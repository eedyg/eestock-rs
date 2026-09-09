//! 官方模板回归（ADR §13.2 D10 / ABI §4.5）：实例化（含 PARAMS_SCHEMA 提取校验）
//! + 确定性双跑（同代码同 bars 两次运行分数序列逐点相等）。
//!
//! 纪律：确定性手工构造数据（锯齿生成器，无 RNG/无时钟），真实 QuickJsRuntime。

use backtest::{Bar, FeeModel, ParamValue, Period, StrategyParams};
use strategy_core::engine::run_ensemble_with_quickjs;
use strategy_core::{reference, EnsembleConfig, ExecutionPolicy, StrategySlot};
use strategy_runtime::{PluginRuntime, QuickJsRuntime, RuntimeLimits};

/// 确定性锯齿序列（无 RNG/无时钟）：close 在 9..=13 三角波振荡（含回踩/冲高，
/// 供模板的均线/门控/软止损分支覆盖）。
fn zigzag_bars(n: usize) -> Vec<Bar> {
    (0..n)
        .map(|i| {
            let t = (i % 8) as f64;
            let off = if t <= 4.0 { t } else { 8.0 - t };
            let c = 9.0 + off;
            Bar {
                ts: 1_700_000_000 + i as i64 * 86_400,
                open: c,
                high: c + 0.3,
                low: c - 0.3,
                close: c,
                volume: 10_000.0,
            }
        })
        .collect()
}

/// 按模板 PARAMS_SCHEMA 填缺省（ABI §1 NIT-6：填缺省是消费方职责，运行时原样透传）。
fn fill_schema_defaults(code: &str) -> StrategyParams {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let inst = rt
        .instantiate("sha256:fill-defaults", code, &StrategyParams::new())
        .expect("schema 提取用实例化");
    inst.params_schema()
        .iter()
        .map(|d| (d.key.clone(), ParamValue::Num(d.default)))
        .collect()
}

fn run_scores(code: &str, id: &str, bars: &[Bar]) -> Vec<f64> {
    let slot = StrategySlot::new(
        code,
        format!("sha256:template/{id}"),
        fill_schema_defaults(code),
        1.0,
    )
    .expect("合法 slot");
    let cfg = EnsembleConfig {
        slots: vec![slot],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy: ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: None,
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::D1,
        runtime_limits: RuntimeLimits::default(),
    };
    run_ensemble_with_quickjs(&cfg, bars)
        .expect("ensemble 运行成功")
        .per_bar
        .iter()
        .map(|r| r.aggregate)
        .collect()
}

#[test]
fn templates_instantiate_with_valid_schema() {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    for t in reference::official_templates() {
        let inst = rt
            .instantiate("sha256:template-check", t.code, &StrategyParams::new())
            .unwrap_or_else(|e| panic!("模板 {} 实例化失败: {e}", t.id));
        assert!(
            !inst.params_schema().is_empty(),
            "模板 {} 应声明 PARAMS_SCHEMA",
            t.id
        );
        for d in inst.params_schema() {
            assert_ne!(d.key, "position_pct", "模板 {} 不得声明 position_pct", t.id);
        }
    }
}

#[test]
fn templates_deterministic_double_run() {
    let bars = zigzag_bars(60);
    for t in reference::official_templates() {
        let first = run_scores(t.code, t.id, &bars);
        let second = run_scores(t.code, t.id, &bars);
        assert_eq!(first, second, "模板 {} 双跑分数序列不一致", t.id);
        // 分数全部在 [0,100]（host clamp 后的合法区间）。
        for (i, s) in first.iter().enumerate() {
            assert!(
                (0.0..=100.0).contains(s),
                "模板 {} bar{i} 分数越界: {s}",
                t.id
            );
        }
    }
}

/// 模板行为冒烟：两态门控模板在持仓期不得再给买入区高分（ABI §4.5 门控语义）。
#[test]
fn two_state_gate_scores_gated_by_position() {
    // 单边上行序列：trend 恒向上；首次空仓给 80 → 成交后持仓期应回落到中立 50。
    let bars: Vec<Bar> = (0..40)
        .map(|i| {
            let c = 10.0 + i as f64 * 0.5;
            Bar {
                ts: 1_700_000_000 + i * 86_400,
                open: c,
                high: c + 0.2,
                low: c - 0.2,
                close: c,
                volume: 10_000.0,
            }
        })
        .collect();
    let t = reference::official_templates()
        .into_iter()
        .find(|t| t.id == "two_state_gate")
        .expect("模板存在");
    let slot = StrategySlot::new(
        t.code,
        "sha256:template/two_state_gate",
        fill_schema_defaults(t.code),
        1.0,
    )
    .expect("合法 slot");
    let cfg = EnsembleConfig {
        slots: vec![slot],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy: ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: None,
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::D1,
        runtime_limits: RuntimeLimits::default(),
    };
    let res = run_ensemble_with_quickjs(&cfg, &bars).expect("运行成功");
    // 均线可用后首次空仓 bar 给 80；买入成交后的持仓 bar 应给 50（门控关闭）。
    let scores: Vec<f64> = res.per_bar.iter().map(|r| r.aggregate).collect();
    let first_80 = scores
        .iter()
        .position(|&s| s == 80.0)
        .expect("应出现买入区高分");
    // 防空转守卫：skip(first_80 + 2) 后必须有实际迭代区间（MAJOR-1：旧 bars (0..20) 下
    // first_80=19 → skip(21) 零迭代，门控断言形同虚设，持仓分支变异为恒 80 也照样绿）。
    assert!(
        first_80 + 2 < scores.len(),
        "门控断言区间为空（first_80={first_80}，len={}）——测试假覆盖",
        scores.len()
    );
    // 成交在次 bar open；成交后聚合分应为 50（持仓期中立）。
    for (i, &s) in scores.iter().enumerate().skip(first_80 + 2) {
        assert_eq!(s, 50.0, "持仓期（bar{i}）应为中立分 50（门控），实际 {s}");
    }
}
