// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/diagnose/src/health.rs>>[init]
//! 源健康窗口聚合（纯应用服务）：成功率（分母排除 err_kind='na'，03 §7）、延迟分位数、熔断态、最近错误。
//! 分层红线（Phase A 审查返工）：diagnose 不依赖 sqlx——窗口事件经 domain::ports::HealthEventsRead
//! 注入，聚合为纯函数（可离线 TDD；口径与初版 SQL 聚合一致，05 §1）。

use anyhow::Result;
use chrono::{DateTime, Utc};
use domain::ports::{HealthEventRow, HealthEventsRead};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// 熔断状态（由窗口内最近一条熔断迁移事件推导）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitState { Closed, HalfOpen, Open }

/// 状态灯（05 §1）：Healthy=无熔断且成功率≥95%（或无统计事件）；Degraded=<95%；CircuitOpen=熔断中。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusLight { Healthy, Degraded, CircuitOpen }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastError {
    pub err_kind: Option<String>,
    pub ts: DateTime<Utc>,
    pub code: Option<String>,   // 触发标的（源级事件为 None）
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceHealth {
    pub source: String,
    pub window_secs: i64,
    /// 成功率分母：窗口内非 na 事件数（03 §7：na=非交易时段可达，不入分母）。
    pub attempts: i64,
    pub successes: i64,
    /// attempts=0 → None（无统计意义，前端显示 —）。
    pub success_rate: Option<f64>,
    /// 延迟分位数：窗口内 ok=true 且 latency_ms 非空事件（05 §1；na 事件延迟照计）。
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub circuit_state: CircuitState,
    pub status: StatusLight,
    pub last_error: Option<LastError>,
    pub last_event_ts: Option<DateTime<Utc>>,
}

pub fn success_rate(successes: i64, attempts: i64) -> Option<f64> {
    if attempts <= 0 { None } else { Some(successes as f64 / attempts as f64) }
}

pub fn circuit_state_of(last_kind: Option<&str>) -> CircuitState {
    match last_kind {
        Some("circuit_open") => CircuitState::Open,
        Some("circuit_halfopen") => CircuitState::HalfOpen,
        // circuit_closed / manual_reset / 无迁移事件 → 闭合
        _ => CircuitState::Closed,
    }
}

pub fn status_of(circuit: CircuitState, rate: Option<f64>) -> StatusLight {
    match circuit {
        CircuitState::Open => StatusLight::CircuitOpen,
        _ => match rate {
            Some(r) if r < 0.95 => StatusLight::Degraded,
            _ => StatusLight::Healthy,
        },
    }
}

/// percentile_cont（PG 线性插值口径）：p∈[0,1]，空样本 → None。
pub fn percentile_cont(xs: &[f64], p: f64) -> Option<f64> {
    if xs.is_empty() { return None; }
    let mut v = xs.to_vec();
    v.sort_by(f64::total_cmp);
    let rank = p * (v.len() - 1) as f64;
    let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
    Some(v[lo] + (v[hi] - v[lo]) * (rank - lo as f64))
}

fn is_na(e: &HealthEventRow) -> bool { e.err_kind.as_deref() == Some("na") }

/// 熔断迁移类事件（circuit_* / manual_reset）：是状态不是抓取错误，不占 last_error 位。
fn is_circuit_migration(e: &HealthEventRow) -> bool {
    matches!(e.err_kind.as_deref(),
        Some("circuit_open") | Some("circuit_halfopen")
        | Some("circuit_closed") | Some("manual_reset"))
}

