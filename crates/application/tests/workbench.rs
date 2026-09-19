//! WorkbenchService 测试（application 层；mock store/bar reader/symbols/sink + 真实 QuickJsRuntime）。
//! ⚠️ 非 tangle 手写（与 strategy.rs 测试同模式）。
//! 覆盖（P3a 任务书 TDD 矩阵）：
//! - submit 校验全路径：draft 版本 400 / 未知版本 404 / 未注册 symbol 400 / 区间超限 400 /
//!   slots 空或超 10 / weight≤0 / 阈值倒挂 / 非法 policy / 非法 stop / 非法 fee / 空区间 bar / >20 万 bar；
//! - 运行成功端到端：真实 published 版本 → 结果落库五 jsonb 字段齐全 + config 钉住快照
//!   （strategy_id/version_id/version/sha256/params 缺省填充/weight）+ 进度事件单调递增至 1.0；
//! - 取消语义：queued 取消 / running 取消（协作式，引擎 observer Break）/ 终态 409 / 未知 404；
//! - compare 并排结构（net_value+metrics，输入序，未知/未成功跳过）；
//! - preset CRUD + apply（重名 409 / 非法配置 400 / 未知 404）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    BacktestBarRead, CatalogEntry, Clock, NewStrategy, NewStrategyPreset, NewStrategyRun,
    NewStrategyVersion, ResultChunk, ResultKind, StrategyManageItem, StrategyPresetRow,
    StrategyPresetStore, StrategyRow, StrategyRunFilter, StrategyRunResult, StrategyRunStatus,
    StrategyRunStore, StrategyRunView, StrategyStore, StrategyVersionRow, SymbolRegistry,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use domain::types::{Code, Period, SourceId};

use application::error::StructuredError;
use application::workbench::{
    BarsWindow, SlotReq, SubmitRunReq, WorkbenchConflict, WorkbenchNotFound, WorkbenchService,
    WorkbenchValidation, GUARD_CONFIRM_BARS, MAX_BARS_GUARD,
};

// ── fixtures ──

/// 恒分插件（带参数，验证 params 缺省填充进快照）。
const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

/// 趋势插件（产生真实买卖信号：close > 105 → 90 分 Buy，否则 20 分 Sell）。
const TREND: &str = "function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }";

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 0, 0).unwrap()
}

struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        fixed_now()
    }
}

fn dbar(i: i64, close: f64) -> domain::types::Bar {
    domain::types::Bar {
        code: Code("600000".into()),
        period: Period::D1,
        ts: Utc.with_ymd_and_hms(2026, 9, 1, 1, 30, 0).unwrap() + Duration::days(i),
        open: close,
        high: close + 1.0,
        low: close - 1.0,
        close,
        volume: 1000,
        amount: close * 1000.0,
        source: SourceId::Tushare,
    }
}

/// 6 根日线：100,100,110,110,100,100（TREND → 1 笔完整交易）。
fn trend_bars() -> Vec<domain::types::Bar> {
    [100.0, 100.0, 110.0, 110.0, 100.0, 100.0]
        .iter()
        .enumerate()
        .map(|(i, c)| dbar(i as i64, *c))
        .collect()
}

fn flat_bars(n: usize) -> Vec<domain::types::Bar> {
    (0..n).map(|i| dbar(i as i64, 100.0)).collect()
}

// ── mocks ──

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

struct MockSymbols(Vec<String>);
#[async_trait::async_trait]
impl SymbolRegistry for MockSymbols {
    async fn enabled_codes(&self) -> anyhow::Result<Vec<Code>> {
        Ok(self.0.iter().map(|c| Code(c.clone())).collect())
    }
    async fn interval_secs(&self, _code: &Code) -> anyhow::Result<u64> {
        Ok(60)
    }
    async fn upsert(&self, _code: Code, _interval_secs: u64, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
}

/// 进度事件记录（run_id, progress, bar_ts）。
type ProgressEvent = (String, f64, Option<DateTime<Utc>>);

#[derive(Default)]
struct MockSink {
    events: Mutex<Vec<ProgressEvent>>,
}
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for MockSink {
    async fn send(
        &self,
        run_id: &str,
        progress: f64,
        bar_ts: Option<DateTime<Utc>>,
    ) -> anyhow::Result<()> {
        self.events.lock().unwrap().push((run_id.to_string(), progress, bar_ts));
        Ok(())
    }
}

/// 与 PgStrategyRunStore 同语义的内存 mock（条件更新/原子认领/级联结果/分块）。
#[derive(Default)]
struct MockRunStore {
    runs: Mutex<HashMap<String, StrategyRunView>>,
    results: Mutex<HashMap<String, StrategyRunResult>>,
    /// (run_id, chunk) —— ADR-024 P4 分块（“边跑边写”）。
    chunks: Mutex<Vec<(String, ResultChunk)>>,
    /// 测试钩子：置位后首个 append_result_chunk 将 run 并发迁移为 canceled，
    /// 模拟「分块已写但 mark_succeeded 的 status='running' 守卫拦住 succeeded」。
    cancel_on_append: std::sync::atomic::AtomicBool,
    /// P4b 反向/终态断言：置位后 `append_result_chunk` 直接返回 Err
    /// （模拟 D8 分块写失败 ⇒ run 必落 failed）。
    fail_on_append: std::sync::atomic::AtomicBool,
    /// P4b 终态帧必写断言：记录**每一次** `update_progress` **调用**（id, progress），
    /// 无论 status 守卫是否让它真正落库 —— 这样「取消路径」下终态帧的写入尝试也可被观察。
    progress_calls: Mutex<Vec<(String, f64)>>,
}

impl MockRunStore {
    fn view(&self, id: &str) -> Option<StrategyRunView> {
        self.runs.lock().unwrap().get(id).cloned()
    }
}

#[async_trait::async_trait]
impl StrategyRunStore for MockRunStore {
    async fn create_run(&self, run: &NewStrategyRun) -> anyhow::Result<StrategyRunView> {
        // 与 PgStrategyRunStore 同口径：requested/clamped/预估从 config 快照回读（P5）。
        let cfg = &run.config;
        let cfg_ts = |key: &str| {
            cfg.get(key)
                .and_then(|v| serde_json::from_value::<DateTime<Utc>>(v.clone()).ok())
        };
        let view = StrategyRunView {
            id: run.id.clone(),
            name: run.name.clone(),
            symbol: run.symbol.clone(),
            period: run.period.clone(),
            from_ts: run.from_ts,
            to_ts: run.to_ts,
            config: run.config.clone(),
            status: StrategyRunStatus::Queued,
            progress: 0.0,
            error: None,
            created_at: fixed_now(),
            started_at: None,
            finished_at: None,
            requested_from: cfg_ts("requested_from").unwrap_or(run.from_ts),
            requested_to: cfg_ts("requested_to").unwrap_or(run.to_ts),
            clamped: cfg.get("clamped").and_then(|v| v.as_bool()).unwrap_or(false),
            clamp_reason: cfg
                .get("clamp_reason")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            estimated_bars: cfg.get("estimated_bars").and_then(|v| v.as_i64()),
            bars_total: None,
            result_format: None,
        };
        self.runs.lock().unwrap().insert(run.id.clone(), view.clone());
        Ok(view)
    }

    async fn get_run(&self, id: &str) -> anyhow::Result<Option<StrategyRunView>> {
        Ok(self.view(id))
    }

    async fn list_runs(&self, filter: &StrategyRunFilter) -> anyhow::Result<Vec<StrategyRunView>> {
        let mut all: Vec<_> = self.runs.lock().unwrap().values().cloned().collect();
        all.sort_by(|a, b| (b.created_at, &b.id).cmp(&(a.created_at, &a.id)));
        Ok(all
            .into_iter()
            .filter(|r| filter.status.is_none_or(|s| r.status == s))
            .skip(filter.offset as usize)
            .take(filter.limit as usize)
            .collect())
    }

    async fn mark_started(&self, id: &str, started_at: DateTime<Utc>) -> anyhow::Result<bool> {
        let mut runs = self.runs.lock().unwrap();
        let Some(r) = runs.get_mut(id) else { return Ok(false) };
        if r.status != StrategyRunStatus::Queued {
            return Ok(false);
        }
        r.status = StrategyRunStatus::Running;
        r.started_at = Some(started_at);
        Ok(true)
    }

    async fn update_progress(&self, id: &str, progress: f64) -> anyhow::Result<()> {
        // P4b：先记录**调用**（含终态行被静默忽略者），再走 status 守卫（与 Pg 同语义）。
        self.progress_calls.lock().unwrap().push((id.to_string(), progress));
        let mut runs = self.runs.lock().unwrap();
        if let Some(r) = runs.get_mut(id) {
            if r.status == StrategyRunStatus::Running {
                r.progress = progress;
            }
        }
        Ok(())
    }

    async fn mark_succeeded(
        &self,
        id: &str,
        result: &StrategyRunResult,
        finished_at: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let mut runs = self.runs.lock().unwrap();
        let Some(r) = runs.get_mut(id) else { return Ok(false) };
        if r.status != StrategyRunStatus::Running {
            return Ok(false);
        }
        r.status = StrategyRunStatus::Succeeded;
        r.progress = 1.0;
        r.finished_at = Some(finished_at);
        self.results.lock().unwrap().insert(id.to_string(), result.clone());
        Ok(true)
    }

    async fn mark_failed(
        &self,
        id: &str,
        error: &str,
        finished_at: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let mut runs = self.runs.lock().unwrap();
        let Some(r) = runs.get_mut(id) else { return Ok(false) };
        if r.status != StrategyRunStatus::Queued && r.status != StrategyRunStatus::Running {
            return Ok(false);
        }
        r.status = StrategyRunStatus::Failed;
        r.error = Some(error.to_string());
        r.finished_at = Some(finished_at);
        Ok(true)
    }

    async fn mark_canceled(
        &self,
        id: &str,
        finished_at: DateTime<Utc>,
    ) -> anyhow::Result<Option<bool>> {
        let mut runs = self.runs.lock().unwrap();
        let Some(r) = runs.get_mut(id) else { return Ok(None) };
        if r.status.is_terminal() {
            return Ok(Some(false));
        }
        r.status = StrategyRunStatus::Canceled;
        r.finished_at = Some(finished_at);
        Ok(Some(true))
    }

    async fn get_result(&self, run_id: &str) -> anyhow::Result<Option<StrategyRunResult>> {
        Ok(self.results.lock().unwrap().get(run_id).cloned())
    }

    async fn append_result_chunk(&self, run_id: &str, chunk: &ResultChunk) -> anyhow::Result<()> {
        if self.fail_on_append.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(anyhow::anyhow!("注入：结果分块落库失败"));
        }
        self.chunks.lock().unwrap().push((run_id.to_string(), chunk.clone()));
        if self.cancel_on_append.load(std::sync::atomic::Ordering::Relaxed) {
            // 模拟并发取消：run 已非 running ⇒ 后续 mark_succeeded 返回 false（不落 succeeded）。
            let mut runs = self.runs.lock().unwrap();
            if let Some(r) = runs.get_mut(run_id) {
                if r.status == StrategyRunStatus::Running {
                    r.status = StrategyRunStatus::Canceled;
                    r.finished_at = Some(fixed_now());
                }
            }
        }
        Ok(())
    }

    async fn result_chunks(
        &self,
        run_id: &str,
        kind: ResultKind,
        offset: i64,
        limit: i64,
    ) -> anyhow::Result<Vec<ResultChunk>> {
        let g = self.chunks.lock().unwrap();
        let mut v: Vec<ResultChunk> = g
            .iter()
            .filter(|(r, c)| r == run_id && c.kind == kind)
            .map(|(_, c)| c.clone())
            .collect();
        v.sort_by_key(|c| c.seq);
        Ok(v.into_iter().skip(offset.max(0) as usize).take(limit.max(0) as usize).collect())
    }

    async fn result_chunks_in_range(
        &self,
        run_id: &str,
        kind: ResultKind,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> anyhow::Result<Vec<ResultChunk>> {
        let g = self.chunks.lock().unwrap();
        let mut v: Vec<ResultChunk> = g
            .iter()
            .filter(|(r, c)| r == run_id && c.kind == kind && c.ts_from <= to && c.ts_to >= from)
            .map(|(_, c)| c.clone())
            .collect();
        v.sort_by_key(|c| c.seq);
        Ok(v)
    }

    async fn result_chunk_count(&self, run_id: &str, kind: ResultKind) -> anyhow::Result<i64> {
        let g = self.chunks.lock().unwrap();
        Ok(g.iter().filter(|(r, c)| r == run_id && c.kind == kind).count() as i64)
    }
}

#[derive(Default)]
struct MockPresetStore {
    rows: Mutex<HashMap<String, StrategyPresetRow>>,
}

#[async_trait::async_trait]
impl StrategyPresetStore for MockPresetStore {
    async fn create_preset(&self, p: &NewStrategyPreset) -> anyhow::Result<StrategyPresetRow> {
        let mut rows = self.rows.lock().unwrap();
        if rows.values().any(|r| r.name == p.name) {
            return Err(anyhow::anyhow!("duplicate key value violates unique constraint"));
        }
        let row = StrategyPresetRow {
            id: p.id.clone(),
            name: p.name.clone(),
            config: p.config.clone(),
            created_at: fixed_now(),
            updated_at: fixed_now(),
        };
        rows.insert(p.id.clone(), row.clone());
        Ok(row)
    }

    async fn get_preset(&self, id: &str) -> anyhow::Result<Option<StrategyPresetRow>> {
        Ok(self.rows.lock().unwrap().get(id).cloned())
    }

    async fn find_preset_by_name(&self, name: &str) -> anyhow::Result<Option<StrategyPresetRow>> {
        Ok(self.rows.lock().unwrap().values().find(|r| r.name == name).cloned())
    }

    async fn list_presets(&self) -> anyhow::Result<Vec<StrategyPresetRow>> {
        let mut all: Vec<_> = self.rows.lock().unwrap().values().cloned().collect();
        all.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        Ok(all)
    }

    async fn update_preset(
        &self,
        id: &str,
        name: &str,
        config: &serde_json::Value,
    ) -> anyhow::Result<Option<StrategyPresetRow>> {
        let mut rows = self.rows.lock().unwrap();
        if rows.values().any(|r| r.name == name && r.id != id) {
            return Err(anyhow::anyhow!("duplicate key value violates unique constraint"));
        }
        let Some(r) = rows.get_mut(id) else { return Ok(None) };
        r.name = name.to_string();
        r.config = config.clone();
        r.updated_at = fixed_now() + Duration::seconds(1);
        Ok(Some(r.clone()))
    }

