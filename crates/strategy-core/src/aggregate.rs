//! 聚合评分与信号判定（ADR §6 步骤 1-3，D2）。

use backtest::StrategyParams;
use serde::{Deserialize, Serialize};

/// 中立分：无覆盖 / 全部熔断 / 插件错误 bar 的兜底分（ADR §6 步骤 2 / ABI G5）。
pub const NEUTRAL_SCORE: f64 = 50.0;
/// 默认买入阈值（ADR §6 步骤 3）。
pub const DEFAULT_BUY_THRESHOLD: f64 = 60.0;
/// 默认卖出阈值（ADR §6 步骤 3）。
pub const DEFAULT_SELL_THRESHOLD: f64 = 40.0;

/// 引擎信号（聚合分经阈值判定后的三态；与 backtest::Signal 区分——本信号不含资金比例，
/// 仓位换算全部归 ExecutionPolicy，ADR §13.1 决策层/执行层分离）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TradeSignal {
    Buy,
    Sell,
    Hold,
}

/// 策略槽位：一个插件实例的静态配置（代码 + sha256 寻址 + 参数 + 聚合权重）。
///
/// 不变量（MINOR-4）：字段私有，唯一构造入口 [`StrategySlot::new`] 校验 weight > 0 且有限、
/// code/code_hash 非空——外部无法构造出非法 slot。
#[derive(Debug, Clone, PartialEq)]
pub struct StrategySlot {
    /// 插件 JS 源码（发布版本内容）。
    code: String,
    /// 发布版本 sha256（ABI G4 寻址/留痕；错误事件自含此字段）。
    code_hash: String,
    /// 运行参数（按 schema 校验/填缺省为消费方职责，ABI §1 NIT-6 裁决；此处原样透传）。
    params: StrategyParams,
    /// 聚合权重，必须 > 0（ADR D2 加权平均）。
    weight: f64,
}

impl StrategySlot {
    /// 构造并校验（weight 必须为正且有限；code/code_hash 非空）。
    pub fn new(
        code: impl Into<String>,
        code_hash: impl Into<String>,
        params: StrategyParams,
        weight: f64,
    ) -> Result<Self, String> {
        let code = code.into();
        let code_hash = code_hash.into();
        if !weight.is_finite() || weight <= 0.0 {
            return Err(format!("聚合权重必须为正有限值（ADR D2），got {weight}"));
        }
        if code.is_empty() {
            return Err("插件代码不能为空".to_string());
        }
        if code_hash.is_empty() {
            return Err("code_hash（sha256 寻址，ABI G4）不能为空".to_string());
        }
        Ok(Self {
            code,
            code_hash,
            params,
            weight,
        })
    }

    /// 插件 JS 源码。
    pub fn code(&self) -> &str {
        &self.code
    }

    /// 发布版本 sha256（ABI G4 寻址）。
    pub fn code_hash(&self) -> &str {
        &self.code_hash
    }

    /// 运行参数（原样透传）。
    pub fn params(&self) -> &StrategyParams {
        &self.params
    }

    /// 聚合权重（构造时校验 > 0）。
    pub fn weight(&self) -> f64 {
        self.weight
    }
}

/// 加权聚合（ADR §6 步骤 2）：Σ(w·s)/Σw，仅覆盖传入的 slot；
/// 空切片（无覆盖/全部熔断）→ [`NEUTRAL_SCORE`]。
///
/// `scores` 为 `(weight, score)` 序列——调用方（引擎）负责排除已熔断 slot。
pub fn aggregate(scores: &[(f64, f64)]) -> f64 {
    let mut wsum = 0.0;
    let mut wssum = 0.0;
    for (w, s) in scores {
        wsum += w;
        wssum += w * s;
    }
    if wsum > 0.0 {
        wssum / wsum
    } else {
        NEUTRAL_SCORE
    }
}

/// 信号判定（ADR §6 步骤 3）：aggregate ≥ buy_threshold → Buy；
/// ≤ sell_threshold → Sell；否则 Hold。阈值恰值归入对应方向（边界含等号）。
pub fn classify(aggregate: f64, buy_threshold: f64, sell_threshold: f64) -> TradeSignal {
    if aggregate >= buy_threshold {
        TradeSignal::Buy
    } else if aggregate <= sell_threshold {
        TradeSignal::Sell
    } else {
        TradeSignal::Hold
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use backtest::{ParamValue, StrategyParams};

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "expected {b}, got {a}");
    }

    // ---- StrategySlot 校验 ----

    #[test]
    fn slot_rejects_non_positive_weight() {
        let p = StrategyParams::new();
        assert!(StrategySlot::new("code", "sha256:x", p.clone(), 0.0).is_err());
        assert!(StrategySlot::new("code", "sha256:x", p.clone(), -1.0).is_err());
        assert!(StrategySlot::new("code", "sha256:x", p.clone(), f64::NAN).is_err());
        assert!(StrategySlot::new("code", "sha256:x", p, f64::INFINITY).is_err());
    }

    #[test]
    fn slot_accepts_positive_weight() {
        let mut p = StrategyParams::new();
        p.insert("fast".to_string(), ParamValue::Num(5.0));
        let s = StrategySlot::new("code", "sha256:x", p, 1.5).expect("合法 slot");
        close(s.weight(), 1.5);
    }

    // ---- 聚合数学（ADR D2）----

    #[test]
    fn aggregate_weighted_mean() {
        // (2×80 + 1×30) / 3 = 190/3
        close(aggregate(&[(2.0, 80.0), (1.0, 30.0)]), 190.0 / 3.0);
    }

    #[test]
    fn aggregate_single_slot_equals_score() {
        close(aggregate(&[(3.0, 42.0)]), 42.0);
    }

    #[test]
    fn aggregate_empty_is_neutral() {
        // 无覆盖 / 全部熔断 → 中立 50（ADR §6 步骤 2）
        close(aggregate(&[]), NEUTRAL_SCORE);
        close(NEUTRAL_SCORE, 50.0);
    }

    // ---- 信号判定阈值边界（ADR §6 步骤 3，恰值归入对应方向）----

    #[test]
    fn classify_boundaries_exact() {
        assert_eq!(classify(60.0, 60.0, 40.0), TradeSignal::Buy, "恰值 60 → Buy");
        assert_eq!(classify(40.0, 60.0, 40.0), TradeSignal::Sell, "恰值 40 → Sell");
        assert_eq!(classify(59.999999, 60.0, 40.0), TradeSignal::Hold);
        assert_eq!(classify(40.000001, 60.0, 40.0), TradeSignal::Hold);
        assert_eq!(classify(50.0, 60.0, 40.0), TradeSignal::Hold);
        assert_eq!(classify(100.0, 60.0, 40.0), TradeSignal::Buy);
        assert_eq!(classify(0.0, 60.0, 40.0), TradeSignal::Sell);
    }

    #[test]
    fn classify_custom_thresholds() {
        assert_eq!(classify(70.0, 70.0, 30.0), TradeSignal::Buy);
        assert_eq!(classify(30.0, 70.0, 30.0), TradeSignal::Sell);
        assert_eq!(classify(50.0, 70.0, 30.0), TradeSignal::Hold);
    }
}
