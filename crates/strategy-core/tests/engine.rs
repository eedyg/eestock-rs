//! EnsembleEngine 集成测试（ADR 12-strategy-system §6/§9/§13.3，ABI §3 G5 / §5 归属澄清）。
//!
//! 纪律：全部为确定性手工构造数据（固定 bar 序列 + 显式参数），真实 `QuickJsRuntime`
//! 跑仓内 fixture 插件；无 RNG / 无系统时间依赖（超时用例收紧 per_call_timeout 快速触发）。

use std::time::Duration;

use backtest::{Bar, FeeModel, ParamValue, Period, StrategyParams};
use strategy_core::{
    run_ensemble, DcaMode, EngineEvent, EnsembleConfig, ExecutionPolicy, OrderReason, OrderSide,
    SlotScoreOutcome, StopConfig, StopKind, StopTrigger, StrategySlot, TradeSignal,
    CIRCUIT_BREAKER_THRESHOLD,
};
use strategy_runtime::{PluginError, QuickJsRuntime, RuntimeLimits};

const CONSTANT_SCORE: &str = include_str!("fixtures/constant_score.js");
const POSITION_GATE: &str = include_str!("fixtures/position_gate.js");
const SCRIPTED_INDEX: &str = include_str!("fixtures/scripted_index.js");
const FLAKY: &str = include_str!("fixtures/flaky.js");
const INFINITE_LOOP: &str = include_str!("fixtures/infinite_loop.js");

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

fn params(pairs: &[(&str, f64)]) -> StrategyParams {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), ParamValue::Num(*v)))
        .collect()
}

fn slot(code: &str, hash: &str, params: StrategyParams, weight: f64) -> StrategySlot {
    StrategySlot::new(code, hash, params, weight).expect("合法 slot")
}

/// 固定价 bar 序列（open=high=low=close=price）。
fn flat_bars(n: usize, price: f64) -> Vec<Bar> {
    (0..n)
        .map(|i| Bar {
            ts: 1_700_000_000 + i as i64 * 86_400,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: 10_000.0,
        })
        .collect()
}

fn base_cfg(slots: Vec<StrategySlot>, policy: ExecutionPolicy) -> EnsembleConfig {
    EnsembleConfig {
        slots,
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy,
        stop: None,
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::D1,
        runtime_limits: RuntimeLimits::default(),
    }
}

fn run(cfg: &EnsembleConfig, bars: &[Bar]) -> strategy_core::EnsembleResult {
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    run_ensemble(cfg, bars, &mut rt).expect("引擎运行成功")
}

