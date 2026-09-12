//! 策略 Registry REST handlers（12-strategy-system / P2a；设计契约 ADR 12-strategy-system §5/§13.5）。
//!
//! ⚠️ **非 tangle 手写**（ADR-007 例外，与 backtest.rs/simlive.rs 同模式）：本文件为新增功能模块；
//! `lib.rs` 路由与 `state.rs` 的 `AppState.strategies` 字段为 tangle 加法（00-web-api.md）。
//!
//! 分层：web（Presentation）经 `application::StrategyService`（Application）访问 Registry 能力；
//! `storage::strategy::PgStrategyStore` 由 app bin 装配注入；`storage` 不进正常依赖图（仅 dev-deps）。
//!
//! 错误语义：未注册/未找到 404（StrategyNotFound）、非法状态流转 409（StrategyInvalidTransition）、
//! 校验失败 400（StrategyValidation / web 层入参校验）；服务未装配 → 503。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

/// 策略编程手册全文（design/12-strategy-system/04-strategy-programming-guide.md；
/// include_str! 静态内嵌——手册为架构师主笔事实源，仓外不读盘，随二进制分发）。
/// GET /api/strategies/guide 与 MCP strategy_guide 双通道共用同一字节。
const STRATEGY_GUIDE: &str =
    include_str!("../../../design/12-strategy-system/04-strategy-programming-guide.md");
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::sync::Arc;

use application::strategy::{
    CreateStrategyInput, StrategyInvalidTransition, StrategyNotFound, StrategyService,
    StrategyValidation, TestRunMode, TestRunRequest, TestRunSource, UpdateDraftOutcome,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind};

use crate::state::AppState;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "strategies handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// 服务错误 → HTTP 语义（404/409/400/500）。
fn map_svc_err(e: anyhow::Error) -> Response {
    if let Some(x) = e.downcast_ref::<StrategyNotFound>() {
        err(StatusCode::NOT_FOUND, &x.0)
    } else if let Some(x) = e.downcast_ref::<StrategyInvalidTransition>() {
        err(StatusCode::CONFLICT, &x.0)
    } else if let Some(x) = e.downcast_ref::<StrategyValidation>() {
        err(StatusCode::BAD_REQUEST, &x.0)
    } else {
        internal(e)
    }
}

/// 取注入的 StrategyService；未装配（None）→ 503（与 AppState.sim 同模式）。
/// （Err 载荷为 axum Response 属大类型——handler 短路返回模式既定，allow 之；与 rest.rs 同口径）
#[allow(clippy::result_large_err)]
fn svc(st: &Arc<AppState>) -> Result<Arc<StrategyService>, Response> {
    st.strategies
        .clone()
        .ok_or_else(|| err(StatusCode::SERVICE_UNAVAILABLE, "strategy registry 未配置（AppState.strategies=None）"))
}

// ── DTO ──

