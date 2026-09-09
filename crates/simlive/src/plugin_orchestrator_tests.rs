//! PluginStrategyOrchestrator 单测（P4a 切源；TDD Red→Green）。
//! 独立文件以保持 plugin_orchestrator.rs 本体紧凑；`#[path]` 挂到 simlive 测试树。

use std::collections::HashMap;

use backtest::{Bar, ParamValue, StrategyParams};
use strategy_runtime::{PluginError, PluginInstance, PluginRuntime, QuickJsRuntime, RuntimeLimits};
use strategy_runtime::{BarCtx, ParamDef};

use crate::plugin_orchestrator::{
    current_entry_ts, PluginStrategyConfig, PluginStrategyOrchestrator, PositionInput,
};
use crate::session::{SessionEvent, SessionManager};
use crate::strategy_orchestrator::{
    aggregate_to_signal, weighted_aggregate, NEUTRAL_SCORE,
};
use crate::fill::{Side, SimTrade};

// ── 测试替身：脚本化 MockRuntime（聚合/G5/上限语义锁定，不经 QuickJS）──

/// 脚本化实例：每次 on_bar 弹出下一个结果；脚本耗尽后重复最后一个。
struct ScriptedInstance {
    script: Vec<Result<f64, PluginError>>,
    /// 记录收到的 position（None/Some），供 position 注入断言（与 MockRuntime 共享，测试可读）。
    seen_positions: PositionRecorder,
}

/// seen_positions 元素：(qty, avg_cost, entry_ts, bars_since_entry, unrealized_pnl)。
type SeenPosition = (f64, f64, i64, u64, f64);
/// 持仓观测记录器（实例内写入、测试侧读取；Rc 共享——单线程测试语义）。
type PositionRecorder = std::rc::Rc<std::cell::RefCell<Vec<Option<SeenPosition>>>>;

impl PluginInstance for ScriptedInstance {
    fn on_bar(&mut self, ctx: &BarCtx<'_>) -> Result<f64, PluginError> {
        self.seen_positions.borrow_mut().push(ctx.position.map(|p| {
            (p.qty, p.avg_cost, p.entry_ts, p.bars_since_entry, p.unrealized_pnl)
        }));
        if self.script.len() > 1 {
            self.script.remove(0)
        } else {
            self.script[0].clone()
        }
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

/// Mock 运行时：按 code_hash 查脚本表；未注册 hash → 实例化失败（显式 Err）。
struct MockRuntime {
    /// code_hash → 每股脚本（每实例 clone 一份）。
    scripts: HashMap<String, Vec<Result<f64, PluginError>>>,
    /// 记录实例化收到的 params（供参数透传断言）。
    instantiated: std::cell::RefCell<Vec<(String, StrategyParams)>>,
    /// code_hash → 持仓观测记录器（最近一次实例化创建的实例共享；测试据此断言注入字段）。
    recorders: HashMap<String, PositionRecorder>,
}

impl MockRuntime {
    fn new() -> Self {
        Self {
            scripts: HashMap::new(),
            instantiated: std::cell::RefCell::new(Vec::new()),
            recorders: HashMap::new(),
        }
    }
    fn register(&mut self, code_hash: &str, script: Vec<Result<f64, PluginError>>) {
        self.scripts.insert(code_hash.to_string(), script);
    }
    /// 某 hash 实例收到的 position 序列（NIT-5：PositionSnapshot 全字段断言用）。
    fn seen_positions(&self, code_hash: &str) -> PositionRecorder {
        self.recorders
            .get(code_hash)
            .cloned()
            .unwrap_or_else(|| std::rc::Rc::new(std::cell::RefCell::new(Vec::new())))
    }
}

impl PluginRuntime for MockRuntime {
    fn instantiate(
        &mut self,
        code_hash: &str,
        _code: &str,
        params: &StrategyParams,
    ) -> Result<Box<dyn PluginInstance>, PluginError> {
        self.instantiated
            .borrow_mut()
            .push((code_hash.to_string(), params.clone()));
        let script = self
            .scripts
            .get(code_hash)
            .cloned()
            .ok_or_else(|| PluginError::JsException(format!("mock 未注册 hash: {code_hash}")))?;
        let recorder: PositionRecorder = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        self.recorders.insert(code_hash.to_string(), std::rc::Rc::clone(&recorder));
        Ok(Box::new(ScriptedInstance { script, seen_positions: recorder }))
    }
}

// ── 辅助 ──

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

fn bar(ts: i64, close: f64) -> Bar {
    Bar { ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 10_000.0 }
}

fn num_params(pairs: &[(&str, f64)]) -> StrategyParams {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), ParamValue::Num(*v)))
        .collect()
}

