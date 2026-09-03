// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/calendar_test.rs>>[init]
//! TradingCalendar / 交易分钟序列（fake clock）。

use chrono::{NaiveDate, TimeZone, Utc};
use collector::calendar::*;
use collector::clock::FakeClock;
use domain::ports::TradingCalendar;
use std::sync::Arc;

fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }

#[test]
fn trading_minutes_240_and_lunch_boundary() {
    let mins = trading_minutes(d(2026, 9, 3)); // 周四
    assert_eq!(mins.len(), 240);
    // 上午 09:30..=11:29、下午 13:00..=14:59；午休边界不误判
    assert!(is_trading_minute(hm(9, 30)));
    assert!(is_trading_minute(hm(11, 29)));
    assert!(!is_trading_minute(hm(11, 30)), "11:30 属午休");
    assert!(!is_trading_minute(hm(12, 59)));
    assert!(is_trading_minute(hm(13, 0)), "13:00 属午后首节");
    assert!(is_trading_minute(hm(14, 59)));
    assert!(!is_trading_minute(hm(15, 0)), "15:00 已收盘（bar 起始时刻口径）");
    assert!(!is_trading_minute(hm(9, 29)));
}

#[test]
fn weekday_calendar_with_fake_clock() {
    // 2026-09-03 是周四；2026-09-05 是周六
    assert!(is_weekday(d(2026, 9, 3)));
    assert!(!is_weekday(d(2026, 9, 5)));
    // 09:35 CST = 01:35 UTC → 交易中
    let clock = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 3, 1, 35, 0).unwrap()));
    let cal = WeekdayCalendar::new(clock.clone());
    assert!(cal.is_trading_now());
    // 推进到午休 12:00 CST = 04:00 UTC
    clock.advance(chrono::Duration::minutes(145));
    assert!(!cal.is_trading_now());
    // 推进到周六 10:00 CST（= 9-5 02:00 UTC）
    let sat = Arc::new(FakeClock::new(Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap()));
    assert!(!WeekdayCalendar::new(sat).is_trading_now());
}
// ~/~ end
