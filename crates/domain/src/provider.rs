// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/provider.rs>>[init]
//! Provider trait：每个数据源一个适配器（Infrastructure 层）。
//! 约束：GBK 解码、字段单位换算、限频（token bucket）均在适配器内部完成。

use crate::types::*;
use async_trait::async_trait;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("http: {0}")]
    Http(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("rate limited (403/429)")]
    RateLimited,
    #[error("timeout")]
    Timeout,
    #[error("no data (非交易时段/标的无数据)")]
    NoData,
}

#[async_trait]
pub trait MinuteKlineProvider: Send + Sync {
    fn id(&self) -> SourceId;
    /// 拉取最近若干根 1m bar。免费源物理上限：腾讯≈2天/新浪≈8天（ADR-004）。
    async fn fetch_m1(&self, code: &Code, limit: usize) -> Result<Vec<Bar>, ProviderError>;
}

#[async_trait]
pub trait SnapshotProvider: Send + Sync {
    fn id(&self) -> SourceId;
    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError>;
}

/// ADR-016：历史数据 Provider（tushare 等）。与实时层解耦：
/// 实时层喂 kline_raw（日内增量），历史层喂 kline_accurate（准确层回填）。
#[async_trait]
pub trait HistoricalDataProvider: Send + Sync {
    fn id(&self) -> SourceId;
    /// 拉取 [start, end]（闭区间，UTC）内指定周期 K线，按 ts 升序。
    async fn fetch_history(&self, code: &Code, period: Period,
                           start: DateTime<Utc>, end: DateTime<Utc>)
                           -> Result<Vec<Bar>, ProviderError>;
    /// 该源支持的周期（tushare：M1/M5/M15/H1/D1，视账户档位，启动时探测）
    fn supported_periods(&self) -> Vec<Period>;
}
// ~/~ end