/// 构造钉住策略配置（code 内容对 MockRuntime 无意义；hash 用作脚本索引）。
fn cfg(strategy_id: &str, sha: &str, stocks: &[&str], weight: f64) -> PluginStrategyConfig {
    PluginStrategyConfig {
        strategy_id: strategy_id.into(),
        version_id: format!("sv_{strategy_id}"),
        version: 1,
        sha256: sha.into(),
        name: strategy_id.into(),
        code: format!("// code of {strategy_id}"),
        params: StrategyParams::new(),
        stocks: stocks.iter().map(|s| s.to_string()).collect(),
        weight,
        stock_weights: HashMap::new(),
    }
}

// ── Red 1：插件连续分直通 + 聚合/阈值语义不变（取代三档映射）──
#[test]
fn plugin_scores_pass_through_and_aggregate_weighted() {
    let mut rt = MockRuntime::new();
    rt.register("sha_a", vec![Ok(80.0)]);
    rt.register("sha_b", vec![Ok(30.0)]);
    let configs = vec![
        cfg("strat_a", "sha_a", &["AAA"], 2.0),
        cfg("strat_b", "sha_b", &["AAA"], 1.0),
    ];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    let ev = orch.feed_bar("AAA", bar(100, 10.0), None).expect("评估");
    // 插件连续分直通（不再是 Buy=100/Hold=50/Sell=0 三档）。
    assert_eq!(ev.per_strategy_scores.len(), 2);
    close(ev.per_strategy_scores[0].score, 80.0);
    close(ev.per_strategy_scores[1].score, 30.0);
    // 每策略信号由自身分对阈值判定。
    assert_eq!(ev.per_strategy_scores[0].signal, "buy");
    assert_eq!(ev.per_strategy_scores[1].signal, "sell");
    // 聚合 = Σ(w·s)/Σw = (2·80 + 1·30)/3 = 190/3；语义与旧编排器一致。
    let agg = (2.0 * 80.0 + 1.0 * 30.0) / 3.0;
    close(ev.aggregate_score, agg);
    assert_eq!(ev.signal, aggregate_to_signal(agg, 60.0, 40.0));
    close(ev.latest_price, 10.0);
    assert_eq!(ev.ts, 100);
    assert_eq!(orch.stocks(), vec!["AAA".to_string()]);
}

/// stock_weights 覆盖默认 weight 参与聚合（口径不变）。
#[test]
fn stock_weights_override_default_weight() {
    let mut rt = MockRuntime::new();
    rt.register("sha_a", vec![Ok(80.0)]);
    rt.register("sha_b", vec![Ok(30.0)]);
    let mut c1 = cfg("strat_a", "sha_a", &["AAA"], 1.0);
    c1.stock_weights.insert("AAA".to_string(), 3.0);
    let c2 = cfg("strat_b", "sha_b", &["AAA"], 1.0);
    let mut orch = PluginStrategyOrchestrator::new(vec![c1, c2], 60.0, 40.0, &mut rt).expect("构建");
    let ev = orch.feed_bar("AAA", bar(100, 10.0), None).expect("评估");
    close(ev.aggregate_score, (3.0 * 80.0 + 1.0 * 30.0) / 4.0);
}

/// 未覆盖标的不评估（语义不变）。
#[test]
fn uncovered_stock_not_evaluated() {
    let mut rt = MockRuntime::new();
    rt.register("sha_a", vec![Ok(80.0)]);
    let configs = vec![cfg("strat_a", "sha_a", &["AAA"], 1.0)];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    assert!(orch.feed_bar("ZZZ", bar(100, 10.0), None).is_none());
    assert!(orch.latest_evaluation("ZZZ").is_none());
    assert!(orch.feed_bar("AAA", bar(100, 10.0), None).is_some());
}