    async fn delete_preset(&self, id: &str) -> anyhow::Result<bool> {
        Ok(self.rows.lock().unwrap().remove(id).is_some())
    }
}

/// mock StrategyStore：仅 get_version 真实（HashMap），其余 unimplemented。
#[derive(Default)]
struct MockStrategyStore {
    versions: Mutex<HashMap<String, StrategyVersionRow>>,
}

impl MockStrategyStore {
    fn add_version(&self, id: &str, strategy_id: &str, code: &str, status: StrategyStatus) {
        let published_at = (status != StrategyStatus::Draft).then(fixed_now);
        self.versions.lock().unwrap().insert(
            id.to_string(),
            StrategyVersionRow {
                id: id.into(),
                strategy_id: strategy_id.into(),
                version: 1,
                code: code.into(),
                params_schema: serde_json::json!([
                    {"key": "score", "type": "float", "default": 80, "min": 0, "max": 100,
                     "description": "恒分"}
                ]),
                sha256: application::strategy::sha256_hex(code),
                status,
                approval_level: ApprovalLevel::BacktestOk,
                created_at: fixed_now(),
                published_at,
            },
        );
    }
}

#[async_trait::async_trait]
impl StrategyStore for MockStrategyStore {
    async fn create_strategy(&self, _s: &NewStrategy) -> anyhow::Result<StrategyRow> {
        unimplemented!()
    }
    async fn get_strategy(&self, _id: &str) -> anyhow::Result<Option<StrategyRow>> {
        unimplemented!()
    }
    async fn count_strategies(&self) -> anyhow::Result<i64> {
        unimplemented!()
    }
    async fn catalog(
        &self,
        _level: Option<ApprovalLevel>,
        _kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<CatalogEntry>> {
        unimplemented!()
    }
    async fn create_version(
        &self,
        _v: &NewStrategyVersion,
    ) -> anyhow::Result<StrategyVersionRow> {
        unimplemented!()
    }
    async fn get_version(&self, id: &str) -> anyhow::Result<Option<StrategyVersionRow>> {
        Ok(self.versions.lock().unwrap().get(id).cloned())
    }
    async fn find_version_by_name_sha(
        &self,
        _name: &str,
        _sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unimplemented!()
    }
    async fn list_versions(&self, _strategy_id: &str) -> anyhow::Result<Vec<StrategyVersionRow>> {
        unimplemented!()
    }
    async fn next_version_number(&self, _strategy_id: &str) -> anyhow::Result<i32> {
        unimplemented!()
    }
    async fn update_draft(
        &self,
        _id: &str,
        _code: &str,
        _params_schema: &serde_json::Value,
        _sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unimplemented!()
    }
    async fn mark_published(
        &self,
        _id: &str,
        _expected_code: &str,
        _sha256: &str,
        _params_schema: &serde_json::Value,
        _published_at: DateTime<Utc>,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unimplemented!()
    }
    async fn set_status(
        &self,
        _id: &str,
        _status: StrategyStatus,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        unimplemented!()
    }
    async fn manage_list(
        &self,
        _kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<StrategyManageItem>> {
        unimplemented!()
    }
    async fn update_meta(
        &self,
        _id: &str,
        _name: &str,
        _description: &str,
    ) -> anyhow::Result<Option<StrategyRow>> {
        unimplemented!()
    }
    async fn delete_strategy(&self, _id: &str) -> anyhow::Result<u64> {
        unimplemented!()
    }
}

// ── 装配 ──

struct Rig {
    svc: Arc<WorkbenchService>,
    runs: Arc<MockRunStore>,
    strategies: Arc<MockStrategyStore>,
    sink: Arc<MockSink>,
}

fn rig(bars: Vec<domain::types::Bar>, max_concurrent: usize) -> Rig {
    let runs = Arc::new(MockRunStore::default());
    let presets = Arc::new(MockPresetStore::default());
    let strategies = Arc::new(MockStrategyStore::default());
    let sink = Arc::new(MockSink::default());
    let svc = Arc::new(WorkbenchService::new(
        Arc::new(MockBars(bars)),
        runs.clone(),
        presets.clone(),
        strategies.clone(),
        Arc::new(MockSymbols(vec!["600000".into()])),
        sink.clone(),
        Arc::new(FixedClock),
        max_concurrent,
    ));
    Rig { svc, runs, strategies, sink }
}

fn fee_json() -> serde_json::Value {
    serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})
}

fn slot_req(version_id: &str) -> SlotReq {
    SlotReq {
        version_id: version_id.into(),
        params: serde_json::json!({}),
        weight: 1.0,
    }
}

fn submit_req(version_id: &str) -> SubmitRunReq {
    SubmitRunReq {
        name: String::new(),
        symbol: "600000".into(),
        period: "D1".into(),
        from: dbar(-1, 0.0).ts,
        to: dbar(100, 0.0).ts,
        slots: vec![slot_req(version_id)],
        buy_threshold: None,
        sell_threshold: None,
        policy: serde_json::json!({"LumpSum": {"position_pct": 1.0}}),
        stop: None,
        initial_capital: None,
        // ADR-019 D11-3：fee 为 Option（None = 按标的 type 查档案；本夹具显式传 = 旧口径）。
        fee: Some(fee_json()),
        // I-2/D6：默认前置预热 250 根（架构师裁决）；夹具 from 早于全部 bar → effective=0。
        warmup_bars: 250,
        // ADR-024 P5：资源护栏二次确认（缺省 false）。
        confirm: false,
    }
}

/// 轮询直到 run 终态（超时 30s 防挂死）。
async fn wait_terminal(runs: &MockRunStore, id: &str) -> StrategyRunView {
    for _ in 0..3000 {
        if let Some(r) = runs.view(id) {
            if r.status.is_terminal() {
                return r;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("run {id} 30s 未达终态");
}

/// ADR-024 P4 / D8 双读辅助：物化某 run 某 kind 的全部分块 bar（逐页拼接）。
async fn read_all(runs: &MockRunStore, run_id: &str, kind: ResultKind) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut off = 0i64;
    loop {
        let cs = runs.result_chunks(run_id, kind, off, 1000).await.unwrap();
        let got = cs.len() as i64;
        for c in &cs {
            if let Some(a) = c.payload.as_array() {
                out.extend(a.iter().cloned());
            }
        }
        off += got;
        if got < 1000 {
            break;
        }
    }
    out
}

// ── submit 校验全路径 ──

#[tokio::test]
async fn submit_rejects_draft_version_400() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_draft", "st_1", CONST_SCORE, StrategyStatus::Draft);
    let err = r.svc.submit(submit_req("sv_draft")).await.unwrap_err();
    let e = err.downcast_ref::<WorkbenchValidation>().expect("draft 版本 → 400");
    assert!(e.message.contains("draft") && e.message.contains("未发布"),
        "draft 文案须区分「未发布不可运行」（与 404 不存在区分）: {}", e.message);
    assert_eq!(e.code(), application::error::codes::VERSION_NOT_RUNNABLE, "draft 版本 400 码");
}

/// 2026-09-10 架构裁决：archived 版本允许审计重跑（代码不可变+sha256 钉住、回测不触真实资金）；
/// submit 放行 published|archived，config 快照钉住 `archived` 审计标记。
#[tokio::test]
async fn submit_accepts_archived_version_with_audit_marker() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_arch", "st_1", TREND, StrategyStatus::Archived);
    let run = r.svc.submit(submit_req("sv_arch")).await.expect("archived 版本审计重跑应可提交");
    assert_eq!(run.status, StrategyRunStatus::Queued);
    let slot = &run.config["slots"][0];
    assert_eq!(slot["version_id"], "sv_arch", "快照钉住 version_id");
    assert_eq!(slot["archived"], true, "archived 版本须带审计标记");
    assert_eq!(slot["sha256"].as_str().unwrap().len(), 64, "快照钉住 sha256");
    // 审计重跑真实执行至成功（不触真实资金，纯历史 bar 回放）
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "审计重跑应成功: {:?}", fin.error);
}

#[tokio::test]
async fn submit_marks_published_version_not_archived() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("published 提交成功");
    assert_eq!(run.config["slots"][0]["archived"], false, "published 版本审计标记为 false");
}

#[tokio::test]
async fn submit_rejects_unknown_version_404() {
    let r = rig(trend_bars(), 2);
    let err = r.svc.submit(submit_req("sv_none")).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchNotFound>().is_some(), "未知版本 → 404: {err:?}");
}

#[tokio::test]
async fn submit_rejects_unregistered_symbol_400() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let mut req = submit_req("sv_pub");
    req.symbol = "999999".into();
    let err = r.svc.submit(req).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some(), "未注册 symbol → 400");
}

/// ADR-024 P5 §3.1 反向断言（反假绿条款 #4）：**旧「日历天数超限 → 400」断言按新契约改写为
/// 「可提交（201）」**，不得简单删除。M15×259 天（用户被拒的那次）/ M1×1 年 / M30×2 年。
#[tokio::test]
async fn submit_accepts_long_spans_no_calendar_cap() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let start = dbar(0, 0.0).ts;
    // M15 × 259 天（原断言：259 天 > 93 天 → 400）。
    let mut req = submit_req("sv_pub");
    req.period = "M15".into();
    req.from = start;
    req.to = start + Duration::days(259);
    let run = r.svc.submit(req).await.expect("M15×259 天必须可提交（旧 400 已撤销）");
    assert_eq!(run.status, StrategyRunStatus::Queued);
    // M1 × 1 年（原断言：>93 天 → 400）。
    let mut req = submit_req("sv_pub");
    req.period = "M1".into();
    req.from = start;
    req.to = start + Duration::days(366);
    r.svc.submit(req).await.expect("M1×1 年必须可提交");
    // M30 × 2 年（原断言：>93 天 → 400）。
    let mut req = submit_req("sv_pub");
    req.period = "M30".into();
    req.from = start;
    req.to = start + Duration::days(731);
    r.svc.submit(req).await.expect("M30×2 年必须可提交");
    // from >= to 仍 400（基础校验保留）。
    let mut req = submit_req("sv_pub");
    req.to = req.from;
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "from>=to → 400");
}

/// 校验顺序：无交集 ⇒ 结构化 400 `range_empty`（带回显可用区间；D2/D3）——不产出 0 bar 的「成功」run。
#[tokio::test]
async fn submit_range_empty_is_structured_400_with_available_range() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let mut req = submit_req("sv_pub");
    // 夹具 bar 落在 2026-09-01..06；请求窗口完全在其之前 → 无交集。
    req.from = dbar(-100, 0.0).ts;
    req.to = dbar(-50, 0.0).ts;
    let err = r.svc.submit(req).await.unwrap_err();
    let e = err.downcast_ref::<StructuredError>().expect("结构化错误（非字符串）");
    assert_eq!(e.code, "range_empty");
    assert!(e.detail["available_from"].is_string(), "回显可用区间起（前端可编程消费）");
    assert!(e.detail["available_to"].is_string(), "回显可用区间止");
}

/// I-6/D3：工作台接受 H1（与试算同口径；未支持周期仍拒）。
#[tokio::test]
async fn submit_accepts_h1_and_rejects_unknown_period() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let mut req = submit_req("sv_pub");
    req.period = "H1".into();
    let run = r.svc.submit(req).await.expect("H1 应被接受（I-6/D3）");
    assert_eq!(run.period, "H1");
    // W1 看板读源扩展不入回测 → 仍拒。
    let mut req = submit_req("sv_pub");
    req.period = "W1".into();
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some());
}

/// I-2/D6 + I-3/D6：工作台 warmup 标记（前缀不计绩效）+ 钉住 config 回显生效 fee。
#[tokio::test]
async fn submit_warmup_marks_prefix_and_pins_effective_fee() {
    // 10 根恒价日线；请求 [bar5, bar10)，warmup_bars=5。
    let r = rig(flat_bars(10), 1);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let mut req = submit_req("sv_pub");
    req.from = dbar(5, 0.0).ts;
    req.to = dbar(10, 0.0).ts;
    req.warmup_bars = 5;
    let run = r.svc.submit(req).await.expect("提交成功");
    // 钉住 config：warmup requested/effective + 生效 fee（**扁平**形态，ADR-019 v1.1 R-1）。
    assert_eq!(run.config["warmup_requested"], serde_json::json!(5));
    assert_eq!(run.config["warmup_effective"], serde_json::json!(5));
    assert_eq!(run.config["fee"]["stamp_duty_pct"], serde_json::json!(0.05), "缺省股票口径回显（扁平）");
    // R-1：config.fee 必须为扁平 `fee_model_to_json` 形态（两段仅用于响应回显），且可被 `to_fee_model` 无损解析。
    assert!(run.config["fee"].get("effective").is_none(), "config.fee 不得含两段 effective 段");
    assert!(run.config["fee"].get("profile").is_none(), "config.fee 不得含两段 profile 段");
    let round = application::fee::to_fee_model(&run.config["fee"]).expect("钉住 fee 可往返解析");
    assert_eq!(application::fee::fee_model_to_json(&round), run.config["fee"], "扁平 fee 往返无损");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "{:?}", fin.error);
    // ADR-024 P4/D8：strategy_run_result 仅保留 trades/metrics + 占位；per_bar/net_value/drawdown 在分块表。
    let res = r.runs.get_result(&run.id).await.unwrap().expect("结果");
    assert_eq!(res.result_format, "chunked_v1", "新 run 判别列 = chunked_v1");
    assert_eq!(res.per_bar, serde_json::json!([]), "chunked_v1 三列写 [] 占位");
    let per_bar = read_all(&r.runs, &run.id, ResultKind::PerBar).await;
    assert_eq!(per_bar.len(), 10, "per_bar 含 warmup 前缀 + in-range");
    assert!(per_bar[..5].iter().all(|b| b["warmup"] == serde_json::json!(true)), "前 5 根标记 warmup");
    assert!(per_bar[5..].iter().all(|b| b["warmup"] == serde_json::json!(false)), "in-range 不标记");
    // 净值/回撤仅 in-range（5 点）。
    assert_eq!(read_all(&r.runs, &run.id, ResultKind::NetValue).await.len(), 5, "净值仅 in-range");
    assert_eq!(read_all(&r.runs, &run.id, ResultKind::Drawdown).await.len(), 5);
}

#[tokio::test]
async fn submit_rejects_bad_slots_and_config_400() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    // slots 空
    let mut req = submit_req("sv_pub");
    req.slots = vec![];
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "空 slots → 400");
    // slots > 10
    let mut req = submit_req("sv_pub");
    req.slots = (0..11).map(|_| slot_req("sv_pub")).collect();
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "11 slots → 400");
    // weight ≤ 0
    let mut req = submit_req("sv_pub");
    req.slots[0].weight = 0.0;
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "weight=0 → 400");
    // 阈值倒挂
    let mut req = submit_req("sv_pub");
    req.buy_threshold = Some(30.0);
    req.sell_threshold = Some(50.0);
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "buy<=sell → 400");
    // 非法 policy
    let mut req = submit_req("sv_pub");
    req.policy = serde_json::json!({"LumpSum": {"position_pct": 1.5}});
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "position_pct>1 → 400");
    // 非法 stop（value ≤ 0）
    let mut req = submit_req("sv_pub");
    req.stop = Some(serde_json::json!({"kind": "FixedPct", "value": -0.1, "trigger": "Intrabar"}));
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "stop value≤0 → 400");
    // 非法 fee（字段非数值）→ 400（v1.1 R-2：缺字段不再报错，改为字段级回退；**出现的非法字段**仍报错）
    let mut req = submit_req("sv_pub");
    req.fee = Some(serde_json::json!({"rate_pct": "x"}));
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "fee.rate_pct 非数值 → 400");
    // 非法 fee（stamp 越界）→ 400
    let mut req = submit_req("sv_pub");
    req.fee = Some(serde_json::json!({"stamp_duty_pct": 1.5}));
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "fee.stamp_duty_pct 越界 → 400");
    // 非法初始资金
    let mut req = submit_req("sv_pub");
    req.initial_capital = Some(0.0);
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "initial_capital=0 → 400");
    // params 超 schema min/max
    let mut req = submit_req("sv_pub");
    req.slots[0].params = serde_json::json!({"score": 500});
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "params 越界 → 400");
}

