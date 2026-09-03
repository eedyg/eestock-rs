// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/scheduler_test.rs>>[init]
//! Scheduler：相位对齐 + 抖动 + fetch_limit 口径。

use chrono::{TimeZone, Utc};
use collector::scheduler::*;

#[test]
fn next_tick_aligns_minute_boundary_with_jitter() {
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 10).unwrap();
    for seed in 0..30u64 {
        let next = next_tick_after(now, 60, seed);
        assert!(next > now);
        assert_eq!(next.timestamp() % 60, (seed % 3) as i64, "分钟边界 + 0~2s 抖动");
        assert!((0..=2).contains(&(next.timestamp() % 60)));
        assert!(next.timestamp() - now.timestamp() <= 63);
    }
    // interval 300s：对齐 5 分钟边界
    let next5 = next_tick_after(Utc.with_ymd_and_hms(2026, 9, 3, 1, 31, 0).unwrap(), 300, 0);
    assert_eq!(next5.timestamp() % 300, 0);
    // interval < 60 抬到 60（symbols CHECK interval_secs>=60 双保险）
    let n = next_tick_after(now, 30, 0);
    assert_eq!(n.timestamp() % 60, 0);
}

#[test]
fn fetch_limit_remaining_plus_overlap() {
    // 10:00 CST = 02:00 UTC：已过 09:30..09:59 共 30 根 → 剩余 210（含 10:00 本分钟），+3 重叠
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    assert_eq!(fetch_limit(now), 210 + OVERLAP_BARS);
    // 午休 12:30 CST：剩余 120 根下午 +3
    let noon = Utc.with_ymd_and_hms(2026, 9, 3, 4, 30, 0).unwrap();
    assert_eq!(fetch_limit(noon), 120 + OVERLAP_BARS);
    // 盘后 15:30 CST → 0；周六 → 0
    assert_eq!(fetch_limit(Utc.with_ymd_and_hms(2026, 9, 3, 7, 30, 0).unwrap()), 0);
    assert_eq!(fetch_limit(Utc.with_ymd_and_hms(2026, 9, 5, 2, 0, 0).unwrap()), 0);
}
// ~/~ end
