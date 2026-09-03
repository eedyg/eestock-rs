// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/standby_test.rs>>[init]
//! StandbyReserve：近似 bar 合成 / 乱序轮询 / Tier2 指数退避 / 降级集管理。

mod common;

use chrono::{Duration, TimeZone, Utc};
use collector::clock::FakeClock;
use collector::standby::StandbyReserve;
use common::*;
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use std::sync::{Arc, Mutex};

struct MockSnap {
    id: SourceId,
    results: Mutex<Vec<Result<Vec<Quote>, ProviderError>>>,
    calls: Mutex<usize>,
}
impl MockSnap {
    fn new(id: SourceId, results: Vec<Result<Vec<Quote>, ProviderError>>) -> Self {
        Self { id, results: Mutex::new(results), calls: Mutex::new(0) }
    }
}
#[async_trait::async_trait]
impl SnapshotProvider for MockSnap {
    fn id(&self) -> SourceId { self.id }
    async fn fetch_snapshot(&self, _codes: &[Code]) -> Result<Vec<Quote>, ProviderError> {
        *self.calls.lock().unwrap() += 1;
        let mut g = self.results.lock().unwrap();
        if g.is_empty() { Err(ProviderError::NoData) } else { g.remove(0) }
    }
}

#[test]
fn synthesize_approx_bar_from_quotes() {
    let code = Code("518880".into());
    let q1 = quote("518880", 8.9, 1000, 8900.0, SourceId::TencentQt);
    let q2 = quote("518880", 8.95, 1600, 14300.0, SourceId::TencentQt);
    let m = Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap();
    // 首个快照：volume/amount 估算为 0（无差分基准）
    let b1 = StandbyReserve::synthesize(&code, &q1, None, m);
    assert_eq!((b1.open, b1.high, b1.low, b1.close), (8.9, 8.9, 8.9, 8.9));
    assert_eq!(b1.volume, 0);
    assert_eq!(b1.source, SourceId::TencentQtApprox, "source=*_approx 物理可区分");
    assert!(b1.source.is_approx());
    // 有前快照：差分估算
    let b2 = StandbyReserve::synthesize(&code, &q2, Some(&q1), m);
    assert_eq!(b2.volume, 600);
    assert!((b2.amount - 5400.0).abs() < 1e-9);
}

#[test]
fn poll_delay_in_5_to_10s_and_backoff_exponential() {
    let mut rng = rand::thread_rng();
    for _ in 0..100 {
        let d = StandbyReserve::next_poll_delay(&mut rng);
        assert!((5..=10).contains(&d.as_secs()), "5-10s 含抖动: {d:?}");
    }
    assert_eq!(StandbyReserve::tier2_backoff(0), Duration::seconds(10));
    assert_eq!(StandbyReserve::tier2_backoff(1), Duration::seconds(20));
    assert_eq!(StandbyReserve::tier2_backoff(9), Duration::seconds(300), "封顶 300s");
}

#[tokio::test]
async fn poll_once_success_then_volume_diff() {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 20).unwrap()));
    let p = Arc::new(MockSnap::new(SourceId::TencentQt, vec![
        Ok(vec![quote("518880", 8.9, 1000, 8900.0, SourceId::TencentQt)]),
        Ok(vec![quote("518880", 8.95, 1600, 14300.0, SourceId::TencentQt)]),
    ]));
    let pool: Vec<Arc<dyn SnapshotProvider>> = vec![p];
    let standby = StandbyReserve::new(pool, clock.clone());
    let code = Code("518880".into());
    standby.activate(&code);
    assert!(standby.is_degraded(&code));
    let b1 = standby.poll_once(&code).await.unwrap();
    assert_eq!(b1.ts, Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap(), "分钟边界对齐");
    assert_eq!(b1.volume, 0);
    clock.advance(Duration::seconds(60));
    let b2 = standby.poll_once(&code).await.unwrap();
    assert_eq!(b2.volume, 600, "跨快照量差分估算");
    assert_eq!(b2.source, SourceId::TencentQtApprox);
    standby.deactivate(&code);
    assert!(!standby.is_degraded(&code));
}

#[tokio::test]
async fn tier2_failure_backs_off_source() {
    // 单源池（确定性）：失败 → 指数退避冷却，退避期内不再请求该源（不轰击）
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let bad = Arc::new(MockSnap::new(SourceId::ThsCs, vec![
        Err(ProviderError::Timeout), Err(ProviderError::Timeout), Err(ProviderError::Timeout)]));
    let pool: Vec<Arc<dyn SnapshotProvider>> = vec![bad.clone()];
    let standby = StandbyReserve::new(pool, clock.clone());
    let code = Code("518880".into());
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 1);
    clock.advance(Duration::seconds(5)); // 退避 10s 未到期
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 1, "退避期内不再请求该源（不轰击）");
    clock.advance(Duration::seconds(6)); // 退避到期
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 2, "退避到期后可再试");
    clock.advance(Duration::seconds(15)); // 第二次退避 20s 未到期
    assert!(standby.poll_once(&code).await.is_err());
    assert_eq!(*bad.calls.lock().unwrap(), 2, "退避档 ×2 生效");
}

#[tokio::test]
async fn poll_falls_through_shuffled_pool_to_healthy_source() {
    // 首源失败 → 乱序池中落到健康源（每次随机打乱，行为口径：任一可用源即可承接）
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let bad = Arc::new(MockSnap::new(SourceId::ThsCs, vec![
        Err(ProviderError::Timeout), Err(ProviderError::Timeout), Err(ProviderError::Timeout),
        Err(ProviderError::Timeout), Err(ProviderError::Timeout)]));
    let good = Arc::new(MockSnap::new(SourceId::SinaHq, vec![
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)]),
        Ok(vec![quote("518880", 8.9, 0, 0.0, SourceId::SinaHq)])]));
    let pool: Vec<Arc<dyn SnapshotProvider>> = vec![bad.clone(), good.clone()];
    let standby = StandbyReserve::new(pool, clock.clone());
    let code = Code("518880".into());
    let b = standby.poll_once(&code).await.unwrap();
    assert_eq!(b.source, SourceId::SinaHqApprox, "坏源失败应由健康源承接");
}

#[test]
fn should_probe_recover_only_when_tier1_available() {
    assert!(!StandbyReserve::should_probe_recover(&[]));
    assert!(StandbyReserve::should_probe_recover(&[SourceId::SinaJsonp]));
}
// ~/~ end
