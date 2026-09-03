// ~/~ begin <<design/04-storage/03-raw-writer.md#crates/storage/tests/event_sink.rs>>[init]
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
// ~/~ end
