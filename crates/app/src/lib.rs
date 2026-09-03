// ~/~ begin <<design/03-collector/02-data-plane.md#crates/app/src/lib.rs>>[init]
//! app —— 二进制装配：DI 组装、配置加载、进程入口（ADR-017 双面分离）。
//! 由 design/03-collector/02-data-plane.md tangle 生成（ADR-007），禁止手改。

// app_config：应用面（eestock-app）配置（Wave 1 Phase A 加法扩展；代码块在 design/07-app-plane/00-web-api.md）
pub mod app_config;
pub mod config;
pub mod healthz;
// ~/~ end
