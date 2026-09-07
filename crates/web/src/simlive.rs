//! 模拟实盘 REST handlers（11-sim-live / L3b：web 面板；设计契约 design/11-sim-live/01-adr.md §7/§8）。
//!
//! ⚠️ **非 tangle 手写**（ADR-007 例外，与 backtest.rs 同模式）：本文件为新增功能模块，
//! 契约描述在 design/07-app-plane/00-web-api.md §1.6（端点表 / DTO / DI）；`lib.rs` 路由与
//! `state.rs` 的 `AppState.sim` 字段为 tangle 加法。
//!
//! 分层：web（Presentation）经 `application::SimLiveService`（Application）访问模拟实盘能力；
//! **MCP 与 web 共享同一 `SimLiveService` 实例**（ADR §7 双通道一致性：同账户/会话/开关/评分）。
//! `storage::sim::PgSimSessionStore` 由 app bin 装配注入；`storage` 不进正常依赖图（仅 dev-deps）。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::sync::Arc;

use application::simlive::{PlaceOrderReq, SimLiveService, StartSessionReq};

use crate::state::AppState;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "sim-live handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// 取注入的 SimLiveService；未配置（None）→ 503。
fn sim_service(st: &Arc<AppState>) -> Result<Arc<SimLiveService>, Response> {
    st.sim
        .clone()
        .ok_or_else(|| err(StatusCode::SERVICE_UNAVAILABLE, "sim-live 未配置（AppState.sim=None）"))
}

/// 解析目标会话：显式 `session_id` 优先；缺省回落到**当前运行会话**（`SimLiveService::current_session_id`）。
/// 用于当前会话区域（session-control / position-table / 等），历史回看必须显式传 id。
fn resolve_session_id(sim: &SimLiveService, explicit: Option<&str>) -> Result<String, Response> {
    if let Some(sid) = explicit {
        if !sid.trim().is_empty() {
            return Ok(sid.to_string());
        }
    }
    sim.current_session_id()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "无运行中会话（请先 start-session 或显式传 session_id）"))
}

// ── DTO（server 线格式；前端 mock/types 与此对齐，snake_case）──

/// GET /api/sim-live/state 查询参数：可选 session_id（缺省 = 当前运行会话）。
#[derive(Debug, Deserialize)]
pub struct SimStateQuery {
    #[serde(default)]
    pub session_id: Option<String>,
}

/// POST /api/sim-live/stop-session 请求体：session_id（缺省 = 当前运行会话）。
#[derive(Debug, Deserialize)]
pub struct SimStopReq {
    #[serde(default)]
    pub session_id: Option<String>,
}

/// POST /api/sim-live/cancel-order 请求体。
#[derive(Debug, Deserialize)]
pub struct SimCancelOrderReq {
    pub session_id: String,
    pub order_id: String,
}

/// POST /api/sim-live/place-order 请求体：`price`=模拟行情最新价（市价按此即时成交；限价为触发参考）。
#[derive(Debug, Deserialize)]
pub struct SimPlaceOrderReq {
    #[serde(default)]
    pub session_id: Option<String>,
    pub code: String,
    pub side: String,
    pub qty: f64,
    pub price: f64,
    #[serde(default)]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub intent_id: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "manual".into()
}

/// POST /api/sim-live/trading 请求体：enabled 布尔。
#[derive(Debug, Deserialize)]
pub struct SimToggleReq {
    pub enabled: bool,
}

/// POST /api/sim-live/mcp-toggle 请求体：enabled 布尔。
#[derive(Debug, Deserialize)]
pub struct SimMcpToggleReq {
    pub enabled: bool,
}

// ── REST handlers（§1.6 端点表）──────────────────────────────────────────────

/// GET /api/sim-live/state —— 会话状态 + 账户 + 持仓 + P&L + 统一开关 + MCP 开关（当前会话聚合）。
pub async fn state(State(st): State<Arc<AppState>>, Query(q): Query<SimStateQuery>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let sid = match resolve_session_id(&sim, q.session_id.as_deref()) { Ok(id) => id, Err(e) => return e };

    let account = match sim.get_account(&sid) { Ok(a) => a, Err(e) => return internal(e) };
    let positions = match sim.get_positions(&sid).await { Ok(p) => p, Err(e) => return internal(e) };
    let pnl = match sim.get_pnl(&sid) { Ok(p) => p, Err(e) => return internal(e) };
    let trading_enabled = match sim.trading_enabled(&sid) { Ok(t) => t, Err(e) => return internal(e) };
    let session_detail = match sim.get_session(&sid).await { Ok(s) => s, Err(e) => return internal(e) };

    Json(serde_json::json!({
        "active": true,
        "session": session_detail.map(|d| d.session),
        "account": account,
        "positions": positions,
        "pnl": pnl,
        "trading_enabled": trading_enabled,
        "mcp_enabled": sim.mcp_enabled(),
    }))
    .into_response()
}

