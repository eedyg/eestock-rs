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
