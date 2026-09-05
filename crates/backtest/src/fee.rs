//! 费用 / 滑点 / 成交模型（ADR §4，简化、非完整交易所撮合）。
//!
//! 口径（bt-1 默认值 + bt-2 成交假设 + 说明）：
//! - 默认值：佣金 0.025%（万2.5）最低 5 元；卖方印花税 0.05%；滑点 2bp（bt-1）。
//! - 成交价：买 = 价 ×(1+滑点)，卖 = 价 ×(1−滑点)。
//! - 佣金：`max(成交额 × 佣金率%, 最低佣金)`（买/卖各收一次）。
//! - 印花税：仅卖出收取 `成交额 × 印花税%`。
//! - 建仓预算扣费：为使总成本（成交额+佣金）不超过预算，本模型将佣金折入成交额
//!   （`shares = 预算/(成交价×(1+佣金率))*`；佣金触及最低时退回最低补偿），保证现金不因费用透支。
//!   这是 ADR §4「非完整撮合」的简化，真实 A 股 1 手=100 股整手规则不纳入。

use serde::{Deserialize, Serialize};

/// 费用模型。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FeeModel {
    /// 佣金率（%，0.025 = 万2.5）。
    pub commission_rate_pct: f64,
    /// 单笔最低佣金（元）。
    pub min_commission: f64,
    /// 卖方印花税率（%，0.05 = 0.05%）。
    pub stamp_duty_pct: f64,
    /// 滑点（bp，2.0 = 0.02%）。
    pub slippage_bp: f64,
}

impl Default for FeeModel {
    /// ADR bt-1 推荐默认值：0.025 / 5.0 / 0.05 / 2.0。
    fn default() -> Self {
        Self {
            commission_rate_pct: 0.025,
            min_commission: 5.0,
            stamp_duty_pct: 0.05,
            slippage_bp: 2.0,
        }
    }
}

impl FeeModel {
    pub fn commission_fraction(&self) -> f64 {
        self.commission_rate_pct / 100.0
    }

    pub fn stamp_fraction(&self) -> f64 {
        self.stamp_duty_pct / 100.0
    }

    pub fn slippage_fraction(&self) -> f64 {
        self.slippage_bp / 10_000.0
    }

    /// 买入成交价（含滑点）。
    pub fn buy_price(&self, price: f64) -> f64 {
        price * (1.0 + self.slippage_fraction())
    }

    /// 卖出成交价（含滑点）。
    pub fn sell_price(&self, price: f64) -> f64 {
        price * (1.0 - self.slippage_fraction())
    }

    /// 单笔佣金（含最低）。
    pub fn commission(&self, trade_value: f64) -> f64 {
        (trade_value * self.commission_fraction()).max(self.min_commission)
    }

    /// 卖方印花税（仅卖出收）。
    pub fn stamp_duty(&self, trade_value: f64) -> f64 {
        trade_value * self.stamp_fraction()
    }

    /// 建仓：给定预算与原始价，返回成交结果。总成本=预算（佣金未触发最低时）。
    pub fn buy(&self, budget: f64, raw_price: f64) -> BuyExecution {
        let eff_price = self.buy_price(raw_price);
        let prop_shares = budget / (eff_price * (1.0 + self.commission_fraction()));
        let prop_value = prop_shares * eff_price;
        let prop_comm = self.commission(prop_value);
        if prop_comm > self.min_commission {
            BuyExecution {
                shares: prop_shares,
                trade_value: prop_value,
                commission: prop_comm,
                effective_price: eff_price,
                total_cost: prop_value + prop_comm,
            }
        } else {
            // 最低佣金主导：折入最低佣金，退算出成交额（预算不足以覆盖最低佣金时记为 0 股）。
            let value = (budget - self.min_commission).max(0.0);
            let shares = if eff_price > 0.0 { value / eff_price } else { 0.0 };
            BuyExecution {
                shares,
                trade_value: value,
                commission: if value > 0.0 { self.min_commission } else { 0.0 },
                effective_price: eff_price,
                total_cost: if value > 0.0 { value + self.min_commission } else { 0.0 },
            }
        }
    }

