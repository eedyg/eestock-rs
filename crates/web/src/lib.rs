// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/lib.rs>>[init]
//! web —— Presentation：axum REST + WebSocket + SPA 静态托管（应用面，ADR-017）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

pub mod dto;
pub mod rest;
pub mod spa;
pub mod state;
pub mod ws;

use axum::{routing::get, Router};
use std::sync::Arc;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/healthz", get(rest::healthz))
        .route("/api/kline", get(rest::get_kline))
        .route("/api/symbols", get(rest::get_symbols))
        .route("/api/sources/health", get(rest::get_sources_health))
        .route("/ws", get(ws::ws_handler))
        .fallback(spa::spa_fallback)
        .with_state(state)
}
// ~/~ end
