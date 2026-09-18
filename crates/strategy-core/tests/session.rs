//! ADR-024 P2（D5/D7）—— 引擎**会话化** `EnsembleSession` 的等价性与取消语义。
//!
//! 判据来源：`design/16-backtest-scalability/03-test-plan.md`
//! - §1.1 **A 层 bitwise**：会话式逐 bar `push` 的结果必须与既有批式入口逐字段相等；
//! - P2 清单「分块喂入（chunk 边界 1/2/5000/非整除）与一次性喂入输出等价（A 层）」；
//! - P2 清单「取消：仍**每 bar** 生效（不得退化为 chunk 边界）；取消后不落 succeeded」
//!   （observer 参数 `(bar_index, total)` 与 `LoopControl::Break` 立即跳出，见 `engine.rs` 文档）。
//!
//! 既有批式入口（`run_ensemble` / `run_ensemble_with_observer` / `run_ensemble_with_quickjs_observed`）
//! 签名与行为零变更（内部改为会话的薄封装）——本文件的对照即该契约的回归守护。

use backtest::{Bar, FeeModel, ParamValue, Period, StrategyParams};
use strategy_core::reference::reference_plugins;
use strategy_core::engine::run_ensemble_with_quickjs;
use strategy_core::{
    run_ensemble_with_observer, EnsembleConfig, EnsembleError, EnsembleSession, EnsembleResult,
    ExecutionPolicy, LoopControl, StopConfig, StopKind, StopTrigger, StrategySlot,
};
use strategy_runtime::{QuickJsRuntime, RuntimeLimits};

fn ref_code(id: &str) -> &'static str {
    reference_plugins()
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.code)
        .unwrap_or_else(|| panic!("参考插件 {id} 不存在"))
}

fn slot(id: &str, params: &[(&str, f64)], weight: f64) -> StrategySlot {
    let mut p = StrategyParams::new();
    for (k, v) in params {
        p.insert((*k).to_string(), ParamValue::Num(*v));
    }
    StrategySlot::new(ref_code(id), format!("sha256:{id}"), p, weight).expect("合法 slot")
}

/// 决定性「近真实」序列（LCG，无 RNG/时间依赖）：含趋势段、回调段与平盘段。
fn series(n: usize) -> Vec<Bar> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut close = 3.5_f64;
    (0..n)
        .map(|i| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let step = ((state >> 33) % 41) as f64 - 20.0; // -20..=20
            close = (close + step * 0.0005).max(0.1);
            let hi = close + 0.002 + ((state >> 21) % 5) as f64 * 0.0005;
            let lo = close - 0.002 - ((state >> 11) % 5) as f64 * 0.0005;
            Bar {
                ts: 1_600_000_000 + i as i64 * 300,
                open: close - 0.001,
                high: hi,
                low: lo,
                close,
                volume: 100_000.0 + i as f64,
            }
        })
        .collect()
}

/// 三 slot（dual_ma / macd / kdj，覆盖多 slot 聚合路径）+ ATR 硬止损 + warmup 的配置。
fn base_cfg(warmup_bars: usize) -> EnsembleConfig {
    EnsembleConfig {
        slots: vec![
            slot("dual_ma", &[("fast", 5.0), ("slow", 20.0)], 1.0),
            slot("macd", &[("fast", 12.0), ("slow", 26.0)], 0.5),
            slot("kdj", &[("n", 9.0), ("k_period", 3.0), ("d_period", 3.0)], 1.5),
        ],
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy: ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: Some(StopConfig {
            kind: StopKind::Atr,
            value: 2.0,
            trigger: StopTrigger::Intrabar,
        }),
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::M5,
        warmup_bars,
        runtime_limits: RuntimeLimits::default(),
    }
}

/// 会话式逐 bar push（含 observer 每 bar 调用）→ 结果；与批式入口逐字段相等。
#[test]
fn session_push_matches_batch_entry_bitwise() {
    let cfg = base_cfg(30);
    let bars = series(600);

    let expected = run_ensemble_with_quickjs(&cfg, &bars).expect("批式入口应成功");

    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let mut session = EnsembleSession::new(&cfg, &mut rt).expect("会话构造应成功");
    session.set_total_hint(bars.len());
    let mut calls: Vec<(usize, usize)> = Vec::new();
    let mut pushed: Vec<strategy_core::BarRecord> = Vec::new();
    for bar in &bars {
        let rec = session.push(bar);
        calls.push((session.bars_seen() - 1, bars.len()));
        pushed.push(rec);
    }
    assert_eq!(
        calls,
        (0..bars.len()).map(|i| (i, bars.len())).collect::<Vec<_>>(),
        "push 逐 bar 记录与批式循环的 bar_index/total 序列应一致"
    );
    assert_eq!(
        session.records(),
        pushed.as_slice(),
        "push 返回值应与会话内部记录一致（同一记录）"
    );
    let got = session.finish();
    assert_eq!(
        got, expected,
        "会话式 push 结果必须与既有批式入口逐字段（A 层 bitwise）相等"
    );
}

