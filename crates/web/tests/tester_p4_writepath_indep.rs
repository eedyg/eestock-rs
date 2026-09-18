//! **tester 独立验收**（ADR-024 P4 / D8）——写路径语义（**真实 DB store** + 注入式故障/取消）。
//! ⚠️ 非 tangle 手写；由 tester 独立编写（不复用 worker `crates/application/tests/workbench.rs` 断言）。
//!
//! 判据（`02-spec.md` §1.2 错误语义）：
//!   • `append_result_chunk` 失败 ⇒ run 必须落 `failed`（**不得**留半截结果当 succeeded）；
//!   • 分块写**先于** `mark_succeeded`（失败/取消场景下无 `strategy_run_result` 行）；
//!   • 取消 ⇒ `canceled`（已写分块可保留、不得 succeeded —— `mark_succeeded` 的 `status='running'` 守卫）；
//!   • chunk `seq` 单调递增、`ts_from/ts_to` = 本块首/末 bar ts（直查 DB 核对）。
//!
//! 实现方式：`PgStrategyRunStore`（临时库）**外包一层** `InjectStore`——除注入点外逐方法透传，
//! 因此除故障注入外，走的是与生产同一条 storage/application 路径。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    BacktestBarRead, CatalogEntry, Clock, NewStrategy, NewStrategyPreset, NewStrategyRun,
    NewStrategyVersion, ResultChunk, ResultKind, StrategyManageItem, StrategyPresetRow,
    StrategyPresetStore, StrategyRow, StrategyRunFilter, StrategyRunResult, StrategyRunStatus,
    StrategyRunStore, StrategyRunView, StrategyStore, StrategyVersionRow, SymbolRegistry,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use domain::types::{Bar, Code, Period, SourceId};

use application::workbench::{SlotReq, SubmitRunReq, WorkbenchService};

const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 0, 0).unwrap()
}

struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> { fixed_now() }
}

fn dbar(i: i64, close: f64) -> Bar {
    Bar {
        code: Code("600000".into()),
        period: Period::D1,
        ts: Utc.with_ymd_and_hms(2026, 9, 1, 1, 30, 0).unwrap() + Duration::days(i),
        open: close, high: close + 1.0, low: close - 1.0, close,
        volume: 1000, amount: close * 1000.0, source: SourceId::Tushare,
    }
}

fn flat_bars(n: usize) -> Vec<Bar> {
    (0..n).map(|i| dbar(i as i64, 100.0)).collect()
}

// ── 最小夹具（除 run/result store 为真实 DB 外，其余为端口桩） ──

