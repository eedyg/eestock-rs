//! 事件驱动回测引擎（ADR §4 / §5 / §6）。
//!
//! 事件循环（每 bar）：
//! 1. 在 `open[i]` 执行上一 bar 收盘产生的挂单（bt-2：信号在 bar close 判定 → 下一 bar open 成交）。
//! 2. 用 `bars[0..=i]` 计算指标 → 构造 `Ctx`（bar_index/ts/资金/持仓/净值）。
//! 3. 对当前 bar 调用 `strategy.on_bar` → 产生 `Signal`，作为下一 bar open 的挂单。
//! 4. 记录该 bar 收盘净值（现金 + 持仓 × close）。
//!
//! 期末若仍持仓 → 用最后可用 close 强制平仓（并让净值序列最后一个点反映已实现净值）。
//! 仅支持单标的、单方向多头（ADR §4）；`Signal::Sell` 平掉全部持仓。

use crate::indicators::Indicators;
use crate::metrics::{compute_drawdown, compute_metrics};
use crate::types::{BacktestResult, Bar, Ctx, RunConfig, Signal, Strategy, TradeDetail};

/// 回测引擎：持有运行配置（初始资金 / 费用 / 周期）。
#[derive(Debug, Clone)]
pub struct Engine {
    cfg: RunConfig,
}

/// 挂单（来自上一 bar 的信号，于本 bar 开盘执行）。
#[derive(Debug, Clone, Copy)]
enum Pending {
    Buy { budget: f64 },
    Sell { shares: f64 },
}

/// 开仓状态（用于平仓明细）。
#[derive(Debug, Clone, Copy)]
struct OpenTrade {
    ts: i64,
    bar_index: usize,
    effective_price: f64,
    cost: f64,
    buy_commission: f64,
}

impl Engine {
    pub fn new(cfg: RunConfig) -> Self {
        Self { cfg }
    }

    /// 运行一次回测。`strategy` 已按目标参数配置。
    pub fn run(&self, bars: &[Bar], strategy: &mut dyn Strategy) -> BacktestResult {
        let fee = &self.cfg.fee;
        let initial = self.cfg.initial_capital;
        let period = self.cfg.period;
        let n = bars.len();

        let mut cash = initial;
        let mut position = 0.0_f64;
        let mut open_trade: Option<OpenTrade> = None;
        let mut pending: Option<Pending> = None;

        let mut nav: Vec<(i64, f64)> = Vec::with_capacity(n);
        let mut trades: Vec<TradeDetail> = Vec::new();

        for i in 0..n {
            let bar = &bars[i];

            // 1) 执行上一 bar 信号产生的挂单（本 bar 开盘价成交）
            if let Some(order) = pending.take() {
                match order {
                    Pending::Buy { budget } => {
                        if position == 0.0 && budget > 0.0 {
                            let b = fee.buy(budget, bar.open);
                            cash -= b.total_cost;
                            position += b.shares;
                            open_trade = Some(OpenTrade {
                                ts: bar.ts,
                                bar_index: i,
                                effective_price: b.effective_price,
                                cost: b.total_cost,
                                buy_commission: b.commission,
                            });
                        }
                    }
                    Pending::Sell { shares } => {
                        if position > 0.0 {
                            let s = fee.sell(shares, bar.open);
                            let open = open_trade.expect("open trade must exist while holding");
                            let pnl = s.proceeds - open.cost;
                            trades.push(TradeDetail {
                                open_ts: open.ts,
                                close_ts: bar.ts,
                                open_bar: open.bar_index,
                                close_bar: i,
                                open_price: open.effective_price,
                                close_price: s.effective_price,
                                shares,
                                gross_value: s.trade_value,
                                commission: open.buy_commission + s.commission,
                                stamp_duty: s.stamp_duty,
                                pnl,
                                hold_bars: i - open.bar_index,
                            });
                            cash += s.proceeds;
                            position = 0.0;
                            open_trade = None;
                        }
                    }
                }
            }

            // 2) 指标 + 上下文
            let ind = Indicators::new(bars, i);
            let equity = cash + position * bar.close;
            let mut ctx = Ctx {
                bar_index: i,
                ts: bar.ts,
                cash,
                position,
                equity,
            };

            // 3) 策略决策 → 挂单（下一 bar 开盘执行）
            let signal = strategy.on_bar(&mut ctx, bar, &ind);
            match signal {
                Signal::Hold => {}
                Signal::Buy(fraction) => {
                    if position == 0.0 {
                        let budget = fraction * (cash + position * bar.close);
                        if budget > 0.0 {
                            pending = Some(Pending::Buy { budget });
                        }
                    }
                }
                Signal::Sell => {
                    if position > 0.0 {
                        pending = Some(Pending::Sell { shares: position });
                    }
                }
            }

            // 4) 记录收盘净值
            nav.push((bar.ts, cash + position * bar.close));
        }

        // 期末强制平仓（用最后 close）
        if position > 0.0 {
            let bar = &bars[n - 1];
            let s = fee.sell(position, bar.close);
            let open = open_trade.expect("open trade must exist while holding");
            let pnl = s.proceeds - open.cost;
            trades.push(TradeDetail {
                open_ts: open.ts,
                close_ts: bar.ts,
                open_bar: open.bar_index,
                close_bar: n - 1,
                open_price: open.effective_price,
                close_price: s.effective_price,
                shares: position,
                gross_value: s.trade_value,
                commission: open.buy_commission + s.commission,
                stamp_duty: s.stamp_duty,
                pnl,
                hold_bars: n - 1 - open.bar_index,
            });
            cash += s.proceeds;
            // 净值最后一点修正为已实现净值
            if let Some(last) = nav.last_mut() {
                last.1 = cash;
            }
        }

        let drawdown_series = compute_drawdown(&nav);
        let metrics = compute_metrics(&nav, &trades, initial, period);

        BacktestResult {
            net_value_series: nav,
            drawdown_series,
            trades,
            metrics,
        }
    }
}

/// 直接运行一次回测（便捷函数，等价于 `Engine::new(cfg).run(...)`）。
pub fn run(bars: &[Bar], strategy: &mut dyn Strategy, cfg: &RunConfig) -> BacktestResult {
    Engine::new(cfg.clone()).run(bars, strategy)
}
