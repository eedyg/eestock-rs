//! `BacktestService`（application 层）：异步任务队列 + 真实进度上报。
//! 依赖注入 domain 端口（`BacktestBarRead`/`BacktestRunStore`/`BacktestProgressSink`）+ `backtest` crate；
//! 不依赖 web/storage（DI 由 app bin / 阶段 3c 装配）。
//!
//! 职责：submit（单 run / 参数网格展开 N 子任务，共享 group_id，`BoundedSemaphore` 限并发）→
//! 每个后台任务 `run_backtest`：读 bar（domain::Bar → backtest::Bar 映射）→ 引擎按进度回调上报 →
//! 完成 `mark_done` / 失败 `mark_failed`。查询：list/get/compare；`strategies()` 提供 UI 下拉目录。

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use domain::ports::{BacktestBarRead, BacktestProgressSink, BacktestRunStore, NewRun, RunFilter, RunResult, RunView};
use std::sync::Arc;
use tokio::sync::Semaphore;

use crate::fee::to_fee_model;
use crate::params::{expand_grid, to_strategy_params};
use crate::types::{SubmitOutcome, SubmitReq};

/// 单次回测并发上限（ADR §7 默认 4；`max_concurrent` 由 DI 传入）。
pub static DEFAULT_MAX_CONCURRENT: usize = 4;

/// 回测服务。
pub struct BacktestService {
    bar_read: Arc<dyn BacktestBarRead>,
    store: Arc<dyn BacktestRunStore>,
    progress: Arc<dyn BacktestProgressSink>,
    semaphore: Arc<Semaphore>,
    initial_capital_default: f64,
}

impl BacktestService {
    /// 构造。`max_concurrent` 为并发回测上限（防 DB/资源过载），最小为 1。
    pub fn new(
        bar_read: Arc<dyn BacktestBarRead>,
        store: Arc<dyn BacktestRunStore>,
        progress: Arc<dyn BacktestProgressSink>,
        max_concurrent: usize,
    ) -> Self {
        Self {
            bar_read,
            store,
            progress,
            semaphore: Arc::new(Semaphore::new(max_concurrent.max(1))),
            initial_capital_default: 100_000.0,
        }
    }

    /// 提交：单 run 或参数网格展开 N 个子任务（共享 group_id）；每个任务 spawn 后台执行。
    /// 入队即限并发（`Semaphore::acquire` 在后台任务内阻塞等待）。
    pub async fn submit(&self, req: SubmitReq) -> anyhow::Result<SubmitOutcome> {
        // 提交期预校验（防孤儿 failed 行）：周期受支持 + 策略 id 已知（用空参数可构造默认实例）。
        parse_period(&req.period)?;
        if backtest::create_strategy(&req.strategy_id, &backtest::StrategyParams::new()).is_none() {
            return Err(anyhow!("未知策略 id: {}", req.strategy_id));
        }

        let children_params = match req.params_grid.as_ref() {
            Some(grid) => expand_grid(&req.params, grid)?,
            None => vec![req.params.clone()],
        };
        let is_grid = children_params.len() > 1;
        let group_id = is_grid.then(new_group_id);
        let initial_capital = req.initial_capital.unwrap_or(self.initial_capital_default);
        let mut run_ids = Vec::with_capacity(children_params.len());

        for params in children_params {
            let run = NewRun {
                code: req.code.clone(),
                period: req.period.clone(),
                strategy_id: req.strategy_id.clone(),
                params,
                fee: req.fee.clone(),
                group_id: group_id.clone(),
            };
            let id = self.store.create_run(&run).await?;
            run_ids.push(id);

            let store = Arc::clone(&self.store);
            let bar_read = Arc::clone(&self.bar_read);
            let progress = Arc::clone(&self.progress);
            let semaphore = Arc::clone(&self.semaphore);
            let from = req.from;
            let to = req.to;
            let run = run.clone();
            tokio::spawn(async move {
                let _permit = semaphore.acquire().await.expect("semaphore closed");
                execute_run(store, bar_read, progress, id, run, from, to, initial_capital).await;
            });
        }

        Ok(match group_id {
            Some(gid) => SubmitOutcome::Group(gid),
            None => SubmitOutcome::Run(run_ids[0]),
        })
    }

    /// 列表（GET /api/backtest/runs）。
    pub async fn list_runs(&self, filter: &RunFilter) -> anyhow::Result<Vec<RunView>> {
        self.store.list_runs(filter).await
    }

    /// 单次 run 详情（含结果；GET /api/backtest/runs/{id}）。
    pub async fn get_run(&self, id: i64) -> anyhow::Result<Option<RunView>> {
        self.store.get_run(id).await
    }

    /// 多 run 对比：委托 store 取多个 run（净值/指标由前端/3c 组装渲染）。
    pub async fn compare(&self, ids: &[i64]) -> anyhow::Result<Vec<RunView>> {
        let mut out = Vec::with_capacity(ids.len());
        for &id in ids {
            if let Some(v) = self.store.get_run(id).await? {
                out.push(v);
            }
        }
        Ok(out)
    }