struct StubBars(Vec<Bar>);
#[async_trait::async_trait]
impl BacktestBarRead for StubBars {
    async fn bars(&self, _c: &str, _p: &Period, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<Bar>> {
        Ok(self.0.clone())
    }
}

struct StubSymbols(String);
#[async_trait::async_trait]
impl SymbolRegistry for StubSymbols {
    async fn enabled_codes(&self) -> anyhow::Result<Vec<Code>> { Ok(vec![Code(self.0.clone())]) }
    async fn interval_secs(&self, _c: &Code) -> anyhow::Result<u64> { Ok(60) }
    async fn upsert(&self, _c: Code, _i: u64, _e: bool) -> anyhow::Result<()> { Ok(()) }
}

#[derive(Default)]
struct StubSink;
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for StubSink {
    async fn send(&self, _r: &str, _p: f64, _t: Option<DateTime<Utc>>) -> anyhow::Result<()> { Ok(()) }
}

/// 仅 `get_version` 有实现（submit 校验路径）；其余 `unimplemented!()`。
#[derive(Default)]
struct StubStrategies(Mutex<HashMap<String, StrategyVersionRow>>);
impl StubStrategies {
    fn publish(&self, id: &str) {
        let code = CONST_SCORE;
        self.0.lock().unwrap().insert(id.into(), StrategyVersionRow {
            id: id.into(),
            strategy_id: "st_tester_p4".into(),
            version: 1,
            code: code.into(),
            params_schema: serde_json::json!([
                {"key": "score", "type": "float", "default": 80, "min": 0, "max": 100, "description": "恒分"}
            ]),
            sha256: application::strategy::sha256_hex(code),
            status: StrategyStatus::Published,
            approval_level: ApprovalLevel::BacktestOk,
            created_at: fixed_now(),
            published_at: Some(fixed_now()),
        });
    }
}
#[async_trait::async_trait]
impl StrategyStore for StubStrategies {
    async fn create_strategy(&self, _s: &NewStrategy) -> anyhow::Result<StrategyRow> { unimplemented!() }
    async fn get_strategy(&self, _i: &str) -> anyhow::Result<Option<StrategyRow>> { unimplemented!() }
    async fn count_strategies(&self) -> anyhow::Result<i64> { unimplemented!() }
    async fn catalog(&self, _l: Option<ApprovalLevel>, _k: Option<StrategyKind>)
        -> anyhow::Result<Vec<CatalogEntry>> { unimplemented!() }
    async fn create_version(&self, _v: &NewStrategyVersion) -> anyhow::Result<StrategyVersionRow> { unimplemented!() }
    async fn get_version(&self, id: &str) -> anyhow::Result<Option<StrategyVersionRow>> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    async fn find_version_by_name_sha(&self, _n: &str, _s: &str)
        -> anyhow::Result<Option<StrategyVersionRow>> { unimplemented!() }
    async fn list_versions(&self, _s: &str) -> anyhow::Result<Vec<StrategyVersionRow>> { unimplemented!() }
    async fn next_version_number(&self, _s: &str) -> anyhow::Result<i32> { unimplemented!() }
    async fn update_draft(&self, _i: &str, _c: &str, _p: &serde_json::Value, _s: &str)
        -> anyhow::Result<Option<StrategyVersionRow>> { unimplemented!() }
    async fn mark_published(&self, _i: &str, _c: &str, _s: &str, _p: &serde_json::Value, _t: DateTime<Utc>)
        -> anyhow::Result<Option<StrategyVersionRow>> { unimplemented!() }
    async fn set_status(&self, _i: &str, _s: StrategyStatus) -> anyhow::Result<Option<StrategyVersionRow>> { unimplemented!() }
    async fn manage_list(&self, _k: Option<StrategyKind>) -> anyhow::Result<Vec<StrategyManageItem>> { unimplemented!() }
    async fn update_meta(&self, _i: &str, _n: &str, _d: &str) -> anyhow::Result<Option<StrategyRow>> { unimplemented!() }
    async fn delete_strategy(&self, _i: &str) -> anyhow::Result<u64> { unimplemented!() }
}

struct StubPresets;
#[async_trait::async_trait]
impl StrategyPresetStore for StubPresets {
    async fn create_preset(&self, _p: &NewStrategyPreset) -> anyhow::Result<StrategyPresetRow> { unimplemented!() }
    async fn get_preset(&self, _i: &str) -> anyhow::Result<Option<StrategyPresetRow>> { unimplemented!() }
    async fn find_preset_by_name(&self, _n: &str) -> anyhow::Result<Option<StrategyPresetRow>> { unimplemented!() }
    async fn list_presets(&self) -> anyhow::Result<Vec<StrategyPresetRow>> { unimplemented!() }
    async fn update_preset(&self, _i: &str, _n: &str, _c: &serde_json::Value)
        -> anyhow::Result<Option<StrategyPresetRow>> { unimplemented!() }
    async fn delete_preset(&self, _i: &str) -> anyhow::Result<bool> { unimplemented!() }
}

/// 透传包装 + 两个注入点：
///   • `fail_at`：第 N 次 `append_result_chunk`（1 起）返回 Err；
///   • `cancel_at`：第 N 次 `append_result_chunk` 成功后，直接以 SQL 把 run 置 `canceled`
///     （模拟「取消在分块写之后胜出」的并发时序，确定性、无竞态）。
struct InjectStore {
    inner: storage::workbench::PgStrategyRunStore,
    pool: sqlx::PgPool,
    appends: AtomicI64,
    fail_at: Option<i64>,
    fail_kind: Option<ResultKind>,
    cancel_at: Option<i64>,
    appended: AtomicBool,
}
impl InjectStore {
    fn new(pool: sqlx::PgPool) -> Self {
        Self {
            inner: storage::workbench::PgStrategyRunStore::new(pool.clone()),
            pool,
            appends: AtomicI64::new(0),
            fail_at: None,
            fail_kind: None,
            cancel_at: None,
            appended: AtomicBool::new(false),
        }
    }
    fn fail_at(mut self, n: i64) -> Self { self.fail_at = Some(n); self }
    /// ADR-024 P6：按 chunk kind 定点失败（用于证明 **fills 块写失败 ⇒ run 落 failed**）。
    fn fail_kind(mut self, k: ResultKind) -> Self { self.fail_kind = Some(k); self }
    fn cancel_at(mut self, n: i64) -> Self { self.cancel_at = Some(n); self }
}

#[async_trait::async_trait]
impl StrategyRunStore for InjectStore {
    async fn create_run(&self, r: &NewStrategyRun) -> anyhow::Result<StrategyRunView> { self.inner.create_run(r).await }
    async fn get_run(&self, id: &str) -> anyhow::Result<Option<StrategyRunView>> { self.inner.get_run(id).await }
    async fn list_runs(&self, f: &StrategyRunFilter) -> anyhow::Result<Vec<StrategyRunView>> { self.inner.list_runs(f).await }
    async fn mark_started(&self, id: &str, t: DateTime<Utc>) -> anyhow::Result<bool> { self.inner.mark_started(id, t).await }
    async fn update_progress(&self, id: &str, p: f64) -> anyhow::Result<()> { self.inner.update_progress(id, p).await }
    async fn mark_succeeded(&self, id: &str, r: &StrategyRunResult, t: DateTime<Utc>) -> anyhow::Result<bool> {
        self.inner.mark_succeeded(id, r, t).await
    }
    async fn mark_failed(&self, id: &str, e: &str, t: DateTime<Utc>) -> anyhow::Result<bool> {
        self.inner.mark_failed(id, e, t).await
    }
    async fn mark_canceled(&self, id: &str, t: DateTime<Utc>) -> anyhow::Result<Option<bool>> {
        self.inner.mark_canceled(id, t).await
    }
    async fn get_result(&self, id: &str) -> anyhow::Result<Option<StrategyRunResult>> { self.inner.get_result(id).await }

