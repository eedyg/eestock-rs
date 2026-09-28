//! ADR-029 Step 1.5（Lane A/E）判据测试：**E18 / E19 / E20 / E21 / E23（core 部分）/ E25**。
//!
//! 判据口径 = `design/12-strategy-system/06-plan-exposure-step1_5.md` §4 + ADR-029 §8.1；
//! 契约唯一出口 = 06-plan §2（pipeline P1–P8、`RampSpec::RateCap` 两个新字段、
//! `GuardSpec::deadzone_min_notional`、`PolicyObservation::intent_pct`/`down_ramp_cap_pct_per_bar`）。
//!
//! **E19④「缺省（无新字段）⇒ 订单序列与现行逐字节一致」在 `adr029_step1_5_golden.rs`**
//! （引擎级特征化基线，改动前先绿）——本文件覆盖逐 bar 的语义判据。
//!
//! 口径说明：本文件的均以 `PolicyState::target_qty_with_score` 求值，
//! `cur := 上一 bar 输出目标`（假定成交到位）——与既有 `policy.rs` 单测（E1–E17）同形，隔离引擎侧成交细节。

use strategy_core::{
    classify, ExposureTarget, ExecutionPolicy, GuardSpec, OnSignalBreak, PolicyObservation,
    PolicyState, RampSpec, SellPolicy,
};

const BUY_T: f64 = 60.0;
const SELL_T: f64 = 40.0;

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "expected {b}, got {a}");
}

/// 固定阈值求值：返回（输出目标股数，观测）。
fn eval(
    st: &mut PolicyState,
    p: &ExecutionPolicy,
    score: f64,
    equity: f64,
    price: f64,
    current_qty: f64,
) -> (f64, PolicyObservation) {
    let signal = classify(score, BUY_T, SELL_T);
    let out = st.target_qty_with_score(p, signal, score, BUY_T, SELL_T, equity, price, current_qty);
    (out.target_qty, out.observation)
}

fn guard4(max_pct: f64, min_pct: f64, deadzone_pct: f64, min_notional: Option<f64>) -> GuardSpec {
    GuardSpec { max_pct, min_pct, deadzone_pct, deadzone_min_notional: min_notional }
}

fn mapped(at_threshold_pct: f64, at_full_pct: f64, sell: SellPolicy) -> ExposureTarget {
    ExposureTarget::ScoreMapped { at_threshold_pct, at_full_pct, sell }
}

fn rate_cap(
    pct_per_bar: f64,
    down_pct_per_bar: Option<f64>,
    on_signal_break: Option<OnSignalBreak>,
) -> RampSpec {
    RampSpec::RateCap { pct_per_bar, down_pct_per_bar, on_signal_break }
}

fn exposure(target: ExposureTarget, ramp: RampSpec, guard: GuardSpec) -> ExecutionPolicy {
    ExecutionPolicy::Exposure { target, ramp, guard }
}

// ===========================================================================
// E18：非对称速率（上行 `pct_per_bar` / 下行 `down_pct_per_bar`；逐 bar 金额 + 不越过 desired）
// ===========================================================================

/// E18①：双向预算**互相独立**——上行按 `pct_per_bar`（5% 净值 = 500 股/bar），
/// 下行按 `down_pct_per_bar`（20% 净值 = 2000 股/bar）；逐 bar 折算金额断言 + 不越过 desired。
#[test]
fn e18_1_up_and_down_budgets_are_independent() {
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        rate_cap(0.05, Some(0.2), None),
        guard4(1.0, 0.0, 0.0, None),
    );
    p.validate().expect("非对称速率配置须合法");
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    let mut prev = 0.0f64;
    // 上行：desired = 8000 股；每 bar ≤ 500 股（5% 净值），16 根到达，且不得越过 8000。
    for bar in 0..16 {
        let (t, o) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        assert!(t <= 8_000.0 + 1e-9, "上行 bar {bar}：越过 desired（{t}）");
        let step_value = (t - prev).abs() * 10.0;
        assert!(
            step_value <= 0.05 * 100_000.0 + 1e-6,
            "上行 bar {bar}：折算金额 {step_value} 超过上行预算 5000 元"
        );
        assert_eq!(o.down_ramp_cap_pct_per_bar, Some(0.2), "下行预算占比须披露");
        assert_eq!(o.ramp_cap_pct_per_bar, Some(0.05));
        prev = t;
        cur = t;
    }
    close(prev, 8_000.0);

    // 下行：desired = 0；每 bar ≤ 2000 股（20% 净值），4 根清完（若误用上行预算需 16 根）。
    for bar in 0..4 {
        let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
        assert!(t >= -1e-9, "下行 bar {bar}：越过 desired（{t}）");
        let step_value = (prev - t).abs() * 10.0;
        assert!(
            step_value <= 0.2 * 100_000.0 + 1e-6,
            "下行 bar {bar}：折算金额 {step_value} 超过下行预算 20000 元"
        );
        assert!(o.rate_limited == (t > 1e-9), "bar {bar}：受限标记须与实际一致");
        prev = t;
        cur = t;
    }
    close(prev, 0.0);
    close(cur, 0.0);
}

/// E18②：`down_pct_per_bar = 0` ⇒ **下行无预算**（单 bar 直达 desired，仍不得越过 desired）。
#[test]
fn e18_2_zero_down_budget_reaches_desired_in_one_bar() {
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        rate_cap(0.05, Some(0.0), None),
        guard4(1.0, 0.0, 0.0, None),
    );
    p.validate().expect("down_pct_per_bar = 0 须合法（= 下行不限速）");
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    for _ in 0..16 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 8_000.0);
    // 单 bar 直达 0（不越界：目标 == desired）
    let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
    assert_eq!(t.to_bits(), 0.0f64.to_bits(), "down=0 ⇒ 本 bar 直达 desired（0）");
    assert!(!o.rate_limited, "down=0 ⇒ 未受限");
    assert_eq!(o.down_ramp_cap_pct_per_bar, Some(0.0), "下行预算占比披露 = 配置值 0");
    // 上行仍受限（不得越过 desired、不得一次到位）
    let (t_up, o_up) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 0.0);
    close(t_up, 500.0);
    assert!(o_up.rate_limited);
}

