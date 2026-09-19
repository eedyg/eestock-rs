//! ADR-027 P1b：引擎侧逐笔账本接线（`rt_seq` + 费用三件套 + 唯一聚合 + 持仓序列）的集成判据。
//!
//! 事实源契约：`design/17-trade-detail-layering/02-spec.md` §1.1/§1.3/§2/§4.1；
//! 测试规格：`design/17-trade-detail-layering/03-test-plan.md` U5/U6/U7 + I1/I3/I4 恒等式。
//!
//! 纪律：判据全部为**正向断言**（具体值 / 恒等式 / 位级相等）；确定性（无 RNG / 无系统时钟 / 无 IO）。
//! 本文件是 P1b **新增**判据，不改动 `adr027_repro.rs`（R 段）与既有引擎测试的判据强度。

use backtest::{Bar, FeeModel, Period};
use strategy_core::{
    run_ensemble, EngineEvent, EnsembleConfig, ExecutionPolicy, OrderReason, OrderSide, StrategySlot,
};
use strategy_runtime::{QuickJsRuntime, RuntimeLimits};

// ---------------------------------------------------------------------------
// 辅助（与 R 段同源的构造口径：固定 bar 序列 + 固定配置 + inline 脚本化插件）
// ---------------------------------------------------------------------------

/// 固定价 bar 序列（open=high=low=close=price）。
fn price_bars(prices: &[f64]) -> Vec<Bar> {
    prices
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
        .collect()
}

fn slot(code: &str, hash: &str, weight: f64) -> StrategySlot {
    StrategySlot::new(code, hash, backtest::StrategyParams::new(), weight).expect("合法 slot")
}

