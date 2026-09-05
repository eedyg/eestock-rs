// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/diagnose/src/lib.rs>>[init]
//! diagnose —— 应用层：健康指标聚合查询（读 source_health_events，03 §7 / 05 §1 口径）
//! 与数据质量服务（Wave 2 Phase A：raw vs accurate 对照 + 交易日历驱动缺口报告，本节 §2.1）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

/// crate 编译时版本（settings 页 system-info 展示；由 app 装配 CrateVersions）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod health;
pub mod quality;
// ~/~ end
