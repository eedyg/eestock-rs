//! 回测费用映射与**按标的类型推断费率**（ADR-019 / D11-3）。
//!
//! 三层费率解析（`resolve_fee`，ADR-019 ¶3 / D11-3）：
//! 1. **显式传参优先**：调用方给了 `fee` 对象 → 整体以显式为准（缺 `stamp_duty_pct` 仍取
//!    旧默认 0.05 → 完全向后兼容，可复现旧行为）；`source="explicit"`。
//! 2. **按类型推断**：未传 `fee` → 按标的 `symbols.type` 查 `fee_profiles`（D11-2）；
//!    `source="profile"`。滑点非费率事实（档案无列）→ 取 ADR bt-1 默认 2bp。
//! 3. **未知回退**：`type IS NULL` / 无档案行 → 旧 ADR bt-1 默认（0.025/5/0.05/2）
//!    + `source="default"`——不静默借用他类型档案（ADR-019 D11-1 裁决 A2）。
//!
//! 字段映射：`rate_pct -> commission_rate_pct`、`min_fee -> min_commission`、`slippage_bp -> slippage_bp`；
//! `stamp_duty_pct`（卖方印花税）为可选用户参数，缺省 0.05（A 股股票口径，ADR bt-1）。
//! （父级 2026-xx 已批准：在 application 层完成映射，不改 backtest/fee 的 `FeeModel` 定义。）

use anyhow::{anyhow, Result};
use backtest::FeeModel;
use domain::ports::FeeProfileRow;

/// 缺省佣金率%（万2.5；ADR bt-1）。
pub const DEFAULT_COMMISSION_RATE_PCT: f64 = 0.025;
/// 缺省单笔最低佣金（元）。
pub const DEFAULT_MIN_FEE: f64 = 5.0;
/// 缺省滑点（bp）。
pub const DEFAULT_SLIPPAGE_BP: f64 = 2.0;
/// 缺省卖方印花税 0.05%（A 股股票口径，ADR bt-1）；ETF/LOF 类标的经档案解析为 0（D11）。
pub const DEFAULT_STAMP_DUTY_PCT: f64 = 0.05;

/// 生效费的来源（D11-3 响应回显三值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeSource {
    /// 调用方显式传 `fee`（整体以显式为准）。
    Explicit,
    /// 按标的 type 查 `fee_profiles` 解析。
    Profile,
    /// type 未知/无档案 → 回退旧 ADR bt-1 默认。
    Default,
}

impl FeeSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            FeeSource::Explicit => "explicit",
            FeeSource::Profile => "profile",
            FeeSource::Default => "default",
        }
    }
}

/// 费率解析结果：生效 `FeeModel` + 来源 + 解析路径（回显/审计用）。
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFee {
    /// 送入引擎的**生效**费用模型。
    pub model: FeeModel,
    pub source: FeeSource,
    /// 解析到的档案 type（None = 未解析到档案，例如 type 未设或无档案行）。
    pub symbol_type: Option<String>,
    /// 解析到的档案行（作为参考事实回显；`source=explicit` 时档案未被应用）。
    pub profile: Option<FeeProfileRow>,
}

/// 旧 ADR bt-1 默认（`backtest::FeeModel::default()` 同值；第三级回退与显式缺 stamp 时用）。
pub fn legacy_default_fee_model() -> FeeModel {
    FeeModel {
        commission_rate_pct: DEFAULT_COMMISSION_RATE_PCT,
        min_commission: DEFAULT_MIN_FEE,
        stamp_duty_pct: DEFAULT_STAMP_DUTY_PCT,
        slippage_bp: DEFAULT_SLIPPAGE_BP,
    }
}

/// 档案行 → 生效 `FeeModel`：本批引擎只消费佣金/最低/印花税（ADR-019 D11-2 注）；
/// `exchange_fee_pct`/`regulatory_fee_pct`/`transfer_fee_pct` 为事实/口径列（未建模，D11-follow-up）。
pub fn fee_model_from_profile(p: &FeeProfileRow) -> FeeModel {
    FeeModel {
        commission_rate_pct: p.commission_rate_pct,
        min_commission: p.min_fee,
        stamp_duty_pct: p.stamp_duty_pct,
        slippage_bp: DEFAULT_SLIPPAGE_BP,
    }
}

