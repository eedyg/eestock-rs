//! ADR-024 P2（D7）—— 插件 ABI 共享历史缓冲 `BarHistory` 语义与"零 ABI 变更"取证。
//!
//! 判据来源：
//! - `03-test-plan.md` P2 清单：「共享缓冲：`ctx.bars` 语义不变（插件按 `bars[0]`/`bars[i]`
//!   取值仍正确）」；
//! - 任务书 P2(A)：「ABI 语义不得变：`ctx.bars` 仍表示**从第 0 根到当前 index 的全量历史**」。
//!
//! 本文件锁定：
//! 1. `BarHistory` 的**前缀增长**语义（`len == index+1`；`bars[0]` = 首根；`bars[index]` = 当前 bar）；
//! 2. 宿主侧 `BarCtx.bars`（插件可见的历史视图）在共享句柄与兼容路径下**取值一致**；
//! 3. 共享句柄路径与兼容路径（`BarCtx::new` 逐 bar 复制）的插件评分**位级一致**；
//! 4. `BarHistory` 的 7 个指标访问器与切片视图 `Indicators` 位级一致（wiring 正确性）。

use backtest::{Bar, Indicators, OnlineIndicators, ParamValue, StrategyParams};
use strategy_runtime::{
    BarCtx, BarHistory, ParamDef, PluginError, PluginInstance, PluginRuntime,
    PositionSnapshot,
};

/// 每 bar 调全部指标（覆盖 7 条指标路径）。
const INDICATOR_MIX: &str = r#"
function on_bar(ctx) {
  const i = ctx.indicators;
  const ma = i.ma(ctx.params.ma_n);
  const ema = i.ema(ctx.params.ema_n);
  const rsi = i.rsi(ctx.params.rsi_n);
  const m = i.macd();
  const a = i.atr(ctx.params.atr_n);
  const k = i.kdj();
  const bl = i.boll(ctx.params.boll_n, 2.0);
  if (ma === null || ema === null || rsi === null || m === null || a === null || k === null || bl === null) {
    return 50;
  }
  const raw = 50 + (ma - ema) + (rsi - 50) * 0.5 + m.macd * 10 + a * 0.1 + (k.k - k.d) + (bl.upper - bl.lower);
  if (raw > 100) { return 100; }
  if (raw < 0) { return 0; }
  return raw;
}
"#;

fn params() -> StrategyParams {
    StrategyParams::from([
        ("ma_n".to_string(), ParamValue::Num(20.0)),
        ("ema_n".to_string(), ParamValue::Num(20.0)),
        ("rsi_n".to_string(), ParamValue::Num(14.0)),
        ("atr_n".to_string(), ParamValue::Num(14.0)),
        ("boll_n".to_string(), ParamValue::Num(20.0)),
    ])
}

/// 决定性「近真实」序列（LCG；含 close 不变段与 high==low 平台段）。
fn series(n: usize) -> Vec<Bar> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut close = 3.5_f64;
    (0..n)
        .map(|i| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            if i % 29 != 0 {
                let step = ((state >> 33) % 41) as f64 - 20.0;
                close = (close + step * 0.0005).max(0.1);
            }
            let (open, high, low, c) = if (150..160).contains(&i) {
                (10.0, 10.0, 10.0, 10.0)
            } else {
                (
                    close - 0.001,
                    close + 0.003,
                    close - 0.003,
                    close,
                )
            };
            Bar {
                ts: 1_600_000_000 + i as i64 * 60,
                open,
                high,
                low,
                close: c,
                volume: 100_000.0 + i as f64,
            }
        })
        .collect()
}

/// 记录 `ctx.bars`（宿主侧历史视图）的探针插件：不做任何指标计算。
#[derive(Debug, Default)]
struct BarsProbe {
    /// 每 bar：`(index, bars.len(), bars[0].ts, bars[index].ts, bars[index] == ctx.bar)`
    seen: Vec<(usize, usize, i64, i64, bool)>,
}

impl PluginInstance for BarsProbe {
    fn on_bar(&mut self, ctx: &BarCtx<'_>) -> Result<f64, PluginError> {
        let i = ctx.index;
        let bars = ctx.bars;
        assert!(
            i < bars.len(),
            "ctx.bars 必须至少覆盖到 index（index={i}, len={}）",
            bars.len()
        );
        self.seen.push((
            i,
            bars.len(),
            bars[0].ts,
            bars[i].ts,
            bars[i] == ctx.bar,
        ));
        Ok(50.0)
    }

    fn save(&self) -> Result<Option<serde_json::Value>, PluginError> {
        Ok(None)
    }

    fn load(&mut self, _state: &serde_json::Value) -> Result<(), PluginError> {
        Ok(())
    }

    fn params_schema(&self) -> &[ParamDef] {
        &[]
    }
}