/// GET /api/sim-live/positions —— 持仓。（`session_id` 可选，缺省当前运行会话。）
pub async fn positions(State(st): State<Arc<AppState>>, Query(q): Query<SimStateQuery>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let sid = match resolve_session_id(&sim, q.session_id.as_deref()) { Ok(id) => id, Err(e) => return e };
    match sim.get_positions(&sid).await {
        Ok(positions) => Json(serde_json::json!({ "session_id": sid, "positions": positions })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/sim-live/orders —— 订单列表。
pub async fn orders(State(st): State<Arc<AppState>>, Query(q): Query<SimStateQuery>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let sid = match resolve_session_id(&sim, q.session_id.as_deref()) { Ok(id) => id, Err(e) => return e };
    match sim.get_orders(&sid) {
        Ok(orders) => Json(serde_json::json!({ "session_id": sid, "orders": orders })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/sim-live/pnl —— 已实现/未实现盈亏。
pub async fn pnl(State(st): State<Arc<AppState>>, Query(q): Query<SimStateQuery>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let sid = match resolve_session_id(&sim, q.session_id.as_deref()) { Ok(id) => id, Err(e) => return e };
    match sim.get_pnl(&sid) {
        Ok(pnl) => Json(serde_json::json!({ "session_id": sid, "pnl": pnl })).into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/sim-live/place-order —— 下模拟单（市价按 `price` 即时成交；限价触及成交）。
/// body：`{session_id?, code, side, qty, price, limit_price?, intent_id?, source?}`（`price`=模拟行情最新价）。
pub async fn place_order(
    State(st): State<Arc<AppState>>,
    Json(body): Json<SimPlaceOrderReq>,
) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let sid = match resolve_session_id(&sim, body.session_id.as_deref()) { Ok(id) => id, Err(e) => return e };
    let req = PlaceOrderReq {
        code: body.code.clone(),
        side: body.side.clone(),
        qty: body.qty,
        limit_price: body.limit_price,
        intent_id: body.intent_id.clone(),
        source: body.source.clone(),
    };
    match sim.place_order(&sid, &req, body.price).await {
        Ok(Some(fill)) => Json(serde_json::json!({
            "session_id": sid, "filled": true, "fill": fill,
        }))
        .into_response(),
        Ok(None) => Json(serde_json::json!({
            "session_id": sid, "filled": false, "fill": null, "reason": "限价未触及，记为 pending 单",
        }))
        .into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/sim-live/cancel-order —— 撤单（仅取消 pending 单）。
pub async fn cancel_order(
    State(st): State<Arc<AppState>>,
    Json(body): Json<SimCancelOrderReq>,
) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    match sim.cancel_order(&body.session_id, &body.order_id).await {
        Ok(cancelled) => Json(serde_json::json!({
            "session_id": body.session_id, "order_id": body.order_id, "cancelled": cancelled,
        }))
        .into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/sim-live/start-session —— 开模拟会话（body = StartSessionReq）。
/// O1：已有 running 会话时 → 409（防多 running；`SimLiveService::start_session` 返回 `AlreadyRunning`）。
pub async fn start_session(State(st): State<Arc<AppState>>, Json(body): Json<StartSessionReq>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    match sim.start_session(&body).await {
        Ok(view) => Json(serde_json::json!({ "started": true, "session": view })).into_response(),
        Err(e) => {
            if e.downcast_ref::<application::simlive::AlreadyRunning>().is_some() {
                err(StatusCode::CONFLICT, "已有运行中会话，请先停止会话再开始（单运行会话约束）")
            } else {
                internal(e)
            }
        }
    }
}

/// POST /api/sim-live/stop-session —— 停会话（body：`{session_id?}`）。
pub async fn stop_session(State(st): State<Arc<AppState>>, Json(body): Json<SimStopReq>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let sid = match resolve_session_id(&sim, body.session_id.as_deref()) { Ok(id) => id, Err(e) => return e };
    match sim.stop_session(&sid).await {
        Ok(stopped) => Json(serde_json::json!({ "session_id": sid, "stopped": stopped })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/sim-live/strategies —— 3 策略评估概览（每策略独立分 + 聚合分）。
/// 返回：`strategies`（每策略当前最强标的/分，供 strategy-panel）+ `stocks`（每 stock 聚合+独立评分+信号，供 stock-scoring）。
pub async fn strategies(
    State(st): State<Arc<AppState>>,
    Query(q): Query<SimStateQuery>,
) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let sid = match resolve_session_id(&sim, q.session_id.as_deref()) { Ok(id) => id, Err(e) => return e };
    let evals = match sim.get_strategy_analysis(&sid) { Ok(e) => e, Err(e) => return internal(e) };

    // 策略名映射（内置目录；未知 id 兜底回 id）。
    let name_map: std::collections::HashMap<String, String> = match sim.list_builtin_strategies() {
        Ok(catalog) => catalog.into_iter().map(|s| (s.id.clone(), s.name)).collect(),
        Err(_) => Default::default(),
    };

    // 每策略：跨所有评估找其独立分最高的 stock（strategy-panel「当前最强」）。
    let mut per_strategy: std::collections::BTreeMap<String, serde_json::Value> = Default::default();
    let mut strategy_names: Vec<String> = Vec::new();
    for ev in &evals {
        for s in &ev.per_strategy_scores {
            strategy_names.push(s.strategy_id.clone());
            let best_cur = per_strategy.get(&s.strategy_id);
            let best_score = best_cur.and_then(|v| v.get("score")).and_then(|v| v.as_f64()).unwrap_or(f64::MIN);
            if s.score > best_score {
                per_strategy.insert(
                    s.strategy_id.clone(),
                    serde_json::json!({
                        "strategy_id": s.strategy_id,
                        "code": ev.code,
                        "score": s.score,
                        "signal": s.signal,
                    }),
                );
            }
        }
    }
    let strategy_ids: std::collections::BTreeSet<String> = strategy_names.into_iter().collect();
    let strategies: Vec<serde_json::Value> = strategy_ids
        .into_iter()
        .map(|id| {
            let name = name_map.get(&id).cloned().unwrap_or_else(|| id.clone());
            let strongest = per_strategy.get(&id).cloned().unwrap_or(serde_json::json!(null));
            serde_json::json!({ "strategy_id": id, "name": name, "strongest": strongest })
        })
        .collect();

    Json(serde_json::json!({
        "session_id": sid,
        "strategies": strategies,
        "stocks": evals,
    }))
    .into_response()
}

/// POST /api/sim-live/trading —— 统一交易开关（聚合评分→自动模拟单）。body `{enabled}`（可带 session_id?）。
pub async fn trading(State(st): State<Arc<AppState>>, Json(body): Json<SimToggleReq>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    // 统一交易开关作用于当前会话。
    let sid = match resolve_session_id(&sim, None) { Ok(id) => id, Err(e) => return e };
    match sim.set_trading(&sid, body.enabled) {
        Ok(enabled) => Json(serde_json::json!({ "session_id": sid, "trading_enabled": enabled })).into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/sim-live/mcp-toggle —— MCP sim_* 服务快捷开关（共享同一 SimLiveService，web+mcp 一致）。
pub async fn mcp_toggle(State(st): State<Arc<AppState>>, Json(body): Json<SimMcpToggleReq>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    let enabled = sim.set_mcp_enabled(body.enabled);
    Json(serde_json::json!({ "mcp_enabled": enabled })).into_response()
}

/// GET /api/sim-live/sessions —— 历史会话列表（已结束附指标摘要；start_ts DESC）。
pub async fn list_sessions(State(st): State<Arc<AppState>>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    match sim.list_sessions().await {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/sim-live/sessions/{id} —— 会话详情回看（元数据 + 结束结果）。
pub async fn get_session(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    match sim.get_session(&id).await {
        Ok(Some(detail)) => Json(detail).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "会话不存在"),
        Err(e) => internal(e),
    }
}

/// POST /api/sim-live/sessions/{id}/backtest-compare —— 「回测一下」同周期+同策略集触发回测对比。
pub async fn backtest_compare(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let sim = match sim_service(&st) { Ok(s) => s, Err(e) => return e };
    match sim.run_backtest_compare(&id).await {
        Ok(view) => Json(view).into_response(),
        Err(e) => internal(e),
    }
}
