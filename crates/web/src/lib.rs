// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/lib.rs>>[init]
//! web —— Presentation：axum REST + WebSocket + SPA 静态托管（应用面，ADR-017）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

pub mod dto;
pub mod rest;
pub mod spa;
pub mod state;
pub mod ws;

use axum::{routing::{get, patch, post}, Router};
use std::sync::Arc;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/healthz", get(rest::healthz))
        .route("/api/kline", get(rest::get_kline))
        // Phase C：symbols 写端点（注册 POST / 编辑 PATCH；无物理删除，03-symbols §4）
        .route("/api/symbols", get(rest::get_symbols).post(rest::register_symbol))
        .route("/api/symbols/{code}", patch(rest::update_symbol))
        .route("/api/sources/health", get(rest::get_sources_health))
        // Phase C：熔断手动复位（DB 控制通道，ADR-017）
        .route("/api/sources/{id}/reset", post(rest::reset_source))
        .route("/ws", get(ws::ws_handler))
        .fallback(spa::spa_fallback)
        .with_state(state)
}
// ~/~ end
