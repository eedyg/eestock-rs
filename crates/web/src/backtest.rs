//! 回测 REST handlers + WS 进度 sink（Wave 3 Phase 3c；设计契约见 design/07-app-plane/00-web-api.md §1.5）。
//!
//! ⚠️ **非 tangle 手写**（ADR-007 例外）：本文件为新增功能模块，代码块不入 design 文档，
//! 契约描述在 design/07-app-plane/00-web-api.md §1.5（端点表 / DTO / WS topic / DI）。
//!
//! 分层：web（Presentation）经 `application::BacktestService`（Application）+ `domain::ports::BacktestProgressSink`
//! 访问回测能力；`storage` 实现（BacktestBarReader/PgBacktestStore）与 WS 进度 sink 由 app bin 装配注入。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use std::sync::Arc;

use application::types::{SubmitOutcome, SubmitReq};
use domain::ports::{BacktestProgressSink, RunFilter, RunStatus};

use crate::dto::*;
use crate::state::AppState;
use crate::ws::{PushMsg, WsHub};

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "backtest handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

fn field_err(e: FieldError) -> Response {
    match e {
        FieldError::BadRequest(m) => err(StatusCode::BAD_REQUEST, &m),
        FieldError::Unprocessable(m) => err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    }
}

// ── REST handlers（§1.5 端点表）──────────────────────────────────────────────

/// GET /api/backtest/strategies —— 内置策略目录（id/name/description/params_schema，恰 7 款）。
/// `params_schema` 直通 backtest::ParamDef 的 JSON 形态（每项为 `{key,label,kind}`）。
pub async fn strategies(State(st): State<Arc<AppState>>) -> Response {
    let catalog = st.backtest.strategies();
    let list: Vec<BacktestStrategyDto> = catalog
        .into_iter()
        .map(|s| BacktestStrategyDto {
            id: s.id,
            name: s.name,
            description: s.description,
            params_schema: s
                .params_schema
                .iter()
                .map(|p| serde_json::to_value(p).expect("参数 schema 可序列化"))
                .collect(),
        })
        .collect();
    Json(list).into_response()
}

/// POST /api/backtest/runs —— 提交回测（单 run 或参数网格展开，入队异步）。
/// 校验：code 非空、period 合法、from/to RFC3339 且 from<to、fee 数值、strategy 存在、params 或 params_grid 其一。
pub async fn submit_run(
    State(st): State<Arc<AppState>>,
    Json(req): Json<BacktestSubmitReq>,
) -> Response {
    if req.code.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "code 必填");
    }
    if let Err(e) = validate_backtest_period(&req.period) {
        return field_err(e);
    }
    if let Err(e) = validate_backtest_params_present(&req.params, &req.params_grid) {
        return field_err(e);
    }
    if let Err(e) = validate_backtest_fee(&req.fee) {
        return field_err(e);
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
    // strategy 存在性 → 404（§1.5：0-shot，与 BacktestService::submit 的预校验双保险）
    if !st.backtest.strategies().iter().any(|s| s.id == req.strategy_id) {
        return err(StatusCode::NOT_FOUND, &format!("未知策略 id: {}", req.strategy_id));
    }
    let submit = SubmitReq {
        code: req.code.clone(),
        period: req.period.clone(),
        from,
        to,
        strategy_id: req.strategy_id.clone(),
        params: req.params.clone(),
        params_grid: req.params_grid.clone(),
        fee: req.fee.clone(),
        initial_capital: req.initial_capital,
    };
    match st.backtest.submit(submit).await {
        Ok(SubmitOutcome::Run(id)) => Json(serde_json::json!({ "run_id": id })).into_response(),
        Ok(SubmitOutcome::Group(gid)) => {
            // 网格展开：返回 group_id + 该组子任务 run_ids（复用 list_runs 按 group 过滤）
            let filter = RunFilter { group_id: Some(gid.clone()), status: None, ..Default::default() };
            match st.backtest.list_runs(&filter).await {
                Ok(runs) => {
                    let run_ids: Vec<i64> = runs.iter().map(|r| r.id).collect();
                    Json(serde_json::json!({ "group_id": gid, "run_ids": run_ids })).into_response()
                }
                Err(e) => internal(e),
            }
        }
        Err(e) => {
            // submit 预校验失败兜底（未知周期/策略已前置拦截；网格畸形/区间无数据等在此 400）
            err(StatusCode::BAD_REQUEST, &e.to_string())
        }
    }
}

