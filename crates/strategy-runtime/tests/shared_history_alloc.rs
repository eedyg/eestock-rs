//! ADR-024 P2（A 项）—— **共享缓冲**的分配量判据（crate 级，含量化前后数值）。
//!
//! 判据来源：任务书 P2(A)「分配量不再随 index 线性增长（可用计数分配器或 `alloc_bytes` 断言，
//! 给出量化前后数值）」；`03-test-plan.md` §2.2 独立指纹②。
//!
//! 测量对象 = **插件调用路径**（`build_indicators` 的历史缓冲构造），两条路径对照：
//! - **共享句柄**（`BarCtx::with_history`，引擎会话路径）：每 bar 不得随 index 增长；
//! - **兼容路径**（`BarCtx::new`，试算/sim-live/单测）：保持改造前行为（每 bar 复制
//!   `bars[..=index]`）⇒ 该对照同时是**敏感性证据**：同一测量方法对 O(index) 复制必须给
//!   出 ≈2.0 的比值（否则断言无鉴别力）。
//!
//! 本文件是独立测试二进制（唯一 `#[test]`），计数分配器不受同进程其他测试干扰。

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};

use backtest::{Bar, ParamValue, StrategyParams};
use strategy_runtime::{BarCtx, BarHistory, PluginRuntime, QuickJsRuntime, RuntimeLimits};

struct CountingAlloc;

static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

const INDICATOR_MIX: &str = r#"
function on_bar(ctx) {
  const i = ctx.indicators;
  const ma = i.ma(20);
  const ema = i.ema(20);
  const rsi = i.rsi(14);
  const m = i.macd();
  const a = i.atr(14);
  const k = i.kdj();
  const bl = i.boll(20, 2.0);
  if (ma === null || ema === null || rsi === null || m === null || a === null || k === null || bl === null) {
    return 50;
  }
  return 50 + (ma - ema) + (rsi - 50) * 0.5 + m.macd * 10 + a * 0.1 + (k.k - k.d) + (bl.upper - bl.lower);
}
"#;

fn params() -> StrategyParams {
    StrategyParams::from([("unused".to_string(), ParamValue::Num(0.0))])
}

fn series(n: usize) -> Vec<Bar> {
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    let mut close = 3.5_f64;
    (0..n)
        .map(|i| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let step = ((state >> 33) % 41) as f64 - 20.0;
            close = (close + step * 0.0005).max(0.1);
            Bar {
                ts: 1_600_000_000 + i as i64 * 60,
                open: close - 0.001,
                high: close + 0.003,
                low: close - 0.003,
                close,
                volume: 100_000.0 + i as f64,
            }
        })
        .collect()
}

/// 共享句柄路径：每 bar 分配字节/次数。
fn shared_per_bar(bars: &[Bar]) -> (f64, f64) {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:indicator_mix", INDICATOR_MIX, &params())
        .expect("实例化成功");
    let hist = BarHistory::with_capacity(bars.len());
    let bytes0 = ALLOC_BYTES.load(Ordering::Relaxed);
    let count0 = ALLOC_COUNT.load(Ordering::Relaxed);
    let mut sum = 0.0;
    for (i, bar) in bars.iter().enumerate() {
        hist.push(bar.clone());
        let ctx = BarCtx::new(i, bar.clone(), &bars[..=i], None).with_history(hist.clone());
        sum += inst.on_bar(&ctx).expect("不应出错");
    }
    assert!(sum.is_finite());
    let bytes = ALLOC_BYTES.load(Ordering::Relaxed) - bytes0;
    let count = ALLOC_COUNT.load(Ordering::Relaxed) - count0;
    (bytes as f64 / bars.len() as f64, count as f64 / bars.len() as f64)
}

/// 兼容路径（改造前口径，逐 bar 复制整段历史）：每 bar 分配字节/次数。
fn compat_per_bar(bars: &[Bar]) -> (f64, f64) {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:indicator_mix", INDICATOR_MIX, &params())
        .expect("实例化成功");
    let bytes0 = ALLOC_BYTES.load(Ordering::Relaxed);
    let count0 = ALLOC_COUNT.load(Ordering::Relaxed);
    let mut sum = 0.0;
    for (i, bar) in bars.iter().enumerate() {
        let ctx = BarCtx::new(i, bar.clone(), bars, None);
        sum += inst.on_bar(&ctx).expect("不应出错");
    }
    assert!(sum.is_finite());
    let bytes = ALLOC_BYTES.load(Ordering::Relaxed) - bytes0;
    let count = ALLOC_COUNT.load(Ordering::Relaxed) - count0;
    (bytes as f64 / bars.len() as f64, count as f64 / bars.len() as f64)
}

#[test]
fn shared_history_per_bar_allocation_is_flat_in_index() {
    let bars = series(4000);

    let (shared_small, shared_cnt_small) = shared_per_bar(&bars[..2000]);
    let (shared_large, shared_cnt_large) = shared_per_bar(&bars[..4000]);
    let (compat_small, compat_cnt_small) = compat_per_bar(&bars[..2000]);
    let (compat_large, compat_cnt_large) = compat_per_bar(&bars[..4000]);

    let shared_ratio = shared_large / shared_small;
    let compat_ratio = compat_large / compat_small;
    println!(
        "P2-shared-buffer alloc/bar（bytes）: 共享句柄 n=2000 {shared_small:.1} → n=4000 {shared_large:.1} \
         (ratio={shared_ratio:.3})；兼容路径（改造前口径）n=2000 {compat_small:.1} → n=4000 {compat_large:.1} \
         (ratio={compat_ratio:.3})"
    );
    println!(
        "P2-shared-buffer alloc/bar（次数）: 共享句柄 {shared_cnt_small:.2} → {shared_cnt_large:.2} \
         (ratio={:.3})；兼容路径 {compat_cnt_small:.2} → {compat_cnt_large:.2} (ratio={:.3})",
        shared_cnt_large / shared_cnt_small,
        compat_cnt_large / compat_cnt_small
    );

    assert!(
        shared_ratio < 1.5,
        "共享缓冲路径每 bar 分配字节不得随 index 增长：{shared_small:.1} B/bar → {shared_large:.1} B/bar（ratio={shared_ratio:.3}）"
    );
    // 敏感性证据：同一测量方法在**兼容路径**（改造前逐 bar 复制）上必须给出 ≈2.0
    //（O(index) ⇒ n 翻倍 ⇒ 每 bar 平均字节 ≈ 翻倍）。若该值 ≤1.5，说明本测量无鉴别力。
    assert!(
        compat_ratio > 1.5,
        "敏感性证据失效：兼容路径（每 bar 复制 bars[..=index]）应呈现 O(index) ⇒ ratio≈2，实测 {compat_ratio:.3}"
    );
}
