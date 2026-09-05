//! 黄金样本（单测锁定）：手工 12 根 1 日 bar 驱动双均线策略（快2/慢3/全仓）。
//! 期望值由独立 Python 模型按 ADR 口径推演（含滑点/佣金/印花税/下一 bar open 成交/期末平仓）。
//! 锁死：净值序列逐点、回撤序列逐点、8 项指标、买卖明细（费用/滑点/持仓时长）。
#![allow(clippy::excessive_precision)]

use backtest::{DualMaStrategy, Engine, FeeModel, Period, RunConfig, Strategy, Signal, Bar};

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

fn golden_bars() -> Vec<Bar> {
    // (ts 相对, close)   —— open==close；high=max(low=min)（双均线只用 close，其它指标不受影响）
    let closes: [f64; 12] = [10.0, 9.0, 8.0, 8.2, 9.5, 12.0, 11.0, 10.0, 13.0, 15.0, 10.5, 10.5];
    let base = 1_704_067_200_i64;
    closes
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let ts = base + i as i64 * 86_400;
            Bar {
                ts,
                open: *c,
                high: *c,
                low: *c,
                close: *c,
                volume: 10_000.0,
            }
        })
        .collect()
}

#[test]
fn golden_dual_ma_pipeline() {
    let bars = golden_bars();
    let mut strat = DualMaStrategy::new(2, 3, 1.0);
    let cfg = RunConfig {
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::D1,
    };
    let res = Engine::new(cfg).run(&bars, &mut strat);

    // ---- 净值序列（逐点） ----
    let expected_nav: [(i64, f64); 12] = [
        (1_704_067_200, 100_000.0),
        (1_704_153_600, 100_000.0),
        (1_704_240_000, 100_000.0),
        (1_704_326_400, 100_000.0),
        (1_704_412_800, 100_000.0),
        (1_704_499_200, 99_955.0152453888),
        (1_704_585_600, 91_625.4306416064),
        (1_704_672_000, 83_295.8460378240),
        (1_704_758_400, 108_181.7457220045),
        (1_704_844_800, 108_133.0804291573),
        (1_704_931_200, 75_693.1563004101),
        (1_705_017_600, 75_621.2591558982),
    ];
    assert_eq!(res.net_value_series.len(), 12);
    for (got, (ets, eeq)) in res.net_value_series.iter().zip(expected_nav.iter()) {
        assert_eq!(got.0, *ets, "ts mismatch");
        close(got.1, *eeq);
    }

    // ---- 回撤序列（逐点） ----
    let expected_dd: [f64; 12] = [
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0004498475,
        0.0837456936,
        0.1670415396,
        0.0,
        0.0004498475,
        0.3003148933,
        0.3009794892,
    ];
    assert_eq!(res.drawdown_series.len(), 12);
    for (got, edd) in res.drawdown_series.iter().zip(expected_dd.iter()) {
        close(got.1, *edd);
    }

    // ---- 交易明细 ----
    assert_eq!(res.trades.len(), 2);
    let t0 = &res.trades[0];
    assert_eq!(t0.open_ts, 1_704_499_200);
    assert_eq!(t0.close_ts, 1_704_758_400);
    assert_eq!(t0.open_bar, 5);
    assert_eq!(t0.close_bar, 8);
    close(t0.open_price, 12.0024);
    close(t0.close_price, 12.9974);
    close(t0.shares, 8329.58460378);
    close(t0.gross_value, 108262.9429292);
    close(t0.commission, 52.05948729);
    close(t0.stamp_duty, 54.13147146);
    close(t0.pnl, 8181.745722);
    assert_eq!(t0.hold_bars, 3);

    let t1 = &res.trades[1];
    assert_eq!(t1.open_ts, 1_704_844_800);
    assert_eq!(t1.close_ts, 1_705_017_600);
    assert_eq!(t1.open_bar, 9);
    assert_eq!(t1.close_bar, 11);
    close(t1.open_price, 15.003);
    close(t1.close_price, 10.4979);
    close(t1.shares, 7208.87202861);
    close(t1.gross_value, 75678.01766915);
    close(t1.commission, 45.95818118);
    close(t1.stamp_duty, 37.83900883);
    close(t1.pnl, -32560.48656611);
    assert_eq!(t1.hold_bars, 2);

    // ---- 8 项指标 ----
    let m = &res.metrics;
    close(m.net_profit, -24378.740844101805);
    close(m.max_drawdown, 0.300979489181);
    close(m.sharpe, -1.848716325424);
    close(m.win_rate, 0.500000000000);
    close(m.profit_factor, 0.251278361747);
    close(m.annualized_return, -0.997171722664);
    assert_eq!(m.trade_count, 2);
    close(m.avg_hold_bars, 2.5);
}

// 校验策略信号逻辑本身（与黄金样本同源）：仅当双均线定义后交叉才产生信号。
#[test]
fn dual_ma_signal_crossings() {
    let bars = golden_bars();
    let mut strat = DualMaStrategy::new(2, 3, 1.0);
    let mut signals = Vec::new();
    for i in 0..bars.len() {
        let bar = &bars[i];
        let ind = backtest::Indicators::new(&bars, i);
        let mut ctx = backtest::Ctx {
            bar_index: i,
            ts: bar.ts,
            cash: 100_000.0,
            position: 0.0,
            equity: 100_000.0,
        };
        signals.push(strat.on_bar(&mut ctx, bar, &ind));
    }
    // 期望：bar4=Buy、bar7=Sell、bar8=Buy、bar10=Sell、其余 Hold
    assert!(matches!(signals[4], Signal::Buy(_)));
    assert!(matches!(signals[7], Signal::Sell));
    assert!(matches!(signals[8], Signal::Buy(_)));
    assert!(matches!(signals[10], Signal::Sell));
    for idx in [0_usize, 1, 2, 3, 5, 6, 9, 11] {
        assert!(matches!(signals[idx], Signal::Hold), "idx {idx} should Hold");
    }
}
