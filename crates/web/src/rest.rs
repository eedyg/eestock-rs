// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/rest.rs>>[init]
//! REST 端点处理（契约见本文档 §1.1）。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use domain::ports::{SymbolAdminInput, SymbolPatch};
use std::sync::Arc;

use crate::dto::*;
use crate::state::AppState;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "rest handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// GET /healthz —— 存活探测（compose healthcheck 经 --self-check 调此路由）。
pub async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

pub async fn get_kline(State(st): State<Arc<AppState>>, Query(q): Query<KlineQuery>) -> Response {
    if q.code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 必填"); }
    let Some(period) = parse_period(&q.period) else {
        return err(StatusCode::BAD_REQUEST, "period 须为 1m/5m/15m/1h/1d");
    };
    let before = match q.before.as_deref() {
        None => None,
        Some(s) => match DateTime::parse_from_rfc3339(s) {
            Ok(t) => Some(t.with_timezone(&Utc)),
            Err(_) => return err(StatusCode::BAD_REQUEST, "before 须为 RFC3339 时间戳"),
        },
    };
    let limit = q.limit.clamp(1, MAX_LIMIT);
    match st.kline.bars(period, &q.code, before, limit).await {
        Ok(rows) => {
            // 取满一页 → 可能还有更早数据，游标 = 本页最旧 ts（bars 已升序）
            let next_before = if rows.len() as i64 == limit {
                rows.first().map(|r| r.ts)
            } else { None };
            Json(KlineResponse {
                code: q.code.clone(),
                period: q.period.clone(),
                bars: rows.iter().map(BarDto::from).collect(),
                next_before,
            }).into_response()
        }
        Err(e) => internal(e),
    }
}

pub async fn get_symbols(State(st): State<Arc<AppState>>,
                         Query(q): Query<SymbolsQuery>) -> Response {
    let with_stats = q.with_stats.as_deref() == Some("1");
    let rows = match st.kline.symbols_with_latest().await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let mut list: Vec<SymbolDto> = rows.iter().map(SymbolDto::from).collect();
    if with_stats {
        match st.symbol_stats.today_stats().await {
            Ok(stats) => {
                let map: std::collections::HashMap<String, i64> =
                    stats.into_iter().map(|s| (s.code, s.today_bars)).collect();
                for d in &mut list {
                    d.today_bars = Some(map.get(&d.code).copied().unwrap_or(0));
                }
            }
            Err(e) => return internal(e),
        }
    }
    Json(list).into_response()
}

/// 字段校验错误 → 400/422 JSON（FieldError 分类）。
fn field_err(e: FieldError) -> Response {
    match e {
        FieldError::BadRequest(m) => err(StatusCode::BAD_REQUEST, &m),
        FieldError::Unprocessable(m) => err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    }
}

/// 写后回读（经 merge 视图返回含 latest 的完整行）；写成功但回读缺失 → 500（不自洽）。
async fn read_symbol(st: &AppState, code: &str) -> anyhow::Result<Option<SymbolDto>> {
    Ok(st.kline.symbols_with_latest().await?.iter()
        .find(|r| r.code == code).map(SymbolDto::from))
}

/// POST /api/symbols —— 注册标的（校验 03-symbols §3；写 symbols 表即控制通道，热生效）。
/// 名称不经服务端行情源反查（ADR-017：应用面无数据面直连）——请求体携带或留空后续 PATCH。
pub async fn register_symbol(State(st): State<Arc<AppState>>,
                             Json(req): Json<RegisterSymbolReq>) -> Response {
    if let Err(e) = validate_code(&req.code) { return field_err(e); }
    if let Err(e) = validate_interval(req.interval_secs) { return field_err(e); }
    if let Err(e) = validate_settlement(&req.settlement) { return field_err(e); }
    let input = SymbolAdminInput {
        code: req.code.clone(), name: normalize_name(req.name),
        interval_secs: req.interval_secs, settlement: req.settlement.clone(),
        enabled: req.enabled,
    };
    match st.symbols_admin.register(&input).await {
        Ok(true) => match read_symbol(&st, &req.code).await {
            Ok(Some(dto)) => (StatusCode::CREATED, Json(dto)).into_response(),
            Ok(None) => internal(anyhow::anyhow!("register 后回读缺失 {}", req.code)),
            Err(e) => internal(e),
        },
        Ok(false) => err(StatusCode::CONFLICT, "code 已注册（编辑用 PATCH）"),
        Err(e) => internal(e),
    }
}

/// PATCH /api/symbols/{code} —— 编辑（间隔/启停/名称/settlement；code 主键不可改）。
/// 仅停用、无物理删除（03-symbols §4）；间隔修改下一采集周期热生效。
pub async fn update_symbol(State(st): State<Arc<AppState>>, Path(code): Path<String>,
                           Json(req): Json<UpdateSymbolReq>) -> Response {
    if let Some(secs) = req.interval_secs {
        if let Err(e) = validate_interval(secs) { return field_err(e); }
    }
    if let Some(s) = &req.settlement {
        if let Err(e) = validate_settlement(s) { return field_err(e); }
    }
    let patch = SymbolPatch {
        name: normalize_name(req.name),
        interval_secs: req.interval_secs,
        settlement: req.settlement.clone(),
        enabled: req.enabled,
    };
    match st.symbols_admin.update(&code, &patch).await {
        Ok(true) => match read_symbol(&st, &code).await {
            Ok(Some(dto)) => Json(dto).into_response(),
            Ok(None) => internal(anyhow::anyhow!("update 后回读缺失 {code}")),
            Err(e) => internal(e),
        },
        Ok(false) => err(StatusCode::NOT_FOUND, "code 未注册"),
        Err(e) => internal(e),
    }
}

/// POST /api/sources/{id}/reset —— 熔断手动复位（DB 控制通道，ADR-017）。
/// 202 异步：写 circuit_reset_requests；数据面 ResetWatcher ≤5s 消费并发出 manual_reset 事件
/// （未知源 id 由消费端跳过并告警——应用面不知编译期源清单，不在此校验）。
pub async fn reset_source(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if id.trim().is_empty() { return err(StatusCode::BAD_REQUEST, "source id 空"); }
    match st.resets.request_reset(&id).await {
        Ok(()) => (StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "accepted" }))).into_response(),
        Err(e) => internal(e),
    }
}

pub async fn get_sources_health(State(st): State<Arc<AppState>>,
                                Query(q): Query<HealthQuery>) -> Response {
    let window = q.window_secs.clamp(60, 7 * 24 * 3600);
    match st.health.aggregate(window).await {
        Ok(sources) => Json(serde_json::json!({
            "window_secs": window,
            "sources": sources,
        })).into_response(),
        Err(e) => internal(e),
    }
}
// ~/~ end
