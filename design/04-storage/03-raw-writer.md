# 04-storage/03 — raw 层写入 + 事件落库 + 启动自检

> 本文档 tangle 生成 `crates/storage/src/{kline,events,migrate_check}.rs` 与对应集成测试。
> 决策依据：ADR-002（首写胜出）、03 §7（事件模型）、ADR-017（数据面启动自检）。
> lib.rs 模块声明在 02-tushare-sync.md 的 lib.rs 代码块统一维护。

## 1. KlineWriter（kline_raw，首写胜出）

- `INSERT ... ON CONFLICT (code,ts) DO NOTHING`，返回**实际插入行数**（冲突跳过不计，调度层据此观测去重）。
- source 列文本口径 = `SourceId::as_str()`（含 `*_approx` 降级标记，03 §6）。
- 集成测试断言行数：同 (code,ts) 二次写入返回 0 且原值不变（首写胜出）。

``` {.rust file=crates/storage/src/kline.rs}
//! raw 层（kline_raw）写入：ON CONFLICT DO NOTHING（首写胜出，ADR-002）。

use anyhow::Result;
use domain::ports::KlineWriter;
use domain::types::Bar;
use sqlx::PgPool;

pub struct RawKlineWriter {
    pool: PgPool,
}

impl RawKlineWriter {
    pub fn new(pool: PgPool) -> Self { Self { pool } }

    /// crate 内共享连接池（RawBarReader 实现在 symbols.rs）。
    pub(crate) fn pool(&self) -> &PgPool { &self.pool }
}

#[async_trait::async_trait]
impl KlineWriter for RawKlineWriter {
    /// 返回实际插入行数（首写胜出：冲突行跳过不计）。
    async fn write_batch(&self, bars: &[Bar]) -> Result<usize> {
        if bars.is_empty() { return Ok(0); }
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) ");
        qb.push_values(bars.iter(), |mut b, bar| {
            b.push_bind(bar.code.0.clone())
             .push_bind(bar.ts)
             .push_bind(bar.open)
             .push_bind(bar.high)
             .push_bind(bar.low)
             .push_bind(bar.close)
             .push_bind(bar.volume as i64)
             .push_bind(bar.amount)
             .push_bind(bar.source.as_str()); // 含 *_approx 降级标记（03 §6）
        });
        qb.push(" ON CONFLICT (code, ts) DO NOTHING");
        let res = qb.build().execute(&self.pool).await?;
        Ok(res.rows_affected() as usize)
    }
}
```

## 2. EventSink（source_health_events，03 §7 事件模型）

- 列口径：ts/source/ok/latency_ms/err_kind/code；`trace_id` 随事件对象贯穿日志（tracing span），
  不落表（schema 无此列；诊断面板查询维度不含 trace，05 §1）。

``` {.rust file=crates/storage/src/events.rs}
//! 事件落库：source_health_events（诊断系统数据源，03 §7）。

use anyhow::Result;
use domain::ports::{EventSink, HealthEvent};
use sqlx::PgPool;

pub struct PgEventSink {
    pool: PgPool,
}

impl PgEventSink {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait::async_trait]
impl EventSink for PgEventSink {
    async fn emit(&self, ev: HealthEvent) -> Result<()> {
        sqlx::query(
            "INSERT INTO source_health_events (ts, source, ok, latency_ms, err_kind, code) \
             VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(ev.ts)
            .bind(ev.source.as_str())
            .bind(ev.ok)
            .bind(ev.latency_ms.map(|x| x as i32))
            .bind(ev.err_kind.map(|k| k.as_str()))
            .bind(ev.code.map(|c| c.0))
            .execute(&self.pool).await?;
        Ok(())
    }
}
```

## 3. 启动自检（ADR-017：sqlx migrate 自检的落地口径）

背景约束：`migrations/0001–0006` 由 compose initdb 在空卷首次启动时执行（02 §2 注记：
之后不再享受免费 initdb），库上无 `_sqlx_migrations` 台账，sqlx migrate 无法直接重放。
因此 Wave 0 启动自检落地为**关键关系 + hypertable 存在性校验**（缺任一并列明缺失项、拒绝启动）；
0007+ 迁移的台账化接入随首个增量迁移一并设计（Wave 1 边界，见 wave-0.md「明确不做」无冲突）。

