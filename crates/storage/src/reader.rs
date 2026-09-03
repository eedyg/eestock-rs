// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/storage/src/reader.rs>>[init]
//! 应用面只读扩展（Wave 1 Phase A 加法，ADR-017 授权口径；写入路径零改动）：
//! 实现 domain::ports::{KlineRead, HealthEventsRead}（分层红线：web/diagnose 只依赖 domain 端口）。
//! - 1m：kline_merged 合并视图（准确层优先，ADR-003）
//! - 5m/15m/1d：连续聚合直读（ADR-004）
//! - 1h：kline_15m rollup（schema 未建 kline_1h cagg，查询期聚合语义等价）
//! - symbols + 最新快照（REST /api/symbols latest 字段与 WS quote 推送数据源）
//! - source_health_events 窗口读取（diagnose 聚合输入）

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{HealthEventRow, HealthEventsRead, KlineBarView, KlineRead, SymbolLatestView};
use domain::types::Period;
use sqlx::PgPool;

type BarTuple = (String, DateTime<Utc>, f64, f64, f64, f64, i64, f64, Option<String>);

const MERGED_1M_SQL: &str = r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM kline_merged
WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
ORDER BY ts DESC LIMIT $3
"#;

/// cagg 无 source 列（以 NULL 归一行型）；volume 为 numeric → ::bigint。
/// 表名只经 KlineRead::bars 内部 match 映射常量传入，不接受外部输入（无注入面）。
fn cagg_sql(table: &str) -> String {
    format!("
SELECT code, ts, open, high, low, close, volume::bigint AS volume, amount, NULL::text AS source
FROM {table}
WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
ORDER BY ts DESC LIMIT $3")
}

const ROLLUP_1H_SQL: &str = r#"
SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low, last(close, ts) AS close,
       sum(volume)::bigint AS volume, sum(amount) AS amount, NULL::text AS source
FROM kline_15m
WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
GROUP BY code, time_bucket('1 hour', ts)
ORDER BY ts DESC LIMIT $3
"#;

/// 每 code 最近 2 根 merge bar（LATERAL，避免全表窗口）；prev_close = 前一根收盘。
const SYMBOLS_LATEST_SQL: &str = r#"
SELECT s.code, s.name, s.interval_secs, s.settlement, s.enabled,
       l.ts AS last_ts, l.close AS last_close, l.prev_close
FROM symbols s
LEFT JOIN LATERAL (
    SELECT ts, close, lag(close) OVER (ORDER BY ts) AS prev_close
    FROM (
        SELECT ts, close FROM kline_merged m
        WHERE m.code = s.code
        ORDER BY ts DESC LIMIT 2
    ) latest2
    ORDER BY ts DESC LIMIT 1
) l ON true
ORDER BY s.code
"#;

const WINDOW_EVENTS_SQL: &str = r#"
SELECT ts, source, ok, latency_ms, err_kind, code
FROM source_health_events
WHERE ts > now() - make_interval(secs => $1)
ORDER BY source, ts
"#;

/// K线只读端口实现（PgPool）。
pub struct KlineReader {
    pool: PgPool,
}

impl KlineReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl KlineRead for KlineReader {
    /// ts < before（None=最新起），降序取 limit 行后翻转**升序**返回（图表口径）。
    async fn bars(&self, period: Period, code: &str,
                  before: Option<DateTime<Utc>>, limit: i64) -> Result<Vec<KlineBarView>> {
        let sql = match period {
            Period::M1 => MERGED_1M_SQL.to_string(),
            Period::M5 => cagg_sql("kline_5m"),
            Period::M15 => cagg_sql("kline_15m"),
            Period::H1 => ROLLUP_1H_SQL.to_string(),
            Period::D1 => cagg_sql("kline_1d"),
        };
        let rows: Vec<BarTuple> = sqlx::query_as(&sql)
            .bind(code).bind(before).bind(limit)
            .fetch_all(&self.pool).await?;
        let mut bars: Vec<KlineBarView> = rows.into_iter().map(
            |(code, ts, open, high, low, close, volume, amount, source)|
            KlineBarView { code, ts, open, high, low, close, volume, amount, source }
        ).collect();
        bars.reverse();
        Ok(bars)
    }

    /// 注册表 + 最新快照（涨跌幅 = (last − prev_close) / prev_close，由调用方计算）。
    async fn symbols_with_latest(&self) -> Result<Vec<SymbolLatestView>> {
        type Row = (String, Option<String>, i32, String, bool,
                    Option<DateTime<Utc>>, Option<f64>, Option<f64>);
        let rows: Vec<Row> = sqlx::query_as(SYMBOLS_LATEST_SQL).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(
            |(code, name, interval_secs, settlement, enabled, last_ts, last_close, prev_close)|
            SymbolLatestView { code, name, interval_secs, settlement, enabled,
                               last_ts, last_close, prev_close }
        ).collect())
    }
}

/// 健康事件窗口读取（diagnose 聚合输入；HealthEventsRead 实现）。
pub struct HealthEventReader {
    pool: PgPool,
}

impl HealthEventReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl HealthEventsRead for HealthEventReader {
    async fn window_events(&self, window_secs: i64) -> Result<Vec<HealthEventRow>> {
        type Row = (DateTime<Utc>, String, bool, Option<i32>, Option<String>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(WINDOW_EVENTS_SQL)
            .bind(window_secs as f64).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(ts, source, ok, latency_ms, err_kind, code)|
            HealthEventRow { ts, source, ok, latency_ms, err_kind, code }
        ).collect())
    }
}
// ~/~ end
