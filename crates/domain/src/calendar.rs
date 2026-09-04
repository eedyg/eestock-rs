// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/calendar.rs>>[init]
//! 交易日历分钟标签口径（Wave 2 Phase A，实盘数据实证 2026-09-04 定稿，本节头注释）。
//! 标签集合：09:30..=11:30 ∪ 13:01..=15:00（241 个）；采集会话窗口含标签可得性滞后余量。

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Weekday};

pub fn hm(h: u32, m: u32) -> NaiveTime { NaiveTime::from_hms_opt(h, m, 0).expect("valid hm") }

pub fn is_weekday(date: NaiveDate) -> bool {
    matches!(date.weekday(),
        Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu | Weekday::Fri)
}

/// 当日交易分钟标签序列（naive CST）：09:30..=11:30 ∪ 13:01..=15:00，共 241。
/// 09:30=开盘集合竞价+首分钟 bar；11:30=上午收盘 bar；13:00 无标签（午后首分钟标签 13:01）；
/// 15:00=收盘集合竞价 bar。
pub fn trading_minute_labels(date: NaiveDate) -> Vec<NaiveDateTime> {
    let mut out = Vec::with_capacity(241);
    let mut push_range = |start: NaiveTime, end_inclusive: NaiveTime| {
        let mut t = start;
        while t <= end_inclusive {
            out.push(date.and_time(t));
            t += Duration::minutes(1);
        }
    };
    push_range(hm(9, 30), hm(11, 30));
    push_range(hm(13, 1), hm(15, 0));
    out
}

/// 采集会话窗口：该时刻是否应尝试采集（覆盖 11:30/15:00 标签 bar 的可得性滞后 ~1min）。
/// 09:30..=11:31 ∪ 13:00..=15:01。
pub fn is_session_minute(t: NaiveTime) -> bool {
    (hm(9, 30)..hm(11, 32)).contains(&t) || (hm(13, 0)..hm(15, 2)).contains(&t)
}

/// 分钟下取整（naive）。
fn minute_floor(t: NaiveDateTime) -> NaiveDateTime {
    t.date().and_time(NaiveTime::from_hms_opt(t.time().hour(), t.time().minute(), 0)
        .expect("valid hm"))
}

/// 陈旧判定基准（粘源陈旧检测，03-collector §3.1）：now（naive CST）时点「已到期」的最大标签
/// = 标签 ≤ floor_min(now − 60s)（1 分钟宽限：标签时刻后 60s 内允许源端未更新）。
/// None = 当日尚无到期标签（09:31 前）→ 调用方不做陈旧判定。
pub fn latest_due_label(now: NaiveDateTime) -> Option<NaiveDateTime> {
    let floor = minute_floor(now - Duration::seconds(60));
    trading_minute_labels(now.date()).into_iter().filter(|l| *l <= floor).max()
}

/// 陈旧 bar 判定：抓取结果最新标签落后于已到期标签 → 源在喂旧数据。
/// fetched_max / now 均为 naive CST；是否处于会话时段由调用方以 is_session_minute 门控
/// （executor 仅交易时段抓取；盘后/周末回填场景 due=15:00 与非交易日语义见 03 §3.1）。
pub fn is_stale(fetched_max: NaiveDateTime, now: NaiveDateTime) -> bool {
    match latest_due_label(now) {
        Some(due) => fetched_max < due,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }

    #[test]
    fn labels_241_and_boundaries() {
        let mins = trading_minute_labels(d(2026, 9, 3)); // 周四
        assert_eq!(mins.len(), 241);
        assert_eq!(mins.first().unwrap().time(), hm(9, 30), "首标签 09:30");
        assert_eq!(mins.last().unwrap().time(), hm(15, 0), "末标签 15:00（收盘集合竞价 bar）");
        let times: Vec<NaiveTime> = mins.iter().map(|m| m.time()).collect();
        assert!(times.contains(&hm(11, 30)), "11:30 上午收盘 bar 有标签");
        assert!(!times.contains(&hm(13, 0)), "13:00 无标签（上游口径实证）");
        assert!(times.contains(&hm(13, 1)), "午后首标签 13:01");
        assert!(!times.contains(&hm(12, 59)) && !times.contains(&hm(9, 29)));
    }

    #[test]
    fn session_window_covers_label_availability_lag() {
        assert!(!is_session_minute(hm(9, 29)));
        assert!(is_session_minute(hm(9, 30)));
        assert!(is_session_minute(hm(11, 30)) && is_session_minute(hm(11, 31)),
            "11:30 标签 bar 滞后余量");
        assert!(!is_session_minute(hm(11, 32)));
        assert!(!is_session_minute(hm(12, 59)), "午休不采集");
        assert!(is_session_minute(hm(13, 0)));
        assert!(is_session_minute(hm(15, 0)) && is_session_minute(hm(15, 1)),
            "15:00 收盘 bar 滞后余量");
        assert!(!is_session_minute(hm(15, 2)));
    }

    #[test]
    fn weekday_basics() {
        assert!(is_weekday(d(2026, 9, 3)));
        assert!(!is_weekday(d(2026, 9, 5)) && !is_weekday(d(2026, 9, 6)), "周末");
    }

    #[test]
    fn latest_due_label_and_stale() {
        let day = d(2026, 9, 3);
        // 09:30:30 → 无到期标签（宽限 60s）→ None；09:31:01 → due=09:30
        assert_eq!(latest_due_label(day.and_time(hm(9, 30))), None);
        assert_eq!(latest_due_label(day.and_hms_opt(9, 31, 1).unwrap()).unwrap().time(), hm(9, 30));
        // 10:41:20 → due=10:40
        assert_eq!(latest_due_label(day.and_hms_opt(10, 41, 20).unwrap()).unwrap().time(), hm(10, 40));
        // 午休 13:01:30 → floor=13:00，13:01 标签未到期 → due=11:30（午餐边缘不误判）
        assert_eq!(latest_due_label(day.and_hms_opt(13, 1, 30).unwrap()).unwrap().time(), hm(11, 30));
        // 13:02:30 → due=13:01
        assert_eq!(latest_due_label(day.and_hms_opt(13, 2, 30).unwrap()).unwrap().time(), hm(13, 1));
        // 盘后 21:00 → due=15:00（缺口回填场景）
        assert_eq!(latest_due_label(day.and_hms_opt(21, 0, 0).unwrap()).unwrap().time(), hm(15, 0));

        // is_stale：最新 bar 到期内不判陈旧；落后则陈旧
        assert!(!is_stale(day.and_hms_opt(10, 40, 0).unwrap(), day.and_hms_opt(10, 41, 20).unwrap()));
        assert!(is_stale(day.and_hms_opt(10, 39, 0).unwrap(), day.and_hms_opt(10, 41, 20).unwrap()),
            "10:40 bar 已到期而源最新只到 10:39 → 陈旧");
        assert!(!is_stale(day.and_hms_opt(11, 30, 0).unwrap(), day.and_hms_opt(13, 1, 30).unwrap()),
            "午休后首轮：13:01 未到期，11:30 不判陈旧");
        assert!(is_stale(day.and_hms_opt(11, 30, 0).unwrap(), day.and_hms_opt(13, 2, 30).unwrap()),
            "13:01 到期后仍停在 11:30 → 陈旧");
        // 当日无到期标签 → 不判陈旧
        assert!(!is_stale(day.and_hms_opt(9, 30, 0).unwrap(), day.and_hms_opt(9, 30, 30).unwrap()));
    }
}
// ~/~ end
