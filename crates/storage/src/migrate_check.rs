// ~/~ begin <<design/04-storage/03-raw-writer.md#crates/storage/src/migrate_check.rs>>[init]
//! 启动 schema 自检：关键关系与 hypertable 存在性校验（ADR-017）。

use anyhow::{anyhow, Result};
use sqlx::PgPool;

/// 0001–0006 应存在的关系（表/视图/连续聚合）。
pub const EXPECTED_RELATIONS: &[&str] = &[
    "kline_raw", "kline_accurate", "symbols", "source_health_events",
    "metrics", "chip_distribution", "share_float", "sync_checkpoints",
    "kline_merged", "kline_5m", "kline_15m", "kline_1d", "kline_accurate_1d",
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
            "schema 自检失败：缺失关系 {miss_rel:?}；非 hypertable {miss_hyper:?}（migrations 0001-0006 未落库）"));
    }
    Ok(())
}
// ~/~ end
