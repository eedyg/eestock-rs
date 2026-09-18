//! ADR-024 P2b —— **试算（`pure_score`）路径线性化**的定向判据（application crate 级）。
//!
//! 判据来源：
//! - `design/16-backtest-scalability/04-implementation-plan.md` §2「P2b」；
//! - `design/16-backtest-scalability/01-adr.md` **D7 修订**（宿主侧 `BarCtx.bars` 收窄为前缀；
//!   残留调用点 `application/src/strategy.rs` 试算逐 bar 评分循环随 P2b 改持 `Rc<BarHistory>`）；
//! - tester P2 验收报告 §9 **R2**（发现来源）。
//!
//! 两条判据（与 `crates/simlive/tests/adr024_p2b_orchestrator.rs` 同型）：
//! 1. **等价性**：`StrategyService::test_run`（新路径：共享缓冲 + 前缀切片）与「改造前口径复刻」
//!    （兼容路径：每 bar 传全量切片、运行时内部按 `bars[..=index]` 建一次性缓冲）逐 bar 评分
//!    **位级相同**（`f64::to_bits`）；
//! 2. **分配量**：每 bar 分配字节不再随 index 增长（n 与 2n 的每 bar 分配比 ≤ 1.25；改造前 ≈ 2.0）。
//!
//! 本文件是**独立测试二进制**（计数分配器不受同进程其他测试干扰）；两个 `#[tokio::test]`
//! 以 `SERIAL` 互斥串行执行，保证分配量测量窗口内无并发分配噪声。
//! 无 IO/无 DB：store 为端口桩（`pure_score` 内联代码路径不触 store），bar 读取为内存桩。

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    BacktestBarRead, CatalogEntry, Clock, NewStrategy, NewStrategyVersion, StrategyManageItem,
    StrategyRow, StrategyStore, StrategyVersionRow,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use domain::types::{Code, Period, SourceId};

use backtest::StrategyParams;
use strategy_runtime::PluginRuntime as _;
use application::strategy::{
    StrategyService, TestRunMode, TestRunRequest, TestRunSource, TEST_RUN_MEMORY_LIMIT,
    TEST_RUN_PER_CALL_TIMEOUT_MS,
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

/// 测量窗口互斥（同一二进制内各测试串行；无并发分配污染。
/// `spawn_blocking` 的评分线程在测量窗口内 ⇒ 计数完整）。
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

const SYMBOL: &str = "600000";
/// 分钟级数据（M1）：区间档上限 93 天 ⇒ 4,000 根（≈2.8 天）不触发区间护栏。
const PERIOD_CODE: &str = "M1";

fn dbar(i: i64, close: f64) -> domain::types::Bar {
    domain::types::Bar {
        code: Code(SYMBOL.into()),
        period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap() + Duration::minutes(i),
        open: close,
        high: close + 1.0,
        low: (close - 1.0).max(0.01),
        close,
        volume: 10_000,
        amount: close * 10_000.0,
        source: SourceId::Tushare,
    }
}

/// 确定性 bar 序列（非恒定 ⇒ 指标取值有鉴别力）。
fn series(n: usize) -> Vec<domain::types::Bar> {
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    let mut close = 12.5_f64;
    (0..n)
        .map(|i| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let step = ((state >> 33) % 41) as f64 - 20.0;
            close = (close + step * 0.01).max(0.5);
            dbar(i as i64, close)
        })
        .collect()
}

