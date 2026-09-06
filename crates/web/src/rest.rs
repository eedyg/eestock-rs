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
    // 看板收藏（Wave 3 页面①）：经 FavoriteStore.favorite_map 注入 code→sort_order（非收藏不在 map）
    let fav_map = match st.favorites.favorite_map().await {
        Ok(m) => m,
        Err(e) => return internal(e),
    };
    let mut list: Vec<SymbolDto> = rows.iter().map(SymbolDto::from).collect();
    for d in &mut list {
        if let Some(sort) = fav_map.get(&d.code).copied() {
            d.favorite = true;
            d.favorite_sort = Some(sort);
        }
    }
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
    // 收藏优先：按 favorite_sort 升序；非收藏保持原顺序（symbols_with_latest 按 code 序）。
    // sort_by 为稳定排序（equal 不重排），锁住非收藏原序。
    list.sort_by(|a, b| match (a.favorite_sort, b.favorite_sort) {
        (Some(ao), Some(bo)) => ao.cmp(&bo),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    Json(list).into_response()
}

/// 字段校验错误 → 400/422 JSON（FieldError 分类）。
fn field_err(e: FieldError) -> Response {
    match e {
        FieldError::BadRequest(m) => err(StatusCode::BAD_REQUEST, &m),
        FieldError::Unprocessable(m) => err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    }
}

/// 写后回读（经 merge 视图返回含 latest + 收藏标注的完整行）；写成功但回读缺失 → 500（不自洽）。
async fn read_symbol(st: &AppState, code: &str) -> anyhow::Result<Option<SymbolDto>> {
    let fav_map = st.favorites.favorite_map().await?;
    Ok(st.kline.symbols_with_latest().await?.iter()
        .find(|r| r.code == code)
        .map(|r| {
            let mut d = SymbolDto::from(r);
            if let Some(sort) = fav_map.get(&r.code).copied() {
                d.favorite = true;
                d.favorite_sort = Some(sort);
            }
            d
        }))
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

// ── Wave 3 页面① 看板收藏端点（favorite_symbols 表，0013；应用面自有表，写不违 ADR-017）──

/// 符号存在性探测（不存在 → 404）。复用 PgSymbolAdmin::update 的「无字段 no-op 探测」：
/// `UPDATE symbols SET name=COALESCE(NULL,name) ... WHERE code=$1` → rows_affected>0 表示存在。
/// 不新增 FavoriteStore 端口方法（契约最小集），符号存在性经既有 SymbolAdminWrite::update 探测。
#[allow(clippy::result_large_err)]
async fn symbol_exists(st: &AppState, code: &str) -> Result<bool, Response> {
    match st.symbols_admin.update(code, &SymbolPatch::default()).await {
        Ok(exists) => Ok(exists),
        Err(e) => Err(internal(e)),
    }
}

/// POST /api/symbols/{code}/favorite —— 一键收藏（自动置顶 sort_order=max+1）。
/// 幂等语义（父级批准）：已收藏再次收藏 → 200 无副作用（不做 409）。
pub async fn star_favorite(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Response {
    if code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 空"); }
    match symbol_exists(&st, &code).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "code 未注册"),
        Err(e) => return e,
    }
    match st.favorites.star(&code).await {
        Ok(()) => (StatusCode::OK,
            Json(serde_json::json!({ "code": &code, "favorite": true }))).into_response(),
        Err(e) => internal(e),
    }
}

/// DELETE /api/symbols/{code}/favorite —— 取消收藏（不存在收藏 → 200 幂等）。
pub async fn unstar_favorite(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Response {
    if code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 空"); }
    match symbol_exists(&st, &code).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "code 未注册"),
        Err(e) => return e,
    }
    match st.favorites.unstar(&code).await {
        Ok(()) => (StatusCode::OK,
            Json(serde_json::json!({ "code": &code, "favorite": false }))).into_response(),
        Err(e) => internal(e),
    }
}

