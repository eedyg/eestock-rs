// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/scheduler.rs>>[init]
//! 调度：每 code 独立 ticker，分钟边界相位对齐 + 0~2s 抖动；每周期重读 symbols 热生效（service.rs）。

use crate::calendar::trading_minutes;
use chrono::{DateTime, TimeZone, Timelike, Utc};
use domain::tz::utc_to_cst;

/// 下一 tick：ceil(now/interval)*interval + jitter(0~2s)（interval>=60，分钟边界相位对齐）。
pub fn next_tick_after(now: DateTime<Utc>, interval_secs: u64, jitter_seed: u64) -> DateTime<Utc> {
    let iv = interval_secs.max(60) as i64;
    let next = (now.timestamp() / iv + 1) * iv;
    let jitter = (jitter_seed % 3) as i64; // 0~2s 防同刻齐发
    Utc.timestamp_opt(next + jitter, 0).single().expect("valid ts")
}

/// 首写胜出重叠根数（§3：每次拉取含最近 3 根已有 bar 的重叠）。
pub const OVERLAP_BARS: usize = 3;

/// 本周期抓取 limit：当日剩余交易分钟标签数 + 3 根重叠（§3）。
/// trading_day 由调用方经 TradingCalendar 判定传入（节假日感知，Wave 2 Phase A）；
/// 非交易日/已收盘 → 0（跳过）。
pub fn fetch_limit(now: DateTime<Utc>, trading_day: bool) -> usize {
    if !trading_day { return 0; }
    let cst = utc_to_cst(now);
    let cur_floor = cst.with_second(0).and_then(|t| t.with_nanosecond(0));
    let Some(cur) = cur_floor else { return 0 };
    let remaining = trading_minutes(cst.date()).into_iter().filter(|m| *m >= cur).count();
    if remaining == 0 { 0 } else { remaining + OVERLAP_BARS }
}
// ~/~ end
