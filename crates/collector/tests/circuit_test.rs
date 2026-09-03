// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/circuit_test.rs>>[init]
//! 熔断状态机全迁移路径（fake clock + 内存 sink）。

mod common;

use chrono::{Duration, TimeZone, Utc};
use collector::circuit::{CircuitRegistry, CircuitState};
use collector::clock::FakeClock;
use common::MemSink;
use domain::ports::HealthMonitor;
use domain::types::{Health, SourceId};
use std::sync::Arc;

const S: SourceId = SourceId::TencentIfzq;

fn setup() -> (Arc<CircuitRegistry>, Arc<FakeClock>, Arc<MemSink>) {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()));
    let sink = Arc::new(MemSink::default());
    let reg = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock.clone(), sink.clone()));
    (reg, clock, sink)
}

#[tokio::test]
async fn three_failures_open_then_cooldown_halfopen_then_close() {
    let (reg, clock, sink) = setup();
    for _ in 0..2 { reg.report_failure(S, "http").await; }
    assert_eq!(reg.state(S).await, CircuitState::Healthy, "2 次失败不熔断");
    assert!(reg.healthy_minute_sources().await.contains(&S));
    reg.report_failure(S, "timeout").await;
    assert_eq!(reg.state(S).await, CircuitState::Open, "连续 3 次失败 → Open");
    assert!(!reg.healthy_minute_sources().await.contains(&S), "熔断源从健康池摘除");
    assert!(sink.kinds().contains(&Some("circuit_open".into())));
    assert_eq!(reg.health(S).await, Health::CircuitOpen);
    // 冷却 59s 仍 Open；60s 后懒迁移 HalfOpen + 事件
    clock.advance(Duration::seconds(59));
    assert_eq!(reg.state(S).await, CircuitState::Open);
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
    assert!(sink.kinds().contains(&Some("circuit_halfopen".into())));
    // HalfOpen 单次成功 → Healthy + circuit_closed
    reg.report_success(S, 100).await;
    assert_eq!(reg.state(S).await, CircuitState::Healthy);
    assert!(sink.kinds().contains(&Some("circuit_closed".into())));
    assert!(reg.healthy_minute_sources().await.contains(&S));
}

#[tokio::test]
async fn halfopen_failure_reopens_with_doubled_cooldown_capped_30min() {
    let (reg, clock, _sink) = setup();
    for _ in 0..3 { reg.report_failure(S, "http").await; }
    clock.advance(Duration::seconds(60));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
    reg.report_failure(S, "http").await; // HalfOpen 失败 → Open，冷却 ×2 = 120s
    assert_eq!(reg.state(S).await, CircuitState::Open);
    clock.advance(Duration::seconds(119));
    assert_eq!(reg.state(S).await, CircuitState::Open);
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
    // 连续翻倍封顶 30min：再失败 → 240s，再失败 → 480s ... 验证不超过 1800s
    let mut cooldown = 240u64;
    for _ in 0..6 {
        reg.report_failure(S, "http").await;
        clock.advance(Duration::seconds(cooldown.min(1800) as i64 - 1));
        assert_eq!(reg.state(S).await, CircuitState::Open, "冷却 {cooldown}s 未到不迁移");
        clock.advance(Duration::seconds(1));
        assert_eq!(reg.state(S).await, CircuitState::HalfOpen);
        reg.report_failure(S, "http").await; // 立即再打回 Open
        cooldown *= 2;
    }
    clock.advance(Duration::seconds(1800));
    assert_eq!(reg.state(S).await, CircuitState::HalfOpen, "冷却封顶 30min 后必到期");
}

#[tokio::test]
async fn rate_limited_backoff_ladder_not_circuit() {
    let (reg, clock, _sink) = setup();
    reg.report_failure(S, "rate_limited").await;
    assert_eq!(reg.state(S).await, CircuitState::Healthy, "限流不进熔断");
    assert_eq!(reg.health(S).await, Health::Degraded, "退避中为 Degraded");
    assert!(!reg.healthy_minute_sources().await.contains(&S), "退避期静默该源");
    clock.advance(Duration::seconds(5));
    assert!(reg.healthy_minute_sources().await.contains(&S), "5s 退避档到期恢复");
    reg.report_failure(S, "rate_limited").await;
    clock.advance(Duration::seconds(9));
    assert_eq!(reg.health(S).await, Health::Degraded, "第二档 10s 未到期");
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.health(S).await, Health::Healthy);
    reg.report_failure(S, "rate_limited").await;
    clock.advance(Duration::seconds(29));
    assert_eq!(reg.health(S).await, Health::Degraded, "第三档 30s 未到期");
    clock.advance(Duration::seconds(1));
    assert_eq!(reg.health(S).await, Health::Healthy);
    // 成功重置退避档
    reg.report_failure(S, "rate_limited").await;
    reg.report_success(S, 10).await;
    reg.report_failure(S, "rate_limited").await;
    clock.advance(Duration::seconds(5));
    assert_eq!(reg.health(S).await, Health::Healthy, "成功后退避档重置回 5s");
}

#[tokio::test]
async fn manual_reset_from_any_state() {
    let (reg, _clock, sink) = setup();
    for _ in 0..3 { reg.report_failure(S, "http").await; }
    assert_eq!(reg.state(S).await, CircuitState::Open);
    reg.manual_reset(S).await;
    assert_eq!(reg.state(S).await, CircuitState::Healthy);
    assert!(sink.kinds().contains(&Some("manual_reset".into())));
    assert!(reg.healthy_minute_sources().await.contains(&S));
}
// ~/~ end
