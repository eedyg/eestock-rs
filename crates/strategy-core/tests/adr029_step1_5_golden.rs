//! ADR-029 Step 1.5（Lane A）**特征化基线**（characterization golden，**改动前先绿**）。
//!
//! 目的：把 Step 1.5 改动**之前**的三组代表性配置在**确定性 bar 序列**上的
//! 订单意图 + 成交序列冻结为常量，作为 E19④「缺省（无新字段）⇒ 订单序列与现行逐字节一致」
//! 的硬基线（06-plan §4 E19④、§2.1 兼容铁律）。
//!
//! 纪律：
//! - 数据**手工构造**（固定价 + 3 段价格阶跃；评分序列硬编码于 fixture），无 RNG / 无系统时间；
//! - 冻结值来自**改动前**的产品代码（唯一一次 `--nocapture` 采集），改动后**必须逐字符相同**；
//! - 三组配置均只使用 Step 1.5 之前的 JSON 形态（`RateCap{pct_per_bar}`、三字段 `guard`）
//!   ⇒ 即「旧 run 配置」的等价形态。
//!
//! 采集命令（证据落 `coder/evidence/20260929_adr029_step1_5/raw/`）：
//! `cargo test -p strategy-core --test adr029_step1_5_golden -- --nocapture`

use backtest::{Bar, FeeModel, Period, StrategyParams};
use strategy_core::{
    run_ensemble, EnsembleConfig, EngineEvent, EnsembleResult, ExecutionPolicy, ExposureTarget,
    GuardSpec, RampSpec, SellPolicy, StrategySlot,
};
use strategy_runtime::{QuickJsRuntime, RuntimeLimits};

const SCRIPTED: &str = include_str!("fixtures/adr029_step1_5_scripted.js");
const INITIAL_CAPITAL: f64 = 100_000.0;
/// 正名费（golden 采集期的 run 配置）。
const FEE: FeeModel = FeeModel {
    commission_rate_pct: 0.025,
    min_commission: 5.0,
    stamp_duty_pct: 0.05,
    slippage_bp: 2.0,
};