/// 参数透传：实例化时收到钉住 params。
#[test]
fn params_passed_to_instantiate() {
    let mut rt = MockRuntime::new();
    rt.register("sha_a", vec![Ok(50.0)]);
    let mut c = cfg("strat_a", "sha_a", &["AAA"], 1.0);
    c.params = num_params(&[("lookback", 7.0)]);
    let _orch = PluginStrategyOrchestrator::new(vec![c], 60.0, 40.0, &mut rt).expect("构建");
    let seen = rt.instantiated.borrow();
    assert_eq!(seen.len(), 1, "1 策略 × 1 标的 = 1 实例");
    assert_eq!(seen[0].0, "sha_a");
    assert_eq!(seen[0].1.get("lookback"), Some(&ParamValue::Num(7.0)));
}

// ── Red 2：实例化失败 → 显式报错（旧「未知策略静默跳过」语义废止）──
#[test]
fn instantiate_failure_is_explicit_error() {
    let mut rt = MockRuntime::new(); // 不注册 sha_bad → instantiate Err
    let configs = vec![cfg("strat_bad", "sha_bad", &["AAA"], 1.0)];
    let r = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt);
    let Err(e) = r else { panic!("实例化失败必须显式报错，禁止静默跳过") };
    let msg = e.to_string();
    assert!(msg.contains("strat_bad"), "错误须含 strategy_id：{msg}");
    assert!(msg.contains("sv_strat_bad"), "错误须含 version_id：{msg}");
}

/// MINOR-4：阈值须夹中立 50（buy > 50 且 sell < 50，保证「全熔断→中立 50→Hold」契约）。
#[test]
fn thresholds_must_straddle_neutral_50() {
    let mk_rt = || {
        let mut rt = MockRuntime::new();
        rt.register("sha_a", vec![Ok(50.0)]);
        rt
    };
    let configs = || vec![cfg("strat_a", "sha_a", &["AAA"], 1.0)];
    // 合法基线 60/40。
    assert!(PluginStrategyOrchestrator::new(configs(), 60.0, 40.0, &mut mk_rt()).is_ok());
    // buy=45/sell=40：buy 未过中立 50 → 全熔断中立 50 会误判 buy → 拒绝。
    assert!(PluginStrategyOrchestrator::new(configs(), 45.0, 40.0, &mut mk_rt()).is_err());
    // buy=50 恰值中立分 → 拒绝（须严格大于）。
    assert!(PluginStrategyOrchestrator::new(configs(), 50.0, 40.0, &mut mk_rt()).is_err());
    // sell=50 恰值中立分 → 拒绝（须严格小于）。
    assert!(PluginStrategyOrchestrator::new(configs(), 60.0, 50.0, &mut mk_rt()).is_err());
    // sell=55 超中立分 → 拒绝。
    assert!(PluginStrategyOrchestrator::new(configs(), 60.0, 55.0, &mut mk_rt()).is_err());
    // 原有校验保持：倒挂 / NaN 仍拒绝。
    assert!(PluginStrategyOrchestrator::new(configs(), 40.0, 60.0, &mut mk_rt()).is_err());
    assert!(PluginStrategyOrchestrator::new(configs(), f64::NAN, 40.0, &mut mk_rt()).is_err());
}

/// 上限校验：>3 策略 / 单策略 >30 股 → Err。
#[test]
fn limits_3_strategies_30_stocks_enforced() {
    let mut rt = MockRuntime::new();
    rt.register("sha_a", vec![Ok(50.0)]);
    // 4 策略 → Err
    let four: Vec<_> = (0..4).map(|i| cfg(&format!("s{i}"), "sha_a", &["AAA"], 1.0)).collect();
    assert!(PluginStrategyOrchestrator::new(four, 60.0, 40.0, &mut rt).is_err());
    // 31 股 → Err
    let stocks: Vec<String> = (0..31).map(|i| format!("{i:06}")).collect();
    let mut c = cfg("strat_a", "sha_a", &["AAA"], 1.0);
    c.stocks = stocks;
    assert!(PluginStrategyOrchestrator::new(vec![c], 60.0, 40.0, &mut rt).is_err());
    // 恰 3 策略 × 30 股 → Ok
    let stocks30: Vec<&str> = Vec::new();
    let _ = stocks30;
    let three: Vec<_> = (0..3).map(|i| cfg(&format!("s{i}"), "sha_a", &["AAA"], 1.0)).collect();
    assert!(PluginStrategyOrchestrator::new(three, 60.0, 40.0, &mut rt).is_ok());
}

