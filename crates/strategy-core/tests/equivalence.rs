//! 迁移等价性测试（ADR 12-strategy-system §7 验收标准 / §9 TDD 规格）。
//!
//! 口径：**信号序列逐 bar 一致**——
//! - Rust 侧：`backtest::Engine` 跑内建策略（经 Recorder 包装记录每 bar 原始 Signal）；
//! - JS 侧：参考插件单 slot `EnsembleEngine`（weight=1，阈值 60/40，`LumpSum{pct:1.0}`，
//!   同 `FeeModel::default()`、同 initial_capital），取 `per_bar[i].signal`；
//! - 映射：插件分数 Buy→80 / Sell→20 / Hold→50，故 80≥60 ↔ Buy、20≤40 ↔ Sell、50 ↔ Hold
//!   （逐款插件头注释亦注明该等价性依据）。
//!
//! golden bars：全部手工构造确定性字面量序列（无 RNG / 无时钟），逐款覆盖各分支
//! （金叉/死叉/上下轨穿越/过滤分支/止损触发/通道离场等）；构造意图见各测试注释。
//! 另附默认参数长序列抽查（确定性锯齿生成器，无 RNG）覆盖长周期口径。
//!
//! 端到端断言：每款至少 1 条交易相等（开/平仓 bar 一致；价格口径差异已排除——
//! 同 FeeModel、同「close 判定、次 bar open 成交」规则，仅比较 bar 序号与笔数）。

use backtest::{
    create_strategy, Bar, Engine, FeeModel, ParamValue, Period, RunConfig, Signal, Strategy,
    StrategyParams, TradeDetail,
};
use strategy_core::engine::run_ensemble_with_quickjs;
use strategy_core::{reference, EnsembleConfig, ExecutionPolicy, StrategySlot, TradeSignal};
use strategy_runtime::{BarCtx, PluginRuntime, QuickJsRuntime, RuntimeLimits};

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/// 手工构造 bar（ts 由序号推出，确定性）。
fn bar(i: i64, open: f64, high: f64, low: f64, close: f64) -> Bar {
    Bar {
        ts: 1_700_000_000 + i * 86_400,
        open,
        high,
        low,
        close,
        volume: 10_000.0,
    }
}

/// 等宽 bar（open=high=low=close=price）。
fn flat(i: i64, price: f64) -> Bar {
    bar(i, price, price, price, price)
}

/// 由收盘价序列生成等宽 bar。
fn flat_bars(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| flat(i as i64, c))
        .collect()
}

/// 带上下影线的 bar 序列（high=close+0.5, low=close−0.5；沿用 Rust 内建策略单测口径）。
fn shadow_bars(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| bar(i as i64, c, c + 0.5, c - 0.5, c))
        .collect()
}

/// 确定性锯齿长序列（无 RNG/无时钟）：close 在 9..=13 以 8 为周期三角波振荡，
/// 用于默认参数（长周期）下的等价性抽查。
fn zigzag_bars(n: usize) -> Vec<Bar> {
    (0..n)
        .map(|i| {
            let t = (i % 8) as f64;
            let off = if t <= 4.0 { t } else { 8.0 - t };
            let c = 9.0 + off;
            bar(i as i64, c, c + 0.3, c - 0.3, c)
        })
        .collect()
}

fn nums(pairs: &[(&str, f64)]) -> StrategyParams {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), ParamValue::Num(*v)))
        .collect()
}

/// Rust 侧信号记录器（透传内建策略，逐 bar 记录原始 Signal）。
struct Recorder {
    inner: Box<dyn Strategy>,
    signals: Vec<Signal>,
}

impl Strategy for Recorder {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn params_schema(&self) -> Vec<backtest::ParamDef> {
        self.inner.params_schema()
    }
    fn on_bar(&mut self, ctx: &mut backtest::Ctx, bar: &Bar, ind: &backtest::Indicators) -> Signal {
        let s = self.inner.on_bar(ctx, bar, ind);
        self.signals.push(s);
        s
    }
}

