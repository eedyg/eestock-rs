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
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};

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

/// 周线 W1 兜底：kline_1d 查询期 rollup（与 reader.rs FALLBACK_1W 同义；周=A股交易周周一为界）。
const FALLBACK_1W: &str = r#"
(SELECT code, time_bucket('1 week', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_1d GROUP BY code, time_bucket('1 week', ts, 'Asia/Shanghai'))"#;

/// 月线 MO1 兜底：kline_1d 查询期 rollup（与 reader.rs FALLBACK_1MO 同义；月=自然月）。
const FALLBACK_1MO: &str = r#"
(SELECT code, time_bucket('1 month', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_1d GROUP BY code, time_bucket('1 month', ts, 'Asia/Shanghai'))"#;

fn period_range_sql(p: Period) -> String {
    match p {
        Period::M1 => M1_RANGE_SQL.to_string(),
        Period::M5 => range_sql("kline_accurate_5m", "kline_5m"),
        Period::M15 => range_sql("kline_accurate_15m", "kline_15m"),
        Period::H1 => range_sql("kline_accurate_1h", FALLBACK_1H),
        Period::D1 => range_sql("kline_accurate_1d", "kline_1d"),
        // ⚠️ W1/MO1 仅看板读源扩展（domain::Period 增变体以保 match 全穷尽）；回测周期不扩——
        // application::parse_period 仍拒绝 1w/1mo，故实际回测不会以 W1/MO1 条目入队。
        Period::W1 => range_sql("kline_accurate_1w", FALLBACK_1W),
        Period::MO1 => range_sql("kline_accurate_1mo", FALLBACK_1MO),
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

/// 联表行（run LEFT JOIN result）→ RunView（用 sqlx::Row 手动按列索引提取，避免 16 元组 FromRow 上限）。
/// ⚠️ 列索引必须与 `RUNS_SELECT` 的列顺序一一对应；增列时同步更新。
fn row_to_run_view(row: &PgRow) -> RunView {
    let net_value: Option<serde_json::Value> = row.get(16);
    let trades: Option<serde_json::Value> = row.get(17);
    let metrics: Option<serde_json::Value> = row.get(18);
    let result = match (net_value, trades, metrics) {
        (Some(net_value), Some(trades), Some(metrics)) =>
            Some(RunResult { net_value, trades, metrics }),
        _ => None,
    };
    let status: String = row.get(9);
    RunView {
        id: row.get(0),
        code: row.get(1),
        period: row.get(2),
        strategy_id: row.get(3),
        params: row.get(4),
        fee: row.get(5),
        initial_capital: row.get(6),
        date_from: row.get(7),
        date_to: row.get(8),
        status: RunStatus::parse(&status).unwrap_or(RunStatus::Pending),
        progress: row.get(10),
        current_ts: row.get(11),
        created_at: row.get(12),
        finished_at: row.get(13),
        error: row.get(14),
        group_id: row.get(15),
        result,
    }
}

/// 列表/详情联表 SQL（run LEFT JOIN result；status/group 过滤用 `$n::text IS NULL OR`）。
const RUNS_SELECT: &str = r#"
SELECT r.id, r.code, r.period, r.strategy_id, r.params_json, r.fee_json,
       r.initial_capital, r.date_from, r.date_to,
       r.status, r.progress, r.current_ts, r.created_at, r.finished_at, r.error, r.group_id,
       res.net_value_json, res.trades_json, res.metrics_json
FROM backtest_runs r
LEFT JOIN backtest_results res ON res.run_id = r.id
"#;

#[async_trait]
impl BacktestRunStore for PgBacktestStore {
    /// 写 pending 行（B1 起落 initial_capital/date_from/date_to 三列，迁移 0012）。
    async fn create_run(&self, run: &NewRun) -> Result<i64> {
        let row: (i64,) = sqlx::query_as(
            "INSERT INTO backtest_runs (code, period, strategy_id, params_json, fee_json, status, group_id, \
             initial_capital, date_from, date_to) \
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9) RETURNING id")
            .bind(&run.code).bind(&run.period).bind(&run.strategy_id)
            .bind(&run.params).bind(&run.fee).bind(&run.group_id)
            .bind(run.initial_capital).bind(run.date_from).bind(run.date_to)
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
        let rows: Vec<PgRow> = sqlx::query(&sql)
            .bind(filter.status.map(|s| s.as_str()))
            .bind(filter.group_id.as_deref())
            .fetch_all(&self.pool).await?;
        Ok(rows.iter().map(row_to_run_view).collect())
    }

    async fn get_run(&self, id: i64) -> Result<Option<RunView>> {
        let sql = format!("{RUNS_SELECT} WHERE r.id = $1");
        let row: Option<PgRow> = sqlx::query(&sql).bind(id).fetch_optional(&self.pool).await?;
        Ok(row.as_ref().map(row_to_run_view))
    }

    /// 删除 run（backtest_results 由 FK ON DELETE CASCADE 级联）。返回 true=删了行；false=id 不存在。
    async fn delete_run(&self, id: i64) -> Result<bool> {
        let res = sqlx::query("DELETE FROM backtest_runs WHERE id = $1")
            .bind(id).execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }
}