#[tokio::test]
async fn submit_rejects_empty_data_range_400() {
    // 无任何数据 → range_empty（结构化）。
    let r = rig(vec![], 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let err = r.svc.submit(submit_req("sv_pub")).await.unwrap_err();
    let e = err.downcast_ref::<StructuredError>().expect("空数据 → 结构化 400");
    assert_eq!(e.code, "range_empty");
}

// ── 运行成功端到端 ──

#[tokio::test]
async fn run_success_end_to_end() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", TREND, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("提交成功");
    assert_eq!(run.status, StrategyRunStatus::Queued, "入队 queued");

    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "应成功: {:?}", fin.error);
    assert_eq!(fin.progress, 1.0);
    assert!(fin.started_at.is_some() && fin.finished_at.is_some());

    // 结果五类数据齐全（ADR §13.4 全量粒度；P4/D8 后 per_bar/net_value/drawdown 走分块表）
    let res = r.runs.get_result(&run.id).await.unwrap().expect("结果应落库");
    assert_eq!(res.result_format, "chunked_v1");
    assert_eq!(res.per_bar, serde_json::json!([]), "chunked_v1 占位（数据在 strategy_run_bars）");
    let per_bar = read_all(&r.runs, &run.id, ResultKind::PerBar).await;
    assert_eq!(per_bar.len(), 6, "6 根 bar 全量记录");
    let rec = &per_bar[0];
    for key in ["ts", "scores", "aggregate", "signal", "orders", "events"] {
        assert!(rec.get(key).is_some(), "per_bar 记录缺字段 {key}");
    }
    assert!(res.trades.as_array().unwrap().len() == 1, "TREND fixture 应产生 1 笔交易");
    assert_eq!(read_all(&r.runs, &run.id, ResultKind::NetValue).await.len(), 6);
    assert_eq!(read_all(&r.runs, &run.id, ResultKind::Drawdown).await.len(), 6);
    assert!(res.metrics.is_object(), "metrics 为 8 项绩效对象");

    // config 钉住快照：strategy_id/version_id/version/sha256/params（缺省填充）/weight 全量
    let cfg = &fin.config;
    let slot = &cfg["slots"][0];
    assert_eq!(slot["strategy_id"], "st_1");
    assert_eq!(slot["version_id"], "sv_pub");
    assert_eq!(slot["version"], 1);
    assert_eq!(slot["sha256"], application::strategy::sha256_hex(TREND));
    assert_eq!(slot["params"]["score"], 80.0, "params 缺省填充入快照");
    assert_eq!(slot["weight"], 1.0);
    assert_eq!(cfg["buy_threshold"], 60.0, "阈值缺省 60");
    assert_eq!(cfg["sell_threshold"], 40.0);
    assert_eq!(cfg["initial_capital"], 100_000.0);

    // 进度事件：单调递增、末帧 1.0、run_id 正确
    let events = r.sink.events.lock().unwrap();
    let mine: Vec<_> = events.iter().filter(|(id, _, _)| id == &run.id).collect();
    assert!(!mine.is_empty(), "应有进度事件");
    assert!(mine.windows(2).all(|w| w[0].1 <= w[1].1), "进度单调不减");
    assert!((mine.last().unwrap().1 - 1.0).abs() < 1e-12, "末帧进度 1.0");
}

// ── 取消语义 ──

#[tokio::test]
async fn cancel_unknown_run_404_and_terminal_409() {
    let r = rig(trend_bars(), 2);
    let err = r.svc.cancel("sr_none").await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchNotFound>().is_some(), "未知 id → 404");

    // 终态不可取消 → 409
    r.strategies.add_version("sv_pub", "st_1", TREND, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded);
    let err = r.svc.cancel(&run.id).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchConflict>().is_some(), "终态取消 → 409");
}

#[tokio::test]
async fn cancel_queued_run_prevents_execution() {
    // max_concurrent=1：run1（3 万 bar）占住执行位，run2 排队；取消 run2 → 永不执行。
    let r = rig(flat_bars(30_000), 1);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run1 = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    let run2 = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    r.svc.cancel(&run2.id).await.expect("queued 可取消");

    let fin2 = wait_terminal(&r.runs, &run2.id).await;
    assert_eq!(fin2.status, StrategyRunStatus::Canceled, "queued 取消应落 canceled");
    assert!(fin2.started_at.is_none(), "queued 取消不应有 started_at（未被执行）");
    assert!(r.runs.get_result(&run2.id).await.unwrap().is_none(), "取消不落结果");

    let fin1 = wait_terminal(&r.runs, &run1.id).await;
    assert_eq!(fin1.status, StrategyRunStatus::Succeeded, "run1 正常完成");
}

#[tokio::test]
async fn cancel_running_run_cooperative_break() {
    // running 中取消：observer 检查点协作式 Break → Canceled，不落结果。
    let r = rig(flat_bars(50_000), 1);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.unwrap();

    // 等到确实进入 running（进度 > 0 说明引擎在跑）
    let mut entered = false;
    for _ in 0..3000 {
        if let Some(v) = r.runs.view(&run.id) {
            if v.status == StrategyRunStatus::Running && v.progress > 0.0 {
                entered = true;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(entered, "run 应进入 running 且产生进度");
    r.svc.cancel(&run.id).await.expect("running 可取消");

    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Canceled, "协作式取消应落 canceled: {:?}", fin.error);
    assert!(r.runs.get_result(&run.id).await.unwrap().is_none(), "取消不落结果");
}

// ── compare ──

#[tokio::test]
async fn compare_returns_side_by_side_net_value_and_metrics() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", TREND, StrategyStatus::Published);
    let run1 = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    let run2 = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    wait_terminal(&r.runs, &run1.id).await;
    wait_terminal(&r.runs, &run2.id).await;

    // 输入序保持；未知 id 与未成功 run 跳过
    let items = r
        .svc
        .compare(&[run2.id.clone(), "sr_none".into(), run1.id.clone()])
        .await
        .unwrap();
    assert_eq!(items.len(), 2, "未知 id 跳过");
    assert_eq!(items[0].run_id, run2.id, "按输入序");
    assert_eq!(items[1].run_id, run1.id);
    assert!(items[0].net_value.is_array() && !items[0].net_value.as_array().unwrap().is_empty());
    assert!(items[0].metrics.is_object(), "metrics 并排");
}

// ── preset CRUD + apply ──

fn preset_cfg(version_id: &str) -> serde_json::Value {
    serde_json::json!({
        "slots": [{"version_id": version_id, "params": {}, "weight": 1.0}],
        "buy_threshold": 60.0,
        "sell_threshold": 40.0,
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "stop": null,
        "initial_capital": 100000.0,
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    })
}

#[tokio::test]
async fn preset_crud_and_apply() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", TREND, StrategyStatus::Published);

    // create（config 校验 + 钉住快照：slots 展开为含 sha256/version 的钉住形态）
    let p = r.svc.create_preset("组合A", &preset_cfg("sv_pub")).await.expect("创建成功");
    assert_eq!(p.name, "组合A");
    let slot = &p.config["slots"][0];
    assert_eq!(slot["sha256"], application::strategy::sha256_hex(TREND), "预设钉住 sha256");
    assert_eq!(slot["strategy_id"], "st_1");
    assert_eq!(slot["params"]["score"], 80.0, "params 缺省填充");

    // 重名 → 409
    let err = r.svc.create_preset("组合A", &preset_cfg("sv_pub")).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchConflict>().is_some(), "重名 → 409");

    // 非法配置 → 400（weight=0）
    let mut bad = preset_cfg("sv_pub");
    bad["slots"][0]["weight"] = serde_json::json!(0.0);
    let err = r.svc.create_preset("组合B", &bad).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some(), "非法配置 → 400");
    // draft 版本 → 400
    r.strategies.add_version("sv_draft", "st_2", TREND, StrategyStatus::Draft);
    let err = r.svc.create_preset("组合C", &preset_cfg("sv_draft")).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some());

    // get/list
    assert_eq!(r.svc.get_preset(&p.id).await.unwrap().name, "组合A");
    let err = r.svc.get_preset("sp_none").await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchNotFound>().is_some());
    assert!(r.svc.list_presets().await.unwrap().iter().any(|x| x.id == p.id));

    // update（改名+改配置；撞名 409；未知 404）
    let p2 = r.svc.create_preset("组合D", &preset_cfg("sv_pub")).await.unwrap();
    let updated = r.svc.update_preset(&p.id, "组合A改", &preset_cfg("sv_pub")).await.unwrap();
    assert_eq!(updated.name, "组合A改");
    let err = r.svc.update_preset(&p2.id, "组合A改", &preset_cfg("sv_pub")).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchConflict>().is_some(), "update 撞名 → 409");
    let err = r.svc.update_preset("sp_none", "x", &preset_cfg("sv_pub")).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchNotFound>().is_some(), "update 未知 → 404");

    // apply：返回 config 供 submit 用（钉住形态原样返回）
    let applied = r.svc.apply_preset(&p.id).await.unwrap();
    assert_eq!(applied["slots"][0]["version_id"], "sv_pub");
    assert_eq!(applied["slots"][0]["sha256"], application::strategy::sha256_hex(TREND));
    let err = r.svc.apply_preset("sp_none").await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchNotFound>().is_some(), "apply 未知 → 404");

    // delete
    r.svc.delete_preset(&p.id).await.unwrap();
    assert!(r.svc.get_preset(&p.id).await.is_err());
    let err = r.svc.delete_preset(&p.id).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchNotFound>().is_some(), "二次删除 → 404");
}

// ── ADR-019（D11-3）：工作台按标的 type 推断费率（与试算同口径）──

/// 费率档案测试替身：`codes` 内 code → etf 档案（其余 → None = 无档案）。
struct StubEtfProfiles(Vec<&'static str>);

#[async_trait::async_trait]
impl domain::ports::FeeProfileStore for StubEtfProfiles {
    async fn for_symbol(&self, code: &str)
        -> anyhow::Result<Option<domain::ports::FeeProfileRow>> {
        if !self.0.contains(&code) {
            return Ok(None);
        }
        Ok(Some(domain::ports::FeeProfileRow {
            type_: "etf".into(),
            commission_rate_pct: 0.025,
            min_fee: 5.0,
            exchange_fee_pct: 0.0,
            regulatory_fee_pct: 0.0,
            stamp_duty_pct: 0.0,
            transfer_fee_pct: 0.0,
            note: "测试档案：全佣口径（经手费/证管费列 0）；印花税不征".into(),
            source: "test".into(),
        }))
    }
}

fn rig_with_fee_profiles(bars: Vec<domain::types::Bar>, codes: Vec<&'static str>) -> Rig {
    let runs = Arc::new(MockRunStore::default());
    let presets = Arc::new(MockPresetStore::default());
    let strategies = Arc::new(MockStrategyStore::default());
    let sink = Arc::new(MockSink::default());
    let svc = Arc::new(
        WorkbenchService::new(
            Arc::new(MockBars(bars)),
            runs.clone(),
            presets.clone(),
            strategies.clone(),
            Arc::new(MockSymbols(vec!["518880".into(), "600000".into()])),
            sink.clone(),
            Arc::new(FixedClock),
            1,
        )
        .with_fee_profiles(Arc::new(StubEtfProfiles(codes))),
    );
    Rig { svc, runs, strategies, sink }
}

/// 省略 fee 的 ETF 运行：钉住 config 快照为**扁平** fee（印花税 0，ADR-019 v1.1 R-1）；
/// 显式三键 fee（无 stamp）+ ETF 档案 → 字段级回退 stamp=0（R-2 本批核心断言）。
#[tokio::test]
async fn submit_fee_resolves_by_symbol_type_and_pins_source() {
    let r = rig_with_fee_profiles(flat_bars(10), vec!["518880"]);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    // ① 省略 fee + ETF 标的 → profile 解析：config.fee 扁平，印花税 0
    let mut req = submit_req("sv_pub");
    req.symbol = "518880".into();
    req.fee = None;
    let run = r.svc.submit(req).await.expect("提交成功");
    assert_eq!(run.config["fee"]["stamp_duty_pct"], serde_json::json!(0.0), "ETF 印花税 0（D11 主目标）");
    assert_eq!(run.config["fee"]["rate_pct"], serde_json::json!(0.025));
    assert_eq!(run.config["fee"]["min_fee"], serde_json::json!(5.0));
    assert_eq!(run.config["fee"]["slippage_bp"], serde_json::json!(2.0));
    assert!(run.config["fee"].get("effective").is_none(), "R-1：config.fee 扁平，无两段结构");
    application::fee::to_fee_model(&run.config["fee"]).expect("扁平 config.fee 可往返解析");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "{:?}", fin.error);

    // ② **核心断言（R-2 ①）**：UI 三键 fee（无 stamp）+ ETF → 字段级回退 → stamp=0（非旧 0.05）
    let mut req = submit_req("sv_pub");
    req.symbol = "518880".into();
    req.fee = Some(serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0}));
    let run2 = r.svc.submit(req).await.expect("提交成功");
    assert_eq!(run2.config["fee"]["stamp_duty_pct"], serde_json::json!(0.0),
        "三键 fee 无 stamp + ETF 档案 → 回退档案 stamp=0（本批核心断言）");

    // ③ 显式 stamp 优先（R-2 ③）：三键 + stamp=0.05 → 0.05
    let mut req = submit_req("sv_pub");
    req.symbol = "518880".into();
    req.fee = Some(serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0,
                                      "slippage_bp": 2.0, "stamp_duty_pct": 0.05}));
    let run2b = r.svc.submit(req).await.expect("提交成功");
    assert_eq!(run2b.config["fee"]["stamp_duty_pct"], serde_json::json!(0.05), "显式 stamp 优先");

    // ④ 未建档标的 → default 分支（旧默认），不借用他类型档案
    let mut req = submit_req("sv_pub");
    req.symbol = "600000".into();
    req.fee = None;
    let run3 = r.svc.submit(req).await.expect("提交成功");
    assert_eq!(run3.config["fee"]["stamp_duty_pct"], serde_json::json!(0.05));
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-024 P4b（D15）仪表阶段：计数器 + 分段 span + 改动前基线数字
// TDD：本段测试先于实现落地 —— 实现前必须**红**（无 `p4b.run_summary` 事件 / 无 `workbench_run` span）。
// 观测面 = 既有 tracing（JSON 日志）；不引新依赖（捕获层用 `tracing::Subscriber` 手写实现）。
// ─────────────────────────────────────────────────────────────────────────────