/// Rust 侧：`backtest::Engine` 跑内建策略，返回（逐 bar 信号序列, 交易明细）。
fn rust_run(id: &str, params: &StrategyParams, bars: &[Bar]) -> (Vec<Signal>, Vec<TradeDetail>) {
    let strat = create_strategy(id, params).unwrap_or_else(|| panic!("未知策略 id: {id}"));
    let mut rec = Recorder {
        inner: strat,
        signals: Vec::new(),
    };
    let cfg = RunConfig {
        initial_capital: 100_000.0,
        fee: FeeModel::default(),
        period: Period::D1,
    };
    let res = Engine::new(cfg).run(bars, &mut rec);
    (rec.signals, res.trades)
}

/// JS 侧参数默认值填充（ABI §1 NIT-6 裁决：schema 校验/填缺省是**消费方**职责，
/// 运行时原样透传）。本测试即消费方：缺失 key 按插件 PARAMS_SCHEMA 的 default 补齐，
/// 与 Rust 侧 `create_strategy` 的空参默认填充对齐。
fn fill_schema_defaults(code: &str, mut params: StrategyParams) -> StrategyParams {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let inst = rt
        .instantiate("sha256:fill-defaults", code, &params)
        .expect("schema 提取用实例化");
    for def in inst.params_schema() {
        params
            .entry(def.key.clone())
            .or_insert(ParamValue::Num(def.default));
    }
    params
}

/// JS 侧：单 slot EnsembleEngine（weight=1，阈值 60/40，LumpSum{1.0}，同 FeeModel）。
fn js_run(
    id: &str,
    code: &str,
    params: StrategyParams,
    bars: &[Bar],
) -> (Vec<TradeSignal>, Vec<TradeDetail>) {
    let params = fill_schema_defaults(code, params);
    let slot =
        StrategySlot::new(code, format!("sha256:reference/{id}"), params, 1.0).expect("合法 slot");
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
    let res = run_ensemble_with_quickjs(&cfg, bars).expect("ensemble 运行成功");
    (res.per_bar.iter().map(|r| r.signal).collect(), res.trades)
}

fn norm(s: &Signal) -> TradeSignal {
    match s {
        Signal::Buy(_) => TradeSignal::Buy,
        Signal::Sell => TradeSignal::Sell,
        Signal::Hold => TradeSignal::Hold,
    }
}

/// 等价性断言：信号序列逐 bar 一致 + 交易笔数与开/平仓 bar 一致。
fn assert_equivalent(
    id: &str,
    rust_params: &StrategyParams,
    js_params: StrategyParams,
    bars: &[Bar],
    expect_trade: bool,
) {
    let plugin = reference::reference_plugins()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("参考插件缺失: {id}"));
    let (rust_sigs, rust_trades) = rust_run(id, rust_params, bars);
    let (js_sigs, js_trades) = js_run(id, plugin.code, js_params, bars);

    let rust_norm: Vec<TradeSignal> = rust_sigs.iter().map(norm).collect();
    assert_eq!(
        rust_norm.len(),
        js_sigs.len(),
        "{id}: 信号序列长度不一致（rust={} js={}）",
        rust_norm.len(),
        js_sigs.len()
    );
    for (i, (r, j)) in rust_norm.iter().zip(js_sigs.iter()).enumerate() {
        assert_eq!(r, j, "{id}: bar {i} 信号不一致（rust={r:?} js={j:?}）");
    }

    assert_eq!(
        rust_trades.len(),
        js_trades.len(),
        "{id}: 交易笔数不一致（rust={} js={}）",
        rust_trades.len(),
        js_trades.len()
    );
    for (k, (rt, jt)) in rust_trades.iter().zip(js_trades.iter()).enumerate() {
        assert_eq!(rt.open_bar, jt.open_bar, "{id}: 交易{k} 开仓 bar 不一致");
        assert_eq!(rt.close_bar, jt.close_bar, "{id}: 交易{k} 平仓 bar 不一致");
    }
    if expect_trade {
        assert!(
            !rust_trades.is_empty(),
            "{id}: golden bars 应至少产生 1 条端到端交易"
        );
    }
}

fn plugin_code(id: &str) -> &'static str {
    reference::reference_plugins()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("参考插件缺失: {id}"))
        .code
}

