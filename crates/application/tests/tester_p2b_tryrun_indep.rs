//! [tester 独立验收 · ADR-024 P2b] 试算路径（`application/src/strategy.rs::run_pure_score`）**独立**
//! 判别测试 —— 由 tester 自行设计，**不依赖** worker 交付的 `adr024_p2b_tryrun.rs` 的任何断言。
//!
//! 目的（任务书 A2/A3）：
//! 1. 用**自带 warmup + 索引/数据耦合插件**的序列，把「新路径（前缀切片 + 共享缓冲）」与
//!    「改造前口径复刻（`git show HEAD:crates/application/src/strategy.rs` 的整段流程：
//!    拉取 → split → warmup_effective → `all[slice_start..]` → 逐 bar `BarCtx::new(i, bar, bars, None)`）」
//!    逐 bar 位级比对（score / ts / warmup 标记 / bar_count / warmup_requested / warmup_effective）；
//! 2. SimPosition 入口在 P2b 后与**直接引擎调用**逐位一致（回归对照：warmup + 真实买卖 + 事件映射）；
//! 3. 分配量**双向**测量：新路径（前缀 + 共享缓冲）每 bar 分配应**常数**；把改造前调用形态
//!    在**本测试内**复刻（兼容路径）应**随 index 线性增长** ⇒ 证明该度量本身有判别力
//!    （不是「两边都平」的空测）。
//!
//! 纪律：本文件只读生产 API，不改任何生产代码；独立测试二进制（自带计数分配器）。
//!
//! 反向对照（人为退化 ⇒ 必须变红）：见 tester/report/adr024_p2b_and_m30_golden_verification.md §A2
//! （临时把 `run_pure_score` 的 helper 退回全量切片 / 退回复制路径 ⇒ 本文件 `indep_*` 与 worker 断言
//! 均变红，取证后逐字节复原）。

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
// 计数分配器（独立测试二进制 ⇒ 不受其他测试二进制干扰；同进程 spawn_blocking 线程亦计入）
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

/// 测量窗口互斥（同一二进制内串行；避免并发分配污染）。
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SYMBOL: &str = "600000";
const PERIOD_CODE: &str = "M1";

/// 判别插件：评分同时耦合 `ctx.index`、当前 bar 的 `ts/close` **与指标窗口** `ma(5)`。
/// ⇒ 若新路径的 index 对齐、喂入序列或 `bars[..=index]` 窗口有任何偏移，逐 bar 位级比对必变红。
const INDEX_ENCODING_PLUGIN: &str = r#"
function on_bar(ctx) {
  const ma = ctx.indicators.ma(5);
  const tail = (ctx.index % 10) * 0.01 + (ctx.bar.ts % 97) * 0.001 + (ctx.bar.close % 1.0);
  if (ma === null) {
    return 20 + tail;
  }
  var raw = 50 + (ctx.bar.close - ma) * 3.0 + tail;
  if (raw > 100) { raw = 100; }
  if (raw < 0) { raw = 0; }
  return raw;
}
"#;

/// 买卖脚本插件（SimPosition 回归对照用）：先强买、再强卖、后中性。
const TRADE_SCRIPT_PLUGIN: &str = r#"
var n = 0;
function on_bar(ctx) {
  n = n + 1;
  if (n <= 30) { return 55; }   // 覆盖 warmup 段（warmup 段不执行挂单）
  if (n <= 60) { return 90; }   // 强买信号段（bar 30..59）
  if (n <= 70) { return 55; }   // 持有/观望
  if (n <= 100) { return 10; }  // 强卖信号段（bar 70..99）
  return 55;
}
"#;

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

/// 确定性非恒定序列（LCG）。
fn series(n: usize) -> Vec<domain::types::Bar> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
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

/// 与 `strategy.rs::to_bt_bar` 同口径（逐字段核对过源码：ts→Unix 秒、volume→f64）。
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

/// 与生产 `test_run_limits()` 同口径（读自 `strategy.rs:68`：per_call=常量、instantiate=max(20×,1s)、mem=常量）。
fn test_run_limits() -> strategy_runtime::RuntimeLimits {
    let per_call_timeout = std::time::Duration::from_millis(TEST_RUN_PER_CALL_TIMEOUT_MS);
    strategy_runtime::RuntimeLimits {
        per_call_timeout,
        instantiate_timeout: (per_call_timeout * 20).max(std::time::Duration::from_secs(1)),
        memory_limit: TEST_RUN_MEMORY_LIMIT,
    }
}

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

