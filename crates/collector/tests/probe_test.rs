// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/probe_test.rs>>[init]
//! 熔断低频探测任务（CircuitProber）装配级测试 —— tester 004 §3c 实盘复现的 fake-clock 版。
//! 缺陷 1 修复验收：HalfOpen 源冷却到期后探测自愈回切；探测失败重开熔断冷却翻倍；
//! 无 HalfOpen 源时整轮零调用（不占交易抓取通道）。

mod common;

use chrono::{Duration, TimeZone, Utc};
use collector::circuit::{CircuitRegistry, CircuitState};
use collector::clock::FakeClock;
use collector::executor::{FetchExecutor, FetchOutcome};
use collector::probe::CircuitProber;
use collector::standby::StandbyReserve;
use common::*;
use domain::ports::HealthMonitor;
use domain::provider::ProviderError;
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;
use std::collections::HashMap;
use std::sync::Arc;

const T: SourceId = SourceId::TencentIfzq;
const S: SourceId = SourceId::SinaJsonp;

type Providers = HashMap<SourceId, Arc<dyn domain::provider::MinuteKlineProvider>>;

struct Rig {
    prober: Arc<CircuitProber>,
    circuits: Arc<CircuitRegistry>,
    clock: Arc<FakeClock>,
    sink: Arc<MemSink>,
}

fn rig(t: Arc<MockMinute>, s: Arc<MockMinute>) -> Rig {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let sink = Arc::new(MemSink::default());
    let circuits = Arc::new(CircuitRegistry::new(vec![T, S], clock.clone(), sink.clone()));
    let registry = Arc::new(MemRegistry {
        codes: std::sync::Mutex::new(vec![(Code("518880".into()), 60)]) });
    let mut providers: Providers = HashMap::new();
    providers.insert(T, t);
    providers.insert(S, s);
    let prober = Arc::new(CircuitProber::new(
        providers, circuits.clone(), registry, sink.clone(), clock.clone()));
    Rig { prober, circuits, clock, sink }
}

#[tokio::test]
async fn halfopen_probe_success_closes_circuit_and_restores_source() {
    // 复现 tester 004 §3c：双源被杀 → Open → 冷却到期 HalfOpen → 网络恢复 → 探测闭合自愈
    let t = Arc::new(MockMinute::new(T, vec![Ok(vec![bar("518880", 1, 36, T)])]));
    let s = Arc::new(MockMinute::new(S, vec![Ok(vec![bar("518880", 1, 36, S)])]));
    let rig = rig(t.clone(), s.clone());
    // 双源各 3 连败 → 双 Open（模拟杀源）
    for _ in 0..3 {
        rig.circuits.report_failure(T, "timeout").await;
        rig.circuits.report_failure(S, "timeout").await;
    }
    assert!(rig.circuits.healthy_minute_sources().await.is_empty(), "双源熔断后健康池为空");
    // 冷却 60s 到期 → 懒迁移 HalfOpen（由探测任务触发，迁移事件落库）→ 单发探测
    rig.clock.advance(Duration::seconds(60));
    let probed = rig.prober.probe_round().await;
    assert_eq!(probed, 2, "两个 HalfOpen 源各单发探测一次");
    assert_eq!(t.calls(), 1, "单发轻量探测（每源一次）");
    assert_eq!(s.calls(), 1);
    // 探测成功 → 闭合熔断 + circuit_closed 事件 + 重回健康池（当班轮换恢复容量）
    assert_eq!(rig.circuits.state(T).await, CircuitState::Healthy);
    assert_eq!(rig.circuits.state(S).await, CircuitState::Healthy);
    assert!(rig.sink.kinds().contains(&Some("circuit_halfopen".into())));
    assert!(rig.sink.kinds().contains(&Some("circuit_closed".into())));
    let healthy = rig.circuits.healthy_minute_sources().await;
    assert!(healthy.contains(&T) && healthy.contains(&S));
    // §6 回切衔接：健康池非空 → degraded_loop 恢复探测口径放行（既有逻辑接管标的回切）
    assert!(StandbyReserve::should_probe_recover(&healthy));
}

#[tokio::test]
async fn probe_failure_reopens_with_doubled_cooldown() {
    // HalfOpen 探测失败 → 重开 Open、冷却 ×2（沿用既有封顶 30min 语义）
    let t = Arc::new(MockMinute::new(T, vec![
        Err(ProviderError::Timeout),              // 第一次探测仍失败（源未恢复）
        Ok(vec![bar("518880", 1, 38, T)]),      // 第二次探测（冷却翻倍到期后）成功
    ]));
    let s = Arc::new(MockMinute::new(S, vec![])); // s 健康，不参与探测
    let rig = rig(t.clone(), s.clone());
    for _ in 0..3 { rig.circuits.report_failure(T, "timeout").await; }
    rig.clock.advance(Duration::seconds(60));
    assert_eq!(rig.circuits.state(T).await, CircuitState::HalfOpen);
    // 探测失败 → 重开 Open，冷却 ×2 = 120s
    assert_eq!(rig.prober.probe_round().await, 1);
    assert_eq!(rig.circuits.state(T).await, CircuitState::Open);
    // 119s 内不再探测（冷却未到期 → halfopen_sources 为空 → 整轮零调用）
    rig.clock.advance(Duration::seconds(119));
    assert_eq!(rig.prober.probe_round().await, 0, "冷却未到期不探测");
    assert_eq!(t.calls(), 1, "未到期不再打扰源");
    // 120s 到期 → HalfOpen → 再探测成功闭合
    rig.clock.advance(Duration::seconds(1));
    assert_eq!(rig.prober.probe_round().await, 1);
    assert_eq!(rig.circuits.state(T).await, CircuitState::Healthy);
    assert!(rig.sink.kinds().contains(&Some("circuit_closed".into())));
}