/// E18③：`down_pct_per_bar = None` ⇒ 对称（= `pct_per_bar`，逐 bar 金额与上行同预算）。
#[test]
fn e18_3_missing_down_budget_is_symmetric() {
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        rate_cap(0.05, None, None),
        guard4(1.0, 0.0, 0.0, None),
    );
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    for _ in 0..16 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 8_000.0);
    let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
    close(t, 7_500.0);
    assert!(o.rate_limited, "缺省下行预算 = 对称 ⇒ 下行同样受限");
    assert_eq!(o.down_ramp_cap_pct_per_bar, Some(0.05), "缺省 ⇒ 披露 pct_per_bar");
    // 16 根清完（对称预算）
    let mut cur = t;
    for _ in 0..15 {
        let (t, _) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 0.0);
}

/// E18④：下行预算**小于**上行时同样独立生效（防「误取 max/反向」）。
#[test]
fn e18_4_down_budget_smaller_than_up_is_honoured() {
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        rate_cap(0.05, Some(0.01), None),
        guard4(1.0, 0.0, 0.0, None),
    );
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    for _ in 0..16 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 8_000.0);
    let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
    close(t, 7_900.0); // 下行预算 1% 净值 = 100 元 = 10 股
    assert!(o.rate_limited);
    assert_eq!(o.down_ramp_cap_pct_per_bar, Some(0.01));
}

/// E18⑤（validate fail loud）：`down_pct_per_bar` 必须 ≥ 0 且有限。
#[test]
fn e18_5_validate_rejects_negative_or_non_finite_down_budget() {
    for bad in [-0.01, -1.0, f64::NAN, f64::INFINITY] {
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            rate_cap(0.05, Some(bad), None),
            guard4(1.0, 0.0, 0.0, None),
        );
        let err = p.validate().expect_err(&format!("down_pct_per_bar = {bad} 必须拒绝"));
        assert!(err.contains("down_pct_per_bar"), "错误须点名字段：{err}");
    }
    // 0 合法（= 下行不限速）
    exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        rate_cap(0.05, Some(0.0), None),
        guard4(1.0, 0.0, 0.0, None),
    )
    .validate()
    .expect("down_pct_per_bar = 0 合法");
}

// ===========================================================================
// E19：意图一等公民 + `on_signal_break` 四态
// ===========================================================================

/// E19①：`intent_pct` 三态（Buy 线性映射 / Sell 降档 / Hold 沿用上一非 Hold bar）；
/// 首 bar 即 Hold ⇒ 意图 = 当前持仓占比 + 零订单。
#[test]
fn e19_1_intent_pct_three_states() {
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Scaled),
        rate_cap(0.05, None, None),
        guard4(0.9, 0.0, 0.005, None),
    );
    let mut st = PolicyState::new();
    // Buy（score 80）：0.2 + (80−60)/(100−60) × (0.5−0.2) = 0.35
    let (_, o_buy) = eval(&mut st, &p, 80.0, 100_000.0, 10.0, 0.0);
    close(o_buy.intent_pct.expect("intent_pct 可读"), 0.35);
    // Sell（score 30，Scaled）：0.2 × 30/40 = 0.15
    let (_, o_sell) = eval(&mut st, &p, 30.0, 100_000.0, 10.0, 0.0);
    close(o_sell.intent_pct.expect("intent_pct 可读"), 0.15);
    // Hold（score 50）：沿用上一**非 Hold bar** 的意图（0.15），不因净值/价格重算
    for (eq, px) in [(100_000.0, 10.0), (120_000.0, 12.0), (80_000.0, 8.0)] {
        let (_, o) = eval(&mut st, &p, 50.0, eq, px, 1_500.0);
        close(o.intent_pct.expect("intent_pct 可读"), 0.15);
    }
    // 首 bar 即 Hold（无上一意图）⇒ 意图 = 当前持仓占比 ⇒ 零订单
    let mut fresh = PolicyState::new();
    let (t, o) = eval(&mut fresh, &p, 50.0, 100_000.0, 10.0, 3_000.0);
    close(o.intent_pct.expect("intent_pct 可读"), 0.3);
    assert_eq!(t.to_bits(), 3_000.0f64.to_bits(), "首 bar 即 Hold ⇒ 目标 = 当前持仓（零订单）");
}

/// E19②：`Pause`（缺省）⇒ 中立带输出**冻结在上一输出目标的绝对股数**，
/// 且 `intent_pct` 仍（持续）披露未达成的意图。
#[test]
fn e19_2_pause_freezes_output_and_discloses_intent() {
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Scaled),
        rate_cap(0.05, None, None),
        guard4(0.9, 0.0, 0.005, None),
    );
    let mut st = PolicyState::new();
    let (t1, o1) = eval(&mut st, &p, 80.0, 100_000.0, 10.0, 0.0);
    close(t1, 500.0); // 限速一步 = 5% 净值
    close(o1.intent_pct.expect("intent_pct 可读"), 0.35);
    // 中立带：输出冻结在 500 股（绝对量），净值/价格漂移**不得**重算；意图仍披露
    for (eq, px) in [(100_000.0, 10.0), (120_000.0, 12.0), (80_000.0, 8.0)] {
        let (t, o) = eval(&mut st, &p, 50.0, eq, px, 500.0);
        assert_eq!(
            t.to_bits(),
            500.0f64.to_bits(),
            "Pause：中立带输出须冻结在上一输出目标（绝对股数）"
        );
        close(o.intent_pct.expect("intent_pct 可读"), 0.35);
        close(o.target_pct.expect("target_pct 可读"), t * px / eq);
        assert!(
            (o.intent_pct.expect("i") - o.target_pct.expect("t")).abs() > 0.2,
            "Pause 下「意图未达成」必须可测（|intent_pct − target_pct| 须大）"
        );
    }
}

