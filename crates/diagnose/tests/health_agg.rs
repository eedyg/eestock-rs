// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/diagnose/tests/health_agg.rs>>[init]
//! 健康窗口聚合测试（Phase A 返工：聚合为纯函数，无 DB；DB 读路径由 storage 端口测试锁定，
//! 端到端由 web 集成测试 /api/sources/health 锁定）。

use chrono::{Duration, TimeZone, Utc};
use diagnose::health::{aggregate_events, CircuitState, HealthService, SourceHealth, StatusLight};
use domain::ports::{HealthEventRow, HealthEventsRead};

fn ev_for(src: &str, secs_ago: i64, ok: bool, latency: Option<i32>, err: Option<&str>) -> HealthEventRow {
    HealthEventRow {
        ts: Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap() - Duration::seconds(secs_ago),
        source: src.into(), ok, latency_ms: latency, err_kind: err.map(Into::into), code: None,
    }
}

fn one<'a>(rows: &'a [SourceHealth], src: &str) -> &'a SourceHealth {
    rows.iter().find(|r| r.source == src).expect("聚合结果含测试源")
}

#[test]
fn success_rate_excludes_na_and_percentiles() {
    let src = "diag_test_rate";
    let mut events = vec![
        ev_for(src, 100, true, Some(100), None),
        ev_for(src, 90, true, Some(300), None),
        ev_for(src, 80, false, None, Some("timeout")),
    ];
    for i in 0..3 { events.push(ev_for(src, 70 - i, true, None, Some("na"))); }

    let rows = aggregate_events(3600, events);
    let h = one(&rows, src);
    assert_eq!(h.attempts, 3, "na 不入分母（03 §7）");
    assert_eq!(h.successes, 2);
    assert!((h.success_rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
    assert_eq!(h.p50_ms, Some(200.0));
    assert_eq!(h.p95_ms, Some(290.0), "percentile_cont 线性插值口径");
    assert_eq!(h.last_error.as_ref().unwrap().err_kind.as_deref(), Some("timeout"));
    assert_eq!(h.circuit_state, CircuitState::Closed);
    assert_eq!(h.status, StatusLight::Degraded, "0.667 < 0.95");
}

#[test]
fn circuit_state_from_latest_migration_and_last_error_excludes_migrations() {
    let src = "diag_test_circuit";
    let events = vec![
        ev_for(src, 50, false, None, Some("http")),
        ev_for(src, 40, false, None, Some("circuit_open")),
    ];
    let rows = aggregate_events(3600, events);
    let h = one(&rows, src);
    assert_eq!(h.circuit_state, CircuitState::Open);
    assert_eq!(h.status, StatusLight::CircuitOpen);
    assert_eq!(h.last_error.as_ref().unwrap().err_kind.as_deref(), Some("http"),
        "熔断迁移事件不占最近错误位（是状态不是抓取错误）");

    // 手动复位 → 闭合
    let events2 = vec![
        ev_for(src, 50, false, None, Some("http")),
        ev_for(src, 40, false, None, Some("circuit_open")),
        ev_for(src, 30, false, None, Some("manual_reset")),
    ];
    assert_eq!(one(&aggregate_events(3600, events2), src).circuit_state,
        CircuitState::Closed, "手动复位 → 闭合");
}

#[test]
fn healthy_when_all_ok_and_multi_source_sorted() {
    let events = vec![
        ev_for("b_src", 20, true, Some(80), None),
        ev_for("a_src", 20, true, None, None),
        ev_for("a_src", 10, true, Some(200), None),
    ];
    let rows = aggregate_events(3600, events);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].source, "a_src", "输出按 source 排序");
    assert_eq!(rows[1].source, "b_src");
    let a = one(&rows, "a_src");
    assert_eq!(a.success_rate, Some(1.0));
    assert_eq!(a.status, StatusLight::Healthy);
    assert_eq!(a.p50_ms, Some(200.0), "仅 ok 且带 latency 的事件计入分位数");
}

/// HealthService 经 domain 端口注入（mock 读端，证明 diagnose 与 storage 解耦）。
struct MockEvents(Vec<HealthEventRow>);

#[async_trait::async_trait]
impl HealthEventsRead for MockEvents {
    async fn window_events(&self, _window_secs: i64) -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn health_service_aggregates_via_injected_port() {
    let svc = HealthService::new(std::sync::Arc::new(MockEvents(
        vec![ev_for("mock_src", 10, true, Some(80), None)])));
    let rows = svc.aggregate(3600).await.unwrap();
    assert_eq!(one(&rows, "mock_src").success_rate, Some(1.0));
}
// ~/~ end