// ---------------------------------------------------------------------------
// 1. dual_ma —— 双均线交叉（fast=2, slow=3）
// golden bars：先跌(10→8)再涨(9→11)构造金叉，再回落(10→7)构造死叉，尾 bar 供成交。
// 预期信号：[H,H,H,Buy,H,Sell,H]；交易：开仓 bar4 / 平仓 bar6。
// ---------------------------------------------------------------------------
#[test]
fn dual_ma_equivalence() {
    let bars = flat_bars(&[10.0, 8.0, 9.0, 11.0, 10.0, 7.0, 8.0]);
    let p = nums(&[("fast", 2.0), ("slow", 3.0)]);
    assert_equivalent("dual_ma", &p, p.clone(), &bars, true);
}

// ---------------------------------------------------------------------------
// 2. ma_rsi —— 均线交叉 + RSI 过滤（fast=2, slow=3, rsi_period=2, 70/30）
// 序列 A（完整交易）：缓跌后缓涨再缓跌，金叉 bar3（RSI≈66.7 <70 通过），
//   死叉 bar6（RSI≈31.6 >30 通过）；预期 [H,H,H,Buy,H,H,Sell,H]，交易 开4/平7。
// 序列 B（超买过滤金叉）：急跌后急涨 [10,6,8,14]，金叉 bar3 但 RSI≈77.8 ≥70 → 全程 Hold。
// 序列 C（超卖过滤死叉）：[8,10,12,11,7]，死叉 bar4 但 RSI≈18.2 ≤30 → 全程 Hold。
// ---------------------------------------------------------------------------
#[test]
fn ma_rsi_equivalence_trade() {
    let bars = flat_bars(&[10.0, 9.5, 9.2, 10.0, 10.8, 10.4, 10.0, 9.8]);
    let p = nums(&[
        ("fast", 2.0),
        ("slow", 3.0),
        ("rsi_period", 2.0),
        ("rsi_overbought", 70.0),
        ("rsi_oversold", 30.0),
    ]);
    assert_equivalent("ma_rsi", &p, p.clone(), &bars, true);
}

#[test]
fn ma_rsi_equivalence_overbought_blocks_cross() {
    let bars = flat_bars(&[10.0, 6.0, 8.0, 14.0]);
    let p = nums(&[
        ("fast", 2.0),
        ("slow", 3.0),
        ("rsi_period", 2.0),
        ("rsi_overbought", 70.0),
        ("rsi_oversold", 30.0),
    ]);
    assert_equivalent("ma_rsi", &p, p.clone(), &bars, false);
}

#[test]
fn ma_rsi_equivalence_oversold_blocks_cross() {
    let bars = flat_bars(&[8.0, 10.0, 12.0, 11.0, 7.0]);
    let p = nums(&[
        ("fast", 2.0),
        ("slow", 3.0),
        ("rsi_period", 2.0),
        ("rsi_overbought", 70.0),
        ("rsi_oversold", 30.0),
    ]);
    assert_equivalent("ma_rsi", &p, p.clone(), &bars, false);
}

// ---------------------------------------------------------------------------
// 3. macd —— DIF/DEA 交叉（fast=2, slow=3, signal=3）
// golden bars（沿用 Rust 单测序列）：[10,11,12,11,13,14]，含金叉(bar1)/死叉(bar3)/再金叉(bar4)。
// 预期信号：[H,Buy,H,Sell,Buy,H]；交易：(开2,平4) + (开5,期末强平平5)。
// 注：插件按 backtest::Indicators::macd 口径自持增量状态复算（host macd() 固定 12/26/9）。
// ---------------------------------------------------------------------------
#[test]
fn macd_equivalence() {
    let bars = shadow_bars(&[10.0, 11.0, 12.0, 11.0, 13.0, 14.0]);
    let p = nums(&[("fast", 2.0), ("slow", 3.0), ("signal", 3.0)]);
    assert_equivalent("macd", &p, p.clone(), &bars, true);
}

/// 默认参数（12/26/9）长序列抽查：锯齿 60 bar，信号序列与交易逐点一致。
#[test]
fn macd_equivalence_default_params_long_run() {
    let bars = zigzag_bars(60);
    let p = StrategyParams::new(); // 双侧全默认
    assert_equivalent("macd", &p, p.clone(), &bars, true);
}

