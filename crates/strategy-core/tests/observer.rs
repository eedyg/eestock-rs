//! EnsembleEngine 观察者钩子测试（P3a 架构裁决 2026-09-09 批准的 strategy-core 增量加法）。
//!
//! 契约：`run_ensemble_with_observer(cfg, bars, rt, observer)`——observer 在每 bar 末
//! （步骤 8 记录后）调用一次，签名 `(bar_index, total) -> LoopControl`；返回 `Break` →
//! 引擎立即跳出循环（不做期末强平、不产出结果），返回 `EnsembleError::Canceled`。
//! 既有 `run_ensemble` 签名/行为零变更（内部以 no-op observer 委托同一实现）。

use backtest::{Bar, FeeModel, Period, StrategyParams};
use strategy_core::{
    run_ensemble, run_ensemble_with_observer, EnsembleConfig, EnsembleError, ExecutionPolicy,
    LoopControl, StrategySlot,
};
use strategy_runtime::{PluginError, QuickJsRuntime, RuntimeLimits};

const CONSTANT_SCORE: &str = include_str!("fixtures/constant_score.js");

fn slot(code: &str, hash: &str, weight: f64) -> StrategySlot {
    StrategySlot::new(code, hash, StrategyParams::new(), weight).expect("合法 slot")
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

fn base_cfg() -> EnsembleConfig {
    EnsembleConfig {
        slots: vec![slot(CONSTANT_SCORE, "sha256:const", 1.0)],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy: ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: None,
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::D1,
        runtime_limits: RuntimeLimits::default(),
    }
}

/// observer 每 bar 末恰调用一次，(bar_index, total) 逐 bar 递增且 total 恒定。
#[test]
fn observer_called_once_per_bar_in_order() {
    let cfg = base_cfg();
    let bars = flat_bars(7, 100.0);
    let mut calls: Vec<(usize, usize)> = Vec::new();
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let res = run_ensemble_with_observer(&cfg, &bars, &mut rt, &mut |i, total| {
        calls.push((i, total));
        LoopControl::Continue
    })
    .expect("全程 Continue 应成功");
    assert_eq!(res.per_bar.len(), 7);
    assert_eq!(
        calls,
        (0..7).map(|i| (i, 7)).collect::<Vec<_>>(),
        "observer 调用序列应为 (0,7)..(6,7)"
    );
}

/// 中途 Break → Err(EnsembleError::Canceled)，不产出结果（无部分结果泄漏）。
#[test]
fn observer_break_cancels_run_without_result() {
    let cfg = base_cfg();
    let bars = flat_bars(10, 100.0);
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let err = run_ensemble_with_observer(&cfg, &bars, &mut rt, &mut |i, _total| {
        if i >= 2 {
            LoopControl::Break
        } else {
            LoopControl::Continue
        }
    })
    .expect_err("Break 应取消运行");
    assert!(
        matches!(err, EnsembleError::Canceled),
        "应为 EnsembleError::Canceled，实际 {err:?}"
    );
}

/// 首 bar 即 Break → Canceled（边界：index 0）。
#[test]
fn observer_break_at_first_bar() {
    let cfg = base_cfg();
    let bars = flat_bars(3, 100.0);
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let err = run_ensemble_with_observer(&cfg, &bars, &mut rt, &mut |_i, _t| LoopControl::Break)
        .expect_err("首 bar Break 应取消");
    assert!(matches!(err, EnsembleError::Canceled));
}

/// 全程 Continue 的 observer 路径与既有 run_ensemble 结果逐点相等（委托同一实现，零行为漂移）。
#[test]
fn observer_continue_all_matches_run_ensemble() {
    let cfg = base_cfg();
    let bars = flat_bars(6, 100.0);
    let mut rt1 = QuickJsRuntime::new(cfg.runtime_limits);
    let expected = run_ensemble(&cfg, &bars, &mut rt1).expect("run_ensemble 成功");
    let mut rt2 = QuickJsRuntime::new(cfg.runtime_limits);
    let got = run_ensemble_with_observer(&cfg, &bars, &mut rt2, &mut |_i, _t| {
        LoopControl::Continue
    })
    .expect("observer 路径成功");
    assert_eq!(got, expected, "observer 全 Continue 与 run_ensemble 结果应一致");
}

/// 实例化失败（配置级错误）经 EnsembleError::Plugin 包装；From<PluginError> 转换可用。
#[test]
fn plugin_error_wraps_into_ensemble_error() {
    let mut cfg = base_cfg();
    cfg.slots = vec![slot("function not_on_bar() { return 1; }", "sha256:bad", 1.0)];
    let bars = flat_bars(3, 100.0);
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let err = run_ensemble_with_observer(&cfg, &bars, &mut rt, &mut |_i, _t| {
        LoopControl::Continue
    })
    .expect_err("实例化失败应报错");
    assert!(
        matches!(err, EnsembleError::Plugin(_)),
        "应为 EnsembleError::Plugin，实际 {err:?}"
    );
    // From<PluginError> 转换（裁决契约第 2 条）。
    let pe = PluginError::SchemaError("x".into());
    let ee: EnsembleError = pe.into();
    assert!(matches!(ee, EnsembleError::Plugin(PluginError::SchemaError(_))));
    // 既有 run_ensemble 仍返回裸 PluginError（签名/行为零变更）。
    let mut rt2 = QuickJsRuntime::new(cfg.runtime_limits);
    let err2 = run_ensemble(&cfg, &bars, &mut rt2).expect_err("run_ensemble 实例化失败应报错");
    assert!(
        matches!(err2, PluginError::JsException(_) | PluginError::SchemaError(_)),
        "run_ensemble 仍返回 PluginError: {err2:?}"
    );
}

/// EnsembleError 实现 Display + std::error::Error（application 层 anyhow 链式上报前提）。
#[test]
fn ensemble_error_is_std_error() {
    fn assert_std_error<T: std::error::Error>() {}
    assert_std_error::<EnsembleError>();
    let e = EnsembleError::Canceled;
    let msg = format!("{e}");
    assert!(msg.contains("取消") || msg.to_lowercase().contains("cancel"), "Display 应可读: {msg}");
}
