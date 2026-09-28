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
        // P1b 机械适配（架构裁决 2026-09-20 方案 A）：EnsembleConfig 增 symbol（code 唯一取值来源）。
        symbol: "TEST.SYMBOL".to_string(),
        slots,
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy,
        stop: None,
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::D1,
        warmup_bars: 0,
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
            // P1b 机械适配：`EngineEvent::Fill` 增 rt_seq + 金额三件套；本投影只消费原 5 字段。
            EngineEvent::Fill {
                bar_index,
                side,
                qty,
                price,
                reason,
                ..
            } => Some((*bar_index, *side, *qty, *price, *reason)),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 端到端：Buy → 持仓 → 期末强平（ensemble 自身断言）
// P4b：旧 backtest 引擎已物理删除（D16 终章），原「费用口径与旧引擎逐点一致」交叉验证随之退役
// （费用 parity 已于并存期历史证明，见 git 历史）；ensemble 断言继续守护未来回归。
// ---------------------------------------------------------------------------

#[test]
fn e2e_buy_hold_force_close() {
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
    assert_eq!((res.trades[0].open_bar, res.trades[0].close_bar), (1, Some(2)));
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
    assert_eq!(res.trades[0].close_bar, Some(2));
    close(
        // P1b 机械适配：v2 `close_price: Option<f64>` ⇒ 解包（Closed 回合必为 Some）。
        res.trades[0]
            .close_price
            .expect("Closed 回合必有 close_price（02-spec §2）"),
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
    assert_eq!(res.trades[0].close_bar, Some(3));
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
    assert_eq!(res.trades[0].close_bar, Some(5));
    close(
        // P1b 机械适配：v2 `close_price: Option<f64>` ⇒ 解包（Closed 回合必为 Some）。
        res.trades[0]
            .close_price
            .expect("Closed 回合必有 close_price（02-spec §2）"),
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
    assert_eq!(res.trades[0].close_bar, Some(17));
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
    assert_eq!(res.trades[0].close_bar, Some(6));
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
    assert_eq!(res.trades[0].close_bar, Some(5));
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
    assert_eq!(res.trades[0].close_bar, Some(14));
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
    assert_eq!(res.trades[0].close_bar, Some(6));
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

    // MINOR-4：阈值须夹中立 50（buy > 50 且 sell < 50），保证「全熔断→中立 50→Hold」契约。
    let mut c = mk();
    c.buy_threshold = 45.0;
    c.sell_threshold = 40.0;
    assert!(run_err(&c), "buy=45/sell=40：buy 未夹中立 50（中立 50 会误判 buy）→ Err");

    let mut c = mk();
    c.buy_threshold = 50.0;
    c.sell_threshold = 40.0;
    assert!(run_err(&c), "buy_threshold 恰值中立 50（须严格大于）→ Err");

    let mut c = mk();
    c.buy_threshold = 60.0;
    c.sell_threshold = 50.0;
    assert!(run_err(&c), "sell_threshold 恰值中立 50（须严格小于）→ Err");

    let mut c = mk();
    c.buy_threshold = 60.0;
    c.sell_threshold = 55.0;
    assert!(run_err(&c), "sell_threshold 超中立 50（中立 50 会误判 sell）→ Err");

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

// ---------------------------------------------------------------------------
// I-2/D6：warmup 语义（架构师 2026-09-12 裁决 = 方案 A 引擎级标记）
// warmup 段逐 bar 评分（真预热指标/插件状态）但 per_bar 记 warmup=true、
// 不执行 Policy、不产订单、不计净值/回撤/绩效；from 起空仓正常执行。
// ---------------------------------------------------------------------------

#[test]
fn warmup_prefix_scores_but_never_executes_or_counts_metrics() {
    let bars = flat_bars(10, 10.0);
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.warmup_bars = 3;
    let res = run(&cfg, &bars);

    // 前缀 3 根标记 warmup=true，其余 false。
    assert!(
        res.per_bar[..3].iter().all(|r| r.warmup),
        "前 3 根应标记 warmup"
    );
    assert!(
        res.per_bar[3..].iter().all(|r| !r.warmup),
        "from 起不得标记 warmup"
    );
    // warmup 段仍评分（预热插件/指标）。
    assert!(
        res.per_bar[..3].iter().all(|r| r.aggregate == 80.0),
        "warmup 段应仍评分"
    );
    // warmup 段不产订单、不成交、无持仓演进。
    assert!(
        res.per_bar[..3].iter().all(|r| r.orders.is_empty()),
        "warmup 不得产订单"
    );
    assert!(
        res.per_bar[..3]
            .iter()
            .flat_map(|r| r.events.iter())
            .all(|e| !matches!(e, EngineEvent::Fill { .. })),
        "warmup 段不得成交"
    );
    // 净值/回撤/绩效仅含 in-range（10 - 3 = 7 点）。
    assert_eq!(res.net_value.len(), 7, "净值仅 in-range 7 根");
    assert_eq!(res.drawdown.len(), 7);
    assert_eq!(res.net_value[0].0, bars[3].ts, "净值首点 = from 首根");
    // 首个成交发生在 in-range：index 3 决策 Buy → index 4 open 成交。
    let f = fills(&res);
    assert!(!f.is_empty(), "in-range 应有成交（恒 80 → Buy）");
    assert_eq!(
        f[0].0, 4,
        "首个成交在 index 4（index 3 决策，warmup 不执行）"
    );
}

#[test]
fn warmup_zero_is_legacy_behaviour() {
    let bars = flat_bars(6, 10.0);
    let mut cfg = base_cfg(
        vec![slot(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
    );
    cfg.warmup_bars = 0;
    let res = run(&cfg, &bars);
    assert!(res.per_bar.iter().all(|r| !r.warmup));
    assert_eq!(res.net_value.len(), 6);
}

// ---------------------------------------------------------------------------
// ADR-026 §2.3：`TradeDetail.reason`（清仓那一笔的来源，向后兼容）
// ---------------------------------------------------------------------------

/// 清仓来源三值逐一取证：`Policy`（信号清仓）/ `StopTrigger`（硬止损）/ `ForceClose`（期末强平）。
/// **不改 `trade_count` 语义**：回合数仍 = 平仓次数（本测试逐例断言长度不变）。
#[test]
fn trade_detail_reason_records_liquidation_source() {
    // ① 期末强平：`LumpSum{1}` + 全程 Buy → 唯一回合由 `finish` 清仓合成。
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
    assert_eq!(res.trades.len(), 1, "trade_count 语义不变（1 次平仓）");
    assert_eq!(
        res.trades[0].reason.as_deref(),
        Some("ForceClose"),
        "期末强平合成的回合须标注来源"
    );

    // ② 信号清仓（Policy）：持仓门控驱动 买→卖 闭环，前两笔由 Sell 信号清仓，末笔期末强平。
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
    assert_eq!(res.trades.len(), 3, "trade_count 语义不变（3 次平仓）");
    let reasons: Vec<Option<&str>> = res.trades.iter().map(|t| t.reason.as_deref()).collect();
    assert_eq!(
        reasons,
        vec![Some("Policy"), Some("Policy"), Some("ForceClose")],
        "信号清仓标 Policy；末笔期末强平标 ForceClose"
    );

    // ③ 硬止损清仓（StopTrigger）：Intrabar 止损当 bar 平仓。
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
    assert_eq!(res.trades.len(), 2);
    assert_eq!(
        res.trades[0].reason.as_deref(),
        Some("StopTrigger"),
        "止损清仓须标注 StopTrigger"
    );
    assert_eq!(res.trades[1].reason.as_deref(), Some("ForceClose"));
}


// ---------------------------------------------------------------------------
// ADR-029 Step 1：`exposure × ramp × guard` 引擎端到端（E7 / E9 / E10 / E13）
// ---------------------------------------------------------------------------

/// 脚本化分数（按 index 取序列值；ADR-029 引擎端到端用例用）。
const SCRIPTED_SCORES: &str = r#"
const SCRIPT = [80, 80, 80, 50, 50, 80, 80, 90, 90, 90];
function on_bar(ctx) { return SCRIPT[ctx.index % SCRIPT.length]; }
"#;

/// ±5 分抖动（偶数 bar 75 分、奇数 bar 80 分；ADR-029 E9 防抖用例）。
const JITTER_SCORES: &str = r#"
function on_bar(ctx) { return ctx.index % 2 === 0 ? 75 : 80; }
"#;

fn exposure_cfg(
    code: &str,
    hash: &str,
    params: StrategyParams,
    policy: ExecutionPolicy,
) -> EnsembleConfig {
    base_cfg(vec![slot(code, hash, params, 1.0)], policy)
}

/// `constant_score` 带 80 分（Buy 档）的 slot 参数。
fn buy_score_params() -> StrategyParams {
    params(&[("score", 80.0)])
}

fn guard(max_pct: f64, min_pct: f64, deadzone_pct: f64) -> strategy_core::GuardSpec {
    strategy_core::GuardSpec { max_pct, min_pct, deadzone_pct, deadzone_min_notional: None }
}

/// E10：每 bar 观测字段（`target_pct`/`current_pct`/`deadzone_blocked`/`clamped_by_guard`
/// /`rate_limited`/`ramp_cap_pct_per_bar`/`sell_transition`）逐 bar 可读且取值正确。
#[test]
fn adr029_e10_policy_observation_recorded_per_bar() {
    let bars = flat_bars(6, 10.0);
    let cfg = exposure_cfg(
        CONSTANT_SCORE,
        "sha256:constant_score",
        buy_score_params(),
        ExecutionPolicy::Exposure {
            target: strategy_core::ExposureTarget::Fixed { pct: 0.4 },
            ramp: strategy_core::RampSpec::Immediate,
            guard: guard(1.0, 0.0, 0.005),
        },
    );
    let res = run(&cfg, &bars);

    // bar0：空仓 ⇒ 目标 0.4×100_000/10 = 4000 股；观测 = 目标 0.4 / 当前 0 / 各标志 false。
    let o0 = res.per_bar[0].policy_obs;
    close(o0.target_pct.expect("target_pct 可读"), 0.4);
    close(o0.current_pct.expect("current_pct 可读"), 0.0);
    assert!(!o0.deadzone_blocked && !o0.clamped_by_guard && !o0.rate_limited);
    assert!(!o0.sell_transition && o0.ramp_cap_pct_per_bar.is_none());
    assert_eq!(res.per_bar[0].orders.len(), 1, "bar0 应挂买入单");

    // bar1：仓位已到（差 = 佣金级微差）⇒ 死区拦下（零订单），观测 = 目标 = 当前。
    let o1 = res.per_bar[1].policy_obs;
    assert!(o1.deadzone_blocked, "Δ 在死区内 ⇒ 拦下");
    assert!(res.per_bar[1].orders.is_empty(), "死区内不得下单");
    let t1 = o1.target_pct.expect("target_pct");
    let c1 = o1.current_pct.expect("current_pct");
    close(t1, c1);
    assert!((t1 - 0.4).abs() < 1e-4, "目标占比仍应为 ~0.4（实际 {t1}）");

    // 全程观测可读（每 bar 都有值，不只首根）
    for (i, r) in res.per_bar.iter().enumerate() {
        assert!(
            r.policy_obs.target_pct.is_some() && r.policy_obs.current_pct.is_some(),
            "bar {i} 观测缺字段"
        );
    }
}

/// E10 边界：warmup 段不执行 Policy ⇒ 观测为零值（`None`），不得伪造目标。
#[test]
fn adr029_e10_warmup_bars_have_no_observation() {
    let bars = flat_bars(5, 10.0);
    let mut cfg = exposure_cfg(
        CONSTANT_SCORE,
        "sha256:constant_score",
        buy_score_params(),
        ExecutionPolicy::Exposure {
            target: strategy_core::ExposureTarget::Fixed { pct: 0.4 },
            ramp: strategy_core::RampSpec::Immediate,
            guard: guard(1.0, 0.0, 0.0),
        },
    );
    cfg.warmup_bars = 2;
    let res = run(&cfg, &bars);
    for r in res.per_bar.iter().take(2) {
        assert!(r.warmup);
        assert_eq!(
            r.policy_obs,
            strategy_core::PolicyObservation::default(),
            "warmup bar 观测须为零值"
        );
    }
    assert!(res.per_bar[2].policy_obs.target_pct.is_some(), "in-range 起恢复观测");
}

/// E13：`Exposure{Fixed{pct}}`（Immediate + 宽松 guard）与 `LumpSum{position_pct}` 在同一
/// bar 序列上**成交序列逐位一致**（含净值曲线逐位一致）。
#[test]
fn adr029_e13_fixed_matches_lump_sum_fills_bitwise() {
    // 价格路径含上涨/回撤；分数序列含 Buy → Hold（解冻）→ Buy（重快照）→ 更强 Buy。
    let prices = [10.0, 10.0, 10.5, 10.5, 10.0, 9.8, 10.2, 10.4, 10.1, 10.3];
    let bars: Vec<Bar> = prices
        .iter()
        .enumerate()
        .map(|(i, p)| Bar {
            ts: 1_700_000_000 + i as i64 * 86_400,
            open: *p,
            high: *p,
            low: *p,
            close: *p,
            volume: 10_000.0,
        })
        .collect();

    let lump = exposure_cfg(
        SCRIPTED_SCORES,
        "sha256:scripted_scores",
        StrategyParams::new(),
        ExecutionPolicy::LumpSum { position_pct: 0.5 },
    );
    let fixed = exposure_cfg(
        SCRIPTED_SCORES,
        "sha256:scripted_scores",
        StrategyParams::new(),
        ExecutionPolicy::Exposure {
            target: strategy_core::ExposureTarget::Fixed { pct: 0.5 },
            ramp: strategy_core::RampSpec::Immediate,
            guard: guard(1.0, 0.0, 0.0),
        },
    );
    let ra = run(&lump, &bars);
    let rb = run(&fixed, &bars);

    let fa = fills(&ra);
    let fb = fills(&rb);
    assert!(!fa.is_empty(), "用例须真有成交（否则等价断言空洞）");
    assert_eq!(fa.len(), fb.len(), "成交笔数须一致");
    for (i, (a, b)) in fa.iter().zip(fb.iter()).enumerate() {
        assert_eq!(a.0, b.0, "第 {i} 笔成交 bar 不一致");
        assert_eq!(a.1, b.1, "第 {i} 笔方向不一致");
        assert_eq!(a.2.to_bits(), b.2.to_bits(), "第 {i} 笔股数不逐位一致");
        assert_eq!(a.3.to_bits(), b.3.to_bits(), "第 {i} 笔价格不逐位一致");
        assert_eq!(a.4, b.4, "第 {i} 笔缘由不一致");
    }
    assert_eq!(ra.net_value.len(), rb.net_value.len());
    for (i, (x, y)) in ra.net_value.iter().zip(rb.net_value.iter()).enumerate() {
        assert_eq!(x.0, y.0);
        assert_eq!(x.1.to_bits(), y.1.to_bits(), "第 {i} 点净值不逐位一致");
    }
    assert_eq!(ra.trades.len(), rb.trades.len());
}

/// E7：硬止损强平 = 外部中断 ⇒ 路径作废（`PolicyState::reset`）⇒ 限速从**实际暴露**重新起算，
/// 而非续用强平前的旧目标。
///
/// **fixture 输入修正（2026-09-25，架构侧裁定授权；仅改输入，全部断言与容差逐字未动）**
///
/// 原 fixture（`prices = [10, 10, 9.4, 10, 10, 10]`，且**每根 bar `open == close`**）**隐式依赖
/// ADR-029 D3 卡死缺陷**：旧码（`clamp_lump_frozen` 在**任何** Policy 买单成交后无条件调用）下，
/// bar1 成交 ≈500 股后冻结目标即被下调到实得 ⇒ bar1 决策层算出「目标 − 当前 = 0」⇒
/// **bar2 无第二笔成交** ⇒ bar2 摊薄成本停在 ≈10.0118 ⇒ 5% 固定止损线 ≈9.511 > bar2 close 9.4
/// ⇒ 击穿。D3 修复后 bar1 照常再挂 ≈500 股，该笔在 **bar2 open** 成交；原 fixture 的 bar2
/// `open == close == 9.4` 使这笔在 9.4 成交，把摊薄成本拉低到 ≈9.71 ⇒ 止损线 ≈9.222 < 9.4
/// ⇒ **不再击穿**（任何正确修复只要让 bar1 继续挂单都会如此，非本方案特有）。
///
/// 修正＝**只把 bar2 的 `open` 恢复为 10.0**（`close` 保持 9.4 不动；A 股 D1 常见的
/// 「高开/日内回落」形态）：第二笔成交价位回到 ≈10.0 ⇒ 摊薄成本 ≈10.007 ⇒ 止损线 ≈9.507 > 9.4
/// ⇒ 击穿 ⇒ 原判据（击穿 ⇒ `StopTrigger` ⇒ `reset` ⇒ 限速从**实际暴露**重起算）在新成交口径下
/// **完整行使**。本改动**仅还原 E7 原意，未改任何判据**。
///
/// **为何「只动 bar2 open」而不动 close（4 组对照实测；原始输出 `coder/evidence/20260925_d3_wedge_fix/27_e7_control_v*.txt`）**
///
/// 断言 `orders3[0].qty <= 500.5`（本文件 E7 内）读的是 **`per_bar[3]`**，其限速额度
/// `= pct_per_bar × (该决策 bar 净值) / 10.0`；而 `CloseBasis` 止损的**成交在次 bar open（=10.0）**。
/// 实测（均在修复码上，仅改 bar2 输入；净值为 `positions` 逐点原始值）：
///
/// | bar2 输入 | 止损击穿 | 决策 bar 净值（price 10.0） | `per_bar[3].orders[0].qty` | 结果 |
/// |---|---|---|---|---|
/// | **open 10.0 / close 9.4（采用）** | 是 | 99976.0046428856 | **499.880023214428**（= 额度） | **ok** |
/// | open == close == 9.4（原 fixture） | 否（摊薄成本 ≈9.706 ⇒ 线 ≈9.221 < 9.4） | —（bar2 报 `Policy` 530.6636） | — | 红：`orders[0].reason` 得 `Policy`，期望 `StopTrigger` |
/// | open == close == 9.10 | 否（线 ≈9.077 < 9.10） | —（bar2 报 `Policy` 547.3387） | — | 红：同上 `reason` 断言 |
/// | open == close == 9.05 | 是 | 100451.0218330292 | **502.25510916514605** | 红：`qty <= 500.5` |
/// | open == close == 9.0 | 是 | 100476.01967116745 | **502.3800983558373** | 红：`qty <= 500.5` |
///
/// ⇒ 「加深 close（open 随动）」的每一档都不能满足原判据：**9.10 档止损根本不击穿**；9.05/9.0 档击穿后
/// 强平变成对**被拉低的摊薄成本**的盈利平仓 ⇒ 决策净值升到 100_451/100_476 ⇒ 额度
/// 502.255/502.380 > 500.5 ⇒ 红在 qty 断言。采用方案里 `per_bar[3]` 的 qty 是
/// 499.880023214428（**小于** 500.5）；500 量级以上的挂单只出现在**不被断言**的其它 bar
/// （采用方案的 `per_bar[4]` = 500.2249581776884，同样 ≤ 500.5）。
/// 故「只把 bar2 的 `open` 恢复为 10.0、`close` 保持 9.4」是既击穿止损、又不碰任何断言与容差的**最小**改法。
#[test]
fn adr029_e7_stop_reset_restarts_ramp_from_actual_exposure() {
    // 收盘价路径：10 → 10 → 9.4（收盘破固定止损线）→ 10 …（bar2 的 open 另设，见上方说明）
    let prices = [10.0, 10.0, 9.4, 10.0, 10.0, 10.0];
    let bars: Vec<Bar> = prices
        .iter()
        .enumerate()
        .map(|(i, p)| Bar {
            ts: 1_700_000_000 + i as i64 * 86_400,
            // bar2：open 保持 10.0（修复后 bar1 续挂的那笔在此成交，不得把摊薄成本拉低）；
            // 其余 bar 维持 open == close == p。
            open: if i == 2 { 10.0 } else { *p },
            high: if i == 2 { 10.0 } else { *p },
            low: *p,
            close: *p,
            volume: 10_000.0,
        })
        .collect();
    let mut cfg = exposure_cfg(
        CONSTANT_SCORE,
        "sha256:constant_score",
        buy_score_params(),
        ExecutionPolicy::Exposure {
            target: strategy_core::ExposureTarget::Fixed { pct: 1.0 },
            ramp: strategy_core::RampSpec::RateCap { pct_per_bar: 0.05, down_pct_per_bar: None, on_signal_break: None },
            guard: guard(1.0, 0.0, 0.0),
        },
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::FixedPct,
        value: 0.05,
        trigger: StopTrigger::CloseBasis,
    });
    let res = run(&cfg, &bars);

    // 判据行使的**原始逐 bar 痕迹**（仅取证打印，不参与判定；架构裁定条件 (3)/(4) 要求）。
    for (i, r) in res.per_bar.iter().enumerate() {
        eprintln!(
            "[E7 trace] bar {i} price {:.3} | target_pct {:?} | current_pct {:?} | rate_limited {} \
             | deadzone_blocked {} | orders {:?}",
            bars[i].close,
            r.policy_obs.target_pct,
            r.policy_obs.current_pct,
            r.policy_obs.rate_limited,
            r.policy_obs.deadzone_blocked,
            r.orders
                .iter()
                .map(|o| (o.side, o.qty, o.reason))
                .collect::<Vec<_>>()
        );
    }
    for (i, r) in res.per_bar.iter().enumerate() {
        for e in &r.events {
            eprintln!("[E7 trace] bar {i} event {e:?}");
        }
    }
    eprintln!("[E7 trace] positions {:?}", res.positions);

    // bar2：收盘破线 ⇒ 止损挂单（绕过 Policy，policy_obs 留零值）
    assert_eq!(res.per_bar[2].orders.len(), 1);
    assert_eq!(res.per_bar[2].orders[0].reason, OrderReason::StopTrigger);
    assert_eq!(
        res.per_bar[2].policy_obs,
        strategy_core::PolicyObservation::default(),
        "止损挂单 bar 不执行 Policy ⇒ 观测零值"
    );
    // bar3：强平成交后 Policy 恢复：限速锚点 = 实际暴露（0）⇒ 单笔 ≤ 0.05×净值/价 ≈ 500 股
    let orders3 = &res.per_bar[3].orders;
    assert_eq!(orders3.len(), 1, "强平后应有新一轮建仓挂单");
    assert_eq!(orders3[0].side, OrderSide::Buy);
    assert!(
        orders3[0].qty <= 500.5,
        "强平后限速须从实际暴露重新起算（应 ≤ ~500 股，实际 {}）",
        orders3[0].qty
    );
    assert!(res.per_bar[3].policy_obs.rate_limited);
}

/// E9（引擎端到端）：分数 ±5 抖动 20 根 bar ⇒ 不做「每 bar 微单」（订单数与费用上限）。
///
/// 标定（先标定后写死）：映射斜率 `at_full − at_threshold = 0.01` ⇒ ±5 分 ⇒ 目标占比抖动
/// ±0.00125（≈ 12.5 股 @ 净值 10 万/价 10 = 125 元），死区 0.005×净值 = 500 元 ⇒ 全被吸收。
/// 实测（本用例）：订单 1 笔、费用 5 元 ⇒ 费用占净值 0.005%。
#[test]
fn adr029_e9_engine_score_jitter_does_not_churn() {
    let bars = flat_bars(20, 10.0);
    let cfg = exposure_cfg(
        JITTER_SCORES,
        "sha256:jitter_scores",
        StrategyParams::new(),
        ExecutionPolicy::Exposure {
            target: strategy_core::ExposureTarget::ScoreMapped {
                at_threshold_pct: 0.2,
                at_full_pct: 0.21,
                sell: strategy_core::SellPolicy::Flat,
            },
            ramp: strategy_core::RampSpec::Immediate,
            guard: guard(1.0, 0.0, 0.005),
        },
    );
    let res = run(&cfg, &bars);

    let policy_orders: usize = res
        .per_bar
        .iter()
        .map(|r| {
            r.orders
                .iter()
                .filter(|o| o.reason == OrderReason::Policy)
                .count()
        })
        .sum();
    assert!(
        policy_orders <= 2,
        "20 根 ±5 分抖动 bar 上 Policy 订单须 ≤ 2（实测 {policy_orders}）"
    );
    // 费用上限（标定 0.1% 净值，远低于每 bar 微单的量级）
    let fees: f64 = res
        .per_bar
        .iter()
        .flat_map(|r| r.events.iter())
        .filter_map(|e| match e {
            EngineEvent::Fill { commission, stamp_duty, .. } => Some(commission + stamp_duty),
            _ => None,
        })
        .sum();
    assert!(
        fees / 100_000.0 <= 1e-3,
        "费用占净值比须 ≤ 0.1%（实测 {}）",
        fees / 100_000.0
    );
    let max_gap = res
        .per_bar
        .iter()
        .filter_map(|r| match (r.policy_obs.target_pct, r.policy_obs.current_pct) {
            (Some(t), Some(c)) => Some((t - c).abs()),
            _ => None,
        })
        .fold(0.0f64, f64::max);
    eprintln!(
        "[E9 标定·engine] max_intent_gap(同 bar、含建仓首根，**非审计口径**)={max_gap:.6}（仅标定读数；ADR-029 R18 已把**审计**口径改为滞后一 bar 对齐，见 application::audit::exposure_audit）"
    );
    eprintln!(
        "[E9 标定·engine] policy_orders={policy_orders} fees={fees:.4} fee_pct={:.6}% blocked={}/20",
        fees / 100_000.0 * 100.0,
        res.per_bar.iter().filter(|r| r.policy_obs.deadzone_blocked).count()
    );
    // 观测：绝大多数 bar 被死区拦下（不是「每 bar 下单」）
    let blocked = res.per_bar.iter().filter(|r| r.policy_obs.deadzone_blocked).count();
    assert!(blocked >= 18, "抖动应被死区吸收（实测拦下 {blocked}/20）");
}

/// E11（构造期 fail loud，run 配置层）：`ScoreMapped` 配 `buy_threshold = 100` 或
/// `sell_threshold = 0` 时映射分母为 0 ⇒ 引擎启动必须**拒绝运行**（不得静默回退默认）。
#[test]
fn adr029_e11_ensemble_config_rejects_score_mapped_with_degenerate_thresholds() {
    let bars = flat_bars(3, 10.0);
    let mk = |buy: f64, sell: f64| {
        let mut cfg = exposure_cfg(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", 80.0)]),
            ExecutionPolicy::Exposure {
                target: strategy_core::ExposureTarget::ScoreMapped {
                    at_threshold_pct: 0.2,
                    at_full_pct: 0.5,
                    sell: strategy_core::SellPolicy::Flat,
                },
                ramp: strategy_core::RampSpec::Immediate,
                guard: guard(1.0, 0.0, 0.0),
            },
        );
        cfg.buy_threshold = buy;
        cfg.sell_threshold = sell;
        cfg
    };
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let err = run_ensemble(&mk(100.0, 40.0), &bars, &mut rt).expect_err("buy_threshold=100 必须拒绝");
    assert!(
        format!("{err}").contains("buy_threshold"),
        "错误须点名字段：{err}"
    );
    let err = run_ensemble(&mk(60.0, 0.0), &bars, &mut rt).expect_err("sell_threshold=0 必须拒绝");
    assert!(
        format!("{err}").contains("sell_threshold"),
        "错误须点名字段：{err}"
    );
    // 合法阈值 ⇒ 正常运行
    run(&mk(60.0, 40.0), &bars);
}

/// E17（R11）：买入被**现金上限截断**时目标一次性下调到可达上限并披露
/// （`policy_obs.affordability_capped`），且截断后**不得**对不可达缺口每 bar 重复挂单。
///
/// 读数（本用例实测，打印于 stdout 供证据落盘）：`ScoreMapped` 目标 = 「比例 × **当前净值**」
/// ⇒ 被截断后净值已含费用损失，映射目标自动收敛到可达仓位（`target − current = 0`，实测无
/// `affordability_capped` 根 ⇒ 上限在本变体下**结构性不绑定**；该机制作为不变量守卫保留，
/// 变体侧的等价机制是 `Fixed`/`LumpSum` 的 `clamp_lump_frozen` 冻结目标下调）。
/// 判据落点为：① 截断确实发生（成交股数 < 同 bar 意图）；② 截断后逐 bar 无 Policy 挂单；
/// ③ 若披露则目标必被夹到 ≤ 可达上限。
#[test]
fn adr029_e17_engine_affordability_clip_is_disclosed_and_stops_micro_orders() {
    let bars = flat_bars(8, 10.0);
    let cfg = exposure_cfg(
        CONSTANT_SCORE,
        "sha256:constant_score",
        params(&[("score", 100.0)]),
        ExecutionPolicy::Exposure {
            target: strategy_core::ExposureTarget::ScoreMapped {
                at_threshold_pct: 1.0,
                at_full_pct: 1.0,
                sell: strategy_core::SellPolicy::Flat,
            },
            ramp: strategy_core::RampSpec::Immediate,
            guard: guard(1.0, 0.0, 0.0), // 死区 0：隔离 affordability 机制（不靠死区消单）
        },
    );
    let res = run(&cfg, &bars);

    // ① 截断确实发生：存在「决策 bar 的 Policy 买入意图 > 次 bar 实际成交股数」
    let mut clip_bar: Option<usize> = None;
    for (i, rec) in res.per_bar.iter().enumerate() {
        let intent: f64 = rec
            .orders
            .iter()
            .filter(|o| o.reason == OrderReason::Policy && o.side == OrderSide::Buy)
            .map(|o| o.qty)
            .sum();
        if intent <= 0.0 {
            continue;
        }
        let filled: f64 = res
            .per_bar
            .get(i + 1)
            .map(|n| {
                n.events
                    .iter()
                    .filter_map(|e| match e {
                        EngineEvent::Fill { side, qty, reason, .. }
                            if *side == OrderSide::Buy && *reason == OrderReason::Policy =>
                        {
                            Some(*qty)
                        }
                        _ => None,
                    })
                    .sum()
            })
            .unwrap_or(0.0);
        if filled < intent - 1e-9 {
            clip_bar = Some(i);
            break;
        }
    }
    let clip_bar = clip_bar.expect("本用例构造了 need > cash 的截断买入；未观测到截断即用例失效");

    // ② 截断后逐 bar：不得有 Policy 挂单（禁止对不可达缺口重复挂微单）
    let later_orders: Vec<usize> = res
        .per_bar
        .iter()
        .enumerate()
        .filter(|(i, r)| *i > clip_bar && !r.orders.is_empty())
        .map(|(i, _)| i)
        .collect();
    assert!(
        later_orders.is_empty(),
        "截断后不得重复挂微单（实际有挂单的 bar：{later_orders:?}）"
    );

    // ③ 条件式不变量：凡披露下调的 bar，目标必须被夹到可达上限（≤ 披露值且 = 当前暴露）
    let capped: Vec<usize> = res
        .per_bar
        .iter()
        .enumerate()
        .filter(|(_, r)| r.policy_obs.affordability_capped)
        .map(|(i, _)| i)
        .collect();
    for i in &capped {
        let o = res.per_bar[*i].policy_obs;
        let t = o.target_pct.expect("观测");
        let c = o.current_pct.expect("观测");
        assert!(
            (t - c).abs() < 1e-9,
            "bar {i}：披露下调时目标须 = 当前可达暴露（{t} vs {c}）"
        );
    }
    // 读数（证据落盘）：截断根 / 披露根数 / 截断后最大 |目标 − 当前|（净值占比）
    let max_gap_after = res
        .per_bar
        .iter()
        .enumerate()
        .filter(|(i, _)| *i > clip_bar)
        .filter_map(|(_, r)| match (r.policy_obs.target_pct, r.policy_obs.current_pct) {
            (Some(t), Some(c)) => Some((t - c).abs()),
            _ => None,
        })
        .fold(0.0f64, f64::max);
    eprintln!(
        "[E17 读数] clip_bar={clip_bar} capped_bars={capped:?} max_gap_after_clip={max_gap_after:e}"
    );
}
