// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/storage/src/lib.rs>>[init]
//! storage —— 基础设施：TimescaleDB 读写（sqlx）。
//! 由 design/04-storage/*.md tangle 生成（ADR-007），禁止手改。

pub mod accurate;
pub mod events;
pub mod kline;
pub mod migrate_check;
pub mod symbols;
// ~/~ end
