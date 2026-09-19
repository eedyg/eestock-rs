//! **手写测试（非 entangled 生成物）**：D6 —— `Dca.interval` 的 **serde 契约**（省略 = 默认 1）。
//!
//! 判据来源：`design/12-strategy-system/01-adr.md` §6 的 policy 契约
//! `Dca{tranches: N, mode: equal|fixed_amount, amount?, interval?: k（默认 1）}`——
//! `interval?` 标注**可选**，故省略必须可反序列化且等价于 1（旧实现漏 serde default ⇒ 省略即解析失败）。
//!
//! 落位说明：serde 级断言放在 application（本仓唯一 `serde_json` 在手、且策略 JSON 经此层解析的
//! 层）；`strategy-core` 未声明 `serde_json` 依赖，不为一条测试新增依赖（分层红线）。
//!
//! 覆盖：契约②（省略 = 1）/ 契约①（显式 0 语法合法、语义被 validate 拒绝）/ 契约③（≥1 取值不变）。

use serde_json::json;
use strategy_core::{DcaMode, ExecutionPolicy};

/// 契约②：省略 `interval` → 默认 1，且校验通过（让文档成真）。
#[test]
fn dca_interval_omitted_deserializes_to_default_one() {
    let p: ExecutionPolicy = serde_json::from_value(json!({
        "Dca": { "tranches": 3, "mode": "Equal", "amount": null }
    }))
    .expect("省略 interval 必须可反序列化（文档：可选，默认 1）");
    match &p {
        ExecutionPolicy::Dca { interval, .. } => {
            assert_eq!(*interval, 1, "省略 interval ⇒ 默认 1")
        }
        other => panic!("应反序列化为 Dca，实得 {other:?}"),
    }
    p.validate().expect("省略 interval ⇒ 默认 1 ⇒ 合法");
}

/// 契约①：显式 `interval=0` 语法上可解析（0 是合法 usize），语义上必须被 validate 拒绝。
#[test]
fn dca_interval_explicit_zero_parses_but_validate_rejects() {
    let p: ExecutionPolicy = serde_json::from_value(json!({
        "Dca": { "tranches": 3, "mode": "Equal", "amount": null, "interval": 0 }
    }))
    .expect("0 是合法 usize ⇒ 语法层可解析（语义层由 validate 拒绝）");
    let err = p
        .validate()
        .expect_err("显式 interval=0 必须 fail loud（不得静默当 1）");
    assert!(err.contains("Dca.interval"), "错误须指名道姓：{err}");
    assert!(err.contains("默认 1"), "错误须点明省略语义：{err}");
}

/// 契约③：显式 `interval ∈ {1,5,20}` 反序列化取值不变 + 校验通过（回归护栏）。
#[test]
fn dca_interval_explicit_positive_values_unchanged() {
    for (k, expected) in [(1u64, 1usize), (5, 5), (20, 20)] {
        let p: ExecutionPolicy = serde_json::from_value(json!({
            "Dca": { "tranches": 2, "mode": "Equal", "amount": null, "interval": k }
        }))
        .unwrap();
        match &p {
            ExecutionPolicy::Dca { interval, mode, .. } => {
                assert_eq!(*interval, expected, "显式 interval={k} 取值不得改变");
                assert_eq!(*mode, DcaMode::Equal);
            }
            other => panic!("应反序列化为 Dca，实得 {other:?}"),
        }
        p.validate().unwrap_or_else(|e| panic!("interval={k} 须仍然合法：{e}"));
    }
}