/// `BarHistory` = 「从第 0 根到当前 index 的全量历史」：逐 bar push 后前缀必须精确。
#[test]
fn bar_history_grows_as_exact_prefix() {
    let bars = series(50);
    let hist = BarHistory::new();
    assert!(hist.is_empty(), "初始应为空");
    for (i, bar) in bars.iter().enumerate() {
        hist.push(bar.clone());
        assert_eq!(hist.len(), i + 1, "push 后长度应等于 index+1");
        hist.with_slice(|s| {
            assert_eq!(s[0], bars[0], "bars[0] 必须是首根");
            assert_eq!(s[i], bars[i], "bars[index] 必须是当前 bar");
            assert_eq!(s[s.len() - 1], bars[i], "末元素必须是当前 bar");
        });
    }
    // 单根边界
    let one = BarHistory::from_bars(&bars[..1]);
    assert_eq!(one.len(), 1);
    one.with_slice(|s| assert_eq!(s[0], bars[0]));
}

/// 宿主侧 `ctx.bars` 前缀语义（插件可见视图）：引擎会话路径下 len == index+1 且逐根一致。
#[test]
fn ctx_bars_is_prefix_consistent_with_shared_history() {
    let bars = series(300);
    let hist = BarHistory::new();
    let mut probe = BarsProbe::default();
    for (i, bar) in bars.iter().enumerate() {
        hist.push(bar.clone());
        let ctx = BarCtx::new(i, bar.clone(), &bars[..=i], None).with_history(hist.clone());
        probe.on_bar(&ctx).expect("探针不应出错");
    }
    assert_eq!(probe.seen.len(), bars.len());
    for (i, (idx, len, first_ts, cur_ts, is_cur)) in probe.seen.iter().enumerate() {
        assert_eq!(*idx, i);
        assert_eq!(*len, i + 1, "共享缓冲路径：bars 长度 = index+1（不含未来 bar，无前视）");
        assert_eq!(*first_ts, bars[0].ts, "bars[0] 恒为首根");
        assert_eq!(*cur_ts, bars[i].ts, "bars[index] 恒为当前 bar");
        assert!(*is_cur, "bars[index] 必须与 ctx.bar 为同一根");
    }
}

/// 兼容路径（`BarCtx::new`，无共享句柄）语义不变：`bars` 为调用方传入的切片，取值仍正确。
#[test]
fn compat_path_ctx_bars_unchanged() {
    let bars = series(5);
    let mut probe = BarsProbe::default();
    for (i, bar) in bars.iter().enumerate() {
        let ctx = BarCtx::new(i, bar.clone(), &bars, None);
        probe.on_bar(&ctx).expect("探针不应出错");
    }
    assert_eq!(
        probe.seen,
        vec![
            (0, 5, bars[0].ts, bars[0].ts, true),
            (1, 5, bars[0].ts, bars[1].ts, true),
            (2, 5, bars[0].ts, bars[2].ts, true),
            (3, 5, bars[0].ts, bars[3].ts, true),
            (4, 5, bars[0].ts, bars[4].ts, true),
        ],
        "兼容路径：传入全量切片时 bars.len() 仍为切片长度（改造前行为，ABI 未变）"
    );
}

/// 空 / 单根边界：空历史 `len == 0`；单根时插件（index 0）取值正确。
#[test]
fn empty_and_single_bar_boundaries() {
    let hist = BarHistory::new();
    assert!(hist.is_empty());
    hist.with_slice(|s| assert!(s.is_empty()));

    let bars = series(1);
    let hist = BarHistory::new();
    hist.push(bars[0].clone());
    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None).with_history(hist.clone());
    let mut rt = strategy_runtime::QuickJsRuntime::new(strategy_runtime::RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:indicator_mix", INDICATOR_MIX, &params())
        .expect("实例化成功");
    let score = inst.on_bar(&ctx).expect("单根 bar 不应出错");
    assert_eq!(score, 50.0, "单根 bar 时全部指标数据不足 → 中立 50");

    // 单根 bar 下共享句柄与兼容路径评分一致
    let ctx_compat = BarCtx::new(0, bars[0].clone(), &bars, None);
    let mut rt2 = strategy_runtime::QuickJsRuntime::new(strategy_runtime::RuntimeLimits::default());
    let mut inst2 = rt2
        .instantiate("sha256:indicator_mix", INDICATOR_MIX, &params())
        .expect("实例化成功");
    let score2 = inst2.on_bar(&ctx_compat).expect("单根 bar 不应出错");
    assert_eq!(score.to_bits(), score2.to_bits());
}