fn cfg(slots: Vec<StrategySlot>, policy: ExecutionPolicy, capital: f64) -> EnsembleConfig {
    EnsembleConfig {
        symbol: "TEST.SYMBOL".to_string(),
        slots,
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy,
        stop: None,
        initial_capital: capital,
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

/// bar0 Buy；bar1..3 Hold（解冻）；bar4..5 Buy（重快照 @ close=12）；bar6..7 Sell（清仓）。
const SCRIPT_PARTIAL_SELL: &str = r#"
function on_bar(ctx) {
  const i = ctx.index;
  if (i === 0 || (i >= 4 && i <= 5)) return 80;
  if (i >= 6) return 20;
  return 50;
}
"#;

/// 恒 Buy（80 分）：bar0 决策 → bar1 成交，此后不再卖出 ⇒ 期末强平。
const SCRIPT_ALWAYS_BUY: &str = r#"
function on_bar(ctx) { return 80; }
"#;

/// 部分卖出场景（3 笔成交：买 / 部分卖 / 清仓）：价格 10,10,10,10,12,12,11,11。
fn partial_sell_run() -> (EnsembleConfig, strategy_core::EnsembleResult) {
    let bars = price_bars(&[10.0, 10.0, 10.0, 10.0, 12.0, 12.0, 11.0, 11.0]);
    let cfg = cfg(
        vec![slot(SCRIPT_PARTIAL_SELL, "sha256:p1b_partial_sell", 1.0)],
        ExecutionPolicy::LumpSum { position_pct: 0.5 },
        100_000.0,
    );
    let res = run(&cfg, &bars);
    (cfg, res)
}

/// 买入后持有到期末（期末强平终结回合）。
fn hold_to_end_run() -> (EnsembleConfig, strategy_core::EnsembleResult) {
    let bars = price_bars(&[10.0, 10.0, 10.0, 10.0]);
    let cfg = cfg(
        vec![slot(SCRIPT_ALWAYS_BUY, "sha256:p1b_hold_to_end", 1.0)],
        ExecutionPolicy::LumpSum { position_pct: 0.5 },
        100_000.0,
    );
    let res = run(&cfg, &bars);
    (cfg, res)
}

/// 成交事件（含 P1b 新增字段）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct FillEv {
    bar_index: usize,
    side: OrderSide,
    qty: f64,
    price: f64,
    trade_value: f64,
    commission: f64,
    stamp_duty: f64,
    rt_seq: u32,
    reason: OrderReason,
}

fn fills(res: &strategy_core::EnsembleResult) -> Vec<FillEv> {
    res.per_bar
        .iter()
        .flat_map(|r| r.events.iter())
        .filter_map(|e| match e {
            EngineEvent::Fill {
                bar_index,
                side,
                qty,
                price,
                trade_value,
                commission,
                stamp_duty,
                rt_seq,
                reason,
            } => Some(FillEv {
                bar_index: *bar_index,
                side: *side,
                qty: *qty,
                price: *price,
                trade_value: *trade_value,
                commission: *commission,
                stamp_duty: *stamp_duty,
                rt_seq: *rt_seq,
                reason: *reason,
            }),
            _ => None,
        })
        .collect()
}

/// 相对容差恒等式断言（I3 口径：`1e-6 × max(1, |参考值|)`）。
#[track_caller]
fn assert_rel(a: f64, b: f64, what: &str) {
    let tol = 1e-6 * b.abs().max(1.0);
    assert!(
        (a - b).abs() <= tol,
        "{what}: 期望 {b}，实际 {a}（Δ = {}，容差 {tol}）",
        a - b
    );
}

// ---------------------------------------------------------------------------
// I1：L1 金额字段 == 该回合全部 L2 逐笔字段加总（02-spec §2 恒等式 I1）
// ---------------------------------------------------------------------------

#[test]
fn p1b_i1_l1_amounts_equal_per_fill_sums() {
    let (_cfg, res) = partial_sell_run();
    let f = fills(&res);
    assert_eq!(f.len(), 3, "前置：3 笔成交：{f:?}");
    assert_eq!(res.trades.len(), 1, "前置：1 个回合：{:?}", res.trades);

    let t = &res.trades[0];
    let mut exp_gross = 0.0;
    let mut exp_commission = 0.0;
    let mut exp_stamp = 0.0;
    let mut exp_shares = 0.0;
    let mut exp_sell_qty = 0.0;
    for x in &f {
        exp_commission += x.commission;
        if x.side == OrderSide::Buy {
            exp_shares += x.qty;
        } else {
            exp_sell_qty += x.qty;
        }
        if x.side == OrderSide::Sell {
            exp_gross += x.trade_value;
            exp_stamp += x.stamp_duty;
        }
    }
    assert_eq!(
        t.gross_value.to_bits(),
        exp_gross.to_bits(),
        "I1：L1.gross_value 必须 == Σ_sell L2.trade_value（位级相等，无第二处聚合）"
    );
    assert_eq!(
        t.commission.to_bits(),
        exp_commission.to_bits(),
        "I1：L1.commission 必须 == Σ_buy+Σ_sell L2.commission"
    );
    assert_eq!(
        t.stamp_duty.to_bits(),
        exp_stamp.to_bits(),
        "I1：L1.stamp_duty 必须 == Σ_sell L2.stamp_duty"
    );
    assert_eq!(t.l2_count, f.len(), "l2_count == 该回合成交笔数");
    assert_eq!(t.buy_count + t.sell_count, f.len(), "买卖笔数之和 == 笔数");
    assert_rel(t.shares, exp_shares, "L1.shares == Σ_buy qty（此处仅一笔买入）");
    assert_rel(
        exp_sell_qty,
        exp_shares,
        "前置：Closed 回合 Σ_sell qty == Σ_buy qty（回合闭合）",
    );
}

// ---------------------------------------------------------------------------
// I3：nav[-1] == initial + Σ_closed pnl（回测侧全回合 Closed ⇒ 无 Open 项）
// ---------------------------------------------------------------------------

#[test]
fn p1b_i3_nav_identity_holds_on_partial_sell_run() {
    let (cfg, res) = partial_sell_run();
    let nav_last = res.net_value.last().expect("有净值序列").1;
    let sum_pnl: f64 = res
        .trades
        .iter()
        .map(|t| t.pnl.expect("回测侧全回合必须 Closed（期末强平）⇒ pnl 必为 Some"))
        .sum();
    assert_rel(
        nav_last,
        cfg.initial_capital + sum_pnl,
        "I3：nav[-1] == initial_capital + Σ_closed(pnl)（部分卖出场景）",
    );
    assert!(
        res.trades
            .iter()
            .all(|t| t.status == backtest::RoundTripStatus::Closed),
        "回测侧所有回合必须 Closed：{:?}",
        res.trades
    );
}

#[test]
fn p1b_i3_nav_identity_holds_on_force_close_run() {
    let (cfg, res) = hold_to_end_run();
    let nav_last = res.net_value.last().expect("有净值序列").1;
    let sum_pnl: f64 = res
        .trades
        .iter()
        .map(|t| t.pnl.expect("Closed 回合必有 pnl"))
        .sum();
    assert_rel(
        nav_last,
        cfg.initial_capital + sum_pnl,
        "I3：nav[-1] == initial_capital + Σ pnl（期末强平场景）",
    );
}

// ---------------------------------------------------------------------------
// 期末强平：保有成交 + 终结最后一个回合（reason = ForceClose，ADR-027 D6/§3.4）
// ---------------------------------------------------------------------------

#[test]
fn p1b_force_close_terminates_last_round_trip() {
    let (_cfg, res) = hold_to_end_run();
    let f = fills(&res);
    let last_bar = res.net_value.len() - 1;
    // 净值序列自 bar0 起（warmup=0）⇒ 净值末点 == 最后一根 bar。
    assert_eq!(res.trades.len(), 1, "持有到期末 ⇒ 恰 1 个回合：{:?}", res.trades);

    let t = &res.trades[0];
    assert_eq!(t.status, backtest::RoundTripStatus::Closed, "期末强平 ⇒ Closed");
    assert_eq!(t.reason.as_deref(), Some("ForceClose"), "unclosed 回合由强平终结");
    assert_eq!(t.close_bar, Some(last_bar), "强平落在最后一根 bar");
    assert_eq!(t.open_bar, 1, "买入在 bar1 成交");
    assert_eq!(t.hold_bars, Some(last_bar - 1), "hold_bars = close_bar − open_bar");
    assert_eq!(t.l2_count, 2, "买 + 强平 = 2 笔（该回合全部成交进账本）");

    let force = f
        .iter()
        .find(|x| x.reason == OrderReason::ForceClose)
        .expect("强平成交事件必须存在");
    assert_eq!(force.side, OrderSide::Sell, "强平为卖出");
    assert_eq!(force.bar_index, last_bar, "强平 bar_index = 最后一根 bar");
    assert!(
        force.stamp_duty > 0.0,
        "强平卖出必须携带实算印花税（> 0），实得 {}",
        force.stamp_duty
    );
    assert_eq!(
        t.rt_seq, t.rt_seq.max(f[0].rt_seq),
        "回合 rt_seq 必须来自账本（非占位 0）"
    );
    assert!(f.iter().all(|x| x.rt_seq > 0), "全部成交必须已分配 rt_seq：{f:?}");
}

// ---------------------------------------------------------------------------
// 费用三件套：必须来自 `FeeModel::buy/sell` 实算结果（ADR-027 D4；禁费率复算）
// ---------------------------------------------------------------------------

#[test]
fn p1b_fill_events_carry_exec_fee_values() {
    let (_cfg, res) = partial_sell_run();
    let f = fills(&res);
    let fee = FeeModel::default();

    for x in &f {
        assert_eq!(
            x.trade_value.to_bits(),
            (x.qty * x.price).to_bits(),
            "trade_value 必须位级等于 qty × price（撮合点写入的事实值）：{x:?}"
        );
        match x.side {
            OrderSide::Buy => assert_eq!(x.stamp_duty, 0.0, "买入印花税恒 0：{x:?}"),
            OrderSide::Sell => assert!(
                x.stamp_duty > 0.0,
                "卖出必须携带实算印花税（> 0）：{x:?}"
            ),
        }
        // 费用事实值必须与 `FeeModel` 对该笔 trade_value 的实算一致
        // （本场景无最低佣金歧义：三笔 trade_value 均 > min_commission / 费率）。
        let proportional = x.trade_value * fee.commission_fraction() > fee.min_commission;
        if proportional {
            assert_eq!(
                x.commission.to_bits(),
                fee.commission(x.trade_value).to_bits(),
                "commission 必须为 FeeModel 实算结果（比例分支）：{x:?}"
            );
        } else {
            assert_eq!(
                x.commission, fee.min_commission,
                "最低佣金分支必须携带 min_commission 事实值：{x:?}"
            );
        }
    }

    // 反向守卫：部分卖出笔与清仓笔的金额**不同**（若引擎只按末笔造数，必与此不符）。
    let sells: Vec<_> = f.iter().filter(|x| x.side == OrderSide::Sell).collect();
    assert_eq!(sells.len(), 2, "两笔卖出：{f:?}");
    assert!(
        (sells[0].trade_value - sells[1].trade_value).abs() > 1.0,
        "两笔卖出金额必须各自独立（禁复用末笔）：{sells:?}"
    );
}

// ---------------------------------------------------------------------------
// 归属键：`rt_seq` 由 `assign_rt_seq` 语义分配（D6；per code 从 1 递增，持仓中的成交归当前回合）
// ---------------------------------------------------------------------------

#[test]
fn p1b_rt_seq_attribution_is_consistent_between_events_and_round_trips() {
    let (_cfg, res) = partial_sell_run();
    let f = fills(&res);
    let t = &res.trades[0];

    let mut seqs: Vec<u32> = f.iter().map(|x| x.rt_seq).collect();
    seqs.dedup();
    assert_eq!(
        seqs,
        vec![t.rt_seq],
        "买 / 部分卖 / 清仓三笔必须同属同一 rt_seq（持仓中的成交归当前回合）：{f:?}"
    );
    assert_eq!(t.rt_seq, 1, "该 run 只有一个回合 ⇒ rt_seq 从 1 起");

    let hold: Vec<u32> = f
        .iter()
        .filter(|x| x.reason == OrderReason::ForceClose)
        .map(|x| x.rt_seq)
        .collect();
    assert!(hold.is_empty(), "本场景期末空仓 ⇒ 无强平成交：{hold:?}");
}

#[test]
fn p1b_u6_i4_distinct_rt_seq_equals_round_trip_count() {
    // 多回合场景：Buy（bar1 成交）→ StopTrigger 强平 → 重新建仓 → 期末强平 ⇒ ≥2 个回合。
    let mut bars = price_bars(&[10.0, 10.0, 10.0, 10.0, 10.0, 10.0]);
    // bar2：open 10（买入成交）→ low 9.0 破线（avg_cost×(1−5%)≈9.5）→ 当 bar 止损平仓。
    bars[2].low = 9.0;
    bars[2].close = 9.6;
    let mut cfg = cfg(
        vec![slot(SCRIPT_ALWAYS_BUY, "sha256:p1b_multi_rt", 1.0)],
        ExecutionPolicy::LumpSum { position_pct: 0.5 },
        100_000.0,
    );
    cfg.stop = Some(strategy_core::StopConfig {
        kind: strategy_core::StopKind::FixedPct,
        value: 0.05,
        trigger: strategy_core::StopTrigger::Intrabar,
    });
    let res = run(&cfg, &bars);
    let f = fills(&res);

    assert!(res.trades.len() >= 2, "前置：应有多回合：{:?}", res.trades);
    let mut rt_seqs: Vec<u32> = res.trades.iter().map(|t| t.rt_seq).collect();
    rt_seqs.sort_unstable();
    rt_seqs.dedup();
    assert_eq!(
        rt_seqs.len(),
        res.trades.len(),
        "I4：distinct(rt_seq) == round_trips.len()：{:?}",
        res.trades
    );
    let expected: Vec<u32> = (1..=res.trades.len() as u32).collect();
    assert_eq!(rt_seqs, expected, "rt_seq 必须 per code 从 1 连续单调：{:?}", res.trades);

    let sum_l2: usize = res.trades.iter().map(|t| t.l2_count).sum();
    assert_eq!(sum_l2, f.len(), "Σ l2_count == 全部成交笔数");
    for x in &f {
        assert!(
            res.trades.iter().any(|t| t.rt_seq == x.rt_seq),
            "每笔成交的 rt_seq 必须能归属到某个回合：{x:?} / {:?}",
            res.trades
        );
    }
}

// ---------------------------------------------------------------------------
// 标的：`code` 必须为 run 的 symbol（L1 分组键，非占位空串）
// ---------------------------------------------------------------------------

#[test]
fn p1b_trade_code_is_run_symbol() {
    let (cfg, res) = partial_sell_run();
    assert!(!cfg.symbol.is_empty(), "配置必须携带 symbol");
    for t in &res.trades {
        assert_eq!(t.code, cfg.symbol, "TradeDetail.code == run symbol：{t:?}");
    }
}

// ---------------------------------------------------------------------------
// U7：持仓序列（与净值同点；02-spec §4.1）
// ---------------------------------------------------------------------------

#[test]
fn p1b_u7_position_series_is_synchronous_with_nav_and_self_consistent() {
    let (cfg, res) = partial_sell_run();
    assert!(
        !res.positions.is_empty(),
        "持仓序列必须与净值同点产出（非空）"
    );
    assert_eq!(
        res.positions.len(),
        res.net_value.len(),
        "持仓序列与净值序列必须逐点对齐（同压入点）"
    );

    for (i, (p, nv)) in res.positions.iter().zip(res.net_value.iter()).enumerate() {
        assert_eq!(p.ts, nv.0, "第 {i} 点 ts 必须与净值同点：{p:?} / {nv:?}");
        assert_rel(
            p.position_value + p.cash,
            nv.1,
            &format!("U7 第 {i} 点：position_value + cash == nav"),
        );
        assert_rel(p.nav, nv.1, &format!("U7 第 {i} 点：nav 与净值一致"));
        let exp_ratio = if p.nav <= 0.0 {
            0.0
        } else {
            p.position_value / p.nav
        };
        assert_rel(
            p.position_ratio,
            exp_ratio,
            &format!("U7 第 {i} 点：position_ratio == position_value/nav（nav≤0 ⇒ 0）"),
        );
        assert!(
            p.qty >= 0.0 && p.cash >= 0.0,
            "第 {i} 点 qty/cash 必须非负：{p:?}"
        );
    }

    // 期末强平 ⇒ 末点必须为空仓（position_value == 0，nav == cash），且为 run 的真实终值。
    let last = res.positions.last().expect("非空");
    assert_eq!(last.qty, 0.0, "期末强平后末点 qty == 0：{last:?}");
    assert_eq!(last.position_value, 0.0, "期末强平后末点持仓市值 == 0");
    assert_eq!(last.position_ratio, 0.0, "空仓 ⇒ position_ratio == 0");
    assert_rel(
        last.nav,
        cfg.initial_capital
            + res
                .trades
                .iter()
                .map(|t| t.pnl.expect("Closed 必 Some"))
                .sum::<f64>(),
        "末点 nav == 初始资金 + Σ pnl（已实现净值）",
    );

    // 持仓期至少有一点的 position_ratio > 0（否则该序列无信息量 = 假覆盖）。
    assert!(
        res.positions.iter().any(|p| p.position_ratio > 0.0),
        "持仓期必须存在 position_ratio > 0 的点：{:?}",
        res.positions
    );
}