/// E19③：`Continue` ⇒ **单根**降档声明后，中立带继续推进，在 ⌈Δ/预算⌉+1 根内到达 intent。
#[test]
fn e19_3_continue_advances_after_single_declaration() {
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Scaled),
        rate_cap(0.05, None, Some(OnSignalBreak::Continue)),
        guard4(1.0, 0.0, 0.0, None),
    );
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    for _ in 0..10 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 5_000.0);
    // 单根降档声明（score 30 ⇒ intent 0.15 ⇒ 1500 股）
    let (t1, _) = eval(&mut st, &p, 30.0, 100_000.0, 10.0, cur);
    close(t1, 4_500.0);
    cur = t1;
    // 其后**全部**是中立带（score 50）⇒ Continue 继续推进：Δ = 3000 股、预算 500 股/bar ⇒ 6 根
    let mut bars = 0usize;
    while (cur - 1_500.0).abs() > 1e-9 && bars < 20 {
        let (t, o) = eval(&mut st, &p, 50.0, 100_000.0, 10.0, cur);
        close(o.intent_pct.expect("intent_pct 可读"), 0.15);
        assert!(t <= cur + 1e-9, "降档推进不得反向（{t} > {cur}）");
        cur = t;
        bars += 1;
    }
    assert!(bars <= 6 + 1, "须在 ⌈Δ/预算⌉+1 = 7 根内到达 intent，实际 {bars} 根");
    close(cur, 1_500.0);
}

// E19④（缺省 ⇒ 订单序列与现行逐字节一致）落 `adr029_step1_5_golden.rs`（引擎级特征化基线）。

// ===========================================================================
// E20：清仓豁免死区（`desired == 0`）
// ===========================================================================

/// E20①：残仓 + 清仓意图 ⇒ **即使 |gap| 折算金额 < 死区**也必须产单（目标直达 0）。
#[test]
fn e20_1_liquidation_exempt_from_deadzone() {
    // 死区 5% 净值 = 5000 元 = 500 股 @10 ⇒ 远超残仓
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        RampSpec::Immediate,
        guard4(1.0, 0.0, 0.05, None),
    );
    // 残仓 100 股（折 1000 元 < 5000 元死区）⇒ 清仓豁免：目标 0 且不置 deadzone_blocked
    let (t, o) = eval(&mut PolicyState::new(), &p, 0.0, 100_000.0, 10.0, 100.0);
    assert_eq!(t.to_bits(), 0.0f64.to_bits(), "清仓豁免：desired == 0 ⇒ 死区不适用");
    assert!(!o.deadzone_blocked, "清仓豁免 ⇒ 不得置 deadzone_blocked");
    // 反证口径：非清仓（降档至非零水位）仍受死区（同 guard）
    let (t2, o2) = eval(&mut PolicyState::new(), &p, 82.0, 100_000.0, 10.0, 5_000.0);
    assert!(o2.deadzone_blocked, "降档至非零水位仍受死区（豁免只针对 desired == 0）");
    assert_eq!(t2.to_bits(), 5_000.0f64.to_bits());
}

/// E20②：限速下的清仓尾段（含进入死区范围的最后几股）逐 bar 逼近 0（F3 的病灶）。
#[test]
fn e20_2_liquidation_tail_walks_to_zero_through_deadzone() {
    // 下行预算 = 0.004 × 100_000 / 10 = 40 股/bar；死区 0.5% 净值 = 500 元 = 50 股：
    // 残仓降到 50 股以下时，|gap| 折算金额 < 死区 ⇒ 清仓豁免必须生效（否则结构性清不掉）。
    let p = exposure(
        mapped(0.006, 0.006, SellPolicy::Flat),
        rate_cap(0.05, Some(0.004), None),
        guard4(1.0, 0.0, 0.005, None),
    );
    let mut st = PolicyState::new();
    // 建仓到 60 股（intent = 0.006 ⇒ 0.006 × 100_000 / 10 = 60 股；上行预算 500 股/bar ⇒ 1 根到位）
    let (t0, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 0.0);
    close(t0, 60.0);
    let mut cur = t0;
    // 首根清仓 bar：尚在死区之外（|gap| = 600 元 ≥ 500 元）⇒ 正常下行一步（40 股）
    let (t1, o1) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
    assert!(!o1.deadzone_blocked, "首根清仓 bar 在死区之外，不得被拦");
    close(t1, 20.0);
    cur = t1;
    let mut bars = 1usize;
    // 其后每根都已落入死区范围（|gap| 折算 < 500 元）⇒ 靠清仓豁免继续逼近 0
    while cur > 1e-9 && bars < 10 {
        let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
        assert!(
            !o.deadzone_blocked,
            "清仓推进（desired == 0）不得被死区拦截（bar {bars}，cur={cur}）"
        );
        assert!(t < cur, "须逐 bar 逼近 0（bar {bars}：{t} >= {cur}）");
        cur = t;
        bars += 1;
    }
    assert!(
        bars <= 3,
        "60 股 / 40 股每 bar ⇒ 须在 ⌈60/40⌉+1 = 3 根内到 0，实际 {bars} 根"
    );
    close(cur, 0.0);
    // 到 0 后继续持股态（**已空仓、锚点 = 0**）：本无单可下 ⇒ 清仓豁免**不适用**（需 `current > 0`）
    // ⇒ `|gap| = 0 < 死区` 命中、目标恒 0、零订单。该断言原为 `!o.deadzone_blocked`，
    // 编码的是 **2026-09-29 E25 收口前**的旧口径（`desired == 0` 一律豁免），
    // 现按 06-plan §2.5 P6 收口为「有残仓才豁免」⇒ 此处改为**保留旧观测**（详见 E25①）。
    let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, 0.0);
    assert_eq!(t.to_bits(), 0.0f64.to_bits(), "零订单：目标 = 当前 = 0");
    assert!(
        o.deadzone_blocked,
        "无残仓 ⇒ 保留旧观测（gap 0 < 死区 500 元），不得计入「被豁免」"
    );
    assert!(!o.rate_limited);
}

