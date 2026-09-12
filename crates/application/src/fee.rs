//! 回测费用映射与**按标的类型推断费率**（ADR-019 / D11-3；v1.1 修订 R-2/R-3）。
//!
//! 费率解析（`resolve_fee`）= **按字段优先级**（ADR-019 v1.1 R-2）：
//! 1. **显式字段优先**：显式 `fee` 对象中**出现的**字段以其值（并校验）为准；
//! 2. **缺失字段回退档案**：显式未出现的字段 → 按标的 `symbols.type` 查 `fee_profiles`（D11-2）；
//! 3. **档案缺失再回退旧默认**：无档案行 / `type` 未设 → 旧 ADR bt-1 默认（0.025 / 5 / 0.05）。
//!    滑点非费率事实（档案无列）→ 档案分支取 ADR bt-1 默认 2bp。
//!
//! `source`（R-3）= 本次解析**最高优先级来源**：任一字段来自显式 → `"explicit"`；否则解析到档案 → `"profile"`；
//! 否则 → `"default"`。**口径注记**：`source="explicit"` **不等于**「所有字段都来自显式」——未出现的字段
//! 仍逐字段回退档案/默认。
//!
//! 字段映射：`rate_pct -> commission_rate_pct`、`min_fee -> min_commission`、`slippage_bp -> slippage_bp`；
//! `stamp_duty_pct`（卖方印花税）为可选字段，缺失时**按优先级回退**（档案/默认），不再固定 0.05
//! —— 这是 R-2 直接修复的回归（v1.0「对象存在=整体显式、缺失 stamp 取 0.05」使 UI 三键 fee 对 ETF 多收印花税）。
//!
//! **v1.1 补守卫（架构师裁决）**：显式 `fee` 对象**存在**但**不含任何可识别字段**
//! （`{}` / 全未知键，如 `{"foo":1}`）→ **报错（HTTP 400 / MCP isError）**，消息指明可识别字段集
//! 与实际收到的键。含 **≥1 个**可识别字段（[`RECOGNIZED_FEE_FIELDS`]）→ 正常字段级解析（缺失字段逐级回退，
//! 不报错）。理由：空/全未知键是典型调用方 bug，静默按"全量回退"属"静默失真"类缺陷（同 I-1 静默空返回），
//! 必须 fail-fast；而"部分字段"（如 UI 三键不带 stamp）是合法意图，必须允许。
//! **HTTP 层 `validate_backtest_fee` 三键预校验保持不变**（UI 契约）；本守卫作用于本模块（API/服务层解析点）。
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

/// 显式 `fee` 对象**可识别（入参形态）字段集**：调用方入参至少须含其一（ADR-019 v1.1 补守卫）。
/// **注意**：这是**入参**键名，与档案列名（`commission_rate_pct` 等）不同；`stamp_duty_pct` 虽可省略，
/// 但"本对象根本没有任何费率入参"属调用方 bug → fail-fast。
pub const RECOGNIZED_FEE_FIELDS: [&str; 4] = ["rate_pct", "min_fee", "slippage_bp", "stamp_duty_pct"];

/// 生效费的来源（D11-3 响应回显三值；v1.1 R-3：取**最高优先级来源**，非"所有字段均来自该类"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeSource {
    /// 至少一个字段来自调用方显式 `fee` 对象（其余字段仍可回退档案/默认）。
    Explicit,
    /// 无字段来自显式，但解析到标的 type 的 `fee_profiles` 档案。
    Profile,
    /// 无显式字段且 type 未知/无档案 → 回退旧 ADR bt-1 默认。
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