/// 端口桩：本测试路径不触 store（触达即 panic ⇒ 自证「无 DB/无 IO」）。
struct UnusedStore;

#[async_trait::async_trait]
impl StrategyStore for UnusedStore {
    async fn create_strategy(&self, _s: &NewStrategy) -> anyhow::Result<StrategyRow> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn get_strategy(&self, _id: &str) -> anyhow::Result<Option<StrategyRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn count_strategies(&self) -> anyhow::Result<i64> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn catalog(
        &self,
        _level: Option<ApprovalLevel>,
        _kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<CatalogEntry>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn create_version(&self, _v: &NewStrategyVersion) -> anyhow::Result<StrategyVersionRow> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn get_version(&self, _id: &str) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn find_version_by_name_sha(
        &self,
        _name: &str,
        _sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn list_versions(&self, _strategy_id: &str) -> anyhow::Result<Vec<StrategyVersionRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn next_version_number(&self, _strategy_id: &str) -> anyhow::Result<i32> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn update_draft(
        &self,
        _id: &str,
        _code: &str,
        _params_schema: &serde_json::Value,
        _sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn mark_published(
        &self,
        _id: &str,
        _expected_code: &str,
        _sha256: &str,
        _params_schema: &serde_json::Value,
        _published_at: DateTime<Utc>,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn set_status(
        &self,
        _id: &str,
        _status: StrategyStatus,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn manage_list(
        &self,
        _kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<StrategyManageItem>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn update_meta(
        &self,
        _id: &str,
        _name: &str,
        _description: &str,
    ) -> anyhow::Result<Option<StrategyRow>> {
        unreachable!("tester 判别测试不触 store")
    }
    async fn delete_strategy(&self, _id: &str) -> anyhow::Result<u64> {
        unreachable!("tester 判别测试不触 store")
    }
}

fn service(bars: Vec<domain::types::Bar>) -> StrategyService {
    StrategyService::new(
        Arc::new(UnusedStore),
        Arc::new(MockBars(bars)) as Arc<dyn BacktestBarRead>,
        Arc::new(FixedClock) as Arc<dyn Clock>,
    )
}

/// 构造请求：`from` 显式给定（warmup 场景 = 第 `warmup` 根的 ts）。
fn request(
    code: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    mode: TestRunMode,
    warmup_bars: usize,
) -> TestRunRequest {
    TestRunRequest {
        source: TestRunSource::Inline(code.into()),
        params: serde_json::json!({}),
        symbol: SYMBOL.into(),
        period: PERIOD_CODE.into(),
        from,
        to,
        mode,
        warmup_bars,
        fee: Some(serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})),
        policy: serde_json::json!({"LumpSum": {"position_pct": 1.0}}),
        initial_capital: 100_000.0,
        // ADR-024 P5：资源护栏二次确认（本用例区间小，false）。
        confirm: false,
    }
}

// ---------------------------------------------------------------------------
// 判据 1（A2 判别用例）：warmup + 索引耦合插件 —— 新路径 vs 改造前整段流程复刻
// ---------------------------------------------------------------------------

/// 复刻 `git show HEAD:crates/application/src/strategy.rs` 的 `test_run`（PureScore 段）**整段流程**：
/// 拉取 → `split = 首个 ts >= from` → `warmup_effective = split.min(warmup_requested)` →
/// `slice_start = split - warmup_effective` → `bars = all[slice_start..]` →
/// 逐 bar `BarCtx::new(i, bar.clone(), bars, None)`（**全量切片**，运行时内部按 `bars[..=i]` 建一次性等价缓冲）
/// → 评分 / 错误中立 50 / 连续错误熔断（`scores[len] >= MAX` 截断）。
///
/// 返回每 bar `(ts, score, warmup)` + `(bar_count, warmup_requested, warmup_effective)`。
fn prechange_pure_score_replica(
    code: &str,
    all: &[backtest::Bar],
    from_ts: i64,
    warmup_requested: usize,
) -> (Vec<(i64, f64, bool)>, usize, usize, usize) {
    let split = all
        .iter()
        .position(|b| b.ts >= from_ts)
        .unwrap_or(all.len());
    let warmup_effective = split.min(warmup_requested);
    let slice_start = split - warmup_effective;
    let bars: &[backtest::Bar] = &all[slice_start..];

    let mut rt = strategy_runtime::QuickJsRuntime::new(test_run_limits());
    let mut inst = rt
        .instantiate("sha256:tester-indep", code, &StrategyParams::new())
        .expect("实例化成功");
    let mut out = Vec::with_capacity(bars.len());
    for (i, bar) in bars.iter().enumerate() {
        // 改造前调用形态（逐字）：全量切片 + 无共享句柄。
        let ctx = strategy_runtime::BarCtx::new(i, bar.clone(), bars, None);
        let score = inst.on_bar(&ctx).expect("不应出错");
        out.push((bar.ts, score, i < warmup_effective));
    }
    (out, bars.len(), warmup_requested, warmup_effective)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn indep_tryrun_warmup_flow_bitwise_vs_prechange_replica() {
    let _guard = serial();
    // 120 根：前 30 根为 warmup 前缀（MockBars 忽略 from/to，整段返回 ⇒ 生产侧 split=30、
    // warmup_effective=min(30,30)=30、slice_start=0、bars=全 120 根）。
    let total = 120usize;
    let requested_warmup = 30usize;
    let bars = series(total);
    let from = bars[requested_warmup].ts;
    let to = bars[total - 1].ts + Duration::minutes(1);
    let svc = service(bars.clone());
    let req = request(
        INDEX_ENCODING_PLUGIN,
        from,
        to,
        TestRunMode::PureScore,
        requested_warmup,
    );

    // 新路径：真实公开入口 `test_run`（前缀切片 + 共享增长式缓冲）。
    let resp = svc.test_run(&req).await.expect("试算成功");

    // 旧口径复刻（HEAD 整段流程）。
    let bt_bars: Vec<backtest::Bar> = bars.iter().map(to_bt_bar).collect();
    let (old, old_bar_count, old_wreq, old_weff) =
        prechange_pure_score_replica(INDEX_ENCODING_PLUGIN, &bt_bars, from.timestamp(), requested_warmup);

    // ① 结构性字段
    assert_eq!(resp.bar_count, old_bar_count, "bar_count 漂移");
    assert_eq!(resp.warmup_requested, old_wreq, "warmup_requested 漂移");
    assert_eq!(resp.warmup_effective, old_weff, "warmup_effective 漂移");
    assert_eq!(resp.warmup_effective, requested_warmup, "本用例应生效 30 根 warmup");
    assert_eq!(resp.scores.len(), old.len(), "scores 长度漂移");

    // ② 逐 bar 位级
    let mut warmup_true = 0usize;
    let mut distinct = std::collections::HashSet::new();
    for (i, (old_ts, old_score, old_warmup)) in old.iter().enumerate() {
        let got = &resp.scores[i];
        assert_eq!(got.ts, *old_ts, "bar {i}: ts 漂移");
        assert_eq!(got.warmup, *old_warmup, "bar {i}: warmup 标记漂移");
        let s = got.score.expect("不应熔断");
        assert_eq!(
            s.to_bits(),
            old_score.to_bits(),
            "bar {i}: 新路径 {s:?} ≠ 改造前复刻 {old_score:?}（位级）"
        );
        if *old_warmup {
            warmup_true += 1;
        }
        distinct.insert(s.to_bits());
    }
    assert_eq!(warmup_true, requested_warmup, "warmup=true 的 bar 数应为 30");
    assert!(distinct.len() > 50, "评分取值应有鉴别力（非恒定）：distinct={}", distinct.len());
    println!(
        "[tester-indep/tryrun] warmup 位级等价：bars={} warmup_effective={} warmup_true={} \
         逐位相等={} distinct_scores={}",
        resp.bar_count,
        resp.warmup_effective,
        warmup_true,
        old.len(),
        distinct.len()
    );
    println!(
        "[tester-indep/tryrun] 前 5 bar（新路径）：{:?}",
        resp.scores[..5]
            .iter()
            .map(|p| (p.ts, p.score.map(f64::to_bits), p.warmup))
            .collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// 判据 2（回归对照）：SimPosition 入口 vs 直接引擎调用（warmup + 真实买卖 + 事件映射）
// ---------------------------------------------------------------------------

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn indep_simposition_tryrun_matches_direct_engine() {
    let _guard = serial();
    let total = 120usize;
    let requested_warmup = 30usize;
    let bars = series(total);
    let from = bars[requested_warmup].ts;
    let to = bars[total - 1].ts + Duration::minutes(1);
    let svc = service(bars.clone());
    let req = request(
        TRADE_SCRIPT_PLUGIN,
        from,
        to,
        TestRunMode::SimPosition,
        requested_warmup,
    );
    let resp = svc.test_run(&req).await.expect("试算成功");

    // 直接引擎调用（`run_sim_position` 的逐字同参：默认 60/40 + LumpSum pct=1.0 + stop:None + warmup_effective）
    let code_hash = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(TRADE_SCRIPT_PLUGIN.as_bytes());
        format!("sha256:{}", h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>())
    };
    let slot =
        strategy_core::StrategySlot::new(TRADE_SCRIPT_PLUGIN, &code_hash, StrategyParams::new(), 1.0)
            .expect("slot");
    let cfg = strategy_core::EnsembleConfig {
        // P1b 机械适配（裁决 A）：symbol 为新增必填字段；取本测试 run 的 symbol（与
        // `run_sim_position` 内 `req.symbol` 同值，保证两侧逐字同参对比仍成立）。
        symbol: SYMBOL.to_string(),
        slots: vec![slot],
        buy_threshold: strategy_core::DEFAULT_BUY_THRESHOLD,
        sell_threshold: strategy_core::DEFAULT_SELL_THRESHOLD,
        policy: strategy_core::ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: None, // 试算路径不支持止损（`run_sim_position` 硬编码 None）——见报告 §A2 注记
        initial_capital: 100_000.0,
        fee: backtest::FeeModel {
            commission_rate_pct: 0.025,
            min_commission: 5.0,
            // 口径来自生产 `fee.rs`：显式 fee 缺 `stamp_duty_pct` ⇒ 缺省 0.05（DEFAULT_STAMP_DUTY_PCT）。
            stamp_duty_pct: application::fee::DEFAULT_STAMP_DUTY_PCT,
            slippage_bp: 2.0,
        },
        period: backtest::Period::M1,
        warmup_bars: resp.warmup_effective,
        runtime_limits: test_run_limits(),
    };
    let bt_bars: Vec<backtest::Bar> = bars.iter().map(to_bt_bar).collect();
    let engine = strategy_core::engine::run_ensemble_with_quickjs(&cfg, &bt_bars).expect("引擎运行");

    assert_eq!(resp.bar_count, engine.per_bar.len(), "bar_count 漂移");
    assert_eq!(resp.scores.len(), engine.per_bar.len(), "scores 长度漂移");
    let mut fills = 0usize;
    for (i, rec) in engine.per_bar.iter().enumerate() {
        assert_eq!(resp.scores[i].ts, rec.ts, "bar {i}: ts 漂移");
        assert_eq!(resp.scores[i].warmup, rec.warmup, "bar {i}: warmup 标记漂移");
        assert_eq!(
            resp.scores[i].score.expect("aggregate").to_bits(),
            rec.aggregate.to_bits(),
            "bar {i}: aggregate 位级漂移"
        );
        let want = match rec.signal {
            strategy_core::TradeSignal::Buy => "buy",
            strategy_core::TradeSignal::Sell => "sell",
            strategy_core::TradeSignal::Hold => "hold",
        };
        assert_eq!(resp.signals[i].signal, want, "bar {i}: signal 漂移");
        fills += rec
            .events
            .iter()
            .filter(|e| matches!(e, strategy_core::EngineEvent::Fill { .. }))
            .count();
    }
    assert_eq!(
        resp.trades,
        serde_json::to_value(&engine.trades).expect("trades 序列化"),
        "trades 载荷漂移"
    );
    assert!(!engine.trades.is_empty(), "本用例应产出真实买卖（否则无鉴别力）");
    assert!(fills > 0, "本用例应产出成交事件");
    println!(
        "[tester-indep/tryrun] SimPosition 回归对照：bars={} warmup_effective={} trades={} fills={} \
         aggregate/ts/warmup/signal/trades 逐位一致",
        resp.bar_count,
        resp.warmup_effective,
        engine.trades.len(),
        fills
    );
}

// ---------------------------------------------------------------------------
// 判据 3（A3 双向分配量）：新路径常数 vs 改造前调用形态（兼容路径）线性
// ---------------------------------------------------------------------------

async fn measure_new_path(n: usize) -> (f64, f64) {
    let bars = series(n);
    let svc = service(bars.clone());
    let from = bars[0].ts;
    let to = bars[n - 1].ts + Duration::minutes(1);
    let req = request(INDEX_ENCODING_PLUGIN, from, to, TestRunMode::PureScore, 0);
    let before = ALLOC_BYTES.load(Ordering::Relaxed);
    let t0 = std::time::Instant::now();
    let resp = svc.test_run(&req).await.expect("试算成功");
    let wall_ms = t0.elapsed().as_secs_f64() * 1_000.0;
    let after = ALLOC_BYTES.load(Ordering::Relaxed);
    assert_eq!(resp.scores.len(), n);
    ((after - before) as f64 / n as f64, wall_ms)
}

/// 改造前调用形态（兼容路径）在本测试进程内的复刻：逐 bar `BarCtx::new(i, bar, &bars_full, None)`
/// —— 运行时内部按 `bars[..=i]` 建一次性等价缓冲（O(index) 复制）。
fn measure_compat_path(n: usize) -> (f64, f64) {
    let bars: Vec<backtest::Bar> = series(n).iter().map(to_bt_bar).collect();
    let mut rt = strategy_runtime::QuickJsRuntime::new(test_run_limits());
    let mut inst = rt
        .instantiate("sha256:tester-indep", INDEX_ENCODING_PLUGIN, &StrategyParams::new())
        .expect("实例化成功");
    let before = ALLOC_BYTES.load(Ordering::Relaxed);
    let t0 = std::time::Instant::now();
    for (i, bar) in bars.iter().enumerate() {
        let ctx = strategy_runtime::BarCtx::new(i, bar.clone(), &bars, None);
        let _ = inst.on_bar(&ctx).expect("不应出错");
    }
    let wall_ms = t0.elapsed().as_secs_f64() * 1_000.0;
    let after = ALLOC_BYTES.load(Ordering::Relaxed);
    ((after - before) as f64 / n as f64, wall_ms)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn indep_alloc_flat_new_path_vs_growing_compat_path() {
    let _guard = serial();
    let (new2k, new2k_ms) = measure_new_path(2_000).await;
    let (new4k, new4k_ms) = measure_new_path(4_000).await;
    let (new1k, new1k_ms) = measure_new_path(1_000).await;
    let (cmp2k, cmp2k_ms) = measure_compat_path(2_000);
    let (cmp4k, cmp4k_ms) = measure_compat_path(4_000);

    println!(
        "[tester-indep/alloc·新路径] n=1000 {new1k:.1} B/bar（{new1k_ms:.1} ms） | n=2000 {new2k:.1} \
         B/bar（{new2k_ms:.1} ms） | n=4000 {new4k:.1} B/bar（{new4k_ms:.1} ms）"
    );
    println!(
        "[tester-indep/alloc·新路径] ratio 4000/2000 = {:.3}（期望 ≈1，常数）；wall ratio = {:.3}（期望 ≈2）",
        new4k / new2k,
        new4k_ms / new2k_ms
    );
    println!(
        "[tester-indep/alloc·兼容路径(改造前形态)] n=2000 {cmp2k:.1} B/bar（{cmp2k_ms:.1} ms） | \
         n=4000 {cmp4k:.1} B/bar（{cmp4k_ms:.1} ms）；ratio = {:.3}（期望 ≈2，线性）",
        cmp4k / cmp2k
    );

    assert!(
        new4k / new2k <= 1.25,
        "新路径每 bar 分配不得随 index 增长：{new2k:.1} → {new4k:.1} B/bar（ratio {:.3}）",
        new4k / new2k
    );
    assert!(
        cmp4k / cmp2k >= 1.5,
        "度量判别力检验失败：改造前调用形态（兼容路径）应随 index 线性增长，实测 {cmp2k:.1} → \
         {cmp4k:.1} B/bar（ratio {:.3}）——若此断言不成立，则「新路径平」不具判别力",
        cmp4k / cmp2k
    );
    assert!(
        cmp2k / new2k >= 10.0,
        "改造前形态每 bar 分配应远高于新路径：兼容 {cmp2k:.1} vs 新 {new2k:.1} B/bar"
    );
}