/// 共享句柄路径 vs 兼容路径：同插件同序列评分**位级一致**（零 ABI/口径漂移）。
#[test]
fn shared_history_scores_bitwise_equal_to_compat_path() {
    let bars = series(200);

    // 路径 A：共享历史缓冲（引擎会话路径）
    let hist = BarHistory::new();
    let mut rt_a = strategy_runtime::QuickJsRuntime::new(strategy_runtime::RuntimeLimits::default());
    let mut inst_a = rt_a
        .instantiate("sha256:indicator_mix", INDICATOR_MIX, &params())
        .expect("实例化成功");
    let mut scores_a = Vec::with_capacity(bars.len());
    for (i, bar) in bars.iter().enumerate() {
        hist.push(bar.clone());
        let ctx = BarCtx::new(i, bar.clone(), &bars[..=i], None).with_history(hist.clone());
        scores_a.push(inst_a.on_bar(&ctx).expect("不应出错"));
    }

    // 路径 B：兼容路径（每 bar 传入全量切片，运行时内部按 bars[..=index] 建一次性缓冲）
    let mut rt_b = strategy_runtime::QuickJsRuntime::new(strategy_runtime::RuntimeLimits::default());
    let mut inst_b = rt_b
        .instantiate("sha256:indicator_mix", INDICATOR_MIX, &params())
        .expect("实例化成功");
    let mut scores_b = Vec::with_capacity(bars.len());
    for (i, bar) in bars.iter().enumerate() {
        let ctx = BarCtx::new(i, bar.clone(), &bars, None);
        scores_b.push(inst_b.on_bar(&ctx).expect("不应出错"));
    }

    assert_eq!(scores_a.len(), scores_b.len());
    for (i, (a, b)) in scores_a.iter().zip(scores_b.iter()).enumerate() {
        assert_eq!(
            a.to_bits(),
            b.to_bits(),
            "bar {i}: 共享缓冲路径 {a:?} 与兼容路径 {b:?} 位级不一致"
        );
    }
}

/// 会话路径下 `ctx.position` 注入与既有 ABI §2.5 口径一致（共享缓冲不得影响持仓全景）。
#[test]
fn shared_history_keeps_position_snapshot() {
    let bars = series(10);
    let hist = BarHistory::new();
    for bar in &bars {
        hist.push(bar.clone());
    }
    let pos = PositionSnapshot {
        qty: 100.0,
        avg_cost: 3.5,
        entry_ts: bars[0].ts,
        bars_since_entry: 3,
        unrealized_pnl: 12.0,
    };
    let ctx = BarCtx::new(9, bars[9].clone(), &bars, Some(pos)).with_history(hist.clone());
    let mut rt = strategy_runtime::QuickJsRuntime::new(strategy_runtime::RuntimeLimits::default());
    let mut inst = rt
        .instantiate(
            "sha256:pos_probe",
            "function on_bar(ctx) { return ctx.position === null ? 0 : ctx.position.qty; }",
            &StrategyParams::new(),
        )
        .expect("实例化成功");
    assert_eq!(inst.on_bar(&ctx).expect("不应出错"), 100.0);
    assert!(ctx.shared_history().is_some(), "注入后应可见共享句柄");
    assert!(BarCtx::new(0, bars[0].clone(), &bars, None)
        .shared_history()
        .is_none());
}

/// `BarHistory` 指标访问器 == 切片视图 `Indicators`（含 `index >= len` 的 None 口径）。
#[test]
fn bar_history_indicators_match_slice_view() {
    let bars = series(400);
    let hist = BarHistory::new();
    let mut online = OnlineIndicators::new();
    for (i, bar) in bars.iter().enumerate() {
        hist.push(bar.clone());
        for period in [1usize, 3, 20] {
            assert_eq!(
                hist.ma(i, period).map(f64::to_bits),
                indicators_ma(&bars, i, period).map(f64::to_bits),
                "ma({period}) @i={i}"
            );
            assert_eq!(
                hist.ema(i, period).map(f64::to_bits),
                online.ema(&bars, i, period).map(f64::to_bits),
                "ema({period}) @i={i}"
            );
            assert_eq!(
                hist.rsi(i, period).map(f64::to_bits),
                online.rsi(&bars, i, period).map(f64::to_bits),
                "rsi({period}) @i={i}"
            );
            assert_eq!(
                hist.atr(i, period).map(f64::to_bits),
                online.atr(&bars, i, period).map(f64::to_bits),
                "atr({period}) @i={i}"
            );
        }
        let m_slice = Indicators::new(&bars, i).macd(12, 26, 9).map(|m| m.dif);
        assert_eq!(
            hist.macd(i, 12, 26, 9).map(|m| m.dif.to_bits()),
            m_slice.map(f64::to_bits),
            "macd @i={i}"
        );
        let k_slice = Indicators::new(&bars, i).kdj(9, 3, 3).map(|k| k.k);
        assert_eq!(
            hist.kdj(i, 9, 3, 3).map(|k| k.k.to_bits()),
            k_slice.map(f64::to_bits),
            "kdj @i={i}"
        );
        let b_slice = Indicators::new(&bars, i).boll(20, 2.0).map(|b| b.mid);
        assert_eq!(
            hist.boll(i, 20, 2.0).map(|b| b.mid.to_bits()),
            b_slice.map(f64::to_bits),
            "boll @i={i}"
        );
    }
    // 越界（数据尚未喂到）→ None，不 panic
    assert!(hist.ema(400, 20).is_none());
    assert!(hist.rsi(400, 14).is_none());
    assert!(hist.atr(400, 14).is_none());
    assert!(hist.macd(400, 12, 26, 9).is_none());
    assert!(hist.kdj(400, 9, 3, 3).is_none());
    assert!(hist.ma(400, 5).is_none());
    assert!(hist.boll(400, 20, 2.0).is_none());
}

fn indicators_ma(bars: &[Bar], i: usize, period: usize) -> Option<f64> {
    Indicators::new(bars, i).ma(period)
}
