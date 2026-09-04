// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/web/src/alerts.rs>>[init]
//! 页面⑦ 告警中心 REST handlers + 评估推送循环（Wave 2 Phase B；契约 07-alerts §6）。
//! 由 design/07-app-plane/02-alerts.md tangle 生成（ADR-007），禁止手改。
//! 评估节拍驱动（默认 1min）→ AlertService.evaluate() → 新建/续触发/恢复事件经 WS hub 推送
//! {type:"alert", ...}（info/warning 静默入列表；critical 由前端 shell 右上角 toast 强弹）。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use domain::ports::{AlertEvent, AlertFilter, AlertLevel, AlertRule, AlertRulePatch, AlertStatus};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;
use crate::ws::PushMsg;

const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "alerts handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

// ── DTO（07-alerts §6 线格式；与前端 api/types.ts AlertEventItem/AlertRuleItem 对齐）──

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertEventDto {
    pub id: i64,
    pub rule_id: String,
    pub level: AlertLevel,
    pub source: String,
    pub message: String,
    pub status: AlertStatus,
    pub fire_count: i64,
    pub first_fired_at: DateTime<Utc>,
    pub last_fired_at: DateTime<Utc>,
    pub acked_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
}

impl From<&AlertEvent> for AlertEventDto {
    fn from(e: &AlertEvent) -> Self {
        AlertEventDto {
            id: e.id, rule_id: e.rule_id.clone(), level: e.level, source: e.source.clone(),
            message: e.message.clone(), status: e.status, fire_count: e.fire_count,
            first_fired_at: e.first_fired_at, last_fired_at: e.last_fired_at,
            acked_at: e.acked_at, resolved_at: e.resolved_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertRuleDto {
    pub id: String,
    pub name: String,
    pub level: AlertLevel,
    pub threshold: f64,
    pub duration_minutes: i64,
    pub silence_minutes: i64,
    pub enabled: bool,
}

impl From<&AlertRule> for AlertRuleDto {
    fn from(r: &AlertRule) -> Self {
        AlertRuleDto {
            id: r.id.clone(), name: r.name.clone(), level: r.level, threshold: r.threshold,
            duration_minutes: r.duration_minutes, silence_minutes: r.silence_minutes,
            enabled: r.enabled,
        }
    }
}

// ── GET /api/alerts?level=&from=&to=&source=&limit= ──

#[derive(Debug, Deserialize)]
pub struct AlertsQuery {
    pub level: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub source: Option<String>,
    pub limit: Option<i64>,
}

/// 过滤参数校验错误（小错误类型，与 dto.rs FieldError 同惯例；
/// 避免 Result<_, Response> 大 Err 变体——clippy result_large_err 收口）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterError(pub String);

/// 查询参数 → AlertFilter（非法值 FilterError → handler 映射 400；limit 默认 200 封顶 1000）。
pub fn parse_filter(q: AlertsQuery) -> Result<AlertFilter, FilterError> {
    let level = match q.level.as_deref() {
        None => None,
        Some(s) => Some(AlertLevel::parse(s)
            .ok_or_else(|| FilterError("level 须为 info/warning/critical".into()))?),
    };
    let parse_ts = |v: Option<String>, name: &str| -> Result<Option<DateTime<Utc>>, FilterError> {
        v.map(|s| DateTime::parse_from_rfc3339(&s)
            .map(|t| t.with_timezone(&Utc))
            .map_err(|_| FilterError(format!("{name} 须为 RFC3339 时间戳"))))
            .transpose()
    };
    Ok(AlertFilter {
        level,
        from: parse_ts(q.from, "from")?,
        to: parse_ts(q.to, "to")?,
        source: q.source.filter(|s| !s.is_empty()),
        limit: q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
    })
}

pub async fn list_alerts(State(st): State<Arc<AppState>>, Query(q): Query<AlertsQuery>) -> Response {
    let filter = match parse_filter(q) {
        Ok(f) => f,
        Err(e) => return err(StatusCode::BAD_REQUEST, &e.0),
    };
    match st.alerts.list(&filter).await {
        Ok(events) => Json(events.iter().map(AlertEventDto::from).collect::<Vec<_>>())
            .into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/alerts/{id}/ack —— 确认（记录确认时刻，持久化刷新不丢）。
/// 仅 triggered 可确认；已确认/已恢复/未知 id → 404（无可确认对象）。
pub async fn ack_alert(State(st): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    match st.alerts.ack(id).await {
        Ok(Some(ev)) => Json(AlertEventDto::from(&ev)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "告警不存在或不在未确认状态"),
        Err(e) => internal(e),
    }
}

// ── GET/PATCH /api/alert-rules（内置规则仅阈值/开关/静默时长可调，热生效）──

pub async fn list_rules(State(st): State<Arc<AppState>>) -> Response {
    match st.alerts.rules().await {
        Ok(rules) => Json(rules.iter().map(AlertRuleDto::from).collect::<Vec<_>>())
            .into_response(),
        Err(e) => internal(e),
    }
}

/// PATCH 请求体：id 定位规则；三项可调（None = 不改）。
#[derive(Debug, Deserialize)]
pub struct PatchRuleReq {
    pub id: String,
    pub threshold: Option<f64>,
    pub enabled: Option<bool>,
    pub silence_minutes: Option<i64>,
}

pub async fn patch_rule(State(st): State<Arc<AppState>>, Json(req): Json<PatchRuleReq>) -> Response {
    if req.id.trim().is_empty() { return err(StatusCode::BAD_REQUEST, "id 必填"); }
    if let Some(s) = req.silence_minutes {
        if s < 1 { return err(StatusCode::BAD_REQUEST, "silence_minutes 下限 1"); }
    }
    if let Some(t) = req.threshold {
        if !t.is_finite() || t < 0.0 {
            return err(StatusCode::BAD_REQUEST, "threshold 须为非负有限数");
        }
    }
    let patch = AlertRulePatch {
        threshold: req.threshold, enabled: req.enabled, silence_minutes: req.silence_minutes,
    };
    match st.alerts.update_rule(&req.id, &patch).await {
        Ok(Some(r)) => Json(AlertRuleDto::from(&r)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "规则不存在（内置规则预置，不可增删）"),
        Err(e) => internal(e),
    }
}

/// 评估推送循环（与 ws::Poller 同模式；ADR-017：推送源 = 应用面节拍读库，无数据面直连）。
/// 每轮评估后：fired（新建/续触发）与 resolved（恢复）事件逐一发布 {type:"alert"}。
pub struct AlertEvaluator {
    state: Arc<AppState>,
    interval: Duration,
}

impl AlertEvaluator {
    pub fn new(state: Arc<AppState>, interval: Duration) -> Self { Self { state, interval } }

    pub async fn run(self) {
        loop {
            if let Err(e) = self.tick().await {
                tracing::warn!(error = %e, "alert evaluator tick failed");
            }
            tokio::time::sleep(self.interval).await;
        }
    }

    /// 单轮评估 + 推送（测试可直调）。
    pub async fn tick(&self) -> anyhow::Result<()> {
        let outcome = self.state.alerts.evaluate().await?;
        for ev in outcome.fired.iter().chain(outcome.resolved.iter()) {
            self.state.hub.publish(PushMsg::Alert(AlertEventDto::from(ev)));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_filter_validation_and_defaults() {
        let f = parse_filter(AlertsQuery { level: None, from: None, to: None,
            source: None, limit: None }).unwrap();
        assert_eq!(f.limit, 200, "默认 200");
        let f = parse_filter(AlertsQuery { level: Some("warning".into()), from: None, to: None,
            source: Some("tencent_qt".into()), limit: Some(99999) }).unwrap();
        assert_eq!(f.level, Some(AlertLevel::Warning));
        assert_eq!(f.limit, 1000, "封顶 1000");
        assert_eq!(f.source.as_deref(), Some("tencent_qt"));
        assert!(parse_filter(AlertsQuery { level: Some("crit".into()), from: None, to: None,
            source: None, limit: None }).is_err(), "非法级别 400");
        let e = parse_filter(AlertsQuery { level: None, from: Some("x".into()), to: None,
            source: None, limit: None }).unwrap_err();
        assert_eq!(e, super::FilterError("from 须为 RFC3339 时间戳".into()), "小错误类型载错误文案");
    }

    #[test]
    fn dto_serializes_snake_case_enums() {
        let ev = AlertEvent {
            id: 7, rule_id: "collection_stall".into(), level: AlertLevel::Critical,
            source: "collector".into(), message: "停摆".into(), status: AlertStatus::Triggered,
            fire_count: 3, first_fired_at: Utc::now(), last_fired_at: Utc::now(),
            acked_at: None, resolved_at: None,
        };
        let v = serde_json::to_value(AlertEventDto::from(&ev)).unwrap();
        assert_eq!(v["level"], "critical");
        assert_eq!(v["status"], "triggered");
        assert_eq!(v["fire_count"], 3);
        assert!(v["acked_at"].is_null());
    }
}
// ~/~ end
