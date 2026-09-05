//! 应用层 BacktestService 集成测试（**mock 端口**，确定性、无实时 DB）。
//! 全部数据为手工固定 bar 序列 + 显式固定参数，无 RNG / 无时间依赖 / 无实时数据，任意次运行一致。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{
    BacktestBarRead, BacktestProgressSink, BacktestRunStore, NewRun, RunFilter, RunResult, RunStatus,
    RunView,
};
use domain::types::{Bar, Code, Period, SourceId};

use application::service::{BacktestService, execute_run};
use application::types::{SubmitOutcome, SubmitReq};

/// 进度推送记录（mock sink 记录用）。
type ProgressRecord = (i64, i32, Option<DateTime<Utc>>);
/// 进度落库记录（mock store 记录用）。
type StoreProgressRecord = (i64, i32, DateTime<Utc>);

// ---------------------------------------------------------------------------
// mock 端口
// ---------------------------------------------------------------------------

/// Mock bar 读取：返回固定序列（`fail=true` 则报错）。忽略 code/period/from/to。
struct MockBarRead {
    bars: Vec<Bar>,
    fail: bool,
}

#[async_trait]
impl BacktestBarRead for MockBarRead {
    async fn bars(
        &self,
        _code: &str,
        _period: &Period,
        _from: DateTime<Utc>,
        _to: DateTime<Utc>,
    ) -> Result<Vec<Bar>> {
        if self.fail {
            return Err(anyhow::anyhow!("bar read failed"));
        }
        Ok(self.bars.clone())
    }
}

/// Mock run 存储：记录 create/progress/done/failed，并提供 runs 读模型。
struct MockStore {
    created: Mutex<Vec<NewRun>>,
    progress: Mutex<Vec<StoreProgressRecord>>,
    done: Mutex<Vec<(i64, RunResult)>>,
    failed: Mutex<Vec<(i64, String)>>,
    deleted: Mutex<Vec<i64>>,
    runs: Mutex<HashMap<i64, RunView>>,
    next_id: AtomicI64,
}

impl MockStore {
    fn new() -> Self {
        Self {
            created: Mutex::new(Vec::new()),
            progress: Mutex::new(Vec::new()),
            done: Mutex::new(Vec::new()),
            failed: Mutex::new(Vec::new()),
            deleted: Mutex::new(Vec::new()),
            runs: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
        }
    }

    fn set_run(&self, id: i64, view: RunView) {
        self.runs.lock().unwrap().insert(id, view);
    }
}

#[async_trait]
impl BacktestRunStore for MockStore {
    async fn create_run(&self, run: &NewRun) -> Result<i64> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.created.lock().unwrap().push(run.clone());
        Ok(id)
    }

    async fn update_run_progress(&self, id: i64, pct: i32, ts: DateTime<Utc>) -> Result<()> {
        self.progress.lock().unwrap().push((id, pct, ts));
        Ok(())
    }

    async fn mark_done(&self, id: i64, result: &RunResult) -> Result<()> {
        self.done.lock().unwrap().push((id, result.clone()));
        Ok(())
    }

    async fn mark_failed(&self, id: i64, err: &str) -> Result<()> {
        self.failed.lock().unwrap().push((id, err.to_string()));
        Ok(())
    }

    async fn list_runs(&self, _filter: &RunFilter) -> Result<Vec<RunView>> {
        Ok(self.runs.lock().unwrap().values().cloned().collect())
    }

    async fn get_run(&self, id: i64) -> Result<Option<RunView>> {
        Ok(self.runs.lock().unwrap().get(&id).cloned())
    }

    async fn delete_run(&self, id: i64) -> Result<bool> {
        let existed = self.runs.lock().unwrap().remove(&id).is_some();
        self.deleted.lock().unwrap().push(id);
        Ok(existed)
    }
}

/// Mock 进度推送：记录全部 send 调用。
struct MockSink {
    sent: Mutex<Vec<ProgressRecord>>,
}

