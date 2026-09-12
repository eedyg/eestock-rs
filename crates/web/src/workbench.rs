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

use application::workbench::{
    SlotReq, SubmitRunReq, WorkbenchConflict, WorkbenchNotFound, WorkbenchService,
    WorkbenchValidation,
};
use domain::ports::{StrategyRunFilter, StrategyRunProgressSink, StrategyRunStatus};

use crate::state::AppState;
use crate::ws::{PushMsg, WsHub};

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "workbench handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// 服务错误 → HTTP 语义（404/409/400/500）。
fn map_svc_err(e: anyhow::Error) -> Response {
    if let Some(x) = e.downcast_ref::<WorkbenchNotFound>() {
        err(StatusCode::NOT_FOUND, &x.0)
    } else if let Some(x) = e.downcast_ref::<WorkbenchConflict>() {
        err(StatusCode::CONFLICT, &x.0)
    } else if let Some(x) = e.downcast_ref::<WorkbenchValidation>() {
        err(StatusCode::BAD_REQUEST, &x.0)
    } else {
        internal(e)
    }
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

/// POST /api/workbench/runs/compare 请求体。
#[derive(Debug, Deserialize)]
pub struct WorkbenchCompareReq {
    pub ids: Vec<String>,
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
        return err(StatusCode::BAD_REQUEST, "symbol 必填");
    }
    if !matches!(req.period.as_str(), "M1" | "M5" | "M15" | "H1" | "D1") {
        return err(StatusCode::BAD_REQUEST, "period 须为 M1/M5/M15/H1/D1");
    }
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
    if req.slots.is_empty() {
        return err(StatusCode::BAD_REQUEST, "slots 必填（1..=10）");
    }
    // fee 缺省（None）= 按标的 type 解析（ADR-019 D11-3）→ 仅显式传入时做形状校验。
    if let Some(fee) = &req.fee {
        if let Err(e) = crate::dto::validate_backtest_fee(fee) {
            return match e {
                crate::dto::FieldError::BadRequest(m) | crate::dto::FieldError::Unprocessable(m) => {
                    err(StatusCode::BAD_REQUEST, &m)
                }
            };
        }
    }
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
    };
    match svc.submit(submit).await {
        Ok(run) => (StatusCode::CREATED, Json(run)).into_response(),
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
                return err(
                    StatusCode::BAD_REQUEST,
                    "status 须为 queued/running/succeeded/failed/canceled",
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

/// GET /api/workbench/runs/{id}/result —— 运行结果（per_bar 全量五 jsonb；未成功/未知 → 404）。
pub async fn get_result(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    match svc.get_result(&id).await {
        Ok(res) => Json(res).into_response(),
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

/// POST /api/workbench/runs/compare —— 多 run 并排对比（net_value+metrics；输入序；未知/未成功跳过）。
pub async fn compare_runs(
    State(st): State<Arc<AppState>>,
    Json(req): Json<WorkbenchCompareReq>,
) -> Response {
    let svc = match svc(&st) { Ok(s) => s, Err(r) => return r };
    if req.ids.is_empty() {
        return err(StatusCode::BAD_REQUEST, "ids 必填（run id 数组）");
    }
    match svc.compare(&req.ids).await {
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
        return err(StatusCode::BAD_REQUEST, "name 必填");
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
        return err(StatusCode::BAD_REQUEST, "name 必填");
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