/// GET /api/strategies?level=&kind= 查询参数。
#[derive(Debug, Deserialize)]
pub struct CatalogQuery {
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

/// POST /api/strategies 请求体。
#[derive(Debug, Deserialize)]
pub struct CreateStrategyReq {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    pub code: String,
}

/// POST /api/strategies/{id}/versions 请求体（从指定版本新建 draft）。
#[derive(Debug, Deserialize)]
pub struct CreateDraftReq {
    pub from_version_id: String,
}

/// GET /api/strategies/manage?kind= 查询参数（P2b）。
#[derive(Debug, Deserialize)]
pub struct ManageQuery {
    #[serde(default)]
    pub kind: Option<String>,
}

/// PATCH /api/strategies/{id} 请求体（P2b：name/description 均可选，均空 → 400）。
#[derive(Debug, Deserialize)]
pub struct UpdateMetaReq {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// PUT /api/strategies/versions/{vid} 请求体（改 draft 代码；published → 自动新 draft）。
#[derive(Debug, Deserialize)]
pub struct UpdateDraftReq {
    pub code: String,
}

/// GET /api/strategies/versions/diff?from=&to= 查询参数。
#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// POST /api/strategies/test-run 请求体。
/// ⚠️ 字段口径：`code` = 策略插件 JS 源码（与 version_id 二选一）；`symbol` = 标的代码
/// （避免与策略 code 同名冲突，任务书「code(股票)」字段在 wire 格式上命名为 symbol）。
#[derive(Debug, Deserialize)]
pub struct TestRunReq {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    pub symbol: String,
    pub period: String,
    pub from: String,
    pub to: String,
    pub mode: String,
    /// I-2/D6：前置预热根数（缺省 250，与 MCP strategy_test_run 同口径）。
    #[serde(default)]
    pub warmup_bars: Option<usize>,
    /// I-3/D6 + D11-3：费用入参（省略/`null` = 按标的 type 查 `fee_profiles` 解析，
    /// 无档案 → 旧 ADR bt-1 默认；显式传对象整体优先）。
    #[serde(default)]
    pub fee: Option<serde_json::Value>,
    /// I-3/D6：执行策略（缺省 `{"LumpSum":{"position_pct":1.0}}`）。
    #[serde(default)]
    pub policy: Option<serde_json::Value>,
    /// I-3/D6：初始资金（缺省 100000）。
    #[serde(default)]
    pub initial_capital: Option<f64>,
}

/// 试算缺省前置预热根数（I-2/D6 架构师裁决；与 MCP 同值）。
pub const DEFAULT_TEST_RUN_WARMUP_BARS: usize = 250;

/// 试算缺省初始资金（与回测 ADR §4 一致）。
pub const DEFAULT_TEST_RUN_CAPITAL: f64 = 100_000.0;

// ── handlers ──

/// GET /api/strategies?level=&kind= —— catalog（仅 published，每策略最新 published 版本；
/// level at-least 过滤：backtest_ok/sim_ok/live_approved；kind: strategy/template）。
pub async fn catalog(State(st): State<Arc<AppState>>, Query(q): Query<CatalogQuery>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let level = match q.level.as_deref() {
        None => None,
        Some(s) => match ApprovalLevel::parse(s) {
            Some(l) => Some(l),
            None => return err(StatusCode::BAD_REQUEST, "level 须为 backtest_ok/sim_ok/live_approved"),
        },
    };
    let kind = match q.kind.as_deref() {
        None => None,
        Some(s) => match StrategyKind::parse(s) {
            Some(k) => Some(k),
            None => return err(StatusCode::BAD_REQUEST, "kind 须为 strategy/template"),
        },
    };
    match svc.catalog(level, kind).await {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/strategies —— 新建策略（v1 draft；201）。
pub async fn create_strategy(
    State(st): State<Arc<AppState>>,
    Json(req): Json<CreateStrategyReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.name.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "name 必填");
    }
    if req.code.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "code 必填");
    }
    let kind = match req.kind.as_deref() {
        None => StrategyKind::Strategy,
        Some(s) => match StrategyKind::parse(s) {
            Some(k) => k,
            None => return err(StatusCode::BAD_REQUEST, "kind 须为 strategy/template"),
        },
    };
    let input = CreateStrategyInput {
        name: req.name.clone(),
        description: req.description.clone().unwrap_or_default(),
        kind,
        code: req.code.clone(),
    };
    match svc.create_strategy(&input).await {
        Ok((strategy, version)) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "strategy": strategy, "version": version })),
        )
            .into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/strategies/manage?kind= —— 管理列表（P2b：全部策略含仅 draft / 零版本；
