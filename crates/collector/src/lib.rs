// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/lib.rs>>[init]
//! collector —— 应用层：采集调度、源选取状态机、熔断、缺口回填、降级模式。
//! 由 design/03-collector/00-design.md tangle 生成（ADR-007），禁止手改。

/// crate 编译时版本（settings 页 system-info 展示；由 app 装配 CrateVersions）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod calendar;
pub mod circuit;
pub mod clock;
pub mod executor;
pub mod gapfill;
pub mod probe;
// reset：熔断复位 DB 控制通道消费端（Wave 1 Phase C 加法扩展，§10；数据面零既有逻辑改动）
pub mod reset;
pub mod scheduler;
pub mod service;
pub mod standby;
// ~/~ end
