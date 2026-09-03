// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/executor_test.rs>>[init]
//! FetchExecutor：首源成功不转移 / NoData 不计失败 / RateLimited 走退避不进熔断 /
//! 全链失败产出 code 级事件 / 当班源链首 / Trace ID 贯穿。

mod common;

use chrono::{TimeZone, Utc};
use collector::circuit::CircuitRegistry;
use collector::clock::FakeClock;
use collector::executor::*;
use common::*;
use domain::ports::HealthMonitor;
use domain::provider::ProviderError;
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;
use std::collections::HashMap;
use std::sync::Arc;

fn setup(t: Arc<MockMinute>, s: Arc<MockMinute>)
    -> (Arc<FetchExecutor>, Arc<MemWriter>, Arc<MemSink>, Arc<CircuitRegistry>) {
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let sink = Arc::new(MemSink::default());
    let writer = Arc::new(MemWriter::default());
    let circuits = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock.clone(), sink.clone()));
    let mut providers: HashMap<SourceId, Arc<dyn domain::provider::MinuteKlineProvider>> = HashMap::new();
    providers.insert(SourceId::TencentIfzq, t);
    providers.insert(SourceId::SinaJsonp, s);
    let ex = Arc::new(FetchExecutor::new(
        providers,
        SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]),
        DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
        circuits.clone(), writer.clone(), sink.clone(), clock));
    (ex, writer, sink, circuits)
}

#[tokio::test]
async fn first_source_success_no_failover() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::TencentIfzq)])]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::SinaJsonp)])]));
    let (ex, writer, sink, _c) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    // 当班源（duty）放链首：用 duty_for 对齐期望
    let duty = duty_for(&DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
                        &code, Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap());
    let out = ex.fetch_one(&code, 10).await;
    let FetchOutcome::Ok { source, inserted, .. } = out else { panic!("应成功: {out:?}") };
    assert_eq!(source, duty, "当班源健康时先试当班源");
    assert_eq!(inserted, 1);
    let other_calls = if duty == SourceId::TencentIfzq { s.calls() } else { t.calls() };
    assert_eq!(other_calls, 0, "首源成功不转移");
    // 成功事件 + Trace ID 贯穿
    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].ok && events[0].err_kind.is_none() && events[0].latency_ms.is_some());
    assert_eq!(events[0].trace_id.as_deref().map(str::len), Some(32));
    assert_eq!(writer.bars.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn nodata_marks_na_no_failover_no_circuit() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![Err(ProviderError::NoData), Err(ProviderError::NoData)]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp, vec![Err(ProviderError::NoData), Err(ProviderError::NoData)]));
    let (ex, _w, sink, circuits) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    let duty = duty_for(&DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
                        &code, Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap());
    let other = if duty == SourceId::TencentIfzq { s.clone() } else { t.clone() };
    assert_eq!(ex.fetch_one(&code, 10).await, FetchOutcome::NoData);
    assert_eq!(other.calls(), 0, "NoData 不转移（本批次终止）");
    assert_eq!(sink.kinds(), vec![Some("na".to_string())], "ok=true + err_kind=na");
    // NoData 不计失败：连续两次后源仍健康
    assert_eq!(ex.fetch_one(&code, 10).await, FetchOutcome::NoData);
    assert!(circuits.healthy_minute_sources().await.contains(&duty));
}

#[tokio::test]
async fn rate_limited_failover_no_circuit_trip() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![
        Err(ProviderError::RateLimited), Err(ProviderError::RateLimited),
        Err(ProviderError::RateLimited), Ok(vec![bar("518880", 1, 35, SourceId::TencentIfzq)])]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::SinaJsonp)])]));
    let (ex, _w, sink, circuits) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    let out = ex.fetch_one(&code, 10).await;
    assert!(matches!(out, FetchOutcome::Ok { source: SourceId::SinaJsonp, .. }),
            "RateLimited 应转移下一源: {out:?}");
    assert!(sink.kinds().contains(&Some("rate_limited".into())));
    // 连续 3 次 RateLimited 不触发熔断（不进熔断计数）
    for _ in 0..3 { let _ = ex.fetch_one(&code, 10).await; }
    assert!(circuits.healthy_minute_sources().await.contains(&SourceId::TencentIfzq)
        || matches!(circuits.health(SourceId::TencentIfzq).await, Health::Degraded),
        "限流只进退避档，不熔断");
}

#[tokio::test]
async fn all_failed_emits_code_level_event_and_counts_circuit() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![Err(ProviderError::Timeout)]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp, vec![Err(ProviderError::Http("x".into()))]));
    let (ex, _w, sink, _c) = setup(t.clone(), s.clone());
    let code = Code("518880".into());
    assert_eq!(ex.fetch_one(&code, 10).await, FetchOutcome::AllFailed);
    let kinds = sink.kinds();
    assert!(kinds.contains(&Some("timeout".into())) && kinds.contains(&Some("http".into())),
            "每源失败事件分源记录: {kinds:?}");
    assert_eq!(kinds.last().unwrap(), &Some("all_failed".into()), "全链失败产出 code 级事件");
    // code 级事件带 code、trace 贯穿全链同一 trace_id
    let events = sink.events.lock().unwrap();
    let traces: std::collections::HashSet<_> = events.iter().filter_map(|e| e.trace_id.clone()).collect();
    assert_eq!(traces.len(), 1, "单次抓取全链共享同一 Trace ID");
    assert_eq!(events.last().unwrap().code, Some(Code("518880".into())));
}

#[tokio::test]
async fn circuit_open_source_excluded_from_chain() {
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![])); // 不会被调用
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp,
        vec![Ok(vec![bar("518880", 1, 35, SourceId::SinaJsonp)])]));
    let (ex, _w, _sink, circuits) = setup(t.clone(), s.clone());
    for _ in 0..3 { circuits.report_failure(SourceId::TencentIfzq, "http").await; }
    let out = ex.fetch_one(&Code("518880".into()), 10).await;
    assert!(matches!(out, FetchOutcome::Ok { source: SourceId::SinaJsonp, .. }));
    assert_eq!(t.calls(), 0, "熔断源不出现在 attempt_chain");
}
// ~/~ end
