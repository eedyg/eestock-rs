// ~/~ begin <<design/04-storage/03-raw-writer.md#crates/storage/src/symbols.rs>>[init]
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
// ~/~ end