/// 批式入口的内部实现改为会话薄封装后，observer 仍**每 bar** 调用、参数仍为 (bar_index, total)。
#[test]
fn session_observer_called_per_bar_and_break_is_immediate() {
    let cfg = base_cfg(0);
    let bars = series(40);

    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let mut session = EnsembleSession::new(&cfg, &mut rt).expect("会话构造应成功");
    session.set_total_hint(bars.len());
    let mut calls: Vec<(usize, usize)> = Vec::new();
    let err = session
        .push_batch(&bars, &mut |i, total| {
            calls.push((i, total));
            if i >= 7 {
                LoopControl::Break
            } else {
                LoopControl::Continue
            }
        })
        .expect_err("Break 应取消运行");
    assert!(matches!(err, EnsembleError::Canceled), "应为 Canceled: {err:?}");
    assert_eq!(
        calls,
        (0..=7).map(|i| (i, bars.len())).collect::<Vec<_>>(),
        "Break 必须**立即**跳出（第 8 次回调后不再调用），且 total 恒定"
    );

    // 对照：既有批式入口同一 Break 语义（既有测试 observer.rs 同型断言的回归确认）。
    let mut rt2 = QuickJsRuntime::new(cfg.runtime_limits);
    let err2 = run_ensemble_with_observer(&cfg, &bars, &mut rt2, &mut |i, _t| {
        if i >= 7 {
            LoopControl::Break
        } else {
            LoopControl::Continue
        }
    })
    .expect_err("Break 应取消");
    assert!(matches!(err2, EnsembleError::Canceled));
}

/// **分块喂入**（chunk 边界 1 / 2 / 5000 / 非整除）与一次性喂入输出等价（A 层）。
#[test]
fn session_chunked_feed_matches_single_feed() {
    let cfg = base_cfg(20);
    let bars = series(137); // 非整除：137 = 50+50+37；且含 chunk=5000（大于总量）

    let expected: EnsembleResult = run_ensemble_with_quickjs(&cfg, &bars).expect("一次性喂入");

    for chunk in [1usize, 2, 3, 5000] {
        let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
        let mut session = EnsembleSession::new(&cfg, &mut rt).expect("会话构造应成功");
        for piece in bars.chunks(chunk) {
            session
                .push_batch(piece, &mut |_i, _t| LoopControl::Continue)
                .expect("分块喂入应成功");
        }
        assert_eq!(
            session.finish(),
            expected,
            "chunk={chunk} 分块喂入结果必须与一次性喂入逐字段相等"
        );
    }

    // push_batch 的 observer total：流式语义（未声明总量时 = 已喂入 bar 数）。
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let mut session = EnsembleSession::new(&cfg, &mut rt).expect("会话构造应成功");
    let mut totals: Vec<usize> = Vec::new();
    for piece in bars.chunks(50) {
        session
            .push_batch(piece, &mut |_i, total| {
                totals.push(total);
                LoopControl::Continue
            })
            .expect("分块喂入应成功");
    }
    assert_eq!(
        totals,
        (1..=bars.len()).collect::<Vec<_>>(),
        "未声明 total_hint 时 total = 已喂入 bar 数（流式语义：observer 仍**每 bar** 调用）"
    );
}

/// 边界：零 bar 与单 bar（warmup ≥ 总 bar 数 → 全 warmup，不产订单/净值）。
#[test]
fn session_handles_empty_single_and_warmup_overflow() {
    for (n, warmup) in [(0usize, 0usize), (1, 0), (1, 5), (10, 50)] {
        let cfg = base_cfg(warmup);
        let bars = series(n);
        let expected = run_ensemble_with_quickjs(&cfg, &bars).expect("批式入口应成功");
        let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
        let mut session = EnsembleSession::new(&cfg, &mut rt).expect("会话构造应成功");
        session
            .push_batch(&bars, &mut |_i, _t| LoopControl::Continue)
            .expect("喂入应成功");
        assert_eq!(session.finish(), expected, "n={n} warmup={warmup} 应等价");
        if warmup >= n {
            assert!(
                expected.per_bar.iter().all(|r| r.warmup),
                "n={n} warmup={warmup}: warmup ≥ 总 bar 数 ⇒ 全部 bar 标 warmup"
            );
            assert!(expected.net_value.is_empty(), "全 warmup 段不计净值");
            assert!(
                expected.per_bar.iter().all(|r| r.orders.is_empty()),
                "全 warmup 段不产订单"
            );
        }
    }
}

