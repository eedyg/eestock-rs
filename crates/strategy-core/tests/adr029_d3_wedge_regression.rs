//! ADR-029 D3 修复（A 案：两处 clamp 收进同一「现金截断」门控）的**回归向量 + 不变量**测试。
//!
//! 背景与判据见 `tests/adr029_fixed_ratecap_ramp.rs`（架构侧 Red 交付物）与
//! `coder/report/*_d3_*.md`。本文件**不重复**该文件的 D3 复现断言，只负责三件事：
//!
//! 1. **旧行为保持**：`LumpSum` 被现金截断时，冻结目标**仍**被下调（`clamp_lump_frozen`
//!    的调用前提收紧，但 `LumpSum` 唯一的截断原因就是现金 ⇒ 行为必须逐字不变）；
//! 2. **口径不变**：`Exposure{ScoreMapped}` 的现金不可达下调（ADR-029 D6-6/R11/E17）读数不变；
//! 3. **不变量**：`Buy` 且**未触发限速**且「策略声明目标 − 当前 > 死区」⇒ 不得 `deadzone_blocked=true`，
//!    且必有订单增量（防同类「引擎侧外部改写策略目标 ⇒ 死区恒真 ⇒ 永久卡死」回归）。
//!
//! 纪律：确定性手工构造数据（固定价 bar + 仓内 fixture 插件），无 RNG / 无系统时间依赖。

use backtest::{Bar, FeeModel, ParamValue, Period, StrategyParams};
use strategy_core::{
    run_ensemble, EngineEvent, EnsembleConfig, ExecutionPolicy, ExposureTarget, GuardSpec,
    OrderReason, OrderSide, RampSpec, StrategySlot, TradeSignal,
};
use strategy_runtime::{QuickJsRuntime, RuntimeLimits};

const CONSTANT_SCORE: &str = include_str!("fixtures/constant_score.js");

const INITIAL_CAPITAL: f64 = 100_000.0;
/// D3 场景的 policy 目标比例（`ExposureTarget::Fixed{pct}`）。
const TARGET_PCT: f64 = 0.3;
/// D3 场景的限速（`RampSpec::RateCap{pct_per_bar}`）。
const PCT_PER_BAR: f64 = 0.05;
/// D3 场景的 `deadzone_pct`。
const DEADZONE_PCT: f64 = 0.005;
/// `Exposure{Fixed 30%}` 在 `equity = 100_000`、`price = 10` 下的冻结目标股数。
///
/// 冻结快照取自**首个 Buy bar**（净值仅因买入佣金/滑点而微降）⇒ 后续 bar 的冻结值
/// **不可能低于**该值 ⇒ 作为「策略声明目标」的**下界**用于不变量判定（保守方向正确：
/// 下界更小 ⇒ 更不容易误判 gap 超死区）。
const DECLARED_QTY_LOWER_BOUND: f64 = TARGET_PCT * INITIAL_CAPITAL / 10.0; // 3000 股

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