use std::collections::BTreeMap;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id as TracingId, Record};
use tracing::{Event, Metadata, Subscriber};

/// 捕获到的一条事件（message + 字段 + 当前 span 名字栈）。
#[derive(Debug, Clone, Default)]
struct CapEvent {
    message: String,
    fields: BTreeMap<String, String>,
    spans: Vec<String>,
}

/// 捕获到的一个 span（名字 + 字段 + 父 span 名）。
#[derive(Debug, Clone)]
struct CapSpan {
    name: String,
    fields: BTreeMap<String, String>,
    parent: Option<u64>,
    id: u64,
}

struct CapVisitor<'a>(&'a mut BTreeMap<String, String>);

impl Visit for CapVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().to_string(), format!("{value:?}"));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
}

thread_local! {
    /// 当前线程已进入的 span id 栈（**必须线程本地**：并发测试共享一个全局订阅者）。
    static CAP_STACK: std::cell::RefCell<Vec<u64>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[derive(Clone, Default)]
struct CaptureSub {
    events: Arc<Mutex<Vec<CapEvent>>>,
    spans: Arc<Mutex<Vec<CapSpan>>>,
    next_span: Arc<Mutex<u64>>,
}

impl Subscriber for CaptureSub {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, attrs: &Attributes<'_>) -> TracingId {
        let id = {
            let mut g = self.next_span.lock().unwrap();
            *g += 1;
            *g
        };
        let mut fields = BTreeMap::new();
        attrs.record(&mut CapVisitor(&mut fields));
        let parent = attrs
            .parent()
            .map(|p| p.clone().into_u64())
            .or_else(|| CAP_STACK.with(|st| st.borrow().last().copied()));
        self.spans.lock().unwrap().push(CapSpan {
            name: attrs.metadata().name().to_string(),
            fields,
            parent,
            id,
        });
        TracingId::from_u64(id)
    }
    fn record(&self, id: &TracingId, values: &Record<'_>) {
        let key = id.clone().into_u64();
        let mut spans = self.spans.lock().unwrap();
        if let Some(s) = spans.iter_mut().find(|s| s.id == key) {
            values.record(&mut CapVisitor(&mut s.fields));
        }
    }
    fn record_follows_from(&self, _: &TracingId, _: &TracingId) {}
    fn event(&self, event: &Event<'_>) {
        let mut fields = BTreeMap::new();
        event.record(&mut CapVisitor(&mut fields));
        let message = fields.remove("message").unwrap_or_default();
        let spans = {
            let stack = CAP_STACK.with(|st| st.borrow().clone());
            let all = self.spans.lock().unwrap();
            stack
                .iter()
                .filter_map(|id| all.iter().find(|s| s.id == *id).map(|s| s.name.clone()))
                .collect()
        };
        self.events.lock().unwrap().push(CapEvent { message, fields, spans });
    }
    fn enter(&self, id: &TracingId) {
        CAP_STACK.with(|st| st.borrow_mut().push(id.clone().into_u64()));
    }
    fn exit(&self, id: &TracingId) {
        let key = id.clone().into_u64();
        CAP_STACK.with(|st| {
            let mut stack = st.borrow_mut();
            if stack.last() == Some(&key) {
                stack.pop();
            }
        });
    }
}

impl CaptureSub {
    fn events(&self) -> Vec<CapEvent> {
        self.events.lock().unwrap().clone()
    }
    fn spans(&self) -> Vec<CapSpan> {
        self.spans.lock().unwrap().clone()
    }
    fn span_parent_name(&self, span: &CapSpan) -> Option<String> {
        span.parent
            .and_then(|p| self.spans().into_iter().find(|s| s.id == p).map(|s| s.name))
    }
}

/// 进程级安装捕获（`set_global_default` 一次；并发测试下线程内 `set_default` 不可靠 ——
/// tracing 的 callsite interest 缓存是**进程级**的，其他测试线程先用到同一 callsite 会把
/// 未注册订阅者时的 `never` 写进缓存 ⇒ 本线程的 `set_default` 收不到任何事件）。
/// 因此全局安装 + 事件按 `run_id`/`trace_id` 过滤（各测试 run 互不干扰）。
fn capture_subscriber() -> CaptureSub {
    static CAP: std::sync::OnceLock<CaptureSub> = std::sync::OnceLock::new();
    let cap = CAP.get_or_init(CaptureSub::default).clone();
    if tracing::subscriber::set_global_default(cap.clone()).is_ok() {
        tracing::callsite::rebuild_interest_cache();
    }
    cap
}

/// P4b 仪表自洽性（TDD 主测）：
/// ① 提交侧事件与父 span 带**同一** `trace_id`（贯穿 submit → 引擎 → 落库）；
/// ② 引擎侧产生帧数 ≥ 实际落库次数 ≥ 1（D15 时间窗节流后；旧契约 `produced == writes` 已由
///    `p4b_progress_db_time_window_throttle_reduces_writes` 接管 —— 节流前两者相等）；
/// ③ permit 持有各段（引擎/序列化/落库/进度排水）齐备且父 span = `workbench_run`；
/// ④ 汇总事件在父 span 上下文内（可检索）。
#[tokio::test]
async fn p4b_run_summary_counters_are_self_consistent() {
    let cap = capture_subscriber();

    let r = rig(flat_bars(300), 1);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("提交成功");
    let terminal = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(terminal.status, StrategyRunStatus::Succeeded, "run 应成功");

    let events = cap.events();
    let sum = |e: &CapEvent, k: &str| -> String {
        e.fields
            .get(k)
            .unwrap_or_else(|| panic!("事件 {} 缺字段 {k}（实测字段: {:?}）", e.message, e.fields))
            .clone()
    };
    // 本 run 的事件（并发测试下其他 run 的事件也在同一全局捕获里 ⇒ 必须按 run_id 过滤）
    let mine: Vec<CapEvent> = events
        .iter()
        .filter(|e| e.fields.get("run_id").map(String::as_str) == Some(run.id.as_str()))
        .cloned()
        .collect();

    // ① 提交侧事件存在且带 run_id / trace_id；父 span 与事件同 trace_id
    let submit_ev = mine
        .iter()
        .find(|e| e.message == "p4b.submit")
        .unwrap_or_else(|| {
            panic!(
                "缺提交侧事件 p4b.submit（run_id={}）；本 run 已捕获={:?}",
                run.id,
                mine.iter().map(|e| e.message.clone()).collect::<Vec<_>>()
            )
        });
    let trace_id = sum(submit_ev, "trace_id");
    assert_eq!(sum(submit_ev, "run_id"), run.id, "提交侧事件 run_id 必须等于 run.id");
    let spans = cap.spans();
    let root = spans
        .iter()
        .find(|s| {
            s.name == "workbench_run"
                && s.fields.get("trace_id").map(String::as_str) == Some(trace_id.as_str())
                && s.fields.get("run_id").map(String::as_str) == Some(run.id.as_str())
        })
        .unwrap_or_else(|| {
            panic!(
                "缺父 span workbench_run(run_id={})；已捕获 span={:?}",
                run.id,
                spans
                    .iter()
                    .filter(|s| s.name == "workbench_run")
                    .map(|s| s.fields.clone())
                    .collect::<Vec<_>>()
            )
        });
    assert_eq!(
        root.fields.get("bars_total").map(String::as_str),
        Some("300"),
        "父 span bars_total 必须由 span.record 补全"
    );

    // ② 汇总事件：帧数自洽（produced == writes == 理论帧数 = bars）
    let summary = mine
        .iter()
        .find(|e| e.message == "p4b.run_summary")
        .expect("缺每 run 汇总事件 p4b.run_summary（P4b 未落地）");
    assert_eq!(sum(summary, "trace_id"), trace_id, "汇总事件必须带同一 trace_id（贯穿至落库段）");
    assert_eq!(sum(summary, "run_id"), run.id);
    let bars_total: u64 = sum(summary, "bars_total").parse().unwrap();
    let produced: u64 = sum(summary, "progress_frames_produced").parse().unwrap();
    let writes: u64 = sum(summary, "progress_db_writes").parse().unwrap();
    assert_eq!(bars_total, 300, "本夹具 bars=300");
    assert_eq!(produced, 300, "300 bar ⇒ 0.1% 粒度节流下逐 bar 前进 ⇒ 300 帧");
    // ADR-024 D15 任务一（时间窗节流）后契约：帧数不变，但落库被 ≥250ms 窗口降频 ⇒
    // `1 <= writes <= produced`。旧契约 `produced == writes`（逐帧落库）由节流方案取代
    //（判别性证据：`p4b_progress_db_time_window_throttle_reduces_writes` + 报告 §任务一-3 反向）。
    assert!(writes >= 1, "至少落一次库（首帧或终态帧）");
    assert!(writes <= produced, "落库次数不得超产生帧数（writes={writes} produced={produced}）");
    assert!(
        sum(summary, "progress_db_write_ms").parse::<f64>().unwrap() >= 0.0,
        "落库累计耗时必须可解析"
    );

    // ③ permit 持有各段：引擎/序列化/落库/进度排水 + permit 总持有
    for k in [
        "permit_hold_ms",
        "engine_ms",
        "result_serialize_ms",
        "result_write_ms",
        "progress_drain_tail_ms",
        "progress_drain_total_ms",
        "progress_db_write_ms",
        "progress_ws_send_ms",
        "fetch_ms",
        "mark_started_ms",
    ] {
        sum(summary, k).parse::<f64>().unwrap_or_else(|_| panic!("分段字段 {k} 不可解析"));
    }
    let hold: f64 = sum(summary, "permit_hold_ms").parse().unwrap();
    let engine: f64 = sum(summary, "engine_ms").parse().unwrap();
    assert!(hold >= engine, "permit 持有必须覆盖引擎段（hold={hold} engine={engine}）");

    // ④ 子 span 结构：各段子 span 必须挂在**本 run 的**父 span 下；汇总事件在父 span 上下文内
    let segments: Vec<String> = spans
        .iter()
        .filter(|s| s.name == "p4b.segment" && s.parent == Some(root.id))
        .filter_map(|s| s.fields.get("segment").cloned())
        .collect();
    for want in ["engine", "result_serialize", "result_write", "progress_drain"] {
        assert!(segments.iter().any(|s| s == want), "缺分段子 span: {want}（实测 {segments:?}）");
    }
    let engine_span = spans
        .iter()
        .find(|s| {
            s.name == "p4b.segment"
                && s.parent == Some(root.id)
                && s.fields.get("segment").map(String::as_str) == Some("engine")
        })
        .expect("缺 engine 分段 span");
    assert_eq!(
        cap.span_parent_name(engine_span).as_deref(),
        Some("workbench_run"),
        "engine 分段 span 的父 span 必须是 workbench_run"
    );
    // 取数段子 span（在 submit 阶段创建，早于 run_id ⇒ 以 trace_id 标识）
    let fetch_span = spans.iter().find(|s| {
        s.name == "p4b.segment"
            && s.fields.get("segment").map(String::as_str) == Some("fetch")
            && s.fields.get("trace_id").map(String::as_str) == Some(trace_id.as_str())
    });
    let fetch_span = fetch_span.expect("缺 fetch 分段 span（submit 侧）");
    assert_eq!(
        cap.span_parent_name(fetch_span).as_deref(),
        Some("workbench_run"),
        "fetch 分段 span 的父 span 必须是 workbench_run"
    );
    assert!(
        summary.spans.iter().any(|s| s == "workbench_run"),
        "汇总事件必须落在父 span workbench_run 上下文内（实测 {:?}）",
        summary.spans
    );
    // 原始输出（可复核）：P4b 观测量 + span 结构
    println!("[P4b/capture] 事件数={} span 数={}", events.len(), spans.len());
    for e in events.iter().filter(|e| {
        e.message.starts_with("p4b.")
            && (e.fields.get("run_id").map(String::as_str) == Some(run.id.as_str())
                || e.fields.get("trace_id").map(String::as_str) == Some(trace_id.as_str()))
    }) {
        println!("[P4b/capture] {} spans={:?} fields={:?}", e.message, e.spans, e.fields);
    }
    println!("[P4b/capture] span workbench_run fields={:?}", root.fields);
}

// ── ADR-024 D15 任务一：进度落库**时间窗节流**（≥250ms/次；帧粒度不变；终态必写） ──

/// 由捕获层取某 run 的 `p4b.run_summary` 字段表（未出现时 panic）。
fn p4b_summary_fields(cap: &CaptureSub, run_id: &str) -> Option<std::collections::BTreeMap<String, String>> {
    cap.events()
        .into_iter()
        .filter(|e| {
            e.message == "p4b.run_summary"
                && e.fields.get("run_id").map(String::as_str) == Some(run_id)
        })
        .next_back()
        .map(|e| e.fields)
}

/// 等待并取出某 run 的 `p4b.run_summary`（终态置位与汇总事件之间有一瞬）。
async fn wait_p4b_summary(cap: &CaptureSub, run_id: &str) -> std::collections::BTreeMap<String, String> {
    for _ in 0..3000 {
        if let Some(f) = p4b_summary_fields(cap, run_id) {
            return f;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("15s 内未出现 p4b.run_summary（run_id={run_id}）");
}

/// 该 run 最后一次 `update_progress` **调用**的进度值（含被状态守卫静默忽略者）。
fn last_progress_call(runs: &MockRunStore, run_id: &str) -> Option<f64> {
    runs.progress_calls
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|(r, _)| r == run_id)
        .map(|(_, p)| *p)
}

/// 该 run 经由 `sink.send` 发出的**最后一帧**进度（WS 帧粒度证据）。
fn last_sink_frame(sink: &MockSink, run_id: &str) -> Option<f64> {
    sink.events
        .lock()
        .unwrap()
        .iter()
        .filter(|(r, _, _)| r == run_id)
        .map(|(_, p, _)| *p)
        .next_back()
}

/// **主测（红→绿）**：时间窗节流降低落库次数，且**成功路径**终态帧（1.0）必落库。
///
/// 夹具 3,000 bar ⇒ 理论帧数 1,001（0.1% 粒度不因落库节流改变）；引擎仅数十 ms
/// ⇒ 整 run 远短于 250ms 时间窗 ⇒ 落库应被压到极少次（首帧 + 终态帧）。
#[tokio::test]
async fn p4b_progress_db_time_window_throttle_reduces_writes() {
    let cap = capture_subscriber();
    let r = rig(flat_bars(3_000), 1);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("提交成功");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "run 应成功: {:?}", fin.error);

    let f = wait_p4b_summary(&cap, &run.id).await;
    let produced: u64 = f["progress_frames_produced"].parse().unwrap();
    let writes: u64 = f["progress_db_writes"].parse().unwrap();
    assert_eq!(produced, 1_001, "0.1% 粒度下 3,000 bar ⇒ 1,001 帧（帧粒度不因落库节流而变）");
    assert!(writes >= 1, "至少落一次库（首帧或终态帧）");
    assert!(
        writes < produced,
        "时间窗节流应显著减少落库：writes={writes} produced={produced}（相等 ⇒ 节流未生效）"
    );
    assert_eq!(
        last_progress_call(&r.runs, &run.id),
        Some(1.0),
        "成功路径终态帧（progress=1.0）必须落库"
    );
    // 帧粒度不变：WS sink 收到的帧数 == 引擎产生帧数。
    let sunk = r.sink.events.lock().unwrap().iter().filter(|(r, _, _)| r == &run.id).count();
    assert_eq!(sunk as u64, produced, "WS 帧粒度不变（每帧仍推送）");
    println!(
        "[D15-throttle] bars={} frames={produced} writes={writes} throttled={} ws_frames={sunk} \
         db_ms={} hold_ms={} last_update_progress={:?}",
        f["bars_total"],
        f["progress_db_throttled"],
        f["progress_db_write_ms"],
        f["permit_hold_ms"],
        last_progress_call(&r.runs, &run.id),
    );
}

