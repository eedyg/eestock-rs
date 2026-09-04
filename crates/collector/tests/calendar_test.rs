// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/calendar_test.rs>>[init]
//! TradingCalendar / 交易分钟标签序列（fake clock）。
//! Wave 2 Phase A：241 标签实盘实证口径（contracts §2.8）+ 节假日表感知 HolidayCalendar（0008）。

use chrono::{NaiveDate, TimeZone, Utc};
use collector::calendar::*;
use collector::clock::FakeClock;
use domain::ports::TradingCalendar;
use std::collections::HashSet;
use std::sync::Arc;

fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }

#[test]
fn trading_minutes_241_labels_upstream_aligned() {
    let mins = trading_minutes(d(2026, 9, 3)); // 周四
    assert_eq!(mins.len(), 241, "09:30..=11:30(121) ∪ 13:01..=15:00(120)，上游三源实盘实证");
    // 会话窗口：11:30/11:31 仍属会话（上午收盘 bar 可得性滞后）；午休不采集
    assert!(is_trading_minute(hm(9, 30)));
    assert!(is_trading_minute(hm(11, 30)) && is_trading_minute(hm(11, 31)));
    assert!(!is_trading_minute(hm(11, 32)), "11:32 起午休");
    assert!(!is_trading_minute(hm(12, 59)));
    assert!(is_trading_minute(hm(13, 0)), "13:00 起为午后会话（等 13:01 首标签 bar）");
    assert!(is_trading_minute(hm(15, 0)) && is_trading_minute(hm(15, 1)), "15:00 收盘 bar 滞后余量");
    assert!(!is_trading_minute(hm(15, 2)), "15:02 起收盘");
    assert!(!is_trading_minute(hm(9, 29)));
    // 标签集合：13:00 无标签（13:00 伪缺口结案）；11:30/15:00 有标签
    let times: Vec<_> = mins.iter().map(|m| m.time()).collect();
    assert!(!times.contains(&hm(13, 0)), "13:00 无标签（上游口径实证，Wave 1 伪缺口结案）");
    assert!(times.contains(&hm(11, 30)) && times.contains(&hm(15, 0)));
    assert!(times.contains(&hm(13, 1)) && times.contains(&hm(14, 59)));
}

#[test]
fn holiday_calendar_weekend_holiday_and_refresh() {
    // 2026-09-03 周四 09:35 CST = 01:35 UTC
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let cal = HolidayCalendar::new(clock.clone());
    // 空快照 = 仅工作日口径（fail-open，与 Wave 0/1 行为一致）
    assert!(cal.is_trading_day(d(2026, 9, 3)));
    assert!(cal.is_trading_day(d(2026, 10, 1)), "空快照 fail-open：国庆暂按工作日");
    // 刷新 2026 节假日（0008 迁移数据子集：国庆 10/1-10/8、元旦 1/1-1/3）
    let mut h: HashSet<NaiveDate> = HashSet::new();
    for dd in 1..=8u32 { h.insert(d(2026, 10, dd)); }
    for dd in 1..=3u32 { h.insert(d(2026, 1, dd)); }
    cal.refresh(h);
    assert!(!cal.is_trading_day(d(2026, 10, 1)), "国庆不采集（任务书验收点）");
    assert!(!cal.is_trading_day(d(2026, 10, 8)), "国庆区间内");
    assert!(!cal.is_trading_day(d(2026, 1, 1)), "元旦不采集（任务书验收点）");
    assert!(!cal.is_trading_day(d(2026, 9, 5)), "周六不采集");
    assert!(!cal.is_trading_day(d(2026, 9, 6)), "周日不采集");
    assert!(cal.is_trading_day(d(2026, 9, 3)), "普通工作日交易");
    assert!(cal.is_trading_day(d(2026, 10, 9)), "国庆后首个工作日交易");
    // is_trading_now：交易中 → 推进至午休 12:00 CST → 非交易
    assert!(cal.is_trading_now());
    clock.advance(chrono::Duration::minutes(145));
    assert!(!cal.is_trading_now());
    // 周六 10:00 CST → 非交易
    let sat = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap()));
    assert!(!HolidayCalendar::new(sat).is_trading_now());
    // 国庆盘中时刻（10-01 10:00 CST = 02:00 UTC）→ 非交易
    let gq_clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 10, 1, 2, 0, 0).unwrap()));
    let gq = HolidayCalendar::with_holidays(gq_clock,
        (1..=8u32).map(|dd| d(2026, 10, dd)).collect());
    assert!(!gq.is_trading_now(), "国庆盘中时刻也不采集");
}
// ~/~ end