/// 与 `strategy.rs::to_bt_bar` 同口径（改造前复刻须用同一入参序列）。
fn to_bt_bar(b: &domain::types::Bar) -> backtest::Bar {
    backtest::Bar {
        ts: b.ts.timestamp(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume as f64,
    }
}

/// 试算限额（与生产 `test_run_limits()` 同口径——改造前复刻必须用同一限额）。
fn test_run_limits() -> strategy_runtime::RuntimeLimits {
    let per_call_timeout = std::time::Duration::from_millis(TEST_RUN_PER_CALL_TIMEOUT_MS);
    strategy_runtime::RuntimeLimits {
        per_call_timeout,
        instantiate_timeout: (per_call_timeout * 20).max(std::time::Duration::from_secs(1)),
        memory_limit: TEST_RUN_MEMORY_LIMIT,
    }
}

// ── 端口桩：bar 读取（内存）+ Clock + store（`pure_score` 内联代码路径不触 store）──

struct MockBars(Vec<domain::types::Bar>);

#[async_trait::async_trait]
impl BacktestBarRead for MockBars {
    async fn bars(
        &self,
        _code: &str,
        _period: &Period,
        _from: DateTime<Utc>,
        _to: DateTime<Utc>,
    ) -> anyhow::Result<Vec<domain::types::Bar>> {
        Ok(self.0.clone())
    }
}

struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap()
    }
}

/// 端口桩（未实现 = 本测试路径不应触达；触达即 panic ⇒ 自证「无 DB/无 IO」）。
struct UnusedStore;

