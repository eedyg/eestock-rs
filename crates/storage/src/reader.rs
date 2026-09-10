// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/storage/src/reader.rs>>[init]
//! 应用面只读扩展（Wave 1 Phase A 加法，ADR-017 授权口径；写入路径零改动）：
//! 实现 domain::ports::{KlineRead, HealthEventsRead}（分层红线：web/diagnose 只依赖 domain 端口）。
//! 统一读源（Wave 3 0010）：所有周期 accurate 优先 + 底层兜底（ADR-003 推广）。
//! - 1m：MERGED_1M_SQL 双侧 (code,ts) 索引 DESC LIMIT 合并（准确层优先语义等价 kline_merged，ADR-003）；5m/15m/1h/1d/w/m：merged_sql(accurate_<P> UNION ALL 兜底 反连接)
//! - forming 桶（实时右缘）：5m/15m/1h 在 latest 查询（before=None）额外聚合当前未闭合桶（kline_raw 实时）
//!   —— cagg(accurate/兜底) 只承载**已闭合**桶，右缘落后至上一闭合桶（5m 最多 ~5min），forming 分支让右缘随 live 前进。
//! - 周线 W1/月线 MO1（看板 W1）：accurate 用 kline_accurate_1w/1mo（0014 cagg）；兜底用 kline_1d 查询期 rollup
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

/// 1m 统一读源（MERGED_1M_SQL，ADR-003 准确层优先语义等价 kline_merged）。
/// 旧版直查 kline_merged 视图（accurate(M1) UNION ALL raw 反连接剔重）：ORDER BY ts DESC LIMIT 无法
/// 下推到各分支 → 全量 Append（~77万行）+ top-N 排序 + raw 反连接逐行查 accurate，实测 ~2.5s。
/// 新版双侧各自 (code,ts) 索引回溯 DESC LIMIT 取候选 → 合并（同 ts 准确层优先，raw 经反连接剔重）
/// 再 DESC LIMIT。merge 尾部 top-N ⊆ 双侧 top-N 并集，语义等价（实盘 EXCEPT 互减 0 行）。
/// 实测（同库）：旧 ~1.05s → 新 ~0.1s。raw 分支保留实际 source（与 kline_merged 口径一致）；
/// accurate 分支 source 记 'tushare'（与准确层写入源一致）。
const MERGED_1M_SQL: &str = r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM (
    (SELECT a.code, a.ts, a.open, a.high, a.low, a.close, a.volume::bigint AS volume,
            a.amount, 'tushare'::text AS source
     FROM kline_accurate a
     WHERE a.code = $1 AND a.period = 'M1' AND ($2::timestamptz IS NULL OR a.ts < $2)
     ORDER BY a.ts DESC LIMIT $3)
    UNION ALL
    (SELECT f.code, f.ts, f.open, f.high, f.low, f.close, f.volume::bigint AS volume,
            f.amount, f.source
     FROM kline_raw f
     WHERE f.code = $1 AND ($2::timestamptz IS NULL OR f.ts < $2)
       AND NOT EXISTS (SELECT 1 FROM kline_accurate a
                       WHERE a.code = f.code AND a.ts = f.ts AND a.period = 'M1')
     ORDER BY f.ts DESC LIMIT $3)
) m
ORDER BY ts DESC LIMIT $3
"#;

