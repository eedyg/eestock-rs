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
    NewStrategyVersion, StrategyManageItem, StrategyPresetRow, StrategyPresetStore, StrategyRow,
    StrategyRunFilter, StrategyRunResult, StrategyRunStatus, StrategyRunStore, StrategyRunView,
    StrategyStore, StrategyVersionRow, SymbolRegistry,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use domain::types::{Code, Period, SourceId};

use application::workbench::{
    SlotReq, SubmitRunReq, WorkbenchConflict, WorkbenchNotFound, WorkbenchService,
    WorkbenchValidation, MAX_BARS,
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

/// 与 PgStrategyRunStore 同语义的内存 mock（条件更新/原子认领/级联结果）。
#[derive(Default)]
struct MockRunStore {
    runs: Mutex<HashMap<String, StrategyRunView>>,
    results: Mutex<HashMap<String, StrategyRunResult>>,
}

impl MockRunStore {
    fn view(&self, id: &str) -> Option<StrategyRunView> {
        self.runs.lock().unwrap().get(id).cloned()
    }
}

#[async_trait::async_trait]
impl StrategyRunStore for MockRunStore {
    async fn create_run(&self, run: &NewStrategyRun) -> anyhow::Result<StrategyRunView> {
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

// ── submit 校验全路径 ──

#[tokio::test]
async fn submit_rejects_draft_version_400() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_draft", "st_1", CONST_SCORE, StrategyStatus::Draft);
    let err = r.svc.submit(submit_req("sv_draft")).await.unwrap_err();
    let e = err.downcast_ref::<WorkbenchValidation>().expect("draft 版本 → 400");
    assert!(e.0.contains("draft") && e.0.contains("未发布"),
        "draft 文案须区分「未发布不可运行」（与 404 不存在区分）: {}", e.0);
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

#[tokio::test]
async fn submit_rejects_span_limits_400() {
    let r = rig(trend_bars(), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    // D1 超 5 年
    let mut req = submit_req("sv_pub");
    req.to = req.from + Duration::days(366 * 5 + 1);
    let err = r.svc.submit(req).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some(), "D1 超 5 年 → 400");
    // 分钟级超 3 个月
    let mut req = submit_req("sv_pub");
    req.period = "M1".into();
    req.to = req.from + Duration::days(94);
    let err = r.svc.submit(req).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some(), "M1 超 3 个月 → 400");
    // from >= to
    let mut req = submit_req("sv_pub");
    req.to = req.from;
    let err = r.svc.submit(req).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some(), "from>=to → 400");
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
    // 钉住 config：warmup requested/effective + 生效 fee（含 stamp_duty_pct 实际取值）。
    assert_eq!(run.config["warmup_requested"], serde_json::json!(5));
    assert_eq!(run.config["warmup_effective"], serde_json::json!(5));
    assert_eq!(run.config["fee"]["effective"]["stamp_duty_pct"], serde_json::json!(0.05), "缺省股票口径回显");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "{:?}", fin.error);
    let res = r.runs.get_result(&run.id).await.unwrap().expect("结果");
    let per_bar = res.per_bar.as_array().unwrap();
    assert_eq!(per_bar.len(), 10, "per_bar 含 warmup 前缀 + in-range");
    assert!(per_bar[..5].iter().all(|b| b["warmup"] == serde_json::json!(true)), "前 5 根标记 warmup");
    assert!(per_bar[5..].iter().all(|b| b["warmup"] == serde_json::json!(false)), "in-range 不标记");
    // 净值/回撤仅 in-range（5 点）。
    assert_eq!(res.net_value.as_array().unwrap().len(), 5, "净值仅 in-range");
    assert_eq!(res.drawdown.as_array().unwrap().len(), 5);
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
    // 非法 fee
    let mut req = submit_req("sv_pub");
    req.fee = Some(serde_json::json!({"rate_pct": 0.025}));
    assert!(r.svc.submit(req).await.unwrap_err().downcast_ref::<WorkbenchValidation>().is_some(),
        "fee 缺字段 → 400");
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
async fn submit_rejects_empty_or_oversize_bars_400() {
    // 空区间
    let r = rig(vec![], 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let err = r.svc.submit(submit_req("sv_pub")).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some(), "空 bar → 400");
    // >20 万 bar
    let r = rig(flat_bars(MAX_BARS + 1), 2);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    let err = r.svc.submit(submit_req("sv_pub")).await.unwrap_err();
    assert!(err.downcast_ref::<WorkbenchValidation>().is_some(), ">20 万 bar → 400");
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

    // 结果五 jsonb 字段齐全（ADR §13.4 全量粒度）
    let res = r.runs.get_result(&run.id).await.unwrap().expect("结果应落库");
    let per_bar = res.per_bar.as_array().expect("per_bar 为数组");
    assert_eq!(per_bar.len(), 6, "6 根 bar 全量记录");
    let rec = &per_bar[0];
    for key in ["ts", "scores", "aggregate", "signal", "orders", "events"] {
        assert!(rec.get(key).is_some(), "per_bar 记录缺字段 {key}");
    }
    assert!(res.trades.as_array().unwrap().len() == 1, "TREND fixture 应产生 1 笔交易");
    assert_eq!(res.net_value.as_array().unwrap().len(), 6);
    assert_eq!(res.drawdown.as_array().unwrap().len(), 6);
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

/// 省略 fee 的 ETF 运行：钉住 config 快照 = 档案生效值（印花税 0）+ source=profile；
/// 显式传参仍整体优先（向后兼容旧行为）。
#[tokio::test]
async fn submit_fee_resolves_by_symbol_type_and_pins_source() {
    let r = rig_with_fee_profiles(flat_bars(10), vec!["518880"]);
    r.strategies.add_version("sv_pub", "st_1", CONST_SCORE, StrategyStatus::Published);
    // ① 省略 fee + ETF 标的 → profile 分支
    let mut req = submit_req("sv_pub");
    req.symbol = "518880".into();
    req.fee = None;
    let run = r.svc.submit(req).await.expect("提交成功");
    assert_eq!(run.config["fee"]["effective"]["stamp_duty_pct"], serde_json::json!(0.0), "ETF 印花税 0（D11 主目标）");
    assert_eq!(run.config["fee"]["effective"]["source"], serde_json::json!("profile"));
    assert_eq!(run.config["fee"]["symbol_type"], serde_json::json!("etf"));
    assert_eq!(run.config["fee"]["profile"]["transfer_fee_pct"], serde_json::json!(0.0));
    assert_eq!(run.config["fee"]["profile"]["not_modeled"],
        serde_json::json!(["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"]),
        "未建模规费须显式标注，不得出现在 effective 段");
    let fin = wait_terminal(&r.runs, &run.id).await;
    assert_eq!(fin.status, StrategyRunStatus::Succeeded, "{:?}", fin.error);

    // ② 显式 fee → config 钉住显式值 + source=explicit（可复现旧口径）
    let mut req = submit_req("sv_pub");
    req.symbol = "518880".into();
    req.fee = Some(serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0}));
    let run2 = r.svc.submit(req).await.expect("提交成功");
    assert_eq!(run2.config["fee"]["effective"]["source"], serde_json::json!("explicit"));
    assert_eq!(run2.config["fee"]["effective"]["stamp_duty_pct"], serde_json::json!(0.05), "显式缺 stamp → 旧默认");

    // ③ 未建档标的 → default 分支（旧默认），不借用他类型档案
    let mut req = submit_req("sv_pub");
    req.symbol = "600000".into();
    req.fee = None;
    let run3 = r.svc.submit(req).await.expect("提交成功");
    assert_eq!(run3.config["fee"]["effective"]["source"], serde_json::json!("default"));
    assert_eq!(run3.config["fee"]["effective"]["stamp_duty_pct"], serde_json::json!(0.05));
    assert!(run3.config["fee"].get("profile").is_none());
}
