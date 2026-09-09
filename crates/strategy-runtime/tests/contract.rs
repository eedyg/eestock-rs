//! 契约测试套件（ADR 12-strategy-system §9 / 02-plugin-abi.md §5）。
//!
//! 任何 `PluginRuntime` 实现必须通过本套件；当前实现为 `QuickJsRuntime`。
//! 覆盖 ABI §5 全部 8 用例（含内存上限、栈深递归）+ PARAMS_SCHEMA 提取 + clamp 边界
//! + ctx.position（§2.5）+ save() 错误上报（MAJOR-1 裁决）+ 错误归类防伪造（MINOR-1 裁决）
//! + on_bar 错误自含 sha256/bar_index（MINOR-2 裁决，ABI G5）。
//!
//! 纪律：全部为确定性手工构造数据，无 RNG / 无系统时间依赖，可完全复现；
//! 超时用例通过收紧 `RuntimeLimits::per_call_timeout` 保证快速触发。

use std::time::Duration;

use backtest::{Bar, ParamValue, StrategyParams};
use strategy_runtime::{
    BarCtx, ParamDef, ParamKind, PluginError, PluginInstance, PluginRuntime, PositionSnapshot,
    QuickJsRuntime, RuntimeLimits,
};

// ---------------------------------------------------------------------------
// fixture 插件（仓内 include_str! 加载，02-plugin-abi.md §5 矩阵）
// ---------------------------------------------------------------------------

const CONSTANT_SCORE: &str = include_str!("fixtures/constant_score.js");
const STATEFUL_COUNTER: &str = include_str!("fixtures/stateful_counter.js");
const THROWER: &str = include_str!("fixtures/thrower.js");
const INFINITE_LOOP: &str = include_str!("fixtures/infinite_loop.js");
const BOUNDARY_CLAMP: &str = include_str!("fixtures/boundary_clamp.js");
const CAPABILITY_FORBIDDEN: &str = include_str!("fixtures/capability_forbidden.js");
const DUAL_MA_REF: &str = include_str!("fixtures/dual_ma_ref.js");
const STACK_OVERFLOW: &str = include_str!("fixtures/stack_overflow.js");

// ---------------------------------------------------------------------------
// 测试辅助（确定性数据 + 引擎循环模拟）
// ---------------------------------------------------------------------------

/// 确定性 bar 序列：纯算术构造，无 RNG / 无时间依赖。
/// close 在 8.5..11.5 区间往复摆动，足以触发双均线上下穿越。
fn make_bars(n: usize) -> Vec<Bar> {
    (0..n)
        .map(|i| {
            let close = 10.0 + (((i * 37) % 11) as f64 - 5.0) * 0.3;
            Bar {
                ts: 1_700_000_000 + (i as i64) * 86_400,
                open: close - 0.1,
                high: close + 0.2,
                low: close - 0.2,
                close,
                volume: 1_000.0 + i as f64,
            }
        })
        .collect()
}

fn dual_ma_params() -> StrategyParams {
    StrategyParams::from([
        ("fast".to_string(), ParamValue::Num(5.0)),
        ("slow".to_string(), ParamValue::Num(20.0)),
    ])
}

/// 单插件跑完整段 bars，逐 bar 收集分数；任何插件错误直接 panic（契约内不允许出错的路径用）。
fn run_scores(inst: &mut Box<dyn PluginInstance>, bars: &[Bar]) -> Vec<f64> {
    bars.iter()
        .enumerate()
        .map(|(i, bar)| {
            let ctx = BarCtx::new(i, bar.clone(), bars, None);
            inst.on_bar(&ctx)
                .unwrap_or_else(|e| panic!("bar {i} 不应出错: {e}"))
        })
        .collect()
}

/// 引擎循环模拟（ABI G5 语义）：单插件出错 → 该 bar 记中立分 50 并记录错误事件，引擎继续。
/// 返回 (聚合前的逐 bar 分数序列, 错误事件序列 {bar_index, error})。
fn engine_loop(inst: &mut Box<dyn PluginInstance>, bars: &[Bar]) -> (Vec<f64>, Vec<(usize, String)>) {
    let mut scores = Vec::new();
    let mut events = Vec::new();
    for (i, bar) in bars.iter().enumerate() {
        let ctx = BarCtx::new(i, bar.clone(), bars, None);
        match inst.on_bar(&ctx) {
            Ok(score) => scores.push(score),
            Err(e) => {
                events.push((i, e.to_string()));
                scores.push(50.0); // 中立分兜底，引擎继续
            }
        }
    }
    (scores, events)
}