// ===========================================================================
// E21：收敛判据（4 分句；a/b/c/d）
// ===========================================================================

/// E21a：清仓意图持续 K ⇒ **含尾段**在 ≤ ⌈w/下行预算⌉+1 根内到 0。
///
/// 尾段构造（**必须**让限速的最后一步落进死区范围，否则豁免不进判据）：下行预算 991 股/bar、
/// 死区 0.5% 净值 = 500 元 = 50 股 ⇒ 序列 5000 → 4009 → 3018 → 2027 → 1036 → 45 → 0，
/// 倒数第二步时残仓 45 股（折算 450 元 < 500 元）——**只有清仓豁免生效才可能继续走到 0**。
#[test]
fn e21_a_liquidation_converges_including_tail() {
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Flat),
        rate_cap(0.05, Some(0.0991), Some(OnSignalBreak::Continue)),
        guard4(1.0, 0.0, 0.005, None),
    );
    p.validate().expect("合法非对称配置");
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    for _ in 0..10 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t; // 上行预算 5% ⇒ 500 股/bar ⇒ 10 根到 5000
    }
    close(cur, 5_000.0);
    // 单根清仓声明（score 0 ⇒ intent 0）→ 其后全部中立带（Continue 保持 intent = 0）
    let (t, _) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
    close(t, 5_000.0 - 991.0);
    cur = t;
    let mut bars = 1usize;
    while cur > 1e-9 && bars < 20 {
        let (t, o) = eval(&mut st, &p, 50.0, 100_000.0, 10.0, cur);
        close(o.intent_pct.expect("intent_pct 可读"), 0.0);
        assert!(
            !o.deadzone_blocked,
            "清仓尾段（desired == 0）不得被死区拦截（bar {bars}，cur={cur}）"
        );
        assert!(t < cur, "须逐 bar 逼近 0（bar {bars}）");
        cur = t;
        bars += 1;
    }
    let bound = (5_000f64 / 991f64).ceil() as usize + 1; // ⌈w/下行预算⌉ + 1 = 7
    assert!(bars <= bound, "清仓须在 {bound} 根内到 0（含尾段），实际 {bars} 根");
    close(cur, 0.0);
}

/// E21b：降档至 w₁ 持续 K ⇒ 到达 w₁（±死区）。
#[test]
fn e21_b_downgrade_converges_to_declared_level() {
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Scaled),
        rate_cap(0.05, None, None),
        guard4(1.0, 0.0, 0.005, None),
    );
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    for _ in 0..10 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 5_000.0);
    // w₁ = 0.15 × 100_000 / 10 = 1500 股；持续降档声明（score 30，Scaled）
    let mut bars = 0usize;
    while (cur - 1_500.0).abs() > 1e-9 && bars < 20 {
        let (t, _) = eval(&mut st, &p, 30.0, 100_000.0, 10.0, cur);
        assert!(t <= cur + 1e-9, "降档不得反向");
        cur = t;
        bars += 1;
    }
    assert!(bars <= 7 + 1, "Δ = 3500 股 / 预算 500 ⇒ 须 ≤ 8 根，实际 {bars} 根");
    let deadzone_qty = 0.005 * 100_000.0 / 10.0; // 50 股
    assert!(
        (cur - 1_500.0).abs() <= deadzone_qty + 1e-9,
        "须到达 w₁ ± 死区（{cur} vs 1500 ± {deadzone_qty}）"
    );
    close(cur, 1_500.0);
}

/// E21c：`Continue` 下单根信号 ⇒ 仍须在 ⌈Δ/预算⌉+1 根内到达（多个预算档复证）。
#[test]
fn e21_c_single_signal_continues_to_convergence() {
    for pct in [0.05f64, 0.02] {
        let p = exposure(
            mapped(0.2, 0.5, SellPolicy::Scaled),
            rate_cap(pct, Some(pct), Some(OnSignalBreak::Continue)),
            guard4(1.0, 0.0, 0.0, None),
        );
        let mut st = PolicyState::new();
        let mut cur = 0.0f64;
        // 建仓到 5000（上行预算 pct ⇒ ⌈5000/(pct×10000)⌉ 根）
        let up_bars = (5_000f64 / (pct * 100_000.0 / 10.0)).ceil() as usize;
        for _ in 0..up_bars {
            let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
            cur = t;
        }
        close(cur, 5_000.0);
        // 单根降档声明（intent 0.15 ⇒ 1500 股）⇒ 其后中立带 Continue 推进
        let (t, _) = eval(&mut st, &p, 30.0, 100_000.0, 10.0, cur);
        cur = t;
        let delta = (5_000.0 - 1_500.0) / (pct * 100_000.0 / 10.0); // Δ / 预算
        let bound = delta.ceil() as usize + 1;
        let mut bars = 0usize;
        while (cur - 1_500.0).abs() > 1e-9 && bars < 30 {
            let (t, _) = eval(&mut st, &p, 50.0, 100_000.0, 10.0, cur);
            cur = t;
            bars += 1;
        }
        assert!(
            bars <= bound,
            "pct={pct}：单根信号后须在 ⌈Δ/预算⌉+1 = {bound} 根内收敛，实际 {bars} 根"
        );
        close(cur, 1_500.0);
    }
}

