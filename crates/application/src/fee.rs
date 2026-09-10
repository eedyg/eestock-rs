//! 回测费用映射：`serde_json` fee → `backtest::fee::FeeModel`。
//! 设计 §7/06-web 的提交 fee 为用户可调 3 字段 `{rate_pct, min_fee, slippage_bp}`；
//! `backtest::FeeModel` 需要 4 字段，`stamp_duty_pct`（卖方印花税）为**可选用户参数**：
//! 缺省 0.05（A 股股票口径，ADR bt-1）；ETF 类回测显式传 0（研发任务架构裁决修订——
//! 原「非用户参数」注记作废：平台宣称支持 ETF 而 ETF 现实无印花税，属平台缺陷修复）。
//! 字段映射：`rate_pct -> commission_rate_pct`、`min_fee -> min_commission`、`slippage_bp -> slippage_bp`。
//! （父级 2026-xx 已批准：在 application 层完成映射，不改 backtest/fee 的 `FeeModel` 定义。）

use anyhow::{anyhow, Result};
use backtest::FeeModel;

/// 缺省卖方印花税 0.05%（A 股股票口径，ADR bt-1）；ETF 类回测显式传 0。
const DEFAULT_STAMP_DUTY_PCT: f64 = 0.05;

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
}