fn tighten(timeout_ms: u64) -> RuntimeLimits {
    RuntimeLimits {
        per_call_timeout: Duration::from_millis(timeout_ms),
        ..RuntimeLimits::default()
    }
}

// ---------------------------------------------------------------------------
// 用例 1：确定性双跑（dual_ma_ref）——同 fixture 两次运行分数序列逐点相等
// ---------------------------------------------------------------------------

#[test]
fn contract_determinism_double_run() {
    let bars = make_bars(120);

    let scores_a = {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let mut inst = rt
            .instantiate("sha256:dual_ma_ref", DUAL_MA_REF, &dual_ma_params())
            .expect("instantiate dual_ma_ref (run A)");
        run_scores(&mut inst, &bars)
    };
    let scores_b = {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let mut inst = rt
            .instantiate("sha256:dual_ma_ref", DUAL_MA_REF, &dual_ma_params())
            .expect("instantiate dual_ma_ref (run B)");
        run_scores(&mut inst, &bars)
    };

    assert_eq!(scores_a.len(), bars.len());
    assert_eq!(
        scores_a, scores_b,
        "确定性双跑 diff 必须为空（逐点相等）"
    );
    //  sanity：分数只落在双均线评分口径的三个档位上，且至少出现过一次 80/30（非恒定序列）。
    assert!(scores_a.iter().all(|s| [30.0, 50.0, 80.0].contains(s)));
    assert!(scores_a.contains(&80.0), "序列应出现买入区高分 80");
    assert!(scores_a.contains(&30.0), "序列应出现卖出区低分 30");
}

// ---------------------------------------------------------------------------
// 用例 2：状态 round-trip（stateful_counter）——save → 新实例 load → 后续分数一致
// ---------------------------------------------------------------------------

#[test]
fn contract_state_round_trip() {
    let bars = make_bars(6);
    let params = StrategyParams::new();

    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut original = rt
        .instantiate("sha256:stateful_counter", STATEFUL_COUNTER, &params)
        .expect("instantiate stateful_counter");

    // 原实例先跑 3 根 bar（分数 1,2,3），随后保存状态。
    let prefix = run_scores(&mut original, &bars[..3]);
    assert_eq!(prefix, vec![1.0, 2.0, 3.0]);
    let snapshot = original
        .save()
        .expect("save() 调用必须成功（MAJOR-1：save 失败不得折叠为 None）")
        .expect("stateful_counter 必须提供 save()");
    assert_eq!(snapshot, serde_json::json!({ "count": 3 }));

    // 新实例加载快照，从第 4 根 bar 继续，分数必须与原实例继续运行的结果一致。
    let mut restored = rt
        .instantiate("sha256:stateful_counter", STATEFUL_COUNTER, &params)
        .expect("instantiate stateful_counter (restored)");
    restored.load(&snapshot).expect("load 状态快照");

    for (i, bar) in bars.iter().enumerate().skip(3) {
        let ctx = BarCtx::new(i, bar.clone(), &bars, None);
        let s_original = original.on_bar(&ctx).expect("original on_bar");
        let ctx = BarCtx::new(i, bar.clone(), &bars, None);
        let s_restored = restored.on_bar(&ctx).expect("restored on_bar");
        assert_eq!(s_original, s_restored, "bar {i} 状态恢复后分数必须一致");
    }
}

// ---------------------------------------------------------------------------
// 用例 2b：save() 错误上报（评审 MAJOR-1 裁决 / ABI §4）
// save() 抛异常 / 返回不可 JSON 序列化值 → Err(PluginError)，不得折叠为 None；
// 未定义 save() → Ok(None)。
// ---------------------------------------------------------------------------