impl MockSink {
    fn new() -> Self {
        Self { sent: Mutex::new(Vec::new()) }
    }
}

#[async_trait]
impl BacktestProgressSink for MockSink {
    async fn send(&self, run_id: i64, pct: i32, bar_ts: Option<DateTime<Utc>>) -> Result<()> {
        self.sent.lock().unwrap().push((run_id, pct, bar_ts));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 固定 n 根 1 日 bar（简单上行；dual_ma fast=2/slow=3 可触发交叉）。
fn make_bars(n: usize) -> Vec<Bar> {
    let base = 1_704_067_200_i64;
    (0..n)
        .map(|i| Bar {
            code: Code("600000".to_string()),
            period: Period::D1,
            ts: DateTime::from_timestamp(base + i as i64 * 86_400, 0).unwrap(),
            open: 10.0,
            high: 10.0 + i as f64 * 0.2,
            low: 9.5 + i as f64 * 0.2,
            close: 10.0 + i as f64 * 0.2,
            volume: 10_000,
            amount: 1_000_000.0,
            source: SourceId::Tushare,
        })
        .collect()
}

fn ts(secs: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(secs, 0).unwrap()
}

fn sample_run_view(id: i64) -> RunView {
    RunView {
        id,
        code: "600000".to_string(),
        period: "D1".to_string(),
        strategy_id: "dual_ma".to_string(),
        params: serde_json::json!({}),
        fee: serde_json::json!({}),
        initial_capital: 100_000.0,
        date_from: ts(1_700_000_000),
        date_to: ts(1_740_000_000),
        status: RunStatus::Done,
        progress: 100,
        current_ts: Some(ts(1_704_067_200)),
        created_at: ts(1_704_000_000),
        finished_at: Some(ts(1_704_100_000)),
        error: None,
        group_id: None,
        result: Some(RunResult {
            net_value: serde_json::json!({"series": [], "drawdown": []}),
            trades: serde_json::json!([]),
            metrics: serde_json::json!({}),
        }),
    }
}

fn fee() -> serde_json::Value {
    serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})
}

fn base_submit(strategy_id: &str) -> SubmitReq {
    SubmitReq {
        code: "600000".to_string(),
        period: "D1".to_string(),
        from: ts(1_700_000_000),
        to: ts(1_740_000_000),
        strategy_id: strategy_id.to_string(),
        params: serde_json::json!({}),
        params_grid: None,
        fee: fee(),
        initial_capital: None,
    }
}

// ---------------------------------------------------------------------------
// submit：网格展开 / 单 run
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submit_grid_expands_n_children_and_shares_group() {
    let store = Arc::new(MockStore::new());
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        store.clone(),
        Arc::new(MockSink::new()),
        4,
    );
    let mut req = base_submit("dual_ma");
    req.params_grid = Some(serde_json::json!({"fast": "2:6:2"})); // 2/4/6 → 3 子任务

    let out = service.submit(req).await.unwrap();
    let SubmitOutcome::Group(gid) = out else {
        panic!("网格应返回 SubmitOutcome::Group，实际 {out:?}")
    };

    let created = store.created.lock().unwrap();
    assert_eq!(created.len(), 3, "网格应展开 3 个子任务");
    for c in created.iter() {
        assert_eq!(c.group_id.as_deref(), Some(gid.as_str()), "子任务应共享 group_id");
    }
    // 每个子任务 fast 取展开值之一且覆盖 {2,4,6}
    let fast_values: Vec<f64> = created
        .iter()
        .map(|c| c.params.as_object().unwrap().get("fast").and_then(|v| v.as_f64()).unwrap())
        .collect();
    assert_eq!(fast_values, vec![2.0, 4.0, 6.0], "fast 展开应为 2/4/6");
}