fn fills(res: &strategy_core::EnsembleResult) -> Vec<(usize, OrderSide, f64, f64, OrderReason)> {
    res.per_bar
        .iter()
        .flat_map(|r| r.events.iter())
        .filter_map(|e| match e {
            EngineEvent::Fill {
                bar_index,
                side,
                qty,
                price,
                reason,
            } => Some((*bar_index, *side, *qty, *price, *reason)),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 端到端：Buy → 持仓 → 期末强平；费用口径与 backtest 引擎逐点一致
// ---------------------------------------------------------------------------

/// 对照组：等价的 backtest 内建引擎脚本策略（bar0 Buy(1.0)，其余 Hold）。
struct ScriptedStrategy;
impl backtest::Strategy for ScriptedStrategy {
    fn id(&self) -> &str {
        "test_scripted"
    }
    fn params_schema(&self) -> Vec<backtest::ParamDef> {
        Vec::new()
    }
    fn on_bar(
        &mut self,
        ctx: &mut backtest::Ctx,
        _bar: &Bar,
        _ind: &backtest::Indicators,
    ) -> backtest::Signal {
        if ctx.bar_index == 0 {
            backtest::Signal::Buy(1.0)
        } else {
            backtest::Signal::Hold
        }
    }
}

#[test]
fn e2e_buy_hold_force_close_fee_parity_with_backtest() {
    let bars = flat_bars(10, 10.0);
    let cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    let res = run(&cfg, &bars);

    // bar0: score 80 → aggregate 80 → Buy；挂单在 bar1 open 成交。
    assert_eq!(res.per_bar[0].signal, TradeSignal::Buy);
    assert_eq!(res.per_bar[0].orders.len(), 1);
    assert_eq!(res.per_bar[0].orders[0].side, OrderSide::Buy);
    assert_eq!(res.per_bar[0].orders[0].reason, OrderReason::Policy);
    // bar1-8 重复 Buy 信号但目标仓位已到 → 无新订单（幂等）。
    for r in &res.per_bar[1..] {
        assert!(r.orders.is_empty(), "重复信号不得产生额外订单（ADR §13.1）");
    }

    // 成交：bar1 open 买入 1 笔；期末强制平仓 1 笔（最后 close）。
    let f = fills(&res);
    assert_eq!(f.len(), 2, "买入 + 期末强平各一笔");
    assert_eq!(
        (f[0].0, f[0].1, f[0].4),
        (1, OrderSide::Buy, OrderReason::Policy)
    );
    assert_eq!(
        (f[1].0, f[1].1, f[1].4),
        (9, OrderSide::Sell, OrderReason::ForceClose)
    );
    assert_eq!(res.trades.len(), 1);

    // 费用口径与 backtest 引擎一致（同一 FeeModel、同一成交假设）。
    let bt = backtest::run(
        &bars,
        &mut ScriptedStrategy,
        &backtest::RunConfig {
            initial_capital: 100_000.0,
            fee: FeeModel::default(),
            period: Period::D1,
        },
    );
    assert_eq!(res.net_value.len(), bt.net_value_series.len());
    for ((ts_a, v_a), (ts_b, v_b)) in res.net_value.iter().zip(bt.net_value_series.iter()) {
        assert_eq!(ts_a, ts_b);
        close(*v_a, *v_b);
    }
    close(res.trades[0].open_price, bt.trades[0].open_price);
    close(res.trades[0].close_price, bt.trades[0].close_price);
    close(res.trades[0].pnl, bt.trades[0].pnl);
    // MINOR-3：TradeDetail 全字段对照相等。
    assert_eq!(res.trades.len(), bt.trades.len());
    for (ta, tb) in res.trades.iter().zip(bt.trades.iter()) {
        assert_eq!(ta.open_ts, tb.open_ts);
        assert_eq!(ta.close_ts, tb.close_ts);
        assert_eq!(ta.open_bar, tb.open_bar);
        assert_eq!(ta.close_bar, tb.close_bar);
        close(ta.open_price, tb.open_price);
        close(ta.close_price, tb.close_price);
        close(ta.shares, tb.shares);
        close(ta.gross_value, tb.gross_value);
        close(ta.commission, tb.commission);
        close(ta.stamp_duty, tb.stamp_duty);
        close(ta.pnl, tb.pnl);
        assert_eq!(ta.hold_bars, tb.hold_bars);
    }
    // MINOR-3：drawdown 逐点对照相等。
    assert_eq!(res.drawdown.len(), bt.drawdown_series.len());
    for ((ts_a, d_a), (ts_b, d_b)) in res.drawdown.iter().zip(bt.drawdown_series.iter()) {
        assert_eq!(ts_a, ts_b);
        close(*d_a, *d_b);
    }
    // MINOR-3：8 项绩效全字段对照相等。
    close(res.metrics.net_profit, bt.metrics.net_profit);
    close(res.metrics.max_drawdown, bt.metrics.max_drawdown);
    close(res.metrics.sharpe, bt.metrics.sharpe);
    close(res.metrics.win_rate, bt.metrics.win_rate);
    close(res.metrics.profit_factor, bt.metrics.profit_factor);
    close(res.metrics.annualized_return, bt.metrics.annualized_return);
    assert_eq!(res.metrics.trade_count, bt.metrics.trade_count);
    close(res.metrics.avg_hold_bars, bt.metrics.avg_hold_bars);
}

// ---------------------------------------------------------------------------
// 确定性双跑（ADR §9）：同 fixture 两次运行逐点相等
// ---------------------------------------------------------------------------

#[test]
fn e2e_deterministic_double_run_pointwise_equal() {
    let bars = flat_bars(30, 10.0);
    let cfg = base_cfg(
        vec![
            slot(
                CONSTANT_SCORE,
                "sha256:constant_score",
                params(&[("score", 80.0)]),
                2.0,
            ),
            slot(
                POSITION_GATE,
                "sha256:position_gate",
                StrategyParams::new(),
                1.0,
            ),
        ],
        ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        },
    );
    let a = run(&cfg, &bars);
    let b = run(&cfg, &bars);

    assert_eq!(a.per_bar.len(), b.per_bar.len());
    for (ra, rb) in a.per_bar.iter().zip(b.per_bar.iter()) {
        assert_eq!(ra.scores, rb.scores, "逐 bar 各策略分逐点相等");
        assert_eq!(ra.aggregate, rb.aggregate);
        assert_eq!(ra.signal, rb.signal);
        assert_eq!(ra.orders, rb.orders);
    }
    assert_eq!(a.net_value, b.net_value, "净值序列逐点相等");
    assert_eq!(a.drawdown, b.drawdown, "drawdown 序列逐点相等（NIT-2）");
    assert_eq!(a.trades, b.trades);
    assert_eq!(a.metrics, b.metrics);
    // NIT-2：events 序列逐点相等。
    for (ra, rb) in a.per_bar.iter().zip(b.per_bar.iter()) {
        assert_eq!(ra.events, rb.events, "逐 bar events 逐点相等");
    }
}

// ---------------------------------------------------------------------------
// position 门控（ABI §2.5）：真实持仓快照注入驱动买→卖闭环
// ---------------------------------------------------------------------------

#[test]
fn e2e_position_gate_buy_then_sell() {
    let bars = flat_bars(6, 10.0);
    let cfg = base_cfg(
        vec![slot(
            POSITION_GATE,
            "sha256:position_gate",
            StrategyParams::new(),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    let res = run(&cfg, &bars);

    // bar0 空仓 → 80 → Buy；bar1 open 成交后持仓 → bar1 起 20 → Sell；bar2 open 清仓。
    close(res.per_bar[0].scores[0].score, 80.0);
    close(res.per_bar[1].scores[0].score, 20.0);
    assert_eq!(res.per_bar[0].signal, TradeSignal::Buy);
    assert_eq!(res.per_bar[1].signal, TradeSignal::Sell);
    let f = fills(&res);
    assert_eq!((f[0].0, f[0].1), (1, OrderSide::Buy));
    assert_eq!((f[1].0, f[1].1), (2, OrderSide::Sell));
    // 门控随持仓状态振荡：清仓后 position 恢复 null → bar2 起重回 80 分再次买入，
    // 6 bar 内共 3 笔完整交易（1→2, 3→4, 5→期末强平）。首笔验证开平仓 bar 序号。
    assert_eq!(res.trades.len(), 3);
    assert_eq!((res.trades[0].open_bar, res.trades[0].close_bar), (1, 2));
    close(res.per_bar[2].scores[0].score, 80.0);
}

// ---------------------------------------------------------------------------
// DCA 端到端：interval=2 分批（bar0/bar2 决策 → bar1/bar3 open 成交）
// ---------------------------------------------------------------------------

#[test]
fn e2e_dca_batches_with_interval() {
    let bars = flat_bars(8, 10.0);
    let cfg = base_cfg(
        vec![slot(
            SCRIPTED_INDEX,
            "sha256:scripted_index",
            params(&[("buy_below", 4.0)]),
            1.0,
        )],
        ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::Equal,
            amount: None,
            interval: 2,
        },
    );
    let res = run(&cfg, &bars);

    // Buy 信号持续 bar0..=3；批次在 bar0/bar2 决策（interval=2），bar1/bar3 open 成交。
    let policy_buys: Vec<_> = fills(&res)
        .into_iter()
        .filter(|f| f.1 == OrderSide::Buy && f.4 == OrderReason::Policy)
        .collect();
    assert_eq!(policy_buys.len(), 2, "恰好两批买入");
    assert_eq!(policy_buys[0].0, 1);
    assert_eq!(policy_buys[1].0, 3);
    // 计划总额 = bar0 起点净值 100_000，Equal 两批 → 每批 50_000 预算级股数。
    close(res.per_bar[0].orders[0].qty, 5_000.0);
    // bar4 起信号转 Hold（50 分）→ 无新订单；期末强平收尾。
    assert!(res.per_bar[4].orders.is_empty());
    assert_eq!(res.trades.len(), 1, "期末强平合成一笔完整交易");
}

// ---------------------------------------------------------------------------
// 硬止损 × 两种 trigger（ADR §13.3 第二层）
// ---------------------------------------------------------------------------

/// 止损测试 bar 序列：bar0/1 平 10；bar2 插针（low/close 破线）；后续平 9.6。
fn stop_bars() -> Vec<Bar> {
    vec![
        Bar {
            ts: 1_700_000_000,
            open: 10.0,
            high: 10.0,
            low: 10.0,
            close: 10.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_086_400,
            open: 10.0,
            high: 10.0,
            low: 10.0,
            close: 10.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_172_800,
            open: 9.8,
            high: 9.9,
            low: 9.50,
            close: 9.60,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_259_200,
            open: 9.60,
            high: 9.60,
            low: 9.60,
            close: 9.60,
            volume: 1.0,
        },
    ]
}

#[test]
fn stop_fixed_pct_intrabar_fills_same_bar_at_line_minus_slippage() {
    let bars = stop_bars();
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::FixedPct,
        value: 0.05,
        trigger: StopTrigger::Intrabar,
    });
    let res = run(&cfg, &bars);

    // bar1 open 买入：avg_cost（含买入佣金摊薄）= 100000/shares。
    let fee = FeeModel::default();
    let buy = fee.buy(100_000.0, 10.0);
    let avg_cost = 100_000.0 / buy.shares;
    let line = avg_cost * 0.95; // ≈ 9.5119；bar2 low = 9.50 < line → 触发
    assert!(9.50 < line, "前置：bar2 low 必须破止损线");

    let f = fills(&res);
    // 买入 fill + 止损 fill（当 bar、按止损价×(1−slippage)）。
    let stop_fill = f
        .iter()
        .find(|f| f.4 == OrderReason::StopTrigger)
        .expect("应有 stop_trigger 成交事件");
    assert_eq!(stop_fill.0, 2, "Intrabar 当 bar 成交（口径唯一例外）");
    close(stop_fill.3, line * (1.0 - fee.slippage_fraction()));

    // 首笔交易为止损平仓：bar2 当 bar 成交，价 = 止损线 ×(1−slippage)。
    assert_eq!(res.trades[0].close_bar, 2);
    close(
        res.trades[0].close_price,
        line * (1.0 - fee.slippage_fraction()),
    );
    // 语义注明：止损平仓后信号仍为 Buy（80 分）→ Policy 重新建仓，bar3 open 再买入，
    // 期末强平收尾——硬止损只负责「触发即平仓」，不抑制后续信号（ADR §13.3 第二层职责边界）。
    assert_eq!(res.trades.len(), 2);
    assert_eq!(res.trades[1].open_bar, 3);
}

#[test]
fn stop_close_basis_next_open_fill() {
    let mut bars = stop_bars();
    bars[2].close = 9.50; // close 破线（< line≈9.5119）
    bars[2].low = 9.50;
    bars[3].open = 9.55;
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::FixedPct,
        value: 0.05,
        trigger: StopTrigger::CloseBasis,
    });
    let res = run(&cfg, &bars);

    // bar2 收盘判定触发 → 订单标注 stop_trigger，bar3 open 成交。
    assert_eq!(res.per_bar[2].orders.len(), 1);
    assert_eq!(res.per_bar[2].orders[0].reason, OrderReason::StopTrigger);
    assert_eq!(res.per_bar[2].orders[0].side, OrderSide::Sell);
    // 止损绕过 Policy：bar2 信号仍为 Buy（80 分）但订单是止损平仓。
    assert_eq!(res.per_bar[2].signal, TradeSignal::Buy);

    let fee = FeeModel::default();
    let stop_fill = fills(&res)
        .into_iter()
        .find(|f| f.4 == OrderReason::StopTrigger)
        .expect("应有 stop_trigger 成交");
    assert_eq!(stop_fill.0, 3, "次 bar open 成交");
    close(stop_fill.3, 9.55 * (1.0 - fee.slippage_fraction()));
    assert_eq!(res.trades.len(), 1);
    assert_eq!(res.trades[0].close_bar, 3);
}

