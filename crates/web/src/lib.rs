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
// 11-sim-live / L3b：模拟实盘 REST handlers（§1.6；非 tangle 手写，web 依赖 application，与 MCP 共享 SimLiveService）
pub mod simlive;
// 12-strategy-system / P2a：策略 Registry REST handlers（§1.7；非 tangle 手写，web 依赖 application）
pub mod strategies;
// 12-strategy-system / P3a：回测工作台 REST handlers + WS 进度 sink（§1.8；非 tangle 手写，web 依赖 application）
pub mod workbench;
pub mod spa;
pub mod state;
pub mod ws;

use axum::{routing::{get, patch, post, put}, Router};
use std::sync::Arc;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/healthz", get(rest::healthz))
        .route("/api/kline", get(rest::get_kline))
        // Phase C：symbols 写端点（注册 POST / 编辑 PATCH；无物理删除，03-symbols §4）
        .route("/api/symbols", get(rest::get_symbols).post(rest::register_symbol))
        .route("/api/symbols/{code}", patch(rest::update_symbol))
        // 看板收藏（Wave 3 页面①）：一键收藏 POST（幂等）/ 取消 DELETE（幂等）/ 拖拽排序 PUT
        .route("/api/symbols/{code}/favorite", post(rest::star_favorite).delete(rest::unstar_favorite))
        .route("/api/symbols/favorites/order", put(rest::reorder_favorites))
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
        // 11-sim-live / L3b：模拟实盘 web 面板（§1.6；handlers 在 simlive.rs，与 MCP 共享同一 SimLiveService）
        .route("/api/sim-live/state", get(simlive::state))
        .route("/api/sim-live/positions", get(simlive::positions))
        .route("/api/sim-live/orders", get(simlive::orders))
        .route("/api/sim-live/pnl", get(simlive::pnl))
        .route("/api/sim-live/strategies", get(simlive::strategies))
        .route("/api/sim-live/sessions", get(simlive::list_sessions))
        .route("/api/sim-live/sessions/{id}", get(simlive::get_session))
        .route("/api/sim-live/sessions/{id}/backtest-compare", post(simlive::backtest_compare))
        .route("/api/sim-live/place-order", post(simlive::place_order))
        .route("/api/sim-live/cancel-order", post(simlive::cancel_order))
        .route("/api/sim-live/start-session", post(simlive::start_session))
        .route("/api/sim-live/stop-session", post(simlive::stop_session))
        .route("/api/sim-live/trading", post(simlive::trading))
        .route("/api/sim-live/mcp-toggle", post(simlive::mcp_toggle))
        // 页面⑧ 系统设置 S1（08-settings.md §6）：系统信息 + 只读配置快照 + 危险运维
        .route("/api/system/info", get(settings::system_info))
        .route("/api/system/purge-raw", post(settings::purge_raw))
        .route("/api/system/reset-circuits", post(settings::reset_circuits))
        // S2：config 持久化 PATCH（GET 读持久 + PATCH 写；缺则默认）
        .route("/api/config/sources", get(settings::get_config_sources).patch(settings::patch_config_sources))
        .route("/api/config/collector", get(settings::get_config_collector).patch(settings::patch_config_collector))
        .route("/api/config/mcp", get(settings::get_config_mcp).patch(settings::patch_config_mcp))
        // 行情看板 MA 可配置（后端 W1：GET 读 / PUT 写归一化升序窗口；主图+宫格应用，回测弹窗不动）
        .route("/api/config/ma", get(rest::get_ma_config).put(rest::put_ma_config))
        // 行情看板 K线默认视口（后端 W1：GET /api/config/kline 读 / PUT 写 viewport_days；app_config 0021；缺省 2）
        .route("/api/config/kline", get(settings::get_config_kline).put(settings::put_config_kline))
        // 12-strategy-system / P2a+P2b：策略 Registry（§1.7；handlers 在 strategies.rs，非 tangle 手写）
        .route("/api/strategies", get(strategies::catalog).post(strategies::create_strategy))
        .route("/api/strategies/test-run", post(strategies::test_run))
        // P2b：manage 管理列表（静态段优先于 {id} 参数段，axum matchit 保证）
        .route("/api/strategies/manage", get(strategies::manage_list))
        .route("/api/strategies/versions/diff", get(strategies::diff_versions))
        .route("/api/strategies/versions/{vid}", put(strategies::update_draft))
        .route("/api/strategies/versions/{vid}/publish", post(strategies::publish_version))
        .route("/api/strategies/versions/{vid}/archive", post(strategies::archive_version))
        .route("/api/strategies/{id}", get(strategies::get_strategy).patch(strategies::update_meta))
        .route("/api/strategies/{id}/versions", get(strategies::list_versions).post(strategies::create_draft_from))
        // 12-strategy-system / P3a：回测工作台（§1.8；handlers 在 workbench.rs，非 tangle 手写）
        // 静态段优先于 {id} 参数段（axum matchit 保证）：compare/presets 先于 /runs/{id}
        .route("/api/workbench/runs", get(workbench::list_runs).post(workbench::submit_run))
        .route("/api/workbench/runs/compare", post(workbench::compare_runs))
        .route("/api/workbench/runs/{id}", get(workbench::get_run))
        .route("/api/workbench/runs/{id}/result", get(workbench::get_result))
        .route("/api/workbench/runs/{id}/cancel", post(workbench::cancel_run))
        .route("/api/workbench/presets", get(workbench::list_presets).post(workbench::create_preset))
        .route("/api/workbench/presets/{id}", get(workbench::get_preset).put(workbench::update_preset).delete(workbench::delete_preset))
        .route("/api/workbench/presets/{id}/apply", post(workbench::apply_preset))
        .route("/ws", get(ws::ws_handler))
        .fallback(spa::spa_fallback)
        .with_state(state)
}
// ~/~ end
