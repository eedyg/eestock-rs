// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/calendar.rs>>[init]
//! 交易时段判定（Wave 2 Phase A：节假日感知 HolidayCalendar；分钟标签口径见 domain::calendar §2.8）。
//! 旧 WeekdayCalendar（仅工作日）已退役——节假日噪音结案（0008 holidays 表）。

use crate::clock::Clock;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use domain::ports::TradingCalendar;
use domain::tz::utc_to_cst;
use std::collections::HashSet;
use std::sync::{Arc, RwLock};

// 分钟标签/会话窗口/陈旧判定纯函数统一走 domain（diagnose 质量报告共用同口径，防双份漂移）。
pub use domain::calendar::{hm, is_session_minute, is_stale, is_weekday, latest_due_label,
    trading_minute_labels};

/// 兼容别名：当日交易分钟标签序列（241 个，naive CST）。
pub fn trading_minutes(date: NaiveDate) -> Vec<NaiveDateTime> { trading_minute_labels(date) }

/// 兼容别名：采集会话窗口判定（09:30..=11:31 ∪ 13:00..=15:01）。
pub fn is_trading_minute(t: NaiveTime) -> bool { is_session_minute(t) }

/// 节假日感知日历：内存快照（RwLock，sync trait 约束）+ 外部周期刷新（service.rs 刷新任务）。
/// 空快照 = 仅工作日口径（fail-open，与 Wave 0/1 行为一致；DB 故障不扩大停采面）。
pub struct HolidayCalendar {
    clock: Arc<dyn Clock>,
    holidays: RwLock<HashSet<NaiveDate>>,
}

impl HolidayCalendar {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self { clock, holidays: RwLock::new(HashSet::new()) }
    }
    /// 测试/装配用：直接给定节假日集合。
    pub fn with_holidays(clock: Arc<dyn Clock>, holidays: HashSet<NaiveDate>) -> Self {
        Self { clock, holidays: RwLock::new(holidays) }
    }
    /// 刷新快照（service 刷新任务调用；整体替换，读侧无锁竞争窗口语义）。
    pub fn refresh(&self, holidays: HashSet<NaiveDate>) {
        *self.holidays.write().expect("holidays poisoned") = holidays;
    }
    /// 当前快照（测试断言/观测用）。
    pub fn snapshot(&self) -> HashSet<NaiveDate> {
        self.holidays.read().expect("holidays poisoned").clone()
    }
}

impl TradingCalendar for HolidayCalendar {
    /// 交易日 = 工作日 ∧ 非节假日（0008）。
    fn is_trading_day(&self, date: NaiveDate) -> bool {
        is_weekday(date) && !self.holidays.read().expect("holidays poisoned").contains(&date)
    }

    fn is_trading_now(&self) -> bool {
        let cst = utc_to_cst(self.clock.now());
        self.is_trading_day(cst.date()) && is_session_minute(cst.time())
    }
}

/// 节假日快照刷新节拍（service.rs 刷新任务；小表全量读，低频）。
pub const HOLIDAY_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);
// ~/~ end