#[test]
fn stop_trailing_intrabar_uses_peak_close_since_entry() {
    // 建仓后收盘冲高至 12（峰值），bar5 low 10.7 破线 12×0.9=10.8 → 当 bar 成交。
    let bars = vec![
        Bar {
            ts: 1_700_000_000,
            open: 10.0,
            high: 10.0,
            low: 10.0,
            close: 10.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_086_400,
            open: 10.0,
            high: 10.6,
            low: 9.9,
            close: 10.5,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_172_800,
            open: 10.5,
            high: 11.1,
            low: 10.4,
            close: 11.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_259_200,
            open: 11.0,
            high: 11.6,
            low: 10.9,
            close: 11.5,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_345_600,
            open: 11.5,
            high: 12.1,
            low: 11.4,
            close: 12.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_432_000,
            open: 11.8,
            high: 11.9,
            low: 10.7,
            close: 11.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_518_400,
            open: 11.0,
            high: 11.0,
            low: 11.0,
            close: 11.0,
            volume: 1.0,
        },
    ];
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::Trailing,
        value: 0.1,
        trigger: StopTrigger::Intrabar,
    });
    let res = run(&cfg, &bars);

    let fee = FeeModel::default();
    let line = 12.0 * 0.9;
    let stop_fill = fills(&res)
        .into_iter()
        .find(|f| f.4 == OrderReason::StopTrigger)
        .expect("应有 trailing 止损成交");
    assert_eq!(stop_fill.0, 5);
    close(stop_fill.3, line * (1.0 - fee.slippage_fraction()));
    assert_eq!(res.trades[0].close_bar, 5);
    close(
        res.trades[0].close_price,
        line * (1.0 - fee.slippage_fraction()),
    );
}

