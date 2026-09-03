// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/calendar.rs>>[init]
//! 交易时段判定（工作日 + 双交易时段；节假日表 Wave 2 接入）。

use crate::clock::Clock;
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use domain::ports::TradingCalendar;
use domain::tz::utc_to_cst;
use std::sync::Arc;

pub fn hm(h: u32, m: u32) -> NaiveTime { NaiveTime::from_hms_opt(h, m, 0).expect("valid hm") }

/// 分钟（bar 起始时刻）是否交易时段。
pub fn is_trading_minute(t: NaiveTime) -> bool {
    (hm(9, 30)..hm(11, 30)).contains(&t) || (hm(13, 0)..hm(15, 0)).contains(&t)
}

/// 当日交易分钟序列（bar 起始时刻，naive CST）：09:30..=11:29 ∪ 13:00..=14:59，共 240。
pub fn trading_minutes(date: NaiveDate) -> Vec<NaiveDateTime> {
    let mut out = Vec::with_capacity(240);
    let mut push_range = |start: NaiveTime, end: NaiveTime| {
        let mut t = start;
        while t < end {
            out.push(date.and_time(t));
            t += chrono::Duration::minutes(1);
        }
    };
    push_range(hm(9, 30), hm(11, 30));
    push_range(hm(13, 0), hm(15, 0));
    out
}

pub fn is_weekday(date: NaiveDate) -> bool {
    matches!(date.weekday(), chrono::Weekday::Mon | chrono::Weekday::Tue
        | chrono::Weekday::Wed | chrono::Weekday::Thu | chrono::Weekday::Fri)
}

pub struct WeekdayCalendar {
    clock: Arc<dyn Clock>,
}

impl WeekdayCalendar {
    pub fn new(clock: Arc<dyn Clock>) -> Self { Self { clock } }
}

impl TradingCalendar for WeekdayCalendar {
    fn is_trading_day(&self, date: NaiveDate) -> bool { is_weekday(date) }

    fn is_trading_now(&self) -> bool {
        let cst = utc_to_cst(self.clock.now());
        self.is_trading_day(cst.date()) && is_trading_minute(cst.time())
    }
}
// ~/~ end
