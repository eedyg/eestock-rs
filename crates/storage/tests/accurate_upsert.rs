// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/storage/tests/accurate_upsert.rs>>[init]
//! 准确层 upsert 语义集成测试（需 TimescaleDB :5433，设计意图锁定）：
//! 准确层允许 tushare 修正覆盖（DO UPDATE），与 raw 层首写胜出（DO NOTHING）相反。

use chrono::{TimeZone, Utc};
use domain::types::*;
use sqlx::PgPool;
use storage::accurate::{period_str, AccurateWriter};

fn bar(close: f64) -> Bar {
    Bar {
        code: Code("999999".into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2025, 8, 1, 1, 30, 0).unwrap(),
        open: 1.0, high: 1.0, low: 1.0, close, volume: 100, amount: 100.0,
        source: SourceId::Tushare,
    }
}

#[tokio::test]
async fn conflict_updates_row_not_keeps_first() {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    let pool = PgPool::connect(&url).await.expect("TimescaleDB :5433 可用");
    let w = AccurateWriter::new(pool.clone());

    w.upsert_batch(&[bar(1.0)]).await.unwrap();
    w.upsert_batch(&[bar(2.0)]).await.unwrap(); // 修正覆盖

    let (cnt, close): (i64, f64) = sqlx::query_as(
        "SELECT COUNT(*), MAX(close) FROM kline_accurate WHERE code='999999' AND period='M1'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1, "同键不重复落行");
    assert_eq!(close, 2.0, "准确层后写覆盖先写（修正语义）");

    sqlx::query("DELETE FROM kline_accurate WHERE code='999999'")
        .execute(&pool).await.unwrap();
}

#[tokio::test]
async fn checkpoints_roundtrip() {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    let pool = PgPool::connect(&url).await.unwrap();
    let d = chrono::NaiveDate::from_ymd_opt(2025, 8, 1).unwrap();
    assert_eq!(storage::accurate::get_checkpoint(&pool, "999999", "M1").await.unwrap(), None);
    storage::accurate::set_checkpoint(&pool, "999999", "M1", d).await.unwrap();
    assert_eq!(storage::accurate::get_checkpoint(&pool, "999999", "M1").await.unwrap(), Some(d));
    let d2 = chrono::NaiveDate::from_ymd_opt(2025, 8, 15).unwrap();
    storage::accurate::set_checkpoint(&pool, "999999", "M1", d2).await.unwrap();
    assert_eq!(storage::accurate::get_checkpoint(&pool, "999999", "M1").await.unwrap(), Some(d2),
        "checkpoint 可推进（upsert）");
    sqlx::query("DELETE FROM sync_checkpoints WHERE code='999999'")
        .execute(&pool).await.unwrap();
    assert_eq!(period_str(Period::M1), "M1");
}
// ~/~ end