/// **终态必写 · 失败路径**：人为注入 chunk 写失败（D8）⇒ run 落 failed；终态进度仍必落库。
#[tokio::test]
async fn p4b_progress_terminal_frame_persisted_on_chunk_write_failure() {
    let cap = capture_subscriber();
    let r = rig(flat_bars(3_000), 1);
    r.runs
        .fail_on_append
        .store(true, std::sync::atomic::Ordering::Relaxed);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("提交成功");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Failed, "分块写失败 ⇒ run 落 failed: {:?}", fin.error);

    let f = wait_p4b_summary(&cap, &run.id).await;
    let produced: u64 = f["progress_frames_produced"].parse().unwrap();
    let writes: u64 = f["progress_db_writes"].parse().unwrap();
    assert!(writes >= 1, "失败路径也必须落一次进度");
    assert!(writes < produced, "节流生效：writes={writes} produced={produced}");
    assert_eq!(
        last_progress_call(&r.runs, &run.id),
        Some(1.0),
        "失败路径终态帧（引擎跑完 ⇒ 1.0）必须落库，不得被节流吞掉"
    );
    println!(
        "[D15-terminal/failed] status={:?} frames={produced} writes={writes} throttled={} \
         last_update_progress={:?}",
        fin.status,
        f["progress_db_throttled"],
        last_progress_call(&r.runs, &run.id),
    );
}

/// **终态必写 · 取消路径**：末帧 < 1.0（引擎中途 Break）——节流把它暂存后，必须在排水收口补写。
///
/// 这是对「通道关闭时冲刷 pending 帧」的**判别性**断言：若只做节流不做终态补写，
/// 末帧（在被取消时已落在 250ms 窗口内）会被吞掉 ⇒ 本断言变红。
#[tokio::test]
async fn p4b_progress_terminal_frame_persisted_on_cancel() {
    let cap = capture_subscriber();
    let r = rig(flat_bars(50_000), 1);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("提交成功");

    // 等到确实进入 running 且已有可观进度（保证取消时已产生多帧、末帧远 < 1.0）。
    let mut entered = false;
    for _ in 0..3000 {
        if let Some(v) = r.runs.view(&run.id) {
            if v.status == StrategyRunStatus::Running && v.progress >= 0.2 {
                entered = true;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(entered, "run 应进入 running 且进度 ≥ 0.2");
    r.svc.cancel(&run.id).await.expect("running 可取消");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Canceled, "协作式取消应落 canceled: {:?}", fin.error);

    let f = wait_p4b_summary(&cap, &run.id).await;
    let produced: u64 = f["progress_frames_produced"].parse().unwrap();
    let writes: u64 = f["progress_db_writes"].parse().unwrap();
    let last_frame = last_sink_frame(&r.sink, &run.id).expect("取消前已应有进度帧");
    assert!(last_frame < 1.0, "取消路径末帧应 < 1.0（否则本断言失去判别力）: {last_frame}");
    assert!(writes >= 1, "取消路径也必须落一次进度");
    assert!(
        writes < produced,
        "取消路径同样受时间窗节流：writes={writes} produced={produced}"
    );
    assert_eq!(
        last_progress_call(&r.runs, &run.id),
        Some(last_frame),
        "取消路径：末帧（<1.0）必须经排水补写入库（节流不得吞掉终态）——\n\
         sink 末帧={last_frame} 但 update_progress 末次={:?}（writes={writes}/produced={produced}）",
        last_progress_call(&r.runs, &run.id)
    );
    println!(
        "[D15-terminal/cancel] status={:?} frames={produced} writes={writes} throttled={} \
         sink_last_frame={last_frame} last_update_progress={:?}",
        fin.status,
        f["progress_db_throttled"],
        last_progress_call(&r.runs, &run.id),
    );
}

// ── ADR-024 P4 / D8-D10：结果分块落库 + 双读 + 读取端点（bars/curve/result/brief） ──

/// 大 run bar 数（> 1 个 chunk；3 块：5000 + 5000 + 1000）。
const P4_N: usize = 11_000;

/// 提交一个大 run 并等至 succeeded，返回 run id（P4 分块读取夹具）。
async fn submitted_big(r: &Rig) -> String {
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("提交成功");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "应成功: {:?}", fin.error);
    run.id
}

/// 边跑边写：11,000 根 ⇒ 3 块（5000/5000/1000），seq 单调、逐块 ts 衔接。
#[tokio::test]
async fn p4_chunked_write_seq_and_boundaries() {
    let r = rig(flat_bars(P4_N), 2);
    let id = submitted_big(&r).await;
    assert_eq!(r.runs.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 3,
        "11000 = 5000 + 5000 + 1000");
    let chunks = r.runs.result_chunks(&id, ResultKind::PerBar, 0, 100).await.unwrap();
    assert_eq!(chunks.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![0, 1, 2], "seq 单调递增");
    assert_eq!(chunks[0].payload.as_array().unwrap().len(), 5000, "非末块恰 5000 根");
    assert_eq!(chunks[2].payload.as_array().unwrap().len(), 1000, "末块为余数");
    // ts_from/ts_to = 本块首/末 bar ts（与 bar 序列一致）
    assert_eq!(chunks[0].ts_from, dbar(0, 0.0).ts);
    assert_eq!(chunks[0].ts_to, dbar(4999, 0.0).ts);
    assert_eq!(chunks[2].ts_to, dbar(P4_N as i64 - 1, 0.0).ts);
    // 净值/回撤各自 seq 从 0 起（in-range 全量 ⇒ 同样 3 块）
    assert_eq!(r.runs.result_chunk_count(&id, ResultKind::NetValue).await.unwrap(), 3);
    assert_eq!(r.runs.result_chunk_count(&id, ResultKind::Drawdown).await.unwrap(), 3);
}

/// `GET /bars` offset/limit 边界（0 / 恰好一块 / 跨块 / 超末尾）。
#[tokio::test]
async fn p4_bars_paging_offset_limit_boundaries() {
    let r = rig(flat_bars(P4_N), 2);
    let id = submitted_big(&r).await;

    let p0 = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Offset { offset: 0, limit: 5000 })
        .await.unwrap();
    assert_eq!(p0.bars.len(), 5000, "offset=0 恰好一块");
    assert!(p0.has_more);
    assert_eq!(p0.next_offset, Some(5000));
    assert_eq!(p0.total, P4_N as i64);

    let p1 = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Offset { offset: 5000, limit: 5000 })
        .await.unwrap();
    assert_eq!(p1.bars.len(), 5000);
    assert!(p1.has_more);
    assert_eq!(p1.next_offset, Some(10000));

    let p2 = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Offset { offset: 10000, limit: 5000 })
        .await.unwrap();
    assert_eq!(p2.bars.len(), 1000, "末块余数");
    assert!(!p2.has_more);
    assert_eq!(p2.next_offset, None);

    let p3 = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Offset { offset: 20000, limit: 5000 })
        .await.unwrap();
    assert!(p3.bars.is_empty(), "超末尾 → 空");
    assert!(!p3.has_more);

    // 跨块：offset=4999/limit=2 横跨 chunk 0/1 边界
    let x = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Offset { offset: 4999, limit: 2 })
        .await.unwrap();
    assert_eq!(x.bars.len(), 2, "跨块读取不丢边界");
    assert_eq!(x.bars[0]["ts"], serde_json::json!(dbar(4999, 0.0).ts.timestamp()));
    assert_eq!(x.bars[1]["ts"], serde_json::json!(dbar(5000, 0.0).ts.timestamp()));
    // 与逐块读取一致（跨块切片 = 前块末 + 后块首）
    assert_eq!(x.bars[0], p0.bars[4999]);
}

/// `GET /bars` 区间读：chunk 外沿由 application 在**块内按 ts 过滤**（契约写明的边界）。
#[tokio::test]
async fn p4_bars_range_client_filters_chunk_edges() {
    let r = rig(flat_bars(P4_N), 2);
    let id = submitted_big(&r).await;
    // 区间横跨 chunk 0/1 边界：块 0 覆盖 dbar(0..4999)、块 1 覆盖 dbar(5000..9999)。
    let from = dbar(4998, 0.0).ts;
    let to = dbar(5002, 0.0).ts;
    let res = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Range { from, to })
        .await.unwrap();
    assert_eq!(res.bars.len(), 5, "闭区间 [4998,5002] = 5 根（非整块 10000 根）");
    for b in &res.bars {
        let ts = b["ts"].as_i64().unwrap();
        assert!(ts >= from.timestamp() && ts <= to.timestamp(), "全部落在区间内（外沿已过滤）");
    }
    assert!(!res.has_more);
    // 区间仍在块内（单块外沿）：[10,12] → 3 根
    let inner = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Range { from: dbar(10, 0.0).ts, to: dbar(12, 0.0).ts })
        .await.unwrap();
    assert_eq!(inner.bars.len(), 3);
}

/// `GET /curve`：显式抽样（均匀保首尾）+ `downsampled`/`original_bars`。
#[tokio::test]
async fn p4_curve_downsampling_marks_and_endpoints() {
    let r = rig(flat_bars(P4_N), 2);
    let id = submitted_big(&r).await;
    let all = read_all(&r.runs, &id, ResultKind::NetValue).await;
    assert_eq!(all.len(), P4_N, "净值 in-range 全量");

    let c = r.svc.result_curve(&id, ResultKind::NetValue, Some(100)).await.unwrap();
    assert_eq!(c.points.len(), 100, "目标点数 k=100");
    assert!(c.downsampled, "必带 downsampled:true");
    assert_eq!(c.original_bars, P4_N as i64);
    assert_eq!(c.k, 100);
    assert_eq!(c.points[0], all[0], "保首点");
    assert_eq!(c.points[99], all[all.len() - 1], "保尾点");

    // k >= n ⇒ 不抽样
    let full = r.svc.result_curve(&id, ResultKind::NetValue, Some(20_000)).await.unwrap();
    assert!(!full.downsampled);
    assert_eq!(full.points.len(), P4_N);

    // 缺省 k = 2000（< n）⇒ 抽样
    let dflt = r.svc.result_curve(&id, ResultKind::NetValue, None).await.unwrap();
    assert_eq!(dflt.k, 2000);
    assert!(dflt.downsampled);
}

/// `GET /result` 兼容：chunked_v1 ⇒ summary + 首页 per_bar + has_more + next_offset（显式截断）。
#[tokio::test]
async fn p4_result_compat_chunked_first_page() {
    let r = rig(flat_bars(P4_N), 2);
    let id = submitted_big(&r).await;
    let rc = r.svc.result_compat(&id, 5000).await.unwrap();
    assert_eq!(rc.result_format, "chunked_v1");
    assert_eq!(rc.per_bar.len(), 5000, "首页 per_bar");
    assert!(rc.has_more, "显式 has_more（非静默截断）");
    assert_eq!(rc.next_offset, Some(5000));
    assert!(rc.metrics.is_object(), "summary 带 metrics");
    assert_eq!(rc.summary.chunk_count, 3);
    assert_eq!(rc.summary.bars_total, P4_N as i64);
    assert_eq!(rc.summary.result_format.as_deref(), Some("chunked_v1"));
    // 首页 per_bar 与 /bars 首页逐值一致
    let bars0 = r.svc
        .result_bars(&id, ResultKind::PerBar, BarsWindow::Offset { offset: 0, limit: 5000 })
        .await.unwrap();
    assert_eq!(rc.per_bar, bars0.bars);
}

/// `GET /brief`：轻量摘要字段（无结果 run 也能读；ADR-024 P5：requested/effective/clamped/预估已落地）。
#[tokio::test]
async fn p4_brief_fields() {
    let r = rig(flat_bars(P4_N), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    // queued：无结果行 ⇒ result_format None、chunk_count 0
    let b0 = r.svc.result_brief(&run.id).await.unwrap();
    assert_eq!(b0.status, StrategyRunStatus::Queued);
    assert_eq!(b0.result_format, None);
    assert_eq!(b0.chunk_count, 0);
    // P5：请求 from=dbar(-1) 早于可得起 dbar(0) ⇒ 收缩（clamped）。
    assert!(b0.clamped, "P5：左端超出可得区间 ⇒ clamped=true");
    assert!(b0.effective_from > b0.requested_from, "effective 被收缩到可得起");
    assert_eq!(b0.estimated_bars, Some(P4_N as i64), "D12 预扫描回显（不再恒 null）");

    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "{:?}", fin.error);
    let b = r.svc.result_brief(&run.id).await.unwrap();
    assert_eq!(b.result_format.as_deref(), Some("chunked_v1"));
    assert_eq!(b.chunk_count, 3);
    assert_eq!(b.bars_total, P4_N as i64);
    assert!(b.metrics.is_some());
    assert_eq!(b.estimated_bars, Some(P4_N as i64));
}

