//! ADR-023 D1 红测试（**手写**，非 tangle 产物）。
//! 判据 J1：`crates/domain` 的 `Period` 枚举含 `M30`。
//! 本目标为**编译期断言**：`Period::M30` 不存在 ⇒ 本测试目标编译失败（= J1 红）。
//! 契约出处：design/01-architecture/adr/ADR-023-period-set-extension-30m.md §5.1 / §1.2 / §3.1。

use domain::types::Period;

/// J1：`Period::M30` 必须存在，且与既有 7 档互不相等（新档位是**加法**，不得顶替/复用旧变体）。
#[test]
fn j1_period_enum_contains_m30_variant() {
    // 编译期：这一行要求 `Period::M30` 变体存在（当前不存在 ⇒ 编译错误 = J1 红）。
    let m30: Period = Period::M30;

    assert!(matches!(m30, Period::M30), "Period::M30 必须是自己的变体");

    for other in [
        Period::M1,
        Period::M5,
        Period::M15,
        Period::H1,
        Period::D1,
        Period::W1,
        Period::MO1,
    ] {
        assert_ne!(m30, other, "Period::M30 必须与既有变体 {other:?} 互不相等");
    }

    // 变体名字面量（storage::accurate::period_str 的映射面由 crates/storage/tests/period30m_period_str.rs 覆盖）
    assert_eq!(format!("{m30:?}"), "M30");
    assert_ne!(format!("{m30:?}"), "M15", "M30 不得与 M15 同变体");
}