/// 18 根确定性 bar：open=high=low=close；价格三段阶跃 10.0 / 11.0 / 9.5。
fn bar_series() -> Vec<Bar> {
    let prices: Vec<f64> = (0..18)
        .map(|i| match i {
            0..=7 => 10.0,
            8..=12 => 11.0,
            _ => 9.5,
        })
        .collect();
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

fn cfg(policy: ExecutionPolicy) -> EnsembleConfig {
    EnsembleConfig {
        symbol: "TEST.SYMBOL".to_string(),
        slots: vec![StrategySlot::new(
            SCRIPTED,
            "sha256:adr029_step1_5_scripted",
            StrategyParams::new(),
            1.0,
        )
        .expect("合法 slot")],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy,
        stop: None,
        initial_capital: INITIAL_CAPITAL,
        fee: FEE,
        period: Period::D1,
        warmup_bars: 0,
        runtime_limits: RuntimeLimits::default(),
    }
}

fn run(cfg: &EnsembleConfig, bars: &[Bar]) -> EnsembleResult {
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    run_ensemble(cfg, bars, &mut rt).expect("引擎运行成功")
}

/// 订单意图 + 成交序列的**定序**文本（`bar_index + side + qty`，每行一笔；qty 定点 9 位）。
fn script(res: &EnsembleResult) -> String {
    let mut out = String::new();
    for (i, r) in res.per_bar.iter().enumerate() {
        for o in &r.orders {
            out.push_str(&format!(
                "bar={i:>2} order {:?} qty={:.9} reason={:?}\n",
                o.side, o.qty, o.reason
            ));
        }
        for e in &r.events {
            if let EngineEvent::Fill { bar_index, side, qty, price, reason, .. } = e {
                out.push_str(&format!(
                    "bar={bar_index:>2} fill  {side:?} qty={qty:.9} price={price:.9} reason={reason:?}\n"
                ));
            }
        }
    }
    for t in &res.trades {
        out.push_str(&format!(
            "trade open_bar={} close_bar={:?} shares={:.9} pnl={:?} status={:?}\n",
            t.open_bar, t.close_bar, t.shares, t.pnl, t.status
        ));
    }
    out
}

const GOLDEN_1: &str = r#"bar= 0 order Buy qty=500.000000000 reason=Policy
bar= 1 order Buy qty=500.344903769 reason=Policy
bar= 1 fill  Buy qty=499.625099980 price=10.002000000 reason=Policy
bar= 2 order Buy qty=500.314817842 reason=Policy
bar= 2 fill  Buy qty=499.970089975 price=10.002000000 reason=Policy
bar= 3 fill  Buy qty=499.939996527 price=10.002000000 reason=Policy
bar= 9 order Buy qty=461.279709619 reason=Policy
bar=10 order Buy qty=461.591507576 reason=Policy
bar=10 fill  Buy qty=460.940574982 price=11.002200000 reason=Policy
bar=11 fill  Buy qty=461.252450890 price=11.002200000 reason=Policy
bar=13 order Sell qty=514.931131436 reason=Policy
bar=14 order Sell qty=514.886795632 reason=Policy
bar=14 fill  Sell qty=514.931131436 price=9.498100000 reason=Policy
bar=15 order Sell qty=514.842461379 reason=Policy
bar=15 fill  Sell qty=514.886795632 price=9.498100000 reason=Policy
bar=16 order Buy qty=514.798128678 reason=Policy
bar=16 fill  Sell qty=514.842461379 price=9.498100000 reason=Policy
bar=17 order Buy qty=515.164179897 reason=Policy
bar=17 fill  Buy qty=514.400617663 price=9.501900000 reason=Policy
bar=17 fill  Sell qty=1391.468441569 price=9.498100000 reason=ForceClose
trade open_bar=1 close_bar=Some(17) shares=2936.128830016 pnl=Some(-2208.5848556496385) status=Closed
"#;

const GOLDEN_2: &str = r#"bar= 0 order Buy qty=500.000000000 reason=Policy
bar= 1 order Buy qty=500.344903769 reason=Policy
bar= 1 fill  Buy qty=499.625099980 price=10.002000000 reason=Policy
bar= 2 order Buy qty=500.314817842 reason=Policy
bar= 2 fill  Buy qty=499.970089975 price=10.002000000 reason=Policy
bar= 3 fill  Buy qty=499.939996527 price=10.002000000 reason=Policy
bar= 5 order Sell qty=499.910004648 reason=Policy
bar= 6 fill  Sell qty=499.910004648 price=9.998000000 reason=Policy
bar= 9 order Buy qty=458.968760188 reason=Policy
bar=10 order Buy qty=459.281158998 reason=Policy
bar=10 fill  Buy qty=458.629047814 price=11.002200000 reason=Policy
bar=11 fill  Buy qty=458.941524724 price=11.002200000 reason=Policy
bar=13 order Sell qty=516.238499761 reason=Policy
bar=14 order Sell qty=516.194118205 reason=Policy
bar=14 fill  Sell qty=516.238499761 price=9.498100000 reason=Policy
bar=15 order Sell qty=516.149738202 reason=Policy
bar=15 fill  Sell qty=516.194118205 price=9.498100000 reason=Policy
bar=16 order Buy qty=516.105359753 reason=Policy
bar=16 fill  Sell qty=516.149738202 price=9.498100000 reason=Policy
bar=17 order Buy qty=516.471071089 reason=Policy
bar=17 fill  Buy qty=515.708175545 price=9.501900000 reason=Policy
bar=17 fill  Sell qty=884.321573750 price=9.498100000 reason=ForceClose
trade open_bar=1 close_bar=Some(17) shares=2932.813934566 pnl=Some(-1956.8413908886068) status=Closed
"#;

const GOLDEN_3: &str = r#"bar= 0 order Buy qty=3500.000000000 reason=Policy
bar= 1 fill  Buy qty=3500.000000000 price=10.002000000 reason=Policy
bar= 5 order Sell qty=2000.236276250 reason=Policy
bar= 6 fill  Sell qty=2000.236276250 price=9.998000000 reason=Policy
bar= 9 order Buy qty=2766.378839707 reason=Policy
bar=10 fill  Buy qty=2766.378839707 price=11.002200000 reason=Policy
bar=13 order Sell qty=4266.142563457 reason=Policy
bar=14 fill  Sell qty=4266.142563457 price=9.498100000 reason=Policy
bar=16 order Buy qty=4625.662471403 reason=Policy
bar=17 fill  Buy qty=4625.662471403 price=9.501900000 reason=Policy
bar=17 fill  Sell qty=4625.662471403 price=9.498100000 reason=ForceClose
trade open_bar=1 close_bar=Some(14) shares=6266.378839707 pnl=Some(-4986.3924792795515) status=Closed
trade open_bar=17 close_bar=Some(17) shares=4625.662471403 pnl=Some(-61.51691649030545) status=Closed
"#;

// ---------------------------------------------------------------------------
// 三组代表配置（Step 1.5 之前的 JSON 形态 ⇒ 旧 run 配置等价形态）
// ---------------------------------------------------------------------------

/// ① `ScoreMapped 0.2/0.5 Scaled` + `RateCap{pct_per_bar: 0.05}` + `guard(0.9, 0, 0.005)`。
#[test]
fn golden_1_score_mapped_scaled_rate_cap() {
    let policy = ExecutionPolicy::Exposure {
        target: ExposureTarget::ScoreMapped {
            at_threshold_pct: 0.2,
            at_full_pct: 0.5,
            sell: SellPolicy::Scaled,
        },
        ramp: RampSpec::RateCap { pct_per_bar: 0.05, down_pct_per_bar: None, on_signal_break: None },
        guard: GuardSpec { max_pct: 0.9, min_pct: 0.0, deadzone_pct: 0.005, deadzone_min_notional: None },
    };
    let res = run(&cfg(policy), &bar_series());
    let got = script(&res);
    eprintln!("=== GOLDEN_1（ScoreMapped Scaled + RateCap 0.05）===\n{got}");
    assert_eq!(got, GOLDEN_1, "① 旧 JSON 形态订单/成交序列必须与改动前逐字符一致");
}

/// ② `Fixed{0.3}` + `RateCap{pct_per_bar: 0.05}` + 同 guard。
#[test]
fn golden_2_fixed_rate_cap() {
    let policy = ExecutionPolicy::Exposure {
        target: ExposureTarget::Fixed { pct: 0.3 },
        ramp: RampSpec::RateCap { pct_per_bar: 0.05, down_pct_per_bar: None, on_signal_break: None },
        guard: GuardSpec { max_pct: 0.9, min_pct: 0.0, deadzone_pct: 0.005, deadzone_min_notional: None },
    };
    let res = run(&cfg(policy), &bar_series());
    let got = script(&res);
    eprintln!("=== GOLDEN_2（Fixed 0.3 + RateCap 0.05）===\n{got}");
    assert_eq!(got, GOLDEN_2, "② 旧 JSON 形态订单/成交序列必须与改动前逐字符一致");
}

/// ③ `ScoreMapped` + `Immediate` + 同 guard。
#[test]
fn golden_3_score_mapped_immediate() {
    let policy = ExecutionPolicy::Exposure {
        target: ExposureTarget::ScoreMapped {
            at_threshold_pct: 0.2,
            at_full_pct: 0.5,
            sell: SellPolicy::Scaled,
        },
        ramp: RampSpec::Immediate,
        guard: GuardSpec { max_pct: 0.9, min_pct: 0.0, deadzone_pct: 0.005, deadzone_min_notional: None },
    };
    let res = run(&cfg(policy), &bar_series());
    let got = script(&res);
    eprintln!("=== GOLDEN_3（ScoreMapped + Immediate）===\n{got}");
    assert_eq!(got, GOLDEN_3, "③ 旧 JSON 形态订单/成交序列必须与改动前逐字符一致");
}