/// D8 双读：`legacy_single` 旧 run 全量可读（不回填；chunked 端点对 legacy 亦走内联列）。
#[tokio::test]
async fn p4_legacy_dual_read_full() {
    let r = rig(flat_bars(6), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "{:?}", fin.error);
    // 改写为 legacy 形态（模拟迁移前历史 run；删掉分块以证明读自内联列）。
    {
        let mut results = r.runs.results.lock().unwrap();
        let res = results.get_mut(&run.id).unwrap();
        res.result_format = "legacy_single".into();
        res.per_bar = serde_json::json!([{"ts": 1, "signal": "Hold"}, {"ts": 2, "signal": "Buy"}]);
        res.net_value = serde_json::json!([[1, 100.0], [2, 101.0]]);
        res.drawdown = serde_json::json!([[1, 0.0], [2, -0.01]]);
    }
    r.runs.chunks.lock().unwrap().clear();

    // /result：legacy 全量
    let rc = r.svc.result_compat(&run.id, 5000).await.unwrap();
    assert_eq!(rc.result_format, "legacy_single");
    assert_eq!(rc.per_bar.len(), 2, "legacy 全量 per_bar");
    assert!(!rc.has_more);
    assert_eq!(rc.per_bar[1]["signal"], serde_json::json!("Buy"), "逐值一致");
    assert_eq!(rc.net_value.len(), 2);
    assert_eq!(rc.drawdown.len(), 2);

    // /bars 分页（内存切片）与 /curve（不抽样）对 legacy 亦可用
    let p = r.svc
        .result_bars(&run.id, ResultKind::PerBar, BarsWindow::Offset { offset: 1, limit: 10 })
        .await.unwrap();
    assert_eq!(p.bars.len(), 1);
    assert_eq!(p.bars[0]["ts"], serde_json::json!(2));
    let c = r.svc.result_curve(&run.id, ResultKind::NetValue, Some(2000)).await.unwrap();
    assert!(!c.downsampled);
    assert_eq!(c.points.len(), 2);

    // brief：legacy ⇒ chunk_count 0、bars_total = 内联长度
    let b = r.svc.result_brief(&run.id).await.unwrap();
    assert_eq!(b.result_format.as_deref(), Some("legacy_single"));
    assert_eq!(b.chunk_count, 0);
    assert_eq!(b.bars_total, 2);
}

/// 取消守卫：分块已写（边跑边写先于 mark_succeeded），run 不落 succeeded（status='running' 守卫）。
#[tokio::test]
async fn p4_cancel_guard_chunks_written_not_succeeded() {
    let r = rig(flat_bars(P4_N), 1);
    r.runs.cancel_on_append.store(true, std::sync::atomic::Ordering::Relaxed);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.unwrap();

    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Canceled, "并发取消胜出，不落 succeeded: {:?}", fin.error);
    assert!(
        r.runs.result_chunk_count(&run.id, ResultKind::PerBar).await.unwrap() >= 1,
        "取消后分块已写（边跑边写先于 mark_succeeded）"
    );
    assert!(r.runs.get_result(&run.id).await.unwrap().is_none(), "取消不落结果行");
}

/// 端点行为样例（ADR-024 P4 §3.2）：小数据集（6 根 / 页 2 / k=3）驱动出
/// `has_more`/`next_offset`/`downsampled`/`original_bars` 各字段的**可复核原始 JSON**。
/// 运行：`cargo test -p application --test workbench p4_wire_sample_dump -- --nocapture`。
#[tokio::test]
async fn p4_wire_sample_dump() {
    let r = rig(flat_bars(6), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    assert_eq!(wait_terminal(&r.runs, &run.id).await.status, StrategyRunStatus::Succeeded);

    let brief = r.svc.result_brief(&run.id).await.unwrap();
    println!("[P4/wire] GET /brief        = {}", serde_json::to_string(&brief).unwrap());

    let bars = r.svc
        .result_bars(&run.id, ResultKind::PerBar, BarsWindow::Offset { offset: 0, limit: 2 })
        .await.unwrap();
    assert!(bars.has_more && bars.next_offset == Some(2));
    println!("[P4/wire] GET /bars?limit=2 = {}", serde_json::to_string(&bars).unwrap());

    let curve = r.svc.result_curve(&run.id, ResultKind::NetValue, Some(3)).await.unwrap();
    assert!(curve.downsampled && curve.original_bars == 6 && curve.points.len() == 3);
    println!("[P4/wire] GET /curve?k=3    = {}", serde_json::to_string(&curve).unwrap());

    let rc = r.svc.result_compat(&run.id, 2).await.unwrap();
    assert!(rc.has_more && rc.next_offset == Some(2));
    println!("[P4/wire] GET /result(page2)= {}", serde_json::to_string(&rc).unwrap());

    let cmp = r.svc.compare_sampled(&[run.id.clone()], 3).await.unwrap();
    assert!(cmp[0].downsampled);
    println!("[P4/wire] POST /compare k=3 = {}", serde_json::to_string(&cmp).unwrap());
}

// ── ADR-024 P6：fills 事实源（成交明细单块 + `/fills` 分页读；禁止抽样） ──

/// 提交一个会产生成交的 run（TREND 夹具 = 1 笔完整交易 + 期末强平）并等至 succeeded。
async fn submitted_trend(r: &Rig) -> String {
    r.strategies.add_version("sv_pub", "st_1", TREND, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("提交成功");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "应成功: {:?}", fin.error);
    run.id
}

/// fills 单块：`kind='fills'`、`seq=0`、无成交也写块；payload = 成交事件（含 bar ts/方向/量/价/原因）。
#[tokio::test]
async fn p6_fills_block_single_seq_and_content() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;

    assert_eq!(
        r.runs.result_chunk_count(&id, ResultKind::Fills).await.unwrap(),
        1,
        "fills 恒为单块（seq=0）"
    );
    let chunks = r.runs.result_chunks(&id, ResultKind::Fills, 0, 10).await.unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].seq, 0);
    assert_eq!(chunks[0].kind, ResultKind::Fills);
    // ts_from/ts_to = 本 run 首/末 bar ts（空成交块亦取 bar 区间）
    assert_eq!(chunks[0].ts_from, dbar(0, 0.0).ts);
    assert_eq!(chunks[0].ts_to, dbar(5, 0.0).ts);

    let fills = chunks[0].payload.as_array().expect("payload 为数组");
    assert!(!fills.is_empty(), "TREND 夹具应产生成交");
    let all_bars: Vec<serde_json::Value> = read_all(&r.runs, &id, ResultKind::PerBar).await;
    for f in fills {
        assert_eq!(f["type"], serde_json::json!("fill"));
        let bar_index = f["bar_index"].as_u64().expect("bar_index") as usize;
        assert_eq!(
            f["ts"],
            all_bars[bar_index]["ts"],
            "fill.ts 必须对齐对应 bar 的 ts（K 线标记锚点）"
        );
        assert!(f["side"] == serde_json::json!("Buy") || f["side"] == serde_json::json!("Sell"));
        assert!(f["qty"].as_f64().unwrap_or(0.0) > 0.0);
        assert!(f["price"].as_f64().unwrap_or(0.0) > 0.0);
        assert!(f["reason"].is_string(), "reason 必带（Policy/StopTrigger/ForceClose）");
    }
    // 成交事实源与 per_bar 内联事件的成交条目逐值一致（同源）。
    let mut from_per_bar = 0usize;
    for rec in &all_bars {
        from_per_bar += rec["events"].as_array().unwrap().iter()
            .filter(|e| e["type"] == serde_json::json!("fill")).count();
    }
    assert_eq!(fills.len(), from_per_bar, "fills 块 = 全部 per_bar fill 事件（不漏、不重）");
}

/// `/fills` 分页：total / offset / limit / has_more / next_offset；`recorded=true`。
#[tokio::test]
async fn p6_fills_paging_and_recorded() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;

    let all = r.svc.result_fills(&id, 0, 5000).await.unwrap();
    assert_eq!(all.run_id, id);
    assert!(all.recorded, "chunked run 有 fills 块 ⇒ recorded=true");
    assert!(all.total >= 2, "成交数 = engine 事实（实测 {:?}）", all.total);
    assert_eq!(all.fills.len(), all.total as usize);
    assert!(!all.has_more);
    assert_eq!(all.next_offset, None);

    // 逐页拼接 = 全量（分页不丢不重）
    let mut paged: Vec<serde_json::Value> = Vec::new();
    let mut off = 0i64;
    loop {
        let p = r.svc.result_fills(&id, off, 2).await.unwrap();
        paged.extend(p.fills.iter().cloned());
        if !p.has_more {
            assert_eq!(p.next_offset, None);
            break;
        }
        assert_eq!(p.next_offset, Some(off + 2));
        off = p.next_offset.unwrap();
    }
    assert_eq!(paged, all.fills, "分页拼接逐值一致");

    // 超末尾 → 空页
    let past = r.svc.result_fills(&id, 10_000, 10).await.unwrap();
    assert!(past.fills.is_empty());
    assert!(!past.has_more);
}

/// 「无成交」与「未写」可区分：P6 之前的 chunked run（无 fills 块）⇒ `recorded=false`。
#[tokio::test]
async fn p6_fills_unrecorded_distinguished() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    // 模拟 P4 期 chunked run：结果行是 chunked_v1，但无 fills 块。
    r.runs.chunks.lock().unwrap().retain(|(_, c)| c.kind != ResultKind::Fills);
    let res = r.svc.result_fills(&id, 0, 5000).await.unwrap();
    assert!(!res.recorded, "无 fills 块 ⇒ recorded=false（「未写」，非「无成交」）");
    assert_eq!(res.total, 0);
    assert!(res.fills.is_empty());
}

/// 双读：legacy run 的 fills 由内联 per_bar 的 `fill` 事件派生（不回填），`recorded=true`。
#[tokio::test]
async fn p6_fills_legacy_derived_from_inline_per_bar() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    {
        let mut results = r.runs.results.lock().unwrap();
        let res = results.get_mut(&id).unwrap();
        res.result_format = "legacy_single".into();
        res.per_bar = serde_json::json!([
            {"ts": 11, "events": [{"type": "fill", "bar_index": 0, "side": "Buy", "qty": 100.0,
                                   "price": 7.5, "reason": "Policy"}]},
            {"ts": 22, "events": [{"type": "plugin_log", "slot_idx": 0, "bar_index": 1, "message": "x"}]},
            {"ts": 33, "events": [{"type": "fill", "bar_index": 2, "side": "Sell", "qty": 100.0,
                                   "price": 8.0, "reason": "ForceClose"}]},
        ]);
    }
    r.runs.chunks.lock().unwrap().clear();

    let res = r.svc.result_fills(&id, 0, 5000).await.unwrap();
    assert!(res.recorded, "legacy 双读 ⇒ recorded=true");
    assert_eq!(res.total, 2, "只取 fill 事件（plugin_log 不计）");
    assert_eq!(res.fills[0]["ts"], serde_json::json!(11), "ts 取所在 bar");
    assert_eq!(res.fills[0]["price"], serde_json::json!(7.5));
    assert_eq!(res.fills[1]["reason"], serde_json::json!("ForceClose"));
    assert_eq!(res.fills[1]["ts"], serde_json::json!(33));
    // 分页对 legacy 亦生效
    let p = r.svc.result_fills(&id, 1, 1).await.unwrap();
    assert_eq!(p.fills.len(), 1);
    assert_eq!(p.fills[0]["ts"], serde_json::json!(33));
    assert!(!p.has_more);
}

/// 硬约束：`fills` 是事实源 ⇒ `/curve` 抽样必须拒绝（400 语义），不得静默抽样。
#[tokio::test]
async fn p6_fills_curve_sampling_rejected() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let e = r.svc.result_curve(&id, ResultKind::Fills, Some(1)).await.unwrap_err();
    assert!(
        e.downcast_ref::<WorkbenchValidation>().is_some(),
        "fills 抽样应为 400 语义（WorkbenchValidation）"
    );
    assert!(e.to_string().contains("不可抽样"), "错误文案说明原因: {e}");
}

// ───────────────────── ADR-024 P5：区间收缩 / 资源护栏 / 预扫描（可编程 mock） ─────────────────────

/// P5 可编程 bar mock：可分别指定 bars / 可得区间 / 预扫描计数（或令其失败）。
struct MockBars2 {
    bars: Vec<domain::types::Bar>,
    avail: Option<domain::ports::AvailableRange>,
    count: Option<i64>,
    count_err: bool,
}

#[async_trait::async_trait]
impl BacktestBarRead for MockBars2 {
    async fn bars(
        &self,
        _code: &str,
        _period: &Period,
        _from: DateTime<Utc>,
        _to: DateTime<Utc>,
    ) -> anyhow::Result<Vec<domain::types::Bar>> {
        Ok(self.bars.clone())
    }
    async fn available_range(
        &self,
        _code: &str,
        _period: &Period,
    ) -> anyhow::Result<Option<domain::ports::AvailableRange>> {
        Ok(self.avail)
    }
    async fn count_bars(
        &self,
        _code: &str,
        _period: &Period,
        _from: DateTime<Utc>,
        _to: DateTime<Utc>,
    ) -> anyhow::Result<i64> {
        if self.count_err {
            anyhow::bail!("预扫描失败（测试注入）");
        }
        Ok(self.count.unwrap_or(self.bars.len() as i64))
    }
}

fn rig2(
    bars: Vec<domain::types::Bar>,
    avail: Option<domain::ports::AvailableRange>,
    count: Option<i64>,
    count_err: bool,
) -> Rig {
    let runs = Arc::new(MockRunStore::default());
    let presets = Arc::new(MockPresetStore::default());
    let strategies = Arc::new(MockStrategyStore::default());
    let sink = Arc::new(MockSink::default());
    let svc = Arc::new(WorkbenchService::new(
        Arc::new(MockBars2 { bars, avail, count, count_err }),
        runs.clone(),
        presets.clone(),
        strategies.clone(),
        Arc::new(MockSymbols(vec!["600000".into()])),
        sink.clone(),
        Arc::new(FixedClock),
        2,
    ));
    Rig { svc, runs, strategies, sink }
}

/// 宽可得区间：夹具 bar 落在 2026-09-01..06（D1）；可得区间给 [bar1, bar5+1s)。
fn avail_inner() -> domain::ports::AvailableRange {
    domain::ports::AvailableRange {
        from: dbar(1, 0.0).ts,
        to: dbar(5, 0.0).ts + Duration::seconds(1),
    }
}

