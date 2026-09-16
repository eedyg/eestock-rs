//! ADR-023 D1 红测试（**手写**）：判据 J3 —— `period_str(Period::M30) == "M30"`。
//!
//! 可达性说明（IMPORTANT）：`storage::accurate::period_str` 是 `pub fn`（crates/storage/src/accurate.rs:13），
//! 且 `storage::accurate` 是 `pub mod`（crates/storage/src/lib.rs），因此**可从测试外部 crate 直接调用**，
//! 无需任何内部访问技巧。落库口径 `kline_accurate.period` 列的文本由本函数产出，故本断言 = 存储层契约。
//! 契约出处：ADR-023 §3.1（accurate.rs 改动面）。

use domain::types::Period;

/// J3：M30 的落库周期文本必须是 `"M30"`（大写 M + 数值，与 M1/M5/M15/H1 同型）。
#[test]
fn j3_period_str_m30_is_uppercase_m30() {
    assert_eq!(
        storage::accurate::period_str(Period::M30),
        "M30",
        "ADR-023 §3.1：period_str 必须把 Period::M30 映射为 \"M30\""
    );
}

/// J3 反向护栏：既有 7 档映射不得被改动（既有契约一条都不得弱化）。
#[test]
fn j3_existing_period_str_mappings_unchanged() {
    let expect: [(Period, &str); 7] = [
        (Period::M1, "M1"),
        (Period::M5, "M5"),
        (Period::M15, "M15"),
        (Period::H1, "H1"),
        (Period::D1, "D1"),
        (Period::W1, "W1"),
        (Period::MO1, "MO1"),
    ];
    for (p, s) in expect {
        assert_eq!(storage::accurate::period_str(p), s, "既有档位 {p:?} 的 period_str 被改动");
    }
}
