// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/tests/sync_plan.rs>>[init]
//! 同步编排纯逻辑测试：窗口规划 / 断点续传 / 节流门。

use chrono::NaiveDate;
use tushare::sync::*;

fn d(y: i32, m: u32, day: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, day).unwrap() }

#[test]
fn windows_cover_closed_interval() {
    let ws = plan_windows(d(2025, 1, 1), d(2025, 3, 15), 30);
    assert_eq!(ws.first().unwrap().0, d(2025, 1, 1));
    assert_eq!(ws.last().unwrap().1, d(2025, 3, 15));
    // 无缝不重叠
    for w in ws.windows(2) {
        assert_eq!(w[1].0, w[0].1 + chrono::Duration::days(1));
    }
    assert!(ws.iter().all(|(s, e)| s <= e));
}

#[test]
fn windows_single_partial() {
    let ws = plan_windows(d(2025, 3, 10), d(2025, 3, 15), 30);
    assert_eq!(ws, vec![(d(2025, 3, 10), d(2025, 3, 15))]);
}

#[test]
fn windows_empty_when_inverted() {
    assert!(plan_windows(d(2025, 3, 15), d(2025, 3, 10), 30).is_empty());
}

#[test]
fn resume_after_checkpoint_next_day() {
    assert_eq!(resume_from(Some(d(2025, 8, 1))), d(2025, 8, 2));
}

#[test]
fn resume_without_checkpoint_full_history() {
    assert_eq!(resume_from(None), full_history_start());
    assert_eq!(full_history_start(), d(2012, 1, 1));
}

#[test]
fn checkpoint_cap_intraday_vs_after_close() {
    // 缺陷 2 修复口径 a：盘中（CST 15:00 收盘前）checkpoint 封顶前一自然日；收盘后允许含当日。
    use chrono::{TimeZone, Utc};
    let intraday = Utc.with_ymd_and_hms(2026, 9, 3, 6, 59, 0).unwrap(); // 14:59 CST
    assert_eq!(checkpoint_through_cap(intraday), d(2026, 9, 2), "收盘前 1 分钟仍盘中");
    let close = Utc.with_ymd_and_hms(2026, 9, 3, 7, 0, 0).unwrap();    // 15:00 CST
    assert_eq!(checkpoint_through_cap(close), d(2026, 9, 3), "收盘后允许含当日");
    let morning = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap(); // 09:30 CST
    assert_eq!(checkpoint_through_cap(morning), d(2026, 9, 2));
    let evening = Utc.with_ymd_and_hms(2026, 9, 3, 8, 0, 0).unwrap(); // 16:00 CST 盘后
    assert_eq!(checkpoint_through_cap(evening), d(2026, 9, 3), "盘后允许含当日");
    let next_day = Utc.with_ymd_and_hms(2026, 9, 3, 16, 0, 0).unwrap(); // 次日 00:00 CST
    assert_eq!(checkpoint_through_cap(next_day), d(2026, 9, 3), "跨日边界按 CST 日期：次日凌晨仍视为次日的盘中");
}

#[tokio::test]
async fn throttle_enforces_interval() {
    let c = tushare::client::TushareClient::with_config(
        "t".into(), "http://127.0.0.1:1".into(), chrono::Duration::milliseconds(50));
    let t0 = std::time::Instant::now();
    for _ in 0..3 { c.throttle_pub().await; }
    assert!(t0.elapsed() >= std::time::Duration::from_millis(100),
        "3 次节流调用（首次立即）应至少间隔 2×50ms，实际 {:?}", t0.elapsed());
}
// ~/~ end
