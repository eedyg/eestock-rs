//! ADR-024 P2 —— 引擎**分配量**判据（crate 级；权威曲线由 tester 用 harness 跑）。
//!
//! 判据来源：`design/16-backtest-scalability/03-test-plan.md` §2.2「独立指纹②」——
//! `alloc_bytes` 应随改造「塌缩为 O(n)」；P2 任务书第 3 条：**分配量不再随 index 线性增长**
//! （可用计数分配器断言，并给出量化前后数值）。
//!
//! 做法：同一插件（每 bar 调 `ma/ema/rsi/macd/atr/kdj/boll` 全指标）× 同一 bars 前缀，
//! 比较 n 与 2n 的**每 bar 分配字节**：
//! - 改造前（`build_indicators` 逐 bar `bars[..=index].to_vec()` + 指标从 bar 0 重算）
//!   ⇒ 每 bar 分配随 index 线性增长 ⇒ 两点比 ≈ **2.0**（n=2000 → 4000；见报告实测）；
//! - 改造后（共享历史缓冲 + 增量指标）⇒ 每 bar 分配为常数 ⇒ 两点比 ≈ **1.0**。
//!
//! 本文件是**独立测试二进制**（唯一 `#[test]`），计数分配器不受同进程其他测试干扰。

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};

use backtest::{Bar, FeeModel, Period, StrategyParams};
use strategy_core::engine::run_ensemble_with_quickjs;
use strategy_core::{EnsembleConfig, ExecutionPolicy, StrategySlot};
use strategy_runtime::RuntimeLimits;

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

/// 每 bar 调全部指标（覆盖共享缓冲 + 全部增量路径；改造前每条都是 O(index)）。
const INDICATOR_HEAVY: &str = r#"
function on_bar(ctx) {
  const bars = ctx.indicators;
  const ma = bars.ma(20);
  const ema = bars.ema(20);
  const rsi = bars.rsi(14);
  const m = bars.macd();
  const a = bars.atr(14);
  const k = bars.kdj();
  const bl = bars.boll(20, 2.0);
  if (ma === null || ema === null || rsi === null || m === null || a === null || k === null || bl === null) {
    return 50;
  }
  const raw = 50 + (ma - ema) + (rsi - 50) * 0.5 + m.macd * 10 + a * 0.1 + (k.k - k.d) + (bl.upper - bl.lower);
  if (raw > 100) { return 100; }
  if (raw < 0) { return 0; }
  return raw;
}
"#;

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

fn cfg() -> EnsembleConfig {
    EnsembleConfig {
        // P1b 机械适配（架构裁决 2026-09-20 方案 A）：EnsembleConfig 增 symbol（code 唯一取值来源）。
        symbol: "TEST.SYMBOL".to_string(),
        slots: vec![
            StrategySlot::new(
                INDICATOR_HEAVY,
                "sha256:indicator_heavy",
                StrategyParams::new(),
                1.0,
            )
            .expect("合法 slot"),
        ],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy: ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: None,
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::M1,
        warmup_bars: 0,
        runtime_limits: RuntimeLimits::default(),
    }
}

/// 跑 n 根 bar 的引擎，返回 `(每 bar 分配字节, 每 bar 分配次数)`。
fn per_bar_allocs(bars: &[Bar]) -> (f64, f64) {
    let c = cfg();
    let bytes0 = ALLOC_BYTES.load(Ordering::Relaxed);
    let count0 = ALLOC_COUNT.load(Ordering::Relaxed);
    let res = run_ensemble_with_quickjs(&c, bars).expect("引擎运行成功");
    assert_eq!(res.per_bar.len(), bars.len());
    let bytes = ALLOC_BYTES.load(Ordering::Relaxed) - bytes0;
    let count = ALLOC_COUNT.load(Ordering::Relaxed) - count0;
    (bytes as f64 / bars.len() as f64, count as f64 / bars.len() as f64)
}

#[test]
fn engine_per_bar_allocation_does_not_grow_with_index() {
    let bars = series(4000);
    let (bytes_small, count_small) = per_bar_allocs(&bars[..2000]);
    let (bytes_large, count_large) = per_bar_allocs(&bars[..4000]);
    let ratio = bytes_large / bytes_small;
    let count_ratio = count_large / count_small;
    println!(
        "P2-alloc: per_bar_bytes n=2000: {bytes_small:.1}  n=4000: {bytes_large:.1}  ratio={ratio:.3}\n\
         P2-alloc: per_bar_allocs n=2000: {count_small:.2} n=4000: {count_large:.2} ratio={count_ratio:.3}"
    );
    assert!(
        ratio < 1.5,
        "每 bar 分配字节不得随 index 增长：n=2000 {bytes_small:.1} B/bar vs n=4000 {bytes_large:.1} B/bar（ratio={ratio:.3}，\
         改造前 O(index) 复制使该比值 ≈2.0）"
    );
    assert!(
        count_ratio < 1.5,
        "每 bar 分配次数不得随 index 增长：{count_small:.2} vs {count_large:.2}（ratio={count_ratio:.3}）"
    );
}
