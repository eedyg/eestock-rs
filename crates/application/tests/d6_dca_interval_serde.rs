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

// ---------------------------------------------------------------------------
// ADR-029 Step 1：`ExecutionPolicy::Exposure` 的 serde 契约（**无 rename** ⇒ 变体 PascalCase、
// 字段 snake_case；MCP/HTTP 的 policy 直通 JSON 据此自动支持新变体，服务端 serde 校验）。
// ---------------------------------------------------------------------------

use strategy_core::{ExposureTarget, GuardSpec, RampSpec, SellPolicy};

/// 契约：`ScoreMapped` 全字段往返（字段名逐字对应 ADR-029 D3；`sell` 取单位变体字符串）。
#[test]
fn adr029_exposure_score_mapped_serde_round_trip() {
    let raw = json!({
        "Exposure": {
            "target": { "ScoreMapped": { "at_threshold_pct": 0.2, "at_full_pct": 0.8, "sell": "Flat" } },
            "ramp": { "RateCap": { "pct_per_bar": 0.05 } },
            "guard": { "max_pct": 0.9, "min_pct": 0.0, "deadzone_pct": 0.005 }
        }
    });
    let p: ExecutionPolicy = serde_json::from_value(raw.clone()).expect("新变体必须可解析（直通 JSON）");
    assert_eq!(
        p,
        ExecutionPolicy::Exposure {
            target: ExposureTarget::ScoreMapped {
                at_threshold_pct: 0.2,
                at_full_pct: 0.8,
                sell: SellPolicy::Flat,
            },
            // ADR-029 Step 1.5（D12）：`RateCap` 增 `down_pct_per_bar`/`on_signal_break`。
            // 本处**只机械补字段**（`None` = 现行对称速率 + `Pause` 缺省 ⇒ 逐字节一致），
            // **不改任何断言口径**（`raw` 仍是旧形态 JSON ⇒ 往返/校验断言照旧成立）。
            ramp: RampSpec::RateCap {
                pct_per_bar: 0.05,
                down_pct_per_bar: None,
                on_signal_break: None,
            },
            guard: GuardSpec {
                max_pct: 0.9,
                min_pct: 0.0,
                deadzone_pct: 0.005,
                deadzone_min_notional: None,
            },
        }
    );
    // 往返：序列化形态与输入逐字段一致（无 rename ⇒ 键名即字段名）
    assert_eq!(serde_json::to_value(&p).unwrap(), raw);
    p.validate_with_thresholds(60.0, 40.0).expect("合法阈值组合");
}

/// 契约：`Fixed` + 单位变体 `Immediate`（serde 外部标记的单位变体形态 = 字符串，与 `sell: "Flat"` 同规）。
#[test]
fn adr029_exposure_fixed_and_immediate_serde_round_trip() {
    let raw = json!({
        "Exposure": {
            "target": { "Fixed": { "pct": 0.3 } },
            "ramp": { "Immediate": null },
            "guard": { "max_pct": 0.9, "min_pct": 0.0, "deadzone_pct": 0.0 }
        }
    });
    let p: ExecutionPolicy = serde_json::from_value(raw.clone()).expect("Fixed/Immediate 必须可解析");
    assert_eq!(serde_json::to_value(&p).unwrap(), raw);
    p.validate().expect("合法 Fixed 配置");
    // 单位变体形态**唯一**：契约形态之外的 `"Immediate"` 字符串形态必须拒绝（不得两套形状并存）
    let string_form = json!({
        "Exposure": {
            "target": { "Fixed": { "pct": 0.3 } },
            "ramp": "Immediate",
            "guard": { "max_pct": 0.9, "min_pct": 0.0, "deadzone_pct": 0.0 }
        }
    });
    assert!(
        serde_json::from_value::<ExecutionPolicy>(string_form).is_err(),
        "ramp 单位变体只认 {{\"Immediate\": null}}（计划 05 JSONC / web ExposureRamp 契约）"
    );
    // Scaled 支同样可解析
    let p2: ExecutionPolicy = serde_json::from_value(json!({
        "Exposure": {
            "target": { "ScoreMapped": { "at_threshold_pct": 0.1, "at_full_pct": 0.5, "sell": "Scaled" } },
            "ramp": { "Immediate": null },
            "guard": { "max_pct": 0.5, "min_pct": 0.0, "deadzone_pct": 0.0 }
        }
    }))
    .expect("Scaled 支可解析");
    assert!(matches!(
        p2,
        ExecutionPolicy::Exposure { target: ExposureTarget::ScoreMapped { sell: SellPolicy::Scaled, .. }, .. }
    ));
}

