// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/gapfill_test.rs>>[init]
//! GapBackfiller：缺口集合计算（午休边界不误判）+ 只写缺失 ts（首写胜出）。

mod common;

use chrono::{NaiveDate, TimeZone, Utc};
use collector::circuit::CircuitRegistry;
use collector::clock::FakeClock;
use collector::executor::FetchExecutor;
use collector::gapfill::*;
use collector::calendar::trading_minutes;
use common::*;
use domain::ports::KlineWriter;
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;
use domain::tz::cst_to_utc;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

fn d() -> NaiveDate { NaiveDate::from_ymd_opt(2026, 9, 3).unwrap() } // 周四

#[test]
fn gaps_are_trading_minutes_minus_existing_only_past() {
    // now = 10:00 CST = 02:00 UTC
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    let mut existing = HashSet::new();
    // 已有 09:30-09:34（CST → UTC 01:30-01:34）
    for m in trading_minutes(d()).into_iter().take(5) {
        existing.insert(cst_to_utc(m));
    }
    let gaps = compute_gaps(&existing, d(), now);
    // 缺口 = 09:35..10:00（26 根，含 10:00 本分钟）；未来分钟不算缺口
    assert_eq!(gaps.len(), 26, "09:35..=10:00 共 26 根: {:?}", gaps.first());
    assert!(!gaps.contains(&cst_to_utc(trading_minutes(d())[0])), "已有 ts 不是缺口");
    // 午休时段永远不在分钟序列里（11:30-12:59 不产生缺口）——由 trading_minutes 保证
    let noon = Utc.with_ymd_and_hms(2026, 9, 3, 4, 30, 0).unwrap(); // 12:30 CST
    let gaps_noon = compute_gaps(&existing, d(), noon);
    assert!(gaps_noon.iter().all(|ts| {
        let cst = domain::tz::utc_to_cst(*ts);
        collector::calendar::is_trading_minute(cst.time())
    }), "缺口全为交易分钟（午休不误判）");
}

#[test]
fn gaps_empty_on_non_trading_day_or_other_date() {
    let now = Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap(); // 周六
    assert!(compute_gaps(&HashSet::new(), NaiveDate::from_ymd_opt(2026, 9, 5).unwrap(), now).is_empty());
    // now 与 date 不同日 → 空（只回填当日）
    let now2 = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();
    assert!(compute_gaps(&HashSet::new(), d(), now2).is_empty());
}

#[tokio::test]
async fn backfill_writes_only_missing_ts() {
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    let clock = Arc::new(FakeClock::new(now));
    let sink = Arc::new(MemSink::default());
    let writer = Arc::new(MemWriter::default());
    let reader = Arc::new(MemReader::default());
    // 已有 09:30 bar
    let existing_bar = bar("518880", 1, 30, SourceId::TencentIfzq);
    writer.write_batch(std::slice::from_ref(&existing_bar)).await.unwrap();
    reader.ts.lock().unwrap().insert(("518880".into(), d()),
        HashSet::from([existing_bar.ts]));
    // mock 源返回当日全 240 根（含已有的 09:30）
    let all: Vec<Bar> = trading_minutes(d()).into_iter().map(|t| Bar {
        code: Code("518880".into()), period: Period::M1, ts: cst_to_utc(t),
        open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
        source: SourceId::TencentIfzq,
    }).collect();
    // 双源均返回全量（duty 由 stable_seed 决定，任一当班都能成功承接）
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![Ok(all.clone())]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp, vec![Ok(all)]));
    let circuits = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock.clone(), sink.clone()));
    let mut providers: HashMap<SourceId, Arc<dyn domain::provider::MinuteKlineProvider>> = HashMap::new();
    providers.insert(SourceId::TencentIfzq, t);
    providers.insert(SourceId::SinaJsonp, s);
    let ex = Arc::new(FetchExecutor::new(providers,
        SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]),
        DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
        circuits, writer.clone(), sink.clone(), clock.clone()));
    let registry = Arc::new(MemRegistry { codes: std::sync::Mutex::new(vec![(Code("518880".into()), 60)]) });
    let bf = GapBackfiller::new(ex, reader.clone(), registry, clock);
    let touched = bf.backfill_today().await.unwrap();
    assert_eq!(touched, 1);
    // 首写胜出：mock 源返回全 240 根，已有的 09:30 冲突跳过不重复、其余全落
    let written = writer.bars.lock().unwrap();
    assert_eq!(written.len(), 240);
    assert_eq!(written.iter().filter(|b| b.ts == existing_bar.ts).count(), 1,
               "已有 ts 不重复落行（只写缺失 ts）");
}
// ~/~ end
