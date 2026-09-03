// ~/~ begin <<design/04-storage/03-raw-writer.md#crates/storage/src/events.rs>>[init]
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
// ~/~ end
