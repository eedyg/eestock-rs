// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/storage/src/accurate.rs>>[init]
//! 准确层（kline_accurate）写入：ON CONFLICT DO UPDATE（修正覆盖语义）。

use anyhow::Result;
use chrono::NaiveDate;
use domain::types::*;
use sqlx::PgPool;

pub struct AccurateWriter {
    pool: PgPool,
}

pub fn period_str(p: Period) -> &'static str {
    match p { Period::M1 => "M1", Period::M5 => "M5", Period::M15 => "M15",
              Period::H1 => "H1", Period::D1 => "D1" }
}

// source 列文本口径单一事实源在 domain（SourceId::as_str，含 *_approx 变体）。

impl AccurateWriter {
    pub fn new(pool: PgPool) -> Self { Self { pool } }

    /// 批量 upsert：冲突（code,ts,period）覆盖 OHLCV 与 synced_at。返回受影响行数。
    pub async fn upsert_batch(&self, bars: &[Bar]) -> Result<u64> {
        if bars.is_empty() { return Ok(0); }
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO kline_accurate \
             (code, ts, period, open, high, low, close, volume, amount, source) ");
        qb.push_values(bars.iter(), |mut b, bar| {
            b.push_bind(bar.code.0.clone())
             .push_bind(bar.ts)
             .push_bind(period_str(bar.period))
             .push_bind(bar.open)
             .push_bind(bar.high)
             .push_bind(bar.low)
             .push_bind(bar.close)
             .push_bind(bar.volume as i64)
             .push_bind(bar.amount)
             .push_bind(bar.source.as_str());
        });
        qb.push(" ON CONFLICT (code, ts, period) DO UPDATE SET \
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, \
            close = EXCLUDED.close, volume = EXCLUDED.volume, \
            amount = EXCLUDED.amount, source = EXCLUDED.source, \
            synced_at = now()");
        let res = qb.build().execute(&self.pool).await?;
        Ok(res.rows_affected())
    }
}

/// 断点续传检查点读写。
pub async fn get_checkpoint(pool: &PgPool, code: &str, period: &str) -> Result<Option<NaiveDate>> {
    let row: Option<(NaiveDate,)> = sqlx::query_as(
        "SELECT last_synced_date FROM sync_checkpoints WHERE code = $1 AND period = $2")
        .bind(code).bind(period).fetch_optional(pool).await?;
    Ok(row.map(|r| r.0))
}

pub async fn set_checkpoint(pool: &PgPool, code: &str, period: &str, date: NaiveDate) -> Result<()> {
    sqlx::query(
        "INSERT INTO sync_checkpoints (code, period, last_synced_date) VALUES ($1, $2, $3) \
         ON CONFLICT (code, period) DO UPDATE SET \
            last_synced_date = EXCLUDED.last_synced_date, updated_at = now()")
        .bind(code).bind(period).bind(date).execute(pool).await?;
    Ok(())
}
// ~/~ end
