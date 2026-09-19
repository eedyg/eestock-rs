//! 模拟实盘撮合（ADR 11-sim-live §6）：市价=按最新价即时成交；限价=价格触及成交；滑点/手续费按 FeeModel。
//!
//! 简化、非完整交易所撮合（与 backtest::fee 同口径）：
//! - 买成交价 = 原始价 × (1 + 滑点)；卖成交价 = 原始价 × (1 − 滑点)。
//! - 佣金 = `max(成交额 × 佣金率%, 最低佣金)`（买/卖各收一次）。
//! - 印花税 = 仅卖出收 `成交额 × 印花税%`。
//! - 限价单：买 `latest` 触价（`latest ≤ limit`）、卖 `latest` 触价（`latest ≥ limit`）即成交，
//!   成交参考价 = 限价（仍叠滑点/费用）。

use backtest::FeeModel;
use serde::{Deserialize, Serialize};

/// 方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn as_str(&self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "buy" => Some(Side::Buy),
            "sell" => Some(Side::Sell),
            _ => None,
        }
    }
}

/// 一笔成交（有效价已含滑点；费用**分列**为佣金与印花税）。
///
/// ADR-027 D4（2026-09-20）：费用必须由撮合点分列写出（佣金 / 印花税），
/// 禁止下游由 `(side, qty, price)` + 费率复算 —— `FeeModel` 最低佣金分支不可逆（`backtest/src/fee.rs`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fill {
    pub code: String,
    pub side: Side,
    pub qty: f64,
    /// 成交有效价（含滑点）。
    pub price: f64,
    /// 本笔佣金（含最低佣金）。
    pub commission: f64,
    /// 本笔印花税（买入恒 0）。
    pub stamp_duty: f64,
}

impl Fill {
    /// 费用合计（= `commission + stamp_duty`）：**派生读**，非第二事实源；
    /// 供账户账务与订单读模型沿用单列口径（`sim_trades.fee` 列语义同此）。
    pub fn fee(&self) -> f64 {
        self.commission + self.stamp_duty
    }
}

/// 一笔订单。`limit_price=None` 为市价单；`Some(p)` 为限价单。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Order {
    pub code: String,
    pub side: Side,
    pub qty: f64,
    pub limit_price: Option<f64>,
}

/// 订单级联 intent（幂等去重；见 SimLiveService）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct IntentId(pub String);

/// 撮合引擎（无状态，唯一费用模型）。
#[derive(Debug, Clone, Copy)]
pub struct FillEngine {
    pub fee: FeeModel,
}

impl FillEngine {
    pub fn new(fee: FeeModel) -> Self {
        Self { fee }
    }

    /// 给定最新价尝试撮合。市价单恒成交（latest 即时价）；限价单按触价判定。
    /// 返回 `Some(Fill)` 当且仅当成交。`latest ≤ 0`（无行情）不成交（市价也拒绝，防脏价）。
    pub fn try_fill(&self, order: &Order, latest: f64) -> Option<Fill> {
        // 无行情/脏价（NaN/≤0）不成交（市价也拒绝，防脏价）；数量须为正。
        let valid_price = latest.is_finite() && latest > 0.0;
        if !valid_price || order.qty <= 0.0 {
            return None;
        }
        let filled = match (order.side, order.limit_price) {
            // 市价：按最新价即时成交
            (Side::Buy, None) => Some(latest),
            (Side::Sell, None) => Some(latest),
            // 限价：触及成交
            (Side::Buy, Some(limit)) => (latest <= limit).then_some(limit),
            (Side::Sell, Some(limit)) => (latest >= limit).then_some(limit),
        };
        let ref_price = filled?;

        let eff_price = match order.side {
            Side::Buy => self.fee.buy_price(ref_price),
            Side::Sell => self.fee.sell_price(ref_price),
        };
        let trade_value = order.qty * eff_price;
        let commission = self.fee.commission(trade_value);
        let stamp_duty = match order.side {
            Side::Buy => 0.0,
            Side::Sell => self.fee.stamp_duty(trade_value),
        };
        Some(Fill {
            code: order.code.clone(),
            side: order.side,
            qty: order.qty,
            price: eff_price,
            commission,
            stamp_duty,
        })
    }
}

/// 降序（供会话/存储：会话内记录成交明细）。
/// 费用**分列**（ADR-027 D4）：`commission` + `stamp_duty` 为事实；`fee()` 为派生合计。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimTrade {
    pub code: String,
    pub side: Side,
    pub qty: f64,
    pub price: f64,
    pub ts: i64,
    /// 本笔佣金（含最低佣金）。
    pub commission: f64,
    /// 本笔印花税（买入恒 0）。
    pub stamp_duty: f64,
    /// 来源："strategy" | "manual" | "aggregate_strategy"（映射见 `backtest::FillReason`）。
    pub source: String,
}

