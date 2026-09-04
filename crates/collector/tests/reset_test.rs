// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/reset_test.rs>>[init]
//! ResetWatcher（§10，Wave 1 Phase C）：DB 控制通道消费 → CircuitRegistry.manual_reset。

mod common;

use chrono::{TimeZone, Utc};
use collector::circuit::CircuitRegistry;
use collector::clock::FakeClock;
use collector::reset::ResetWatcher;
use common::MemSink;
use domain::ports::{CircuitResetChannel, HealthMonitor, ResetRequest};
use domain::types::SourceId;
use std::sync::{Arc, Mutex};

/// 内存复位通道：take_pending 弹出并清空（模拟原子消费）。
#[derive(Default)]
struct MemChannel {
    pending: Mutex<Vec<ResetRequest>>,
}

#[async_trait::async_trait]
impl CircuitResetChannel for MemChannel {
    async fn take_pending(&self) -> anyhow::Result<Vec<ResetRequest>> {
        Ok(std::mem::take(&mut *self.pending.lock().unwrap()))
    }
}

fn fixture() -> (Arc<ResetWatcher>, Arc<MemChannel>, Arc<CircuitRegistry>, Arc<MemSink>) {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()));
    let sink = Arc::new(MemSink::default());
    let circuits = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock, sink.clone()));
    let channel = Arc::new(MemChannel::default());
    let watcher = Arc::new(ResetWatcher::new(channel.clone(), circuits.clone()));
    (watcher, channel, circuits, sink)
}

#[tokio::test]
async fn pending_reset_applied_and_event_emitted() {
    const S: SourceId = SourceId::TencentIfzq;
    let (watcher, channel, circuits, sink) = fixture();
    // 先打到熔断：连续 3 次失败 → Open
    for _ in 0..3 { circuits.report_failure(S, "http").await; }
    assert_eq!(circuits.state(S).await, collector::circuit::CircuitState::Open);

    channel.pending.lock().unwrap()
        .push(ResetRequest { id: 1, source: S.as_str().into() });
    let applied = watcher.poll_once().await.unwrap();
    assert_eq!(applied, 1);
    assert_eq!(circuits.state(S).await, collector::circuit::CircuitState::Healthy,
        "消费后任意态 → Healthy");
    assert!(sink.kinds().contains(&Some("manual_reset".into())),
        "复位事件由数据面单写者发出");
    assert!(channel.pending.lock().unwrap().is_empty(), "请求已被取走（原子消费）");
}

#[tokio::test]
async fn unknown_source_skipped_and_empty_is_noop() {
    let (watcher, channel, circuits, _sink) = fixture();
    channel.pending.lock().unwrap()
        .push(ResetRequest { id: 2, source: "no_such_source".into() });
    let applied = watcher.poll_once().await.unwrap();
    assert_eq!(applied, 0, "未知 source 跳过不 panic");
    // 空队列：0 且不产生任何事件
    assert_eq!(watcher.poll_once().await.unwrap(), 0);
    assert_eq!(circuits.state(SourceId::SinaJsonp).await,
        collector::circuit::CircuitState::Healthy, "未受影响源保持原态");
}
// ~/~ end