/// 三层费率解析（详见模块头注）：显式 > 档案（按 type）> 旧默认。
/// `profile` 为调用方按 `symbols.type` 查得（`FeeProfileStore::for_symbol`，查不到即 None）。
pub fn resolve_fee(explicit: Option<&serde_json::Value>, profile: Option<FeeProfileRow>) -> Result<ResolvedFee> {
    let symbol_type = profile.as_ref().map(|p| p.type_.clone());
    let model = match explicit {
        Some(v) => to_fee_model(v)?,
        None => match &profile {
            Some(p) => fee_model_from_profile(p),
            None => legacy_default_fee_model(),
        },
    };
    let source = match explicit {
        Some(_) => FeeSource::Explicit,
        None if profile.is_some() => FeeSource::Profile,
        None => FeeSource::Default,
    };
    Ok(ResolvedFee { model, source, symbol_type, profile })
}

/// I-3/D6：`FeeModel -> serde_json`（**输入/预设钉住**形态：`{rate_pct, min_fee, slippage_bp, stamp_duty_pct}`）。
/// 注意：这是**提交入参**兼容形态（供预设 config 回填后再次提交），**不是**响应回显；
/// 响应/运行快照一律用 [`resolved_fee_to_json`] 的两段（`effective`/`profile`+`not_modeled`）结构。
pub fn fee_model_to_json(m: &FeeModel) -> serde_json::Value {
    serde_json::json!({
        "rate_pct": m.commission_rate_pct,
        "min_fee": m.min_commission,
        "slippage_bp": m.slippage_bp,
        "stamp_duty_pct": m.stamp_duty_pct,
    })
}

/// 档案字段 → 生效 `FeeModel` 的**消费映射**（单一事实源，与 [`fee_model_from_profile`] 一一对应）：
/// 未列入本表的档案数值费率字段 = 引擎**未消费** → 回显段 `profile.not_modeled`。
/// 注意 `min_fee` 在 `FeeModel` 中名为 `min_commission`；`slippage_bp` 非档案字段（取 ADR bt-1 默认）。
const PROFILE_CONSUMED_FIELDS: [&str; 3] = ["commission_rate_pct", "min_fee", "stamp_duty_pct"];

/// 档案非费率元数据字段（派生 `not_modeled` 时排除；不属费率事实）。
const PROFILE_META_FIELDS: [&str; 3] = ["type", "note", "source"];

/// 由档案回显对象派生 `not_modeled` 清单：
/// = `profile` 数值费率键 − [`PROFILE_CONSUMED_FIELDS`]（升序，确定性输出）。
/// **不硬编码**清单：新增/删除档案字段会自动体现，避免清单与实现脱节。
fn not_modeled_fields(profile_obj: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    let mut fields: Vec<String> = profile_obj
        .keys()
        .filter(|k| !PROFILE_META_FIELDS.contains(&k.as_str()))
        .filter(|k| !PROFILE_CONSUMED_FIELDS.contains(&k.as_str()))
        .cloned()
        .collect();
    fields.sort_unstable();
    fields
}

/// D11-fix 响应回显：**显式区分两段**，消除「档案规费被误读为已计入成本」的误导。
/// - `effective`：引擎**实际应用**的参数（`commission_rate_pct`/`min_fee`/`stamp_duty_pct`/`slippage_bp`）
///   + `source`（explicit|profile|default）——**任何未参与撮合的档案字段不得出现在此段**；
/// - `profile`：解析到的档案**全量事实**字段 + `not_modeled`（经手费/证管费/过户费，引擎未建模 →
///   显式标注其未参与撮合，**始终**列出，schema 稳定）；
/// - `symbol_type`：解析到的标的类型（None = 未解析）。
pub fn resolved_fee_to_json(r: &ResolvedFee) -> serde_json::Value {
    let mut j = serde_json::json!({
        "effective": {
            "commission_rate_pct": r.model.commission_rate_pct,
            "min_fee": r.model.min_commission,
            "stamp_duty_pct": r.model.stamp_duty_pct,
            "slippage_bp": r.model.slippage_bp,
            "source": r.source.as_str(),
        },
        "symbol_type": match &r.symbol_type {
            Some(t) => serde_json::json!(t),
            None => serde_json::Value::Null,
        },
    });
    let obj = j.as_object_mut().expect("resolved fee json 恒为对象");
    if let Some(p) = &r.profile {
        let mut pj = serde_json::json!({
            "type": p.type_,
            "commission_rate_pct": p.commission_rate_pct,
            "min_fee": p.min_fee,
            "exchange_fee_pct": p.exchange_fee_pct,
            "regulatory_fee_pct": p.regulatory_fee_pct,
            "stamp_duty_pct": p.stamp_duty_pct,
            "transfer_fee_pct": p.transfer_fee_pct,
            "note": p.note,
            "source": p.source,
        });
        let pc = pj.as_object_mut().expect("profile json 恒为对象");
        let not_modeled = not_modeled_fields(pc);
        pc.insert("not_modeled".into(), serde_json::json!(not_modeled));
        obj.insert("profile".into(), pj);
    }
    j
}

