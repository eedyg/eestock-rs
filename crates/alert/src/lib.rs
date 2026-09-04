// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/alert/src/lib.rs>>[init]
//! alert —— 应用层：告警引擎（规则评估 + 生命周期状态机；端口注入，不依赖 sqlx）。
//! 由 design/07-app-plane/02-alerts.md tangle 生成（ADR-007），禁止手改。

pub mod engine;
pub mod rules;
// ~/~ end