#[test]
fn contract_save_error_is_reported_not_swallowed() {
    let bars = make_bars(1);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());

    // (a) 未定义 save() → Ok(None)。
    let plain = rt
        .instantiate("sha256:constant_score", CONSTANT_SCORE, &StrategyParams::new())
        .expect("instantiate constant_score");
    assert!(matches!(plain.save(), Ok(None)), "未定义 save() 须为 Ok(None)");

    // (b) save() 抛异常 → Err(JsException)，宿主收到错误（非静默 None）。
    let throwing = rt
        .instantiate(
            "sha256:save_thrower",
            "function on_bar(ctx) { return 1; } function save() { throw new Error('save boom'); }",
            &StrategyParams::new(),
        )
        .expect("instantiate save_thrower");
    match throwing.save() {
        Err(e) => {
            assert!(
                matches!(e.root_cause(), PluginError::JsException(_)),
                "save() 抛错须归类 JsException，实际: {e:?}"
            );
            assert!(e.to_string().contains("save boom"), "错误须含插件原文: {e}");
        }
        Ok(v) => panic!("save() 抛错不得折叠为 Ok，实际: {v:?}"),
    }

    // (c) save() 返回循环引用（json_stringify 失败）→ Err，不得折叠为 None。
    let circular = rt
        .instantiate(
            "sha256:save_circular",
            "function on_bar(ctx) { return 1; } function save() { var o = {}; o.self = o; return o; }",
            &StrategyParams::new(),
        )
        .expect("instantiate save_circular");
    assert!(
        circular.save().is_err(),
        "循环引用 save() 须报 Err，不得折叠为 None"
    );

    // (d) 正常 save() 后插件仍可继续评分（错误上报不破坏实例）。
    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    let mut throwing = throwing;
    assert_eq!(throwing.on_bar(&ctx).expect("on_bar"), 1.0);
}

// ---------------------------------------------------------------------------
// 用例 3：超时熔断语义（infinite_loop）——runtime 报 Timeout，引擎记中立分并可继续
// ---------------------------------------------------------------------------

#[test]
fn contract_timeout_circuit_semantics() {
    let bars = make_bars(5);
    let mut rt = QuickJsRuntime::new(tighten(30));
    let mut looper = rt
        .instantiate("sha256:infinite_loop", INFINITE_LOOP, &StrategyParams::new())
        .expect("instantiate infinite_loop");

    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    let first = looper.on_bar(&ctx);
    assert!(
        matches!(&first, Err(e) if matches!(e.root_cause(), PluginError::Timeout(_))),
        "死循环必须被 per-call 超时打断并报 Timeout，实际: {first:?}"
    );
    // G5（MINOR-2 裁决）：on_bar 路径错误自含 sha256 + bar_index。
    let msg = first.as_ref().unwrap_err().to_string();
    assert!(
        msg.contains("sha256:infinite_loop") && msg.contains("bar 0"),
        "超时错误事件须自含 sha256 + bar_index: {msg}"
    );

    // interrupt 之后 runtime 仍可用于后续调用（引擎循环可继续调度该插件或由引擎熔断）。
    let ctx = BarCtx::new(1, bars[1].clone(), &bars, None);
    let second = looper.on_bar(&ctx);
    assert!(
        matches!(&second, Err(e) if matches!(e.root_cause(), PluginError::Timeout(_))),
        "第二次调用同样应超时，实际: {second:?}"
    );

    // 引擎侧：错误 → 中立分 50 + 错误事件，全程跑完不中断。
    // 注（ABI §5）：「连续 N 次后熔断停用并告警」的计数/停用断言归**引擎层 strategy-core
    // 契约测试（P1）**，runtime 仅保证单调用报 Timeout 且实例可继续被调度，不在本套件实现。
    let (scores, events) = engine_loop(&mut looper, &bars);
    assert_eq!(scores, vec![50.0; 5], "超时插件全部兜底中立分");
    assert_eq!(events.len(), 5, "每 bar 一条超时错误事件");
    assert!(events.iter().all(|(_, msg)| msg.contains("超时") || msg.to_lowercase().contains("timeout")));
}

// ---------------------------------------------------------------------------
// 用例 4：异常隔离（thrower）——错误事件落bar，其余插件不受影响
// ---------------------------------------------------------------------------

