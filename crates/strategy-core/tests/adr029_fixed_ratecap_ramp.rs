//! ADR-029 缺陷复现（**只取证，不修**）：`Exposure{Fixed} + Ramp{RateCap}` 被
//! 引擎侧 `clamp_lump_frozen` 拉平 ⇒ 「只成交一次」永久卡死（ratecap wedge）。
//!
//! 背景（活库 run `sr_1790346535264_000006`，symbol 518880 / D1）：
//! `Exposure{Fixed 0.3} + RateCap{pct_per_bar: 0.05} + guard{max 0.9, min 0, deadzone 0.005}`、
//! 信号恒 Buy（aggregate=75，阈值 60/40）⇒ 应然「每 bar +5%，6 根内建到 30%」；
//! 实测 428 bar 里只有 **1** 条 `rate_limited=true`（idx 250）、其后 177 条
//! `deadzone_blocked=true` 且 `target_pct ≡ current_pct`，`trades` 仅 1 个回合 ⇒ 目标 30% 永不达成。
//!
//! 契约基线（ADR-029 D5 七步 pipeline，`crates/strategy-core/src/policy.rs:544 exposure_outcome`）：
//! ⑤ 限速 = 「本 bar 目标股数增量所折算金额 ≤ `pct_per_bar × equity`」，且**不得越过目标**；
//! 限速只决定「靠近速率」，不得反过来改写目标（`RateCap` 语义为逐 bar 推进，非一次性夹到 5%）。
//!
//! 本文件是本任务的 **Red 交付物**：它按当前产品代码断言应然行为，预期失败。
//! 断言**不**为迁就现状调整。

use backtest::{Bar, FeeModel, ParamValue, Period, StrategyParams};
use strategy_core::{
    run_ensemble, EnsembleConfig, ExecutionPolicy, ExposureTarget, GuardSpec, PolicyObservation,
    PolicyState, RampSpec, StrategySlot, TradeSignal,
};
use strategy_runtime::{QuickJsRuntime, RuntimeLimits};

const CONSTANT_SCORE: &str = include_str!("fixtures/constant_score.js");

const INITIAL_CAPITAL: f64 = 100_000.0;
/// run 配置的目标比例（`ExposureTarget::Fixed{pct}`）。
const TARGET_PCT: f64 = 0.3;
/// run 配置的限速（`RampSpec::RateCap{pct_per_bar}`）。
const PCT_PER_BAR: f64 = 0.05;
/// 建到目标所需 bar 数（0.3 / 0.05 = 6）。
const BARS_TO_TARGET: usize = 6;
/// `deadzone_pct`（同 run 的 guard）。
const DEADZONE_PCT: f64 = 0.005;
/// 「远未达成」判据：当前暴露 < 目标 − 一个步长。
const FAR_BELOW_TARGET: f64 = TARGET_PCT - PCT_PER_BAR;

// ---------------------------------------------------------------------------
// 测试辅助（与 `tests/engine.rs` 同形，镜像而为，避免跨测试文件依赖）
// ---------------------------------------------------------------------------

fn params(pairs: &[(&str, f64)]) -> StrategyParams {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), ParamValue::Num(*v)))
        .collect()
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

/// 单 slot 恒分（score=75 ⇒ Buy 档；阈值 60/40，与活库 run 的 `aggregate=75` 同档）。
fn buy_cfg(policy: ExecutionPolicy) -> EnsembleConfig {
    EnsembleConfig {
        symbol: "TEST.SYMBOL".to_string(),
        slots: vec![
            StrategySlot::new(
                CONSTANT_SCORE,
                "sha256:constant_score",
                params(&[("score", 75.0)]),
                1.0,
            )
            .expect("合法 slot"),
        ],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy,
        stop: None,
        initial_capital: INITIAL_CAPITAL,
        fee: FeeModel::default(),
        period: Period::D1,
        warmup_bars: 0,
        runtime_limits: RuntimeLimits::default(),
    }
}

/// run 的 policy（活库 `config.policy` 的等价构造）。
fn run_policy(ramp: RampSpec) -> ExecutionPolicy {
    ExecutionPolicy::Exposure {
        target: ExposureTarget::Fixed { pct: TARGET_PCT },
        ramp,
        guard: GuardSpec {
            max_pct: 0.9,
            min_pct: 0.0,
            deadzone_pct: DEADZONE_PCT,
            deadzone_min_notional: None,
        },
    }
}