// ---------------------------------------------------------------------------
// 4. boll —— 带突破（period=5, k=1.5；mode 0=mean_reversion / 1=trend）
// 序列 A（均值回归，完整交易）：[10,10,10,10,5,10,15,14]——
//   bar4 收破下轨(prev≥lower) Buy；bar6 收破上轨(prev≤upper) Sell。交易 开5/平7。
// 序列 B（趋势模式，完整交易）：[10,10,10,10,15,16,4,5]——
//   bar4 收破上轨 Buy；bar6 下破下轨 Sell。
// ---------------------------------------------------------------------------
#[test]
fn boll_equivalence_mean_reversion() {
    let bars = flat_bars(&[10.0, 10.0, 10.0, 10.0, 5.0, 10.0, 15.0, 14.0]);
    let p = nums(&[("period", 5.0), ("k", 1.5)]);
    // 不显式传 mode：Rust 默认 mean_reversion；JS mode 缺省按 0（mean_reversion）处理。
    assert_equivalent("boll", &p, p.clone(), &bars, true);
}

#[test]
fn boll_equivalence_trend_mode() {
    let bars = flat_bars(&[10.0, 10.0, 10.0, 10.0, 15.0, 16.0, 4.0, 5.0]);
    let mut rust_p = nums(&[("period", 5.0), ("k", 1.5)]);
    rust_p.insert("mode".to_string(), ParamValue::Choice("trend".to_string()));
    let js_p = nums(&[("period", 5.0), ("k", 1.5), ("mode", 1.0)]);
    assert_equivalent("boll", &rust_p, js_p, &bars, true);
}

// ---------------------------------------------------------------------------
// 5. kdj —— K/D 交叉（n=3, k_period=2, d_period=2）
// golden bars（沿用 Rust 单测序列）：[10,11,12,11,13,14]——
//   bar2 起指标可用；bar3 死叉 Sell（无持仓，双侧均被引擎忽略成交但信号一致）；
//   bar4 金叉 Buy → 开5，期末强平 平5。
// 预期信号：[H,H,H,Sell,Buy,H]。
// 注：插件按 backtest::Indicators::kdj 口径自持滚动窗 + K/D(种子50) 递推（host kdj() 固定 9/3/3）。
// ---------------------------------------------------------------------------
#[test]
fn kdj_equivalence() {
    let bars = shadow_bars(&[10.0, 11.0, 12.0, 11.0, 13.0, 14.0]);
    let p = nums(&[("n", 3.0), ("k_period", 2.0), ("d_period", 2.0)]);
    assert_equivalent("kdj", &p, p.clone(), &bars, true);
}

/// 默认参数（9/3/3）长序列抽查。
#[test]
fn kdj_equivalence_default_params_long_run() {
    let bars = zigzag_bars(60);
    let p = StrategyParams::new();
    assert_equivalent("kdj", &p, p.clone(), &bars, true);
}

// ---------------------------------------------------------------------------
// 6. momentum —— Donchian 突破（lookback=2，窗不含当前 bar）
// golden bars：b0/b1 建立通道(high 10 / low 9)；b2 close=12 破上轨 Buy；
//   b3 close=8 破下轨(min low of b1,b2 = 9) Sell；b4 供成交。
// 预期信号：[H,H,Buy,Sell,H]；交易 开3/平4。
// ---------------------------------------------------------------------------
#[test]
fn momentum_equivalence() {
    let bars = vec![
        bar(0, 10.0, 10.0, 9.0, 10.0),
        bar(1, 10.0, 10.0, 9.0, 10.0),
        bar(2, 12.0, 12.0, 11.0, 12.0),
        bar(3, 8.0, 8.5, 7.5, 8.0),
        bar(4, 8.0, 8.2, 7.8, 8.0),
    ];
    let p = nums(&[("lookback", 2.0)]);
    assert_equivalent("momentum", &p, p.clone(), &bars, true);
}