#[test]
fn contract_exception_isolation() {
    let bars = make_bars(5);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut thrower = rt
        .instantiate("sha256:thrower", THROWER, &StrategyParams::new())
        .expect("instantiate thrower");
    let mut steady = rt
        .instantiate("sha256:constant_score", CONSTANT_SCORE, &StrategyParams::new())
        .expect("instantiate constant_score");

    // thrower：bar 2 抛异常，其余 bar 正常 50。
    for (i, bar) in bars.iter().enumerate() {
        let ctx = BarCtx::new(i, bar.clone(), &bars, None);
        match thrower.on_bar(&ctx) {
            Ok(score) => {
                assert_ne!(i, 2, "bar 2 必须抛异常");
                assert_eq!(score, 50.0);
            }
            Err(e) if matches!(e.root_cause(), PluginError::JsException(_)) => {
                assert_eq!(i, 2, "只有 bar 2 允许抛异常");
                let msg = e.to_string();
                assert!(msg.contains("boom at bar 2"), "错误信息须含插件原文: {msg}");
                // G5（MINOR-2 裁决）：on_bar 路径错误自含 sha256 + bar_index。
                assert!(
                    msg.contains("sha256:thrower") && msg.contains("bar 2"),
                    "错误事件须自含 sha256 + bar_index: {msg}"
                );
            }
            Err(other) => panic!("bar {i} 错误类型应为 JsException，实际: {other:?}"),
        }
    }

    // 对照插件全程不受影响（异常隔离）。
    let steady_scores = run_scores(&mut steady, &bars);
    assert_eq!(steady_scores, vec![42.0; 5]);

    // 引擎视角：thrower 序列 = [50, 50, 中立50, 50, 50]，引擎完成运行。
    let (scores, events) = engine_loop(&mut thrower, &bars);
    assert_eq!(scores, vec![50.0; 5]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, 2, "错误事件须携带 bar_index");
    // G5：错误事件文本自含 sha256 + bar_index（引擎落 run 事件流无需额外补全）。
    assert!(events[0].1.contains("sha256:thrower"), "{} ", events[0].1);
    assert!(events[0].1.contains("bar 2"), "{}", events[0].1);
}

// ---------------------------------------------------------------------------
// 用例 5：越界 clamp（boundary_clamp）—— -5→0、150→100、NaN→InvalidScore
// ---------------------------------------------------------------------------

#[test]
fn contract_boundary_clamp() {
    let bars = make_bars(4);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:boundary_clamp", BOUNDARY_CLAMP, &StrategyParams::new())
        .expect("instantiate boundary_clamp");

    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    assert_eq!(inst.on_bar(&ctx).expect("-5 应 clamp 为 Ok"), 0.0);

    let ctx = BarCtx::new(1, bars[1].clone(), &bars, None);
    assert_eq!(inst.on_bar(&ctx).expect("150 应 clamp 为 Ok"), 100.0);

    let ctx = BarCtx::new(2, bars[2].clone(), &bars, None);
    let res = inst.on_bar(&ctx);
    assert!(
        matches!(&res, Err(e) if matches!(e.root_cause(), PluginError::InvalidScore(_))),
        "NaN 必须按 InvalidScore 异常处理，实际: {res:?}"
    );

    let ctx = BarCtx::new(3, bars[3].clone(), &bars, None);
    assert_eq!(inst.on_bar(&ctx).expect("界内 60 原样通过"), 60.0);
}

// ---------------------------------------------------------------------------
// 用例 6：能力禁区（capability_forbidden 引用 Date.now）——按异常处理，引擎继续
// ---------------------------------------------------------------------------

#[test]
fn contract_capability_forbidden() {
    let bars = make_bars(3);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate(
            "sha256:capability_forbidden",
            CAPABILITY_FORBIDDEN,
            &StrategyParams::new(),
        )
        .expect("instantiate capability_forbidden");

    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    match inst.on_bar(&ctx) {
        Err(e) if matches!(e.root_cause(), PluginError::CapabilityViolation(_)) => {
            assert!(e.to_string().contains("Date"), "能力违规信息须指明被禁能力: {e}");
        }
        other => panic!("引用 Date.now() 必须报 CapabilityViolation，实际: {other:?}"),
    }

    // 引擎视角：每 bar 违规 → 中立分兜底，引擎跑完全程（G5：引擎永不因插件崩溃中断）。
    let (scores, events) = engine_loop(&mut inst, &bars);
    assert_eq!(scores, vec![50.0; 3]);
    assert_eq!(events.len(), 3);
}