/// 窗口聚合纯函数（diagnose 唯一业务逻辑）：
/// 按 source 归组排序 → 计数（na 出分母）→ 分位数 → 熔断态（最近迁移事件）→ 最近非迁移错误。
pub fn aggregate_events(window_secs: i64, events: Vec<HealthEventRow>) -> Vec<SourceHealth> {
    let mut by_source: HashMap<String, Vec<HealthEventRow>> = HashMap::new();
    for e in events { by_source.entry(e.source.clone()).or_default().push(e); }
    let mut out: Vec<SourceHealth> = by_source.into_iter().map(|(source, mut evs)| {
        evs.sort_by_key(|e| e.ts);
        let attempts = evs.iter().filter(|e| !is_na(e)).count() as i64;
        let successes = evs.iter().filter(|e| e.ok && !is_na(e)).count() as i64;
        let lats: Vec<f64> = evs.iter()
            .filter(|e| e.ok && e.latency_ms.is_some())
            .map(|e| e.latency_ms.expect("filtered") as f64)
            .collect();
        let rate = success_rate(successes, attempts);
        let circuit = circuit_state_of(evs.iter().rev().find(|e| is_circuit_migration(e))
            .and_then(|e| e.err_kind.as_deref()));
        let last_error = evs.iter().rev()
            .find(|e| !e.ok && !is_circuit_migration(e))
            .map(|e| LastError { err_kind: e.err_kind.clone(), ts: e.ts, code: e.code.clone() });
        SourceHealth {
            source, window_secs, attempts, successes,
            success_rate: rate,
            p50_ms: percentile_cont(&lats, 0.5),
            p95_ms: percentile_cont(&lats, 0.95),
            circuit_state: circuit,
            status: status_of(circuit, rate),
            last_error,
            last_event_ts: evs.last().map(|e| e.ts),
        }
    }).collect();
    out.sort_by(|a, b| a.source.cmp(&b.source));
    out
}

/// 健康查询服务（Application）：注入只读端口；聚合全部走纯函数。
pub struct HealthService {
    reader: Arc<dyn HealthEventsRead>,
}

impl HealthService {
    pub fn new(reader: Arc<dyn HealthEventsRead>) -> Self { Self { reader } }

    /// REST /api/sources/health 与 WS health 推送共用入口。
    pub async fn aggregate(&self, window_secs: i64) -> Result<Vec<SourceHealth>> {
        let events = self.reader.window_events(window_secs).await?;
        Ok(aggregate_events(window_secs, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_rate_denominator_semantics() {
        assert_eq!(success_rate(2, 3), Some(2.0 / 3.0));
        assert_eq!(success_rate(0, 0), None, "窗口内无统计事件（全 na）→ None");
        assert_eq!(success_rate(0, 3), Some(0.0));
    }

    #[test]
    fn circuit_state_mapping() {
        assert_eq!(circuit_state_of(Some("circuit_open")), CircuitState::Open);
        assert_eq!(circuit_state_of(Some("circuit_halfopen")), CircuitState::HalfOpen);
        assert_eq!(circuit_state_of(Some("circuit_closed")), CircuitState::Closed);
        assert_eq!(circuit_state_of(Some("manual_reset")), CircuitState::Closed, "手动复位 → 闭合");
        assert_eq!(circuit_state_of(None), CircuitState::Closed);
    }

    #[test]
    fn status_light_matrix() {
        assert_eq!(status_of(CircuitState::Open, Some(1.0)), StatusLight::CircuitOpen);
        assert_eq!(status_of(CircuitState::HalfOpen, Some(0.99)), StatusLight::Healthy);
        assert_eq!(status_of(CircuitState::Closed, Some(0.94)), StatusLight::Degraded, "05 §1 边界 95%");
        assert_eq!(status_of(CircuitState::Closed, Some(0.95)), StatusLight::Healthy);
        assert_eq!(status_of(CircuitState::Closed, None), StatusLight::Healthy,
            "无统计事件（非交易时段全 na）不算降级");
    }

    #[test]
    fn percentile_cont_pg_linear_interpolation() {
        assert_eq!(percentile_cont(&[], 0.5), None);
        assert_eq!(percentile_cont(&[42.0], 0.95), Some(42.0));
        assert_eq!(percentile_cont(&[100.0, 300.0], 0.5), Some(200.0));
        assert_eq!(percentile_cont(&[100.0, 300.0], 0.95), Some(290.0),
            "与 PG percentile_cont 线性插值一致（rank=p*(n-1)）");
        // 乱序输入
        assert_eq!(percentile_cont(&[300.0, 100.0, 200.0], 0.5), Some(200.0));
    }
}
// ~/~ end