#[tokio::test]
async fn probe_noop_without_halfopen_sources() {
    // 全部健康 → 整轮零探测（探测不占交易抓取通道）
    let t = Arc::new(MockMinute::new(T, vec![]));
    let s = Arc::new(MockMinute::new(S, vec![]));
    let rig = rig(t.clone(), s.clone());
    assert_eq!(rig.prober.probe_round().await, 0, "无 HalfOpen 源 → 整轮零探测");
    assert_eq!(t.calls(), 0);
    assert_eq!(s.calls(), 0);
}

#[tokio::test]
async fn probe_nodata_means_reachable_closes_circuit() {
    // NoData = 源应答正常（非交易时段/无数据）→ 视为存活闭合（与 executor na 口径一致）
    let t = Arc::new(MockMinute::new(T, vec![Err(ProviderError::NoData)]));
    let s = Arc::new(MockMinute::new(S, vec![]));
    let rig = rig(t.clone(), s.clone());
    for _ in 0..3 { rig.circuits.report_failure(T, "http").await; }
    rig.clock.advance(Duration::seconds(60));
    assert_eq!(rig.prober.probe_round().await, 1);
    assert_eq!(rig.circuits.state(T).await, CircuitState::Healthy, "NoData=源可达 → 闭合");
    assert!(rig.sink.kinds().contains(&Some("na".into())));
    assert!(rig.sink.kinds().contains(&Some("circuit_closed".into())));
}

#[tokio::test]
async fn full_recovery_cycle_degraded_code_returns_to_normal() {
    // tester 004 §3c 全链路装配级复现：双杀降级 → 恢复 → 探测闭合 → 正常链回切
    let t = Arc::new(MockMinute::new(T, vec![
        Err(ProviderError::Timeout), Err(ProviderError::Timeout), Err(ProviderError::Timeout),
        Ok(vec![bar("518880", 1, 36, T)]),  // 恢复：探测成功
        Ok(vec![bar("518880", 1, 37, T)]),  // 回切：正常链抓取
    ]));
    let s = Arc::new(MockMinute::new(S, vec![
        Err(ProviderError::Timeout), Err(ProviderError::Timeout), Err(ProviderError::Timeout),
        Ok(vec![bar("518880", 1, 36, S)]),  // 恢复：探测成功
        Ok(vec![bar("518880", 1, 37, S)]),  // 回切：正常链抓取
    ]));
    let rig = rig(t.clone(), s.clone());
    let writer = Arc::new(MemWriter::default());
    let standby = Arc::new(StandbyReserve::new(vec![], rig.clock.clone()));
    let mut providers: Providers = HashMap::new();
    providers.insert(T, t);
    providers.insert(S, s);
    let executor = Arc::new(FetchExecutor::new(
        providers,
        SourceSelector::new(vec![T, S]),
        DutyRoster::new([T, S]),
        rig.circuits.clone(), writer.clone(), rig.sink.clone(), rig.clock.clone()));
    let code = Code("518880".into());
    // 双杀：3 轮全链失败（装配路径驱动熔断，非直调 report_failure）→ 标的降级
    for _ in 0..3 {
        assert_eq!(executor.fetch_one(&code, 10).await, FetchOutcome::AllFailed);
    }
    standby.activate(&code);
    assert!(standby.is_degraded(&code));
    assert!(rig.circuits.healthy_minute_sources().await.is_empty(), "双源均熔断（HalfOpen 前）");
    // 网络恢复：冷却到期 → 探测闭合双源
    rig.clock.advance(Duration::seconds(60));
    assert_eq!(rig.prober.probe_round().await, 2);
    // 回切（degraded_loop 既有口径）：健康池非空 → 正常链探测成功 → 标的退出降级
    let healthy = rig.circuits.healthy_minute_sources().await;
    assert!(StandbyReserve::should_probe_recover(&healthy));
    let out = executor.fetch_one(&code, 10).await;
    assert!(matches!(out, FetchOutcome::Ok { .. }), "回切正常链成功: {out:?}");
    standby.deactivate(&code);
    assert!(!standby.is_degraded(&code));
}
// ~/~ end
