//! 回测工作台 REST handlers + WS 进度 sink（12-strategy-system / P3a；设计契约 §1.8）。
//!
//! ⚠️ **非 tangle 手写**（ADR-007 例外，与 backtest.rs/strategies.rs 同模式）：本文件为新增功能模块；
//! `lib.rs` 路由与 `state.rs` 的 `AppState.workbench` 字段、ws.rs 的 `Topic::StrategyRun` /
//! `PushMsg::StrategyRunProgress` 为 tangle 加法（00-web-api.md）。
//!
//! 分层：web（Presentation）经 `application::workbench::WorkbenchService`（Application）访问工作台能力；
//! `storage::workbench::PgStrategyRunStore/PgStrategyPresetStore` 等由 app bin 装配注入。
//!
//! 错误语义：未找到 404（WorkbenchNotFound）、冲突 409（WorkbenchConflict：终态取消/预设重名）、
//! 校验失败 400（WorkbenchValidation / web 层入参校验）；服务未装配 → 503。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::sync::Arc;
use tracing::Instrument;

use application::workbench::{
    SlotReq, SubmitRunReq, WorkbenchConflict, WorkbenchNotFound, WorkbenchService,
    WorkbenchValidation, BARS_LIMIT_DEFAULT, BARS_LIMIT_MAX, BarsWindow, COMPARE_K_DEFAULT,
};
use application::error::StructuredError;
use application::error::codes;
use application::bar_map;
use domain::ports::{ResultKind, StrategyRunFilter, StrategyRunProgressSink, StrategyRunStatus};

use crate::state::AppState;
use crate::ws::{PushMsg, WsHub};

/// 非 400 的错误体（404/409/500/503）。
///
/// ⚠️ ADR-024 P5 整改 N1：**只允许**用于非 400；本模块内所有 400 一律走 [`structured`]，
/// 使 `error` 字段在 400 上恒为对象（禁两种类型混用）。
fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// ADR-024 §3.1.1：结构化错误体 `{"error":{"code","message","detail"}}`（前端可**编程**消费）。
/// `detail` 恒为对象（无补充信息时 `{}`）。
fn structured(status: StatusCode, code: &str, message: &str, detail: serde_json::Value) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": { "code": code, "message": message, "detail": detail }
        })),
    )
        .into_response()
}

