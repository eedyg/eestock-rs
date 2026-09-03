// ~/~ begin <<design/03-collector/01-providers-spec.md#crates/providers/src/lib.rs>>[init]
//! providers —— 基础设施：各数据源 HTTP 适配器（domain::provider trait 实现）。
//! 由 design/03-collector/01-providers-spec.md tangle 生成（ADR-007），禁止手改。

pub mod exchange;
pub mod http;
pub mod push2delay;
pub mod sina_hq;
pub mod sina_jsonp;
pub mod tencent_ifzq;
pub mod tencent_qt;
pub mod ths_cs;
// ~/~ end
