// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/tests/daily_sync.rs>>[init]
//! 日增量定时任务测试（fake clock + mock provider + 内存 store，不触网）。

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use domain::ports::{Clock, EventSink, HealthEvent};
use domain::provider::{HistoricalDataProvider, ProviderError};
use domain::types::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tushare::daily::*;

struct FakeClock(Mutex<DateTime<Utc>>);
impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> { *self.0.lock().unwrap() }
}

#[derive(Default)]
struct MemSink { events: Mutex<Vec<HealthEvent>> }
#[async_trait::async_trait]
impl EventSink for MemSink {
    async fn emit(&self, ev: HealthEvent) -> anyhow::Result<()> {
        self.events.lock().unwrap().push(ev);
        Ok(())
    }
}

#[derive(Default)]
struct MemStore {
    cps: Mutex<HashMap<String, NaiveDate>>,
    saved: Mutex<HashMap<String, usize>>,
    codes: Vec<String>,
}
#[async_trait::async_trait]
impl DailyStore for MemStore {
    async fn checkpoint(&self, code: &str) -> anyhow::Result<Option<NaiveDate>> {
        Ok(self.cps.lock().unwrap().get(code).cloned())
    }
    async fn save(&self, code: &str, bars: &[Bar], through: NaiveDate) -> anyhow::Result<u64> {
        self.cps.lock().unwrap().insert(code.to_string(), through);
        *self.saved.lock().unwrap().entry(code.to_string()).or_default() += bars.len();
        Ok(bars.len() as u64)
    }
    async fn enabled_codes(&self) -> anyhow::Result<Vec<String>> { Ok(self.codes.clone()) }
}

struct MockHist { results: Mutex<Vec<Result<Vec<Bar>, ProviderError>>>, calls: Mutex<usize> }
#[async_trait::async_trait]
impl HistoricalDataProvider for MockHist {
    fn id(&self) -> SourceId { SourceId::Tushare }
    async fn fetch_history(&self, _code: &Code, _period: Period,
                           _s: DateTime<Utc>, _e: DateTime<Utc>) -> Result<Vec<Bar>, ProviderError> {
        *self.calls.lock().unwrap() += 1;
        let mut g = self.results.lock().unwrap();
        if g.is_empty() { Err(ProviderError::Http("unexpected call".into())) } else { g.remove(0) }
    }
    fn supported_periods(&self) -> Vec<Period> { vec![Period::M1] }
}

fn mk_bar(code: &str) -> Bar {
    Bar {
        code: Code(code.into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 3, 7, 0, 0).unwrap(),
        open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
        source: SourceId::Tushare,
    }
}

fn setup(results: Vec<Result<Vec<Bar>, ProviderError>>, codes: Vec<&str>, cps: Vec<(&str, NaiveDate)>)
    -> (Arc<DailySync>, Arc<MockHist>, Arc<MemStore>, Arc<MemSink>) {
    let clock = Arc::new(FakeClock(Mutex::new(Utc.with_ymd_and_hms(2026, 9, 3, 7, 31, 0).unwrap()))); // 15:31 CST
    let sink = Arc::new(MemSink::default());
    let store = Arc::new(MemStore {
        codes: codes.into_iter().map(String::from).collect(),
        cps: Mutex::new(cps.into_iter().map(|(c, d)| (c.to_string(), d)).collect()),
        ..Default::default()
    });
    let hist = Arc::new(MockHist { results: Mutex::new(results), calls: Mutex::new(0) });
    let sync = Arc::new(DailySync::with_backoff(hist.clone(), store.clone(), sink.clone(),
        clock, std::time::Duration::ZERO));
    (sync, hist, store, sink)
}

#[test]
fn next_run_same_day_before_1530() {
    // 周四 10:00 CST = 02:00 UTC → 当日 15:30 CST = 07:30 UTC
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 0).unwrap();
    assert_eq!(next_run_after(now), Utc.with_ymd_and_hms(2026, 9, 3, 7, 30, 0).unwrap());
}