    /// 策略目录（UI 下拉 + 参数 schema；GET /api/backtest/strategies）。
    pub fn strategies(&self) -> Vec<backtest::StrategyResult> {
        backtest::builtin_strategy_catalog()
    }
}

/// 周期字符串 → `(domain::types::Period, backtest::Period)`。H1 回测暂不支持（设计仅 1m/5m/15m/日）。
pub fn parse_period(s: &str) -> anyhow::Result<(domain::types::Period, backtest::Period)> {
    match s {
        "M1" => Ok((domain::types::Period::M1, backtest::Period::M1)),
        "M5" => Ok((domain::types::Period::M5, backtest::Period::M5)),
        "M15" => Ok((domain::types::Period::M15, backtest::Period::M15)),
        "D1" => Ok((domain::types::Period::D1, backtest::Period::D1)),
        "H1" => Err(anyhow!("周期 H1 回测暂不支持（仅 M1/M5/M15/D1）")),
        other => Err(anyhow!("未知周期: {other}")),
    }
}

/// 生成唯一任务组 id（时间戳 + 单调计数器；无随机依赖）。
fn new_group_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("g_{}_{}", Utc::now().timestamp_millis(), n)
}

/// `domain::types::Bar -> backtest::Bar`（ts 转 Unix 秒；volume 转 f64）。
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

/// `backtest::BacktestResult -> domain::RunResult`（拆三列 jsonb；净值=序列+回撤对象，保留回撤序列）。
fn to_run_result(res: backtest::BacktestResult) -> RunResult {
    RunResult {
        net_value: serde_json::json!({
            "series": res.net_value_series,
            "drawdown": res.drawdown_series,
        }),
        trades: serde_json::to_value(&res.trades).expect("trades 可序列化"),
        metrics: serde_json::to_value(res.metrics).expect("metrics 可序列化"),
    }
}

/// 后台执行单个 run：读 bar → 映射 → 构策略 → 引擎按进度上报 → 落结果（成功 `mark_done` / 失败 `mark_failed`）。
#[allow(clippy::too_many_arguments)]
pub async fn execute_run(
    store: Arc<dyn BacktestRunStore>,
    bar_read: Arc<dyn BacktestBarRead>,
    progress: Arc<dyn BacktestProgressSink>,
    run_id: i64,
    run: NewRun,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    initial_capital: f64,
) {
    match run_one(store.clone(), bar_read, progress, run_id, &run, from, to, initial_capital).await {
        Ok(result) => {
            if let Err(e) = store.mark_done(run_id, &result).await {
                tracing::error!(run_id, error = %e, "mark_done 失败");
            }
        }
        Err(e) => {
            let _ = store.mark_failed(run_id, &e.to_string()).await;
        }
    }
}

/// run 执行主体（返回 RunResult；不落库，由调用方 mark_done/mark_failed）。
#[allow(clippy::too_many_arguments)]
async fn run_one(
    store: Arc<dyn BacktestRunStore>,
    bar_read: Arc<dyn BacktestBarRead>,
    progress: Arc<dyn BacktestProgressSink>,
    run_id: i64,
    run: &NewRun,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    initial_capital: f64,
) -> anyhow::Result<RunResult> {
    let (domain_period, bt_period) = parse_period(&run.period)?;
    let bars = bar_read.bars(&run.code, &domain_period, from, to).await?;
    if bars.is_empty() {
        return Err(anyhow!("回测区间无 K 线 bar（code={}, period={}）", run.code, run.period));
    }
    let bt_bars: Vec<backtest::Bar> = bars.iter().map(to_bt_bar).collect();
    let fee = to_fee_model(&run.fee)?;
    let params = to_strategy_params(&run.params)?;
    let mut strategy = backtest::create_strategy(&run.strategy_id, &params)
        .ok_or_else(|| anyhow!("未知策略 id: {}", run.strategy_id))?;

    // 引擎进度回调为**同步**（纯逻辑），经 mpsc 桥接到独立异步报告任务（WS + 落库）。
    // total（总 bar 数）由引擎在回调参数中提供，无需在此重复推导。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(i32, DateTime<Utc>)>();
    let sink = Arc::clone(&progress);
    let store2 = Arc::clone(&store);
    let report_task = tokio::spawn(async move {
        while let Some((pct, ts)) = rx.recv().await {
            let _ = sink.send(run_id, pct, Some(ts)).await;
            let _ = store2.update_run_progress(run_id, pct, ts).await;
        }
    });

    let cfg = backtest::RunConfig {
        initial_capital,
        fee,
        period: bt_period,
    };
    let result = tokio::task::spawn_blocking(move || {
        let mut cb = |i: usize, total: usize, t: i64| {
            let pct = ((i + 1) * 100 / total) as i32;
            if let Some(ts) = DateTime::from_timestamp(t, 0) {
                let _ = tx.send((pct, ts));
            }
        };
        backtest::Engine::new(cfg).run_with_progress(&bt_bars, strategy.as_mut(), &mut cb)
    })
    .await
    .map_err(|e| anyhow!("回测任务 panic: {e}"))?;

    // 引擎在 spawn_blocking 结束后已 drop 发送端；等报告任务排空（进度/落库全部完成）保证确定可复现。
    let _ = report_task.await;

    Ok(to_run_result(result))
}