// ---------------------------------------------------------------------------
// 用例 7：内存上限（ABI §5 / G2）——超限报 MemoryExceeded，runtime 可继续调度
// ---------------------------------------------------------------------------

#[test]
fn contract_memory_limit() {
    let bars = make_bars(2);
    // 收紧限额保证快速触发（RunConfig 级可配，ABI §4）。
    let limits = RuntimeLimits {
        memory_limit: 8 * 1024 * 1024,
        ..RuntimeLimits::default()
    };
    let mut rt = QuickJsRuntime::new(limits);
    let mut hog = rt
        .instantiate(
            "sha256:mem_hog",
            "function on_bar(ctx) { var a = []; for (var i = 0; i < 1e9; i++) { a.push(new Array(100000).join('x')); } return 50; }",
            &StrategyParams::new(),
        )
        .expect("instantiate mem_hog");

    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    let first = hog.on_bar(&ctx);
    assert!(
        matches!(&first, Err(e) if matches!(e.root_cause(), PluginError::MemoryExceeded)),
        "超限必须报 MemoryExceeded，实际: {first:?}"
    );

    // runtime 可继续调度：同实例再次被调度 + 其他健康插件不受影响（G5 异常隔离）。
    let ctx = BarCtx::new(1, bars[1].clone(), &bars, None);
    let second = hog.on_bar(&ctx);
    assert!(
        matches!(&second, Err(e) if matches!(e.root_cause(), PluginError::MemoryExceeded)),
        "第二次调用同样应超限，实际: {second:?}"
    );
    let mut steady = rt
        .instantiate("sha256:constant_score", CONSTANT_SCORE, &StrategyParams::new())
        .expect("instantiate constant_score");
    assert_eq!(run_scores(&mut steady, &bars), vec![42.0; 2]);
}

// ---------------------------------------------------------------------------
// 用例 8：栈深递归（stack_overflow，ABI §5）——归类 JsException，宿主进程不崩溃
// ---------------------------------------------------------------------------

#[test]
fn contract_stack_overflow_is_js_exception() {
    let bars = make_bars(2);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:stack_overflow", STACK_OVERFLOW, &StrategyParams::new())
        .expect("instantiate stack_overflow");

    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    let res = inst.on_bar(&ctx);
    match &res {
        Err(e) => {
            assert!(
                matches!(e.root_cause(), PluginError::JsException(_)),
                "深递归须归类 JsException（实测 QuickJS 抛 RangeError），实际: {e:?}"
            );
            assert!(
                e.to_string().to_lowercase().contains("stack"),
                "错误信息须指明栈溢出: {e}"
            );
        }
        Ok(v) => panic!("深递归必须抛错，实际返回: {v}"),
    }

    // 进程不崩溃：同实例与其他插件后续调用正常。
    let ctx = BarCtx::new(1, bars[1].clone(), &bars, None);
    assert!(inst.on_bar(&ctx).is_err(), "第二次调用同样归类为错误");
    let mut steady = rt
        .instantiate("sha256:constant_score", CONSTANT_SCORE, &StrategyParams::new())
        .expect("instantiate constant_score");
    assert_eq!(run_scores(&mut steady, &bars), vec![42.0; 2]);
}

// ---------------------------------------------------------------------------
// 用例 9：错误归类防伪造（评审 MINOR-1 裁决）
// 插件 throw new Error("interrupted")/"out of memory" 不得伪造 Timeout/MemoryExceeded：
// interrupted/out-of-memory 归类要求 name == "InternalError" + 消息精确匹配；
// 能力桩使用独立 error name（CapabilityError）归类，不按消息子串。
// ---------------------------------------------------------------------------

#[test]
fn contract_forged_guard_messages_are_js_exception() {
    let bars = make_bars(1);
    let mut rt = QuickJsRuntime::new(tighten(200));

    for (forged, label) in [
        ("interrupted", "伪造 interrupted 不得归类 Timeout"),
        ("out of memory", "伪造 out of memory 不得归类 MemoryExceeded"),
        ("capability-forbidden: Date", "伪造 capability 标记不得归类 CapabilityViolation"),
    ] {
        let code = format!("function on_bar(ctx) {{ throw new Error('{forged}'); }}");
        let mut inst = rt
            .instantiate("sha256:forger", &code, &StrategyParams::new())
            .expect("instantiate forger");
        let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
        match inst.on_bar(&ctx) {
            Err(e) => assert!(
                matches!(e.root_cause(), PluginError::JsException(_)),
                "{label}，实际: {e:?}"
            ),
            Ok(v) => panic!("{label}，插件抛错竟返回 Ok({v})"),
        }
    }
}

