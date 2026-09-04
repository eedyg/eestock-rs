// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/server.rs>>[init]
//! MCP HTTP/SSE 传输（spec 2024-11-05 SSE transport，ADR-009）：
//! - GET  /sse → text/event-stream 长连接：首帧 `event: endpoint`（data=/messages?sessionId=<32hex>），
//!   随后每个 JSON-RPC 响应为 `event: message` 帧；15s 保活注释帧（:ka，防代理空闲断连）；
//!   连接断开即注销会话（SessionGuard drop——连接泄漏防护，父级裁决口径）。
//! - POST /messages?sessionId=<id> → 202 Accepted（响应经 SSE 流异步下发；通知无响应也 202）；
//!   缺 sessionId → 400；未知/已关闭会话 → 404；会话通道溢出 → 410。
//!
//! 免认证（ADR-010 内网）；端口独立（默认 8082，配置化，见 00-web-api §5 app_config）。

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::StreamExt;

use crate::rpc;
use crate::state::{McpState, SessionRegistry};

/// SSE 保活间隔（秒）。
pub const KEEPALIVE_SECS: u64 = 15;
/// 会话消息通道容量（溢出即 410，客户端重连重建会话兜底）。
pub const SESSION_CHANNEL_CAP: usize = 64;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<McpState>) -> Router {
    Router::new()
        .route("/sse", get(sse_handler))
        .route("/messages", post(post_message))
        .with_state(state)
}

/// 常驻服务入口（eestock-app 同进程 spawn；端口独立，ADR-009）。
pub async fn serve(state: Arc<McpState>, listen: &str) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!(listen = %listen, "mcp server (HTTP/SSE) serving");
    axum::serve(listener, build_router(state)).await?;
    Ok(())
}

async fn sse_handler(State(st): State<Arc<McpState>>) -> Response {
    let (id, rx) = st.sessions.create(SESSION_CHANNEL_CAP);
    tracing::info!(session = %id, "mcp sse session opened");
    let stream = sse_stream(&st, id, rx);
    (
        [(header::CONTENT_TYPE, "text/event-stream"),
         (header::CACHE_CONTROL, "no-cache")],
        Body::from_stream(stream),
    ).into_response()
}

/// SSE 帧流：endpoint 首帧 → (message | keepalive) 合并流；guard 随流 drop 注销会话。
fn sse_stream(st: &McpState, id: String, rx: tokio::sync::mpsc::Receiver<String>)
    -> impl tokio_stream::Stream<Item = Result<axum::body::Bytes, Infallible>>
{
    let endpoint = tokio_stream::once(
        format!("event: endpoint\ndata: /messages?sessionId={id}\n\n"));
    let messages = tokio_stream::wrappers::ReceiverStream::new(rx)
        .map(|m| format!("event: message\ndata: {m}\n\n"));
    let ka = tokio::time::interval_at(
        tokio::time::Instant::now() + std::time::Duration::from_secs(KEEPALIVE_SECS),
        std::time::Duration::from_secs(KEEPALIVE_SECS));
    let keepalive = tokio_stream::wrappers::IntervalStream::new(ka)
        .map(|_| ":ka\n\n".to_string());
    let guard = SessionGuard { sessions: st.sessions.clone(), id };
    endpoint
        .chain(messages.merge(keepalive))
        .map(move |frame| { let _guard = &guard; Ok(axum::body::Bytes::from(frame)) })
}

/// 会话清理哨兵：SSE 流被 drop（客户端断开/服务关闭）即注销会话（连接泄漏防护）。
struct SessionGuard {
    sessions: SessionRegistry,
    id: String,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.sessions.remove(&self.id);
        tracing::info!(session = %self.id, "mcp sse session closed");
    }
}

/// POST /messages 查询参数（MCP SSE transport 口径：sessionId camelCase）。
#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

/// POST /messages：解析 JSON-RPC → dispatch → 响应经会话通道下发 SSE；通知（无响应）也 202。
async fn post_message(State(st): State<Arc<McpState>>, Query(q): Query<MessagesQuery>,
                      body: String) -> Response {
    let Some(sid) = q.session_id.filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "sessionId 必填").into_response();
    };
    let Some(tx) = st.sessions.sender(&sid) else {
        return (StatusCode::NOT_FOUND, "未知或已关闭会话").into_response();
    };
    let resp = match serde_json::from_str::<rpc::RpcRequest>(&body) {
        Ok(req) => rpc::dispatch(&st, &req).await,
        Err(_) => Some(rpc::result_err(None, rpc::PARSE_ERROR, "parse error: 非法 JSON-RPC 帧")),
    };
    if let Some(resp) = resp {
        if tx.try_send(resp.to_string()).is_err() {
            return (StatusCode::GONE, "会话通道已满或已关闭，请重连 /sse").into_response();
        }
    }
    StatusCode::ACCEPTED.into_response()
}
// ~/~ end
