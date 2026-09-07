//! 模拟账户（ADR 11-sim-live §5）：现金 + 持仓{数量/成本/最新/市值/未实现} + 已实现盈亏 + 费用(FeeModel)。
//!
//! 纯逻辑、无 IO/无随机：`apply_fill` 更新现金/持仓/已实现盈亏/费用；`mark_to_market` 按最新价打市值，
//! 返回净值（现金 + 持仓市值）。成交价已由 FillEngine 含滑点/费用折算。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::fill::{Fill, Side};

/// 单标的持仓。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub code: String,
    /// 股数。
    pub qty: f64,
    /// 加权平均成本（买入有效价，未摊费用）。
    pub avg_cost: f64,
    /// 最新价（`mark_to_market` 刷新）。
    pub latest: f64,
    /// 市值 = qty × latest。
    pub market_value: f64,
    /// 未实现盈亏 = qty × (latest − avg_cost)。
    pub unrealized_pnl: f64,
}

/// 方向独立仓位（盘后/会话重建用；`SimPositionsRead` 读模型）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimPosition {
    pub code: String,
    pub qty: f64,
    pub avg_cost: f64,
}

/// 模拟账户。
#[derive(Debug, Clone)]
pub struct SimAccount {
    /// 现金（初始 cash_init，默认 1_000_000 可配）。
    pub cash: f64,
    /// 持仓（code → Position）。
    pub positions: BTreeMap<String, Position>,
    /// 已实现盈亏（平仓累计，正=盈）。
    pub realized_pnl: f64,
    /// 累计费用（佣金 + 印花税）。
    pub total_fee: f64,
}

impl SimAccount {
    pub fn new(cash_init: f64) -> Self {
        Self {
            cash: cash_init,
            positions: BTreeMap::new(),
            realized_pnl: 0.0,
            total_fee: 0.0,
        }
    }

    /// 应用一笔成交。买：现金 −(qty×price + fee)、加权成本；卖：现金 +(qty×price − fee)、
    /// 已实现盈亏 +qty×(price − avg_cost) − fee、减仓。`fee` 计入 `total_fee`。
    /// 卖超持仓 → Err（长仓模型，禁止卖空）。
    pub fn apply_fill(&mut self, fill: &Fill) -> anyhow::Result<()> {
        if fill.qty <= 0.0 {
            anyhow::bail!("成交数量须为正，got {}", fill.qty);
        }
        self.total_fee += fill.fee;
        match fill.side {
            Side::Buy => {
                let spend = fill.qty * fill.price + fill.fee;
                self.cash -= spend;
                let pos = self.positions.entry(fill.code.clone()).or_insert(Position {
                    code: fill.code.clone(),
                    qty: 0.0,
                    avg_cost: 0.0,
                    latest: 0.0,
                    market_value: 0.0,
                    unrealized_pnl: 0.0,
                });
                let new_qty = pos.qty + fill.qty;
                pos.avg_cost = weighted_avg(pos.qty, pos.avg_cost, fill.qty, fill.price);
                pos.qty = new_qty;
            }
            Side::Sell => {
                let pos = self.positions.get_mut(&fill.code).ok_or_else(|| {
                    anyhow::anyhow!("无持仓可卖：{}", fill.code)
                })?;
                if fill.qty > pos.qty {
                    anyhow::bail!(
                        "卖出 {qty} 超持仓 {held}（code={code}）",
                        qty = fill.qty,
                        held = pos.qty,
                        code = fill.code
                    );
                }
                let proceeds = fill.qty * fill.price - fill.fee;
                self.cash += proceeds;
                self.realized_pnl += fill.qty * (fill.price - pos.avg_cost) - fill.fee;
                pos.qty -= fill.qty;
                if pos.qty <= 1e-9 {
                    self.positions.remove(&fill.code);
                }
            }
        }
        Ok(())
    }

    /// 按最新价打市值：刷新每仓 latest/market_value/unrealized_pnl，返回净值（现金 + 市值）。
    pub fn mark_to_market(&mut self, latest: &BTreeMap<String, f64>) -> f64 {
        for (code, pos) in self.positions.iter_mut() {
            let price = latest.get(code).copied().unwrap_or(pos.latest);
            pos.latest = price;
            pos.market_value = pos.qty * price;
            pos.unrealized_pnl = pos.qty * (price - pos.avg_cost);
        }
        self.equity()
    }

    /// 净值 = 现金 + Σ市值。
    pub fn equity(&self) -> f64 {
        self.cash + self.market_value()
    }

    /// 总持仓市值 = Σ(qty × latest)。
    pub fn market_value(&self) -> f64 {
        self.positions.values().map(|p| p.market_value).sum()
    }

    /// 未实现盈亏 = Σ(qty × (latest − avg_cost))。`mark_to_market` 后与 `Position.unrealized_pnl` 之和一致。
    pub fn unrealized_pnl(&self) -> f64 {
        self.positions.values().map(|p| p.unrealized_pnl).sum()
    }

    /// 持仓快照（code 升序）。
    pub fn position_snapshot(&self) -> Vec<SimPosition> {
        self.positions
            .values()
            .map(|p| SimPosition {
                code: p.code.clone(),
                qty: p.qty,
                avg_cost: p.avg_cost,
            })
            .collect()
    }
}

