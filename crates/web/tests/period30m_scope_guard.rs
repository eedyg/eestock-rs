//! ADR-023 **D2 契约护栏（手写；2026-09-16 由 D1 越界护栏演进而来 —— 父级授权）**。
//!
//! ## 演进说明（**契约演进，非断言放宽**）
//! D1 阶段本文件断言「30m **不在**多周期白名单」（防止 D1 顺手越界做 D2）。D2 开始时 30m 进入多周期是
//! **目标**，因此三条断言按 D2 契约**转向**：由「不在」改为「**在**白名单内且顺序 15m → 30m → 1h」，
//! 同时**保留**真正该守的护栏（`1mo` 仍不提供、既有档位集合不被削减）。
//! 逐条对照见：`/tmp/adr023-d2-red-20260916T152240Z/diff_scope_guard.before.rs` 与
//! `tester/test/289*` 报告中的前后 diff。
//!
//! 契约出处：ADR-023 §2.5（后端白名单 + rank 插位）、§5.3（D2 交付范围）、§3.2。
//!
//! 红因（红阶段）：`MULTI_PERIOD_ALLOWED` 仍为 6 档 ⇒ 断言失败（**不是**编译错误）。

/// D2 交付后完整白名单（ADR-023 §2.5：在 `15m`(2) 与 `1h`(3) 之间插入 `30m`）。
const EXPECTED_ALLOWED: &[&str] = &["1m", "5m", "15m", "30m", "1h", "1d", "1w"];

/// D2 契约：`30m` **必须**在白名单内，且顺序为 `15m → 30m → 1h`（`1mo` 不提供）。
#[test]
fn d2_backend_multi_period_allowed_contains_30m_between_15m_and_1h() {
    let allowed: &[&str] = web::dto::MULTI_PERIOD_ALLOWED;
    assert!(
        allowed.contains(&"30m"),
        "D2 契约（ADR-023 §2.5）：`\"30m\"` 必须在 MULTI_PERIOD_ALLOWED；实际 = {allowed:?}"
    );
    assert_eq!(
        allowed, EXPECTED_ALLOWED,
        "D2 契约：白名单必须恰为 1m/5m/15m/30m/1h/1d/1w（30m 落在 15m 与 1h 之间）"
    );
    let i15 = allowed.iter().position(|p| *p == "15m").expect("15m 必须在白名单内");
    let i30 = allowed.iter().position(|p| *p == "30m").expect("30m 必须在白名单内");
    let i1h = allowed.iter().position(|p| *p == "1h").expect("1h 必须在白名单内");
    assert!(
        i15 < i30 && i30 < i1h,
        "D2 契约：顺序必须是 15m → 30m → 1h；实际索引 = {i15}/{i30}/{i1h}"
    );
}

/// **保留护栏**：`1mo` 仍不提供（既有用户裁决，D2 不得放开）。
#[test]
fn d2_backend_multi_period_allowed_still_excludes_1mo() {
    assert!(
        !web::dto::MULTI_PERIOD_ALLOWED.contains(&"1mo"),
        "既有裁决（ADR-022 §2.5）: 1mo 不在多周期白名单（D2 只许新增 30m）"
    );
}

/// **保留护栏**：既有 6 档一档都不能少（D2 是纯加法面，不得借机削减/重排既有档位）。
#[test]
fn d2_backend_multi_period_allowed_keeps_all_six_existing_tiers() {
    let allowed: &[&str] = web::dto::MULTI_PERIOD_ALLOWED;
    for tier in ["1m", "5m", "15m", "1h", "1d", "1w"] {
        assert!(
            allowed.contains(&tier),
            "D2 纯加法面：既有档位 `{tier}` 不得被移除；实际 = {allowed:?}"
        );
    }
    assert_eq!(
        allowed.len(),
        7,
        "D2 白名单必须恰为 7 档（既有 6 + 30m）；实际 = {allowed:?}"
    );
}