impl SimTrade {
    /// 费用合计（= `commission + stamp_duty`）：派生读，供既有单列口径消费方沿用。
    pub fn fee(&self) -> f64 {
        self.commission + self.stamp_duty
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    fn order(code: &str, side: Side, qty: f64, limit: Option<f64>) -> Order {
        Order { code: code.into(), side, qty, limit_price: limit }
    }

    /// 市价买：按最新价即时成交，执行价含滑点，佣金按成交额计（0.025% 最低 5）。
    #[test]
    fn market_buy_fills_at_latest_with_slippage_and_commission() {
        let eng = FillEngine::new(FeeModel::default());
        let f = eng.try_fill(&order("510300", Side::Buy, 1000.0, None), 10.0).unwrap();
        close(f.price, 10.002); // 最新 10 × (1 + 2bp)
        close(f.qty, 1000.0);
        // 成交额 = 1000 × 10.002 = 10002 → 佣金 = 10002 × 0.00025 = 2.5005 < 5 → 取最低 5
        close(f.commission, 5.0);
        close(f.stamp_duty, 0.0); // 买入恒 0
        close(f.fee(), 5.0);
        assert_eq!(f.side, Side::Buy);
        assert_eq!(f.code, "510300");
    }

    /// 市价卖：执行价含滑点 + 佣金 + 印花税（仅卖）。
    #[test]
    fn market_sell_charges_slippage_commission_and_stamp() {
        let eng = FillEngine::new(FeeModel::default());
        let f = eng.try_fill(&order("510300", Side::Sell, 1000.0, None), 10.0).unwrap();
        close(f.price, 9.998); // 10 × (1 − 2bp)
        let tv = 1000.0 * 9.998; // 9998
        // commission = max(tv×0.00025, 5) = max(2.4995,5) = 5；stamp = tv×0.0005 = 4.999
        close(f.commission, 5.0);
        close(f.stamp_duty, tv * 0.0005);
        close(f.fee(), 5.0 + tv * 0.0005);
        assert_eq!(f.side, Side::Sell);
    }

    /// ADR-027 D4/R3：费用分列事实 —— 卖腿 `stamp_duty > 0` 且与买腿佣金口径独立
    /// （`Fill` 不再只有合并的 `fee`；`fee()` = 两列之和）。
    #[test]
    fn sell_fill_carries_stamp_duty_as_separate_fact() {
        let eng = FillEngine::new(FeeModel::default());
        let buy = eng.try_fill(&order("510300", Side::Buy, 1000.0, None), 10.0).unwrap();
        let sell = eng.try_fill(&order("510300", Side::Sell, 1000.0, None), 12.0).unwrap();
        assert_eq!(buy.stamp_duty, 0.0, "买入印花税恒 0");
        assert!(
            (sell.stamp_duty - 1000.0 * sell.price * 0.0005).abs() < 1e-12,
            "卖腿印花税 = 成交额 × 0.05%，实际 {}",
            sell.stamp_duty
        );
        assert!((sell.fee() - (sell.commission + sell.stamp_duty)).abs() < 1e-12);
        // 与 backtest::FeeModel::sell 的卖出执行体同源（逐位一致）。
        let exec = FeeModel::default().sell(1000.0, 12.0);
        assert!((sell.commission - exec.commission).abs() < 1e-12);
        assert!((sell.stamp_duty - exec.stamp_duty).abs() < 1e-12);
    }

    /// 限价买：latest ≤ limit 触及成交，参考价 = limit（仍叠滑点/佣金）。
    #[test]
    fn limit_buy_touches_at_or_below_limit() {
        let eng = FillEngine::new(FeeModel::default());
        // 最新 9.5 ≤ 限价 10 → 成交
        let f = eng.try_fill(&order("510300", Side::Buy, 100.0, Some(10.0)), 9.5).unwrap();
        close(f.price, 10.002); // 参考价 = 限价，叠滑点
        // 最新 10.2 > 限价 10 → 不成交
        assert!(eng.try_fill(&order("510300", Side::Buy, 100.0, Some(10.0)), 10.2).is_none());
    }

    /// 限价卖：latest ≥ limit 触及成交。
    #[test]
    fn limit_sell_touches_at_or_above_limit() {
        let eng = FillEngine::new(FeeModel::default());
        let f = eng.try_fill(&order("510300", Side::Sell, 100.0, Some(10.0)), 10.5).unwrap();
        close(f.price, 9.998); // 参考价 = 限价，叠滑点
        assert!(eng.try_fill(&order("510300", Side::Sell, 100.0, Some(10.0)), 9.8).is_none());
    }

    /// 无行情/脏价/非法数量：市价也拒绝（防脏价成交）。
    #[test]
    fn invalid_latest_or_qty_does_not_fill() {
        let eng = FillEngine::new(FeeModel::default());
        for (qty, latest) in [(100.0, 0.0), (100.0, -1.0), (0.0, 10.0), (-5.0, 10.0)] {
            assert!(eng.try_fill(&order("510300", Side::Buy, qty, None), latest).is_none(),
                "qty={qty}, latest={latest} 应拒单");
        }
    }

    /// Side::parse round-trip。（协议文本 → 枚举）。
    #[test]
    fn side_parse_roundtrip() {
        assert_eq!(Side::parse("buy"), Some(Side::Buy));
        assert_eq!(Side::parse("sell"), Some(Side::Sell));
        assert_eq!(Side::parse("hold"), None);
        assert_eq!(Side::Buy.as_str(), "buy");
        assert_eq!(Side::Sell.as_str(), "sell");
    }
}