/// 费率解析（详见模块头注）：**按字段优先级** 显式字段 > 档案（按 type）> 旧默认。
/// `profile` 为调用方按 `symbols.type` 查得（`FeeProfileStore::for_symbol`，查不到即 None）。
///
/// **守卫（v1.1 补）**：显式对象**存在但无任何可识别字段**（`{}` / 全未知键）→ 报错（400/isError）；
/// 含 ≥1 可识别字段（[`RECOGNIZED_FEE_FIELDS`]）→ 出现的字段生效 + 缺失字段逐级回退。
pub fn resolve_fee(explicit: Option<&serde_json::Value>, profile: Option<FeeProfileRow>) -> Result<ResolvedFee> {
    let symbol_type = profile.as_ref().map(|p| p.type_.clone());
    // 基础值 = 档案（若有）否则旧默认；显式字段在其上**逐字段**覆盖（v1.1 R-2）。
    let base = match &profile {
        Some(p) => fee_model_from_profile(p),
        None => legacy_default_fee_model(),
    };
    let (model, source) = match explicit {
        None => {
            let source = if profile.is_some() { FeeSource::Profile } else { FeeSource::Default };
            (base, source)
        }
        Some(v) => {
            let obj = v.as_object().ok_or_else(|| anyhow!("fee 应为对象"))?;
            // v1.1 补守卫（架构师裁决）：显式对象**存在**但**不含任何可识别字段**（`{}`/全未知键）
            // → fail-fast（调用方 bug；不得静默按"全量回退"处理，否则与 I-1 静默空返回同类缺陷）。
            // 含 ≥1 可识别字段（哪怕只有 1 个）→ 按字段级优先级解析，缺失字段逐字段回退。
            if !obj.keys().any(|k| RECOGNIZED_FEE_FIELDS.contains(&k.as_str())) {
                let mut got: Vec<&str> = obj.keys().map(String::as_str).collect();
                got.sort_unstable();
                let got = if got.is_empty() { "（空对象）".to_string() } else { got.join(", ") };
                return Err(anyhow!(
                    "fee 对象不含任何可识别字段（可识别: {}；当前收到: {got}）",
                    RECOGNIZED_FEE_FIELDS.join("/")
                ));
            }
            let mut m = base;
            let mut from_explicit = false;
            if let Some(x) = explicit_number(obj, "rate_pct")? {
                m.commission_rate_pct = x;
                from_explicit = true;
            }
            if let Some(x) = explicit_number(obj, "min_fee")? {
                m.min_commission = x;
                from_explicit = true;
            }
            if let Some(x) = explicit_number(obj, "slippage_bp")? {
                m.slippage_bp = x;
                from_explicit = true;
            }
            if let Some(x) = explicit_stamp_duty(obj)? {
                m.stamp_duty_pct = x;
                from_explicit = true;
            }
            let source = if from_explicit {
                FeeSource::Explicit
            } else if profile.is_some() {
                FeeSource::Profile
            } else {
                FeeSource::Default
            };
            (m, source)
        }
    };
    Ok(ResolvedFee { model, source, symbol_type, profile })
}