// ---------------------------------------------------------------------------
// 附加用例：PARAMS_SCHEMA 提取（ABI §1/§5 编辑器表单数据源）
// ---------------------------------------------------------------------------

#[test]
fn contract_params_schema_extraction() {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let inst = rt
        .instantiate("sha256:dual_ma_ref", DUAL_MA_REF, &dual_ma_params())
        .expect("instantiate dual_ma_ref");

    assert_eq!(
        inst.params_schema(),
        &[
            ParamDef {
                key: "fast".to_string(),
                kind: ParamKind::Int,
                default: 5.0,
                min: Some(1.0),
                max: Some(250.0),
                description: Some("快线周期".to_string()),
            },
            ParamDef {
                key: "slow".to_string(),
                kind: ParamKind::Int,
                default: 20.0,
                min: Some(2.0),
                max: Some(250.0),
                description: Some("慢线周期".to_string()),
            },
            ParamDef {
                key: "weight_hint".to_string(),
                kind: ParamKind::Float,
                default: 1.0,
                min: None,
                max: None,
                description: Some("建议聚合权重（仅提示）".to_string()),
            },
        ]
    );

    // schema 可序列化（Registry params_schema JSONB 落库前提，ADR §5）。
    // NIT-1 裁决：serde 字段名与 ABI §1 对齐为 "type"。
    let json = serde_json::to_value(inst.params_schema()).expect("schema 序列化");
    assert_eq!(json[0]["key"], "fast");
    assert_eq!(json[0]["type"], "int");

    // 未声明 PARAMS_SCHEMA 的插件 → 空 schema。
    let plain = rt
        .instantiate("sha256:constant_score", CONSTANT_SCORE, &StrategyParams::new())
        .expect("instantiate constant_score");
    assert!(plain.params_schema().is_empty());
}

// ---------------------------------------------------------------------------
// 附加用例：ctx.position（ABI §2.5，D9）——纯试算恒 null；注入持仓时插件可见只读全景
// ---------------------------------------------------------------------------

#[test]
fn contract_position_panorama() {
    let code = r#"
        function on_bar(ctx) {
          // 返回必须是 0-100 评分（300 股直接返回会被 G6 clamp），用阈值编码持仓可见性。
          return ctx.position === null ? 77 : (ctx.position.qty === 300 ? 90 : 0);
        }
    "#;
    let bars = make_bars(1);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:position_probe", code, &StrategyParams::new())
        .expect("instantiate position probe");

    // 纯试算：position 恒 null。
    let ctx = BarCtx::new(0, bars[0].clone(), &bars, None);
    assert_eq!(inst.on_bar(&ctx).expect("position=null"), 77.0);

    // 组合回算：注入只读持仓全景，插件可见。
    let pos = PositionSnapshot {
        qty: 300.0,
        avg_cost: 10.0,
        entry_ts: bars[0].ts,
        bars_since_entry: 1,
        unrealized_pnl: 0.0,
    };
    let ctx = BarCtx::new(0, bars[0].clone(), &bars, Some(pos));
    assert_eq!(inst.on_bar(&ctx).expect("position=300"), 90.0);
}

// ---------------------------------------------------------------------------
// 附加用例：ctx.log 归集到 host 侧 sink（ABI §2：唯一副作用通道，不在 JS 内 tracing）
// ---------------------------------------------------------------------------

#[test]
fn contract_log_sink() {
    let bars = make_bars(2);
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    let mut inst = rt
        .instantiate("sha256:constant_score", CONSTANT_SCORE, &StrategyParams::new())
        .expect("instantiate constant_score");

    let ctx = BarCtx::new(1, bars[1].clone(), &bars, None);
    assert_eq!(inst.on_bar(&ctx).expect("on_bar"), 42.0);
    assert_eq!(ctx.take_logs(), vec!["constant_score bar 1".to_string()]);
}
