// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/gapfill_test.rs>>[init]
//! GapBackfiller：缺口集合计算（午休边界不误判）+ 只写缺失 ts（首写胜出）。

mod common;

use chrono::{NaiveDate, TimeZone, Utc};
use collector::calendar::{trading_minutes, HolidayCalendar};
use collector::circuit::CircuitRegistry;
use collector::clock::FakeClock;
use collector::executor::FetchExecutor;
use collector::gapfill::*;
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
    let gaps = compute_gaps(&existing, d(), now, true);
    // 缺口 = 09:35..10:00（26 根，含 10:00 本分钟）；未来分钟不算缺口
    assert_eq!(gaps.len(), 26, "09:35..=10:00 共 26 根: {:?}", gaps.first());
    assert!(!gaps.contains(&cst_to_utc(trading_minutes(d())[0])), "已有 ts 不是缺口");
    // 午休时段永远不在标签序列里（11:31-12:59 不产生缺口）——由 trading_minutes 保证
    let noon = Utc.with_ymd_and_hms(2026, 9, 3, 4, 30, 0).unwrap(); // 12:30 CST
    let gaps_noon = compute_gaps(&existing, d(), noon, true);
    assert!(gaps_noon.iter().all(|ts| {
        let cst = domain::tz::utc_to_cst(*ts);
        collector::calendar::is_trading_minute(cst.time())
    }), "缺口全为会话内分钟（午休不误判）");
    // 13:00 伪缺口结案：标签序列无 13:00，下午首轮前（13:00:30 CST）不产生 13:00 缺口
    let pm = Utc.with_ymd_and_hms(2026, 9, 3, 5, 0, 30).unwrap(); // 13:00:30 CST
    let gaps_pm = compute_gaps(&HashSet::new(), d(), pm, true);
    assert!(gaps_pm.iter().all(|ts| {
        let t = domain::tz::utc_to_cst(*ts).time();
        t != collector::calendar::hm(13, 0)
    }), "13:00 标签不存在 → 恒不为缺口（伪缺口结案）");
}

#[test]
fn gaps_empty_on_non_trading_day_or_other_date() {
    let now = Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap(); // 周六
    assert!(compute_gaps(&HashSet::new(), NaiveDate::from_ymd_opt(2026, 9, 5).unwrap(), now, false)
        .is_empty(), "非交易日（trading_day=false）→ 空");
    // now 与 date 不同日 → 空（只回填当日）
    let now2 = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();
    assert!(compute_gaps(&HashSet::new(), d(), now2, true).is_empty());
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
    // mock 源返回当日全 241 标签（含已有的 09:30）
    let all: Vec<Bar> = trading_minutes(d()).into_iter().map(|t| Bar {
        code: Code("518880".into()), period: Period::M1, ts: cst_to_utc(t),
        open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
        source: SourceId::TencentIfzq,
    }).collect();
    assert_eq!(all.len(), 241);
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
    let cal: Arc<dyn domain::ports::TradingCalendar> =
        Arc::new(HolidayCalendar::new(clock.clone())); // 空快照：工作日口径
    let bf = GapBackfiller::new(ex, reader.clone(), registry, clock, cal);
    let touched = bf.backfill_today().await.unwrap();
    assert_eq!(touched, 1);
    // 首写胜出：mock 源返回全 241 根，已有的 09:30 冲突跳过不重复、其余全落
    let written = writer.bars.lock().unwrap();
    assert_eq!(written.len(), 241);
    assert_eq!(written.iter().filter(|b| b.ts == existing_bar.ts).count(), 1,
               "已有 ts 不重复落行（只写缺失 ts）");
}

#[tokio::test]
async fn backfill_skips_holiday_entirely() {
    // 国庆 2026-10-01 周四 10:00 CST = 02:00 UTC（0008 表口径）：整轮跳过、零调用、零缺口
    let now = Utc.with_ymd_and_hms(2026, 10, 1, 2, 0, 30).unwrap();
    let clock = Arc::new(FakeClock::new(now));
    let sink = Arc::new(MemSink::default());
    let writer = Arc::new(MemWriter::default());
    let reader = Arc::new(MemReader::default());
    let t = Arc::new(MockMinute::new(SourceId::TencentIfzq, vec![]));
    let s = Arc::new(MockMinute::new(SourceId::SinaJsonp, vec![]));
    let circuits = Arc::new(CircuitRegistry::new(
        vec![SourceId::TencentIfzq, SourceId::SinaJsonp], clock.clone(), sink.clone()));
    let mut providers: HashMap<SourceId, Arc<dyn domain::provider::MinuteKlineProvider>> = HashMap::new();
    providers.insert(SourceId::TencentIfzq, t.clone());
    providers.insert(SourceId::SinaJsonp, s.clone());
    let ex = Arc::new(FetchExecutor::new(providers,
        SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]),
        DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
        circuits, writer.clone(), sink.clone(), clock.clone()));
    let registry = Arc::new(MemRegistry { codes: std::sync::Mutex::new(vec![(Code("518880".into()), 60)]) });
    let cal: Arc<dyn domain::ports::TradingCalendar> = Arc::new(HolidayCalendar::with_holidays(
        clock.clone(), (1..=8u32).map(|dd| NaiveDate::from_ymd_opt(2026, 10, dd).unwrap()).collect()));
    let bf = GapBackfiller::new(ex, reader, registry, clock, cal);
    assert_eq!(bf.backfill_today().await.unwrap(), 0, "节假日整轮跳过");
    assert_eq!(t.calls(), 0);
    assert_eq!(s.calls(), 0, "节假日零抓取（不采集、不算缺口）");
    assert!(writer.bars.lock().unwrap().is_empty());
}
// ~/~ end