fn cfg_with(policy: ExecutionPolicy, score: f64) -> EnsembleConfig {
    EnsembleConfig {
        symbol: "TEST.SYMBOL".to_string(),
        slots: vec![StrategySlot::new(
            CONSTANT_SCORE,
            "sha256:constant_score",
            params(&[("score", score)]),
            1.0,
        )
        .expect("合法 slot")],
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

fn run(cfg: &EnsembleConfig, bars: &[Bar]) -> strategy_core::EnsembleResult {
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    run_ensemble(cfg, bars, &mut rt).expect("引擎运行成功")
}

/// 全部 `Policy` 买入成交 `(bar_index, qty)`。
fn policy_buy_fills(res: &strategy_core::EnsembleResult) -> Vec<(usize, f64)> {
    res.per_bar
        .iter()
        .flat_map(|r| r.events.iter())
        .filter_map(|e| match e {
            EngineEvent::Fill {
                bar_index,
                side,
                qty,
                reason,
                ..
            } if *side == OrderSide::Buy && *reason == OrderReason::Policy => Some((*bar_index, *qty)),
            _ => None,
        })
        .collect()
}

fn d3_policy(ramp: RampSpec) -> ExecutionPolicy {
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

// ---------------------------------------------------------------------------
// 回归向量 1：`LumpSum` 现金截断 ⇒ 冻结目标仍被下调（旧行为，A 案必须保持）
// ---------------------------------------------------------------------------

/// `LumpSum{position_pct: 1.0}` 令 `need > cash` ⇒ 成交被现金上限截断 ⇒ 引擎须把冻结目标
/// 下调到实得股数，使其后每 bar「目标 − 当前 = 0」而**不再重复挂微单**（ADR §13.1 MAJOR-1）。
///
/// 鉴别力：若两处 clamp 被整体删除（或 `clamp_lump_frozen` 被移除），冻结目标将停在
/// 10_000 股、实际持仓 ~9_992 股 ⇒ 其后每 bar 产生 ~7.5 股挂单（重复微单）⇒ 本用例变红。
#[test]
fn adr029_d3_lumpsum_cash_clip_still_lowers_frozen_target() {
    let price = 10.0;
    let bars = flat_bars(8, price);
    let cfg = cfg_with(ExecutionPolicy::LumpSum { position_pct: 1.0 }, 75.0);
    let res = run(&cfg, &bars);

    // ① 前置：bar 0 挂单意图 = 满仓目标（100_000 / 10 = 10_000 股），且本笔确被现金截断。
    let intent: f64 = res.per_bar[0]
        .orders
        .iter()
        .filter(|o| o.side == OrderSide::Buy && o.reason == OrderReason::Policy)
        .map(|o| o.qty)
        .sum();
    assert!(
        (intent - INITIAL_CAPITAL / price).abs() < 1e-9,
        "用例失效：bar 0 的 LumpSum 目标应为 {} 股，实为 {intent}",
        INITIAL_CAPITAL / price
    );
    let fills = policy_buy_fills(&res);
    assert_eq!(fills.len(), 1, "应只成交 1 笔 Policy 买入，实为 {fills:?}");
    let (fill_bar, filled_qty) = fills[0];
    assert!(
        filled_qty < intent - 1e-9,
        "用例失效：本笔买入未被现金截断（意图 {intent} / 实得 {filled_qty}）"
    );

    // ② 现金截断 ⇒ 冻结目标下调 ⇒ 其后逐 bar 不得再有 Policy 挂单（旧行为保持）。
    let later: Vec<usize> = res
        .per_bar
        .iter()
        .enumerate()
        .filter(|(i, r)| *i > fill_bar && !r.orders.is_empty())
        .map(|(i, _)| i)
        .collect();
    assert!(
        later.is_empty(),
        "现金截断后冻结目标须被下调（不得对不可达缺口每 bar 重复挂微单）；\
         实际有挂单的 bar：{later:?}，实得股数 {filled_qty}"
    );

    // ③ 观测读数：截断后「声明目标 ≡ 当前暴露」（冻结目标 = 实得）。
    for (i, r) in res.per_bar.iter().enumerate().skip(fill_bar + 1) {
        let t = r.policy_obs.target_pct.expect("target_pct 可读");
        let c = r.policy_obs.current_pct.expect("current_pct 可读");
        assert!(
            (t - c).abs() < 1e-12,
            "bar {i}：截断后目标须等于当前暴露（{t} vs {c}）"
        );
    }
    println!(
        "[D3-LumpSum] intent={intent:.6} filled={filled_qty:.6} fill_bar={fill_bar} \
         later_order_bars={later:?}"
    );
}

// ---------------------------------------------------------------------------
// 回归向量 2：`Exposure{ScoreMapped}` 现金不可达下调（E17 口径）行为不变
// ---------------------------------------------------------------------------

/// E17 场景（`ScoreMapped{1.0,1.0,Flat}` + Immediate + 死区 0，score=100 ⇒ 满仓 Buy）：
/// 买入被现金截断 ⇒ 目标下调到可达仓位（本变体下净值口径使其**结构性收敛**，
/// `affordability_capped` 不必然触发）⇒ 截断后**不得**重复挂微单。
///
/// 本用例是**差分基线**：A 案只收紧 `clamp_lump_frozen` 的调用前提，`clamp_exposure_affordable`
/// 的门控（`budget_limited || cash <= eps`）逐字未变 ⇒ 本用例读数在「门控前 / 门控后」两份
/// 构建上必须**逐字节相同**（差分证据见 `coder/evidence/20260925_d3_wedge_fix/`）。
#[test]
fn adr029_d3_scoremapped_cash_clip_reading_unchanged() {
    let bars = flat_bars(8, 10.0);
    let cfg = cfg_with(
        ExecutionPolicy::Exposure {
            target: ExposureTarget::ScoreMapped {
                at_threshold_pct: 1.0,
                at_full_pct: 1.0,
                sell: strategy_core::SellPolicy::Flat,
            },
            ramp: RampSpec::Immediate,
            guard: GuardSpec {
                max_pct: 1.0,
                min_pct: 0.0,
                deadzone_pct: 0.0, // 死区 0：隔离 affordability 机制（不靠死区消单）
                deadzone_min_notional: None,
            },
        },
        100.0,
    );
    let res = run(&cfg, &bars);

    // ① 截断确实发生：决策 bar 的 Policy 买入意图 > 次 bar 实际成交股数。
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
                        EngineEvent::Fill {
                            side,
                            qty,
                            reason,
                            ..
                        } if *side == OrderSide::Buy && *reason == OrderReason::Policy => Some(*qty),
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

    // ② 截断后逐 bar：不得有 Policy 挂单。
    let later_orders: Vec<usize> = res
        .per_bar
        .iter()
        .enumerate()
        .filter(|(i, r)| *i > clip_bar && !r.orders.is_empty())
        .map(|(i, _)| i)
        .collect();
    assert!(
        later_orders.is_empty(),
        "ScoreMapped 截断后不得重复挂微单（实际挂单 bar：{later_orders:?}）"
    );

    // ③ 条件式：凡披露 `affordability_capped`，目标必被夹到当前可达暴露。
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
    println!(
        "[D3-ScoreMapped] clip_bar={clip_bar} capped_bars={capped:?} \
         gaps={:?}",
        res.per_bar
            .iter()
            .map(|r| (r.policy_obs.target_pct.expect("t"), r.policy_obs.current_pct.expect("c")))
            .collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// 不变量：未限速 + 距（策略声明的）目标仍远 ⇒ 不得死区拦单、必有订单增量
// ---------------------------------------------------------------------------

/// **同类回归防线**（A 案修复的靶心）：`Buy` 且**未触发限速**且「策略声明目标 − 当前折算金额 > 死区」
/// 时，引擎**不得**输出 `deadzone_blocked=true`，且必须产生买入订单增量。
///
/// 为何用「策略声明目标下界」而非观测到的 `target_pct`：卡死态的**病灶**正是「引擎把声明目标
/// 外部改写成当前持仓」⇒ 若以观测目标为参照，不变量在病灶上恒真（空转）而失去鉴别力。
/// 这里用 policy 配置可独立算出的冻结目标下界（`Fixed 30%` ⇒ ≥ 3000 股）作参照。
///
/// 鉴别力：门控被去掉（旧码：任何 Policy 买单成交后无条件 `clamp_lump_frozen`）时，
/// bar 1 处 `rate_limited=false`、当前暴露 ≈ 5%、距声明目标 2500 股（≈25000 元 ≫ 死区 500 元），
/// 却 `deadzone_blocked=true` 且无订单 ⇒ 本用例变红。
#[test]
fn adr029_d3_invariant_no_deadzone_block_while_far_below_declared_target() {
    let price = 10.0;
    let bars = flat_bars(12, price);
    let cfg = cfg_with(d3_policy(RampSpec::RateCap { pct_per_bar: PCT_PER_BAR, down_pct_per_bar: None, on_signal_break: None }), 75.0);
    let res = run(&cfg, &bars);

    let mut rows = String::from(
        "bar | rate_limited | deadzone_blocked | current_qty | declared_gap_value | deadzone_value | orders\n",
    );
    let mut violations: Vec<String> = Vec::new();
    for (i, r) in res.per_bar.iter().enumerate() {
        let o = r.policy_obs;
        let equity = res.net_value[i].1;
        let current_qty = o.current_pct.expect("current_pct") * equity / price;
        let gap_value = (DECLARED_QTY_LOWER_BOUND - current_qty) * price;
        let deadzone_value = DEADZONE_PCT * equity;
        rows.push_str(&format!(
            "{i:>3} | {:>12} | {:>16} | {:>11.4} | {:>18.4} | {:>14.4} | {}\n",
            o.rate_limited,
            o.deadzone_blocked,
            current_qty,
            gap_value,
            deadzone_value,
            r.orders.len()
        ));
        if o.rate_limited {
            continue; // 限速期间不判定死区（限速本身负责节奏）
        }
        if gap_value <= deadzone_value {
            continue; // 未超出死区 ⇒ 死区拦单合法
        }
        if o.deadzone_blocked {
            violations.push(format!(
                "bar {i}: 未限速且距声明目标 {gap_value:.4} 元（> 死区 {deadzone_value:.4}）却 deadzone_blocked=true"
            ));
        }
        if r.orders.is_empty() {
            violations.push(format!(
                "bar {i}: 未限速且距声明目标 {gap_value:.4} 元却无订单增量（目标被外部改写？）"
            ));
        }
    }
    println!("\n=== [D3 不变量] Fixed 0.3 + RateCap 0.05（声明目标下界 {DECLARED_QTY_LOWER_BOUND:.1} 股）===\n{rows}");
    assert!(violations.is_empty(), "不变量违例：\n{}\n{rows}", violations.join("\n"));
}

// ---------------------------------------------------------------------------
// D3 修复的引擎级完成判据（**含 T+1 成交滞后**口径）
// ---------------------------------------------------------------------------

/// `Fixed{0.3} + RateCap{0.05}` + 信号恒 Buy ⇒ 「每 bar 5%」逐 bar 建仓，
/// **第 6 根 bar 声明目标达 30%**（限速不得改写目标），持仓（T+1 成交 ⇒ 滞后一根 bar）在第 7 根观测达 30%。
///
/// 与 `tests/adr029_fixed_ratecap_ramp.rs` 的 [A] 用例同场景；此处按**成交时序**（挂单 bar `i` →
/// 次 bar open 成交、`current_pct` 读的是本 bar 决策时点持仓）分别钉住「目标」与「持仓」两个读数，
/// 避免把 T+1 滞后误判为「未达目标」。
#[test]
fn adr029_d3_fixed_ratecap_ramp_target_and_exposure_reach_thirty_pct() {
    let bars = flat_bars(12, 10.0);
    let cfg = cfg_with(d3_policy(RampSpec::RateCap { pct_per_bar: PCT_PER_BAR, down_pct_per_bar: None, on_signal_break: None }), 75.0);
    let res = run(&cfg, &bars);

    let tgt: Vec<f64> = res.per_bar.iter().map(|r| r.policy_obs.target_pct.expect("t")).collect();
    let cur: Vec<f64> = res.per_bar.iter().map(|r| r.policy_obs.current_pct.expect("c")).collect();
    let fills = policy_buy_fills(&res);
    let table: String = (0..res.per_bar.len())
        .map(|i| {
            format!(
                "bar {i:>2} | target {:.6} | current {:.6} | rate_limited {} | deadzone_blocked {}\n",
                tgt[i],
                cur[i],
                res.per_bar[i].policy_obs.rate_limited,
                res.per_bar[i].policy_obs.deadzone_blocked
            )
        })
        .collect();

    // ① 单调不减（限速只允许靠近，不允许回退）
    for i in 1..cur.len() {
        assert!(cur[i] >= cur[i - 1] - 1e-9, "bar {i}：暴露回退\n{table}");
    }
    // ② 第 6 根 bar（idx 5）声明目标已达 30%：限速不得把目标改写成 5%
    assert!(
        tgt[5] >= TARGET_PCT - 5e-3,
        "idx 5 声明目标仅 {:.6}，未达 {TARGET_PCT}\n{table}",
        tgt[5]
    );
    // ③ 第 7 根 bar（idx 6）持仓达 30%：T+1 成交 ⇒ 比目标声明滞后一根 bar
    assert!(
        cur[6] >= TARGET_PCT - 5e-3,
        "idx 6 持仓仅 {:.6}，未达 {TARGET_PCT}（T+1 滞后下应在 idx 6 到位）\n{table}",
        cur[6]
    );
    // ④ 限速期逐 bar 一笔（不得停在首笔）：ramp 6 根 ⇒ ≥ 6 笔 Policy 买入成交
    assert!(
        fills.len() >= 6,
        "限速 ramp 期间 Policy 买入成交仅 {} 笔（应 ≥ 6）：{fills:?}\n{table}",
        fills.len()
    );
    // ⑤ 全程信号恒 Buy（场景前提）
    for (i, r) in res.per_bar.iter().enumerate() {
        assert_eq!(r.signal, TradeSignal::Buy, "bar {i} 信号应恒为 Buy");
    }
    println!("\n=== [D3 完成判据] fills={fills:?} ===\n{table}");
}