/// E21d（**负向判据**）：`Pause`（缺省）下「停在中途」是**契约行为**，且 `intent_pct` 披露未达成
/// ——防把 `Pause` 实现成 `Continue`。
#[test]
fn e21_d_pause_stops_midpath_by_contract() {
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Scaled),
        rate_cap(0.05, None, None), // on_signal_break 缺省 ⇒ Pause
        guard4(1.0, 0.0, 0.0, None),
    );
    let mut st = PolicyState::new();
    let mut cur = 0.0f64;
    for _ in 0..10 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 5_000.0);
    // 单根降档声明 ⇒ 只推进一步（500 股）后信号中断
    let (t, _) = eval(&mut st, &p, 30.0, 100_000.0, 10.0, cur);
    close(t, 4_500.0);
    cur = t;
    // 其后 10 根中立带：输出**必须**停在 4500（不得继续推进），意图 0.15 持续披露未达成
    for bar in 0..10 {
        let (t, o) = eval(&mut st, &p, 50.0, 100_000.0, 10.0, cur);
        assert_eq!(
            t.to_bits(),
            4_500.0f64.to_bits(),
            "Pause：信号中断后须停在上一输出目标（bar {bar}）"
        );
        close(o.intent_pct.expect("intent_pct 可读"), 0.15);
        close(o.target_pct.expect("target_pct 可读"), 0.45);
        assert!(
            (o.intent_pct.expect("i") - o.target_pct.expect("t")).abs() > 0.2,
            "Pause 下未达成意图必须可测（bar {bar}）"
        );
        cur = t;
    }
}

// ===========================================================================
// 兼容铁律（06-plan §2.1）：`LumpSum`/`Dca` 零行为变化 — 含**观测口径**
// ===========================================================================

/// 兼容：`LumpSum`/`Dca` 的观测新字段恒 `None`（legacy 口径不得被新机制污染）。
#[test]
fn legacy_variants_observation_new_fields_are_none() {
    let cases: &[(ExecutionPolicy, f64)] = &[
        (ExecutionPolicy::LumpSum { position_pct: 0.5 }, 80.0),
        (
            ExecutionPolicy::Dca {
                tranches: 2,
                mode: strategy_core::DcaMode::Equal,
                amount: None,
                interval: 1,
            },
            80.0,
        ),
    ];
    for (p, score) in cases {
        let (_, o) = eval(&mut PolicyState::new(), p, *score, 100_000.0, 10.0, 0.0);
        assert!(o.intent_pct.is_none(), "legacy 变体不产意图（{p:?}）");
        assert!(
            o.down_ramp_cap_pct_per_bar.is_none(),
            "legacy 变体不产下行预算（{p:?}）"
        );
        // 既有观测口径不变（目标/当前占比仍可读，其余flag恒 false）
        assert!(o.target_pct.is_some() && o.current_pct.is_some());
        assert!(!o.rate_limited && !o.deadzone_blocked && !o.clamped_by_guard);
        assert!(!o.sell_transition && !o.affordability_capped);
    }
}

// ===========================================================================
// E23（core 部分）：成本感知 —— `deadzone_min_notional`
// ===========================================================================

/// E23①：阈值 = `max(deadzone_pct × equity, deadzone_min_notional)`（元）。
#[test]
fn e23_1_deadzone_min_notional_raises_threshold() {
    let target = mapped(0.2, 0.8, SellPolicy::Flat);
    // 净值 100_000、价 10：比例死区 0.1% = 100 元 = 10 股；min_notional 5000 元 = 500 股
    let no_min = exposure(target, RampSpec::Immediate, guard4(1.0, 0.0, 0.001, None));
    let with_min = exposure(target, RampSpec::Immediate, guard4(1.0, 0.0, 0.001, Some(5_000.0)));
    // score 82 ⇒ 目标 5300；当前 5000 ⇒ gap 300 股 = 3000 元
    let (t0, o0) = eval(&mut PolicyState::new(), &no_min, 82.0, 100_000.0, 10.0, 5_000.0);
    assert!(!o0.deadzone_blocked, "比例死区 100 元 < 3000 元 ⇒ 不拦");
    close(t0, 5_300.0);
    let (t1, o1) = eval(&mut PolicyState::new(), &with_min, 82.0, 100_000.0, 10.0, 5_000.0);
    assert!(o1.deadzone_blocked, "min_notional 5000 元 > 3000 元 ⇒ 必须拦");
    assert_eq!(t1.to_bits(), 5_000.0f64.to_bits(), "被拦 ⇒ 输出目标 = 当前持仓（零订单）");
    // `max` 语义：比例死区（0.05 × 100_000 = 5000 元）> min_notional（1000 元）⇒ 比例口径胜出
    let ratio_wins = exposure(target, RampSpec::Immediate, guard4(1.0, 0.0, 0.05, Some(1_000.0)));
    let (_, o2) = eval(&mut PolicyState::new(), &ratio_wins, 82.0, 100_000.0, 10.0, 5_000.0);
    assert!(o2.deadzone_blocked, "gap 3000 元 < 比例阈值 5000 元 ⇒ 拦");
    // 门槛是「抬高」而非「封锁」：gap 30000 元 ⇒ 放行
    let (t3, o3) = eval(&mut PolicyState::new(), &with_min, 100.0, 100_000.0, 10.0, 5_000.0);
    assert!(!o3.deadzone_blocked, "gap 30000 元 ≥ 门槛 ⇒ 放行");
    close(t3, 8_000.0);
    // 边界（与既有 E5 同口径）：|gap| 恰等于门槛 ⇒ **不**算命中（严格小于）
    let exact = exposure(target, RampSpec::Immediate, guard4(1.0, 0.0, 0.0, Some(3_000.0)));
    let (t4, o4) = eval(&mut PolicyState::new(), &exact, 82.0, 100_000.0, 10.0, 5_000.0);
    assert!(!o4.deadzone_blocked, "恰等门槛不算命中");
    close(t4, 5_300.0);
}