    /// 平仓：给定持仓与原始价，返回卖出结果（净得）。
    pub fn sell(&self, shares: f64, raw_price: f64) -> SellExecution {
        let eff_price = self.sell_price(raw_price);
        let trade_value = shares * eff_price;
        let commission = self.commission(trade_value);
        let stamp = self.stamp_duty(trade_value);
        SellExecution {
            trade_value,
            commission,
            stamp_duty: stamp,
            proceeds: trade_value - commission - stamp,
            effective_price: eff_price,
        }
    }
}

/// 建仓结果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BuyExecution {
    pub shares: f64,
    pub trade_value: f64,
    pub commission: f64,
    pub effective_price: f64,
    pub total_cost: f64,
}

/// 平仓结果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SellExecution {
    pub trade_value: f64,
    pub commission: f64,
    pub stamp_duty: f64,
    pub proceeds: f64,
    pub effective_price: f64,
}

#[cfg(test)]
// 黄金样本字面量为锁定的精确参考值（用 close() 以 1e-6 容差断言），保留全精度有利于文档溯源。
#[allow(clippy::excessive_precision)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    #[test]
    fn default_matches_adr_bt1() {
        let f = FeeModel::default();
        close(f.commission_rate_pct, 0.025);
        close(f.min_commission, 5.0);
        close(f.stamp_duty_pct, 0.05);
        close(f.slippage_bp, 2.0);
    }

    #[test]
    fn commission_proportional_and_min() {
        let f = FeeModel::default();
        // 100000 × 0.025% = 25 元（超过最低 5 元）
        close(f.commission(100_000.0), 25.0);
        // 10000 × 0.025% = 2.5 元 → 取最低 5 元
        close(f.commission(10_000.0), 5.0);
    }

    #[test]
    fn stamp_only_sell_side() {
        let f = FeeModel::default();
        close(f.stamp_duty(100_000.0), 50.0);
    }

    #[test]
    fn slippage_prices() {
        let f = FeeModel::default();
        close(f.buy_price(10.0), 10.002);
        close(f.sell_price(10.0), 9.998);
    }

    #[test]
    fn buy_uses_proportional_commission_and_total_equals_budget() {
        let f = FeeModel::default();
        let b = f.buy(100_000.0, 12.0);
        close(b.effective_price, 12.0024);
        close(b.shares, 8329.584603782399);
        close(b.trade_value, 99975.006248437872);
        close(b.commission, 24.993751562109);
        close(b.total_cost, 100_000.0); // 佣金折入，总成本=预算
    }

    #[test]
    fn buy_respects_min_commission_branch() {
        let f = FeeModel::default();
        // 极小预算触发最低佣金：value = budget - min
        let b = f.buy(10.0, 12.0);
        close(b.trade_value, 5.0);
        close(b.commission, 5.0);
        close(b.total_cost, 10.0);
    }

    #[test]
    fn sell_charges_commission_and_stamp() {
        let f = FeeModel::default();
        let s = f.sell(8329.58460378, 13.0);
        close(s.effective_price, 12.9974);
        close(s.trade_value, 108262.942929170182);
        close(s.commission, 27.065735732293);
        close(s.stamp_duty, 54.131471464585);
        close(s.proceeds, 108181.745721973304);
    }

    #[test]
    fn sell_roundtrip_golden_pnl() {
        // 第一笔完整交易：买 12.0 → 卖 13.0，与黄金样本一致
        let f = FeeModel::default();
        let b = f.buy(100_000.0, 12.0);
        let s = f.sell(b.shares, 13.0);
        let pnl = s.proceeds - b.total_cost;
        close(pnl, 8181.745722);
        close(b.commission + s.commission, 52.05948729);
    }
}