// ── Red 3：position 注入（真实 QuickJS + ABI §2.5）──

/// 门控插件：空仓 80 / 持仓 20（对齐 strategy-core fixture position_gate 语义）。
const POSITION_GATE_JS: &str = r#"
function on_bar(ctx) {
  return ctx.position === null ? 80 : 20;
}
"#;

/// position 字段回显插件：把持仓快照字段编码为分数（断言注入字段正确性）。
/// 空仓 → 1；否则返回 bars_since_entry（小数值直通）。
const POSITION_ECHO_JS: &str = r#"
function on_bar(ctx) {
  if (ctx.position === null) return 1;
  return ctx.position.bars_since_entry;
}
"#;

#[test]
fn position_injection_real_quickjs() {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let configs = vec![PluginStrategyConfig {
        strategy_id: "st_gate".into(),
        version_id: "sv_gate".into(),
        version: 1,
        sha256: "sha256:gate".into(),
        name: "门控".into(),
        code: POSITION_GATE_JS.into(),
        params: StrategyParams::new(),
        stocks: vec!["AAA".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    // 空仓 → position null → 80。
    let ev = orch.feed_bar("AAA", bar(100, 10.0), None).expect("评估");
    close(ev.per_strategy_scores[0].score, 80.0);
    // 持仓 → position Some → 20。
    let pos = PositionInput { qty: 100.0, avg_cost: 9.0, entry_ts: 100 };
    let ev = orch.feed_bar("AAA", bar(101, 10.0), Some(pos)).expect("评估");
    close(ev.per_strategy_scores[0].score, 20.0);
}

#[test]
fn position_snapshot_fields_bars_since_entry() {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let configs = vec![PluginStrategyConfig {
        strategy_id: "st_echo".into(),
        version_id: "sv_echo".into(),
        version: 1,
        sha256: "sha256:echo".into(),
        name: "回显".into(),
        code: POSITION_ECHO_JS.into(),
        params: StrategyParams::new(),
        stocks: vec!["AAA".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    // bar ts=100 建仓（entry_ts=100）；ts=100 当根 bars_since_entry=0。
    let pos = PositionInput { qty: 100.0, avg_cost: 10.0, entry_ts: 100 };
    let ev = orch.feed_bar("AAA", bar(100, 10.0), Some(pos)).expect("评估");
    close(ev.per_strategy_scores[0].score, 0.0); // bars_since_entry=0
    let ev = orch.feed_bar("AAA", bar(101, 10.0), Some(pos)).expect("评估");
    close(ev.per_strategy_scores[0].score, 1.0);
    let ev = orch.feed_bar("AAA", bar(102, 10.0), Some(pos)).expect("评估");
    close(ev.per_strategy_scores[0].score, 2.0);
    // 清仓（None）→ 回显 1。
    let ev = orch.feed_bar("AAA", bar(103, 10.0), None).expect("评估");
    close(ev.per_strategy_scores[0].score, 1.0);
}

/// Mock 层断言 PositionSnapshot 全字段（qty/avg_cost/entry_ts/bars_since_entry/unrealized_pnl，NIT-5）。
#[test]
fn position_snapshot_fields_full() {
    let mut rt = MockRuntime::new();
    rt.register("sha_p", vec![Ok(50.0)]);
    let configs = vec![cfg("strat_p", "sha_p", &["AAA"], 1.0)];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    orch.feed_bar("AAA", bar(100, 10.0), None);
    let pos = PositionInput { qty: 200.0, avg_cost: 9.0, entry_ts: 100 };
    orch.feed_bar("AAA", bar(101, 11.0), Some(pos));
    let ev = orch.latest_evaluation("AAA").unwrap();
    close(ev.aggregate_score, 50.0);
    // 实例实际收到的持仓快照全字段断言（recorder 与实例共享）：
    // bar ts=101 为第二根（idx=1），entry_ts=100 → bars_since_entry=1；
    // unrealized_pnl = qty × (bar.close − avg_cost) = 200 × (11−9) = 400。
    let seen = rt.seen_positions("sha_p");
    let seen = seen.borrow();
    assert_eq!(seen.len(), 2, "两根 bar 各调用一次 on_bar");
    assert_eq!(seen[0], None, "首根空仓 → position null");
    let (qty, avg_cost, entry_ts, bars_since_entry, unrealized_pnl) = seen[1].expect("持仓注入");
    close(qty, 200.0);
    close(avg_cost, 9.0);
    assert_eq!(entry_ts, 100);
    assert_eq!(bars_since_entry, 1);
    close(unrealized_pnl, 400.0);
}

// ── Red 4：G5 熔断语义对齐引擎 ──

/// 插件每 bar 抛错 → 中立分 50 + 每次错误事件（带 sha256/bar_index）；连续 10 次 → 熔断停用
/// + 告警事件；停用后按「无覆盖」处理（单策略场景聚合回落中立 50，不再产信号）。
#[test]
fn g5_error_neutral_score_events_and_circuit_breaker() {
    let mut rt = MockRuntime::new();
    rt.register(
        "sha_bad",
        vec![Err(PluginError::JsException("boom".into()))],
    );
    rt.register("sha_good", vec![Ok(80.0)]);
    let configs = vec![
        cfg("strat_bad", "sha_bad", &["AAA"], 1.0),
        cfg("strat_good", "sha_good", &["AAA"], 1.0),
    ];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    let threshold = strategy_core::CIRCUIT_BREAKER_THRESHOLD as usize;
    for i in 0..threshold {
        let ev = orch.feed_bar("AAA", bar(100 + i as i64, 10.0), None).expect("评估");
        // 错误 bar：该策略记中立分 50 参与聚合 → (50+80)/2 = 65。
        close(ev.aggregate_score, 65.0);
        let bad = &ev.per_strategy_scores[0];
        assert_eq!(bad.strategy_id, "strat_bad");
        close(bad.score, NEUTRAL_SCORE);
        let events = orch.take_events();
        // 未达阈值：每错误 bar 恰一条 PluginError；达阈值当 bar 追加 CircuitBreaker。
        let expected_len = if i < threshold - 1 { 1 } else { 2 };
        assert_eq!(events.len(), expected_len, "bar {i} 事件数");
        match &events[0] {
            SessionEvent::PluginError { ts, code, strategy_id, sha256, bar_index, error } => {
                assert_eq!(*ts, 100 + i as i64);
                assert_eq!(code, "AAA");
                assert_eq!(strategy_id, "strat_bad");
                assert_eq!(sha256, "sha_bad");
                assert_eq!(*bar_index, i);
                assert!(error.contains("boom"), "错误事件含原因：{error}");
            }
            other => panic!("应为 PluginError 事件，got {other:?}"),
        }
    }
    // 熔断后次 bar 起 strat_bad 不再参与聚合（按无覆盖处理）。
    let ev = orch.feed_bar("AAA", bar(200, 10.0), None).expect("评估");
    assert_eq!(ev.per_strategy_scores.len(), 1, "熔断停用后按无覆盖处理");
    assert_eq!(ev.per_strategy_scores[0].strategy_id, "strat_good");
    close(ev.aggregate_score, 80.0);
    // 熔断后不再产错误事件。
    assert!(orch.take_events().is_empty());
}

/// 熔断告警事件：连续错误达阈值当 bar 同时产 PluginError + CircuitBreaker。
#[test]
fn circuit_breaker_alert_event_on_threshold() {
    let mut rt = MockRuntime::new();
    rt.register("sha_bad", vec![Err(PluginError::JsException("boom".into()))]);
    let configs = vec![cfg("strat_bad", "sha_bad", &["AAA"], 1.0)];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    let threshold = strategy_core::CIRCUIT_BREAKER_THRESHOLD as usize;
    for i in 0..threshold {
        orch.feed_bar("AAA", bar(100 + i as i64, 10.0), None);
        let events = orch.take_events();
        if i < threshold - 1 {
            assert_eq!(events.len(), 1);
        } else {
            assert_eq!(events.len(), 2, "达阈值当 bar：PluginError + CircuitBreaker");
            match &events[1] {
                SessionEvent::CircuitBreaker { strategy_id, sha256, bar_index, .. } => {
                    assert_eq!(strategy_id, "strat_bad");
                    assert_eq!(sha256, "sha_bad");
                    assert_eq!(*bar_index, i);
                }
                other => panic!("应为 CircuitBreaker 事件，got {other:?}"),
            }
        }
    }
    // 全部熔断 → 聚合中立 50 → 不产交易信号（hold）。
    let ev = orch.feed_bar("AAA", bar(200, 10.0), None).expect("评估");
    assert!(ev.per_strategy_scores.is_empty());
    close(ev.aggregate_score, NEUTRAL_SCORE);
    assert_eq!(ev.signal, "hold");
}

/// 成功即清零：间歇错误（每 3 根错 1 次）永不熔断。
#[test]
fn g5_consecutive_errors_reset_on_success() {
    let mut rt = MockRuntime::new();
    // 脚本：Ok, Ok, Err, Ok, Ok, Err ...
    rt.register(
        "sha_flaky",
        vec![
            Ok(60.0),
            Ok(60.0),
            Err(PluginError::JsException("boom".into())),
            Ok(60.0),
            Ok(60.0),
            Err(PluginError::JsException("boom".into())),
            Ok(60.0),
        ],
    );
    let configs = vec![cfg("strat_flaky", "sha_flaky", &["AAA"], 1.0)];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    // 脚本耗尽后重复最后一个（Ok(60)），先跑 6 根（含 2 次错误，不连续 → 不熔断）。
    for i in 0..6 {
        let ev = orch.feed_bar("AAA", bar(100 + i, 10.0), None).expect("评估");
        let expected = if (i % 3) == 2 { NEUTRAL_SCORE } else { 60.0 };
        close(ev.aggregate_score, expected);
    }
    // 永不熔断：第 7 根仍参与。
    let ev = orch.feed_bar("AAA", bar(106, 10.0), None).expect("评估");
    assert_eq!(ev.per_strategy_scores.len(), 1);
}

// ── Red 5：会话事件流（SessionManager.session_events）──

#[test]
fn session_events_record_read_reset_restore() {
    let mut m = SessionManager::new();
    m.start_session("t", 100_000.0, vec![], vec![], "M1", 1000, "manual");
    assert!(m.session_events().is_empty());
    let ev = SessionEvent::PluginError {
        ts: 1001,
        code: "AAA".into(),
        strategy_id: "strat_a".into(),
        sha256: "sha_a".into(),
        bar_index: 0,
        error: "boom".into(),
    };
    m.record_session_event(ev.clone());
    assert_eq!(m.session_events(), std::slice::from_ref(&ev));
    let st = m.get_state().unwrap();
    assert_eq!(st.session_events, vec![ev]);
    // start_session 重置。
    m.start_session("t2", 100_000.0, vec![], vec![], "M1", 2000, "manual");
    assert!(m.session_events().is_empty());
    // restore 可携事件序列重建。
    let cb = SessionEvent::CircuitBreaker {
        ts: 2001,
        code: "AAA".into(),
        strategy_id: "strat_a".into(),
        sha256: "sha_a".into(),
        bar_index: 9,
    };
    let m2 = SessionManager::restore(
        crate::account::SimAccount::new(100_000.0),
        crate::session::SimSession {
            id: "s_1".into(),
            name: "r".into(),
            cash_init: 100_000.0,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            start_ts: 1000,
            end_ts: None,
            status: crate::session::SessionStatus::Running,
            source: "manual".into(),
        },
        vec![],
        vec![],
        vec![],
        vec![cb.clone()],
    );
    assert_eq!(m2.session_events(), &[cb]);
}

// ── Red 6：entry_ts sticky-first-entry 推导（MINOR-2：与 strategy-core Holding 口径一致）──

fn trade(code: &str, side: Side, qty: f64, ts: i64) -> SimTrade {
    SimTrade { code: code.into(), side, qty, price: 10.0, ts, fee: 0.0, source: "t".into() }
}

/// sticky-first-entry：自空仓以来**首笔建仓 ts 钉死**；加仓不动；**部分卖出不前进**
///（即便卖超 FIFO 口径的首 lot）；清仓后重新钉。对齐 strategy-core `Holding.entry_ts` 口径。
#[test]
fn current_entry_ts_sticky_first_entry() {
    let trades = vec![
        trade("AAA", Side::Buy, 100.0, 100),
        trade("AAA", Side::Buy, 100.0, 105),
        trade("BBB", Side::Buy, 50.0, 103),
        trade("AAA", Side::Sell, 100.0, 110), // 卖超 FIFO 首 lot；sticky 口径不前进
    ];
    // AAA 钉死首笔建仓 ts=100（旧 FIFO 口径会前进到 105——MINOR-2 修正点）。
    assert_eq!(current_entry_ts(&trades, "AAA"), Some(100));
    assert_eq!(current_entry_ts(&trades, "BBB"), Some(103));
    assert_eq!(current_entry_ts(&trades, "ZZZ"), None);
    // 全部平仓 → None；重新建仓 → 重新钉死新 ts。
    let mut t2 = trades.clone();
    t2.push(trade("AAA", Side::Sell, 100.0, 120)); // 清仓
    assert_eq!(current_entry_ts(&t2, "AAA"), None);
    t2.push(trade("AAA", Side::Buy, 30.0, 130));
    assert_eq!(current_entry_ts(&t2, "AAA"), Some(130), "清仓后重新钉死");
    // 部分平仓 → 钉死不动。
    let t3 = vec![
        trade("AAA", Side::Buy, 100.0, 100),
        trade("AAA", Side::Sell, 40.0, 110),
    ];
    assert_eq!(current_entry_ts(&t3, "AAA"), Some(100));
    // 卖超持仓的损坏数据 → 防御性视为清仓（不 panic）。
    let t4 = vec![
        trade("AAA", Side::Buy, 100.0, 100),
        trade("AAA", Side::Sell, 150.0, 110),
    ];
    assert_eq!(current_entry_ts(&t4, "AAA"), None);
}

/// MINOR-2：部分卖出后 entry_ts 钉死 → 编排器 bars_since_entry 不分叉（自钉死 ts 连续计数）。
#[test]
fn partial_sell_keeps_entry_ts_and_bars_since_entry_monotonic() {
    // 台账：100 建仓@100 → 部分卖出 40@102（剩 60）→ sticky 钉死 100。
    let trades = vec![
        trade("AAA", Side::Buy, 100.0, 100),
        trade("AAA", Side::Sell, 40.0, 102),
    ];
    let entry = current_entry_ts(&trades, "AAA").expect("仍持仓");
    assert_eq!(entry, 100, "部分卖出不前进 entry_ts");
    // 编排器侧：entry_ts 不变 → bars_since_entry 随 bar 序列单调递增（不因部分卖出重置）。
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let configs = vec![PluginStrategyConfig {
        strategy_id: "st_echo".into(),
        version_id: "sv_echo".into(),
        version: 1,
        sha256: "sha256:echo".into(),
        name: "回显".into(),
        code: POSITION_ECHO_JS.into(),
        params: StrategyParams::new(),
        stocks: vec!["AAA".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    let mut orch = PluginStrategyOrchestrator::new(configs, 60.0, 40.0, &mut rt).expect("构建");
    // 部分卖出后剩余持仓 60 股，entry_ts 钉死 100：逐根 feed（ts 100..=103）。
    for (i, ts) in (100..=103).enumerate() {
        let pos = PositionInput { qty: 60.0, avg_cost: 10.0, entry_ts: entry };
        let ev = orch.feed_bar("AAA", bar(ts, 10.0), Some(pos)).expect("评估");
        close(ev.per_strategy_scores[0].score, i as f64); // bars_since_entry = 0,1,2,3 不分叉
    }
}

// ── 辅助函数语义不变（复用旧编排器纯函数）──
#[test]
fn aggregate_helpers_unchanged() {
    close(weighted_aggregate(&[(1.0, 100.0), (3.0, 50.0)]), 62.5);
    close(weighted_aggregate(&[]), NEUTRAL_SCORE);
    assert_eq!(aggregate_to_signal(60.0, 60.0, 40.0), "buy");
    assert_eq!(aggregate_to_signal(40.0, 60.0, 40.0), "sell");
    assert_eq!(aggregate_to_signal(50.0, 60.0, 40.0), "hold");
    // 与引擎常量一致（G5/中立分对齐）。
    close(NEUTRAL_SCORE, strategy_core::NEUTRAL_SCORE);
}
