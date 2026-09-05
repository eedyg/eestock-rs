// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/lib.rs>>[init]
//! web —— Presentation：axum REST + WebSocket + SPA 静态托管（应用面，ADR-017）。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

// alerts：页面⑦ 告警中心（Wave 2 Phase B 加法；代码块在 design/07-app-plane/02-alerts.md）
pub mod alerts;
// Wave 3 Phase 3c：回测 REST handlers + WS 进度 sink（§1.5；非 tangle 手写，web 依赖 application）
pub mod backtest;
pub mod dto;
pub mod rest;
pub mod settings; // 页面⑧ 系统设置 S1（08-settings.md；只读/运维端点）
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
        // Wave 2 Phase B：页面⑦ 告警中心（列表/确认/规则 CRUD；02-alerts.md）
        .route("/api/alerts", get(alerts::list_alerts))
        .route("/api/alerts/{id}/ack", post(alerts::ack_alert))
        .route("/api/alert-rules", get(alerts::list_rules).patch(alerts::patch_rule))
        // Wave 2 Phase A：页面④ 数据质量 + tushare 同步状态（04-quality.md §7；sync 手动触发暂缓，§1.4）
        .route("/api/quality/divergence", get(rest::get_quality_divergence))
        .route("/api/quality/source-accuracy", get(rest::get_quality_source_accuracy))
        .route("/api/quality/gaps", get(rest::get_quality_gaps))
        .route("/api/tushare/status", get(rest::get_tushare_status))
        // Wave 3 Phase 3c：回测（§1.5；strategies / submit / list / detail / delete / compare，handlers 在 backtest.rs）
        .route("/api/backtest/strategies", get(backtest::strategies))
        .route("/api/backtest/runs", get(backtest::list_runs).post(backtest::submit_run))
        .route("/api/backtest/runs/{id}", get(backtest::get_run).delete(backtest::delete_run))
        .route("/api/backtest/compare", get(backtest::compare_runs))
        // 页面⑧ 系统设置 S1（08-settings.md §6）：系统信息 + 只读配置快照 + 危险运维
        .route("/api/system/info", get(settings::system_info))
        .route("/api/system/purge-raw", post(settings::purge_raw))
        .route("/api/system/reset-circuits", post(settings::reset_circuits))
        .route("/api/config/sources", get(settings::get_config_sources))
        .route("/api/config/collector", get(settings::get_config_collector))
        .route("/api/config/mcp", get(settings::get_config_mcp))
        .route("/ws", get(ws::ws_handler))
        .fallback(spa::spa_fallback)
        .with_state(state)
}
// ~/~ end