fn run(cfg: &EnsembleConfig, bars: &[Bar]) -> strategy_core::EnsembleResult {
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    run_ensemble(cfg, bars, &mut rt).expect("引擎运行成功")
}

/// 逐 bar 观测表（`--nocapture` 时可见；测试失败时作为原始证据）。
fn dump(per_bar: &[strategy_core::BarRecord]) -> String {
    let mut s = String::from(
        "bar | signal  | aggregate | target_pct | current_pct | rate_limited | deadzone_blocked | orders\n",
    );
    for (i, r) in per_bar.iter().enumerate() {
        let o: PolicyObservation = r.policy_obs;
        s.push_str(&format!(
            "{i:>3} | {:?} | {:>9.4} | {:>10} | {:>11} | {:>12} | {:>16} | {}\n",
            r.signal,
            r.aggregate,
            fmt(o.target_pct),
            fmt(o.current_pct),
            o.rate_limited,
            o.deadzone_blocked,
            r.orders.len(),
        ));
    }
    s
}

fn fmt(v: Option<f64>) -> String {
    match v {
        Some(x) => format!("{x:.6}"),
        None => "None".to_string(),
    }
}

// ---------------------------------------------------------------------------
// 交付物 A（Red）：引擎级契约测试 —— `Fixed 30% + RateCap 5%/bar` 必须在 6 根 bar 内建到 30%
// ---------------------------------------------------------------------------

/// 应然：`Fixed{0.3} + RateCap{0.05}` + 信号恒 Buy ⇒ 单调递增、第 6 根 bar 目标 ≥ 30%，
/// 且「目标远未达成」期间**不得** `deadzone_blocked=true`。
///
/// 实然（当前产品代码）：第 1 根被限速到 5% 后引擎 `clamp_lump_frozen` 把冻结目标
/// （≈3000 股 = 30%）下调为实得（500 股 = 5%）⇒ 其后每 bar `desired == current`
/// ⇒ 死区恒真 ⇒ 输出目标 ≡ 当前持仓 ⇒ 订单增量 0 ⇒ 永久停在 5%。
#[test]
fn fixed_ratecap_ramp_reaches_target_within_six_bars() {
    let bars = flat_bars(12, 10.0);
    let cfg = buy_cfg(run_policy(RampSpec::RateCap {
        pct_per_bar: PCT_PER_BAR,
        down_pct_per_bar: None,
        on_signal_break: None,
    }));
    let res = run(&cfg, &bars);
    let table = dump(&res.per_bar);
    println!("\n=== [A] 引擎级：Fixed 0.3 + RateCap 0.05（应然 6 根到 30%）===\n{table}");

    // 明细：逐根暴露占比（引擎实测持仓占比，非目标声明）。
    let cur: Vec<f64> = res
        .per_bar
        .iter()
        .map(|r| r.policy_obs.current_pct.expect("current_pct 可读"))
        .collect();
    let tgt: Vec<f64> = res
        .per_bar
        .iter()
        .map(|r| r.policy_obs.target_pct.expect("target_pct 可读"))
        .collect();

    // (1) 单调不减：限速只允许「靠近」，不允许回退。
    for i in 1..cur.len() {
        assert!(
            cur[i] >= cur[i - 1] - 1e-9,
            "bar {i}：暴露回退（{:.6} < 前值 {:.6}）\n{table}",
            cur[i],
            cur[i - 1]
        );
    }

    // (2) 目标远未达成期间不得死区拦单（死区语义 = 「已到位后的静默」，不是「限速后的刹车」）。
    for (i, r) in res.per_bar.iter().enumerate() {
        let o = r.policy_obs;
        let c = o.current_pct.expect("current_pct 可读");
        assert!(
            !(o.deadzone_blocked && c < FAR_BELOW_TARGET),
            "bar {i}：当前暴露 {c:.6} 仍远低于目标 {TARGET_PCT}（< {}）却 deadzone_blocked=true\n{table}",
            FAR_BELOW_TARGET
        );
    }

    // (3) 6 根 bar 内目标必须到达 30%（限速 5%/bar ⇒ 6 根足额；允许佣金级 eps）。
    //
    // **读数口径拆分（T+1 成交滞后；2026-09-25 架构侧裁定「修正作者错误」，容差 5e-3 不变）**：
    // 决策发生在**本 bar 收盘**、成交在**次 bar 开盘**（ADR §6/§13.3；`engine.rs` step 第 1 步先撮合
    // 上一 bar 挂单）⇒ 第 i 根 bar 观测到的 `current_pct` 只含**第 0..i−1 根**决策的成交。
    // 因此「6 根到 30%」必须分两个读数断言，不得用同一 idx 同时表示「声明目标」与「持仓」：
    //   * idx 5（第 6 根 bar）**声明目标**已达 30%——限速不得改写目标；
    //   * idx 6（第 7 根 bar）**持仓**达 30%——第 6 笔成交发生在 idx 6 的开盘。
    let idx = BARS_TO_TARGET - 1;
    assert!(
        tgt[idx] >= TARGET_PCT - 5e-3,
        "第 {BARS_TO_TARGET} 根 bar（idx {idx}）声明目标仅 {:.6}，未达 {TARGET_PCT}（限速不得改写目标）\n{table}",
        tgt[idx]
    );
    let idx_settled = idx + 1;
    assert!(
        cur[idx_settled] >= TARGET_PCT - 5e-3,
        "idx {idx_settled}（第 {} 根 bar，含 T+1 成交滞后）持仓仅 {:.6}，未达目标 {TARGET_PCT}（−5e-3）\n{table}",
        idx_settled + 1,
        cur[idx_settled]
    );

    // (4) 成交次数：应然为「每 bar 一笔、共 6 笔」；实然应为 1 笔（只成交一次）。
    let policy_buys = res
        .per_bar
        .iter()
        .flat_map(|r| r.events.iter())
        .count();
    assert!(
        policy_buys >= BARS_TO_TARGET,
        "限速 ramp 期间成交事件仅 {policy_buys} 个（应 ≥ {BARS_TO_TARGET}：限速按逐 bar 增量建仓）\n{table}"
    );
}