``` {.rust file=crates/storage/src/migrate_check.rs}
//! 启动 schema 自检：关键关系与 hypertable 存在性校验（ADR-017）。

use anyhow::{anyhow, Result};
use sqlx::PgPool;

/// 0001–0009 应存在的关系（表/视图/连续聚合）。
pub const EXPECTED_RELATIONS: &[&str] = &[
    "kline_raw", "kline_accurate", "symbols", "source_health_events",
    "metrics", "chip_distribution", "share_float", "sync_checkpoints",
    "kline_merged", "kline_5m", "kline_15m", "kline_1d", "kline_accurate_1d",
    // Wave 3 (0010)：统一读源 accurate 连续聚合（5m/15m/1h；D1 复用 kline_accurate_1d）
    "kline_accurate_5m", "kline_accurate_15m", "kline_accurate_1h",
    // Wave 1 Phase C 加法：熔断复位 DB 控制通道表（0007）
    "circuit_reset_requests",
    // Wave 2 Phase A 加法：交易日历节假日表（0008；数据面 collector 日历读 + 应用面质量报告共用）
    "holidays",
    // Wave 2 Phase B 加法：告警引擎表（0009；应用面自有，数据面不读写）
    "alert_rules", "alert_events",
    // Wave 3 (0011-0019)：回测/收藏/MA配置/模拟实盘 应用面表
    "backtest_runs", "backtest_results",
    "favorite_symbols",
    "ma_config",
    // 页面⑧ 系统设置 S2：配置持久化（app_config 表，0021）
    "app_config",
    "simsession", "simsession_result", "sim_trades", "sim_positions", "simsession_state",
    // 12-strategy-system / P2a：Strategy Registry 表（0022；应用面自有）
    "strategy", "strategy_version",
    // 12-strategy-system / P3a：回测工作台表（0023；应用面自有）
    "strategy_run", "strategy_run_result", "strategy_preset",
];

/// 应为 hypertable 的表。
pub const EXPECTED_HYPERTABLES: &[&str] = &[
    "kline_raw", "kline_accurate", "source_health_events", "metrics",
];

/// 返回 expected 中缺失的关系名（空 = 齐全）。
pub async fn missing_relations(pool: &PgPool, expected: &[&str]) -> Result<Vec<String>> {
    let rows: Vec<(String, bool)> = sqlx::query_as(
        "SELECT name, to_regclass(format('public.%I', name)) IS NOT NULL \
         FROM unnest($1::text[]) AS name")
        .bind(expected).fetch_all(pool).await?;
    Ok(rows.into_iter().filter(|(_, ok)| !ok).map(|(n, _)| n).collect())
}

/// 返回 expected 中非 hypertable 的表名（空 = 齐全）。
pub async fn missing_hypertables(pool: &PgPool, expected: &[&str]) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT hypertable_name FROM timescaledb_information.hypertables")
        .fetch_all(pool).await?;
    let have: std::collections::HashSet<String> = rows.into_iter().map(|r| r.0).collect();
    Ok(expected.iter().filter(|t| !have.contains(**t)).map(|s| s.to_string()).collect())
}

/// 启动自检入口：任一缺失 → Err（列出全部缺失项）。
pub async fn verify_schema(pool: &PgPool) -> Result<()> {
    let miss_rel = missing_relations(pool, EXPECTED_RELATIONS).await?;
    let miss_hyper = missing_hypertables(pool, EXPECTED_HYPERTABLES).await?;
    if !miss_rel.is_empty() || !miss_hyper.is_empty() {
        return Err(anyhow!(
            "schema 自检失败：缺失关系 {miss_rel:?}；非 hypertable {miss_hyper:?}（migrations 0001-0009 未落库）"));
    }
    Ok(())
}
```

## 4. 集成测试（需 TimescaleDB :5433，与 accurate_upsert.rs 同口径）

