// ~/~ begin <<design/04-storage/03-raw-writer.md#crates/storage/tests/raw_writer.rs>>[init]
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
// ~/~ end