/// D2：左超 / 右超 / 两端超 / 恰好端点 → 收缩 + `clamped` 回显；执行时以真实首末 bar 为准（D3）。
#[tokio::test]
async fn p5_clamp_left_right_both_and_exact() {
    let r = rig2(trend_bars(), Some(avail_inner()), None, false);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);

    // 两端超：requested [-5, +30) 天 ⊃ 可得 [bar1, bar5+1s)。
    let mut req = submit_req("sv_pub");
    req.from = dbar(-5, 0.0).ts;
    req.to = dbar(30, 0.0).ts;
    let run = r.svc.submit(req).await.expect("两端超 → 收缩后 201");
    assert!(run.clamped, "clamped=true");
    assert_eq!(run.clamp_reason.as_deref(), Some("data_range"));
    assert_eq!(run.requested_from, dbar(-5, 0.0).ts, "requested_from 为原始输入");
    assert_eq!(run.requested_to, dbar(30, 0.0).ts, "requested_to 为原始输入");
    assert_eq!(run.from_ts, dbar(1, 0.0).ts, "effective_from = max(requested, avail.from)");
    assert_eq!(run.to_ts, dbar(5, 0.0).ts + Duration::seconds(1), "effective_to = min(requested, avail.to)");

    // 左超（右在可得内）。
    let mut req = submit_req("sv_pub");
    req.from = dbar(-5, 0.0).ts;
    req.to = dbar(3, 0.0).ts;
    let run = r.svc.submit(req).await.unwrap();
    assert!(run.clamped);
    assert_eq!(run.from_ts, dbar(1, 0.0).ts);
    assert_eq!(run.to_ts, dbar(3, 0.0).ts, "右不夹");

    // 右超（左在可得内）。
    let mut req = submit_req("sv_pub");
    req.from = dbar(2, 0.0).ts;
    req.to = dbar(30, 0.0).ts;
    let run = r.svc.submit(req).await.unwrap();
    assert!(run.clamped);
    assert_eq!(run.from_ts, dbar(2, 0.0).ts, "左不夹");
    assert_eq!(run.to_ts, dbar(5, 0.0).ts + Duration::seconds(1));

    // 恰好等于端点 → 不夹（clamped=false）。
    let mut req = submit_req("sv_pub");
    req.from = dbar(1, 0.0).ts;
    req.to = dbar(5, 0.0).ts + Duration::seconds(1);
    let run = r.svc.submit(req).await.unwrap();
    assert!(!run.clamped, "恰好等于端点不触发收缩");
    assert!(run.clamp_reason.is_none());
}

/// 无交集 → 结构化 400 `range_empty` + 可用区间回显。
#[tokio::test]
async fn p5_clamp_no_intersection_is_range_empty() {
    let r = rig2(trend_bars(), Some(avail_inner()), None, false);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let mut req = submit_req("sv_pub");
    req.from = dbar(20, 0.0).ts;
    req.to = dbar(30, 0.0).ts;
    let e = r.svc.submit(req).await.unwrap_err();
    let e = e.downcast_ref::<StructuredError>().expect("结构化 400");
    assert_eq!(e.code, "range_empty");
    assert_eq!(e.detail["available_from"], serde_json::json!(dbar(1, 0.0).ts.to_rfc3339()));
}

/// D1 资源护栏：`≥ GUARD_CONFIRM_BARS` ⇒ 400 `resource_guard`（detail 齐备）+ `confirm:true` 放行；
/// `> MAX_BARS_GUARD` ⇒ 硬拒（confirm 不放行）。
#[tokio::test]
async fn p5_resource_guard_confirm_and_hard_reject() {
    // 预扫描报 GUARD_CONFIRM_BARS 根（实际 bar 少；护栏按预估值）。
    let r = rig2(trend_bars(), Some(avail_inner()), Some(GUARD_CONFIRM_BARS as i64), false);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let mut req = submit_req("sv_pub");
    let e = r.svc.submit(req.clone()).await.unwrap_err();
    let e = e.downcast_ref::<StructuredError>().expect("结构化 400");
    assert_eq!(e.code, "resource_guard");
    assert_eq!(e.detail["requested_bars"], serde_json::json!(GUARD_CONFIRM_BARS));
    assert_eq!(e.detail["limit_bars"], serde_json::json!(MAX_BARS_GUARD));
    assert_eq!(e.detail["confirmable"], serde_json::json!(true));
    assert!(e.detail["estimated_secs"].as_f64().unwrap() > 0.0, "预估耗时含固定项且 > 0");
    // 带 confirm=true 重提 → 放行。
    req.confirm = true;
    r.svc.submit(req).await.expect("confirm=true 应放行");

    // 硬上界：> MAX_BARS_GUARD ⇒ 即使 confirm=true 也拒。
    let r2 = rig2(trend_bars(), Some(avail_inner()), Some(MAX_BARS_GUARD as i64 + 1), false);
    r2.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let mut req = submit_req("sv_pub");
    req.confirm = true;
    let e = r2.svc.submit(req).await.unwrap_err();
    let e = e.downcast_ref::<StructuredError>().unwrap();
    assert_eq!(e.code, "resource_guard");
    assert_eq!(e.detail["confirmable"], serde_json::json!(false), "硬拒不可 confirm 放行");
}

/// 预估算子**必须含每 run 固定成本项**（D1 修订）：不得用引擎内核口径（二者差 ~2 量级）。
#[test]
fn p5_estimator_includes_fixed_run_cost() {
    use application::workbench::estimate_secs;
    // 0 根 bar 也有非零固定成本（1003 帧进度写库 ≈ 0.85 s）。
    let zero = estimate_secs(0);
    assert!((zero - 0.85).abs() < 1e-6, "0 bar 的预估 = 固定成本项，got {zero}");
    // 引擎内核口径（b≈3.8µs/bar）会给出 ~0.0038s@1000bar；端到端含固定项必然显著更大。
    let e1k = estimate_secs(1_000);
    assert!(e1k > 1000.0 * 3.8e-6 * 10.0, "端到端预估须显著大于内核口径（含固定项）: {e1k}");
}

/// 进度预扫描降级路径可见：count 失败 ⇒ `estimated_bars=null` + config 标明口径 `ts_norm`（D12）。
#[tokio::test]
async fn p5_prescan_degraded_path_visible() {
    let r = rig2(trend_bars(), Some(avail_inner()), None, true);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.expect("预扫描失败不应阻断提交（退化）");
    assert!(run.estimated_bars.is_none(), "降级：estimated_bars = null");
    assert_eq!(
        run.config["progress_prescan"], serde_json::json!("ts_norm"),
        "config 标明实际使用的口径（可检索）"
    );

    // 正常路径：estimated_bars = 预扫描值 + 口径 count。
    let r2 = rig2(trend_bars(), Some(avail_inner()), Some(6), false);
    r2.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run2 = r2.svc.submit(submit_req("sv_pub")).await.unwrap();
    assert_eq!(run2.estimated_bars, Some(6), "预扫描生效 → 精确 total");
    assert_eq!(run2.config["progress_prescan"], serde_json::json!("count"));
}

/// 结构化错误形状（§3.1.1）可被前端**编程**消费：序列化为 `{code,message,detail}`。
#[test]
fn p5_structured_error_shape_json() {
    let e = application::workbench::range_empty_error(
        "600000",
        "M30",
        dbar(0, 0.0).ts,
        dbar(1, 0.0).ts,
        Some(avail_inner()),
    );
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["code"], serde_json::json!("range_empty"));
    assert!(v["message"].as_str().is_some_and(|m| !m.is_empty()));
    assert!(v["detail"].is_object(), "detail 为对象（非字符串）");
}

/// D12 进度预扫描：提交后 `/brief` 的 `estimated_bars` 回显（P5 起非 null）。
#[tokio::test]
async fn p5_brief_estimated_bars_echo() {
    let r = rig2(trend_bars(), Some(avail_inner()), Some(6), false);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let run = r.svc.submit(submit_req("sv_pub")).await.unwrap();
    let brief = r.svc.result_brief(&run.id).await.unwrap();
    assert_eq!(brief.estimated_bars, Some(6));
    assert!(brief.clamped);
    assert_eq!(brief.requested_from, dbar(-1, 0.0).ts);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ADR-027 / ADR-028 P3：C 段契约测试（C1–C8；02-spec §4/§5/§6/§8；03-test-plan §3）
// 载体：既有 mock store + 真实 QuickJsRuntime（不依赖真库）。
// ══════════════════════════════════════════════════════════════════════════════════════════

/// C1：`/result` 的 `trades` 元素 = L1 v2 形状（02-spec §1.2）——字段齐全 + **无旧字段残留**。
///
/// 判据：键集**精确相等**（不是「包含」）⇒ 既无漏字段，也无 v1 残留。
#[tokio::test]
async fn c1_result_trades_element_is_v2_shape() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let rc = r.svc.result_compat(&id, 5000).await.unwrap();
    let trades = rc.trades.as_array().expect("trades 为数组");
    assert!(!trades.is_empty(), "TREND 夹具应产出回合");
    let want: std::collections::BTreeSet<&str> = [
        "rt_seq", "code", "status", "open_ts", "close_ts", "open_bar", "close_bar", "open_price",
        "close_price", "shares", "gross_value", "commission", "stamp_duty", "pnl", "hold_bars",
        "l2_count", "buy_count", "sell_count", "reason",
    ]
    .into_iter()
    .collect();
    for t in trades {
        let got: std::collections::BTreeSet<&str> = t
            .as_object()
            .expect("trades 元素为对象")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(got, want, "trades 元素键集必须 = 02-spec §1.2（无旧字段残留/无漏字段）");
        assert!(t["rt_seq"].as_u64().unwrap() >= 1, "rt_seq 从 1 起单调");
        assert_eq!(t["code"], serde_json::json!("600000"), "回测 code = run symbol");
        assert_eq!(t["status"], serde_json::json!("Closed"), "回测恒 Closed（期末强平）");
        assert!(t["close_ts"].is_i64() && t["close_bar"].is_i64(), "Closed ⇒ close_* 有值");
        assert!(t["pnl"].is_number(), "Closed ⇒ pnl 精确值");
        assert!(t["hold_bars"].is_number());
        assert!(t["l2_count"].as_u64().unwrap() >= 1, "l2_count 摘要必为正");
        assert!(t["open_price"].as_f64().unwrap() > 0.0);
    }
}

/// C2：`/round-trips` 分页与摘要（`l2_count`/`buy_count`/`sell_count`）。
#[tokio::test]
async fn c2_round_trips_paging_and_summary() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let all = r.svc.result_round_trips(&id, 0, 5000).await.unwrap();
    assert_eq!(all.run_id, id);
    assert!(all.recorded, "trades 为数组 ⇒ recorded=true");
    assert!(all.total >= 1);
    assert_eq!(all.round_trips.len() as i64, all.total);
    assert!(!all.has_more);
    assert_eq!(all.next_offset, None);

    // 摘要一致性：l2_count == 该回合 L2 切片 total；买/卖笔数与切片逐笔一致。
    for rt in &all.round_trips {
        let l2 = r.svc.result_round_trip_fills(&id, rt.rt_seq, 0, 5000).await.unwrap();
        assert_eq!(rt.l2_count, l2.total as usize, "l2_count == 该回合 fills 数");
        assert_eq!(rt.l2_count, l2.fills.len());
        let buys = l2.fills.iter().filter(|f| f["side"] == serde_json::json!("Buy")).count();
        let sells = l2.fills.iter().filter(|f| f["side"] == serde_json::json!("Sell")).count();
        assert_eq!(rt.buy_count, buys, "buy_count == 切片买入笔数");
        assert_eq!(rt.sell_count, sells, "sell_count == 切片卖出笔数");
        assert!(rt.buy_count + rt.sell_count == rt.l2_count);
        assert!(
            l2.fills.iter().all(|f| f["rt_seq"].as_u64() == Some(rt.rt_seq as u64)),
            "切片元素 rt_seq 必须全等于该回合"
        );
    }

    // 分页边界：逐页拼接 = 全量；has_more/next_offset 正确。
    let total = all.total;
    let mut paged: Vec<u32> = Vec::new();
    let mut off = 0i64;
    loop {
        let p = r.svc.result_round_trips(&id, off, 1).await.unwrap();
        assert!(p.round_trips.len() <= 1);
        paged.extend(p.round_trips.iter().map(|t| t.rt_seq));
        if !p.has_more {
            assert_eq!(p.next_offset, None, "无更多 ⇒ next_offset=null");
            break;
        }
        assert_eq!(p.next_offset, Some(off + 1), "next_offset = 已消费数");
        off = p.next_offset.unwrap();
    }
    assert_eq!(paged.len() as i64, total, "分页不丢不重");
    assert_eq!(
        paged,
        all.round_trips.iter().map(|t| t.rt_seq).collect::<Vec<_>>(),
        "分页顺序 = 全量顺序"
    );
    // 越界 ⇒ 空页（非错误）
    let past = r.svc.result_round_trips(&id, 10_000, 10).await.unwrap();
    assert!(past.round_trips.is_empty() && !past.has_more && past.next_offset.is_none());
}

/// C3：L2 切片归属正确；**未知 `rt_seq` ⇒ 404**（禁空数组冒充「无成交」，D6/D11）。
#[tokio::test]
async fn c3_l2_slice_ownership_and_unknown_rt_seq_404() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let l1 = r.svc.result_round_trips(&id, 0, 10).await.unwrap();
    let rt = l1.round_trips[0].clone();

    let full = r.svc.result_round_trip_fills(&id, rt.rt_seq, 0, 5000).await.unwrap();
    assert_eq!(full.run_id, id);
    assert_eq!(full.rt_seq, rt.rt_seq);
    assert_eq!(full.total, rt.l2_count as i64);
    assert!(full.recorded);
    for f in &full.fills {
        assert_eq!(f["rt_seq"].as_u64(), Some(rt.rt_seq as u64), "禁止窗口推断归属");
        assert_eq!(f["code"], serde_json::json!("600000"), "L2 元素带 code（02-spec §1.1）");
        for k in [
            "bar_index", "ts", "side", "qty", "price", "trade_value", "commission", "stamp_duty",
            "reason",
        ] {
            assert!(!f[k].is_null(), "L2 字段 {k} 必带（02-spec §1.1）");
        }
    }

    // 分页切片
    let p = r.svc.result_round_trip_fills(&id, rt.rt_seq, 0, 1).await.unwrap();
    assert_eq!(p.fills.len(), 1);
    let more = rt.l2_count > 1;
    assert_eq!(p.has_more, more);
    assert_eq!(p.next_offset, more.then_some(1));

    // 未知 rt_seq ⇒ 404（不是空数组！）
    let unknown = rt.rt_seq + 1000;
    let err = r.svc.result_round_trip_fills(&id, unknown, 0, 10).await.unwrap_err();
    assert!(
        err.downcast_ref::<WorkbenchNotFound>().is_some(),
        "未知 rt_seq 必须 404，实际: {err}"
    );
}

