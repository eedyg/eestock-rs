//! 回测端口实现（Wave 3 Phase 3a；**非 tangle 手写**，契约描述见 design/04-storage/schema.md §4.3.5）。
//! 实现 domain::ports::{BacktestBarRead, BacktestRunStore}（PgPool）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；engine（backtest crate）无 IO/DB，
//! application 层（Phase 3b BacktestService）做 domain::Bar -> backtest::Bar 映射。
//!
//! - `BacktestBarReader`：统一读源（accurate 优先 + cagg 兜底，与 KlineReader 同口径），读 [from,to) 升序 domain::Bar。
//! - `PgBacktestStore`：backtest_runs/backtest_results CRUD（迁移 0011；应用面自有表）。

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{
    BacktestBarRead, BacktestRunStore, NewRun, RunFilter, RunResult, RunStatus, RunView,
};
use domain::types::{Bar, Code, Period, SourceId};
use sqlx::PgPool;

/// 回测 K线读取：M1 走 kline_merged 视图（准确层优先，含 source）；其余周期走 accurage/cagg + 底层兜底。
pub struct BacktestBarReader {
    pool: PgPool,
}

impl BacktestBarReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

type BarRow = (String, DateTime<Utc>, f64, f64, f64, f64, i64, f64, Option<String>);

/// M1：kline_merged 已经是 accurate 优先（ADR-003），source 列非 NULL。
const M1_RANGE_SQL: &str = r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM kline_merged
WHERE code = $1 AND ts >= $2 AND ts < $3
ORDER BY ts
"#;

/// 高周期统一读源：accurate(cagg，source='tushare') UNION ALL 兜底(反连接剔重，source=NULL)。
/// 与 reader.rs `merged_sql` 语义一致，仅把 `ts < before LIMIT` 换成区间 `[from,to)`。
fn range_sql(accurate: &str, fallback: &str) -> String {
    format!(r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM (
    SELECT code, ts, open, high, low, close, volume::bigint AS volume, amount, 'tushare'::text AS source
    FROM {accurate}
    WHERE code = $1 AND ts >= $2 AND ts < $3
    UNION ALL
    SELECT f.code, f.ts, f.open, f.high, f.low, f.close, f.volume::bigint AS volume, f.amount, NULL::text AS source
    FROM {fallback} f
    WHERE f.code = $1 AND f.ts >= $2 AND f.ts < $3
      AND NOT EXISTS (SELECT 1 FROM {accurate} a WHERE a.code = f.code AND a.ts = f.ts)
) m
ORDER BY ts
"#, accurate = accurate, fallback = fallback)
}

/// 1h 兜底：kline_15m 查询期 rollup（schema 未建 kline_1h cagg；与 reader.rs FALLBACK_1H 同义）。
const FALLBACK_1H: &str = r#"
(SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_15m GROUP BY code, time_bucket('1 hour', ts))"#;

fn period_range_sql(p: Period) -> String {
    match p {
        Period::M1 => M1_RANGE_SQL.to_string(),
        Period::M5 => range_sql("kline_accurate_5m", "kline_5m"),
        Period::M15 => range_sql("kline_accurate_15m", "kline_15m"),
        Period::H1 => range_sql("kline_accurate_1h", FALLBACK_1H),
        Period::D1 => range_sql("kline_accurate_1d", "kline_1d"),
    }
}

#[async_trait]
impl BacktestBarRead for BacktestBarReader {
    /// [from, to) 升序 bar。source 处理：兜底 cagg 行 source=NULL 无法回源（cagg 无来源列），
    /// 以 SourceId::parse().unwrap_or(Tushare) 占位——backtest engine 不消费 source（application 层映射丢弃）。
    async fn bars(&self, code: &str, period: &Period, from: DateTime<Utc>, to: DateTime<Utc>)
        -> Result<Vec<Bar>> {
        let sql = period_range_sql(*period);
        let rows: Vec<BarRow> = sqlx::query_as(&sql)
            .bind(code).bind(from).bind(to)
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(code, ts, open, high, low, close, volume, amount, source)| {
            Bar {
                code: Code(code),
                period: *period,
                ts,
                open,
                high,
                low,
                close,
                volume: volume.max(0) as u64,
                amount,
                source: source.as_deref().and_then(SourceId::parse).unwrap_or(SourceId::Tushare),
            }
        }).collect())
    }
}

/// 回测运行存储：backtest_runs/backtest_results（迁移 0011）。
pub struct PgBacktestStore {
    pool: PgPool,
}

