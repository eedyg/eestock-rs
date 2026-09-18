//! ADR-024 P2b —— **sim-live 插件编排器路径线性化**的定向判据（sim-live crate 级）。
//!
//! 判据来源：
//! - `design/16-backtest-scalability/04-implementation-plan.md` §2「P2b」（同源二次项收尾）；
//! - `design/16-backtest-scalability/01-adr.md` **D7 修订**（宿主侧 `BarCtx.bars` 语义收窄为前缀；
//!   残留调用点 `simlive/src/plugin_orchestrator.rs` 随 P2b 改为持 `Rc<BarHistory>`）；
//! - tester P2 验收报告 §9 **R2**（发现来源）。
//!
//! 三条判据（与 `crates/application/tests/adr024_p2b_tryrun.rs` 同型，覆盖两条同源路径）：
//! 1. **可见面**（真实编排器 + 探针 `PluginRuntime`）：宿主侧 `ctx.bars` 必须恰为 `bars[..=index]`
//!    （`bars_len == index + 1`、`ahead_visible == false`）、当前 bar 一致、**共享缓冲句柄已注入**
//!    且**跨 bar 为同一实例**（零复制）；
//! 2. **等价性**：编排器（新路径：共享缓冲）与「改造前口径复刻」（兼容路径：每 bar 全量切片）
//!    逐 bar 评分 **位级相同**（`f64::to_bits`）；
//! 3. **分配量**：每 bar 分配字节不再随 index 增长（n 与 2n 的每 bar 分配比 ≤ 1.25；
//!    改造前 ≈ 2.0）。
//!
//! 本文件是**独立测试二进制**（计数分配器不受同进程其他测试干扰）；两个 `#[test]` 以
//! `SERIAL` 互斥串行执行，保证分配量测量窗口内无并发分配噪声。

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use backtest::{Bar, StrategyParams};
use simlive::{PluginStrategyConfig, PluginStrategyOrchestrator};
use strategy_runtime::{
    BarCtx, ParamDef, PluginError, PluginInstance, PluginRuntime, QuickJsRuntime, RuntimeLimits,
};

// ---------------------------------------------------------------------------
// 计数分配器（与 P2 的 strategy-core/tests/session_alloc.rs 同型）
// ---------------------------------------------------------------------------

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

/// 测量窗口互斥（同一二进制内各测试串行；无并发分配污染）。
static SERIAL: Mutex<()> = Mutex::new(());

/// 取互斥锁（**不因他测 panic 而连带失败**：中毒取回守卫，避免级联假红掩盖本测结论）。
fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/// 每 bar 调全部指标的插件（改造前每条指标都是 O(index) 回放；且每 bar 复制整段历史）。
const INDICATOR_HEAVY: &str = r#"
function on_bar(ctx) {
  const ind = ctx.indicators;
  const ma = ind.ma(20);
  const ema = ind.ema(20);
  const rsi = ind.rsi(14);
  const m = ind.macd();
  const a = ind.atr(14);
  const k = ind.kdj();
  const bl = ind.boll(20, 2.0);
  if (ma === null || ema === null || rsi === null || m === null || a === null || k === null || bl === null) {
    return 50;
  }
  var raw = 50 + (ma - ema) + (rsi - 50) * 0.5 + m.macd * 10 + a * 0.1 + (k.k - k.d) + (bl.upper - bl.lower);
  if (raw > 100) { raw = 100; }
  if (raw < 0) { raw = 0; }
  return raw;
}
"#;

/// 确定性 bar 序列（非恒定 ⇒ 指标取值有鉴别力；避免 f64 舍入巧合掩盖差异）。
fn series(n: usize) -> Vec<Bar> {
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    let mut close = 12.5_f64;
    (0..n)
        .map(|i| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let step = ((state >> 33) % 41) as f64 - 20.0;
            close = (close + step * 0.01).max(0.5);
            Bar {
                ts: 1_700_000_000 + i as i64 * 86_400,
                open: close - 0.05,
                high: close + 0.2,
                low: (close - 0.2).max(0.01),
                close,
                volume: 10_000.0 + (i % 7) as f64,
            }
        })
        .collect()
}

fn cfg(stocks: &[&str]) -> PluginStrategyConfig {
    PluginStrategyConfig {
        strategy_id: "st_p2b".into(),
        version_id: "sv_p2b".into(),
        version: 1,
        sha256: "sha256:p2b".into(),
        name: "p2b_probe".into(),
        code: INDICATOR_HEAVY.into(),
        params: StrategyParams::new(),
        stocks: stocks.iter().map(|s| s.to_string()).collect(),
        weight: 1.0,
        stock_weights: HashMap::new(),
    }
}