/// `serde_json::Value` `{rate_pct, min_fee, slippage_bp, stamp_duty_pct?}` → [`FeeModel`]。
/// `stamp_duty_pct` 缺省 0.05（完全向后兼容）；若提供须为数值且 ∈ [0, 1]，否则报错（web 层同口径 400）。
pub fn to_fee_model(fee: &serde_json::Value) -> Result<FeeModel> {
    let obj = fee.as_object().ok_or_else(|| anyhow!("fee 应为对象"))?;
    let rate_pct = obj
        .get("rate_pct")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow!("fee.rate_pct 缺失或非数值"))?;
    let min_fee = obj
        .get("min_fee")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow!("fee.min_fee 缺失或非数值"))?;
    let slippage_bp = obj
        .get("slippage_bp")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow!("fee.slippage_bp 缺失或非数值"))?;
    let stamp_duty_pct = match obj.get("stamp_duty_pct") {
        None => DEFAULT_STAMP_DUTY_PCT,
        Some(v) => {
            let x = v
                .as_f64()
                .ok_or_else(|| anyhow!("fee.stamp_duty_pct 应为数值"))?;
            if !(0.0..=1.0).contains(&x) {
                return Err(anyhow!("fee.stamp_duty_pct 须 ∈ [0,1]（百分比）"));
            }
            x
        }
    };
    Ok(FeeModel {
        commission_rate_pct: rate_pct,
        min_commission: min_fee,
        stamp_duty_pct,
        slippage_bp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn maps_three_fields_and_defaults_stamp_duty() {
        let fee = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
        let m = to_fee_model(&fee).unwrap();
        assert_eq!(m.commission_rate_pct, 0.025);
        assert_eq!(m.min_commission, 5.0);
        assert_eq!(m.slippage_bp, 2.0);
        assert_eq!(m.stamp_duty_pct, 0.05, "stamp_duty_pct 应为 ADR bt-1 常量");
    }

    #[test]
    fn rejects_missing_field() {
        let fee = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0});
        assert!(to_fee_model(&fee).is_err(), "缺 slippage_bp 应报错");
    }

    #[test]
    fn etf_fee_explicit_zero_stamp_duty_sell_free() {
        // ETF 口径（研发任务裁决）：显式 stamp_duty_pct=0 → 卖出零印花税。
        let fee = serde_json::json!({"rate_pct": 0.005, "min_fee": 0.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0});
        let m = to_fee_model(&fee).unwrap();
        assert_eq!(m.stamp_duty_pct, 0.0, "ETF 显式传 0 应免印花税");
        let sell = m.sell(1000.0, 10.0);
        assert_eq!(sell.stamp_duty, 0.0, "ETF 口径卖出应零印花税");
    }

    #[test]
    fn default_fee_sell_still_charges_stamp_duty() {
        // 缺省回归（向后兼容）：未传 stamp_duty_pct 仍按 0.05% 收卖方印花税。
        let m = to_fee_model(&serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})).unwrap();
        let sell = m.sell(1000.0, 10.0);
        let expected = sell.trade_value * 0.0005;
        assert!((sell.stamp_duty - expected).abs() < 1e-9, "缺省口径卖出仍收 0.05% 印花税");
    }

    #[test]
    fn stamp_duty_pct_out_of_range_rejected() {
        for bad in [-0.1_f64, 1.5] {
            let fee = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": bad});
            assert!(to_fee_model(&fee).is_err(), "stamp_duty_pct={bad} 越界应报错");
        }
        let nonnum = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": "0"});
        assert!(to_fee_model(&nonnum).is_err(), "stamp_duty_pct 非数值应报错");
    }

    #[test]
    fn rejects_non_object() {
        assert!(to_fee_model(&serde_json::json!(42)).is_err());
    }

    // ── ADR-019 / D11-3：按类型推断费率 + 来源回显 ──

    fn etf_profile() -> domain::ports::FeeProfileRow {
        domain::ports::FeeProfileRow {
            type_: "etf".into(),
            commission_rate_pct: 0.025,
            min_fee: 5.0,
            exchange_fee_pct: 0.0,
            regulatory_fee_pct: 0.0,
            stamp_duty_pct: 0.0,
            transfer_fee_pct: 0.0,
            note: "全佣口径：经手费/证管费列 0；印花税不征".into(),
            source: "ADR-019 §1.1".into(),
        }
    }

    fn stock_profile() -> domain::ports::FeeProfileRow {
        domain::ports::FeeProfileRow {
            type_: "stock".into(),
            commission_rate_pct: 0.025,
            min_fee: 5.0,
            exchange_fee_pct: 0.00341,
            regulatory_fee_pct: 0.002,
            stamp_duty_pct: 0.05,
            transfer_fee_pct: 0.001,
            note: "A 股事实费率；规费未建模（D11-follow-up）".into(),
            source: "ADR-019 §1.2".into(),
        }
    }

    #[test]
    fn legacy_default_matches_adr_bt1() {
        let m = legacy_default_fee_model();
        assert_eq!(m.commission_rate_pct, DEFAULT_COMMISSION_RATE_PCT);
        assert_eq!(m.min_commission, DEFAULT_MIN_FEE);
        assert_eq!(m.slippage_bp, DEFAULT_SLIPPAGE_BP);
        assert_eq!(m.stamp_duty_pct, DEFAULT_STAMP_DUTY_PCT);
        assert_eq!(m, FeeModel::default(), "旧默认必须与 backtest::FeeModel::default 一致");
    }

    #[test]
    fn explicit_fee_wins_over_profile_and_keeps_legacy_stamp_default() {
        // 显式传对象（未传 stamp）→ 以显式为准 + 旧行为 0.05（向后兼容，ADR-019 §3.2）。
        let explicit = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
        let r = resolve_fee(Some(&explicit), Some(etf_profile())).unwrap();
        assert_eq!(r.source, FeeSource::Explicit);
        assert_eq!(r.model.stamp_duty_pct, 0.05, "显式分支缺 stamp → 旧默认 0.05（可复现旧行为）");
        assert_eq!(r.model.commission_rate_pct, 0.025);
        assert_eq!(r.symbol_type.as_deref(), Some("etf"), "仍回显标的类型供对照");

        // ETF 显式 stamp=0 → 以显式 0 为准（卖出零印花税）。
        let explicit0 = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0,
                                          "slippage_bp": 2.0, "stamp_duty_pct": 0.0});
        let r0 = resolve_fee(Some(&explicit0), Some(etf_profile())).unwrap();
        assert_eq!(r0.source, FeeSource::Explicit);
        assert_eq!(r0.model.stamp_duty_pct, 0.0);
        assert_eq!(r0.model.sell(1000.0, 10.0).stamp_duty, 0.0);
    }

    #[test]
    fn missing_fee_resolves_profile_by_symbol_type() {
        let r = resolve_fee(None, Some(etf_profile())).unwrap();
        assert_eq!(r.source, FeeSource::Profile);
        assert_eq!(r.symbol_type.as_deref(), Some("etf"));
        assert_eq!(r.model.commission_rate_pct, 0.025);
        assert_eq!(r.model.min_commission, 5.0);
        assert_eq!(r.model.stamp_duty_pct, 0.0, "ETF 印花税不征 → 0（ADR-019 §1.1）");
        assert_eq!(r.model.slippage_bp, DEFAULT_SLIPPAGE_BP, "滑点非费率事实 → ADR bt-1 默认 2bp");
        assert_eq!(r.model.sell(1000.0, 10.0).stamp_duty, 0.0, "ETF 缺省卖出零印花税（D11 主目标）");

        // 股票档案（将来注册个股）：事实口径 0.05 卖出印花税。
        let rs = resolve_fee(None, Some(stock_profile())).unwrap();
        assert_eq!(rs.source, FeeSource::Profile);
        assert_eq!(rs.symbol_type.as_deref(), Some("stock"));
        assert_eq!(rs.model.stamp_duty_pct, 0.05);
    }

    #[test]
    fn missing_fee_and_unknown_type_falls_back_to_legacy_default() {
        // type IS NULL / 无档案行 → 第三级回退（source=default），不静默借用他类型档案。
        let r = resolve_fee(None, None).unwrap();
        assert_eq!(r.source, FeeSource::Default);
        assert_eq!(r.symbol_type, None);
        assert_eq!(r.profile, None);
        assert_eq!(r.model, legacy_default_fee_model());
    }

    #[test]
    fn resolve_fee_propagates_invalid_explicit_fee() {
        let bad = serde_json::json!({"rate_pct": 0.025});
        assert!(resolve_fee(Some(&bad), Some(etf_profile())).is_err(), "缺字段的显式 fee 仍须报错");
        assert!(resolve_fee(Some(&serde_json::json!(42)), None).is_err());
    }

    #[test]
    fn resolved_json_exposes_effective_and_profile_segments() {
        // profile 分支：effective=生效值+source；profile=档案事实 + not_modeled 显式清单
        let r = resolve_fee(None, Some(etf_profile())).unwrap();
        let j = resolved_fee_to_json(&r);
        assert_eq!(j["effective"]["commission_rate_pct"], serde_json::json!(0.025));
        assert_eq!(j["effective"]["min_fee"], serde_json::json!(5.0));
        assert_eq!(j["effective"]["slippage_bp"], serde_json::json!(2.0));
        assert_eq!(j["effective"]["stamp_duty_pct"], serde_json::json!(0.0));
        assert_eq!(j["effective"]["source"], serde_json::json!("profile"));
        assert_eq!(j["symbol_type"], serde_json::json!("etf"));
        assert_eq!(j["profile"]["exchange_fee_pct"], serde_json::json!(0.0));
        assert_eq!(j["profile"]["regulatory_fee_pct"], serde_json::json!(0.0));
        assert_eq!(j["profile"]["transfer_fee_pct"], serde_json::json!(0.0));
        assert_eq!(
            j["profile"]["not_modeled"],
            serde_json::json!(["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"]),
            "档案全量回显须显式标注未建模的三项规费（防误读为已计入成本）"
        );
        assert!(j["profile"]["note"].as_str().unwrap().contains("全佣"));

        // explicit 分支：effective 取显式值 + source=explicit（profile 仍作对照事实）
        let explicit = serde_json::json!({"rate_pct": 0.005, "min_fee": 0.0, "slippage_bp": 2.0,
                                          "stamp_duty_pct": 0.0});
        let je = resolved_fee_to_json(&resolve_fee(Some(&explicit), Some(stock_profile())).unwrap());
        assert_eq!(je["effective"]["commission_rate_pct"], serde_json::json!(0.005));
        assert_eq!(je["effective"]["min_fee"], serde_json::json!(0.0));
        assert_eq!(je["effective"]["source"], serde_json::json!("explicit"));
        assert_eq!(je["symbol_type"], serde_json::json!("stock"));
        assert_eq!(je["profile"]["stamp_duty_pct"], serde_json::json!(0.05), "档案明细=参考事实值");

        // default 分支：无档案 → 无 profile 键、symbol_type 为 null、effective.source=default
        let jd = resolved_fee_to_json(&resolve_fee(None, None).unwrap());
        assert_eq!(jd["effective"]["source"], serde_json::json!("default"));
        assert_eq!(jd["effective"]["stamp_duty_pct"], serde_json::json!(0.05));
        assert!(jd.get("profile").is_none(), "无档案 → 不回显 profile 明细");
        assert_eq!(jd["symbol_type"], serde_json::Value::Null);
    }

    /// D11-fix 语义红线：**任何未参与撮合的档案字段不得出现在 `effective` 段**。
    #[test]
    fn effective_excludes_unmodeled_profile_fields() {
        // stock 档案三项规费均非零，最能暴露「误回显」
        let j = resolved_fee_to_json(&resolve_fee(None, Some(stock_profile())).unwrap());
        let eff = j["effective"].as_object().expect("effective 对象");
        for k in ["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"] {
            assert!(!eff.contains_key(k), "{k} 未参与撮合，不得出现在 effective 段（实际: {eff:?}）");
        }
        assert_eq!(
            eff.keys().cloned().collect::<BTreeSet<_>>(),
            ["commission_rate_pct", "min_fee", "stamp_duty_pct", "slippage_bp", "source"]
                .iter().map(ToString::to_string).collect::<BTreeSet<_>>(),
            "effective 段 = FeeModel 四字段（min_commission 回显名 min_fee）+ source，无其它"
        );
    }

    /// `not_modeled` 与实际回显的档案字段集严格对应（= 档案数值字段 − 引擎消费字段），清单完整。
    #[test]
    fn not_modeled_matches_profile_numeric_fields_minus_consumed() {
        let j = resolved_fee_to_json(&resolve_fee(None, Some(stock_profile())).unwrap());
        let p = j["profile"].as_object().unwrap();
        // 档案数值费率字段集（排除 type/note/source 元数据与 not_modeled 自身）
        let mut fee_fields: Vec<&str> = p
            .keys()
            .map(String::as_str)
            .filter(|k| !["type", "note", "source", "not_modeled"].contains(k))
            .collect();
        fee_fields.sort_unstable();
        assert_eq!(
            fee_fields,
            ["commission_rate_pct", "exchange_fee_pct", "min_fee",
             "regulatory_fee_pct", "stamp_duty_pct", "transfer_fee_pct"],
            "档案回显数值字段集须与 FeeProfileRow 数值字段一致（缺/多皆失败）"
        );
        let nm: Vec<&str> = p["not_modeled"].as_array().unwrap().iter()
            .map(|v| v.as_str().unwrap()).collect();
        assert_eq!(
            nm,
            ["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"],
            "not_modeled 须 = 档案数值字段 − PROFILE_CONSUMED_FIELDS"
        );
        for k in PROFILE_CONSUMED_FIELDS {
            assert!(!nm.contains(&k), "{k} 已参与撮合，不得标为未建模");
        }
    }

    /// `effective` 段字段严格对应 `backtest::FeeModel` 的实际字段集（`min_commission` 回显名 `min_fee`），
    /// 且与 `not_modeled` 清单**互斥**——防止「硬编码清单与实现脱节」。
    #[test]
    fn effective_strictly_matches_fee_model_fields_and_is_disjoint_from_not_modeled() {
        // FeeModel serde 字段 = 引擎字段的权威定义（实现变更时本测试即红）
        let model_keys: BTreeSet<String> = serde_json::to_value(FeeModel::default())
            .unwrap().as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            model_keys,
            ["commission_rate_pct", "min_commission", "stamp_duty_pct", "slippage_bp"]
                .iter().map(ToString::to_string).collect::<BTreeSet<_>>(),
            "FeeModel 实际字段集变更时必须同步 effective 段与 not_modeled 派生"
        );
        let j = resolved_fee_to_json(&resolve_fee(None, Some(stock_profile())).unwrap());
        let eff_keys: BTreeSet<String> = j["effective"].as_object().unwrap()
            .keys().filter(|k| k.as_str() != "source").cloned().collect();
        let aliased: BTreeSet<String> = eff_keys.iter()
            .map(|k| if k == "min_fee" { "min_commission".to_string() } else { k.clone() })
            .collect();
        assert_eq!(aliased, model_keys, "effective 生效字段须与 FeeModel 字段集一一对应");
        let nm: BTreeSet<String> = j["profile"]["not_modeled"].as_array().unwrap().iter()
            .map(|v| v.as_str().unwrap().to_string()).collect();
        assert!(nm.is_disjoint(&model_keys), "not_modeled 与 FeeModel 字段集不得相交: {nm:?}");
    }

    /// `PROFILE_CONSUMED_FIELDS` 与 `fee_model_from_profile` 的实际消费严格一致（单一事实源锁定）。
    #[test]
    fn consumed_profile_fields_are_exactly_what_engine_applies() {
        let p = domain::ports::FeeProfileRow {
            type_: "stock".into(),
            commission_rate_pct: 0.11,
            min_fee: 2.22,
            exchange_fee_pct: 3.33,
            regulatory_fee_pct: 4.44,
            stamp_duty_pct: 5.55,
            transfer_fee_pct: 6.66,
            note: String::new(),
            source: String::new(),
        };
        let m = fee_model_from_profile(&p);
        assert_eq!(m.commission_rate_pct, 0.11);
        assert_eq!(m.min_commission, 2.22);
        assert_eq!(m.stamp_duty_pct, 5.55);
        assert_eq!(m.slippage_bp, DEFAULT_SLIPPAGE_BP, "滑点非档案字段 → ADR bt-1 默认");
        let applied = [m.commission_rate_pct, m.min_commission, m.stamp_duty_pct, m.slippage_bp];
        for (name, v) in [("exchange_fee_pct", 3.33), ("regulatory_fee_pct", 4.44), ("transfer_fee_pct", 6.66)] {
            assert!(!applied.contains(&v), "{name} 未建模：不得进入 FeeModel（实际 applied={applied:?}）");
        }
        assert_eq!(
            PROFILE_CONSUMED_FIELDS,
            ["commission_rate_pct", "min_fee", "stamp_duty_pct"],
            "消费映射须与 fee_model_from_profile 一致；改动 FeeModel 消费范围时必须同步"
        );
    }
}