``` {.rust file=crates/storage/tests/raw_writer.rs}
//! raw 层首写胜出 + approx 标记集成测试（需 TimescaleDB :5433）。

use chrono::{TimeZone, Utc};
use domain::ports::KlineWriter;
use domain::types::*;
use sqlx::PgPool;
use storage::kline::RawKlineWriter;

fn bar(code: &str, close: f64, src: SourceId) -> Bar {
    Bar {
        code: Code(code.into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap(),
        open: 1.0, high: 1.0, low: 1.0, close, volume: 100, amount: 100.0,
        source: src,
    }
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

#[tokio::test]
async fn first_write_wins_and_row_count_asserted() {
    let pool = pool().await;
    let w = RawKlineWriter::new(pool.clone());
    let n1 = w.write_batch(&[bar("999998", 1.0, SourceId::TencentIfzq)]).await.unwrap();
    assert_eq!(n1, 1, "首写入 1 行");
    let n2 = w.write_batch(&[bar("999998", 2.0, SourceId::SinaJsonp)]).await.unwrap();
    assert_eq!(n2, 0, "同 (code,ts) 二次写入 0 行（首写胜出）");
    let (close, source): (f64, String) = sqlx::query_as(
        "SELECT close, source FROM kline_raw WHERE code='999998'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(close, 1.0, "原值不被覆盖");
    assert_eq!(source, "tencent_ifzq");
    sqlx::query("DELETE FROM kline_raw WHERE code='999998'").execute(&pool).await.unwrap();
}

#[tokio::test]
async fn approx_source_marker_persisted() {
    let pool = pool().await;
    let w = RawKlineWriter::new(pool.clone());
    // 与首写胜出测试不同 code：cargo 测试并行，按 code 隔离
    w.write_batch(&[bar("999997", 1.5, SourceId::TencentQtApprox)]).await.unwrap();
    let (source,): (String,) = sqlx::query_as(
        "SELECT source FROM kline_raw WHERE code='999997'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(source, "tencent_qt_approx", "03 §6：降级模式近似 bar 与真实 bar 物理可区分");
    sqlx::query("DELETE FROM kline_raw WHERE code='999997'").execute(&pool).await.unwrap();
}

#[tokio::test]
async fn empty_batch_writes_zero() {
    let w = RawKlineWriter::new(pool().await);
    assert_eq!(w.write_batch(&[]).await.unwrap(), 0);
}
```

``` {.rust file=crates/storage/tests/event_sink.rs}
//! EventSink 落库 + 启动自检集成测试（需 TimescaleDB :5433）。

use chrono::{TimeZone, Utc};
use domain::ports::{ErrKind, EventSink, HealthEvent};
use domain::types::*;
use sqlx::PgPool;
use storage::events::PgEventSink;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

#[tokio::test]
async fn event_roundtrip_na_and_circuit_kinds() {
    let pool = pool().await;
    let sink = PgEventSink::new(pool.clone());
    let ts = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap();
    // 03 §7：非交易时段 ok=true + err_kind=na（成功率分母排除）
    sink.emit(HealthEvent {
        ts, source: SourceId::TencentIfzq, ok: true, latency_ms: None,
        err_kind: Some(ErrKind::Na), code: Some(Code("999998".into())), trace_id: None,
    }).await.unwrap();
    // 熔断迁移事件
    sink.emit(HealthEvent {
        ts, source: SourceId::TencentIfzq, ok: false, latency_ms: None,
        err_kind: Some(ErrKind::CircuitOpen), code: None, trace_id: None,
    }).await.unwrap();
    let rows: Vec<(bool, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT ok, err_kind, code FROM source_health_events \
         WHERE ts=$1 AND source='tencent_ifzq' ORDER BY ok DESC")
        .bind(ts).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], (true, Some("na".into()), Some("999998".into())));
    assert_eq!(rows[1], (false, Some("circuit_open".into()), None));
    sqlx::query("DELETE FROM source_health_events WHERE ts=$1").bind(ts)
        .execute(&pool).await.unwrap();
}

#[tokio::test]
async fn verify_schema_passes_on_migrated_db() {
    let pool = pool().await;
    storage::migrate_check::verify_schema(&pool).await.expect("0001-0006 已落库");
}

#[tokio::test]
async fn missing_relations_detected() {
    let pool = pool().await;
    let miss = storage::migrate_check::missing_relations(
        &pool, &["kline_raw", "definitely_not_a_table"]).await.unwrap();
    assert_eq!(miss, vec!["definitely_not_a_table".to_string()]);
}
```

## 5. SymbolRegistry 与 RawBarReader（symbols 表 = 采集配置，ADR-017 控制通道）

