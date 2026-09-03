// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/tz.rs>>[init]
//! 交易所时区工具：Asia/Shanghai（固定 +8，无 DST）。

use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};

pub const CST_OFFSET_SECS: i32 = 8 * 3600;

pub fn cst() -> FixedOffset {
    FixedOffset::east_opt(CST_OFFSET_SECS).expect("valid offset")
}

/// 北京时间 naive → UTC（固定偏移无歧义）。
pub fn cst_to_utc(naive: NaiveDateTime) -> DateTime<Utc> {
    cst().from_local_datetime(&naive).single()
        .expect("CST 固定偏移无歧义").with_timezone(&Utc)
}

/// UTC → 北京时间 naive。
pub fn utc_to_cst(ts: DateTime<Utc>) -> NaiveDateTime {
    ts.with_timezone(&cst()).naive_local()
}
// ~/~ end