// ---------------------------------------------------------------------------
// 判据 1：宿主侧 ctx.bars 可见面（真实编排器 + 探针 runtime）
// ---------------------------------------------------------------------------

/// 探针行（每 bar 一行；全字段逐位可比较）。
#[derive(Debug, Clone, PartialEq)]
struct CtxRow {
    index: usize,
    bars_len: usize,
    cur_eq_ctx_bar: bool,
    /// `bars.len() > index + 1` ⇒ 宿主侧可读未来 bar（P2b 必须为 false）。
    ahead_visible: bool,
    /// 共享历史缓冲句柄已注入（改造前兼容路径 ⇒ false）。
    shared_handle: bool,
    /// 共享句柄身份（`Rc::as_ptr`）；跨 bar 恒等 ⇒ 同一缓冲被复用（零复制）。
    history_ptr: usize,
}

struct ProbeInstance {
    rows: Rc<RefCell<Vec<CtxRow>>>,
}

impl PluginInstance for ProbeInstance {
    fn on_bar(&mut self, ctx: &BarCtx<'_>) -> Result<f64, PluginError> {
        self.rows.borrow_mut().push(CtxRow {
            index: ctx.index,
            bars_len: ctx.bars.len(),
            cur_eq_ctx_bar: ctx.bars.get(ctx.index).is_some_and(|b| *b == ctx.bar),
            ahead_visible: ctx.bars.len() > ctx.index + 1,
            shared_handle: ctx.shared_history().is_some(),
            history_ptr: ctx
                .shared_history()
                .map(|h| Rc::as_ptr(h) as usize)
                .unwrap_or(0),
        });
        Ok(50.0)
    }
    fn save(&self) -> Result<Option<serde_json::Value>, PluginError> {
        Ok(None)
    }
    fn load(&mut self, _state: &serde_json::Value) -> Result<(), PluginError> {
        Ok(())
    }
    fn params_schema(&self) -> &[ParamDef] {
        &[]
    }
}

/// 探针运行时：返回记录 ctx 可见面的实例（同一实例跨 bar 复用，与真实 runtime 同型）。
struct ProbeRuntime {
    rows: Rc<RefCell<Vec<CtxRow>>>,
}

impl PluginRuntime for ProbeRuntime {
    fn instantiate(
        &mut self,
        _code_hash: &str,
        _code: &str,
        _params: &StrategyParams,
    ) -> Result<Box<dyn PluginInstance>, PluginError> {
        Ok(Box::new(ProbeInstance { rows: Rc::clone(&self.rows) }))
    }
}

#[test]
fn orchestrator_ctx_bars_is_prefix_shared_and_has_no_future() {
    let _guard = serial();
    let n = 20;
    let rows = Rc::new(RefCell::new(Vec::new()));
    let mut rt = ProbeRuntime { rows: Rc::clone(&rows) };
    let mut orch = PluginStrategyOrchestrator::new(vec![cfg(&["AAA"])], 60.0, 40.0, &mut rt)
        .expect("构建编排器");

    let bars = series(n);
    for (i, b) in bars.iter().enumerate() {
        orch.feed_bar("AAA", b.clone(), None).expect("评估");
        let r = &rows.borrow()[i];
        assert_eq!(r.index, i);
        assert_eq!(
            r.bars_len,
            r.index + 1,
            "bar {i}: 宿主侧 ctx.bars 必须恰为 bars[..=index]（P2b：无可读未来）"
        );
        assert!(r.cur_eq_ctx_bar, "bar {i}: ctx.bars[index] 必须等于 ctx.bar");
        assert!(!r.ahead_visible, "bar {i}: 存在 index 之外的 bar（可读未来）");
        assert!(
            r.shared_handle,
            "bar {i}: 必须注入共享历史缓冲句柄（兼容路径每 bar 复制 bars[..=index]）"
        );
        assert_ne!(r.history_ptr, 0, "bar {i}: 共享句柄非空");
    }
    let all = rows.borrow();
    assert_eq!(all.len(), n);
    let first = all[0].history_ptr;
    assert!(
        all.iter().all(|r| r.history_ptr == first),
        "共享缓冲句柄必须跨 bar 恒等（同一增长式缓冲被复用 ⇒ 零复制）"
    );

    // 断言输出（可复核）：每 bar 一行的可见面 + 违例计数。
    let viol = all
        .iter()
        .filter(|r| r.bars_len != r.index + 1 || r.ahead_visible || !r.cur_eq_ctx_bar || !r.shared_handle)
        .count();
    println!("[P2b/sim-live] ctx.bars 可见面探针：rows={} 违例={viol}", all.len());
    for r in all.iter().take(3) {
        println!(
            "  idx={} bars_len={} cur_eq_ctx_bar={} ahead_visible={} shared_handle={} history_ptr={:#x}",
            r.index, r.bars_len, r.cur_eq_ctx_bar, r.ahead_visible, r.shared_handle, r.history_ptr
        );
    }
    println!("  共享句柄身份跨 bar 恒等 = {}", all.iter().all(|r| r.history_ptr == first));
    assert_eq!(viol, 0, "ctx.bars 可见面违例（bars_len != index+1 / 可读未来 / 句柄缺失）");
}

