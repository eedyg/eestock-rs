// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/lib.rs>>[init]
//! collector —— 应用层：采集调度、源选取状态机、熔断、缺口回填、降级模式。
//! 由 design/03-collector/00-design.md tangle 生成（ADR-007），禁止手改。

pub mod calendar;
pub mod circuit;
pub mod clock;
pub mod executor;
pub mod gapfill;
pub mod scheduler;
pub mod service;
pub mod standby;
// ~/~ end