#[async_trait::async_trait]
impl StrategyStore for UnusedStore {
    async fn create_strategy(&self, _s: &NewStrategy) -> anyhow::Result<StrategyRow> {
        unreachable!("P2b 判据不触 store")
    }
    async fn get_strategy(&self, _id: &str) -> anyhow::Result<Option<StrategyRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn count_strategies(&self) -> anyhow::Result<i64> {
        unreachable!("P2b 判据不触 store")
    }
    async fn catalog(
        &self,
        _level: Option<ApprovalLevel>,
        _kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<CatalogEntry>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn create_version(&self, _v: &NewStrategyVersion) -> anyhow::Result<StrategyVersionRow> {
        unreachable!("P2b 判据不触 store")
    }
    async fn get_version(&self, _id: &str) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn find_version_by_name_sha(
        &self,
        _name: &str,
        _sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn list_versions(&self, _strategy_id: &str) -> anyhow::Result<Vec<StrategyVersionRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn next_version_number(&self, _strategy_id: &str) -> anyhow::Result<i32> {
        unreachable!("P2b 判据不触 store")
    }
    async fn update_draft(
        &self,
        _id: &str,
        _code: &str,
        _params_schema: &serde_json::Value,
        _sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn mark_published(
        &self,
        _id: &str,
        _expected_code: &str,
        _sha256: &str,
        _params_schema: &serde_json::Value,
        _published_at: DateTime<Utc>,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn set_status(
        &self,
        _id: &str,
        _status: StrategyStatus,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn manage_list(
        &self,
        _kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<StrategyManageItem>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn update_meta(
        &self,
        _id: &str,
        _name: &str,
        _description: &str,
    ) -> anyhow::Result<Option<StrategyRow>> {
        unreachable!("P2b 判据不触 store")
    }
    async fn delete_strategy(&self, _id: &str) -> anyhow::Result<u64> {
        unreachable!("P2b 判据不触 store")
    }
}

fn service(bars: Vec<domain::types::Bar>) -> StrategyService {
    StrategyService::new(
        Arc::new(UnusedStore),
        Arc::new(MockBars(bars)) as Arc<dyn BacktestBarRead>,
        Arc::new(FixedClock) as Arc<dyn Clock>,
    )
}

fn request(bars: &[domain::types::Bar]) -> TestRunRequest {
    let from = bars[0].ts;
    let to = bars[bars.len() - 1].ts + Duration::minutes(1);
    TestRunRequest {
        source: TestRunSource::Inline(INDICATOR_HEAVY.into()),
        params: serde_json::json!({}),
        symbol: SYMBOL.into(),
        period: PERIOD_CODE.into(),
        from,
        to,
        mode: TestRunMode::PureScore,
        warmup_bars: 0,
        fee: Some(serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})),
        policy: serde_json::json!({"LumpSum": {"position_pct": 1.0}}),
        initial_capital: 100_000.0,
        confirm: false,
    }
}

// ---------------------------------------------------------------------------
// 判据 1：等价性（新路径 vs 改造前口径复刻）——逐 bar 位级相同
// ---------------------------------------------------------------------------

#[tokio::test]
#[allow(clippy::await_holding_lock)] // 刻意：互斥守卫跨 await（跨测试串行化，避免分配量测量被并发污染）
async fn tryrun_pure_score_bitwise_equal_to_compat_path() {
    let _guard = serial();
    let bars = series(400);
    let svc = service(bars.clone());
    let req = request(&bars);

    // 新路径：`test_run`（pure_score；共享历史缓冲 + 前缀 ctx.bars）
    let resp = svc.test_run(&req).await.expect("试算成功");
    assert_eq!(resp.scores.len(), bars.len());
    assert!(!resp.truncated.scores, "400 bar 不应触发评分点截断");

    // 改造前口径复刻：每 bar 传**全量切片**给兼容路径（`BarCtx::new`，运行时内部按
    // `bars[..=index]` 建一次性等价缓冲）——即 `strategy.rs:894/907` 改造前的调用形态。
    let bt_bars: Vec<backtest::Bar> = bars.iter().map(to_bt_bar).collect();
    let mut rt = strategy_runtime::QuickJsRuntime::new(test_run_limits());
    let mut inst = rt
        .instantiate("sha256:p2b", INDICATOR_HEAVY, &StrategyParams::new())
        .expect("实例化成功");
    for (i, bar) in bt_bars.iter().enumerate() {
        let ctx = strategy_runtime::BarCtx::new(i, bar.clone(), &bt_bars, None);
        let old = inst.on_bar(&ctx).expect("不应出错");
        let got = resp.scores[i].score.expect("不应熔断");
        assert_eq!(resp.scores[i].ts, bar.ts, "bar {i}: ts 漂移");
        assert_eq!(
            got.to_bits(),
            old.to_bits(),
            "bar {i}: 试算（共享缓冲）{got:?} 与改造前兼容路径 {old:?} 位级不一致"
        );
    }
}

// ---------------------------------------------------------------------------
// 判据 2：分配量（每 bar 不再随 index 增长）
// ---------------------------------------------------------------------------

/// 单次试算的（每 bar 分配字节, 墙钟毫秒）。夹具构造与断言不纳入测量窗口。
async fn measure(n: usize) -> (f64, f64) {
    let bars = series(n);
    let svc = service(bars.clone());
    let req = request(&bars);
    let before = ALLOC_BYTES.load(Ordering::Relaxed);
    let t0 = std::time::Instant::now();
    let resp = svc.test_run(&req).await.expect("试算成功");
    let wall_ms = t0.elapsed().as_secs_f64() * 1_000.0;
    let after = ALLOC_BYTES.load(Ordering::Relaxed);
    assert_eq!(resp.scores.len(), n);
    ((after - before) as f64 / n as f64, wall_ms)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // 刻意：互斥守卫跨 await（跨测试串行化，避免分配量测量被并发污染）
async fn tryrun_per_bar_allocation_does_not_grow_with_index() {
    let _guard = serial();
    let (small, small_ms) = measure(2_000).await;
    let (large, large_ms) = measure(4_000).await;
    let ratio = large / small;
    println!("P2b-tryrun alloc/bar（bytes）: n=2000 {small:.1} → n=4000 {large:.1} (ratio={ratio:.3})");
    println!("P2b-tryrun wall（ms）: n=2000 {small_ms:.1} → n=4000 {large_ms:.1} (ratio={:.3})", large_ms / small_ms);
    assert!(
        ratio <= 1.25,
        "每 bar 分配字节不得随 index 增长：n=2000 {small:.1} B/bar vs n=4000 {large:.1} B/bar \
         （ratio={ratio:.3}；改造前每 bar 复制 bars[..=index] 使该比值 ≈2.0）"
    );
}