/// 契约（E11 fail loud，经 JSON 路径）：非法配置必须**构造期报错**，不得静默回退默认。
#[test]
fn adr029_exposure_invalid_configs_fail_loud_via_json() {
    let bad = [
        // at_full_pct < at_threshold_pct
        json!({"Exposure": {"target": {"ScoreMapped": {"at_threshold_pct": 0.8, "at_full_pct": 0.2, "sell": "Flat"}},
                            "ramp": {"Immediate": null}, "guard": {"max_pct": 1.0, "min_pct": 0.0, "deadzone_pct": 0.0}}}),
        // at_full_pct > max_pct（策略无权覆盖 guard）
        json!({"Exposure": {"target": {"ScoreMapped": {"at_threshold_pct": 0.2, "at_full_pct": 0.95, "sell": "Flat"}},
                            "ramp": {"Immediate": null}, "guard": {"max_pct": 0.9, "min_pct": 0.0, "deadzone_pct": 0.0}}}),
        // pct_per_bar ≤ 0
        json!({"Exposure": {"target": {"Fixed": {"pct": 0.3}},
                            "ramp": {"RateCap": {"pct_per_bar": 0.0}}, "guard": {"max_pct": 1.0, "min_pct": 0.0, "deadzone_pct": 0.0}}}),
        // min_pct > max_pct
        json!({"Exposure": {"target": {"Fixed": {"pct": 0.3}},
                            "ramp": {"Immediate": null}, "guard": {"max_pct": 0.5, "min_pct": 0.9, "deadzone_pct": 0.0}}}),
        // deadzone_pct < 0
        json!({"Exposure": {"target": {"Fixed": {"pct": 0.3}},
                            "ramp": {"Immediate": null}, "guard": {"max_pct": 1.0, "min_pct": 0.0, "deadzone_pct": -0.1}}}),
    ];
    for raw in bad {
        let p: ExecutionPolicy = serde_json::from_value(raw.clone())
            .unwrap_or_else(|e| panic!("语法层应可解析（语义层拒绝）：{raw} / {e}"));
        assert!(p.validate().is_err(), "非法配置必须 fail loud：{raw}");
    }
    // ScoreMapped 的阈值分母规则（经 `validate_with_thresholds`，由 `EnsembleConfig::validate` 调用）
    let sm: ExecutionPolicy = serde_json::from_value(json!({
        "Exposure": {"target": {"ScoreMapped": {"at_threshold_pct": 0.2, "at_full_pct": 0.5, "sell": "Flat"}},
                     "ramp": {"Immediate": null}, "guard": {"max_pct": 1.0, "min_pct": 0.0, "deadzone_pct": 0.0}}
    }))
    .unwrap();
    assert!(sm.validate_with_thresholds(100.0, 40.0).is_err(), "buy_threshold=100 ⇒ 映射分母为 0");
    assert!(sm.validate_with_thresholds(60.0, 0.0).is_err(), "sell_threshold=0 ⇒ 降档分母为 0");
    assert!(sm.validate().is_ok(), "阈值规则不属无参 validate（需阈值可见处校验）");
    // 旧变体在阈值下依旧合法（历史 run 可复现：阈值任意取值不影响 LumpSum/Dca）
    let legacy: ExecutionPolicy = serde_json::from_value(json!({"LumpSum": {"position_pct": 0.5}})).unwrap();
    legacy.validate_with_thresholds(100.0, 0.0).expect("旧变体不受阈值校验约束");
}