/// 聚合 version_count / latest_version（版本号最大，任意状态）/ latest_published（无 → null））。
/// 响应 `{ items: [...] }`；kind 非法 → 400。
pub async fn manage_list(State(st): State<Arc<AppState>>, Query(q): Query<ManageQuery>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let kind = match q.kind.as_deref() {
        None => None,
        Some(s) => match StrategyKind::parse(s) {
            Some(k) => Some(k),
            None => return err(StatusCode::BAD_REQUEST, "kind 须为 strategy/template"),
        },
    };
    match svc.manage_list(kind).await {
        Ok(items) => Json(serde_json::json!({ "items": items })).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// PATCH /api/strategies/{id} —— 更新策略元数据（P2b：name/description 均可选；
/// 均空 / name trim 后空 → 400；未知 id → 404；200 返回更新后 strategy 行）。
pub async fn update_meta(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateMetaReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.update_meta(&id, req.name.as_deref(), req.description.as_deref()).await {
        Ok(s) => Json(s).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/strategies/{id} —— 策略详情（404）。
pub async fn get_strategy(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.get_strategy(&id).await {
        Ok(s) => Json(s).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/strategies/guide —— 策略编程手册全文（text/markdown；无需策略服务装配，
/// 静态内嵌内容恒可用）。⚠️ 静态段 `guide` 须先于 `{id}` 参数段注册（axum matchit 保证）。
pub async fn guide() -> Response {
    ([(axum::http::header::CONTENT_TYPE, "text/markdown; charset=utf-8")], STRATEGY_GUIDE)
        .into_response()
}

/// DELETE /api/strategies/{id} —— 删除策略（裁决 2026-09-10：仅当全部版本均为 draft
/// 或无版本时可删）。204 无体 / 404 未知 id / 409 含已发布版本（含已归档历史，文案
/// 「含已发布版本的策略不可删除，请归档」）。
pub async fn delete_strategy(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.delete_strategy(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/strategies/{id}/versions —— 版本列表（version 升序；策略不存在 404）。
pub async fn list_versions(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.list_versions(&id).await {
        Ok(vs) => Json(vs).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/strategies/{id}/versions —— 从指定版本新建 draft（回滚/派生；201）。
pub async fn create_draft_from(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<CreateDraftReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.from_version_id.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "from_version_id 必填");
    }
    match svc.create_draft_from(&id, &req.from_version_id).await {
        Ok(v) => (StatusCode::CREATED, Json(v)).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// PUT /api/strategies/versions/{vid} —— 改 draft 代码（draft 原地更新；
/// published → 自动落新 draft，ADR §13.5；archived → 409）。
pub async fn update_draft(
    State(st): State<Arc<AppState>>,
    Path(vid): Path<String>,
    Json(req): Json<UpdateDraftReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.code.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "code 必填");
    }
    match svc.update_draft(&vid, &req.code).await {
        Ok(UpdateDraftOutcome::Updated(v)) => {
            Json(serde_json::json!({ "outcome": "updated", "version": v })).into_response()
        }
        Ok(UpdateDraftOutcome::NewDraft(v)) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "outcome": "new_draft", "version": v })),
        )
            .into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/strategies/versions/{vid}/publish —— 发布（门禁冒烟通过才转 published；
/// 非 draft → 409，门禁失败 → 400）。
pub async fn publish_version(State(st): State<Arc<AppState>>, Path(vid): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.publish(&vid).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/strategies/versions/{vid}/archive —— 归档（仅 published → archived；其余 409）。
pub async fn archive_version(State(st): State<Arc<AppState>>, Path(vid): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.archive(&vid).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// GET /api/strategies/versions/diff?from=&to= —— 两版本代码（前端渲染 diff；任一未知 404）。
pub async fn diff_versions(State(st): State<Arc<AppState>>, Query(q): Query<DiffQuery>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let (Some(from), Some(to)) = (q.from.as_deref(), q.to.as_deref()) else {
        return err(StatusCode::BAD_REQUEST, "from/to 查询参数必填（版本 id）");
    };
    match svc.diff(from, to).await {
        Ok((from, to)) => Json(serde_json::json!({
            "from": { "id": from.id, "strategy_id": from.strategy_id,
                      "version": from.version, "status": from.status, "code": from.code },
            "to": { "id": to.id, "strategy_id": to.strategy_id,
                    "version": to.version, "status": to.status, "code": to.code },
        }))
        .into_response(),
        Err(e) => map_svc_err(e),
    }
}

/// POST /api/strategies/test-run —— 在线试算（同步；双模式 pure_score/sim_position；
/// 区间上限 D1≤5年 / 分钟级≤3个月；收紧 RuntimeLimits per_call 20ms/内存 32MB）。
pub async fn test_run(State(st): State<Arc<AppState>>, Json(req): Json<TestRunReq>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    let source = match (&req.code, &req.version_id) {
        (Some(code), None) => TestRunSource::Inline(code.clone()),
        (None, Some(vid)) => TestRunSource::VersionId(vid.clone()),
        _ => return err(StatusCode::BAD_REQUEST, "code 与 version_id 须且仅须提供一个"),
    };
    if req.symbol.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "symbol（标的代码）必填");
    }
    let mode = match req.mode.as_str() {
        "pure_score" => TestRunMode::PureScore,
        "sim_position" => TestRunMode::SimPosition,
        _ => return err(StatusCode::BAD_REQUEST, "mode 须为 pure_score/sim_position"),
    };
    let from = match DateTime::parse_from_rfc3339(&req.from) {
        Ok(t) => t.with_timezone(&Utc),
        Err(_) => return err(StatusCode::BAD_REQUEST, "from 须为 RFC3339 时间戳"),
    };
    let to = match DateTime::parse_from_rfc3339(&req.to) {
        Ok(t) => t.with_timezone(&Utc),
        Err(_) => return err(StatusCode::BAD_REQUEST, "to 须为 RFC3339 时间戳"),
    };
    if from >= to {
        return err(StatusCode::BAD_REQUEST, "from 须早于 to");
    }
    let run = TestRunRequest {
        source,
        params: req.params.clone().unwrap_or_else(|| serde_json::json!({})),
        symbol: req.symbol.clone(),
        period: req.period.clone(),
        from,
        to,
        mode,
        warmup_bars: req.warmup_bars.unwrap_or(DEFAULT_TEST_RUN_WARMUP_BARS),
        // ADR-019 D11-3：省略 → None，由服务层按标的 type 解析（不再在传输层硬编码缺省）。
        fee: req.fee.clone(),
        policy: req
            .policy
            .clone()
            .unwrap_or_else(|| serde_json::json!({"LumpSum": {"position_pct": 1.0}})),
        initial_capital: req.initial_capital.unwrap_or(DEFAULT_TEST_RUN_CAPITAL),
    };
    match svc.test_run(&run).await {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => map_svc_err(e),
    }
}
