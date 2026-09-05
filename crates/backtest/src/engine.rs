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

    /// 运行一次回测。`strategy` 已按目标参数配置。等价于无进度回调的 [`Engine::run_with_progress`]。
    pub fn run(&self, bars: &[Bar], strategy: &mut dyn Strategy) -> BacktestResult {
        self.run_with_progress(bars, strategy, &mut |_, _, _| {})
    }

    /// 运行一次回测并上报进度。[`progress`]`(bar_idx, total, bar_ts)` 每 bar 调用一次，
    /// `total` = 总 bar 数、`bar_ts` = 当前 bar 的 Unix 秒。**纯逻辑、无 IO**——由 application 层
    /// （Phase 3b BacktestService）注入异步进度报告（WS/DB）；本回调本身保持可单测锁定，无随机/无时间依赖。
    /// ADR 08-backtest 增补（父级已批准此小改）。
    pub fn run_with_progress(
        &self,
        bars: &[Bar],
        strategy: &mut dyn Strategy,
        progress: &mut dyn FnMut(usize, usize, i64),
    ) -> BacktestResult {
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

            // 进度上报（纯逻辑；总 bar 数 = n，当前 bar 已处理到 i）
            progress(i, n, bar.ts);
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

/// 直接运行一次回测并上报进度（等价于 `Engine::new(cfg).run_with_progress(...)`）。
pub fn run_with_progress(
    bars: &[Bar],
    strategy: &mut dyn Strategy,
    cfg: &RunConfig,
    progress: &mut dyn FnMut(usize, usize, i64),
) -> BacktestResult {
    Engine::new(cfg.clone()).run_with_progress(bars, strategy, progress)
}

#[cfg(test)]
// 进度回调单测：手工固定 bar 序列 + 显式固定参数 + Hold 策略，无随机/无时间依赖，完全可复现。
// 断言：回调调用次数 = bar 数；每次 total = bar 数；bar_ts 逐点等于对应 bar.ts；最后一回 index = n-1。
mod progress_tests {
    use super::*;
    use crate::fee::FeeModel;
    use crate::types::Period;

    struct HoldStrategy;

    impl Strategy for HoldStrategy {
        fn id(&self) -> &str {
            "test_hold"
        }
        fn params_schema(&self) -> Vec<crate::types::ParamDef> {
            Vec::new()
        }
        fn on_bar(&mut self, _ctx: &mut Ctx, _bar: &Bar, _ind: &Indicators) -> Signal {
            Signal::Hold
        }
    }

    fn fixed_bars(n: usize) -> Vec<Bar> {
        let base = 1_704_067_200_i64;
        (0..n)
            .map(|i| Bar {
                ts: base + i as i64 * 86_400,
                open: 10.0,
                high: 10.0,
                low: 10.0,
                close: 10.0,
                volume: 10_000.0,
            })
            .collect()
    }

    #[test]
    fn progress_callback_called_once_per_bar_with_correct_total_and_ts() {
        let bars = fixed_bars(7);
        let cfg = RunConfig {
            initial_capital: 100_000.0,
            fee: FeeModel::default(),
            period: Period::D1,
        };
        let mut strat = HoldStrategy {};
        let mut calls: Vec<(usize, usize, i64)> = Vec::new();
        let res = Engine::new(cfg).run_with_progress(&bars, &mut strat, &mut |i, total, ts| {
            calls.push((i, total, ts));
        });

        assert_eq!(calls.len(), bars.len(), "回调应每 bar 调用一次");
        for (idx, (i, total, ts)) in calls.iter().enumerate() {
            assert_eq!(*i, idx, "bar 序号应递增");
            assert_eq!(*total, bars.len(), "total 恒等于 bar 数");
            assert_eq!(*ts, bars[idx].ts, "bar_ts 应等于当前 bar 的 Unix 秒");
        }
        assert_eq!(calls.last().unwrap().0, bars.len() - 1, "最后一次回调应为最后一根 bar");
        // 结果仍可正常产出（Hold 无交易）
        assert_eq!(res.net_value_series.len(), bars.len());
        assert!(res.trades.is_empty());
    }

    #[test]
    fn progress_pct_ratio_is_monotonic_non_decreasing() {
        // 用 pct = (i+1)*100/total 的语义各点比对：断言由回调推导的 pct 单调不减、且最后=100。
        let bars = fixed_bars(4);
        let cfg = RunConfig {
            initial_capital: 100_000.0,
            fee: FeeModel::default(),
            period: Period::D1,
        };
        let mut strat = HoldStrategy {};
        let mut pcts: Vec<i32> = Vec::new();
        let _ = Engine::new(cfg).run_with_progress(&bars, &mut strat, &mut |i, total, _| {
            pcts.push(((i + 1) * 100 / total) as i32);
        });
        assert_eq!(pcts, vec![25, 50, 75, 100], "pct 应为 25/50/75/100");
        for w in pcts.windows(2) {
            assert!(w[0] <= w[1], "pct 应单调不减");
        }
    }
}