/// GET /api/backtest/runs —— 列表（`status`/`group_id` 过滤 + `limit`/`offset` 分页；**轻量：不含结果列**）。
pub async fn list_runs(
    State(st): State<Arc<AppState>>,
    Query(q): Query<BacktestListQuery>,
) -> Response {
    let status = match q.status.as_deref() {
        None => None,
        Some(s) => match RunStatus::parse(s) {
            Some(v) => Some(v),
            None => return err(StatusCode::BAD_REQUEST, "status 须为 pending/running/done/failed"),
        },
    };
    // limit clamp 1-500（单页上限），offset 非负（越界仅返回空页）。
    let filter = RunFilter {
        status,
        group_id: q.group_id.clone(),
        limit: q.limit.clamp(1, MAX_BACKTEST_LIMIT),
        offset: q.offset.max(0),
    };
    match st.backtest.list_runs(&filter).await {
        Ok(runs) => Json(runs.iter().map(BacktestRunDto::from).collect::<Vec<_>>()).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /api/backtest/runs/{id} —— 单 run 详情（净值/交易/指标；未完成时结果字段省略）。
pub async fn get_run(State(st): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    match st.backtest.get_run(id).await {
        Ok(Some(run)) => Json(BacktestRunDto::from(&run)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "run 不存在"),
        Err(e) => internal(e),
    }
}

/// DELETE /api/backtest/runs/{id} —— 删除 run（其结果由 FK 级联删除；200=deleted / 404=not found）。
pub async fn delete_run(State(st): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    match st.backtest.delete_run(id).await {
        Ok(true) => Json(serde_json::json!({ "deleted": true })).into_response(),
        Ok(false) => err(StatusCode::NOT_FOUND, "run 不存在"),
        Err(e) => internal(e),
    }
}

/// GET /api/backtest/compare?ids=1,2,3 —— 多 run 对比（只含 store 存在的 run）。
pub async fn compare_runs(
    State(st): State<Arc<AppState>>,
    Query(q): Query<BacktestCompareQuery>,
) -> Response {
    let ids = match parse_backtest_ids(&q.ids) {
        Ok(ids) => ids,
        Err(e) => return field_err(e),
    };
    match st.backtest.compare(&ids).await {
        Ok(runs) => Json(runs.iter().map(BacktestRunDto::from).collect::<Vec<_>>()).into_response(),
        Err(e) => internal(e),
    }
}

// ── WS 进度分发 sink（§1.5 WS）──────────────────────────────────────────────

/// 回测进度 WS sink（web 实现 `domain::ports::BacktestProgressSink`）。
/// 持有 `WsHub`，把 application 层引擎进度回调发布为 `{type:"backtest_progress", run_id, pct, bar_ts}`；
/// 客户端经 `topic:"backtest"` + `run_id` 订阅过滤（`SubscriptionRegistry`/`handle_socket` 复用）。
pub struct BacktestWsSink {
    hub: WsHub,
}

impl BacktestWsSink {
    pub fn new(hub: WsHub) -> Self {
        Self { hub }
    }
}

#[async_trait::async_trait]
impl BacktestProgressSink for BacktestWsSink {
    /// 每次引擎进度回调发布一帧；无订阅者时 `broadcast::send` 返回 Err，由 `WsHub::publish` 忽略。
    async fn send(&self, run_id: i64, pct: i32, bar_ts: Option<DateTime<Utc>>) -> anyhow::Result<()> {
        self.hub.publish(PushMsg::BacktestProgress { run_id, pct, bar_ts });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 引擎进度回调 → hub 广播 → 订阅者收到对应帧（run_id/pct/bar_ts 透传）。
    #[tokio::test]
    async fn sink_publishes_progress_to_hub() {
        let hub = WsHub::new();
        let mut rx = hub.subscribe();
        let sink = BacktestWsSink::new(hub.clone());
        let ts = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();

        sink.send(42, 50, Some(ts)).await.unwrap();

        match rx.recv().await.unwrap() {
            PushMsg::BacktestProgress { run_id, pct, bar_ts } => {
                assert_eq!(run_id, 42);
                assert_eq!(pct, 50);
                assert_eq!(bar_ts, Some(ts));
            }
            other => panic!("应为 backtest_progress，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn sink_ignores_no_subscriber() {
        // 无订阅者时 publish 返回 Err，sink 应吞掉（WsHub::publish 忽略）——send 不报错。
        let hub = WsHub::new();
        let sink = BacktestWsSink::new(hub);
        assert!(sink.send(1, 0, None).await.is_ok(), "无订阅者不应报错");
    }
}