#[test]
fn next_run_after_1530_rolls_to_next_weekday() {
    // 周四 16:00 CST → 周五（09-04）15:30 CST
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 8, 0, 0).unwrap();
    assert_eq!(next_run_after(now), Utc.with_ymd_and_hms(2026, 9, 4, 7, 30, 0).unwrap());
    // 周五 16:00 CST → 下周一（09-07）15:30 CST（跳过周末）
    let fri = Utc.with_ymd_and_hms(2026, 9, 4, 8, 0, 0).unwrap();
    assert_eq!(next_run_after(fri), Utc.with_ymd_and_hms(2026, 9, 7, 7, 30, 0).unwrap());
    // 周六上午 → 下周一
    let sat = Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap();
    assert_eq!(next_run_after(sat), Utc.with_ymd_and_hms(2026, 9, 7, 7, 30, 0).unwrap());
}

#[test]
fn backoff_doubles_and_caps() {
    let base = std::time::Duration::from_secs(60);
    assert_eq!(retry_backoff(base, 0), std::time::Duration::from_secs(60));
    assert_eq!(retry_backoff(base, 1), std::time::Duration::from_secs(120));
    assert_eq!(retry_backoff(base, 2), std::time::Duration::from_secs(240));
    assert_eq!(retry_backoff(base, 9), std::time::Duration::from_secs(600), "封顶 10min");
}

#[tokio::test]
async fn incremental_from_checkpoint_and_events() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, hist, store, sink) = setup(
        vec![Ok(vec![mk_bar("518880")]), Ok(vec![mk_bar("159776")])],
        vec!["518880", "159776"], vec![("518880", cp), ("159776", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 2, bars: 2 });
    assert_eq!(store.saved.lock().unwrap()["518880"], 1);
    // checkpoint 推进到今日（2026-09-03）
    assert_eq!(store.cps.lock().unwrap()["518880"], NaiveDate::from_ymd_opt(2026, 9, 3).unwrap());
    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e.ok && e.source == SourceId::Tushare));
    assert_eq!(*hist.calls.lock().unwrap(), 2, "每 code 一次增量拉取");
}

#[tokio::test]
async fn retry_then_success_emits_failure_events() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, hist, store, sink) = setup(
        vec![Err(ProviderError::Timeout), Err(ProviderError::Http("x".into())), Ok(vec![mk_bar("518880")])],
        vec!["518880"], vec![("518880", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 1, bars: 1 });
    assert_eq!(*hist.calls.lock().unwrap(), 3, "失败重试至成功");
    let kinds: Vec<_> = sink.events.lock().unwrap().iter()
        .map(|e| (e.ok, e.err_kind.map(|k| k.as_str()))).collect();
    assert_eq!(kinds, vec![(false, Some("timeout")), (false, Some("http")), (true, None)]);
    assert_eq!(store.saved.lock().unwrap()["518880"], 1);
}

#[tokio::test]
async fn retries_exhausted_skips_code_continues_others() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, _hist, store, sink) = setup(
        vec![Err(ProviderError::Http("a".into())), Err(ProviderError::Http("b".into())),
             Err(ProviderError::Http("c".into())), Ok(vec![mk_bar("159776")])],
        vec!["518880", "159776"], vec![("518880", cp), ("159776", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Failed, "518880 三次重试耗尽");
    assert_eq!(store.saved.lock().unwrap().get("518880"), None, "失败 code 不落库");
    assert_eq!(store.saved.lock().unwrap()["159776"], 1, "后续 code 继续");
    assert_eq!(sink.events.lock().unwrap().len(), 3 + 1);
}

#[tokio::test]
async fn rate_limited_aborts_whole_round() {
    let cp = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let (sync, hist, _store, sink) = setup(
        vec![Err(ProviderError::RateLimited)],
        vec!["518880", "159776"], vec![("518880", cp), ("159776", cp)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Failed);
    assert_eq!(*hist.calls.lock().unwrap(), 1, "quota 感知：整轮中止不重试不轰击");
    assert!(sink.events.lock().unwrap().iter()
        .any(|e| e.err_kind.map(|k| k.as_str()) == Some("rate_limited")));
}

#[tokio::test]
async fn up_to_date_code_no_api_call() {
    let today = NaiveDate::from_ymd_opt(2026, 9, 3).unwrap();
    let (sync, hist, _store, _sink) = setup(vec![], vec!["518880"], vec![("518880", today)]);
    let out = sync.run().await;
    assert_eq!(out, DailyOutcome::Synced { codes: 1, bars: 0 });
    assert_eq!(*hist.calls.lock().unwrap(), 0, "已最新不调用 API");
}
// ~/~ end