/// PUT /api/symbols/favorites/order —— 批量重排（sort_order=索引；codes 顺序即展示顺序，可子集）。
/// 校验：codes 所有 code 均须已收藏（favorite_map 预检），否则 400。
pub async fn reorder_favorites(State(st): State<Arc<AppState>>,
                               Json(req): Json<ReorderFavoritesReq>) -> Response {
    let fav_map = match st.favorites.favorite_map().await {
        Ok(m) => m,
        Err(e) => return internal(e),
    };
    for c in &req.codes {
        if !fav_map.contains_key(c) {
            return err(StatusCode::BAD_REQUEST, &format!("code {c} 未收藏"));
        }
    }
    match st.favorites.reorder(&req.codes).await {
        Ok(()) => (StatusCode::OK,
            Json(serde_json::json!({ "codes": req.codes, "reordered": true }))).into_response(),
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

// ── Wave 2 Phase A：数据质量（页面④，04-quality.md §7）+ tushare 同步状态 ──
// 范围/阈值校验在 web 层（400）；service 内部同口径防御性复核。

/// 解析 from/to（YYYY-MM-DD）+ 范围校验；失败 → 400 Response。
/// （Err 载荷为 axum Response 属大类型——handler 短路返回模式既定，allow 之；与 alerts.rs 同口径）
#[allow(clippy::result_large_err)]
fn parse_range(from_s: &str, to_s: &str)
    -> Result<(chrono::NaiveDate, chrono::NaiveDate), Response> {
    let (Some(from), Some(to)) = (parse_date(from_s), parse_date(to_s)) else {
        return Err(err(StatusCode::BAD_REQUEST, "from/to 必填且须为 YYYY-MM-DD"));
    };
    if let Err(e) = diagnose::quality::validate_range(from, to) {
        return Err(err(StatusCode::BAD_REQUEST, &e.to_string()));
    }
    Ok((from, to))
}

/// 阈值解析（默认 = 页面④ QUALITY_DEFAULTS.consistencyThresholdPct=0.5）+ 校验。
#[allow(clippy::result_large_err)]
fn parse_threshold(q: Option<f64>) -> Result<f64, Response> {
    let t = q.unwrap_or(diagnose::quality::DEFAULT_THRESHOLD_PCT);
    if let Err(m) = validate_threshold(t) { return Err(err(StatusCode::BAD_REQUEST, &m)); }
    Ok(t)
}

/// GET /api/quality/divergence?code=&from=&to=&threshold_pct=
pub async fn get_quality_divergence(State(st): State<Arc<AppState>>,
                                    Query(q): Query<DivergenceQuery>) -> Response {
    if q.code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 必填"); }
    let (from, to) = match parse_range(&q.from, &q.to) { Ok(r) => r, Err(r) => return r };
    let threshold = match parse_threshold(q.threshold_pct) { Ok(t) => t, Err(r) => return r };
    match st.quality.divergence(&q.code, from, to, threshold).await {
        Ok(rep) => Json(serde_json::json!({
            "code": q.code, "from": q.from, "to": q.to, "threshold_pct": threshold,
            "summary": rep.summary, "rows": rep.rows,
        })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/quality/source-accuracy?from=&to=&threshold_pct=
pub async fn get_quality_source_accuracy(State(st): State<Arc<AppState>>,
                                         Query(q): Query<SourceAccuracyQuery>) -> Response {
    let (from, to) = match parse_range(&q.from, &q.to) { Ok(r) => r, Err(r) => return r };
    let threshold = match parse_threshold(q.threshold_pct) { Ok(t) => t, Err(r) => return r };
    match st.quality.source_accuracy(from, to, threshold).await {
        Ok(sources) => Json(serde_json::json!({
            "from": q.from, "to": q.to, "threshold_pct": threshold, "sources": sources,
        })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/quality/gaps?code=&from=&to=
/// 仅含有缺口的交易日；segments 的 start/end 为 CST "HH:MM"（页面④ 展示口径）。
pub async fn get_quality_gaps(State(st): State<Arc<AppState>>,
                              Query(q): Query<GapsQuery>) -> Response {
    if q.code.is_empty() { return err(StatusCode::BAD_REQUEST, "code 必填"); }
    let (from, to) = match parse_range(&q.from, &q.to) { Ok(r) => r, Err(r) => return r };
    match st.quality.gaps(&q.code, from, to).await {
        Ok(days) => Json(serde_json::json!({
            "code": q.code, "from": q.from, "to": q.to,
            "days": days.iter().map(|d| serde_json::json!({
                "date": d.date,
                "expected_bars": d.expected_bars,
                "actual_bars": d.actual_bars,
                "missing_bars": d.missing_bars,
                "segments": d.segments.iter().map(|s| serde_json::json!({
                    "start": diagnose::quality::hhmm(&s.start),
                    "end": diagnose::quality::hhmm(&s.end),
                    "count": s.count,
                    "class": s.class,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/tushare/status —— 页面④ sync-panel 状态区。
/// quota_remaining 恒 null：tushare 积分余额未入库（§1.1 注明，待账户侧可查后单开）。
pub async fn get_tushare_status(State(st): State<Arc<AppState>>) -> Response {
    match st.quality.tushare_status().await {
        Ok(s) => Json(serde_json::json!({
            "checkpoints": s.checkpoints,
            "covered_codes": s.covered_codes,
            "last_updated_at": s.last_updated_at,
            "last_event": s.last_event,
            "quota_remaining": serde_json::Value::Null,
        })).into_response(),
        Err(e) => internal(e),
    }
}

// ── 行情看板 MA 可配置（后端 W1：GET /api/config/ma 读 + PUT 写；主图+宫格应用，回测弹窗不动）──
// 校验在 web 层（validate_ma_windows，400）；storage 只存归一化（升序去重）结果，见 §1.1 契约表。

/// GET /api/config/ma —— 读当前 MA 窗口（ma_config 表；表空 → 默认 [5,10,20]）。
pub async fn get_ma_config(State(st): State<Arc<AppState>>) -> Response {
    match st.ma_config.get().await {
        Ok(windows) => Json(MaConfigDto { windows }).into_response(),
        Err(e) => internal(e),
    }
}

/// PUT /api/config/ma —— body {windows:[...]}：校验（1-3 条、每条 1-500、升序/去重归一）→ 存 DB → 返回归一化。
/// 400：条目数/量纲不合规；500：存储失败。
pub async fn put_ma_config(State(st): State<Arc<AppState>>,
                           Json(req): Json<MaConfigDto>) -> Response {
    let windows = match validate_ma_windows(&req.windows) {
        Ok(w) => w,
        Err(e) => return err(StatusCode::BAD_REQUEST, &e),
    };
    match st.ma_config.set(&windows).await {
        Ok(w) => Json(MaConfigDto { windows: w }).into_response(),
        Err(e) => internal(e),
    }
}
// ~/~ end