#[test]
fn stop_atr_close_basis_uses_atr14_line() {
    // 16 根平稳 bar（TR 恒 1.0 → ATR(14)=1.0），bar16 深跌至 close 7.5 破线，bar17 open 成交。
    let mut bars: Vec<Bar> = (0..16)
        .map(|i| Bar {
            ts: 1_700_000_000 + i as i64 * 86_400,
            open: 10.0,
            high: 10.5,
            low: 9.5,
            close: 10.0,
            volume: 1.0,
        })
        .collect();
    bars.push(Bar {
        ts: 1_700_000_000 + 16 * 86_400,
        open: 9.9,
        high: 9.9,
        low: 7.3,
        close: 7.5,
        volume: 1.0,
    });
    bars.push(Bar {
        ts: 1_700_000_000 + 17 * 86_400,
        open: 7.6,
        high: 7.6,
        low: 7.6,
        close: 7.6,
        volume: 1.0,
    });

    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::Atr,
        value: 2.0,
        trigger: StopTrigger::CloseBasis,
    });
    let res = run(&cfg, &bars);

    // 预期止损线：avg_cost − 2 × ATR(14)（用 backtest::Indicators 独立复算）。
    let fee = FeeModel::default();
    let buy = fee.buy(100_000.0, 10.0);
    let avg_cost = 100_000.0 / buy.shares;
    let atr14 = backtest::Indicators::new(&bars, 16)
        .atr(14)
        .expect("ATR 数据充足");
    let line = avg_cost - 2.0 * atr14;
    assert!(bars[16].close < line, "前置：bar16 close 必须破 ATR 线");

    // CloseBasis：bar16 收盘判定 → bar17 open 成交（含滑点）。
    assert_eq!(res.per_bar[16].orders[0].reason, OrderReason::StopTrigger);
    let stop_fill = fills(&res)
        .into_iter()
        .find(|f| f.4 == OrderReason::StopTrigger)
        .expect("应有 ATR 止损成交");
    assert_eq!(stop_fill.0, 17);
    close(stop_fill.3, 7.6 * (1.0 - fee.slippage_fraction()));
    assert_eq!(res.trades[0].close_bar, 17);
}

// ---------------------------------------------------------------------------
// G5 熔断（ABI §5 归属引擎层的断言）
// ---------------------------------------------------------------------------

