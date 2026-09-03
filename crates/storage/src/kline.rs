// ~/~ begin <<design/04-storage/03-raw-writer.md#crates/storage/src/kline.rs>>[init]
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
// ~/~ end