// ---------------------------------------------------------------------------
// 7. atr_channel —— Donchian 通道 + ATR 止损（channel=2, atr_period=2）
// 序列 A（ATR 止损）：b2 close=12 破上轨 Buy（entry=12）；b3 持仓中
//   close=10 < 12 − 1.0×ATR(2)@3(=0.75) → Sell。交易 开3/平4。
// 序列 B（通道离场，atr_multiplier=100 使 ATR 止损不触发）：b3 close=8
//   跌破通道下轨(min low=9) → Sell。
// 口径注记：entry = 自身 Buy 信号当根 close（插件内部状态记录，不用 ctx.position.avg_cost）。
// ---------------------------------------------------------------------------
#[test]
fn atr_channel_equivalence_atr_stop() {
    let bars = vec![
        bar(0, 10.0, 10.0, 9.0, 10.0),
        bar(1, 10.0, 10.0, 9.0, 10.0),
        bar(2, 12.0, 12.0, 11.0, 12.0),
        bar(3, 10.0, 10.0, 10.0, 10.0),
        bar(4, 10.0, 10.0, 9.5, 10.0),
    ];
    let p = nums(&[
        ("channel_period", 2.0),
        ("atr_period", 2.0),
        ("atr_multiplier", 1.0),
    ]);
    assert_equivalent("atr_channel", &p, p.clone(), &bars, true);
}

#[test]
fn atr_channel_equivalence_channel_exit() {
    let bars = vec![
        bar(0, 10.0, 10.0, 9.0, 10.0),
        bar(1, 10.0, 10.0, 9.0, 10.0),
        bar(2, 12.0, 12.0, 11.0, 12.0),
        bar(3, 8.0, 8.5, 7.5, 8.0),
        bar(4, 8.0, 8.0, 7.8, 8.0),
    ];
    let p = nums(&[
        ("channel_period", 2.0),
        ("atr_period", 2.0),
        ("atr_multiplier", 100.0), // 有意越界（schema max 5.0）：运行时透传不 clamp（ABI §1 NIT-6 口径），超大倍数使 ATR 止损不触发，走通道离场分支
    ]);
    assert_equivalent("atr_channel", &p, p.clone(), &bars, true);
}

// ---------------------------------------------------------------------------
// 全部 7 款：默认参数长序列（锯齿 80 bar）等价性抽查
// ---------------------------------------------------------------------------
#[test]
fn all_plugins_default_params_long_run_equivalence() {
    let bars = zigzag_bars(80);
    for p in reference::reference_plugins() {
        let params = StrategyParams::new(); // 双侧全默认
        assert_equivalent(p.id, &params, params.clone(), &bars, false);
    }
}