    async fn append_result_chunk(&self, run_id: &str, chunk: &ResultChunk) -> anyhow::Result<()> {
        let n = self.appends.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_at == Some(n) {
            anyhow::bail!("[tester 注入] 第 {n} 次 append_result_chunk 强制失败");
        }
        if self.fail_kind == Some(chunk.kind) {
            anyhow::bail!("[tester 注入] kind={:?} 的 append_result_chunk 强制失败", chunk.kind);
        }
        self.inner.append_result_chunk(run_id, chunk).await?;
        self.appended.store(true, Ordering::SeqCst);
        if self.cancel_at == Some(n) {
            // 模拟并发取消胜出（DB 侧先落 canceled）：分块已写、后续 mark_succeeded 必被守卫拦住。
            sqlx::query("UPDATE strategy_run SET status='canceled', finished_at=now() \
                         WHERE id=$1 AND status IN ('queued','running')")
                .bind(run_id).execute(&self.pool).await?;
        }
        Ok(())
    }
    async fn result_chunks(&self, id: &str, k: ResultKind, o: i64, l: i64) -> anyhow::Result<Vec<ResultChunk>> {
        self.inner.result_chunks(id, k, o, l).await
    }
    async fn result_chunks_in_range(&self, id: &str, k: ResultKind, f: DateTime<Utc>, t: DateTime<Utc>)
        -> anyhow::Result<Vec<ResultChunk>> {
        self.inner.result_chunks_in_range(id, k, f, t).await
    }
    async fn result_chunk_count(&self, id: &str, k: ResultKind) -> anyhow::Result<i64> {
        self.inner.result_chunk_count(id, k).await
    }
}

struct Rig {
    svc: Arc<WorkbenchService>,
}

fn submit_req(version_id: &str, symbol: &str) -> SubmitRunReq {
    SubmitRunReq {
        name: String::new(),
        symbol: symbol.into(),
        period: "D1".into(),
        from: dbar(-1, 0.0).ts,
        to: dbar(100, 0.0).ts,   // ADR-024 P5：无日历天数档；bar 源由 StubBars 提供
        slots: vec![SlotReq { version_id: version_id.into(), params: serde_json::json!({}), weight: 1.0 }],
        buy_threshold: None,
        sell_threshold: None,
        policy: serde_json::json!({"LumpSum": {"position_pct": 1.0}}),
        stop: None,
        initial_capital: None,
        fee: Some(serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})),
        warmup_bars: 0, // 本批验证与预热无关
        confirm: false,
    }
}