/// 统一读源：accurate(优先) UNION ALL 兜底(反连接剔重)。
/// - accurate 分支：`{accurate}` 表（0010 cagg；D1 复用 kline_accurate_1d），覆盖全历史 2012+；
///   5m/15m/1h（0017）与 1w/1mo（0016）均全量（无 2024 过滤），pre-2024 也走 accurate。
///   source 记为 'tushare'（与 kline_merged M1 的 accurate 分支一致）。
/// - 兜底分支：`{fallback}`（表名或 1h rollup 片段），与 accurate 同 ts 的存在时被反连接剔重。
/// - cagg 无 source 列（以 NULL 归一行型）；volume 为 numeric → ::bigint。
///
/// 表名/片段只经 KlineRead::bars 内部 match 映射常量传入，不接受外部输入（无注入面）。
fn merged_sql(accurate: &str, fallback: &str) -> String {
    format!(r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM (
    SELECT code, ts, open, high, low, close, volume::bigint AS volume, amount, 'tushare'::text AS source
    FROM {accurate}
    WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
    UNION ALL
    SELECT f.code, f.ts, f.open, f.high, f.low, f.close, f.volume::bigint AS volume, f.amount, NULL::text AS source
    FROM {fallback} f
    WHERE f.code = $1 AND ($2::timestamptz IS NULL OR f.ts < $2)
      AND NOT EXISTS (SELECT 1 FROM {accurate} a WHERE a.code = f.code AND a.ts = f.ts)
) m
ORDER BY ts DESC LIMIT $3
"#, accurate = accurate, fallback = fallback)
}

/// 1h 兜底：kline_15m 查询期 rollup（schema 未建 kline_1h cagg；first/last 为 timescaledb 聚合）。
/// bucket ts = time_bucket 起点；before 过滤在桶级（与 accurate_1h 桶对齐后作反连接剔重）。
const FALLBACK_1H: &str = r#"
(SELECT code, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_15m GROUP BY code, time_bucket('1 hour', ts))"#;

/// 周线 W1 兜底：kline_1d 查询期 rollup（schema 未建 kline_1w cagg；与 accurate_1w 同 time_bucket 对齐）。
/// 周=A股交易周（Asia/Shanghai 周一为界，time_bucket 三参形式）；first/last 为 timescaledb 聚合。
const FALLBACK_1W: &str = r#"
(SELECT code, time_bucket('1 week', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_1d GROUP BY code, time_bucket('1 week', ts, 'Asia/Shanghai'))"#;

/// 月线 MO1 兜底：kline_1d 查询期 rollup（schema 未建 kline_1mo cagg；与 accurate_1mo 同 time_bucket 对齐）。
/// 月=自然月（Asia/Shanghai 月界，time_bucket 三参形式）；first/last 为 timescaledb 聚合。
const FALLBACK_1MO: &str = r#"
(SELECT code, time_bucket('1 month', ts, 'Asia/Shanghai') AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount
 FROM kline_1d GROUP BY code, time_bucket('1 month', ts, 'Asia/Shanghai'))"#;

/// 周期 → 统一读源 SQL（1m 用 MERGED_1M_SQL 双侧索引 DESC LIMIT 合并；其余按 accurate 表 + 兜底片段）。
fn period_merged_sql(p: Period) -> String {
    match p {
        Period::M1 => MERGED_1M_SQL.to_string(),
        Period::M5 => merged_sql("kline_accurate_5m", "kline_5m"),
        Period::M15 => merged_sql("kline_accurate_15m", "kline_15m"),
        Period::H1 => merged_sql("kline_accurate_1h", FALLBACK_1H),
        Period::D1 => merged_sql("kline_accurate_1d", "kline_1d"),
        Period::W1 => merged_sql("kline_accurate_1w", FALLBACK_1W),
        Period::MO1 => merged_sql("kline_accurate_1mo", FALLBACK_1MO),
    }
}

/// 当前 forming（未闭合）桶聚合 SQL：从 kline_raw 实时聚合周期桶，供 live 图表右缘随最新 raw 1m 前进。
/// 仅对日内周期 M5/M15/H1 生效（D1/W1/MO1 由既有 cagg/rollup 承载其闭合桶）；非日内周期返回 None。
/// bucket 用 `time_bucket(interval, now())`——只产**当前**未闭合桶（≤1 行）；`source` 记 NULL（与兜底分支同型）。
fn forming_sql(period: Period) -> Option<String> {
    let interval = match period {
        Period::M5 => "5 minutes",
        Period::M15 => "15 minutes",
        Period::H1 => "1 hour",
        _ => return None,
    };
    Some(format!(r#"
SELECT code, time_bucket('{interval}', ts) AS ts,
       first(open, ts) AS open, max(high) AS high, min(low) AS low,
       last(close, ts) AS close, sum(volume)::bigint AS volume, sum(amount) AS amount,
       NULL::text AS source
FROM kline_raw
WHERE code = $1 AND ts >= time_bucket('{interval}', now())
GROUP BY code, time_bucket('{interval}', ts)
"#, interval = interval))
}

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

    /// 当前 forming（未闭合）桶：仅 M5/M15/H1 由 forming_sql 从最新 raw 1m 聚合（≤1 行）；其余无。
    async fn forming_bar(&self, period: Period, code: &str) -> Result<Option<KlineBarView>> {
        let Some(sql) = forming_sql(period) else { return Ok(None); };
        let rows: Vec<BarTuple> = sqlx::query_as(&sql).bind(code).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(
            |(code, ts, open, high, low, close, volume, amount, source)|
            KlineBarView { code, ts, open, high, low, close, volume, amount, source }
        ).next())
    }
}

#[async_trait]
impl KlineRead for KlineReader {
    /// ts < before（None=最新起），降序取 limit 行后翻转**升序**返回（图表口径）。
    async fn bars(&self, period: Period, code: &str,
                  before: Option<DateTime<Utc>>, limit: i64) -> Result<Vec<KlineBarView>> {
        let sql = period_merged_sql(period);
        let rows: Vec<BarTuple> = sqlx::query_as(&sql)
            .bind(code).bind(before).bind(limit)
            .fetch_all(&self.pool).await?;
        let mut bars: Vec<KlineBarView> = rows.into_iter().map(
            |(code, ts, open, high, low, close, volume, amount, source)|
            KlineBarView { code, ts, open, high, low, close, volume, amount, source }
        ).collect();
        bars.reverse();
        // 实时右缘：latest 查询（before=None 且 limit>0）合入当前 forming 桶（若存在且更新于已返回最后一根）。
        // - 更新（f.ts > 末根.ts）：剔除最旧一根保 limit，末根追加 f；
        // - 相同（f.ts == 末根.ts）：f 覆盖 cagg/rollup 的陈旧/部分桶（如 1h rollup 未闭合窗）。
        if before.is_none() && limit > 0 {
            if let Some(f) = self.forming_bar(period, code).await? {
                let last_ts = bars.last().map(|b| b.ts);
                if last_ts.is_none_or(|t| f.ts > t) {
                    if bars.len() as i64 >= limit {
                        bars.remove(0);
                    }
                    bars.push(f);
                } else if last_ts == Some(f.ts) {
                    *bars.last_mut().expect("non-empty") = f;
                }
            }
        }
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