/// E23②：缺省 `None` ⇒ 与现行**比例口径逐字节一致**（含边界：恰等死区不命中）。
#[test]
fn e23_2_default_none_is_ratio_deadzone_unchanged() {
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        RampSpec::Immediate,
        guard4(1.0, 0.0, 0.03, None),
    );
    // |Δ| × price = 3000 = 0.03 × 100_000 ⇒ 不命中（严格小于）
    let (t, o) = eval(&mut PolicyState::new(), &p, 82.0, 100_000.0, 10.0, 5_000.0);
    assert!(!o.deadzone_blocked, "恰等比例死区 ⇒ 不命中（现行口径）");
    close(t, 5_300.0);
    // 阈值略抬（0.0301 ⇒ 3010 元 > gap 3000 元）：命中 ⇒ 输出目标 = 当前持仓
    let p_hit = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        RampSpec::Immediate,
        guard4(1.0, 0.0, 0.0301, None),
    );
    let (t2, o2) = eval(&mut PolicyState::new(), &p_hit, 82.0, 100_000.0, 10.0, 5_000.0);
    assert!(o2.deadzone_blocked, "gap 3000 元 < 3010 元 ⇒ 命中（现行比例口径）");
    assert_eq!(t2.to_bits(), 5_000.0f64.to_bits());
}

/// E23③（validate fail loud）：`deadzone_min_notional` 必须 ≥ 0 且有限。
#[test]
fn e23_3_validate_rejects_negative_or_non_finite_min_notional() {
    for bad in [-0.01, -1.0, f64::NAN, f64::INFINITY] {
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard4(1.0, 0.0, 0.0, Some(bad)),
        );
        let err = p.validate().expect_err(&format!("deadzone_min_notional = {bad} 必须拒绝"));
        assert!(err.contains("deadzone_min_notional"), "错误须点名字段：{err}");
    }
    exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        RampSpec::Immediate,
        guard4(1.0, 0.0, 0.0, Some(0.0)),
    )
    .validate()
    .expect("deadzone_min_notional = 0 合法（等价缺省）");
}

// ===========================================================================
// E25：观测级历史复现 —— D13 豁免条件收口（`desired == 0 ∧ current_qty > 0`）的可测载体
//
// 动因：首轮独立复验（V1）实测，旧配置重放时 `deadzone_blocked` 在
// 000023 104/178 bar、000025 10/178 bar 由 `true → false` 翻转（成交/净值全同）。
// 根因 = 豁免条件写成 `desired == 0`，把「**已空仓且锚点 = 0**」的中立带 bar
// （本无单可下）也判成豁免。契约 §2.5 P6 收口为 `desired_qty == 0.0 && current_qty > 0.0`。
// 下面两条锁**成对**：①无残仓 ⇒ 保留旧观测；②有残仓 ⇒ 豁免生效（F3 修复不变）。
// ===========================================================================

/// E25①：`desired == 0 ∧ current == 0`（**已空仓、锚点 = 0**）⇒ **保留旧观测**：
/// `|gap| = 0 < 死区` ⇒ `deadzone_blocked == true`（豁免**不得**适用），且目标 = 当前 ⇒ **零订单**。
///
/// 形态与真实 run `sr_1790349931357_000023`（`ScoreMapped/Flat`）的收敛尾部一致：
/// 清仓到 0 之后进入中立带（`Hold` + 缺省 `Pause` ⇒ `desired = 锚点 = 0`），旧 run 在那些 bar 上
/// 记录的就是 `deadzone_blocked = true`。
#[test]
fn e25_1_zero_target_with_no_residual_keeps_legacy_deadzone_observation() {
    // 净值 100_000、价 10、死区 0.5% ⇒ 阈值 500 元（= 50 股）
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Flat),
        rate_cap(0.05, None, None), // `on_signal_break` 缺省 ⇒ `Pause`
        guard4(1.0, 0.0, 0.005, None),
    );
    let mut st = PolicyState::new();
    // 建仓到 5000 股（intent 0.5 × 100_000 / 10；上行预算 500 股/bar）
    let mut cur = 0.0f64;
    for _ in 0..10 {
        let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
        cur = t;
    }
    close(cur, 5_000.0);
    // 清仓声明（`Flat` ⇒ intent 0）⇒ **有残仓**段逐 bar 逼近 0（此段豁免必须生效）
    let mut bars = 0usize;
    while cur > 1e-9 && bars < 20 {
        let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
        assert!(
            !o.deadzone_blocked,
            "有残仓的清仓推进必须豁免死区（bar {bars}，cur={cur}）"
        );
        assert!(t < cur, "须逐 bar 逼近 0（bar {bars}）");
        cur = t;
        bars += 1;
    }
    close(cur, 0.0);
    // ★ 已空仓 + 锚点 = 0 的中立带 bar：`desired = 锚点 = 0`、`current = 0` ⇒ gap 0 元 < 500 元
    //   ⇒ 保留旧语义：`deadzone_blocked == true`，且目标 = 当前 ⇒ 零订单。
    for bar in 0..3 {
        let (t, o) = eval(&mut st, &p, 50.0, 100_000.0, 10.0, 0.0);
        assert_eq!(
            t.to_bits(),
            0.0f64.to_bits(),
            "零订单：目标 = 当前 = 0（bar {bar}）"
        );
        assert!(
            o.deadzone_blocked,
            "desired == 0 ∧ current == 0 ⇒ 保留旧观测（deadzone_blocked = true，bar {bar}）"
        );
        close(o.intent_pct.expect("intent_pct 可读"), 0.0);
        close(o.target_pct.expect("target_pct 可读"), 0.0);
        close(o.current_pct.expect("current_pct 可读"), 0.0);
    }
}