/// 读取显式 fee 对象的数值字段（缺失 → `None`；出现但非数值 → 报错）。
fn explicit_number(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<Option<f64>> {
    match obj.get(key) {
        None => Ok(None),
        Some(v) => v.as_f64().map(Some).ok_or_else(|| anyhow!("fee.{key} 应为数值")),
    }
}

/// 读取/校验显式 `stamp_duty_pct`（缺失 → `None`；出现须为数值且 ∈ [0,1]）。
fn explicit_stamp_duty(obj: &serde_json::Map<String, serde_json::Value>) -> Result<Option<f64>> {
    match obj.get("stamp_duty_pct") {
        None => Ok(None),
        Some(v) => {
            let x = v
                .as_f64()
                .ok_or_else(|| anyhow!("fee.stamp_duty_pct 应为数值"))?;
            if !(0.0..=1.0).contains(&x) {
                return Err(anyhow!("fee.stamp_duty_pct 须 ∈ [0,1]（百分比）"));
            }
            Ok(Some(x))
        }
    }
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
/// **用途**：解析**钉住/预设的扁平 fee**（[`fee_model_to_json`] 的往返形态；如工作台预设 CRUD），
/// 要求三键齐（缺 → 报错）；`stamp_duty_pct` 缺省 0.05（扁平预设无标的类型，不可推断）；
/// 若提供须为数值且 ∈ [0, 1]，否则报错（web 层同口径 400）。
/// **费率解析请用 [`resolve_fee`]**（字段级优先级，见模块头注）——不要把本函数用于调用方 fee 入参。
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

    // ── ADR-019 v1.1 R-2/R-3：按**字段**优先级解析（显式字段 > 档案 > 旧默认） ──

    /// 本批核心断言（R2-①）：UI 三键 fee（无 stamp）+ ETF 档案 → stamp=0。
    /// 字段级回退：缺失的 `stamp_duty_pct` 回退档案（ETF 不征 0），而非旧"整体显式→0.05"。
    #[test]
    fn explicit_three_keys_without_stamp_falls_back_to_etf_profile() {
        let ui = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
        let r = resolve_fee(Some(&ui), Some(etf_profile())).unwrap();
        assert_eq!(r.source, FeeSource::Explicit, "三键均来自显式 → source=explicit");
        assert_eq!(r.model.stamp_duty_pct, 0.0, "缺 stamp → 回退 ETF 档案 = 0（核心断言）");
        assert_eq!(r.model.sell(1000.0, 10.0).stamp_duty, 0.0, "ETF 卖出零印花税");
        assert_eq!(r.model.commission_rate_pct, 0.025, "显式 rate 生效");
        assert_eq!(r.model.min_commission, 5.0);
        assert_eq!(r.symbol_type.as_deref(), Some("etf"), "仍回显标的类型供对照");
    }

    /// R2-②：三键 fee（无 stamp）+ stock 档案 → stamp=0.05（回退档案事实，而非凭空旧默认）。
    #[test]
    fn explicit_three_keys_without_stamp_falls_back_to_stock_profile() {
        let ui = serde_json::json!({"rate_pct": 0.02, "min_fee": 5.0, "slippage_bp": 2.0});
        let r = resolve_fee(Some(&ui), Some(stock_profile())).unwrap();
        assert_eq!(r.source, FeeSource::Explicit);
        assert_eq!(r.model.commission_rate_pct, 0.02, "显式字段优先");
        assert_eq!(r.model.stamp_duty_pct, 0.05, "缺 stamp → 回退 stock 档案 0.05");
    }

    /// R2-③：显式 stamp=0.07 → 0.07（显式字段最高优先，覆盖档案与默认）。
    #[test]
    fn explicit_stamp_wins_over_profile() {
        let e = serde_json::json!({"rate_pct": 0.02, "min_fee": 5.0,
                                  "slippage_bp": 2.0, "stamp_duty_pct": 0.07});
        let r = resolve_fee(Some(&e), Some(stock_profile())).unwrap();
        assert_eq!(r.source, FeeSource::Explicit);
        assert_eq!(r.model.stamp_duty_pct, 0.07, "显式 stamp 优先于档案 0.05");
        // ETF 档案下显式 stamp=0.05 仍可复现旧口径（01-cases）
        let e2 = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0,
                                   "slippage_bp": 2.0, "stamp_duty_pct": 0.05});
        assert_eq!(resolve_fee(Some(&e2), Some(etf_profile())).unwrap().model.stamp_duty_pct, 0.05);
    }

    /// 显式仅含部分字段：出现的生效、缺失的逐字段回退档案（R-2 字段级核心语义）。
    #[test]
    fn partial_explicit_overrides_only_present_fields() {
        let partial = serde_json::json!({"rate_pct": 0.01});
        let r = resolve_fee(Some(&partial), Some(etf_profile())).unwrap();
        assert_eq!(r.source, FeeSource::Explicit, "有字段来自显式 → explicit");
        assert_eq!(r.model.commission_rate_pct, 0.01, "显式 rate 生效");
        assert_eq!(r.model.min_commission, 5.0, "缺 min_fee → 回退档案");
        assert_eq!(r.model.slippage_bp, DEFAULT_SLIPPAGE_BP, "缺 slippage → 回退档案（=默认）");
        assert_eq!(r.model.stamp_duty_pct, 0.0, "缺 stamp → 回退 ETF 档案 0");
        // 部分显式 + 无档案 → 缺失字段回退旧默认
        let r2 = resolve_fee(Some(&partial), None).unwrap();
        assert_eq!(r2.source, FeeSource::Explicit);
        assert_eq!(r2.model.commission_rate_pct, 0.01);
        assert_eq!(r2.model.stamp_duty_pct, DEFAULT_STAMP_DUTY_PCT, "无档案 → 缺失字段回退旧默认");
    }

    /// v1.1 补守卫（架构师裁决）：显式对象**存在**但**不含任何可识别字段**（`{}` / 全未知键）
    /// → **fail-fast 报错**（调用方 bug，不得静默按"全量回退"处理）。
    #[test]
    fn explicit_object_without_recognized_fields_is_rejected() {
        for (tag, v) in [
            ("empty_object", serde_json::json!({})),
            ("unknown_only", serde_json::json!({"foo": 1})),
            // 档案列名不是入参名（`commission_rate_pct` ∉ 可识别集）→ 视为未知键
            ("profile_column_name", serde_json::json!({"commission_rate_pct": 0.025})),
        ] {
            let err = resolve_fee(Some(&v), Some(etf_profile()))
                .expect_err(&format!("{tag}: 无可识别字段须报错"));
            let msg = err.to_string();
            assert!(msg.contains("可识别"), "{tag}: 错误消息须指明可识别字段集，实际: {msg}");
            for k in ["rate_pct", "min_fee", "slippage_bp", "stamp_duty_pct"] {
                assert!(msg.contains(k), "{tag}: 错误消息须列出可识别字段 {k}，实际: {msg}");
            }
            assert!(msg.contains("收到"), "{tag}: 错误消息须指明当前收到的键，实际: {msg}");
            // 无档案时同样须报错（守卫先于回退，不因缺档案而放行）
            assert!(resolve_fee(Some(&v), None).is_err(), "{tag}: 无档案时亦须报错");
        }
    }

    /// v1.1 补守卫正向面：显式对象含 **≥1 个可识别字段**（如仅 `rate_pct`）→ 合法。
    /// 出现的字段生效，缺失字段逐字段回退档案（不报错）。
    #[test]
    fn explicit_object_with_single_recognized_field_is_accepted() {
        let r = resolve_fee(Some(&serde_json::json!({"rate_pct": 0.025})), Some(etf_profile()))
            .expect("含 1 个可识别字段须放行");
        assert_eq!(r.source, FeeSource::Explicit, "有字段来自显式 → explicit");
        assert_eq!(r.model.commission_rate_pct, 0.025, "显式 rate 生效");
        assert_eq!(r.model.min_commission, etf_profile().min_fee, "缺 min_fee → 回退档案");
        assert_eq!(r.model.slippage_bp, DEFAULT_SLIPPAGE_BP, "缺 slippage → 回退档案（=默认）");
        assert_eq!(r.model.stamp_duty_pct, 0.0, "缺 stamp → 回退 ETF 档案 0");
        // 无档案时缺失字段回退旧默认，仍为成功（含可识别字段）
        let r2 = resolve_fee(Some(&serde_json::json!({"rate_pct": 0.025})), None).unwrap();
        assert_eq!(r2.source, FeeSource::Explicit);
        assert_eq!(r2.model.stamp_duty_pct, DEFAULT_STAMP_DUTY_PCT, "无档案 → 缺失字段回退旧默认");
    }

    /// 字段级校验：**出现的**字段非法（非数值/越界）仍须报错；未出现的字段不报缺。
    #[test]
    fn present_but_invalid_explicit_fields_still_error() {
        for bad in [
            serde_json::json!({"rate_pct": "x"}),
            serde_json::json!({"min_fee": serde_json::Value::Null}),
            serde_json::json!({"slippage_bp": "2"}),
            serde_json::json!({"stamp_duty_pct": 1.5}),
            serde_json::json!({"stamp_duty_pct": "0"}),
        ] {
            assert!(resolve_fee(Some(&bad), Some(etf_profile())).is_err(), "非法字段须报错: {bad}");
        }
        assert!(resolve_fee(Some(&serde_json::json!(42)), None).is_err(), "非对象须报错");
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