impl PgBacktestStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

type RunRow = (i64, String, String, String, serde_json::Value, serde_json::Value,
               String, i32, Option<DateTime<Utc>>, DateTime<Utc>, Option<DateTime<Utc>>,
               Option<String>, Option<String>, Option<serde_json::Value>,
               Option<serde_json::Value>, Option<serde_json::Value>);

/// 联表行（run LEFT JOIN result）→ RunView。status 文本宽容解析；result 三列全非空才聚成 RunResult。
fn to_run_view(row: RunRow) -> RunView {
    let (id, code, period, strategy_id, params, fee, status, progress, current_ts,
         created_at, finished_at, error, group_id, net_value, trades, metrics) = row;
    let result = match (net_value, trades, metrics) {
        (Some(net_value), Some(trades), Some(metrics)) =>
            Some(RunResult { net_value, trades, metrics }),
        _ => None,
    };
    RunView {
        id,
        code,
        period,
        strategy_id,
        params,
        fee,
        status: RunStatus::parse(&status).unwrap_or(RunStatus::Pending),
        progress,
        current_ts,
        created_at,
        finished_at,
        error,
        group_id,
        result,
    }
}

/// 列表/详情联表 SQL（run LEFT JOIN result；status/group 过滤用 `$n::text IS NULL OR`）。
const RUNS_SELECT: &str = r#"
SELECT r.id, r.code, r.period, r.strategy_id, r.params_json, r.fee_json, r.status, r.progress,
       r.current_ts, r.created_at, r.finished_at, r.error, r.group_id,
       res.net_value_json, res.trades_json, res.metrics_json
FROM backtest_runs r
LEFT JOIN backtest_results res ON res.run_id = r.id
"#;

#[async_trait]
impl BacktestRunStore for PgBacktestStore {
    async fn create_run(&self, run: &NewRun) -> Result<i64> {
        let row: (i64,) = sqlx::query_as(
            "INSERT INTO backtest_runs (code, period, strategy_id, params_json, fee_json, status, group_id) \
             VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING id")
            .bind(&run.code).bind(&run.period).bind(&run.strategy_id)
            .bind(&run.params).bind(&run.fee).bind(&run.group_id)
            .fetch_one(&self.pool).await?;
        Ok(row.0)
    }

    /// 进度上报：写 progress/current_ts，并把 pending → running（进度即运行中）。
    async fn update_run_progress(&self, id: i64, pct: i32, ts: DateTime<Utc>) -> Result<()> {
        sqlx::query(
            "UPDATE backtest_runs SET progress = $2, current_ts = $3, \
             status = CASE WHEN status = 'pending' THEN 'running' ELSE status END \
             WHERE id = $1")
            .bind(id).bind(pct).bind(ts)
            .execute(&self.pool).await?;
        Ok(())
    }

    /// 完成：事务内置 done + 结果 upsert（run_id PK 冲突走 DO UPDATE，幂等重跑）。
    async fn mark_done(&self, id: i64, result: &RunResult) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE backtest_runs SET status = 'done', progress = 100, finished_at = now() WHERE id = $1")
            .bind(id).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO backtest_results (run_id, net_value_json, trades_json, metrics_json) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (run_id) DO UPDATE SET \
                net_value_json = EXCLUDED.net_value_json, \
                trades_json = EXCLUDED.trades_json, \
                metrics_json = EXCLUDED.metrics_json")
            .bind(id).bind(&result.net_value).bind(&result.trades).bind(&result.metrics)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn mark_failed(&self, id: i64, err: &str) -> Result<()> {
        sqlx::query(
            "UPDATE backtest_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1")
            .bind(id).bind(err).execute(&self.pool).await?;
        Ok(())
    }

    async fn list_runs(&self, filter: &RunFilter) -> Result<Vec<RunView>> {
        let sql = format!(
            "{RUNS_SELECT} WHERE ($1::text IS NULL OR r.status = $1) \
             AND ($2::text IS NULL OR r.group_id = $2) \
             ORDER BY r.created_at DESC, r.id DESC");
        let rows: Vec<RunRow> = sqlx::query_as(&sql)
            .bind(filter.status.map(|s| s.as_str()))
            .bind(filter.group_id.as_deref())
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(to_run_view).collect())
    }

    async fn get_run(&self, id: i64) -> Result<Option<RunView>> {
        let sql = format!("{RUNS_SELECT} WHERE r.id = $1");
        let row: Option<RunRow> = sqlx::query_as(&sql).bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(to_run_view))
    }
}
