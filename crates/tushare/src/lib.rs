// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/src/lib.rs>>[init]
//! tushare —— 基础设施：tushare 客户端（HistoricalDataProvider）+ 准确层同步编排。
//! 由 design/04-storage/02-tushare-sync.md tangle 生成（ADR-007），禁止手改。

pub mod client;
pub mod daily;
pub mod parse;
pub mod sync;
// ~/~ end
