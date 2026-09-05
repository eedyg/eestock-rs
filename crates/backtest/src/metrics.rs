//! 绩效指标计算（ADR §6，单测锁定）。
//!
//! 口径（含 ADR bt-3 落地）：
//! - NetProfit = 期末净值 − 初始资金（元）。
//! - MaxDrawdown = 净值序列峰谷最大回撤（`(peak−trough)/peak`，含未实现）。
//! - Sharpe = `(period_returns均值 − rf) / period_returns样本标准差 × sqrt(bars_per_year)`，rf=0
//!   （bt-3：年化因子按周期，日线 √252、1m √(252×240) 等；period_returns 取净值逐 bar 回报）。
//! - WinRate = 盈利平仓笔数 / 总平仓笔数。
//! - ProfitFactor = 平均盈利 / 平均亏损（绝对额）。
//! - AnnualizedReturn = `(期末/初始)^(bars_per_year / bar_count) − 1`（bt-3：按 bar 数换算）。
//! - TradeCount = 平仓次数。
//! - AvgHoldPeriod = 平均开→平仓 bar 数（×周期换算为天/时由展示层并发处理）。
//!
//! 约定：
//! - 周期回报标准差使用**样本标准差**（ddof=1，金融 Sharpe 惯例；ADR 未指明，按推荐实现并注明）。
//! - 无平仓时 WinRate=0、AvgHold=0、ProfitFactor=0；仅盈无亏 → 盈亏比 = +∞；仅亏无盈 → 0。

use serde::{Deserialize, Serialize};

use crate::types::{Period, TradeDetail};

/// 8 项绩效指标。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BacktestMetrics {
    pub net_profit: f64,
    pub max_drawdown: f64,
    pub sharpe: f64,
    pub win_rate: f64,
    pub profit_factor: f64,
    pub annualized_return: f64,
    pub trade_count: usize,
    pub avg_hold_bars: f64,
}

/// 由净值序列与已平仓交易计算 8 项指标。`nav` 最后一个值为期末净值。
pub fn compute_metrics(
    nav: &[(i64, f64)],
    trades: &[TradeDetail],
    initial_capital: f64,
    period: Period,
) -> BacktestMetrics {
    let equity: Vec<f64> = nav.iter().map(|(_, e)| *e).collect();
    let final_equity = equity.last().copied().unwrap_or(initial_capital);
    let net_profit = final_equity - initial_capital;

    let max_drawdown = compute_max_drawdown(&equity);

    let bars_per_year = period.bars_per_year();
    let n = equity.len();

    // 周期回报（逐 bar）
    let returns: Vec<f64> = equity
        .windows(2)
        .map(|w| (w[1] - w[0]) / w[0])
        .collect();
    let mean_r = if returns.is_empty() {
        0.0
    } else {
        returns.iter().sum::<f64>() / returns.len() as f64
    };
    let std_r = if returns.len() > 1 {
        let var = returns.iter().map(|r| (r - mean_r) * (r - mean_r)).sum::<f64>()
            / (returns.len() as f64 - 1.0);
        var.sqrt()
    } else {
        0.0
    };
    let sharpe = if std_r > 0.0 {
        (mean_r - 0.0) / std_r * bars_per_year.sqrt()
    } else {
        0.0
    };

    let closed = trades;
    let wins: Vec<f64> = closed.iter().filter(|t| t.pnl > 0.0).map(|t| t.pnl).collect();
    let losses: Vec<f64> = closed
        .iter()
        .filter(|t| t.pnl < 0.0)
        .map(|t| t.pnl.abs())
        .collect();
    let win_rate = if closed.is_empty() {
        0.0
    } else {
        wins.len() as f64 / closed.len() as f64
    };
    let avg_profit = if wins.is_empty() {
        0.0
    } else {
        wins.iter().sum::<f64>() / wins.len() as f64
    };
    let avg_loss = if losses.is_empty() {
        0.0
    } else {
        losses.iter().sum::<f64>() / losses.len() as f64
    };
    let profit_factor = if avg_loss > 0.0 {
        avg_profit / avg_loss
    } else if avg_profit > 0.0 {
        f64::INFINITY
    } else {
        0.0
    };

    let annualized_return = if n > 0 && initial_capital > 0.0 {
        (final_equity / initial_capital).powf(bars_per_year / n as f64) - 1.0
    } else {
        0.0
    };

    let trade_count = closed.len();
    let avg_hold_bars = if closed.is_empty() {
        0.0
    } else {
        closed.iter().map(|t| t.hold_bars as f64).sum::<f64>() / closed.len() as f64
    };

    BacktestMetrics {
        net_profit,
        max_drawdown,
        sharpe,
        win_rate,
        profit_factor,
        annualized_return,
        trade_count,
        avg_hold_bars,
    }
}