/// 加权平均：(qty_a×cost_a + qty_b×cost_b) / (qty_a + qty_b)。
fn weighted_avg(qty_a: f64, cost_a: f64, qty_b: f64, cost_b: f64) -> f64 {
    let total = qty_a + qty_b;
    if total <= 1e-12 {
        0.0
    } else {
        (qty_a * cost_a + qty_b * cost_b) / total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fill(code: &str, side: Side, qty: f64, price: f64, fee: f64) -> Fill {
        Fill {
            code: code.into(),
            side,
            qty,
            price,
            fee,
        }
    }

    /// 黄金样本断言（1e-6 容差，固定输入可复现）。
    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    /// 初始默认资金 1_000_000（ADR §5）。
    #[test]
    fn default_cash_1m() {
        let a = SimAccount::new(1_000_000.0);
        close(a.cash, 1_000_000.0);
        close(a.equity(), 1_000_000.0);
        assert!(a.positions.is_empty());
        close(a.realized_pnl, 0.0);
        close(a.total_fee, 0.0);
    }

    /// 建仓：现金减（成交额+费）、持仓数量/加权成本、市值=0（未打市值）。
    #[test]
    fn buy_updates_cash_position_cost_fee() {
        let mut a = SimAccount::new(1_000_000.0);
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 4.0, 5.0)).unwrap();
        close(a.cash, 996_000.0 - 5.0); // 1_000_000 - 1000*4 - 5
        let p = &a.positions["510300"];
        close(p.qty, 1000.0);
        close(p.avg_cost, 4.0);
        close(a.total_fee, 5.0);
        close(a.realized_pnl, 0.0);
        close(a.market_value(), 0.0);
    }

    /// 加仓：加权平均成本。
    #[test]
    fn add_to_position_weighted_avg_cost() {
        let mut a = SimAccount::new(1_000_000.0);
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 4.0, 5.0)).unwrap();
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 3.0, 5.0)).unwrap();
        let p = &a.positions["510300"];
        close(p.qty, 2000.0);
        close(p.avg_cost, 3.5); // 加权平均 (1000*4 + 1000*3)/2000
    }

    /// 平仓：现金加（成交额−费）、已实现盈亏、减仓/移除。
    #[test]
    fn sell_updates_cash_realized_and_removes_position() {
        let mut a = SimAccount::new(1_000_000.0);
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 4.0, 5.0)).unwrap();
        let cash_before = a.cash;
        a.apply_fill(&fill("510300", Side::Sell, 1000.0, 4.5, 20.0)).unwrap();
        // 净得 = 1000*4.5 - 20 = 4480
        close(a.cash, cash_before + 4480.0);
        // 已实现 = qty*(sell - avg_cost) - fee = 1000*(4.5-4.0) - 20 = 480
        close(a.realized_pnl, 480.0);
        assert!(a.positions.is_empty(), "清仓后移除持仓");
        close(a.total_fee, 25.0); // 买 5 + 卖 20
    }

    /// 部分平仓：保留剩余持仓，avg_cost 不变。
    #[test]
    fn partial_sell_keeps_remaining_at_avg_cost() {
        let mut a = SimAccount::new(1_000_000.0);
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 4.0, 5.0)).unwrap();
        a.apply_fill(&fill("510300", Side::Sell, 400.0, 4.5, 20.0)).unwrap();
        let p = &a.positions["510300"];
        close(p.qty, 600.0);
        close(p.avg_cost, 4.0); // 部分平仓不改成本
        close(a.realized_pnl, 400.0 * 0.5 - 20.0); // 400*(4.5-4)-20 = 180
    }

    /// 卖空禁止：卖超持仓 → Err。
    #[test]
    fn sell_more_than_held_is_err() {
        let mut a = SimAccount::new(1_000_000.0);
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 4.0, 5.0)).unwrap();
        let r = a.apply_fill(&fill("510300", Side::Sell, 1001.0, 4.5, 20.0));
        assert!(r.is_err(), "卖空应拒绝");
        let r = a.apply_fill(&fill("999999", Side::Sell, 1.0, 4.5, 20.0));
        assert!(r.is_err(), "无持仓应拒绝");
    }

    /// 打市值：刷新 latest/market_value/unrealized_pnl，净值 = 现金 + 市值。
    #[test]
    fn mark_to_market_refreshes_values_and_equity() {
        let mut a = SimAccount::new(1_000_000.0);
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 4.0, 5.0)).unwrap();
        a.apply_fill(&fill("510880", Side::Buy, 2000.0, 3.0, 5.0)).unwrap();
        let mut latest = BTreeMap::new();
        latest.insert("510300".into(), 5.0);
        latest.insert("510880".into(), 2.5);
        let equity = a.mark_to_market(&latest);
        // cash = 1_000_000 - 1000*4 - 5 - 2000*3 - 5 = 1_000_000 - 4005 - 6005 = 989990
        // market = 1000*5 + 2000*2.5 = 5000 + 5000 = 10000
        close(a.cash, 989_990.0);
        close(a.market_value(), 10_000.0);
        close(a.unrealized_pnl(), 1000.0 * (5.0 - 4.0) + 2000.0 * (2.5 - 3.0));
        close(equity, 999_990.0);
        close(a.positions["510300"].unrealized_pnl, 1000.0);
        close(a.positions["510880"].unrealized_pnl, -1000.0);
    }

    /// 未打市值的标的：latest 保持上次值（首次 0）。
    #[test]
    fn mark_to_market_keeps_unknown_code_at_last() {
        let mut a = SimAccount::new(1_000_000.0);
        a.apply_fill(&fill("510300", Side::Buy, 1000.0, 4.0, 5.0)).unwrap();
        a.mark_to_market(&BTreeMap::new());
        close(a.positions["510300"].latest, 0.0); // 无新价时保持 0
        close(a.market_value(), 0.0);
    }
}
