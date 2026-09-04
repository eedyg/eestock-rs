// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/lib.rs>>[init]
//! mcp —— Presentation：MCP HTTP/SSE 常驻服务（ADR-009 范围①②：行情查询 + 源健康；
//! Wave 2 Phase A 加法：范围④ 数据质量 get_data_quality）。
//! 由 design/07-app-plane/01-mcp.md tangle 生成（ADR-007），禁止手改。

pub mod rpc;
pub mod server;
pub mod state;
pub mod tools;

#[cfg(test)]
pub(crate) mod mocks;
// ~/~ end