// ---------------------------------------------------------------------------
// 交付物 B：机制链的**可执行**反证 —— 同一 state、同一 API，两种「调用序」结果不同
// ---------------------------------------------------------------------------

/// 反证：**纯 policy pipeline**（不经过引擎、不做任何 post-fill 钳制）在同一 policy 下
/// 逐 bar 推进 5%，第 6 根到达 30%。
///
/// 该测试证明：卡死**不是** pipeline ⑤ 限速本身的语义（限速不会把目标改写成 5%），
/// 而是引擎在**部分成交后**调用了 `PolicyState::clamp_lump_frozen(h.qty)`（`policy.rs:426`，
/// 只降不升、无「是否被现金截断」门控）把冻结目标从 30% 降到实得 5% 所致。
///
/// 关键对照（同一 state，逐位可复现）：
/// * 引擎第 1 根 live bar 结束时：`current_qty ≈ 500 股（5%）`、`last_target_qty ≈ 500`；
///   引擎第 2 根输出 `target_pct == current_pct == 5%`（[A] 的表）；
/// * 本测试把**完全相同的 state**（`current_qty = 500`、上一目标 = 500）喂给同一个公开 API
///   `PolicyState::target_qty_with_score` ⇒ 输出为 **10%**（限速 +5%）。
/// 二者状态相同而输出不同 ⇒ 状态在两根 bar 之间被引擎侧**外部改写**（冻结目标下调）。
#[test]
fn pure_policy_pipeline_ramps_five_pct_per_bar_to_target() {
    let policy = run_policy(RampSpec::RateCap {
        pct_per_bar: PCT_PER_BAR,
        down_pct_per_bar: None,
        on_signal_break: None,
    });
    let equity = INITIAL_CAPITAL;
    let price = 10.0;

    let mut st = PolicyState::new();
    let mut current = 0.0f64;
    let mut rows = String::from("bar | target_qty | target_pct | current_qty | rate_limited | deadzone_blocked\n");

    for i in 0..BARS_TO_TARGET {
        let out = st.target_qty_with_score(
            &policy,
            TradeSignal::Buy, // 信号恒 Buy（score 75 ≥ 阈值 60）
            75.0,             // 聚合分（与活库 run 一致）
            60.0,
            40.0,
            equity,
            price,
            current,
        );
        let pct = out.observation.target_pct.expect("target_pct");
        rows.push_str(&format!(
            "{i:>3} | {:>10.2} | {:>10.6} | {:>11.2} | {:>12} | {:>16}\n",
            out.target_qty, pct, current, out.observation.rate_limited, out.observation.deadzone_blocked
        ));
        // 模拟「成交足额」：当前持仓 = 本 bar 输出的目标（无限速截断 ⇒ 无外部钳制介入）。
        current = out.target_qty;
    }
    println!("\n=== [B] 纯 policy pipeline（同 policy，无引擎 post-fill 钳制）===\n{rows}");

    let expected = (BARS_TO_TARGET as f64 * PCT_PER_BAR) * equity / price; // 6 × 5% = 30% ⇒ 3000 股
    assert!(
        (current - expected).abs() < 1e-6,
        "纯 pipeline 第 {BARS_TO_TARGET} 根应达 {expected} 股（30%），实为 {current}\n{rows}"
    );

    // 机制链环 1 的**数值证据**（公开 API 读取，不碰产品代码）：
    // * desired_qty（限速前的目标）= 同 policy 用 `Immediate` 求值 ⇒ `Fixed 30%` 的未截断目标；
    // * cap_qty（本 bar 限速额度）= `pct_per_bar × equity / price`；
    // * ramped_qty（⑤ 输出）= 锚点 + clamp(desired − 锚点, ±cap)。
    let mut st_desired = PolicyState::new();
    let desired = st_desired.target_qty_with_score(
        &run_policy(RampSpec::Immediate),
        TradeSignal::Buy,
        75.0,
        60.0,
        40.0,
        equity,
        price,
        0.0,
    );
    let mut st_ramped = PolicyState::new();
    let ramped = st_ramped.target_qty_with_score(
        &policy, TradeSignal::Buy, 75.0, 60.0, 40.0, equity, price, 0.0,
    );
    let cap_qty = PCT_PER_BAR * equity / price;
    println!(
        "\n=== [B0] 环1 数值（equity={equity}, price={price}）===\n\
         desired_qty(未限速, Fixed 30%) = {:.6}\n\
         cap_qty(每 bar 限速额度)        = {:.6}\n\
         ramped_qty(⑤ 输出 = 锚点+step)  = {:.6}  (rate_limited={})\n\
         锚点(anchor, 空仓)             = 0",
        desired.target_qty, cap_qty, ramped.target_qty, ramped.observation.rate_limited
    );
    assert!((desired.target_qty - TARGET_PCT * equity / price).abs() < 1e-9);
    assert!((cap_qty - (PCT_PER_BAR * equity / price)).abs() < 1e-9);
    assert!((ramped.target_qty - cap_qty).abs() < 1e-9);

    // 对照：**同一 state**（current=500 股 = 5%、上一目标 = 500）⇒ pipeline 输出 1000 股（10%），
    // 而引擎在同一状态下输出 500 股（见 [A] 表 bar 1）⇒ 差异只能来自引擎侧冻结目标下调。
    let mut st2 = PolicyState::new();
    let first = st2.target_qty_with_score(
        &policy, TradeSignal::Buy, 75.0, 60.0, 40.0, equity, price, 0.0,
    );
    let step_qty = (PCT_PER_BAR * equity / price) as f64;
    assert!(
        (first.target_qty - step_qty).abs() < 1e-9,
        "第 1 根 bar 应被限速到 {step_qty} 股（5%），实为 {}",
        first.target_qty
    );
    assert!(
        first.observation.rate_limited,
        "第 1 根 bar 须披露 rate_limited（限速生效）"
    );
    let second = st2.target_qty_with_score(
        &policy,
        TradeSignal::Buy,
        75.0,
        60.0,
        40.0,
        equity,
        price,
        first.target_qty, // current = 5%（= 引擎实测第 1 根结束时的持仓）
    );
    assert!(
        (second.target_qty - 2.0 * step_qty).abs() < 1e-9,
        "第 2 根 bar 在 current=5%、上一目标=5% 时应输出 10%（{} 股），实为 {} ⇒ \
         纯 pipeline 不会停在 5%（卡死必由引擎侧状态改写造成）",
        2.0 * step_qty,
        second.target_qty
    );
    assert!(!second.observation.deadzone_blocked, "远未达成 ⇒ 不得死区拦单");
}
