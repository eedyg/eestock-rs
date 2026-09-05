//! 回测费用映射：`serde_json` fee → `backtest::fee::FeeModel`。
//! 设计 §7/06-web 的提交 fee 为用户可调 3 字段 `{rate_pct, min_fee, slippage_bp}`；
//! `backtest::FeeModel` 需要 4 字段，其中 `stamp_duty_pct`（卖方印花税）为 **ADR bt-1 市场常量 0.05%**，非用户参数。
//! 字段映射：`rate_pct -> commission_rate_pct`、`min_fee -> min_commission`、`slippage_bp -> slippage_bp`。
//! （父级 2026-xx 已批准：在 application 层完成映射，不改 backtest/fee 的 `FeeModel` 定义。）

use anyhow::{anyhow, Result};
use backtest::FeeModel;

/// ADR bt-1：卖方印花税 0.05%（市场常量，非用户参数）。
const DEFAULT_STAMP_DUTY_PCT: f64 = 0.05;

/// `serde_json::Value` `{rate_pct, min_fee, slippage_bp}` → [`FeeModel`]。
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
    Ok(FeeModel {
        commission_rate_pct: rate_pct,
        min_commission: min_fee,
        stamp_duty_pct: DEFAULT_STAMP_DUTY_PCT,
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
    fn rejects_non_object() {
        assert!(to_fee_model(&serde_json::json!(42)).is_err());
    }
}
