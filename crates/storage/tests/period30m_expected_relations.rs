//! ADR-023 D1 红测试（**手写**）：判据 J6 —— `EXPECTED_RELATIONS` 含 `kline_accurate_30m`。
//!
//! 可达性说明：`storage::migrate_check::EXPECTED_RELATIONS` 是 `pub const`（crates/storage/src/migrate_check.rs:8），
//! `storage::migrate_check` 是 `pub mod`，故可从测试外部直接读该清单（**不需要数据库**：本测试只读常量）。
//! 契约出处：ADR-023 §2.2 末条 / §3.1（migrate_check.rs 改动面）。
//!
//! 语义：`verify_schema` 按该清单在启动时校验关系存在性；清单缺 30m ⇒ 新迁移落库后启动自检不覆盖 30m cagg
//! （回归无护栏）；清单多加 30m 而迁移未落 ⇒ app 直接起不来（ADR-023 §4.1 顺序硬约束）。

#[test]
fn j6_expected_relations_contains_kline_accurate_30m() {
    let rel: &[&str] = storage::migrate_check::EXPECTED_RELATIONS;
    assert!(
        rel.contains(&"kline_accurate_30m"),
        "ADR-023 §2.2：EXPECTED_RELATIONS 必须加入 \"kline_accurate_30m\"；现状 = {rel:?}"
    );
}

/// J6 反向护栏：既有关系名一条都不得被删（纯加法）。
#[test]
fn j6_existing_relations_not_removed() {
    let rel: &[&str] = storage::migrate_check::EXPECTED_RELATIONS;
    for name in [
        "kline_raw",
        "kline_accurate",
        "kline_accurate_5m",
        "kline_accurate_15m",
        "kline_accurate_1h",
        "kline_accurate_1d",
        "fee_profiles",
    ] {
        assert!(rel.contains(&name), "既有关系 {name} 从 EXPECTED_RELATIONS 消失（不得弱化既有契约）");
    }
}