// ---------------------------------------------------------------------------
// PARAMS_SCHEMA 对齐：与 Rust catalog 同 key/默认值/范围（剔除 position_pct；
// boll mode 为 ABI int 编码 0/1，见插件头注释）
// ---------------------------------------------------------------------------
#[test]
fn params_schema_aligns_with_rust_catalog() {
    let catalog = backtest::builtin_strategy_catalog();
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    for p in reference::reference_plugins() {
        let inst = rt
            .instantiate("sha256:schema-check", p.code, &StrategyParams::new())
            .unwrap_or_else(|e| panic!("{} 实例化失败: {e}", p.id));
        let js_schema = inst.params_schema();
        let rust_entry = catalog.iter().find(|c| c.id == p.id).expect("catalog 条目");
        // Rust 侧剔除 position_pct（仓位是 Policy 职责，ADR §13.1）。
        let rust_params: Vec<&backtest::ParamDef> = rust_entry
            .params_schema
            .iter()
            .filter(|d| d.key != "position_pct")
            .collect();
        assert_eq!(
            js_schema.len(),
            rust_params.len(),
            "{}: schema 参数个数不一致（js={} rust={}）",
            p.id,
            js_schema.len(),
            rust_params.len()
        );
        for rd in &rust_params {
            let jd = js_schema
                .iter()
                .find(|d| d.key == rd.key)
                .unwrap_or_else(|| panic!("{}: 插件 schema 缺参数 {}", p.id, rd.key));
            match &rd.kind {
                backtest::ParamKind::Num { min, max, def, .. } => {
                    assert_eq!(jd.default, *def, "{}.{}: 默认值不一致", p.id, rd.key);
                    assert_eq!(jd.min, Some(*min), "{}.{}: min 不一致", p.id, rd.key);
                    assert_eq!(jd.max, Some(*max), "{}.{}: max 不一致", p.id, rd.key);
                }
                backtest::ParamKind::Choice { options, def } => {
                    // 仅 boll.mode：ABI §1 schema 仅支持 int/float，插件以 int 0/1 编码
                    //（0=mean_reversion 默认 / 1=trend；映射见插件头注释）。
                    assert_eq!(p.id, "boll");
                    assert_eq!(rd.key, "mode");
                    assert_eq!(def, "mean_reversion");
                    assert_eq!(options.len(), 2);
                    assert_eq!(jd.default, 0.0, "boll.mode: 默认应为 0（mean_reversion）");
                    assert_eq!(jd.min, Some(0.0));
                    assert_eq!(jd.max, Some(1.0));
                }
            }
        }
        // 反向：插件不得多出 Rust 没有的参数（尤其不得含 position_pct）。
        for jd in js_schema {
            assert_ne!(
                jd.key, "position_pct",
                "{}: 插件不得声明 position_pct",
                p.id
            );
            assert!(
                rust_params.iter().any(|rd| rd.key == jd.key),
                "{}: 插件多出参数 {}",
                p.id,
                jd.key
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 确定性双跑（ADR §9 契约）：同代码同 bars 两次运行，分数序列逐点相等
// ---------------------------------------------------------------------------
#[test]
fn all_plugins_deterministic_double_run() {
    let bars = zigzag_bars(80);
    for p in reference::reference_plugins() {
        let run_once = || js_run(p.id, p.code, StrategyParams::new(), &bars).0;
        let first = run_once();
        let second = run_once();
        assert_eq!(first, second, "{}: 确定性双跑信号序列不一致", p.id);
        // 同时比较原始分数序列（per_bar.scores）。
        let scores_once = || {
            let slot = StrategySlot::new(
                p.code,
                format!("sha256:reference/{}", p.id),
                StrategyParams::new(),
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
            run_ensemble_with_quickjs(&cfg, &bars)
                .expect("运行成功")
                .per_bar
                .iter()
                .map(|r| r.scores.iter().map(|s| s.score).collect::<Vec<_>>())
                .collect::<Vec<_>>()
        };
        assert_eq!(scores_once(), scores_once(), "{}: 双跑分数序列不一致", p.id);
    }
}

// ---------------------------------------------------------------------------
// 状态 save/load round-trip（ABI G3）：7 款插件均有内部状态，必须实现 save()/load()。
// 前半段喂状态 → save → 新实例 load → 后半段分数与原实例逐点一致。
// ---------------------------------------------------------------------------
#[test]
fn all_plugins_save_load_round_trip() {
    // 每款插件用其 golden bars（含状态积累：prev/窗口/entry/EMA 等）。
    let cases: Vec<(&str, StrategyParams, Vec<Bar>, usize)> = vec![
        (
            "dual_ma",
            nums(&[("fast", 2.0), ("slow", 3.0)]),
            flat_bars(&[10.0, 8.0, 9.0, 11.0, 10.0, 7.0, 8.0]),
            3,
        ),
        (
            "ma_rsi",
            nums(&[
                ("fast", 2.0),
                ("slow", 3.0),
                ("rsi_period", 2.0),
                ("rsi_overbought", 70.0),
                ("rsi_oversold", 30.0),
            ]),
            flat_bars(&[10.0, 9.5, 9.2, 10.0, 10.8, 10.4, 10.0, 9.8]),
            4,
        ),
        (
            "macd",
            nums(&[("fast", 2.0), ("slow", 3.0), ("signal", 3.0)]),
            shadow_bars(&[10.0, 11.0, 12.0, 11.0, 13.0, 14.0]),
            3,
        ),
        (
            "boll",
            nums(&[("period", 5.0), ("k", 1.5), ("mode", 0.0)]),
            flat_bars(&[10.0, 10.0, 10.0, 10.0, 5.0, 10.0, 15.0, 14.0]),
            5,
        ),
        (
            "kdj",
            nums(&[("n", 3.0), ("k_period", 2.0), ("d_period", 2.0)]),
            shadow_bars(&[10.0, 11.0, 12.0, 11.0, 13.0, 14.0]),
            4,
        ),
        (
            "momentum",
            nums(&[("lookback", 2.0)]),
            vec![
                bar(0, 10.0, 10.0, 9.0, 10.0),
                bar(1, 10.0, 10.0, 9.0, 10.0),
                bar(2, 12.0, 12.0, 11.0, 12.0),
                bar(3, 8.0, 8.5, 7.5, 8.0),
                bar(4, 8.0, 8.2, 7.8, 8.0),
            ],
            3,
        ),
        (
            "atr_channel",
            nums(&[
                ("channel_period", 2.0),
                ("atr_period", 2.0),
                ("atr_multiplier", 1.0),
            ]),
            vec![
                bar(0, 10.0, 10.0, 9.0, 10.0),
                bar(1, 10.0, 10.0, 9.0, 10.0),
                bar(2, 12.0, 12.0, 11.0, 12.0),
                bar(3, 10.0, 10.0, 10.0, 10.0),
                bar(4, 10.0, 10.0, 9.5, 10.0),
            ],
            3,
        ),
    ];

    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    for (id, params, bars, split) in cases {
        let code = plugin_code(id);
        // 原实例：全程连续运行。
        let mut origin = rt
            .instantiate("sha256:rt", code, &params)
            .unwrap_or_else(|e| panic!("{id} 实例化失败: {e}"));
        let mut origin_scores = Vec::new();
        for (i, b) in bars.iter().enumerate() {
            let ctx = BarCtx::new(i, b.clone(), &bars, None);
            origin_scores.push(
                origin
                    .on_bar(&ctx)
                    .unwrap_or_else(|e| panic!("{id} bar{i}: {e}")),
            );
        }
        // 断点实例：跑前半段 → save。
        let mut head = rt.instantiate("sha256:rt", code, &params).expect("实例化");
        for (i, b) in bars[..split].iter().enumerate() {
            let ctx = BarCtx::new(i, b.clone(), &bars, None);
            head.on_bar(&ctx).expect("on_bar");
        }
        let state = head
            .save()
            .unwrap_or_else(|e| panic!("{id} save 失败: {e}"))
            .unwrap_or_else(|| panic!("{id} 有内部状态，必须实现 save()（ABI G3）"));
        // 恢复实例：load → 跑后半段，分数须与原实例逐点一致。
        let mut restored = rt.instantiate("sha256:rt", code, &params).expect("实例化");
        restored
            .load(&state)
            .unwrap_or_else(|e| panic!("{id} load 失败: {e}"));
        for (i, b) in bars[split..].iter().enumerate() {
            let idx = split + i;
            let ctx = BarCtx::new(idx, b.clone(), &bars, None);
            let got = restored
                .on_bar(&ctx)
                .unwrap_or_else(|e| panic!("{id} bar{idx}: {e}"));
            assert_eq!(
                got, origin_scores[idx],
                "{id}: round-trip 后 bar{idx} 分数不一致（restored={got} origin={}）",
                origin_scores[idx]
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 损坏快照防御（NIT-3）：load() 对缺失/类型错误字段回退安全默认（与 init() 同口径），
// 不得引入 undefined→NaN 污染；恢复后评分序列与全新实例逐点一致。
// 口径与 dual_ma/boll 的 load() 守卫一致（state && typeof 检查，非法则回退）。
// 注：不新增依赖——损坏快照由真实 save() 输出经 Value 方法改造而来。
// ---------------------------------------------------------------------------
#[test]
fn macd_load_corrupted_snapshot_falls_back_to_safe_defaults() {
    let bars = shadow_bars(&[10.0, 11.0, 12.0, 11.0, 13.0, 14.0]);
    let params = nums(&[("fast", 2.0), ("slow", 3.0), ("signal", 3.0)]);
    let code = plugin_code("macd");
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());

    // 基线：全新实例（init 后状态 = 安全默认）的评分序列。
    let mut fresh = rt.instantiate("sha256:rt", code, &params).expect("实例化");
    let fresh_scores: Vec<f64> = bars
        .iter()
        .enumerate()
        .map(|(i, b)| {
            fresh
                .on_bar(&BarCtx::new(i, b.clone(), &bars, None))
                .expect("on_bar")
        })
        .collect();
    // 基线本身应含非中立分（金叉/死叉），否则对照无意义。
    assert!(
        fresh_scores.iter().any(|&s| s != 50.0),
        "golden bars 应触发至少一次非中立分"
    );

    // 损坏快照 A：类型全错（字符串/数组/布尔顶替数值字段）+ prevGt 非布尔。
    // 构造：取真实 macd 快照，用 kdj 快照的数组字段与自身布尔字段顶替数值键。
    let mut head = rt.instantiate("sha256:rt", code, &params).expect("实例化");
    for (i, b) in bars[..3].iter().enumerate() {
        head.on_bar(&BarCtx::new(i, b.clone(), &bars, None))
            .expect("on_bar");
    }
    let mut corrupted = head.save().expect("save").expect("macd 必有 save()");
    {
        let kdj_code = plugin_code("kdj");
        let mut kdj_inst = rt
            .instantiate("sha256:rt", kdj_code, &StrategyParams::new())
            .expect("kdj 实例化");
        kdj_inst
            .on_bar(&BarCtx::new(0, bars[0].clone(), &bars, None))
            .expect("kdj on_bar");
        let kdj_state = kdj_inst.save().expect("save").expect("kdj 必有 save()");
        let arr = kdj_state.get("highs").cloned().expect("kdj 快照含 highs");
        let obj = corrupted.as_object_mut().expect("快照为对象");
        let boolean = obj.get("prevGt").cloned().expect("macd 快照含 prevGt");
        let numeric = obj.get("seen").cloned().expect("macd 快照含 seen");
        obj.insert("emaFast".into(), boolean.clone()); // 布尔顶替数值
        obj.insert("emaSlow".into(), arr.clone()); // 数组顶替数值
        obj.insert("dea".into(), arr); // 数组顶替数值
        obj.insert("seen".into(), boolean); // 布尔顶替数值
        obj.insert("prevGt".into(), numeric); // 数值顶替布尔
    }
    let mut restored = rt.instantiate("sha256:rt", code, &params).expect("实例化");
    restored
        .load(&corrupted)
        .expect("损坏快照不得报错（应回退安全默认）");
    assert_scores_match_fresh(restored.as_mut(), &bars, &fresh_scores, "类型全错");

    // 损坏快照 B：字段全缺失（kdj 快照对 macd 而言全键缺失）。
    let kdj_code = plugin_code("kdj");
    let mut kdj_inst = rt
        .instantiate("sha256:rt", kdj_code, &StrategyParams::new())
        .expect("kdj 实例化");
    kdj_inst
        .on_bar(&BarCtx::new(0, bars[0].clone(), &bars, None))
        .expect("kdj on_bar");
    let foreign = kdj_inst.save().expect("save").expect("kdj 必有 save()");
    let mut restored2 = rt.instantiate("sha256:rt", code, &params).expect("实例化");
    restored2
        .load(&foreign)
        .expect("异构快照不得报错（应回退安全默认）");
    assert_scores_match_fresh(restored2.as_mut(), &bars, &fresh_scores, "字段全缺失");
}

/// 损坏快照恢复后：逐 bar 分数有限且与全新实例逐点一致。
fn assert_scores_match_fresh(
    inst: &mut dyn strategy_runtime::PluginInstance,
    bars: &[Bar],
    fresh_scores: &[f64],
    case: &str,
) {
    for (i, b) in bars.iter().enumerate() {
        let got = inst
            .on_bar(&BarCtx::new(i, b.clone(), bars, None))
            .unwrap_or_else(|e| panic!("{case} bar{i}: {e}"));
        assert!(
            got.is_finite(),
            "{case} bar{i} 分数非有限值（NaN 污染）: {got}"
        );
        assert_eq!(
            got, fresh_scores[i],
            "{case} bar{i} 损坏快照恢复后与全新实例分数不一致（got={got} fresh={}）",
            fresh_scores[i]
        );
    }
}
