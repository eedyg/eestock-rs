// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/rpc.rs>>[init]
//! MCP JSON-RPC 2.0 协议帧分发（spec 2024-11-05 口径）：
//! initialize / ping / tools/list / tools/call；通知无响应；未知方法 -32601。
//! 纯分发层（可离线 TDD）：输入 RpcRequest、输出 Option<Value>（通知 → None）；HTTP/SSE 传输在 server.rs。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::McpState;

/// MCP 协议版本（ADR-009 SSE transport 口径；Streamable HTTP 迁移列 Wave 2 评估，99-decisions-log）。
pub const PROTOCOL_VERSION: &str = "2024-11-05";
pub const SERVER_NAME: &str = "eestock-mcp";

pub const PARSE_ERROR: i64 = -32700;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

/// JSON-RPC 请求帧（jsonrpc 字段容忍缺省——免认证内网 ADR-010，宽容解析；坏帧由 server 层 -32700）。
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

/// 成功响应帧（echo id；id=None → null——仅用于解析失败等无 id 可得场景）。
pub fn result_ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 错误响应帧（JSON-RPC 标准错误码）。
pub fn result_err(id: Option<Value>, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// 协议分发：通知（notifications/* 或无 id 帧）→ None；未知方法 → -32601。
pub async fn dispatch(st: &McpState, req: &RpcRequest) -> Option<Value> {
    if req.method.starts_with("notifications/") || req.id.is_none() {
        return None;
    }
    match req.method.as_str() {
        "initialize" => Some(result_ok(req.id.clone(), json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        }))),
        "ping" => Some(result_ok(req.id.clone(), json!({}))),
        "tools/list" => Some(result_ok(req.id.clone(), crate::tools::tool_list())),
        "tools/call" => Some(crate::tools::call_tool(st, req.id.clone(), req.params.clone()).await),
        _ => Some(result_err(req.id.clone(), METHOD_NOT_FOUND, "method not found")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{test_state, MockEvents, MockKline};
    use std::sync::Arc;

    fn st() -> Arc<McpState> {
        test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()))
    }

    fn req(id: Option<Value>, method: &str, params: Option<Value>) -> RpcRequest {
        RpcRequest { jsonrpc: Some("2.0".into()), id, method: method.into(), params }
    }

    #[tokio::test]
    async fn initialize_returns_protocol_capabilities_serverinfo() {
        let r = dispatch(&st(), &req(Some(json!(1)), "initialize", Some(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "claude-desktop", "version": "1" },
        })))).await.expect("initialize 有响应");
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(r["result"]["capabilities"]["tools"].is_object());
        assert_eq!(r["result"]["serverInfo"]["name"], "eestock-mcp");
    }

    #[tokio::test]
    async fn id_echo_string_and_numeric_and_ping() {
        let r = dispatch(&st(), &req(Some(json!("abc-1")), "ping", None)).await.unwrap();
        assert_eq!(r["id"], "abc-1", "string id 原样 echo");
        let r = dispatch(&st(), &req(Some(json!(42)), "ping", None)).await.unwrap();
        assert_eq!(r["id"], 42);
        assert_eq!(r["result"], json!({}));
    }

    #[tokio::test]
    async fn notifications_yield_no_response() {
        assert!(dispatch(&st(), &req(None, "notifications/initialized", None)).await.is_none());
        assert!(dispatch(&st(), &req(None, "notifications/cancelled", Some(json!({})))).await.is_none());
    }

    #[tokio::test]
    async fn unknown_method_is_32601() {
        let r = dispatch(&st(), &req(Some(json!(7)), "resources/list", None)).await.unwrap();
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["id"], 7);
    }

    #[tokio::test]
    async fn tools_list_and_call_route_to_tools_layer() {
        let r = dispatch(&st(), &req(Some(json!(2)), "tools/list", None)).await.unwrap();
        let names: Vec<&str> = r["result"]["tools"].as_array().unwrap()
            .iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["get_kline", "get_sources_health", "get_data_quality",
            "sim_start_session", "sim_stop_session", "sim_get_account", "sim_get_positions",
            "sim_get_orders", "sim_get_pnl", "sim_place_order", "sim_cancel_order",
            "sim_list_strategies", "sim_get_strategy_signal", "sim_get_strategy_analysis",
            "sim_list_sessions", "sim_get_session", "sim_run_backtest_compare",
            // 12-strategy-system / P3c：统一策略系统工具族
            "strategy_list", "strategy_get", "strategy_create", "strategy_update",
            "strategy_publish", "strategy_archive", "strategy_test_run",
            "bt_run_ensemble", "bt_get_run", "bt_get_run_result", "bt_list_runs",
            "bt_cancel_run", "bt_compare_runs", "bt_list_presets", "bt_apply_preset"]);
        let r = dispatch(&st(), &req(Some(json!(3)), "tools/call", Some(json!({
            "name": "get_sources_health", "arguments": {},
        })))).await.unwrap();
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("mock_src"));
    }
}
// ~/~ end
