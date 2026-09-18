//! 回测 K 线读取端口实现（Wave 3 Phase 3a；**非 tangle 手写**，契约描述见 design/04-storage/schema.md §4.3.5）。
//! 实现 domain::ports::BacktestBarRead（PgPool）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；engine（backtest crate）无 IO/DB，
//! application 层做 domain::Bar -> backtest::Bar 映射。
//!
//! P4b（D16 终章）：`PgBacktestStore`（backtest_runs/backtest_results CRUD，迁移 0011）随旧回测服务
//! 链物理删除（design/12-strategy-system/01-adr.md §13.8）；`BacktestBarReader` 保留——
//! 新系统（strategy 试算 / workbench 工作台 / mcp bt_* 工具）复用同一取数口径。
//!
//! - `BacktestBarReader`：统一读源（accurate 优先 + cagg 兜底，与 KlineReader 同口径），读 [from,to) 升序 domain::Bar。

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use domain::ports::{AvailableRange, BacktestBarRead};
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

/// 30m 兜底：kline_15m 查询期 rollup（与 reader.rs FALLBACK_30M 同义；2 个 15m 桶 = 1 个 30m 桶）。
const FALLBACK_30M: &str = r#"
(SELECT code, time_bucket('30 minutes', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_15m GROUP BY code, time_bucket('30 minutes', ts))"#;

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

/// 单层 + 兜底并集（`code` 绑定 `$1`）的 min/max：可得区间判定（ADR-024 D3 **服务口径并集**）。
///
/// 硬约束：**不得**只查 accurate 层 —— accurate cagg 已知滞后（ADR-023 §2.4 实测：
/// `kline_accurate_5m` 曾整周 0 行、长期靠兜底在服务），单层判定会切掉兜底本可服务的最新数据。
fn union_avail_sql(accurate: &str, fallback: &str) -> String {
    format!(
        "SELECT min(ts) AS mn, max(ts) AS mx FROM (\
           SELECT ts FROM {accurate} WHERE code = $1 \
           UNION ALL SELECT ts FROM {fallback} WHERE code = $1) u",
        accurate = accurate, fallback = fallback
    )
}

/// 可得区间 SQL：`code` 绑定 `$1`，返回 `(min_ts, max_ts)`（无数据 → NULL）。
/// 口径与 [`period_range_sql`] 逐层对应（accurate ∪ 兜底）。
fn period_avail_sql(p: Period) -> String {
    match p {
        // M1：`kline_merged` 已是 accurate 优先 + raw 兜底（ADR-003），本身即并集口径。
        Period::M1 => "SELECT min(ts) AS mn, max(ts) AS mx FROM kline_merged WHERE code = $1".to_string(),
        Period::M5 => union_avail_sql("kline_accurate_5m", "kline_5m"),
        Period::M15 => union_avail_sql("kline_accurate_15m", "kline_15m"),
        Period::M30 => union_avail_sql("kline_accurate_30m", FALLBACK_30M),
        Period::H1 => union_avail_sql("kline_accurate_1h", FALLBACK_1H),
        Period::D1 => union_avail_sql("kline_accurate_1d", "kline_1d"),
        Period::W1 => union_avail_sql("kline_accurate_1w", FALLBACK_1W),
        Period::MO1 => union_avail_sql("kline_accurate_1mo", FALLBACK_1MO),
    }
}

/// 区间 bar 计数 SQL（ADR-024 D12 预扫描；与 [`period_range_sql`] 同源，`$1/$2/$3 = code/from/to`）。
fn period_count_sql(p: Period) -> String {
    format!("SELECT count(*) FROM ({}) c", period_range_sql(p))
}

fn period_range_sql(p: Period) -> String {
    match p {
        Period::M1 => M1_RANGE_SQL.to_string(),
        Period::M5 => range_sql("kline_accurate_5m", "kline_5m"),
        Period::M15 => range_sql("kline_accurate_15m", "kline_15m"),
        // ADR-023 增 30m 读源（accurate cagg + 15m rollup 兜底）；ADR-024 P0 起 M30 已入回测白名单
        // （backtest::Period 有 M30 变体，application::bar_map::parse_period 接受 "M30"）⇒ 回测可以 M30 入队。
        Period::M30 => range_sql("kline_accurate_30m", FALLBACK_30M),
        Period::H1 => range_sql("kline_accurate_1h", FALLBACK_1H),
        Period::D1 => range_sql("kline_accurate_1d", "kline_1d"),
        // ⚠️ W1/MO1 仅看板读源扩展（domain::Period 增变体以保 match 全穷尽）；回测周期不扩——
        // application::bar_map::parse_period 仍拒绝 1w/1mo，故实际回测不会以 W1/MO1 条目入队。
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

    /// 可得区间（**服务口径并集**：accurate ∪ 兜底；ADR-024 D3）。
    ///
    /// 单条轻量 min/max（`code` 走 `(code, ts)` 索引）；**不**只查 accurate 层（其 cagg 已知滞后）。
    /// 无数据 → `Ok(None)`。`to` = 最晚 bar ts + 1s（半开，保证该 bar 落在区间内）。
    async fn available_range(&self, code: &str, period: &Period)
        -> Result<Option<AvailableRange>> {
        let sql = period_avail_sql(*period);
        let (mn, mx): (Option<DateTime<Utc>>, Option<DateTime<Utc>>) =
            sqlx::query_as(&sql).bind(code).fetch_one(&self.pool).await?;
        Ok(match (mn, mx) {
            (Some(from), Some(to)) => Some(AvailableRange { from, to: to + Duration::seconds(1) }),
            _ => None,
        })
    }

    /// 区间内 bar 数（ADR-024 D12 预扫描；`count(*)` 与取数同源口径）。
    async fn count_bars(&self, code: &str, period: &Period, from: DateTime<Utc>, to: DateTime<Utc>)
        -> Result<i64> {
        let sql = period_count_sql(*period);
        let (n,): (i64,) = sqlx::query_as(&sql)
            .bind(code).bind(from).bind(to)
            .fetch_one(&self.pool).await?;
        Ok(n)
    }
}