async fn rig(n_bars: usize, run_store: Arc<dyn StrategyRunStore>, symbol: &str)
    -> (Rig, Arc<StubStrategies>) {
    let pool = test_support::test_pool().await;
    let strategies = Arc::new(StubStrategies::default());
    strategies.publish("sv_tester_p4");
    let svc = Arc::new(WorkbenchService::new(
        Arc::new(StubBars(flat_bars(n_bars))),
        run_store,
        Arc::new(StubPresets),
        strategies.clone(),
        Arc::new(StubSymbols(symbol.into())),
        Arc::new(StubSink),
        Arc::new(FixedClock),
        application::workbench::DEFAULT_MAX_CONCURRENT,
    ));
    drop(pool);
    (Rig { svc }, strategies)
}

async fn wait_terminal(svc: &WorkbenchService, id: &str) -> StrategyRunView {
    for _ in 0..3000 {
        let r = svc.get_run(id).await.unwrap();
        if r.status.is_terminal() {
            return r;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("run {id} 30s 未达终态");
}

/// 清理：删除本测试专属 symbol 的 run（FK 级联带走 result/chunks）。
/// ⚠ 每个测试用**独立 symbol**（同 binary 并行执行，共享清理会互删——仓库既有踩坑注记）。
async fn clean(pool: &sqlx::PgPool, symbol: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(symbol)
        .execute(pool).await.unwrap();
}

// ───────────────────────── ① 分块写失败 ⇒ run 落 failed ─────────────────────────

#[tokio::test]
async fn t_p4_chunk_write_failure_marks_run_failed_not_succeeded() {
    let pool = test_support::test_pool().await;
    let sym = "tp4a01";
    clean(&pool, sym).await;

    for fail_at in [1i64, 2] {
        // fail_at=1：首块即失败（零分块落库）；fail_at=2：第二块失败（首块已落库）
        let inject = Arc::new(InjectStore::new(pool.clone()).fail_at(fail_at));
        let (rig, _s) = rig(11_000, inject.clone(), sym).await;
        let created = rig.svc.submit(submit_req("sv_tester_p4", sym)).await.unwrap();
        let fin = wait_terminal(&rig.svc, &created.id).await;

        assert_eq!(fin.status, StrategyRunStatus::Failed, "分块写失败 ⇒ failed（fail_at={fail_at}）");
        assert_ne!(fin.status, StrategyRunStatus::Succeeded);
        assert!(fin.error.as_deref().unwrap_or("").contains("结果分块落库失败"),
                "error 应点明分块落库失败，实际 {:?}", fin.error);
        assert!(rig.svc.get_result(&created.id).await.is_err(),
                "分块写失败 ⇒ 不得写 strategy_run_result（mark_succeeded 未执行）");
        let chunks = inject.result_chunk_count(&created.id, ResultKind::PerBar).await.unwrap();
        if fail_at == 1 {
            assert_eq!(chunks, 0, "首块即失败 ⇒ 零分块");
        } else {
            assert!(chunks >= 1, "第二块失败 ⇒ 首块已落库（边跑边写的可观测残渣），实际 {chunks}");
        }
        println!("[probe] fail_at={fail_at}: status={} chunks_per_bar={chunks} error={:?}",
                 fin.status.as_str(), fin.error);
    }
    clean(&pool, sym).await;
}

// ───────────────────── ② 取消 ⇒ canceled（分块保留、不得 succeeded） ─────────────────────

#[tokio::test]
async fn t_p4_cancel_after_chunks_written_never_succeeds() {
    let pool = test_support::test_pool().await;
    let sym = "tp4a02";
    clean(&pool, sym).await;

    // 注入「首块写成功后 DB 侧落 canceled」——即取消在分块写之后胜出的并发时序。
    let inject = Arc::new(InjectStore::new(pool.clone()).cancel_at(1));
    let (rig, _s) = rig(11_000, inject.clone(), sym).await;
    let created = rig.svc.submit(submit_req("sv_tester_p4", sym)).await.unwrap();
    let fin = wait_terminal(&rig.svc, &created.id).await;

    assert_eq!(fin.status, StrategyRunStatus::Canceled, "取消 ⇒ canceled");
    assert_ne!(fin.status, StrategyRunStatus::Succeeded, "取消后**不得**落 succeeded");
    assert!(rig.svc.get_result(&created.id).await.is_err(),
            "取消胜出 ⇒ mark_succeeded 守卫（status='running'）拦住 ⇒ 无结果行");
    let per_bar = inject.result_chunk_count(&created.id, ResultKind::PerBar).await.unwrap();
    assert!(per_bar >= 1, "已写分块保留（D8），实际 {per_bar}");
    println!("[probe] cancel 竞态胜出：status={} chunks_per_bar={per_bar}", fin.status.as_str());

    // 分块结构仍满足不变量：seq 从 0 单调递增、ts_from/ts_to = 本块首末 bar ts
    let cs = inject.result_chunks(&created.id, ResultKind::PerBar, 0, 100).await.unwrap();
    let mut last_seq = -1;
    for c in &cs {
        assert_eq!(c.seq, last_seq + 1, "seq 必须从 0 起单调递增（无空洞）");
        last_seq = c.seq;
        let arr = c.payload.as_array().expect("payload 为数组");
        assert_eq!(c.ts_from.timestamp(), arr.first().unwrap()["ts"].as_i64().unwrap(),
                   "ts_from = 本块首根 bar ts");
        assert_eq!(c.ts_to.timestamp(), arr.last().unwrap()["ts"].as_i64().unwrap(),
                   "ts_to = 本块末根 bar ts");
    }
    clean(&pool, sym).await;
}

// ───────────────────── ③ 成功路径：分块先于 mark_succeeded（真实 DB 顺序可观测） ─────────────────────

#[tokio::test]
async fn t_p4_success_path_writes_all_chunks_before_result_row() {
    let pool = test_support::test_pool().await;
    let sym = "tp4a03";
    clean(&pool, sym).await;
    let inject = Arc::new(InjectStore::new(pool.clone()));
    let (rig, _s) = rig(11_000, inject.clone(), sym).await;
    let created = rig.svc.submit(submit_req("sv_tester_p4", sym)).await.unwrap();
    let fin = wait_terminal(&rig.svc, &created.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "error={:?}", fin.error);

    let res = rig.svc.get_result(&created.id).await.expect("结果行");
    assert_eq!(res.result_format, "chunked_v1");
    assert_eq!(res.per_bar, serde_json::json!([]), "三列占位");
    assert_eq!(res.net_value, serde_json::json!([]));

    for kind in [ResultKind::PerBar, ResultKind::NetValue, ResultKind::Drawdown] {
        assert_eq!(inject.result_chunk_count(&created.id, kind).await.unwrap(), 3,
                   "{kind:?} 11000 根 ⇒ 3 块（5000/5000/1000）");
    }
    let pb = inject.result_chunks(&created.id, ResultKind::PerBar, 0, 10).await.unwrap();
    assert_eq!(pb.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![0, 1, 2], "seq 单调");
    assert_eq!(pb[0].payload.as_array().unwrap().len(), 5000);
    assert_eq!(pb[1].payload.as_array().unwrap().len(), 5000);
    assert_eq!(pb[2].payload.as_array().unwrap().len(), 1000);
    // 与喂入 bar 序列对齐
    let bars = flat_bars(11_000);
    for (i, c) in pb.iter().enumerate() {
        let chunk_first = bars[i * 5000].ts.timestamp();
        let chunk_last = bars[((i + 1) * 5000 - 1).min(10_999)].ts.timestamp();
        assert_eq!(c.ts_from.timestamp(), chunk_first, "块 {i} ts_from");
        assert_eq!(c.ts_to.timestamp(), chunk_last, "块 {i} ts_to");
    }
    clean(&pool, sym).await;
}

// ───────────────── ④ 协作式取消（应用层 in-memory flag 路径） ─────────────────

#[tokio::test]
async fn t_p4_cooperative_cancel_never_marks_succeeded() {
    let pool = test_support::test_pool().await;
    let sym = "tp4a04";
    clean(&pool, sym).await;
    let inject = Arc::new(InjectStore::new(pool.clone()));
    let (rig, _s) = rig(11_000, inject.clone(), sym).await;
    let created = rig.svc.submit(submit_req("sv_tester_p4", sym)).await.unwrap();
    // 立即取消（协作式：内存 flag 在下一 bar 边界生效 + DB 落 canceled）
    let canceled = rig.svc.cancel(&created.id).await.unwrap();
    assert_eq!(canceled.status, StrategyRunStatus::Canceled);
    let fin = wait_terminal(&rig.svc, &created.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Canceled, "取消后终态必须是 canceled");
    assert_ne!(fin.status, StrategyRunStatus::Succeeded);
    assert!(rig.svc.get_result(&created.id).await.is_err(),
            "取消 ⇒ 无结果行（分块可保留）");
    let chunks = inject.result_chunk_count(&created.id, ResultKind::PerBar).await.unwrap();
    println!("[probe] 协作式取消：status={} chunks_per_bar={chunks}（0..k 均可，只需不落 succeeded）",
             fin.status.as_str());
    clean(&pool, sym).await;
}

// ───────── ⑤ ADR-024 P6：fills 块同样「先于 mark_succeeded」+ 写失败 ⇒ failed ─────────

/// P6 新增：fills 块的写失败必须与其它分块同语义 —— `failed`、无 `strategy_run_result` 行。
/// 该用例同时证明 **fills 块写先于 `mark_succeeded`**（否则失败不会阻断成功态）。
#[tokio::test]
async fn t_p6_fills_chunk_write_failure_marks_failed_and_precedes_success() {
    let pool = test_support::test_pool().await;
    let sym = "tp6a05";
    clean(&pool, &sym).await;
    let inject = Arc::new(InjectStore::new(pool.clone()).fail_kind(ResultKind::Fills));
    let (rig, _s) = rig(11_000, inject.clone(), sym).await;
    let created = rig.svc.submit(submit_req("sv_tester_p4", sym)).await.unwrap();
    let fin = wait_terminal(&rig.svc, &created.id).await;

    assert_eq!(fin.status, StrategyRunStatus::Failed, "fills 块写失败 ⇒ failed；error={:?}", fin.error);
    assert!(fin.error.as_deref().unwrap_or("").contains("结果分块落库失败"));
    assert!(rig.svc.get_result(&created.id).await.is_err(),
            "fills 写失败 ⇒ mark_succeeded 未执行 ⇒ 无结果行（= fills 写先于 mark_succeeded）");
    assert_eq!(inject.result_chunk_count(&created.id, ResultKind::Fills).await.unwrap(), 0,
               "fills 块未落库");
    // 其余 kind 的块已写出（边跑边写），但 run 仍是 failed、无结果行
    let pb = inject.result_chunk_count(&created.id, ResultKind::PerBar).await.unwrap();
    println!("[probe] fills 写失败：status={} per_bar_chunks={pb} error={:?}",
             fin.status.as_str(), fin.error);
    assert!(rig.svc.get_result(&created.id).await.is_err(), "不得留半截结果当 succeeded");
    clean(&pool, &sym).await;
}

/// P6 新增：成功路径下 fills 单块（seq=0、ts_from/ts_to = 本 run 首末 bar ts）与 result 行共存。
#[tokio::test]
async fn t_p6_fills_chunk_single_block_and_result_row_coexist() {
    let pool = test_support::test_pool().await;
    let sym = "tp6a06";
    clean(&pool, &sym).await;
    let inject = Arc::new(InjectStore::new(pool.clone()));
    let (rig, _s) = rig(11_000, inject.clone(), sym).await;
    let created = rig.svc.submit(submit_req("sv_tester_p4", sym)).await.unwrap();
    let fin = wait_terminal(&rig.svc, &created.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "error={:?}", fin.error);
    let res = rig.svc.get_result(&created.id).await.expect("结果行");
    assert_eq!(res.result_format, "chunked_v1");

    let cs = inject.result_chunks(&created.id, ResultKind::Fills, 0, 100).await.unwrap();
    assert_eq!(cs.len(), 1, "fills 恒单块");
    assert_eq!(cs[0].seq, 0, "fills seq=0");
    let bars = flat_bars(11_000);
    assert_eq!(cs[0].ts_from.timestamp(), bars[0].ts.timestamp(), "ts_from = 首根 bar ts");
    assert_eq!(cs[0].ts_to.timestamp(), bars[10_999].ts.timestamp(), "ts_to = 末根 bar ts");
    let arr = cs[0].payload.as_array().expect("payload 数组");
    assert!(!arr.is_empty(), "扁平价格 + LumpSum 1.0 ⇒ 应有买入 + 期末强平两笔");
    println!("[probe] fills 单块：seq={} ts_from={} ts_to={} n={}",
             cs[0].seq, cs[0].ts_from, cs[0].ts_to, arr.len());
    clean(&pool, &sym).await;
}