/// 结构化 400 的 `detail`：application 专属字段 + 请求上下文（如 `period`）。
fn merge_detail(mut detail: serde_json::Value, ctx: &serde_json::Value) -> serde_json::Value {
    if let (Some(d), Some(c)) = (detail.as_object_mut(), ctx.as_object()) {
        for (k, v) in c {
            d.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    detail
}

/// application 层结构化错误（`range_empty`/`resource_guard`）→ 结构化 400。
fn structured_err(e: &StructuredError, ctx: &serde_json::Value) -> Response {
    structured(
        StatusCode::BAD_REQUEST,
        &e.code,
        &e.message,
        merge_detail(e.detail.clone(), ctx),
    )
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "workbench handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// 服务错误 → HTTP 语义（404/409/400/500）。
///
/// ADR-024 §3.1.1：400 一律结构化；`WorkbenchValidation` 的 `code` **由 application 校验点同源给出**
/// （web 不做消息解析），`ctx` 为请求上下文（如 `period`）。
fn map_svc_err_ctx(e: anyhow::Error, ctx: serde_json::Value) -> Response {
    if let Some(x) = e.downcast_ref::<StructuredError>() {
        structured_err(x, &ctx)
    } else if let Some(x) = e.downcast_ref::<WorkbenchValidation>() {
        structured(StatusCode::BAD_REQUEST, x.code(), x.message(), ctx)
    } else if let Some(x) = e.downcast_ref::<WorkbenchNotFound>() {
        err(StatusCode::NOT_FOUND, &x.0)
    } else if let Some(x) = e.downcast_ref::<WorkbenchConflict>() {
        err(StatusCode::CONFLICT, &x.0)
    } else {
        internal(e)
    }
}

fn map_svc_err(e: anyhow::Error) -> Response {
    map_svc_err_ctx(e, serde_json::json!({}))
}

/// 取注入的 WorkbenchService；未装配（None）→ 503（与 AppState.strategies 同模式）。
#[allow(clippy::result_large_err)]
fn svc(st: &Arc<AppState>) -> Result<Arc<WorkbenchService>, Response> {
    st.workbench
        .clone()
        .ok_or_else(|| err(StatusCode::SERVICE_UNAVAILABLE, "workbench 未配置（AppState.workbench=None）"))
}

// ── DTO ──

/// POST /api/workbench/runs 提交槽位。
#[derive(Debug, Deserialize)]
pub struct SubmitSlotDto {
    pub version_id: String,
    #[serde(default = "default_params_obj")]
    pub params: serde_json::Value,
    pub weight: f64,
}

fn default_params_obj() -> serde_json::Value {
    serde_json::json!({})
}

/// POST /api/workbench/runs 请求体（from/to 为 RFC3339 字符串，handler 解析为 DateTime<Utc>）。
#[derive(Debug, Deserialize)]
pub struct WorkbenchSubmitReq {
    #[serde(default)]
    pub name: Option<String>,
    pub symbol: String,
    pub period: String,
    pub from: String,
    pub to: String,
    pub slots: Vec<SubmitSlotDto>,
    #[serde(default)]
    pub buy_threshold: Option<f64>,
    #[serde(default)]
    pub sell_threshold: Option<f64>,
    pub policy: serde_json::Value,
    #[serde(default)]
    pub stop: Option<serde_json::Value>,
    #[serde(default)]
    pub initial_capital: Option<f64>,
    /// I-3/D6 + D11-3（v1.1 R-2）：省略/`null` = 按标的 type 查 `fee_profiles` 解析（无档案 → 旧默认）；
    /// 显式对象按**字段优先级**（出现字段优先，缺失字段逐字段回退档案→旧默认）。
    #[serde(default)]
    pub fee: Option<serde_json::Value>,
    /// I-2/D6：前置预热根数（缺省 250）；0 = 无预热。
    #[serde(default)]
    pub warmup_bars: Option<usize>,
    /// ADR-024 P5 §3.1.1：资源护栏二次确认（预估 bar 数 ≥ 阈值时需 `true` 重提放行）。
    #[serde(default)]
    pub confirm: bool,
}

/// `GET /api/workbench/available_range` 查询参数（ADR-024 P5 §5.2：日期控件 min/max 联动）。
#[derive(Debug, Deserialize)]
pub struct AvailableRangeQuery {
    pub symbol: String,
    pub period: String,
}

/// GET /api/workbench/runs 查询参数（status 可选；limit 默认 100 封顶 500，offset 默认 0）。
#[derive(Debug, Deserialize)]
pub struct WorkbenchListQuery {
    pub status: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 {
    100
}

/// 列表单页上限（handler 以 `limit.clamp(1, MAX_WORKBENCH_LIMIT)` 归一；与回测同口径）。
pub const MAX_WORKBENCH_LIMIT: i64 = 500;

/// POST /api/workbench/runs/compare 请求体（`k`：净值抽样目标点数，缺省 2000）。
#[derive(Debug, Deserialize)]
pub struct WorkbenchCompareReq {
    pub ids: Vec<String>,
    #[serde(default)]
    pub k: Option<usize>,
}

/// GET /api/workbench/runs/{id}/bars 查询参数。
/// `kind` 缺省 `per_bar`；`offset/limit`（序号分页）与 `from/to`（时间区间）**互斥**。
#[derive(Debug, Deserialize)]
pub struct BarsQuery {
    pub kind: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// GET /api/workbench/runs/{id}/curve 查询参数（`kind` 缺省 `net_value`；`k` 缺省 2000/上限 20000）。
/// ADR-028 D3：`from_ts`/`to_ts` 为时间窗（epoch 秒，闭区间）；缺省 = 全区间（向后兼容）。
#[derive(Debug, Deserialize)]
pub struct CurveQuery {
    pub kind: Option<String>,
    pub k: Option<usize>,
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
}

/// GET /api/workbench/runs/{id}/fills 查询参数（`offset` 缺省 0；`limit` 缺省 5000/上限 20000）。
/// ADR-027 §5.4：增可选 `round_trip=<rt_seq>` 过滤。
#[derive(Debug, Deserialize)]
pub struct FillsQuery {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
    pub round_trip: Option<u32>,
}

/// GET /api/workbench/runs/{id}/round-trips 查询参数（L1 懒加载首屏分页）。
#[derive(Debug, Deserialize)]
pub struct RoundTripsQuery {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

/// 抽样/区间/分页曲线可接受的 kind（`fills` 是**事实源**：专用 `/fills` 端点分页读，禁止抽样，见 ADR-024 P6）。
/// `default` 为未传 `kind` 时的缺省值（`/bars` = per_bar；`/curve` = net_value）。
/// ADR-027 §4.1：`position` 可抽样（与 `net_value` 同级，须披露 `downsampled`/`original_bars`）。
fn parse_series_kind(s: Option<&str>, default: ResultKind) -> Result<ResultKind, Response> {
    match s {
        None => Ok(default),
        Some("per_bar") => Ok(ResultKind::PerBar),
        Some("net_value") => Ok(ResultKind::NetValue),
        Some("drawdown") => Ok(ResultKind::Drawdown),
        Some("position") => Ok(ResultKind::Position),
        _ => Err(structured(
            StatusCode::BAD_REQUEST,
            codes::KIND_INVALID,
            "kind 须为 per_bar/net_value/drawdown/position（fills 请用专用端点 /fills）",
            serde_json::json!({}),
        )),
    }
}

/// POST/PUT /api/workbench/presets 请求体。
#[derive(Debug, Deserialize)]
pub struct PresetReq {
    pub name: String,
    pub config: serde_json::Value,
}

// ── runs handlers ──

/// POST /api/workbench/runs —— 提交 ensemble 运行（入队异步；201 返回 queued 行含钉住 config 快照）。
/// web 层预校验：symbol 非空 / period 合法 / from、to RFC3339 且 from<to / slots 非空 / fee 形状；
/// 服务层校验：版本 published、symbol 已注册、区间上限、配置合法性、bar 数护栏（§1.8）。
pub async fn submit_run(
    State(st): State<Arc<AppState>>,
    Json(req): Json<WorkbenchSubmitReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.symbol.trim().is_empty() {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::SYMBOL_REQUIRED,
            "symbol 必填",
            serde_json::json!({}),
        );
    }
    // ADR-024 P0 §5.1：周期白名单收敛为单一事实源——删手写 `matches!` 白名单，改调
    // `application::bar_map::parse_period`（与 MCP / 试算同源）；400 语义与可读消息保留。
    if let Err(e) = application::bar_map::parse_period(&req.period) {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::PERIOD_INVALID,
            &format!(
                "period 须为 {}（{e}）",
                application::bar_map::supported_backtest_periods().join("/")
            ),
            serde_json::json!({ "period": req.period, "supported": application::bar_map::supported_backtest_periods() }),
        );
    }
    let from = match DateTime::parse_from_rfc3339(&req.from) {
        Ok(t) => t.with_timezone(&Utc),
        Err(_) => {
            return structured(
                StatusCode::BAD_REQUEST,
                codes::TIMESTAMP_INVALID,
                "from 须为 RFC3339 时间戳",
                serde_json::json!({ "field": "from", "value": req.from }),
            )
        }
    };
    let to = match DateTime::parse_from_rfc3339(&req.to) {
        Ok(t) => t.with_timezone(&Utc),
        Err(_) => {
            return structured(
                StatusCode::BAD_REQUEST,
                codes::TIMESTAMP_INVALID,
                "to 须为 RFC3339 时间戳",
                serde_json::json!({ "field": "to", "value": req.to }),
            )
        }
    };
    if from >= to {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::FROM_AFTER_TO,
            "from 须早于 to",
            serde_json::json!({ "from": req.from, "to": req.to }),
        );
    }
    if req.slots.is_empty() {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::SLOTS_INVALID,
            "slots 必填（1..=10）",
            serde_json::json!({ "got": 0 }),
        );
    }
    // fee 缺省（None）= 按标的 type 解析（ADR-019 D11-3）→ 仅显式传入时做形状校验。
    if let Some(fee) = &req.fee {
        if let Err(e) = crate::dto::validate_backtest_fee(fee) {
            return match e {
                crate::dto::FieldError::BadRequest(m) | crate::dto::FieldError::Unprocessable(m) => {
                    structured(StatusCode::BAD_REQUEST, codes::FEE_INVALID, &m, serde_json::json!({}))
                }
            };
        }
    }
    // 400 上下文（ADR-024 §3.1.1：detail 至少含 `period`（有则））；`req.period` 随后被移入 submit。
    let period_ctx = serde_json::json!({ "period": req.period.clone() });
    let submit = SubmitRunReq {
        name: req.name.unwrap_or_default(),
        symbol: req.symbol,
        period: req.period,
        from,
        to,
        slots: req
            .slots
            .into_iter()
            .map(|s| SlotReq { version_id: s.version_id, params: s.params, weight: s.weight })
            .collect(),
        buy_threshold: req.buy_threshold,
        sell_threshold: req.sell_threshold,
        policy: req.policy,
        stop: req.stop,
        initial_capital: req.initial_capital,
        // I-2/D6：前置预热根数（缺省 250）。
        warmup_bars: req
            .warmup_bars
            .unwrap_or(application::workbench::DEFAULT_WARMUP_BARS),
        fee: req.fee,
        confirm: req.confirm,
    };
    match svc.submit(submit).await {
        Ok(run) => (StatusCode::CREATED, Json(run)).into_response(),
        Err(e) => map_svc_err_ctx(e, period_ctx),
    }
}

/// GET /api/workbench/available_range?symbol=&period= —— 可得区间（ADR-024 P5 §5.2）。
/// 供前端日期控件 min/max 随「标的+周期」联动；无数据 → 200 且 `available_from/to` 为 null。
pub async fn available_range(
    State(st): State<Arc<AppState>>,
    Query(q): Query<AvailableRangeQuery>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if q.symbol.trim().is_empty() {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::SYMBOL_REQUIRED,
            "symbol 必填",
            serde_json::json!({}),
        );
    }
    if let Err(e) = bar_map::parse_period(&q.period) {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::PERIOD_INVALID,
            &format!(
                "period 须为 {}（{e}）",
                bar_map::supported_backtest_periods().join("/")
            ),
            serde_json::json!({ "period": q.period }),
        );
    }
    match svc.available_range(&q.symbol, &q.period).await {
        Ok(range) => Json(serde_json::json!({
            "symbol": q.symbol.trim(),
            "period": q.period,
            "available_from": range.map(|r| r.from.to_rfc3339()),
            "available_to": range.map(|r| r.to.to_rfc3339()),
        }))
        .into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs —— 列表（status 过滤 + limit/offset 分页；轻量不含结果）。
pub async fn list_runs(
    State(st): State<Arc<AppState>>,
    Query(q): Query<WorkbenchListQuery>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let status = match q.status.as_deref() {
        None => None,
        Some(s) => match StrategyRunStatus::parse(s) {
            Some(v) => Some(v),
            None => {
                return structured(
                    StatusCode::BAD_REQUEST,
                    codes::STATUS_INVALID,
                    "status 须为 queued/running/succeeded/failed/canceled",
                    serde_json::json!({ "status": s }),
                )
            }
        },
    };
    let filter = StrategyRunFilter {
        status,
        limit: q.limit.clamp(1, MAX_WORKBENCH_LIMIT),
        offset: q.offset.max(0),
    };
    match svc.list_runs(&filter).await {
        Ok(runs) => Json(runs).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/workbench/runs/{id} —— 单 run 详情（404）。
pub async fn get_run(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.get_run(&id).await {
        Ok(run) => Json(run).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/result —— 运行结果（**兼容**）。
/// `legacy_single`：全量返回（旧前端不破）；`chunked_v1`：`summary` + 首页 per_bar + `has_more`
/// + `next_offset`（默认页 5000，**显式**截断非静默）。未成功/未知 → 404。
pub async fn get_result(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.result_compat(&id, BARS_LIMIT_DEFAULT).await {
        Ok(res) => Json(res).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/brief —— 轻量摘要（status/progress/metrics/result_format/
/// chunk_count/bars_total 等；列表/轮询用）。未成功但有 run 行也返回（result_format=None）。
pub async fn get_brief(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.result_brief(&id).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/bars?kind=&offset=&limit= 或 ...&from=&to= —— 分页/区间读。
/// `kind ∈ per_bar|net_value|drawdown`（缺省 per_bar；`fills` 走专用端点）；
/// `offset/limit` 与 `from/to` **互斥**（同给 ⇒ 400）；
/// `limit` 缺省 5000/上限 20000；区间读可能含 chunk 外沿并由服务端按 ts 过滤。
pub async fn get_bars(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<BarsQuery>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let kind = match parse_series_kind(q.kind.as_deref(), ResultKind::PerBar) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let has_paging = q.offset.is_some() || q.limit.is_some();
    let has_range = q.from.is_some() || q.to.is_some();
    if has_paging && has_range {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::REQUEST_INVALID,
            "offset/limit 与 from/to 互斥，不得同时给",
            serde_json::json!({}),
        );
    }
    let window = if has_range {
        let (Some(from_s), Some(to_s)) = (q.from.as_deref(), q.to.as_deref()) else {
            return structured(
                StatusCode::BAD_REQUEST,
                codes::REQUEST_INVALID,
                "区间读须同时给 from 与 to",
                serde_json::json!({}),
            );
        };
        let from = match DateTime::parse_from_rfc3339(from_s) {
            Ok(t) => t.with_timezone(&Utc),
            Err(_) => {
                return structured(
                    StatusCode::BAD_REQUEST,
                    codes::TIMESTAMP_INVALID,
                    "from 须为 RFC3339 时间戳",
                    serde_json::json!({ "field": "from", "value": from_s }),
                )
            }
        };
        let to = match DateTime::parse_from_rfc3339(to_s) {
            Ok(t) => t.with_timezone(&Utc),
            Err(_) => {
                return structured(
                    StatusCode::BAD_REQUEST,
                    codes::TIMESTAMP_INVALID,
                    "to 须为 RFC3339 时间戳",
                    serde_json::json!({ "field": "to", "value": to_s }),
                )
            }
        };
        if from > to {
            return structured(
                StatusCode::BAD_REQUEST,
                codes::FROM_AFTER_TO,
                "from 须不晚于 to",
                serde_json::json!({ "from": from_s, "to": to_s }),
            );
        }
        BarsWindow::Range { from, to }
    } else {
        let offset = q.offset.unwrap_or(0).max(0);
        let limit = q.limit.unwrap_or(BARS_LIMIT_DEFAULT).clamp(1, BARS_LIMIT_MAX);
        BarsWindow::Offset { offset, limit }
    };
    match svc.result_bars(&id, kind, window).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/curve?k=&kind=&from_ts=&to_ts= —— **显式抽样**曲线（均匀保首尾）。
/// 响应带 `downsampled` + `original_bars`（ADR-024 D10；`kind` 缺省 net_value）；
/// ADR-028 D3：`from_ts`/`to_ts` 时间窗（闭区间，缺省全区间 = 行为与今日一致），窗口内**重新采样**，
/// 响应回显 `window_from_ts`/`window_to_ts`/`window_bars`（窗口内原始根数 = 采样分母）。
pub async fn get_curve(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<CurveQuery>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let kind = match parse_series_kind(q.kind.as_deref(), ResultKind::NetValue) {
        Ok(k) => k,
        Err(r) => return r,
    };
    if let (Some(f), Some(t)) = (q.from_ts, q.to_ts) {
        if f > t {
            return structured(
                StatusCode::BAD_REQUEST,
                codes::FROM_AFTER_TO,
                "from_ts 须不晚于 to_ts",
                serde_json::json!({ "from_ts": f, "to_ts": t }),
            );
        }
    }
    match svc.result_curve_window(&id, kind, q.k, q.from_ts, q.to_ts).await {
        Ok(c) => Json(c).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/fills?offset=&limit=&round_trip= —— **成交明细分页读**（ADR-024 P6）。
/// 有界精确源：`kind='fills'` 单块（chunked）/ 内联 per_bar 事件派生（legacy）；
/// `limit` 缺省 5000/上限 20000；响应含 `total` 与 `recorded`（区分「无成交」与「未写」）。
/// ADR-027 §5.4：元素增 `rt_seq`/`trade_value`/`commission`/`stamp_duty`；增可选 `round_trip` 过滤。
/// 用于 **K 线买卖标记**与成交核对；**禁止**用抽样曲线（丢真实成交）或 `trades`
/// （仅完全平仓时合成 ⇒ 部分买入/加仓/部分卖出不进 `trades`）代替。
pub async fn get_fills(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<FillsQuery>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let offset = q.offset.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(BARS_LIMIT_DEFAULT).clamp(1, BARS_LIMIT_MAX);
    match svc.result_fills_filtered(&id, offset, limit, q.round_trip).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/round-trips?offset=&limit= —— **L1 回合列表**（ADR-027 D8 懒加载首屏）。
///
/// 元素 = 02-spec §1.2 全字段 + 摘要（`l2_count`/`buy_count`/`sell_count`）；
/// 响应自述完整性（`total`/`recorded`/`has_more`/`next_offset`，ADR-027 D11）。
/// 错误语义与 `/result` 同：run 未知 / 无结果 ⇒ 404。
pub async fn get_round_trips(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<RoundTripsQuery>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let offset = q.offset.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(BARS_LIMIT_DEFAULT).clamp(1, BARS_LIMIT_MAX);
    match svc.result_round_trips(&id, offset, limit).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/round-trips/{rt_seq}/fills?offset=&limit= —— **L2 逐笔切片**（ADR-027 §5.3）。
///
/// 归属**只能**由 `rt_seq` 决定（D6：禁 `[open_bar, close_bar]` 窗口推断）；
/// **未知 `rt_seq` ⇒ 404**（禁止空数组冒充「无成交」，D8/D11）。
pub async fn get_round_trip_fills(
    State(st): State<Arc<AppState>>,
    Path((id, rt_seq)): Path<(String, u32)>,
    Query(q): Query<RoundTripsQuery>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let offset = q.offset.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(BARS_LIMIT_DEFAULT).clamp(1, BARS_LIMIT_MAX);
    match svc.result_round_trip_fills(&id, rt_seq, offset, limit).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/runs/{id}/audit —— **执行完整度审计**（ADR-026 §2.2；只读派生）。
///
/// 返回 ADR-026 §2.2 冻结字段（`recorded` / `deployed_*`（敞口）/ `cash_consumed*`（含佣金）/
/// `planned_tranches` / `reachable_batches` / `batches_done` / `unexecuted_orders` / `last_bar_unfilled` /
/// `round_trips_*` / `warnings[]`）；**非阻断**：`warnings` 仅信息，不改变引擎行为、不影响既有响应。
/// 错误语义：运行不存在 / 无结果 → 404（复用既有错误码体系，与 `/result`、`/fills` 同）。
///
/// 可观测性（ADR-026 §4）：发 `tracing` span，含 `trace_id`/`run_id`/`deployed_pct`/
/// `unexecuted_orders`/warnings 数（与仓内 `p4b.segment` 同风格；审计请求自成一个 trace）。
pub async fn get_audit(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let trace_id = domain::types::new_trace_id();
    let span = tracing::info_span!(
        "workbench_run_audit",
        trace_id = %trace_id,
        run_id = %id,
        deployed_pct = tracing::field::Empty,
        unexecuted_orders = tracing::field::Empty,
        warnings = tracing::field::Empty,
    );
    let t0 = std::time::Instant::now();
    let out = svc.run_audit(&id).instrument(span.clone()).await;
    match out {
        Ok(a) => {
            span.record("deployed_pct", a.report.deployed_pct);
            span.record("unexecuted_orders", a.report.unexecuted_orders as i64);
            span.record("warnings", a.report.warnings.len() as i64);
            span.in_scope(|| {
                tracing::info!(
                    trace_id = %trace_id,
                    run_id = %id,
                    deployed_pct = a.report.deployed_pct,
                    cash_consumed_pct = a.report.cash_consumed_pct,
                    recorded = a.report.recorded,
                    unexecuted_orders = a.report.unexecuted_orders,
                    warnings = a.report.warnings.len(),
                    elapsed_us = t0.elapsed().as_micros() as u64,
                    "workbench_run_audit"
                )
            });
            Json(a).into_response()
        }
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/workbench/runs/{id}/cancel —— 协作式取消（queued/running；终态 → 409，未知 → 404）。
pub async fn cancel_run(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.cancel(&id).await {
        Ok(run) => Json(run).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/workbench/runs/compare —— 多 run 并排对比（净值**抽样**默认 k=2000 + 绩效；输入序；
/// 未知/未成功跳过）。ADR-024 D9/D10：禁止 N × 全量净值，响应带 `downsampled`/`original_bars`。
pub async fn compare_runs(
    State(st): State<Arc<AppState>>,
    Json(req): Json<WorkbenchCompareReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.ids.is_empty() {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::IDS_REQUIRED,
            "ids 必填（run id 数组）",
            serde_json::json!({}),
        );
    }
    let k = req.k.unwrap_or(COMPARE_K_DEFAULT).clamp(1, application::workbench::CURVE_K_MAX);
    match svc.compare_sampled(&req.ids, k).await {
        Ok(items) => Json(items).into_response(),
        Err(e) => internal(e),
    }
}

// ── presets handlers ──

/// POST /api/workbench/presets —— 新建组合预设（config 校验+钉住；201；重名 409）。
pub async fn create_preset(
    State(st): State<Arc<AppState>>,
    Json(req): Json<PresetReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.name.trim().is_empty() {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::NAME_REQUIRED,
            "name 必填",
            serde_json::json!({}),
        );
    }
    match svc.create_preset(&req.name, &req.config).await {
        Ok(row) => (StatusCode::CREATED, Json(row)).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/workbench/presets —— 全部预设（created_at ASC）。
pub async fn list_presets(State(st): State<Arc<AppState>>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.list_presets().await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/workbench/presets/{id} —— 预设详情（404）。
pub async fn get_preset(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.get_preset(&id).await {
        Ok(row) => Json(row).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// PUT /api/workbench/presets/{id} —— 更新预设（name trim 非空；config 同 create 校验；404/409）。
pub async fn update_preset(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<PresetReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.name.trim().is_empty() {
        return structured(
            StatusCode::BAD_REQUEST,
            codes::NAME_REQUIRED,
            "name 必填",
            serde_json::json!({}),
        );
    }
    match svc.update_preset(&id, &req.name, &req.config).await {
        Ok(row) => Json(row).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// DELETE /api/workbench/presets/{id} —— 删除预设（200 / 404）。
pub async fn delete_preset(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.delete_preset(&id).await {
        Ok(()) => Json(serde_json::json!({ "deleted": true })).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/workbench/presets/{id}/apply —— 返回钉住 config（供 submit 用；404）。
pub async fn apply_preset(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.apply_preset(&id).await {
        Ok(config) => Json(config).into_response(),
        Err(e) => map_svc_err(e),
    }
}

// ── WS 进度分发 sink（§1.8 WS）──

/// 策略运行进度 WS sink（web 实现 `domain::ports::StrategyRunProgressSink`）。
/// 持有 `WsHub`，把 application 层引擎 observer 进度回调发布为
/// `{type:"strategy_run_progress", run_id, progress, bar_ts}`；
/// 客户端经 `topic:"strategy_run"` + `strategy_run_id` 订阅过滤（复用 SubscriptionRegistry）。
pub struct WorkbenchWsSink {
    hub: WsHub,
}

impl WorkbenchWsSink {
    pub fn new(hub: WsHub) -> Self {
        Self { hub }
    }
}

#[async_trait::async_trait]
impl StrategyRunProgressSink for WorkbenchWsSink {
    /// 每次引擎 observer 进度帧发布一帧；无订阅者时 `broadcast::send` 返回 Err，由 `WsHub::publish` 忽略。
    async fn send(
        &self,
        run_id: &str,
        progress: f64,
        bar_ts: Option<DateTime<Utc>>,
    ) -> anyhow::Result<()> {
        self.hub.publish(PushMsg::StrategyRunProgress {
            run_id: run_id.to_string(),
            progress,
            bar_ts,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 引擎 observer 进度帧 → hub 广播 → 订阅者收到对应帧（run_id/progress/bar_ts 透传）。
    #[tokio::test]
    async fn sink_publishes_progress_to_hub() {
        let hub = WsHub::new();
        let mut rx = hub.subscribe();
        let sink = WorkbenchWsSink::new(hub.clone());
        let ts = Utc.with_ymd_and_hms(2026, 9, 9, 2, 0, 0).unwrap();

        sink.send("sr_1_000001", 0.42, Some(ts)).await.unwrap();

        match rx.recv().await.unwrap() {
            PushMsg::StrategyRunProgress { run_id, progress, bar_ts } => {
                assert_eq!(run_id, "sr_1_000001");
                assert!((progress - 0.42).abs() < 1e-12);
                assert_eq!(bar_ts, Some(ts));
            }
            other => panic!("应为 strategy_run_progress，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn sink_ignores_no_subscriber() {
        // 无订阅者时 publish 返回 Err，sink 应吞掉（WsHub::publish 忽略）——send 不报错。
        let hub = WsHub::new();
        let sink = WorkbenchWsSink::new(hub);
        assert!(sink.send("sr_x", 0.0, None).await.is_ok(), "无订阅者不应报错");
    }
}