#[tokio::test]
async fn submit_single_run_returns_run_id_and_no_group() {
    let store = Arc::new(MockStore::new());
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        store.clone(),
        Arc::new(MockSink::new()),
        4,
    );
    let req = base_submit("dual_ma");
    let from = req.from;
    let to = req.to;

    let out = service.submit(req).await.unwrap();
    let SubmitOutcome::Run(id) = out else {
        panic!("单 run 应返回 SubmitOutcome::Run，实际 {out:?}")
    };
    assert!(id >= 1, "run_id 应为正");
    let created = store.created.lock().unwrap();
    assert_eq!(created.len(), 1);
    assert!(created[0].group_id.is_none(), "单 run 不应有 group_id");
    assert_eq!(created[0].initial_capital, 100_000.0, "初始资金默认 100_000 落库（B1）");
    assert_eq!(created[0].date_from, from, "date_from 落库（B1）");
    assert_eq!(created[0].date_to, to, "date_to 落库（排除端点，B1）");
}

#[tokio::test]
async fn submit_rejects_invalid_period() {
    let store = Arc::new(MockStore::new());
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        store.clone(),
        Arc::new(MockSink::new()),
        4,
    );
    let mut req = base_submit("dual_ma");
    req.period = "H1".to_string();
    assert!(service.submit(req).await.is_err(), "H1 周期应被拒绝");
    assert!(store.created.lock().unwrap().is_empty(), "预校验失败不应创建 run 行");
}

#[tokio::test]
async fn submit_rejects_unknown_strategy() {
    let store = Arc::new(MockStore::new());
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        store.clone(),
        Arc::new(MockSink::new()),
        4,
    );
    let req = base_submit("no_such_strategy");
    assert!(service.submit(req).await.is_err());
    assert!(store.created.lock().unwrap().is_empty(), "未知策略不应创建 run 行");
}

// ---------------------------------------------------------------------------
// run_backtest：成功 / 失败路径 + 进度上报
// ---------------------------------------------------------------------------

#[tokio::test]
async fn run_success_marks_done_and_reports_progress() {
    let store = Arc::new(MockStore::new());
    let sink = Arc::new(MockSink::new());
    let run = NewRun {
        code: "600000".to_string(),
        period: "D1".to_string(),
        strategy_id: "dual_ma".to_string(),
        params: serde_json::json!({"fast": 2, "slow": 3, "position_pct": 1.0}),
        fee: fee(),
        initial_capital: 100_000.0,
        date_from: ts(1_700_000_000),
        date_to: ts(1_740_000_000),
        group_id: None,
    };
    // 7 根 bar → 进度回调 7 次
    execute_run(
        store.clone(),
        Arc::new(MockBarRead { bars: make_bars(7), fail: false }),
        sink.clone(),
        1,
        run,
        ts(1_700_000_000),
        ts(1_740_000_000),
        100_000.0,
    )
    .await;

    let done = store.done.lock().unwrap();
    assert_eq!(done.len(), 1, "成功路径应 mark_done");
    assert_eq!(store.failed.lock().unwrap().len(), 0, "成功路径不应 mark_failed");

    let sent = sink.sent.lock().unwrap();
    assert_eq!(sent.len(), 7, "进度回调应每 bar 上报一次");
    let mut last_pct = 0_i32;
    for (rid, pct, bar_ts) in sent.iter() {
        assert_eq!(*rid, 1, "进度应上报到正确 run_id");
        assert!((0..=100).contains(pct), "pct 应在 0-100");
        assert!(pct >= &last_pct, "pct 应单调不减");
        last_pct = *pct;
        assert!(bar_ts.is_some(), "bar_ts 应有值");
    }
    assert_eq!(sent.last().unwrap().1, 100, "末次进度应为 100");

    let prog = store.progress.lock().unwrap();
    assert_eq!(prog.len(), 7, "每 bar 落库进度一次");
}