#[test]
fn g5_circuit_breaker_after_10_consecutive_timeouts() {
    let bars = flat_bars(12, 10.0);
    let mut cfg = base_cfg(
        vec![slot(
            INFINITE_LOOP,
            "sha256:infinite_loop",
            StrategyParams::new(),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.runtime_limits = RuntimeLimits {
        per_call_timeout: Duration::from_millis(20),
        ..RuntimeLimits::default()
    };
    let res = run(&cfg, &bars); // 引擎跑完全程（不得中断）

    assert_eq!(res.per_bar.len(), 12);
    // 前 10 bar：中立分 50 + 错误事件（自含 sha256/bar_index，root_cause 归类 Timeout）。
    for (i, r) in res.per_bar.iter().enumerate().take(10) {
        assert_eq!(r.scores.len(), 1);
        close(r.scores[0].score, 50.0);
        match &r.scores[0].outcome {
            SlotScoreOutcome::Err(e) => {
                assert!(
                    matches!(e.root_cause(), PluginError::Timeout(_)),
                    "root_cause 应为 Timeout"
                );
                match e {
                    PluginError::OnBar {
                        code_hash,
                        bar_index,
                        ..
                    } => {
                        assert_eq!(code_hash, "sha256:infinite_loop");
                        assert_eq!(*bar_index, i);
                    }
                    other => {
                        panic!("on_bar 错误应自含 sha256/bar_index（OnBar 包装），got {other}")
                    }
                }
            }
            other => panic!("应为错误 outcome，got {other:?}"),
        }
        assert!(r
            .events
            .iter()
            .any(|e| matches!(e, EngineEvent::PluginError { .. })));
    }
    // 第 10 次连续错误（bar 9）→ 熔断告警事件。
    assert!(
        res.per_bar[9]
            .events
            .iter()
            .any(|e| matches!(e, EngineEvent::CircuitBreaker { slot_idx: 0, .. })),
        "连续 {} 次错误应触发熔断告警",
        CIRCUIT_BREAKER_THRESHOLD
    );
    // 熔断后（bar 10/11）：按「无覆盖」处理——无评分记录、聚合中立 50、信号 Hold。
    for r in &res.per_bar[10..] {
        assert!(r.scores.is_empty(), "熔断实例不再产生评分");
        close(r.aggregate, 50.0);
        assert_eq!(r.signal, TradeSignal::Hold);
    }
    assert!(res.trades.is_empty());
}

#[test]
fn g5_consecutive_count_resets_on_success() {
    // flaky 每 3 bar 抛一次错（不连续）→ 永不熔断。
    let bars = flat_bars(9, 10.0);
    let cfg = base_cfg(
        vec![slot(FLAKY, "sha256:flaky", StrategyParams::new(), 1.0)],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    let res = run(&cfg, &bars);

    assert!(!res.per_bar.iter().any(|r| r
        .events
        .iter()
        .any(|e| matches!(e, EngineEvent::CircuitBreaker { .. }))));
    // 错误 bar（2/5/8）记中立 50；正常 bar 记 60。
    for (i, r) in res.per_bar.iter().enumerate() {
        if i % 3 == 2 {
            close(r.scores[0].score, 50.0);
            assert!(matches!(r.scores[0].outcome, SlotScoreOutcome::Err(_)));
        } else {
            close(r.scores[0].score, 60.0);
        }
    }
    let err_events = res
        .per_bar
        .iter()
        .flat_map(|r| r.events.iter())
        .filter(|e| matches!(e, EngineEvent::PluginError { .. }))
        .count();
    assert_eq!(
        err_events, 3,
        "3 个错误事件落事件流（禁止静默吞错，ADR §10）"
    );
}

// ---------------------------------------------------------------------------
// 聚合/阈值边界（引擎级）
// ---------------------------------------------------------------------------

#[test]
fn engine_weighted_aggregation_across_slots() {
    let bars = flat_bars(3, 10.0);
    let cfg = base_cfg(
        vec![
            slot(CONSTANT_SCORE, "sha256:a", params(&[("score", 80.0)]), 2.0),
            slot(CONSTANT_SCORE, "sha256:b", params(&[("score", 30.0)]), 1.0),
        ],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    let res = run(&cfg, &bars);
    close(res.per_bar[0].aggregate, 190.0 / 3.0);
    assert_eq!(res.per_bar[0].signal, TradeSignal::Buy);
}

#[test]
fn engine_threshold_exact_boundaries() {
    let bars = flat_bars(3, 10.0);
    // 恰值 60 → Buy。
    let cfg_buy = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:s60",
            params(&[("score", 60.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    assert_eq!(run(&cfg_buy, &bars).per_bar[0].signal, TradeSignal::Buy);
    // 恰值 40 → Sell（无持仓 → 无订单、无交易）。
    let cfg_sell = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:s40",
            params(&[("score", 40.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    let res = run(&cfg_sell, &bars);
    assert_eq!(res.per_bar[0].signal, TradeSignal::Sell);
    assert!(res.trades.is_empty());
    // 50 → Hold。
    let cfg_hold = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:s50",
            params(&[("score", 50.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    assert_eq!(run(&cfg_hold, &bars).per_bar[0].signal, TradeSignal::Hold);
}

#[test]
fn instantiate_failure_is_reported_not_swallowed() {
    let bars = flat_bars(3, 10.0);
    let cfg = base_cfg(
        vec![slot(
            "function on_bar(ctx) {", // 语法错误：eval 阶段即失败
            "sha256:bad",
            StrategyParams::new(),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    assert!(
        run_ensemble(&cfg, &bars, &mut rt).is_err(),
        "实例化失败应直接报错（配置错误，非 per-bar 异常）"
    );
}

// ---------------------------------------------------------------------------
// 性能冒烟（#[ignore]，ADR §14：单标的 5 年日线 × 3 插件 < 2s 目标）
// ---------------------------------------------------------------------------

#[test]
#[ignore = "性能冒烟：手动运行 cargo test -p strategy-core -- --ignored"]
fn perf_smoke_1260_bars_3_plugins() {
    let bars = flat_bars(1260, 10.0); // ≈ 5 年日线
    let cfg = base_cfg(
        vec![
            slot(CONSTANT_SCORE, "sha256:p1", params(&[("score", 55.0)]), 1.0),
            slot(POSITION_GATE, "sha256:p2", StrategyParams::new(), 1.0),
            slot(
                SCRIPTED_INDEX,
                "sha256:p3",
                params(&[("buy_below", 600.0)]),
                1.0,
            ),
        ],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    let start = std::time::Instant::now();
    let res = run(&cfg, &bars);
    let elapsed = start.elapsed();
    assert_eq!(res.per_bar.len(), 1260);
    // NIT-4：保留 #[ignore]，但运行时硬断言达标线（实测约 86ms，留 20x 余量防 flaky）。
    assert!(
        elapsed < Duration::from_secs(2),
        "性能冒烟超标：1260 bars × 3 plugins elapsed = {elapsed:?}（目标 < 2s，ADR §14）"
    );
    println!("PERF_SMOKE: 1260 bars × 3 plugins elapsed = {elapsed:?}（目标 < 2s，ADR §14）");
}

// ---------------------------------------------------------------------------
// MAJOR-1：LumpSum 冻结口径（ADR §13.1 P1a 评审裁决）
// ---------------------------------------------------------------------------

#[test]
fn lump_sum_frozen_target_flat_no_fee_bleed() {
    // 评审反例：flat bars=10.0、initial 100_000、pct=0.8、恒 80 分端到端。
    let bars = flat_bars(10, 10.0);
    let cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 0.8 },
    );
    let res = run(&cfg, &bars);

    // bar0 决策冻结目标 100_000×0.8/10 = 8000 股 → bar1 open 成交。
    assert_eq!(res.per_bar[0].orders.len(), 1);
    close(res.per_bar[0].orders[0].qty, 8_000.0);
    // bar1 成交后全程无新订单（冻结目标不随净值/费用漂移重算）。
    for (i, r) in res.per_bar.iter().enumerate().skip(1) {
        assert!(
            r.orders.is_empty(),
            "bar{i} 不得产生新订单（冻结口径，无费用出血）"
        );
    }
    // 成交仅 2 笔：bar1 买入 + 期末强平；中途无任何微卖出。
    let f = fills(&res);
    assert_eq!(f.len(), 2, "买入 + 期末强平各一笔");
    assert_eq!(
        (f[0].0, f[0].1, f[0].4),
        (1, OrderSide::Buy, OrderReason::Policy)
    );
    close(f[0].2, 8_000.0);
    assert_eq!(
        (f[1].0, f[1].1, f[1].4),
        (9, OrderSide::Sell, OrderReason::ForceClose)
    );
    // 现金单调不降：持仓期内（flat 价格、无交易）净值严格持平。
    for i in 1..8 {
        close(res.net_value[i + 1].1, res.net_value[i].1);
    }
}

#[test]
fn lump_sum_frozen_target_rising_price_no_micro_sell() {
    // 补充反例：价格上行时旧口径按「当前净值×pct/价」重算目标 < 已持仓 → 每 bar 微卖出出血。
    let bars: Vec<Bar> = (0..10)
        .map(|i| {
            let p = 10.0 + 0.1 * i as f64;
            Bar {
                ts: 1_700_000_000 + i as i64 * 86_400,
                open: p,
                high: p,
                low: p,
                close: p,
                volume: 1.0,
            }
        })
        .collect();
    let cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 0.8 },
    );
    let res = run(&cfg, &bars);

    for (i, r) in res.per_bar.iter().enumerate().skip(1) {
        assert!(
            r.orders.is_empty(),
            "bar{i} 不得因价格漂移产生微卖出（冻结口径）"
        );
    }
    assert_eq!(fills(&res).len(), 2, "买入 + 期末强平各一笔");
}

#[test]
fn lump_sum_interrupted_buy_resnapshots_frozen_target() {
    // 中断后首个 Buy 重新快照：position_gate 驱动 Buy→Sell→Buy 振荡，pct=0.8。
    let bars = flat_bars(6, 10.0);
    let cfg = base_cfg(
        vec![slot(
            POSITION_GATE,
            "sha256:position_gate",
            StrategyParams::new(),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 0.8 },
    );
    let res = run(&cfg, &bars);

    // 首轮快照：100_000×0.8/10 = 8000。
    close(res.per_bar[0].orders[0].qty, 8_000.0);
    // bar2 = Sell 清仓后首个 Buy：按新净值重新快照（bar2 决策时持仓为 0 → 净值 = 现金）。
    assert_eq!(res.per_bar[2].signal, TradeSignal::Buy);
    let expected = res.net_value[2].1 * 0.8 / 10.0;
    close(res.per_bar[2].orders[0].qty, expected);
    assert!(
        (res.per_bar[2].orders[0].qty - 8_000.0).abs() > 1.0,
        "必须为新快照（费用折损后净值 < 100_000），而非沿用旧冻结值"
    );
}

// ---------------------------------------------------------------------------
// MAJOR-2：止损强平重置 PolicyState（ADR §13.1 裁决）——兼 DCA+止损组合（MINOR-5）
// ---------------------------------------------------------------------------

/// MAJOR-2 反例 bar 序列（CloseBasis）：bar0..=4 平 10；bar5 低开低走收 9.42 破线；
/// bar6/7 平 9.42。DCA{tranches:4, Equal, interval:1} 在 bar5 open 完成第 4 批后满仓。
fn dca_stop_bars(close5: f64, low5: f64, tail: f64) -> Vec<Bar> {
    let mut v: Vec<Bar> = (0..5)
        .map(|i| Bar {
            ts: 1_700_000_000 + i as i64 * 86_400,
            open: 10.0,
            high: 10.0,
            low: 10.0,
            close: 10.0,
            volume: 1.0,
        })
        .collect();
    v.push(Bar {
        ts: 1_700_000_000 + 5 * 86_400,
        open: 9.7,
        high: 9.7,
        low: low5,
        close: close5,
        volume: 1.0,
    });
    v.push(Bar {
        ts: 1_700_000_000 + 6 * 86_400,
        open: tail,
        high: tail,
        low: tail,
        close: tail,
        volume: 1.0,
    });
    v.push(Bar {
        ts: 1_700_000_000 + 7 * 86_400,
        open: tail,
        high: tail,
        low: tail,
        close: tail,
        volume: 1.0,
    });
    v
}

#[test]
fn stop_liquidation_resets_dca_state_close_basis() {
    let bars = dca_stop_bars(9.42, 9.42, 9.42);
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::Dca {
            tranches: 4,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::FixedPct,
        value: 0.05,
        trigger: StopTrigger::CloseBasis,
    });
    let res = run(&cfg, &bars);

    // bar5 收盘破线（avg_cost≈9.9295，线≈9.4330 > 9.42）→ 订单标注 stop_trigger，bar6 open 成交。
    assert_eq!(res.per_bar[5].orders.len(), 1);
    assert_eq!(res.per_bar[5].orders[0].reason, OrderReason::StopTrigger);
    let stop_fill = fills(&res)
        .into_iter()
        .find(|f| f.4 == OrderReason::StopTrigger)
        .expect("应有止损强平成交");
    assert_eq!(stop_fill.0, 6, "CloseBasis 次 bar open 成交");

    // 核心断言（评审反例）：强平后首个 Buy 只执行**单批**（新一轮第 1 批），
    // 不得以陈旧批次状态一次性买回全部已累计批次（未修复时此处 qty = 10_000）。
    assert_eq!(res.per_bar[6].orders.len(), 1);
    assert_eq!(res.per_bar[6].orders[0].side, OrderSide::Buy);
    assert_eq!(res.per_bar[6].orders[0].reason, OrderReason::Policy);
    let expected_batch = res.net_value[6].1 / 4.0 / bars[6].close;
    close(res.per_bar[6].orders[0].qty, expected_batch);
    assert!(
        res.per_bar[6].orders[0].qty < 4_000.0,
        "单批 ≈ 2.5k 股，不得一次性买回 10_000 股"
    );
    // 批次重新计数：bar7 继续第 2 批（等额同价 → 同量）。
    assert_eq!(res.per_bar[7].orders.len(), 1);
    close(res.per_bar[7].orders[0].qty, expected_batch);
    // 交易：止损平仓一笔 + 期末强平一笔（重新建仓的部分）。
    assert_eq!(res.trades.len(), 2);
    assert_eq!(res.trades[0].close_bar, 6);
}

#[test]
fn stop_liquidation_resets_dca_state_intrabar() {
    // Intrabar 变体：bar5 low 9.42 破线（线≈9.4330）→ 当 bar 成交并重置。
    let bars = dca_stop_bars(9.5, 9.42, 9.5);
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::Dca {
            tranches: 4,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::FixedPct,
        value: 0.05,
        trigger: StopTrigger::Intrabar,
    });
    let res = run(&cfg, &bars);

    let stop_fill = fills(&res)
        .into_iter()
        .find(|f| f.4 == OrderReason::StopTrigger)
        .expect("应有止损强平成交");
    assert_eq!(stop_fill.0, 5, "Intrabar 当 bar 成交");

    // 强平后首个 Buy（同 bar 信号仍 80 分）只执行单批（未修复时 qty = 10_000）。
    assert_eq!(res.per_bar[5].orders.len(), 1);
    assert_eq!(res.per_bar[5].orders[0].side, OrderSide::Buy);
    assert_eq!(res.per_bar[5].orders[0].reason, OrderReason::Policy);
    let expected_batch = res.net_value[5].1 / 4.0 / bars[5].close;
    close(res.per_bar[5].orders[0].qty, expected_batch);
    assert!(
        res.per_bar[5].orders[0].qty < 4_000.0,
        "单批 ≈ 2.5k 股，不得一次性买回 10_000 股"
    );
    // bar6 继续第 2 批。
    assert_eq!(res.per_bar[6].orders.len(), 1);
    close(res.per_bar[6].orders[0].qty, expected_batch);
    assert_eq!(res.trades.len(), 2);
    assert_eq!(res.trades[0].close_bar, 5);
}

// ---------------------------------------------------------------------------
// MINOR-1：Intrabar ATR 前视修复（截至上一 bar 口径；兼 Atr×Intrabar 组合，MINOR-5）
// ---------------------------------------------------------------------------

#[test]
fn stop_atr_intrabar_uses_atr_through_previous_bar() {
    // 反例：14 根平稳 bar（TR 恒 1.0 → ATR(14)=1.0）+ bar14 深跌（TR=2.1）。
    // 若 ATR 含当前 bar → 线被污染下移 → 漏触发（前视）；截至上一 bar 口径 → 触发。
    let mut bars: Vec<Bar> = (0..14)
        .map(|i| Bar {
            ts: 1_700_000_000 + i as i64 * 86_400,
            open: 10.0,
            high: 10.5,
            low: 9.5,
            close: 10.0,
            volume: 1.0,
        })
        .collect();
    bars.push(Bar {
        ts: 1_700_000_000 + 14 * 86_400,
        open: 9.9,
        high: 9.9,
        low: 7.9,
        close: 8.2,
        volume: 1.0,
    });

    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::Atr,
        value: 2.0,
        trigger: StopTrigger::Intrabar,
    });
    let res = run(&cfg, &bars);

    let fee = FeeModel::default();
    let avg_cost = 100_000.0 / fee.buy(100_000.0, 10.0).shares;
    let atr_prev = backtest::Indicators::new(&bars, 13)
        .atr(14)
        .expect("截至上一 bar ATR 数据充足");
    let atr_incl = backtest::Indicators::new(&bars, 14)
        .atr(14)
        .expect("含当前 bar ATR 数据充足");
    let line_prev = avg_cost - 2.0 * atr_prev;
    let line_incl = avg_cost - 2.0 * atr_incl;
    assert!(
        line_incl < bars[14].low && bars[14].low < line_prev,
        "反例前置：仅「截至上一 bar」口径触发（line_prev={line_prev}, low={}, line_incl={line_incl}）",
        bars[14].low
    );

    // 止损在 bar14 当 bar 按「截至上一 bar」的止损线成交。
    let stop_fills: Vec<_> = fills(&res)
        .into_iter()
        .filter(|f| f.4 == OrderReason::StopTrigger)
        .collect();
    assert_eq!(
        stop_fills.len(),
        1,
        "bar14 前（i<14 数据不足/线未破）不得触发"
    );
    assert_eq!(stop_fills[0].0, 14, "Intrabar 当 bar 成交");
    close(stop_fills[0].3, line_prev * (1.0 - fee.slippage_fraction()));
    assert_eq!(res.trades[0].close_bar, 14);
}

// ---------------------------------------------------------------------------
// MINOR-5：边界用例
// ---------------------------------------------------------------------------

#[test]
fn zero_slots_neutral_50_no_orders() {
    // 零 slot 属合法「无覆盖」场景（MINOR-4 裁决：run_ensemble 不禁空）。
    let bars = flat_bars(5, 10.0);
    let cfg = base_cfg(vec![], ExecutionPolicy::LumpSum { position_pct: 1.0 });
    let res = run(&cfg, &bars);

    assert_eq!(res.per_bar.len(), 5);
    for r in &res.per_bar {
        assert!(r.scores.is_empty());
        close(r.aggregate, 50.0);
        assert_eq!(r.signal, TradeSignal::Hold, "中立 50 → Hold");
        assert!(r.orders.is_empty());
        assert!(r.events.is_empty());
    }
    assert!(res.trades.is_empty());
    for (_, v) in &res.net_value {
        close(*v, 100_000.0);
    }
}

#[test]
fn stop_configured_but_never_holding_is_noop() {
    // 守卫路径：配置止损但全程零持仓（恒 50 → Hold）→ 无成交无交易无panic。
    let bars = flat_bars(5, 10.0);
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 50.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::FixedPct,
        value: 0.05,
        trigger: StopTrigger::Intrabar,
    });
    let res = run(&cfg, &bars);

    assert!(fills(&res).is_empty());
    assert!(res.trades.is_empty());
    for (_, v) in &res.net_value {
        close(*v, 100_000.0);
    }
}

#[test]
fn stop_trailing_close_basis_next_open_fill() {
    // MINOR-5 组合覆盖：Trailing × CloseBasis（既有用例为 Trailing × Intrabar）。
    let bars = vec![
        Bar {
            ts: 1_700_000_000,
            open: 10.0,
            high: 10.0,
            low: 10.0,
            close: 10.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_086_400,
            open: 10.0,
            high: 10.6,
            low: 9.9,
            close: 10.5,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_172_800,
            open: 10.5,
            high: 11.1,
            low: 10.4,
            close: 11.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_259_200,
            open: 11.0,
            high: 11.6,
            low: 10.9,
            close: 11.5,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_345_600,
            open: 11.5,
            high: 12.1,
            low: 11.4,
            close: 12.0,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_432_000,
            open: 11.8,
            high: 11.9,
            low: 10.6,
            close: 10.7,
            volume: 1.0,
        },
        Bar {
            ts: 1_700_518_400,
            open: 10.65,
            high: 10.65,
            low: 10.65,
            close: 10.65,
            volume: 1.0,
        },
    ];
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::Trailing,
        value: 0.1,
        trigger: StopTrigger::CloseBasis,
    });
    let res = run(&cfg, &bars);

    // 峰值 12（bar4 收盘并入）→ 线 10.8；bar5 close 10.7 < 10.8 → 收盘判定触发 → bar6 open 成交。
    assert_eq!(res.per_bar[5].orders.len(), 1);
    assert_eq!(res.per_bar[5].orders[0].reason, OrderReason::StopTrigger);
    assert_eq!(res.per_bar[5].orders[0].side, OrderSide::Sell);
    let fee = FeeModel::default();
    let stop_fill = fills(&res)
        .into_iter()
        .find(|f| f.4 == OrderReason::StopTrigger)
        .expect("应有 trailing 止损成交");
    assert_eq!(stop_fill.0, 6, "CloseBasis 次 bar open 成交");
    close(stop_fill.3, 10.65 * (1.0 - fee.slippage_fraction()));
    assert_eq!(res.trades[0].close_bar, 6);
}

// ---------------------------------------------------------------------------
// NIT-3：EnsembleConfig::validate() 非法配置拒绝
// ---------------------------------------------------------------------------

#[test]
fn ensemble_config_validate_rejects_illegal_configs() {
    let bars = flat_bars(3, 10.0);
    let mk = || {
        base_cfg(
            vec![slot(
                CONSTANT_SCORE,
                "sha256:constant_score",
                params(&[("score", 80.0)]),
                1.0,
            )],
            ExecutionPolicy::LumpSum { position_pct: 0.8 },
        )
    };
    let run_err = |cfg: &EnsembleConfig| {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        run_ensemble(cfg, &bars, &mut rt).is_err()
    };

    let mut c = mk();
    c.buy_threshold = 40.0;
    c.sell_threshold = 60.0;
    assert!(run_err(&c), "buy_threshold < sell_threshold → Err");

    let mut c = mk();
    c.buy_threshold = 50.0;
    c.sell_threshold = 50.0;
    assert!(run_err(&c), "阈值相等（不严格大于）→ Err");

    let mut c = mk();
    c.buy_threshold = f64::NAN;
    assert!(run_err(&c), "阈值 NaN → Err");

    let mut c = mk();
    c.initial_capital = 0.0;
    assert!(run_err(&c), "initial_capital = 0 → Err");

    let mut c = mk();
    c.initial_capital = -1_000.0;
    assert!(run_err(&c), "initial_capital < 0 → Err");

    let mut c = mk();
    c.policy = ExecutionPolicy::LumpSum { position_pct: 0.0 };
    assert!(run_err(&c), "position_pct ∉ (0,1] → Err");

    let mut c = mk();
    c.policy = ExecutionPolicy::Dca {
        tranches: 0,
        mode: DcaMode::Equal,
        amount: None,
        interval: 1,
    };
    assert!(run_err(&c), "tranches < 1 → Err");

    assert!(!run_err(&mk()), "合法配置 → Ok");
}