/// 由净值序列计算逐点回撤 `(ts, drawdown)`。
pub fn compute_drawdown(nav: &[(i64, f64)]) -> Vec<(i64, f64)> {
    let mut peak = f64::NEG_INFINITY;
    nav.iter()
        .map(|(ts, e)| {
            peak = peak.max(*e);
            let dd = if *e > 0.0 { (peak - *e) / peak } else { 0.0 };
            (*ts, dd)
        })
        .collect()
}

/// 由净值序列计算最大回撤（峰值 `(peak-trough)/peak`）。
pub fn compute_max_drawdown(equity: &[f64]) -> f64 {
    let mut peak = f64::NEG_INFINITY;
    let mut maxdd: f64 = 0.0;
    for &e in equity {
        peak = peak.max(e);
        if peak > 0.0 {
            maxdd = maxdd.max((peak - e) / peak);
        }
    }
    maxdd
}

#[cfg(test)]
// 黄金样本字面量为锁定的精确参考值（用 close() 以 1e-6 容差断言）。
#[allow(clippy::excessive_precision)]
mod tests {
    use super::*;
    use crate::types::{Period, TradeDetail};

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    fn trade(pnl: f64, hold: usize) -> TradeDetail {
        TradeDetail {
            open_ts: 0,
            close_ts: 0,
            open_bar: 0,
            close_bar: hold,
            open_price: 0.0,
            close_price: 0.0,
            shares: 0.0,
            gross_value: 0.0,
            commission: 0.0,
            stamp_duty: 0.0,
            pnl,
            hold_bars: hold,
        }
    }

    #[test]
    fn metrics_known_sequence() {
        let nav = vec![(0_i64, 100.0), (1, 110.0), (2, 99.0), (3, 108.9)];
        let trades = vec![trade(100.0, 3), trade(-50.0, 2)];
        let m = compute_metrics(&nav, &trades, 100.0, Period::D1);
        close(m.net_profit, 8.9);
        close(m.max_drawdown, 0.1);
        close(m.sharpe, 4.582575694956);
        close(m.annualized_return, 214.157467903758);
        close(m.win_rate, 0.5);
        close(m.profit_factor, 2.0);
        assert_eq!(m.trade_count, 2);
        close(m.avg_hold_bars, 2.5);
    }

    #[test]
    fn drawdown_series_known() {
        let nav = vec![(0_i64, 100.0), (1, 110.0), (2, 99.0), (3, 108.9)];
        let dd = compute_drawdown(&nav);
        assert_eq!(dd.len(), 4);
        close(dd[0].1, 0.0);
        close(dd[1].1, 0.0);
        close(dd[2].1, (110.0 - 99.0) / 110.0);
        close(dd[3].1, (110.0 - 108.9) / 110.0);
    }

    #[test]
    fn max_drawdown_only_wins_no_loss_gives_infinity_profit_factor() {
        let nav = vec![(0_i64, 100.0), (1, 120.0)];
        let trades = vec![trade(10.0, 1)]; // 仅盈无亏
        let m = compute_metrics(&nav, &trades, 100.0, Period::D1);
        assert!(m.profit_factor.is_infinite());
        assert_eq!(m.trade_count, 1);
    }

    #[test]
    fn no_trades_degenerate() {
        let nav = vec![(0_i64, 100.0), (1, 100.0), (2, 100.0)];
        let m = compute_metrics(&nav, &[], 100.0, Period::D1);
        close(m.win_rate, 0.0);
        close(m.profit_factor, 0.0);
        assert_eq!(m.trade_count, 0);
        close(m.avg_hold_bars, 0.0);
        close(m.max_drawdown, 0.0);
    }
}