// ---------------------------------------------------------------------------
// 判据 2：等价性（新路径 vs 改造前口径复刻）——逐 bar 位级相同
// ---------------------------------------------------------------------------

#[test]
fn orchestrator_scores_bitwise_equal_to_compat_path() {
    let _guard = serial();
    let bars = series(400);

    // 新路径：真实编排器（共享历史缓冲）。
    let mut orch =
        PluginStrategyOrchestrator::with_quickjs(vec![cfg(&["AAA"])], 60.0, 40.0, RuntimeLimits::default())
            .expect("构建编排器");
    let mut new_scores = Vec::with_capacity(bars.len());
    for b in &bars {
        let ev = orch.feed_bar("AAA", b.clone(), None).expect("评估");
        new_scores.push(ev.per_strategy_scores[0].score);
    }

    // 改造前口径复刻：每 bar 传**全量累计切片**给兼容路径（`BarCtx::new` + 运行时内部
    // `bars[..=index]` 一次性等价缓冲）——即 `plugin_orchestrator.rs:264` 改造前的调用形态。
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:p2b", INDICATOR_HEAVY, &StrategyParams::new())
        .expect("实例化成功");
    let mut accumulated: Vec<Bar> = Vec::with_capacity(bars.len());
    let mut old_scores = Vec::with_capacity(bars.len());
    for b in &bars {
        accumulated.push(b.clone());
        let idx = accumulated.len() - 1;
        let ctx = BarCtx::new(idx, b.clone(), &accumulated, None);
        old_scores.push(inst.on_bar(&ctx).expect("不应出错"));
    }

    assert_eq!(new_scores.len(), old_scores.len());
    for (i, (a, b)) in new_scores.iter().zip(old_scores.iter()).enumerate() {
        assert_eq!(
            a.to_bits(),
            b.to_bits(),
            "bar {i}: 编排器（共享缓冲）{a:?} 与改造前兼容路径 {b:?} 位级不一致"
        );
    }
}

// ---------------------------------------------------------------------------
// 判据 3：分配量（每 bar 不再随 index 增长）
// ---------------------------------------------------------------------------

/// 单次 feed 的（每 bar 分配字节, 墙钟毫秒）。夹具构造不纳入测量窗口。
fn measure(n: usize) -> (f64, f64) {
    let bars = series(n);
    let before = ALLOC_BYTES.load(Ordering::Relaxed);
    let t0 = std::time::Instant::now();
    let mut orch =
        PluginStrategyOrchestrator::with_quickjs(vec![cfg(&["AAA"])], 60.0, 40.0, RuntimeLimits::default())
            .expect("构建编排器");
    for b in &bars {
        let ev = orch.feed_bar("AAA", b.clone(), None).expect("评估");
        assert_eq!(ev.per_strategy_scores.len(), 1);
    }
    let wall_ms = t0.elapsed().as_secs_f64() * 1_000.0;
    let after = ALLOC_BYTES.load(Ordering::Relaxed);
    ((after - before) as f64 / n as f64, wall_ms)
}

#[test]
fn orchestrator_per_bar_allocation_does_not_grow_with_index() {
    let _guard = serial();
    let (small, small_ms) = measure(2_000);
    let (large, large_ms) = measure(4_000);
    let ratio = large / small;
    println!("P2b-simlive alloc/bar（bytes）: n=2000 {small:.1} → n=4000 {large:.1} (ratio={ratio:.3})");
    println!("P2b-simlive wall（ms）: n=2000 {small_ms:.1} → n=4000 {large_ms:.1} (ratio={:.3})", large_ms / small_ms);
    assert!(
        ratio <= 1.25,
        "每 bar 分配字节不得随 index 增长：n=2000 {small:.1} B/bar vs n=4000 {large:.1} B/bar \
         （ratio={ratio:.3}；改造前每 bar 复制 bars[..=index] 使该比值 ≈2.0）"
    );
}
