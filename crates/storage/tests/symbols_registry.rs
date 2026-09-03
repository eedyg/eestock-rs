// ~/~ begin <<design/04-storage/03-raw-writer.md#crates/storage/tests/symbols_registry.rs>>[init]
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
// ~/~ end
