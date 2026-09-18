//! ADR-024 D1（修订 2026-09-18）—— 资源护栏**两常量 ↔ 契约向量绑定**断言（**手写**，非 tangle）。
//!
//! 单一事实源：`design/16-backtest-scalability/contract-vectors.json` 的
//! `span_limit_semantics.resource_guard.{max_bars_guard, confirm_bars}`。
//! 本文件把 `application::error::{MAX_BARS_GUARD, GUARD_CONFIRM_BARS}` 钉死在该向量上：
//! **向量改（或常量改）⇒ 本文件必红**（防「阈值改一处、忘另一处」的静默漂移）。
//!
//! 背景：2026-09-18 用户「按推荐」把 confirm 阈值由 200_000 提到 500_000（≈M1 五年）；
//! 硬上界 2_000_000 不变（M1 全历史≈86 万 bar ⇒ 合法请求永不触发）。
//!
//! 卫生：纯函数 + 只读一个仓库内 JSON 文件 ⇒ **无 IO/无 DB/无网络**。
//! 边界：`crates/web/tests/tester_p5_indep.rs` 是 tester 自有资产（含 200_000 硬断言），
//! 本文件不镜像它、也不得反向从它取期望值。

use application::error::{
    codes, guard_bars, GUARD_CONFIRM_BARS, MAX_BARS_GUARD,
};
use serde_json::Value;
use std::path::PathBuf;

fn vectors() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../design/16-backtest-scalability/contract-vectors.json");
    let raw = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("契约向量文件不可读 {}：{e}", p.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("契约向量文件 JSON 解析失败 {}：{e}", p.display()))
}

fn guard_field(v: &Value, key: &str) -> u64 {
    v["span_limit_semantics"]["resource_guard"][key]
        .as_u64()
        .unwrap_or_else(|| panic!("contract-vectors.json 缺 `span_limit_semantics.resource_guard.{key}`（整数）"))
}

/// 硬上界常量 == 向量 `max_bars_guard`。
#[test]
fn max_bars_guard_matches_contract_vector() {
    let want = guard_field(&vectors(), "max_bars_guard");
    assert_eq!(
        MAX_BARS_GUARD as u64,
        want,
        "MAX_BARS_GUARD({MAX_BARS_GUARD}) != contract-vectors.json `resource_guard.max_bars_guard`({want})"
    );
}

/// 二次确认阈值常量 == 向量 `confirm_bars`（本次由 200_000 ⇒ 500_000 的绑定点）。
#[test]
fn confirm_bars_matches_contract_vector() {
    let want = guard_field(&vectors(), "confirm_bars");
    assert_eq!(
        GUARD_CONFIRM_BARS as u64,
        want,
        "GUARD_CONFIRM_BARS({GUARD_CONFIRM_BARS}) != contract-vectors.json `resource_guard.confirm_bars`({want})"
    );
}

/// 运行期判定阈值与向量一致：`confirm_bars - 1` 放行、`confirm_bars` 需确认、`max_bars_guard + 1` 硬拒。
///
/// 这一条把「常量比对」升级为「行为比对」：仅改常量文本而忘了改 `guard_bars` 比较式（或反之）
/// 也会被抓住。
#[test]
fn guard_bars_runtime_thresholds_match_contract_vector() {
    let v = vectors();
    let confirm = guard_field(&v, "confirm_bars") as usize;
    let hard = guard_field(&v, "max_bars_guard") as usize;

    assert!(
        guard_bars(confirm - 1, false, "M1", "518880", None).is_none(),
        "confirm_bars - 1 = {} 必须放行（无护栏）",
        confirm - 1
    );

    let need_confirm = guard_bars(confirm, false, "M1", "518880", None)
        .expect("confirm_bars 处必须要求二次确认（400 resource_guard）");
    assert_eq!(need_confirm.code, codes::RESOURCE_GUARD, "码必须为 resource_guard");
    assert_eq!(
        need_confirm.detail["confirm_bars"].as_u64(),
        Some(confirm as u64),
        "detail.confirm_bars 必须回显向量值"
    );
    assert_eq!(
        need_confirm.detail["limit_bars"].as_u64(),
        Some(hard as u64),
        "detail.limit_bars 必须回显向量 max_bars_guard"
    );
    assert_eq!(need_confirm.detail["confirmable"], Value::Bool(true), "阈值档可 confirm 放行");

    // 带 confirm=true ⇒ 放行；硬上界 > max_bars_guard ⇒ 即使 confirm 也拒。
    assert!(
        guard_bars(confirm, true, "M1", "518880", None).is_none(),
        "confirm=true 在阈值档必须放行"
    );
    let too_big = guard_bars(hard + 1, true, "M1", "518880", None)
        .expect("> max_bars_guard 必须硬拒（confirm 不放行）");
    assert_eq!(too_big.detail["confirmable"], Value::Bool(false), "硬上界档不可放行");
}