/// C4：`/fills?round_trip=` 过滤 + 元素新字段；`recorded=false` 语义不变。
#[tokio::test]
async fn c4_fills_filter_and_element_increment() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let all = r.svc.result_fills(&id, 0, 5000).await.unwrap();
    assert!(all.recorded);
    assert!(all.round_trip.is_none(), "未过滤 ⇒ 不回显 round_trip");
    for f in &all.fills {
        for k in ["code", "rt_seq", "trade_value", "commission", "stamp_duty"] {
            assert!(!f[k].is_null(), "fills 元素增字段 {k} 缺失");
        }
        // 闸门 2 L-1：同一事实源（FillFact）在 `/fills` 与 L2 切片上必须**同形状**（02-spec §1.1/§5.4）。
        assert_eq!(f["code"], serde_json::json!("600000"), "回测 code = run 的 symbol（L-1）");
        assert!(f["rt_seq"].as_u64().unwrap() >= 1);
        assert!(f["trade_value"].as_f64().unwrap() > 0.0);
        assert!(f["commission"].as_f64().unwrap() > 0.0, "佣金含最低佣金，必为正");
        assert!(f["stamp_duty"].as_f64().unwrap() >= 0.0, "买入印花税恒 0");
    }

    // 过滤后集合 == 该回合 L2 切片（逐 (rt_seq, bar_index) 对齐）
    let rt = all.fills[0]["rt_seq"].as_u64().unwrap() as u32;
    let filtered = r.svc.result_fills_filtered(&id, 0, 5000, Some(rt)).await.unwrap();
    let l2 = r.svc.result_round_trip_fills(&id, rt, 0, 5000).await.unwrap();
    let key = |f: &serde_json::Value| (f["rt_seq"].as_u64(), f["bar_index"].as_u64(), f["side"].clone());
    assert_eq!(
        filtered.fills.iter().map(key).collect::<Vec<_>>(),
        l2.fills.iter().map(key).collect::<Vec<_>>(),
        "过滤后集合 == 该回合 fills"
    );
    assert_eq!(filtered.total, l2.total);
    // 闸门 2 L-1：同一事实源**禁止**两种形状 ⇒ `/fills` 与 L2 切片元素键集必须完全一致。
    let keys = |f: &serde_json::Value| {
        let mut k: Vec<String> = f.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(&filtered.fills[0]),
        keys(&l2.fills[0]),
        "`/fills` 元素键集必须 == L2 切片元素键集（同一 FillFact 形状）"
    );
    assert!(keys(&filtered.fills[0]).contains(&"code".to_string()));
    assert_eq!(filtered.round_trip, Some(rt), "过滤参数回显");
    assert!(filtered.fills.iter().all(|f| f["rt_seq"].as_u64() == Some(rt as u64)));

    // recorded 语义不变：无 fills 块 ⇒ recorded=false 且 total=0（过滤不改变该判定）
    r.runs.chunks.lock().unwrap().retain(|(_, c)| c.kind != ResultKind::Fills);
    let un = r.svc.result_fills_filtered(&id, 0, 5000, Some(rt)).await.unwrap();
    assert!(!un.recorded, "无 fills 块 ⇒ 仍是「未写」而非「无成交」");
    assert_eq!(un.total, 0);
}

/// C4b（闸门 2 L-3）：`/fills?round_trip=` 指向**不存在的 `rt_seq`** ⇒ **404**，
/// 与 L2 切片端点 `/round-trips/{rt_seq}/fills` **对称**（02-spec §5.4 冻结：不存在 200 空数组）。
#[tokio::test]
async fn c4b_fills_round_trip_unknown_seq_is_404_symmetric_with_l2() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let l1 = r.svc.result_round_trips(&id, 0, 5000).await.unwrap();
    let known = l1.round_trips[0].rt_seq;

    // 正向：已知回合 ⇒ 200 + 过滤生效（不得把整条过滤路径做成 404）
    let ok = r.svc.result_fills_filtered(&id, 0, 5000, Some(known)).await.unwrap();
    assert_eq!(ok.round_trip, Some(known), "过滤参数回显");
    assert!(ok.total >= 1, "已知回合必有成交（回合必有至少一笔）");

    // 反向：未知回合 ⇒ 404（禁止 200 空数组冒充「该回合无成交」）
    let unknown = known + 1000;
    let err = r.svc.result_fills_filtered(&id, 0, 5000, Some(unknown)).await.unwrap_err();
    assert!(
        err.downcast_ref::<WorkbenchNotFound>().is_some(),
        "`/fills?round_trip=<未知>` 必须 404（对称 §5.3），实际: {err}"
    );
    // 对称性：同一未知 rt_seq 在两个端点得到**同类**错误（404 ⇒ HTTP 404）
    let err_l2 = r.svc.result_round_trip_fills(&id, unknown, 0, 10).await.unwrap_err();
    assert!(
        err_l2.downcast_ref::<WorkbenchNotFound>().is_some(),
        "L2 切片同语义（404），实际: {err_l2}"
    );
    // 未过滤路径不受影响（既有契约：不带 round_trip ⇒ 200 全量）
    let all = r.svc.result_fills(&id, 0, 5000).await.unwrap();
    assert_eq!(all.total, l1.round_trips.iter().map(|t| t.l2_count as i64).sum::<i64>());
}

/// C5：`/curve?kind=position` + `from_ts/to_ts`（窗口回显 / `window_bars` / 缺省向后兼容）。
#[tokio::test]
async fn c5_curve_position_kind_and_time_window() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;

    // ① 缺省无窗口 = 全区间（向后兼容，window_* 回显 null）
    let full = r.svc.result_curve(&id, ResultKind::Position, Some(20_000)).await.unwrap();
    assert_eq!(full.kind, "position");
    assert!(full.recorded, "chunked run 有 position 块 ⇒ recorded=true");
    assert_eq!(full.window_from_ts, None);
    assert_eq!(full.window_to_ts, None);
    assert_eq!(full.window_bars, full.original_bars, "无窗口 ⇒ window_bars == 全序列根数");
    assert!(!full.points.is_empty());
    // 逐点形状 + I6 恒等式：position_value + cash == nav；position_ratio == position_value/nav
    for p in &full.points {
        for k in ["ts", "qty", "position_value", "cash", "nav", "position_ratio"] {
            assert!(p.get(k).is_some(), "position 点缺字段 {k}");
        }
        let pv = p["position_value"].as_f64().unwrap();
        let cash = p["cash"].as_f64().unwrap();
        let nav = p["nav"].as_f64().unwrap();
        let ratio = p["position_ratio"].as_f64().unwrap();
        assert!((pv + cash - nav).abs() <= 1e-6 * nav.abs().max(1.0), "I6: pv+cash==nav");
        let want = if nav <= 0.0 { 0.0 } else { pv / nav };
        assert!((ratio - want).abs() < 1e-12, "position_ratio 分母 = 时点净值");
    }
    // 与 net_value 同点同值（同序列同根数）
    let net = r.svc.result_curve(&id, ResultKind::NetValue, Some(20_000)).await.unwrap();
    assert_eq!(full.original_bars, net.original_bars, "position 与 net_value 同根数");
    for (p, q) in full.points.iter().zip(net.points.iter()) {
        assert_eq!(p["ts"], q[0], "同 ts");
        assert!((p["nav"].as_f64().unwrap() - q[1].as_f64().unwrap()).abs() < 1e-9, "同 nav");
    }

    // ② 时间窗：window_bars == 窗口内原始根数（抽样前）；响应回显窗口
    let ts: Vec<i64> = net.points.iter().map(|q| q[0].as_i64().unwrap()).collect();
    assert!(ts.len() >= 4, "夹具应 ≥4 根 bar");
    let (from, to) = (ts[1], ts[3]);
    let w = r
        .svc
        .result_curve_window(&id, ResultKind::NetValue, Some(20_000), Some(from), Some(to))
        .await
        .unwrap();
    assert_eq!(w.window_from_ts, Some(from));
    assert_eq!(w.window_to_ts, Some(to));
    assert_eq!(w.window_bars, 3, "window_bars == 窗口内原始根数");
    assert_eq!(w.points.len(), 3);
    assert_eq!(w.original_bars, net.original_bars, "original_bars 仍为全序列根数");
    assert!(!w.downsampled);
    // 窗口外点当然不在
    let w_empty = r
        .svc
        .result_curve_window(&id, ResultKind::NetValue, Some(20_000), Some(0), Some(0))
        .await
        .unwrap();
    assert_eq!(w_empty.window_bars, 0, "空窗口 window_bars=0（不静默回全量）");
    assert!(w_empty.points.is_empty());

    // ③ 窗口内**重新采样**（k 作用于窗口内点集；分母 = window_bars）
    let ws = r
        .svc
        .result_curve_window(&id, ResultKind::NetValue, Some(2), Some(from), Some(to))
        .await
        .unwrap();
    assert_eq!(ws.points.len(), 2);
    assert!(ws.downsampled, "窗口内重采样 ⇒ downsampled=true");
    assert_eq!(ws.window_bars, 3);
}

/// C5b：`legacy_single` 无 `position` 列 ⇒ 读侧回空数组 + `recorded=false`
/// （**不得**把「无该序列」读成「无持仓」，02-spec §4.1 / ADR-027 D11）。
#[tokio::test]
async fn c5b_legacy_single_position_is_empty_and_explicitly_unrecorded() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    {
        let mut results = r.runs.results.lock().unwrap();
        let res = results.get_mut(&id).unwrap();
        res.result_format = "legacy_single".into();
        res.net_value = serde_json::json!([[1, 100.0], [2, 101.0]]);
    }
    let c = r.svc.result_curve(&id, ResultKind::Position, None).await.unwrap();
    assert!(c.points.is_empty(), "legacy 无 position 列 ⇒ 空数组");
    assert!(!c.recorded, "「无该序列」必须显式披露（不得读成「无持仓」）");
    assert_eq!(c.window_bars, 0);
    // 既有 kind 的 legacy 内联路径不受影响
    let nv = r.svc.result_curve(&id, ResultKind::NetValue, None).await.unwrap();
    assert!(nv.recorded, "legacy 有 net_value 内联列 ⇒ recorded=true");
    assert_eq!(nv.points.len(), 2);
    assert_eq!(nv.original_bars, 2);
}

/// 写入侧：`positions` 必须落成 `kind='position'` 块（与 `net_value` 同级；ADR-027 §4.1）。
#[tokio::test]
async fn c5c_position_chunk_written_alongside_net_value() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let net_chunks = r.runs.result_chunk_count(&id, ResultKind::NetValue).await.unwrap();
    let pos_chunks = r.runs.result_chunk_count(&id, ResultKind::Position).await.unwrap();
    assert!(net_chunks > 0, "net_value 恒有块");
    assert_eq!(pos_chunks, net_chunks, "position 与 net_value 同级分块（同根数 ⇒ 同块数）");
    let pos = read_all(&r.runs, &id, ResultKind::Position).await;
    let net = read_all(&r.runs, &id, ResultKind::NetValue).await;
    assert_eq!(pos.len(), net.len());
    for (p, q) in pos.iter().zip(net.iter()) {
        assert_eq!(p["ts"], q[0], "逐点同 ts");
        assert!((p["nav"].as_f64().unwrap() - q[1].as_f64().unwrap()).abs() < 1e-9, "逐点同 nav");
    }
}

/// C6：`/curve` 拒 `kind=fills`（白名单不变；含窗口路径）。
#[tokio::test]
async fn c6_curve_rejects_fills_kind() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let err = r.svc.result_curve(&id, ResultKind::Fills, None).await.unwrap_err();
    let e = err.downcast_ref::<WorkbenchValidation>().expect("fills 不可抽样 ⇒ 400");
    assert_eq!(e.code(), "kind_invalid");
    let err2 = r
        .svc
        .result_curve_window(&id, ResultKind::Fills, None, Some(0), Some(9))
        .await
        .unwrap_err();
    assert!(err2.downcast_ref::<WorkbenchValidation>().is_some(), "窗口路径同样拒绝");
}

/// C7：`/audit` 增量（`round_trips_closed/open`、`rt_reconcile`）与 L1 列表逐回合一致。
#[tokio::test]
async fn c7_audit_increments_and_per_round_trip_reconcile() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let a = r.svc.run_audit(&id).await.unwrap();
    let l1 = r.svc.result_round_trips(&id, 0, 1000).await.unwrap();
    assert_eq!(a.report.round_trips_closed, l1.total as usize, "closed == L1 回合数（回测恒 Closed）");
    assert_eq!(a.report.round_trips_open, 0, "回测恒 0");
    assert_eq!(
        a.report.round_trips_closed + a.report.round_trips_open,
        a.report.round_trips_total
    );
    assert_eq!(a.report.rt_reconcile.checked, l1.total as usize, "逐回合核对");
    assert!(a.report.rt_reconcile.mismatched.is_empty(), "正常 run 逐回合自洽（mismatched 空）");
    assert_eq!(a.report.rt_reconcile.tolerance, application::audit::RT_RECONCILE_TOLERANCE);

    // 反例：篡改某回合的一笔 L2 佣金 ⇒ 必须被**标出**该 rt_seq（禁静默按 L1 渲染，D10）
    let target = {
        let mut g = r.runs.chunks.lock().unwrap();
        let mut target = None;
        for (rid, c) in g.iter_mut() {
            if rid == &id && c.kind == ResultKind::Fills {
                if let Some(arr) = c.payload.as_array_mut() {
                    target = arr[0]["rt_seq"].as_u64().map(|v| v as u32);
                    arr[0]["commission"] = serde_json::json!(9999.0);
                }
            }
        }
        target.expect("应存在 fills 块")
    };
    let b = r.svc.run_audit(&id).await.unwrap();
    assert_eq!(b.report.rt_reconcile.mismatched, vec![target], "篡改回合必须被标出");
    assert_eq!(b.report.rt_reconcile.checked, l1.total as usize);
}

/// C8：完整性契约（ADR-027 D11）—— 所有列表型响应自述完整性。
#[tokio::test]
async fn c8_completeness_on_all_list_endpoints() {
    let r = rig(trend_bars(), 2);
    let id = submitted_trend(&r).await;
    let keys = |v: &serde_json::Value, ks: &[&str], who: &str| {
        for k in ks {
            assert!(v.get(*k).is_some(), "{who} 缺完整性字段 {k}（ADR-027 D11）");
        }
    };
    let page_keys = ["total", "recorded", "has_more", "next_offset", "offset", "limit"];

    let f = serde_json::to_value(r.svc.result_fills(&id, 0, 5000).await.unwrap()).unwrap();
    keys(&f, &page_keys, "/fills");
    let l1 = serde_json::to_value(r.svc.result_round_trips(&id, 0, 5000).await.unwrap()).unwrap();
    keys(&l1, &page_keys, "/round-trips");
    let rt = l1["round_trips"][0]["rt_seq"].as_u64().unwrap() as u32;
    let l2 = serde_json::to_value(r.svc.result_round_trip_fills(&id, rt, 0, 5000).await.unwrap())
        .unwrap();
    keys(&l2, &page_keys, "/round-trips/{rt_seq}/fills");
    let b = serde_json::to_value(
        r.svc
            .result_bars(&id, ResultKind::PerBar, BarsWindow::Offset { offset: 0, limit: 2 })
            .await
            .unwrap(),
    )
    .unwrap();
    keys(&b, &["total", "has_more", "next_offset"], "/bars");
    // 窗口取数路径（ADR-028 §2.5）自述窗口 + 抽样前后根数
    let c = serde_json::to_value(r.svc.result_curve(&id, ResultKind::Position, Some(10)).await.unwrap())
        .unwrap();
    keys(
        &c,
        &["window_from_ts", "window_to_ts", "window_bars", "recorded", "downsampled", "original_bars", "k"],
        "/curve",
    );
    // 截断必须显式：首页 limit < total ⇒ has_more=true（不得静默截断）
    let first = r.svc.result_fills(&id, 0, 1).await.unwrap();
    if first.total > 1 {
        assert!(first.has_more && first.next_offset.is_some(), "截断必须显式披露");
    }
}
