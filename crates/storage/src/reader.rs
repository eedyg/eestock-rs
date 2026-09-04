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
use chrono::{DateTime, NaiveDate, Utc};
use domain::ports::{
    DivergenceRow, HealthEventRow, HealthEventsRangeRead, HealthEventsRead, HolidayCalendarRead,
    KlineBarView, KlineRead, QualityRead, SymbolLatestView, SymbolStatView, SymbolStatsRead,
    SyncCheckpointView, TushareStatusRead,
};
use domain::types::Period;
use sqlx::PgPool;
use std::collections::HashSet;

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

/// 每 code 最近 2 根 merge bar（D3 优化版，Wave 2 Phase A）。
/// 旧版直查 kline_merged 视图（UNION ALL + NOT EXISTS 反连接阻断裂索引下推，实测 15-20s/次，
/// Wave 1 验收 D3）；新版双侧各自 (code,ts) 索引回溯 LIMIT 2 取候选 → 按 ts 去重（同 ts 准确层优先，
/// merge 语义）→ row_number 取最新两根。merge 尾部 top-2 ⊆ 双侧 top-2 并集，语义等价
/// （实盘全量 symbols 新老查询 EXCEPT 互减 0 行，证据见 coder/report/011）。
/// 实测（同库）：旧 19,850ms → 新 13.5ms。
const SYMBOLS_LATEST_SQL: &str = r#"
SELECT s.code, s.name, s.interval_secs, s.settlement, s.enabled,
       l.last_ts, l.last_close, l.prev_close
FROM symbols s
LEFT JOIN LATERAL (
  SELECT max(CASE WHEN rn = 1 THEN ts END)   AS last_ts,
         max(CASE WHEN rn = 1 THEN close END) AS last_close,
         max(CASE WHEN rn = 2 THEN close END) AS prev_close
  FROM (
    SELECT ts, close, row_number() OVER (ORDER BY ts DESC) AS rn
    FROM (
      SELECT DISTINCT ON (ts) ts, close
      FROM (
        (SELECT a.ts, a.close, 0 AS pri FROM kline_accurate a
         WHERE a.code = s.code AND a.period = 'M1' ORDER BY a.ts DESC LIMIT 2)
        UNION ALL
        (SELECT r.ts, r.close, 1 AS pri FROM kline_raw r
         WHERE r.code = s.code ORDER BY r.ts DESC LIMIT 2)
      ) cand
      ORDER BY ts, pri
    ) dedup
  ) ranked
) l ON true
ORDER BY s.code
"#;

const WINDOW_EVENTS_SQL: &str = r#"
SELECT ts, source, ok, latency_ms, err_kind, code
FROM source_health_events
WHERE ts > now() - make_interval(secs => $1)
ORDER BY source, ts
"#;

/// 当日（Asia/Shanghai 日界）kline_raw 每 code 行数与最新 ts（页面③ with_stats 数据源）。
const TODAY_STATS_SQL: &str = r#"
SELECT code, count(*)::bigint AS today_bars, max(ts) AS last_bar_ts
FROM kline_raw
WHERE ts >= $1 AND ts < $2
GROUP BY code
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

/// 标的当日采集统计（SymbolStatsRead 实现；页面③ GET /api/symbols?with_stats=1 数据源）。
/// 当日 = Asia/Shanghai 日界（domain::tz 固定 +8 平移口径，与 RawBarReader::existing_ts 一致）。
#[async_trait]
impl SymbolStatsRead for KlineReader {
    async fn today_stats(&self) -> Result<Vec<SymbolStatView>> {
        let today_cst = domain::tz::utc_to_cst(Utc::now()).date();
        let start = domain::tz::cst_to_utc(today_cst.and_hms_opt(0, 0, 0).expect("valid hms"));
        let end = domain::tz::cst_to_utc((today_cst + chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0).expect("valid hms"));
        type Row = (String, i64, Option<DateTime<Utc>>);
        let rows: Vec<Row> = sqlx::query_as(TODAY_STATS_SQL)
            .bind(start).bind(end).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(code, today_bars, last_bar_ts)|
            SymbolStatView { code, today_bars, last_bar_ts }).collect())
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

// ── Wave 2 Phase A 加法：质量对照 / 节假日 / 事件区间 / tushare 同步状态（domain 端口契约见 §2）──

/// raw ⋈ accurate(M1) 双侧收盘对照（质量分歧表数据源）。
/// amount 刻意不查（D4 结案：跨层量纲不可比，04-storage §4.4 注记 7）。
const DIVERGENCE_SQL: &str = r#"
SELECT r.ts, r.code, r.close AS raw_close, a.close AS accurate_close, r.source AS raw_source
FROM kline_raw r
JOIN kline_accurate a ON a.code = r.code AND a.ts = r.ts AND a.period = 'M1'
WHERE ($1::text IS NULL OR r.code = $1)
  AND r.ts >= $2 AND r.ts < $3
ORDER BY r.ts
"#;

#[async_trait]
impl QualityRead for KlineReader {
    async fn divergence_rows(&self, code: Option<&str>, from: DateTime<Utc>, to: DateTime<Utc>)
        -> Result<Vec<DivergenceRow>> {
        type Row = (DateTime<Utc>, String, f64, f64, String);
        let rows: Vec<Row> = sqlx::query_as(DIVERGENCE_SQL)
            .bind(code).bind(from).bind(to).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(ts, code, raw_close, accurate_close, raw_source)|
            DivergenceRow { ts, code, raw_close, accurate_close, raw_source: Some(raw_source) }
        ).collect())
    }
}

/// tushare 同步检查点读（页面④ sync-panel 数据源）。
const SYNC_CHECKPOINTS_SQL: &str = r#"
SELECT code, period, last_synced_date, updated_at FROM sync_checkpoints ORDER BY code
"#;

#[async_trait]
impl TushareStatusRead for KlineReader {
    async fn sync_checkpoints(&self) -> Result<Vec<SyncCheckpointView>> {
        type Row = (String, String, NaiveDate, DateTime<Utc>);
        let rows: Vec<Row> = sqlx::query_as(SYNC_CHECKPOINTS_SQL).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(code, period, last_synced_date, updated_at)|
            SyncCheckpointView { code, period, last_synced_date, updated_at }).collect())
    }
}

/// 健康事件区间读（质量缺口分类输入；与窗口版同表，[from, to) 闭开区间）。
const RANGE_EVENTS_SQL: &str = r#"
SELECT ts, source, ok, latency_ms, err_kind, code
FROM source_health_events
WHERE ts >= $1 AND ts < $2
ORDER BY ts
"#;

#[async_trait]
impl HealthEventsRangeRead for HealthEventReader {
    async fn events_between(&self, from: DateTime<Utc>, to: DateTime<Utc>)
        -> Result<Vec<HealthEventRow>> {
        type Row = (DateTime<Utc>, String, bool, Option<i32>, Option<String>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(RANGE_EVENTS_SQL)
            .bind(from).bind(to).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(ts, source, ok, latency_ms, err_kind, code)|
            HealthEventRow { ts, source, ok, latency_ms, err_kind, code }
        ).collect())
    }
}

/// 节假日表读（0008；collector HolidayCalendar 刷新与 diagnose 缺口报告共用同一实现）。
pub struct HolidaysReader {
    pool: PgPool,
}

impl HolidaysReader {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl HolidayCalendarRead for HolidaysReader {
    async fn holidays(&self) -> Result<HashSet<NaiveDate>> {
        let rows: Vec<(NaiveDate,)> = sqlx::query_as("SELECT date FROM holidays")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(d,)| d).collect())
    }
}
// ~/~ end