``` {.rust file=crates/storage/src/symbols.rs}
//! symbols 表读写：标注册表端口实现（Scheduler 每周期重读热生效）+ raw 已有 ts 读取。

use anyhow::Result;
use chrono::{DateTime, NaiveDate, Utc};
use domain::ports::{RawBarReader, SymbolRegistry};
use domain::types::Code;
use sqlx::PgPool;
use std::collections::HashSet;

pub struct PgSymbolRegistry {
    pool: PgPool,
}

impl PgSymbolRegistry {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait::async_trait]
impl SymbolRegistry for PgSymbolRegistry {
    async fn enabled_codes(&self) -> Result<Vec<Code>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT code FROM symbols WHERE enabled ORDER BY code")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(c,)| Code(c)).collect())
    }

    async fn interval_secs(&self, code: &Code) -> Result<u64> {
        let row: Option<(i32,)> = sqlx::query_as(
            "SELECT interval_secs FROM symbols WHERE code = $1")
            .bind(&code.0).fetch_optional(&self.pool).await?;
        Ok(row.map(|r| r.0 as u64).unwrap_or(60))
    }

    async fn upsert(&self, code: Code, interval_secs: u64, enabled: bool) -> Result<()> {
        sqlx::query(
            "INSERT INTO symbols (code, interval_secs, enabled) VALUES ($1, $2, $3)              ON CONFLICT (code) DO UPDATE SET interval_secs = EXCLUDED.interval_secs,                 enabled = EXCLUDED.enabled")
            .bind(&code.0).bind(interval_secs as i32).bind(enabled)
            .execute(&self.pool).await?;
        Ok(())
    }
}

/// RawBarReader 实现挂在 RawKlineWriter 上（同表同连接池）。
#[async_trait::async_trait]
impl RawBarReader for crate::kline::RawKlineWriter {
    /// 某 code 某日（Asia/Shanghai 口径）kline_raw 已有 ts 集合。
    async fn existing_ts(&self, code: &Code, date: NaiveDate) -> Result<HashSet<DateTime<Utc>>> {
        // 日界按交易所时区（kline_1d 同口径）：[date 00:00 +8, 次日 00:00 +8)
        let start = domain::tz::cst_to_utc(date.and_hms_opt(0, 0, 0).expect("valid hms"));
        let end = domain::tz::cst_to_utc((date + chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0).expect("valid hms"));
        let rows: Vec<(DateTime<Utc>,)> = sqlx::query_as(
            "SELECT ts FROM kline_raw WHERE code = $1 AND ts >= $2 AND ts < $3")
            .bind(&code.0).bind(start).bind(end)
            .fetch_all(self.pool()).await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }
}
```

``` {.rust file=crates/storage/tests/symbols_registry.rs}
//! SymbolRegistry / RawBarReader 集成测试（需 TimescaleDB :5433）。

use chrono::{NaiveDate, TimeZone, Utc};
use domain::ports::{KlineWriter, RawBarReader, SymbolRegistry};
use domain::types::*;
use sqlx::PgPool;
use storage::kline::RawKlineWriter;
use storage::symbols::PgSymbolRegistry;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

#[tokio::test]
async fn symbols_upsert_read_disable() {
    let pool = pool().await;
    let reg = PgSymbolRegistry::new(pool.clone());
    let code = Code("999996".into());
    reg.upsert(code.clone(), 120, true).await.unwrap();
    assert_eq!(reg.interval_secs(&code).await.unwrap(), 120);
    assert!(reg.enabled_codes().await.unwrap().contains(&code));
    // 热生效语义：改间隔 + 禁用立即反映
    reg.upsert(code.clone(), 60, false).await.unwrap();
    assert_eq!(reg.interval_secs(&code).await.unwrap(), 60);
    assert!(!reg.enabled_codes().await.unwrap().contains(&code));
    sqlx::query("DELETE FROM symbols WHERE code='999996'").execute(&pool).await.unwrap();
}

#[tokio::test]
async fn existing_ts_returns_written_bars_cst_day() {
    let pool = pool().await;
    let w = RawKlineWriter::new(pool.clone());
    // 2026-09-03 09:30 CST = 01:30 UTC；同日 23:30 CST = 15:30 UTC 仍属当日
    for (h, mi) in [(1u32, 30u32), (15, 30)] {
        w.write_batch(&[Bar {
            code: Code("999996".into()), period: Period::M1,
            ts: Utc.with_ymd_and_hms(2026, 9, 3, h, mi, 0).unwrap(),
            open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
            source: SourceId::TencentIfzq,
        }]).await.unwrap();
    }
    let date = NaiveDate::from_ymd_opt(2026, 9, 3).unwrap();
    let ts = w.existing_ts(&Code("999996".into()), date).await.unwrap();
    assert_eq!(ts.len(), 2, "CST 日界口径（次日 00:00 +8 前均当日）");
    let next_day = w.existing_ts(&Code("999996".into()),
        NaiveDate::from_ymd_opt(2026, 9, 4).unwrap()).await.unwrap();
    assert!(next_day.is_empty());
    sqlx::query("DELETE FROM kline_raw WHERE code='999996'").execute(&pool).await.unwrap();
}
```