/// E25①（对照组，防「一律置 true」的假绿）：`desired == 0 ∧ current == 0` 但**死区阈值 = 0**
/// ⇒ 仍走现行比例口径（`0 < 0` 不成立）⇒ `deadzone_blocked == false`、零订单。
#[test]
fn e25_1b_zero_target_no_residual_zero_deadzone_is_not_blocked() {
    let p = exposure(
        mapped(0.2, 0.5, SellPolicy::Flat),
        RampSpec::Immediate,
        guard4(1.0, 0.0, 0.0, None),
    );
    let (t, o) = eval(&mut PolicyState::new(), &p, 0.0, 100_000.0, 10.0, 0.0);
    assert_eq!(t.to_bits(), 0.0f64.to_bits());
    assert!(
        !o.deadzone_blocked,
        "阈值为 0 ⇒ 不命中（`0 < 0` 不成立）——与旧 run 同一口径"
    );
}

/// E25②：`desired == 0 ∧ current > 0 ∧ |gap| 折算 < 死区` ⇒ `deadzone_blocked == false`
/// **且必产单**（F3 修复不得因收口而回退）。
#[test]
fn e25_2_zero_target_with_residual_is_exempt_and_must_trade() {
    // 死区 5% 净值 = 5000 元 = 500 股 @10 ⇒ 远大于残仓 20 股（200 元）
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        RampSpec::Immediate,
        guard4(1.0, 0.0, 0.05, None),
    );
    let cur = 20.0f64;
    let (t, o) = eval(&mut PolicyState::new(), &p, 0.0, 100_000.0, 10.0, cur);
    assert!(
        (0.0 - cur).abs() * 10.0 < 0.05 * 100_000.0,
        "前置态必须落在死区内（|gap| 200 元 < 5000 元）"
    );
    assert!(!o.deadzone_blocked, "有残仓的清仓 ⇒ 豁免（不得置 deadzone_blocked）");
    assert_eq!(t.to_bits(), 0.0f64.to_bits(), "目标直达 0");
    assert!(
        (t - cur).abs() > 0.0,
        "必产单：订单增量 = {t} − {cur} 不得为 0"
    );
}

/// E25②（边界）：`desired == 0`、残仓恰好为 0 **以下**（浮点残值 `> 0` 亦算残仓）⇒ 豁免仍生效。
/// 反向边界：残仓 = 0 ⇒ 不豁免（见 E25①）。
#[test]
fn e25_2b_residual_boundary_is_strictly_positive() {
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        RampSpec::Immediate,
        guard4(1.0, 0.0, 0.05, None),
    );
    // 浮点级残值（真实 run 的尾段可能留下 1e-12 量级）：`> 0.0` ⇒ 仍算残仓 ⇒ 豁免
    let (t, o) = eval(&mut PolicyState::new(), &p, 0.0, 100_000.0, 10.0, 1e-9);
    assert!(!o.deadzone_blocked, "残仓 > 0（含浮点残值）⇒ 豁免生效");
    assert_eq!(t.to_bits(), 0.0f64.to_bits(), "目标直达 0（清掉残值）");
}

// ===========================================================================
// E23④ / E25③：**优先级** —— 清仓豁免**优先于** `deadzone_min_notional`（D13）
//
// 动因：收口轮独立复验（`tester/report/20260929_step1_5_laneE_verify.md` §1.2 + 残余风险 3）
// 已用**临时探针**实测「清仓豁免赢过 `deadzone_min_notional`」成立（5 个点位），但登记了覆盖缺口：
// **无永久用例** —— E23①②③ 全部只用**非清仓** bar，E25①②/①②b 全部只用 `min_notional = None`。
// 本组用例补上该缺口，把「优先级」钉成永久判据。
//
// 契约依据：06-plan §2.5 P6 —— 豁免短路 `!liquidation_with_residual` 位于
// `(desired − current).abs() × price < max(deadzone_pct × equity, deadzone_min_notional)` **之前**
// ⇒ 清仓推进不受 `deadzone_min_notional` 影响；D13「清仓豁免优先于 `deadzone_min_notional`」
// （独立复验授权清单第 13 条）。
//
// 三条用例**成组**：正例（必须放行 + 逐 bar 走到 0）／负例①（非清仓同区间**必须拦**，
// 防「一律放行」假绿）／负例②（无残仓**保留旧观测**，与 E25① 同口径）。
// ===========================================================================