#[tokio::test]
async fn run_bar_read_error_marks_failed() {
    let store = Arc::new(MockStore::new());
    let run = NewRun {
        code: "600000".to_string(),
        period: "D1".to_string(),
        strategy_id: "dual_ma".to_string(),
        params: serde_json::json!({}),
        fee: fee(),
        initial_capital: 100_000.0,
        date_from: ts(1_700_000_000),
        date_to: ts(1_740_000_000),
        group_id: None,
    };
    execute_run(
        store.clone(),
        Arc::new(MockBarRead { bars: vec![], fail: true }),
        Arc::new(MockSink::new()),
        2,
        run,
        ts(1_700_000_000),
        ts(1_740_000_000),
        100_000.0,
    )
    .await;

    let failed = store.failed.lock().unwrap();
    assert_eq!(failed.len(), 1, "bar 读取失败应 mark_failed");
    assert_eq!(failed[0].0, 2);
    assert_eq!(store.done.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn run_unknown_strategy_marks_failed() {
    let store = Arc::new(MockStore::new());
    let run = NewRun {
        code: "600000".to_string(),
        period: "D1".to_string(),
        strategy_id: "no_such_strategy".to_string(),
        params: serde_json::json!({}),
        fee: fee(),
        initial_capital: 100_000.0,
        date_from: ts(1_700_000_000),
        date_to: ts(1_740_000_000),
        group_id: None,
    };
    execute_run(
        store.clone(),
        Arc::new(MockBarRead { bars: make_bars(5), fail: false }),
        Arc::new(MockSink::new()),
        3,
        run,
        ts(1_700_000_000),
        ts(1_740_000_000),
        100_000.0,
    )
    .await;

    let failed = store.failed.lock().unwrap();
    assert_eq!(failed.len(), 1, "未知策略应 mark_failed");
    assert!(failed[0].1.contains("no_such_strategy"));
}

// ---------------------------------------------------------------------------
// 查询 / 策略目录 / compare
// ---------------------------------------------------------------------------

#[tokio::test]
async fn strategies_returns_seven_catalog() {
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        Arc::new(MockStore::new()),
        Arc::new(MockSink::new()),
        4,
    );
    let cat = service.strategies();
    assert_eq!(cat.len(), 7, "内置策略应为 7 款");
    for c in &cat {
        assert!(!c.params_schema.is_empty(), "策略 {} 参数 schema 不应为空", c.id);
    }
}

#[tokio::test]
async fn compare_returns_only_runs_the_store_has() {
    let store = Arc::new(MockStore::new());
    store.set_run(1, sample_run_view(1));
    store.set_run(3, sample_run_view(3));
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        store.clone(),
        Arc::new(MockSink::new()),
        4,
    );
    let views = service.compare(&[1, 2, 3]).await.unwrap();
    let ids: Vec<i64> = views.iter().map(|v| v.id).collect();
    assert_eq!(ids, vec![1, 3], "compare 应只返回 store 存在的 run");
}

#[tokio::test]
async fn list_runs_delegates_to_store() {
    let store = Arc::new(MockStore::new());
    store.set_run(1, sample_run_view(1));
    store.set_run(2, sample_run_view(2));
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        store.clone(),
        Arc::new(MockSink::new()),
        4,
    );
    let views = service.list_runs(&RunFilter::default()).await.unwrap();
    assert_eq!(views.len(), 2);
}

#[tokio::test]
async fn delete_run_delegates_to_store() {
    let store = Arc::new(MockStore::new());
    store.set_run(1, sample_run_view(1));
    let service = BacktestService::new(
        Arc::new(MockBarRead { bars: vec![], fail: false }),
        store.clone(),
        Arc::new(MockSink::new()),
        4,
    );

    // 存在 → true
    assert!(service.delete_run(1).await.unwrap(), "存在 run 应返回 true");
    // 不存在 → false（web 映射 404）
    assert!(!service.delete_run(99).await.unwrap(), "不存在 run 应返回 false");
    // 删除委托发生了两次
    let deleted = store.deleted.lock().unwrap();
    assert_eq!(deleted.as_slice(), &[1, 99]);
}