/// 期末强平：会话 `finish()` 与批式入口同样在最后一个 close 强平（净值末点 = 已实现净值）。
#[test]
fn session_finish_force_closes_open_position() {
    let cfg = base_cfg(0);
    // 恒定低价 + 常量高分插件（持仓必然留存到期末）。
    let mut cfg2 = cfg.clone();
    cfg2.slots = vec![slot("dual_ma", &[("fast", 1.0), ("slow", 2.0)], 1.0)];
    cfg2.stop = None;
    let bars = series(25);

    let expected = run_ensemble_with_quickjs(&cfg2, &bars).expect("批式入口应成功");
    let mut rt = QuickJsRuntime::new(cfg2.runtime_limits);
    let mut session = EnsembleSession::new(&cfg2, &mut rt).expect("会话构造应成功");
    session
        .push_batch(&bars, &mut |_i, _t| LoopControl::Continue)
        .expect("喂入应成功");
    let got = session.finish();
    assert_eq!(got, expected);
    assert!(
        expected.trades.iter().all(|t| t.close_bar < bars.len()),
        "期末强平交易应落在最后一根 bar"
    );
}

/// 共享缓冲的**当前 bar 索引正确性**（引擎真实路径 + 真实 QuickJS 插件）：
/// 插件返回 `ctx.indicators.ma(1)`（= 窗口最后一根 = 当前 bar 收盘价）；
/// 若共享缓冲错位/丢当前 bar（off-by-one）或注入的是未来数据，本断言必然变红。
#[test]
fn session_shared_history_exposes_current_bar_to_plugin() {
    let bars = series(50);
    let mut cfg = base_cfg(0);
    cfg.slots = vec![StrategySlot::new(
        "function on_bar(ctx) { return ctx.indicators.ma(1); }",
        "sha256:ma1",
        StrategyParams::new(),
        1.0,
    )
    .expect("合法 slot")];
    cfg.stop = None;

    // 会话路径（共享缓冲注入）
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let mut session = EnsembleSession::new(&cfg, &mut rt).expect("会话构造应成功");
    for bar in &bars {
        session.push(bar);
    }
    let out = session.finish();
    assert_eq!(out.per_bar.len(), bars.len());
    for (i, rec) in out.per_bar.iter().enumerate() {
        assert_eq!(rec.scores.len(), 1);
        assert_eq!(
            rec.scores[0].score.to_bits(),
            bars[i].close.to_bits(),
            "bar {i}: ma(1) 必须等于当前 bar 收盘价（共享缓冲须含且仅含 bars[0..=i]）"
        );
        assert_eq!(rec.aggregate.to_bits(), bars[i].close.to_bits());
    }

    // 批式入口（同一口径；薄封装 ⇒ 必须逐 bar 相同）
    let expected = run_ensemble_with_quickjs(&cfg, &bars).expect("批式入口应成功");
    assert_eq!(out, expected);
}

/// warmup 段的**绝对口径**（不只与批式入口一致）：前 `warmup` 根标 warmup、不产订单、不计净值。
///
/// 反向证据：把会话的 `is_warmup = i < warmup_bars` 改成 `<=` ⇒ 本测试必须变红
/// （见报告 §反向证据 13d）。
#[test]
fn session_warmup_marker_is_exact() {
    for warmup in [0usize, 1, 3, 10] {
        let cfg = base_cfg(warmup);
        let bars = series(10);
        let res = run_ensemble_with_quickjs(&cfg, &bars).expect("批式入口应成功");
        assert_eq!(
            res.per_bar.iter().filter(|r| r.warmup).count(),
            warmup.min(bars.len()),
            "warmup={warmup}: warmup 标记根数应恰为 min(warmup_bars, n)"
        );
        for (i, r) in res.per_bar.iter().enumerate() {
            assert_eq!(r.warmup, i < warmup, "warmup={warmup} bar {i} 标记错误");
            if i < warmup {
                assert!(r.orders.is_empty(), "warmup 段不得产订单");
            }
        }
        assert_eq!(
            res.net_value.len(),
            bars.len().saturating_sub(warmup),
            "warmup={warmup}: 净值序列只含 in-range bar"
        );
    }
}
