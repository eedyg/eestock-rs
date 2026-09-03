// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/src/sync.rs>>[init]
//! 同步编排纯逻辑 + 执行器：checkpoint 断点续传、窗口规划、首年探测。

use chrono::{Duration, NaiveDate};

/// 全历史探测下界（510300 等最老 ETF 上市于 2012）。
pub fn full_history_start() -> NaiveDate {
    NaiveDate::from_ymd_opt(2012, 1, 1).expect("valid date")
}

/// 核心标的（阶段 2 优先首拉）。
pub const CORE_CODES: [&str; 4] = ["518880", "513310", "161226", "159776"];

/// 窗口规划：[from, to] 闭区间按 window_days 切片（最后一片可短）。
pub fn plan_windows(from: NaiveDate, to: NaiveDate, window_days: i64) -> Vec<(NaiveDate, NaiveDate)> {
    let mut out = Vec::new();
    let mut s = from;
    while s <= to {
        let e = (s + Duration::days(window_days - 1)).min(to);
        out.push((s, e));
        s = e + Duration::days(1);
    }
    out
}

/// 断点续传起点：有 checkpoint 从次日续，否则全历史。
pub fn resume_from(checkpoint: Option<NaiveDate>) -> NaiveDate {
    checkpoint.map(|d| d + Duration::days(1)).unwrap_or_else(full_history_start)
}

/// checkpoint 推进封顶（缺陷 2 修复，父级裁决 2026-09-03，§6.1）：
/// 盘中（Asia/Shanghai 15:00 收盘前）的同步不得将当日标记为完成 —— 封顶前一自然日；
/// 收盘后（含 15:00）允许含当日。日增量（daily.rs）与手动全量 bin（tushare_sync）共用此口径。
pub fn checkpoint_through_cap(now: chrono::DateTime<chrono::Utc>) -> NaiveDate {
    let cst = domain::tz::utc_to_cst(now);
    let close = chrono::NaiveTime::from_hms_opt(15, 0, 0).expect("valid hms");
    if cst.time() < close { cst.date() - Duration::days(1) } else { cst.date() }
}
// ~/~ end