/// E23④：**优先级** —— `desired == 0 ∧ current_qty > 0`（正在清仓且**有残仓**）的豁免
/// **优先于** `deadzone_min_notional`：即便 gap 折算金额远小于 `min_notional` 门槛，
/// 也必须产单，并按下行 rate cap **逐 bar 推进到 0**。
///
/// 构造：净值 100_000、价 10、`deadzone_pct = 0`（**故意归零** ⇒ `max(0, 5000)` = `min_notional`
/// 是**唯一**门槛，豁免与门槛的优先关系可被孤立判定）；`deadzone_min_notional = 5000` 元（= 500 股）
/// 远大于残仓 100 股（1000 元）⇒ 每一根 bar 的 `|desired − current|` 都**深在死区内**；
/// 下行预算 `0.004 × 100_000 / 10 = 40` 股/bar ⇒ 100 → 60 → 20 → 0（3 根）。
#[test]
fn e23_4_clearing_exemption_precedes_min_notional() {
    let min_notional = 5_000.0f64; // 元
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        rate_cap(0.05, Some(0.004), None), // 下行预算 0.004 × 100_000 / 10 = 40 股/bar
        guard4(1.0, 0.0, 0.0, Some(min_notional)),
    );
    p.validate().expect("guard（deadzone_pct = 0 + min_notional = 5000）须合法");
    let mut st = PolicyState::new();
    let down_cap_qty = 0.004 * 100_000.0 / 10.0; // 40 股
    let mut cur = 100.0f64; // 残仓（1000 元 < 5000 元）
    let mut bars = 0usize;
    while cur > 1e-9 && bars < 10 {
        let gap_value = (0.0 - cur).abs() * 10.0;
        assert!(
            gap_value < min_notional,
            "前置态必须落在 `min_notional` 死区内（bar {bars}：|gap| {gap_value} 元 < {min_notional} 元）"
        );
        let (t, o) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, cur);
        close(o.intent_pct.expect("intent_pct 可读"), 0.0);
        assert!(
            !o.deadzone_blocked,
            "清仓豁免**优先于** min_notional（bar {bars}，cur = {cur}）⇒ 不得置 deadzone_blocked"
        );
        assert!(
            t < cur,
            "必须产单且朝 0 推进（bar {bars}：target {t} 未小于 current {cur} ⇒ 订单增量 0）"
        );
        let moved_value = (cur - t).abs() * 10.0;
        assert!(
            moved_value <= down_cap_qty * 10.0 + 1e-6,
            "推进受下行 rate cap 约束（bar {bars}：{moved_value} 元 > 400 元）"
        );
        close(o.target_pct.expect("target_pct 可读"), t * 10.0 / 100_000.0);
        cur = t;
        bars += 1;
    }
    assert_eq!(bars, 3, "100 股 / 40 股每 bar ⇒ 须恰好 3 根到 0，实际 {bars} 根");
    assert_eq!(cur.to_bits(), 0.0f64.to_bits(), "目标须推进到 0（逐 bar，按 rate cap）");
}

/// E23④ 负例①（防「一律放行」假绿）：**非清仓** bar（`desired > 0`）的 gap 同样落在
/// `deadzone_min_notional` 死区内 ⇒ **必须被拦**（豁免**只**对 `desired == 0` 生效）。
///
/// 与正例**同 guard / 同净值 / 同价格 / 同 `current_qty` = 100 股**，唯一差别 = 本 bar 是**非清仓**声明：
/// `ScoreMapped{at_threshold_pct: 0.02, at_full_pct: 0.1}`、score 65 ⇒
/// `0.02 + (65−60)/40 × 0.08 = 0.03` ⇒ intent 300 股（3000 元）⇒ `|gap| = 200 股 = 2000 元 < 5000 元`。
#[test]
fn e23_4b_non_clearing_gap_below_min_notional_is_blocked() {
    let p = exposure(
        mapped(0.02, 0.1, SellPolicy::Flat),
        rate_cap(0.05, Some(0.004), None),
        guard4(1.0, 0.0, 0.0, Some(5_000.0)),
    );
    let cur = 100.0f64;
    let (t, o) = eval(&mut PolicyState::new(), &p, 65.0, 100_000.0, 10.0, cur);
    close(o.intent_pct.expect("intent_pct 可读"), 0.03);
    assert!(
        (300.0 - cur) * 10.0 < 5_000.0,
        "前置态必须落在 min_notional 死区内（|gap| 2000 元 < 5000 元）"
    );
    assert!(
        o.deadzone_blocked,
        "非清仓 bar 的 |gap| < min_notional ⇒ 必须被拦（豁免只针对清仓意图）"
    );
    assert_eq!(
        t.to_bits(),
        cur.to_bits(),
        "被拦 ⇒ 输出目标 = 当前持仓 ⇒ 订单增量为 0"
    );
}

/// E23④ 负例②（与 E25① 同口径）：**清仓意图但无残仓**（`current_qty == 0`）⇒ 豁免**不适用**
/// （`current_qty > 0.0` 不成立）⇒ 保留旧观测 `deadzone_blocked == true`、零订单。
///
/// 即便 `deadzone_min_notional` 显著大于 0，也不改变该旧观测 —— 这正是 D13 收口
/// （`desired == 0 ∧ current_qty > 0`）必须同时满足两个条件的原因。
#[test]
fn e23_4c_clearing_intent_without_residual_keeps_legacy_observation() {
    let p = exposure(
        mapped(0.2, 0.8, SellPolicy::Flat),
        rate_cap(0.05, Some(0.004), None),
        guard4(1.0, 0.0, 0.0, Some(5_000.0)),
    );
    let (t, o) = eval(&mut PolicyState::new(), &p, 0.0, 100_000.0, 10.0, 0.0);
    assert_eq!(t.to_bits(), 0.0f64.to_bits(), "零订单：目标 = 当前 = 0");
    assert!(
        o.deadzone_blocked,
        "清仓意图 ∧ 无残仓 ⇒ 保留旧观测（deadzone_blocked = true，与 E25① 同口径）"
    );
    close(o.intent_pct.expect("intent_pct 可读"), 0.0);
    close(o.current_pct.expect("current_pct 可读"), 0.0);
}

