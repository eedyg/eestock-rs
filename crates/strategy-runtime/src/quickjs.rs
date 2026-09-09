//! QuickJS 实现的插件运行时（ADR 12-strategy-system D1；ABI 02-plugin-abi.md §4 首个实现）。
//!
//! 关键决策点：
//! - **intrinsics 裁剪（G1）**：`Context::custom` 仅注入 `Eval + Json + MapSet + TypedArrays`
//!   （BaseObjects 由 rquickjs 强制注入）；**不注入** Date/Performance/Promise/Proxy 等。
//!   Date 不存在 → 引用即 `ReferenceError` → 归类 [`PluginError::CapabilityViolation`]。
//!   **Eval 实测结论（NIT-2，2026-09-09 复验）**：移除 Eval intrinsic 后宿主侧 `ctx.eval`
//!   连 `1 + 2` 都直接抛 Exception（quickjs-ng 0.11 的宿主 eval 路径依赖该 intrinsic），
//!   因此**必须保留**；插件内 `eval`/`Function` 仍在同一沙箱内执行，无额外能力，不破坏 G1。
//!   （验证方式：临时探针对 `Context::custom::<(Json, MapSet, TypedArrays)>` 直接 eval，全部抛 Exception。）
//! - **Math.random 锁死（G1）**：BaseObjects 内含 Math（sqrt/floor 等为合法能力），
//!   无法整体裁剪；守卫脚本以 `Object.defineProperty`（不可写/不可配置）替换为抛错桩，
//!   桩抛 `name = "CapabilityError"` 的自定义错误，宿主按 error name 归类 CapabilityViolation
//!   （MINOR-1 裁决：不按消息子串，防插件伪造）。
//! - **per-call 超时（G2）**：`Runtime::set_interrupt_handler` + 每次调用前 arm 一个
//!   单调时钟（`Instant`）截止时间；handler 到期返回 true 由 QuickJS 打断执行
//!   （实测抛 InternalError "interrupted"）→ 归类 [`PluginError::Timeout`]。本 crate 唯一的
//!   时钟用途即此（分层红线豁免：interrupt 超时所需的单调时钟）。
//! - **实例化时限（NIT-7）**：eval + init 使用独立的 `instantiate_timeout`
//!   （默认 max(per_call×20, 1s)），与 per-call 时限解耦。
//! - **内存上限（G2）**：`Runtime::set_memory_limit`（默认 64MB）；超限实测抛
//!   InternalError "out of memory" → 归类 [`PluginError::MemoryExceeded`]。
//! - **错误归类防伪造（MINOR-1）**：interrupted/out of memory 要求 `name == "InternalError"`
//!   + 消息精确匹配；插件 `throw new Error("interrupted")` 之类伪造一律归类 JsException。
//! - **on_bar 错误包装（G5 / MINOR-2）**：on_bar 路径一切错误包装为 [`PluginError::OnBar`]，
//!   自含 sha256 + bar_index。
//! - **save() 错误上报（MAJOR-1）**：save 抛异常/序列化失败一律 `Err(PluginError)`，
//!   未定义 save() 才是 `Ok(None)`。
//! - **实例隔离**：每个插件实例独占一个 `Runtime + Context`，限额/中断状态互不串扰。
//!
//! 生命周期（ABI §1）：eval 源码 → 提取全局 `PARAMS_SCHEMA`（可选）→ 校验 `on_bar` 存在
//! → 构建并冻结 params 对象 → 调用 `init(params)`（可选）→ 每 bar `on_bar(ctx)`。

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use backtest::{Bar, Indicators, ParamValue, StrategyParams};
use rquickjs::context::intrinsic::{Eval, Json, MapSet, TypedArrays};
use rquickjs::{
    Coerced, Context, Ctx, FromJs, Function, IntoJs, Object, Persistent, Runtime, Value,
};
use serde::Deserialize;

use crate::error::PluginError;
use crate::runtime::{PluginInstance, PluginRuntime};
use crate::types::{clamp_score, BarCtx, ParamDef, ParamKind, RuntimeLimits};

/// 沙箱守卫脚本：锁死 Math.random，并防御性清理可能残留的禁用全局（双保险，
/// 正常路径下 Date/timer/fetch/require 因 intrinsics 裁剪本就不存在）。
/// 能力桩抛 `name = "CapabilityError"` 的自定义错误（MINOR-1 裁决）：宿主按 error name
/// 归类 CapabilityViolation，不依赖消息子串，插件无法以普通 Error 伪造归类。
const SANDBOX_GUARD: &str = r#"
(function () {
  "use strict";
  function ban(name) {
    return function () {
      var e = new Error("capability-forbidden: " + name + "（策略沙箱禁用能力，ABI G1）");
      e.name = "CapabilityError";
      throw e;
    };
  }
  if (typeof Math !== "undefined") {
    Object.defineProperty(Math, "random", {
      value: ban("Math.random"),
      writable: false,
      configurable: false
    });
  }
  var banned = ["Date", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch", "require"];
  for (var i = 0; i < banned.length; i++) {
    try { delete globalThis[banned[i]]; } catch (e) { /* 忽略 */ }
  }
})();
"#;

/// 能力桩错误的 error name（宿主按 name 归类 CapabilityViolation，MINOR-1 裁决）。
const CAPABILITY_ERROR_NAME: &str = "CapabilityError";

/// 禁用全局标识符（G1）：ReferenceError 信息中命中其一即归类 CapabilityViolation。
const FORBIDDEN_GLOBALS: &[&str] = &[
    "Date",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "fetch",
    "require",
    "XMLHttpRequest",
    "WebSocket",
];

/// per-call 超时截止时间（interrupt handler 共享状态）。`None` = 未 arm。
type DeadlineState = Rc<Cell<Option<Instant>>>;

/// 调用期超时守卫：创建即 arm，析构即解除（含 panic 路径）。
struct DeadlineGuard(DeadlineState);

impl DeadlineGuard {
    fn arm(state: &DeadlineState, timeout: Duration) -> Self {
        state.set(Some(Instant::now() + timeout));
        Self(state.clone())
    }
}

impl Drop for DeadlineGuard {
    fn drop(&mut self) {
        self.0.set(None);
    }
}

/// QuickJS 插件运行时（`PluginRuntime` 首个实现）。构造时接收 [`RuntimeLimits`]。
pub struct QuickJsRuntime {
    limits: RuntimeLimits,
}

impl QuickJsRuntime {
    pub fn new(limits: RuntimeLimits) -> Self {
        Self { limits }
    }
}

impl PluginRuntime for QuickJsRuntime {
    fn instantiate(
        &mut self,
        code_hash: &str,
        code: &str,
        params: &StrategyParams,
    ) -> Result<Box<dyn PluginInstance>, PluginError> {
        let timeout = self.limits.per_call_timeout;
        // NIT-7：实例化阶段（eval + init）使用独立更宽时限，与 per-call 解耦。
        let instantiate_timeout = self.limits.instantiate_timeout;

        let runtime = Runtime::new()
            .map_err(|e| PluginError::JsException(format!("创建 QuickJS runtime 失败: {e}")))?;
        runtime.set_memory_limit(self.limits.memory_limit);

        // interrupt handler：到期返回 true → QuickJS 打断当前执行（G2 超时熔断）。
        let deadline: DeadlineState = Rc::new(Cell::new(None));
        {
            let shared = deadline.clone();
            runtime.set_interrupt_handler(Some(Box::new(move || {
                shared.get().is_some_and(|d| Instant::now() >= d)
            })));
        }

        // G1：仅注入白名单 intrinsics（BaseObjects 由 rquickjs 强制注入；Date/Performance/
        // Promise/Proxy/BigInt/WeakRef 一律不注入）。
        // 注：Eval 必须注入——实测（NIT-2，quickjs-ng 0.11）移除后宿主侧 ctx.eval 直接抛
        // Exception；插件内 eval/Function 仍在同一沙箱内执行，不能获得任何额外能力，不破坏 G1。
        let context = Context::custom::<(Eval, Json, MapSet, TypedArrays)>(&runtime)
            .map_err(|e| PluginError::JsException(format!("创建 QuickJS context 失败: {e}")))?;

        let code_hash = code_hash.to_string();
        let parts = context.with(|ctx| -> Result<InstanceParts, PluginError> {
            // 实例化阶段整体限时（eval + init），使用独立 instantiate_timeout（NIT-7）。
            let _guard = DeadlineGuard::arm(&deadline, instantiate_timeout);

            ctx.eval::<(), _>(SANDBOX_GUARD)
                .map_err(|e| js_call_err(&ctx, e, instantiate_timeout))?;
            ctx.eval::<Value, _>(code)
                .map_err(|e| js_call_err(&ctx, e, instantiate_timeout))?;

            let globals = ctx.globals();
            let on_bar_fn = require_global_fn(&ctx, &globals, "on_bar", &code_hash)?;
            let init_fn = optional_global_fn(&ctx, &globals, "init")?;
            let save_fn = optional_global_fn(&ctx, &globals, "save")?;
            let load_fn = optional_global_fn(&ctx, &globals, "load")?;

            let params_schema = extract_params_schema(&ctx, &code_hash)?;

            // params：构建（key 排序保证属性顺序确定）→ 冻结（ABI §2）→ 持久化复用。
            let params_obj = build_params_object(&ctx, params)?;
            freeze_object(&globals, &params_obj)?;

            if let Some(init) = &init_fn {
                init.clone()
                    .restore(&ctx)
                    .map_err(rt_err)?
                    .call::<_, ()>((params_obj.clone(),))
                    .map_err(|e| js_call_err(&ctx, e, instantiate_timeout))?;
            }

            Ok(InstanceParts {
                on_bar_fn: Persistent::save(&ctx, on_bar_fn),
                save_fn,
                load_fn,
                params_obj: Persistent::save(&ctx, params_obj),
                params_schema,
            })
        })?;

        Ok(Box::new(QuickJsInstance {
            deadline,
            timeout,
            code_hash,
            params_schema: parts.params_schema,
            on_bar_fn: parts.on_bar_fn,
            save_fn: parts.save_fn,
            load_fn: parts.load_fn,
            params_obj: parts.params_obj,
            context,
        }))
    }
}

/// instantiate 阶段在 `Context::with` 内组装的实例部件（跨 with 边界须为 Persistent）。
struct InstanceParts {
    on_bar_fn: Persistent<Function<'static>>,
    save_fn: Option<Persistent<Function<'static>>>,
    load_fn: Option<Persistent<Function<'static>>>,
    params_obj: Persistent<Object<'static>>,
    params_schema: Vec<ParamDef>,
}

/// QuickJS 插件实例（单 Runtime + 单 Context 隔离）。
///
/// 字段顺序即析构顺序（Rust 语义）：Persistent 必须先于 `context` 析构，
/// 否则 QuickJS runtime 释放时仍有存活 GC 对象（JS_FreeRuntime 断言失败）。
pub struct QuickJsInstance {
    deadline: DeadlineState,
    timeout: Duration,
    code_hash: String,
    params_schema: Vec<ParamDef>,
    on_bar_fn: Persistent<Function<'static>>,
    save_fn: Option<Persistent<Function<'static>>>,
    load_fn: Option<Persistent<Function<'static>>>,
    params_obj: Persistent<Object<'static>>,
    /// 必须最后声明（最后析构）。
    context: Context,
}

impl PluginInstance for QuickJsInstance {
    fn on_bar(&mut self, bctx: &BarCtx<'_>) -> Result<f64, PluginError> {
        let _guard = DeadlineGuard::arm(&self.deadline, self.timeout);
        let timeout = self.timeout;
        self.context
            .with(|ctx| {
                let on_bar = self.on_bar_fn.clone().restore(&ctx).map_err(rt_err)?;
                let params = self.params_obj.clone().restore(&ctx).map_err(rt_err)?;
                let ctx_obj = build_ctx_object(&ctx, bctx, params)?;
                let value = on_bar
                    .call::<_, Value>((ctx_obj,))
                    .map_err(|e| js_call_err(&ctx, e, timeout))?;
                score_from_value(&value, bctx.index)
            })
            // G5（MINOR-2 裁决）：on_bar 路径错误自含 sha256 + bar_index。
            .map_err(|e| PluginError::on_bar(&self.code_hash, bctx.index, e))
    }

    fn save(&self) -> Result<Option<serde_json::Value>, PluginError> {
        let Some(save_fn) = &self.save_fn else {
            return Ok(None); // 未定义 save() 才是 None（ABI §4）。
        };
        let _guard = DeadlineGuard::arm(&self.deadline, self.timeout);
        let timeout = self.timeout;
        self.context.with(|ctx| {
            let f = save_fn.clone().restore(&ctx).map_err(rt_err)?;
            let value = f
                .call::<_, Value>(())
                .map_err(|e| js_call_err(&ctx, e, timeout))?;
            // 循环引用等 → QuickJS json_stringify 抛 TypeError（Err）或返回 None，均须上报。
            let json = ctx
                .json_stringify(value)
                .map_err(|e| js_call_err(&ctx, e, timeout))?
                .ok_or_else(|| {
                    PluginError::JsException(format!(
                        "插件 {} 的 save() 返回值不可 JSON 序列化（ABI G3）",
                        self.code_hash
                    ))
                })?;
            let json = json.to_string().map_err(rt_err)?;
            serde_json::from_str(&json).map(Some).map_err(|e| {
                PluginError::JsException(format!(
                    "插件 {} 的 save() 返回值 serde 解析失败: {e}",
                    self.code_hash
                ))
            })
        })
    }

    fn load(&mut self, state: &serde_json::Value) -> Result<(), PluginError> {
        let Some(load_fn) = &self.load_fn else {
            return Err(PluginError::JsException(format!(
                "插件 {} 未定义 load(state)，无法恢复状态（ABI G3）",
                self.code_hash
            )));
        };
        let json = serde_json::to_string(state)
            .map_err(|e| PluginError::JsException(format!("状态快照序列化失败: {e}")))?;
        let _guard = DeadlineGuard::arm(&self.deadline, self.timeout);
        let timeout = self.timeout;
        self.context.with(|ctx| {
            let f = load_fn.clone().restore(&ctx).map_err(rt_err)?;
            let value = ctx.json_parse(json).map_err(|e| js_call_err(&ctx, e, timeout))?;
            f.call::<_, ()>((value,))
                .map_err(|e| js_call_err(&ctx, e, timeout))
        })
    }

    fn params_schema(&self) -> &[ParamDef] {
        &self.params_schema
    }
}

// ---------------------------------------------------------------------------
// ctx 对象构造（ABI §2 / §2.5）
// ---------------------------------------------------------------------------

/// 构建每 bar 注入的 JS `ctx` 对象：index / params（冻结复用）/ bar / indicators / position / log。
///
/// 指标函数以 Rust 闭包注入，host 侧用 `backtest::Indicators` 对 `bars[0..=index]` 惰性计算，
/// 数据不足返回 JS null（ABI §2）。
fn build_ctx_object<'js>(
    ctx: &Ctx<'js>,
    bctx: &BarCtx<'_>,
    params: Object<'js>,
) -> Result<Object<'js>, PluginError> {
    let obj = Object::new(ctx.clone()).map_err(rt_err)?;
    obj.set("index", bctx.index as f64).map_err(rt_err)?;
    obj.set("params", params).map_err(rt_err)?;

    let bar = Object::new(ctx.clone()).map_err(rt_err)?;
    bar.set("ts", bctx.bar.ts as f64).map_err(rt_err)?;
    bar.set("open", bctx.bar.open).map_err(rt_err)?;
    bar.set("high", bctx.bar.high).map_err(rt_err)?;
    bar.set("low", bctx.bar.low).map_err(rt_err)?;
    bar.set("close", bctx.bar.close).map_err(rt_err)?;
    bar.set("volume", bctx.bar.volume).map_err(rt_err)?;
    obj.set("bar", bar).map_err(rt_err)?;

    obj.set("indicators", build_indicators(ctx, bctx)?)
        .map_err(rt_err)?;
    obj.set("position", build_position(ctx, bctx)?)
        .map_err(rt_err)?;

    let log_sink = bctx.log_sink();
    let log_fn = Function::new(ctx.clone(), move |msg: Coerced<String>| {
        log_sink.borrow_mut().push(msg.0);
    })
    .map_err(rt_err)?;
    obj.set("log", log_fn).map_err(rt_err)?;

    Ok(obj)
}

/// 数值或 JS null（数据不足口径，ABI §2）。
fn num_or_null<'js>(ctx: &Ctx<'js>, v: Option<f64>) -> rquickjs::Result<Value<'js>> {
    match v {
        Some(x) => x.into_js(ctx),
        None => Ok(Value::new_null(ctx.clone())),
    }
}

/// 三元组对象（macd/kdj/boll）或 JS null。
fn triple_or_null<'js>(
    ctx: &Ctx<'js>,
    v: Option<(f64, f64, f64)>,
    keys: (&str, &str, &str),
) -> rquickjs::Result<Value<'js>> {
    match v {
        Some((a, b, c)) => {
            let obj = Object::new(ctx.clone())?;
            obj.set(keys.0, a)?;
            obj.set(keys.1, b)?;
            obj.set(keys.2, c)?;
            obj.into_js(ctx)
        }
        None => Ok(Value::new_null(ctx.clone())),
    }
}

/// indicators 命名空间：ma/ema/macd(12,26,9)/kdj(9,3,3)/boll/rsi/atr。
/// macd 返回 `{dif, dea, macd}`（ABI §2 字段名；对应 backtest MacdValue.hist）。
///
/// 实现注记：rquickjs 注入闭包须满足其生命周期约束（不可借用 `BarCtx` 引用），
/// 故每 bar 将指标窗口 `bars[0..=index]` 复制入 `Rc<Vec<Bar>>` 供 7 个指标闭包共享
/// （复制成本 O(index)；P1 引擎侧如需优化可改传共享历史缓冲，口径不变）。
fn build_indicators<'js>(ctx: &Ctx<'js>, bctx: &BarCtx<'_>) -> Result<Object<'js>, PluginError> {
    let hist: Rc<Vec<Bar>> = Rc::new(bctx.bars[..=bctx.index].to_vec());
    let index = bctx.index;
    let obj = Object::new(ctx.clone()).map_err(rt_err)?;

    let c = ctx.clone();
    let h = hist.clone();
    let f = Function::new(ctx.clone(), move |n: f64| {
        num_or_null(&c, Indicators::new(&h, index).ma(n.max(0.0) as usize))
    })
    .map_err(rt_err)?;
    obj.set("ma", f).map_err(rt_err)?;

    let c = ctx.clone();
    let h = hist.clone();
    let f = Function::new(ctx.clone(), move |n: f64| {
        num_or_null(&c, Indicators::new(&h, index).ema(n.max(0.0) as usize))
    })
    .map_err(rt_err)?;
    obj.set("ema", f).map_err(rt_err)?;

    let c = ctx.clone();
    let h = hist.clone();
    let f = Function::new(ctx.clone(), move || {
        triple_or_null(
            &c,
            Indicators::new(&h, index)
                .macd(12, 26, 9)
                .map(|m| (m.dif, m.dea, m.hist)),
            ("dif", "dea", "macd"),
        )
    })
    .map_err(rt_err)?;
    obj.set("macd", f).map_err(rt_err)?;

    let c = ctx.clone();
    let h = hist.clone();
    let f = Function::new(ctx.clone(), move || {
        triple_or_null(
            &c,
            Indicators::new(&h, index).kdj(9, 3, 3).map(|k| (k.k, k.d, k.j)),
            ("k", "d", "j"),
        )
    })
    .map_err(rt_err)?;
    obj.set("kdj", f).map_err(rt_err)?;

    let c = ctx.clone();
    let h = hist.clone();
    let f = Function::new(ctx.clone(), move |n: f64, mult: f64| {
        triple_or_null(
            &c,
            Indicators::new(&h, index)
                .boll(n.max(0.0) as usize, mult)
                .map(|b| (b.mid, b.upper, b.lower)),
            ("mid", "upper", "lower"),
        )
    })
    .map_err(rt_err)?;
    obj.set("boll", f).map_err(rt_err)?;

    let c = ctx.clone();
    let h = hist.clone();
    let f = Function::new(ctx.clone(), move |n: f64| {
        num_or_null(&c, Indicators::new(&h, index).rsi(n.max(0.0) as usize))
    })
    .map_err(rt_err)?;
    obj.set("rsi", f).map_err(rt_err)?;

    let c = ctx.clone();
    let f = Function::new(ctx.clone(), move |n: f64| {
        num_or_null(&c, Indicators::new(&hist, index).atr(n.max(0.0) as usize))
    })
    .map_err(rt_err)?;
    obj.set("atr", f).map_err(rt_err)?;

    Ok(obj)
}

/// position（ABI §2.5）：纯试算恒 null；注入时为只读快照对象。
fn build_position<'js>(ctx: &Ctx<'js>, bctx: &BarCtx<'_>) -> Result<Value<'js>, PluginError> {
    match bctx.position {
        None => Ok(Value::new_null(ctx.clone())),
        Some(p) => {
            let obj = Object::new(ctx.clone()).map_err(rt_err)?;
            obj.set("qty", p.qty).map_err(rt_err)?;
            obj.set("avg_cost", p.avg_cost).map_err(rt_err)?;
            obj.set("entry_ts", p.entry_ts as f64).map_err(rt_err)?;
            obj.set("bars_since_entry", p.bars_since_entry as f64)
                .map_err(rt_err)?;
            obj.set("unrealized_pnl", p.unrealized_pnl).map_err(rt_err)?;
            obj.into_js(ctx).map_err(rt_err)
        }
    }
}

// ---------------------------------------------------------------------------
// 实例化辅助
// ---------------------------------------------------------------------------

/// 必需全局函数：缺失即实例化失败（ABI §1：on_bar 必须）。
fn require_global_fn<'js>(
    ctx: &Ctx<'js>,
    globals: &Object<'js>,
    name: &str,
    code_hash: &str,
) -> Result<Function<'js>, PluginError> {
    let declared: bool = ctx
        .eval(format!("typeof {name} === 'function'"))
        .map_err(rt_err)?;
    if !declared {
        return Err(PluginError::JsException(format!(
            "插件 {code_hash} 缺少必需的全局函数 {name}（ABI §1）"
        )));
    }
    globals.get(name).map_err(rt_err)
}

/// 可选全局函数（init/save/load），存在则持久化。
fn optional_global_fn<'js>(
    ctx: &Ctx<'js>,
    globals: &Object<'js>,
    name: &str,
) -> Result<Option<Persistent<Function<'static>>>, PluginError> {
    let declared: bool = ctx
        .eval(format!("typeof {name} === 'function'"))
        .map_err(rt_err)?;
    if !declared {
        return Ok(None);
    }
    let f: Function = globals.get(name).map_err(rt_err)?;
    Ok(Some(Persistent::save(ctx, f)))
}

/// params 对象：key 排序后插入（HashMap 迭代序不确定，排序保证属性枚举序确定，G1 确定性）。
fn build_params_object<'js>(
    ctx: &Ctx<'js>,
    params: &StrategyParams,
) -> Result<Object<'js>, PluginError> {
    let obj = Object::new(ctx.clone()).map_err(rt_err)?;
    let mut keys: Vec<&String> = params.keys().collect();
    keys.sort();
    for key in keys {
        match &params[key] {
            ParamValue::Num(v) => obj.set(key.as_str(), *v).map_err(rt_err)?,
            ParamValue::Choice(s) => obj.set(key.as_str(), s.as_str()).map_err(rt_err)?,
        }
    }
    Ok(obj)
}

/// Object.freeze（ABI §2：params 冻结，插件不可改）。
fn freeze_object<'js>(globals: &Object<'js>, obj: &Object<'js>) -> Result<(), PluginError> {
    let ctor: Object = globals.get("Object").map_err(rt_err)?;
    let freeze: Function = ctor.get("freeze").map_err(rt_err)?;
    freeze.call::<_, ()>((obj.clone(),)).map_err(rt_err)?;
    Ok(())
}

/// PARAMS_SCHEMA 提取（ABI §1）：全局可选；JSON.stringify 后由 serde 严格解析。
fn extract_params_schema(ctx: &Ctx<'_>, code_hash: &str) -> Result<Vec<ParamDef>, PluginError> {
    let value: Value = ctx
        .eval("(typeof PARAMS_SCHEMA === 'undefined') ? null : PARAMS_SCHEMA")
        .map_err(rt_err)?;
    if value.is_null() || value.is_undefined() {
        return Ok(Vec::new());
    }
    let json = ctx
        .json_stringify(value)
        .map_err(rt_err)?
        .ok_or_else(|| {
            PluginError::SchemaError(format!("插件 {code_hash} 的 PARAMS_SCHEMA 不可 JSON 序列化"))
        })?;
    let json = json.to_string().map_err(rt_err)?;

    #[derive(Deserialize)]
    struct RawParamDef {
        key: String,
        #[serde(rename = "type")]
        kind: String,
        default: Option<f64>,
        min: Option<f64>,
        max: Option<f64>,
        description: Option<String>,
    }

    let raw: Vec<RawParamDef> = serde_json::from_str(&json).map_err(|e| {
        PluginError::SchemaError(format!("插件 {code_hash} 的 PARAMS_SCHEMA 须为对象数组: {e}"))
    })?;
    // NIT-4：重复 key 拒绝（静默取其一会掩盖策略作者的声明错误）。
    {
        let mut seen = std::collections::HashSet::with_capacity(raw.len());
        for r in &raw {
            if !seen.insert(r.key.as_str()) {
                return Err(PluginError::SchemaError(format!(
                    "插件 {code_hash} 的 PARAMS_SCHEMA 存在重复 key '{}'",
                    r.key
                )));
            }
        }
    }
    raw.into_iter()
        .map(|r| {
            let kind = match r.kind.as_str() {
                "int" => ParamKind::Int,
                "float" => ParamKind::Float,
                other => {
                    return Err(PluginError::SchemaError(format!(
                        "插件 {code_hash} 参数 '{}' 的 type 须为 int|float，实际 '{other}'",
                        r.key
                    )))
                }
            };
            let default = r.default.ok_or_else(|| {
                PluginError::SchemaError(format!("插件 {code_hash} 参数 '{}' 缺少 default", r.key))
            })?;
            if r.key.is_empty() {
                return Err(PluginError::SchemaError(format!(
                    "插件 {code_hash} 存在空 key 的参数声明"
                )));
            }
            Ok(ParamDef {
                key: r.key,
                kind,
                default,
                min: r.min,
                max: r.max,
                description: r.description,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 评分收敛与错误归类
// ---------------------------------------------------------------------------

/// on_bar 返回值收敛（ABI G6）：有限数值 clamp [0,100]；NaN/无穷/非数值 → InvalidScore。
fn score_from_value(value: &Value<'_>, bar_index: usize) -> Result<f64, PluginError> {
    match value.as_number() {
        Some(x) if x.is_finite() => Ok(clamp_score(x)),
        Some(x) => Err(PluginError::InvalidScore(format!(
            "bar {bar_index} 返回非有限数值 {x}"
        ))),
        None => Err(PluginError::InvalidScore(format!(
            "bar {bar_index} 返回非数值类型"
        ))),
    }
}

/// QuickJS 非异常类错误（转换失败等）兜底。
fn rt_err(e: rquickjs::Error) -> PluginError {
    PluginError::JsException(format!("QuickJS 宿主错误: {e}"))
}

/// JS 调用失败归类：Exception → 取 catch 值细分；其余兜底 JsException。
fn js_call_err(ctx: &Ctx<'_>, e: rquickjs::Error, timeout: Duration) -> PluginError {
    match e {
        rquickjs::Error::Exception => classify_exception(ctx.catch(), timeout),
        other => rt_err(other),
    }
}

/// 异常细分（G1/G2/G5；MINOR-1 裁决防伪造）：
/// - interrupted → Timeout / out of memory → MemoryExceeded：均要求
///   `name == "InternalError"` + 消息**精确匹配**（实测 quickjs-ng 0.11 原文；
///   插件 `throw new Error("interrupted")` 之类伪造只归类 JsException）；
/// - 能力桩抛 `name == "CapabilityError"` 的自定义错误 → CapabilityViolation（按 name 归类，
///   不依赖消息子串）；
/// - 禁用全局 ReferenceError → CapabilityViolation；其余 → JsException。
fn classify_exception(value: Value<'_>, timeout: Duration) -> PluginError {
    let (name, message) = exception_text(&value);
    let name = name.as_deref();
    if name == Some("InternalError") && message == "interrupted" {
        return PluginError::Timeout(timeout);
    }
    if name == Some("InternalError") && message == "out of memory" {
        return PluginError::MemoryExceeded;
    }
    if name == Some(CAPABILITY_ERROR_NAME) {
        return PluginError::CapabilityViolation(message);
    }
    if name == Some("ReferenceError") {
        // quickjs-ng 的信息格式为 "Date is not defined"（无引号），两种格式都兼容。
        for id in FORBIDDEN_GLOBALS {
            if message.contains(&format!("'{id}'"))
                || message.contains(&format!("{id} is not defined"))
            {
                return PluginError::CapabilityViolation(format!(
                    "引用被禁全局 '{id}': {message}"
                ));
            }
        }
    }
    let prefix = name.unwrap_or("Error").to_string();
    PluginError::JsException(format!("{prefix}: {message}"))
}

/// 从 catch 值提取 (name, message)；支持 Error 对象与任意 throw 值。
fn exception_text(value: &Value<'_>) -> (Option<String>, String) {
    if let Some(obj) = value.clone().into_object() {
        let name = obj.get::<_, String>("name").ok();
        let message = obj
            .get::<_, String>("message")
            .ok()
            .unwrap_or_else(|| "(无 message)".to_string());
        (name, message)
    } else {
        let message = Coerced::<String>::from_js(value.ctx(), value.clone())
            .map(|c| c.0)
            .unwrap_or_default();
        (None, message)
    }
}

// （测试见模块末尾。）

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::PluginRuntime;
    use crate::types::BarCtx;
    use backtest::Bar;

    fn bars(n: usize) -> Vec<Bar> {
        (0..n)
            .map(|i| Bar {
                ts: 1_700_000_000 + i as i64 * 86_400,
                open: 10.0,
                high: 10.5,
                low: 9.5,
                close: 10.0 + i as f64 * 0.1,
                volume: 1_000.0,
            })
            .collect()
    }

    fn instantiate(code: &str) -> Box<dyn PluginInstance> {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        rt.instantiate("sha256:test", code, &StrategyParams::new())
            .expect("instantiate")
    }

    #[test]
    fn math_random_is_forbidden() {
        let mut inst = instantiate("function on_bar(ctx) { return Math.random(); }");
        let bs = bars(1);
        let ctx = BarCtx::new(0, bs[0].clone(), &bs, None);
        match inst.on_bar(&ctx) {
            // on_bar 路径错误包装 OnBar（G5），根本原因为 CapabilityViolation。
            Err(e) if matches!(e.root_cause(), PluginError::CapabilityViolation(_)) => {
                assert!(e.to_string().contains("Math.random"), "信息须指明能力名: {e}")
            }
            other => panic!("Math.random 必须报 CapabilityViolation，实际: {other:?}"),
        }
    }

    #[test]
    fn math_legit_functions_still_work() {
        // Math 本体保留（仅 random 被锁死）：sqrt/floor 等确定函数可用。
        let mut inst = instantiate("function on_bar(ctx) { return Math.floor(Math.sqrt(81)); }");
        let bs = bars(1);
        let ctx = BarCtx::new(0, bs[0].clone(), &bs, None);
        assert_eq!(inst.on_bar(&ctx).expect("on_bar"), 9.0);
    }

    #[test]
    fn date_is_absent_from_sandbox() {
        let mut inst =
            instantiate("function on_bar(ctx) { return typeof Date === 'undefined' ? 1 : 0; }");
        let bs = bars(1);
        let ctx = BarCtx::new(0, bs[0].clone(), &bs, None);
        assert_eq!(inst.on_bar(&ctx).expect("on_bar"), 1.0);
    }

    #[test]
    fn missing_on_bar_fails_instantiate() {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let res = rt.instantiate("sha256:bad", "const x = 1;", &StrategyParams::new());
        assert!(
            matches!(res, Err(PluginError::JsException(_))),
            "实际: {:?}",
            res.map(|_| ())
        );
    }

    #[test]
    fn syntax_error_fails_instantiate() {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let res = rt.instantiate("sha256:bad", "function on_bar(ctx) { return", &StrategyParams::new());
        assert!(
            matches!(res, Err(PluginError::JsException(_))),
            "实际: {:?}",
            res.map(|_| ())
        );
    }

    #[test]
    fn malformed_schema_fails_with_schema_error() {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let code = r#"
            const PARAMS_SCHEMA = [{ key: "x", type: "string", default: 1 }];
            function on_bar(ctx) { return 1; }
        "#;
        let res = rt.instantiate("sha256:bad", code, &StrategyParams::new());
        match res {
            Err(PluginError::SchemaError(msg)) => assert!(msg.contains("int|float"), "{msg}"),
            Ok(_) => panic!("非法 type 须报 SchemaError，实际实例化成功"),
            Err(other) => panic!("非法 type 须报 SchemaError，实际: {other:?}"),
        }
    }

    #[test]
    fn duplicate_param_key_is_schema_error() {
        // NIT-4：PARAMS_SCHEMA 重复 key 必须拒绝（SchemaError），不得静默取其一。
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let code = r#"
            const PARAMS_SCHEMA = [
              { key: "fast", type: "int", default: 5 },
              { key: "fast", type: "float", default: 1.0 }
            ];
            function on_bar(ctx) { return 1; }
        "#;
        let res = rt.instantiate("sha256:dup", code, &StrategyParams::new());
        match res {
            Err(PluginError::SchemaError(msg)) => assert!(msg.contains("fast"), "{msg}"),
            Ok(_) => panic!("重复 key 须报 SchemaError，实际实例化成功"),
            Err(other) => panic!("重复 key 须报 SchemaError，实际: {other:?}"),
        }
    }

    #[test]
    fn params_frozen_and_passed() {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let params = StrategyParams::from([("fast".to_string(), ParamValue::Num(5.0))]);
        // 试图改写 params：strict 模式抛 TypeError（异常），sloppy 静默忽略（返回 5）。
        // 两种路径都证明冻结生效；返回值永远不得变成 99。
        let mut inst = rt
            .instantiate(
                "sha256:p",
                "function on_bar(ctx) { ctx.params.fast = 99; return ctx.params.fast; }",
                &params,
            )
            .expect("instantiate");
        let bs = bars(1);
        let ctx = BarCtx::new(0, bs[0].clone(), &bs, None);
        match inst.on_bar(&ctx) {
            Ok(v) => assert_eq!(v, 5.0, "params 不可被插件改写"),
            Err(e) if matches!(e.root_cause(), PluginError::JsException(_)) => {} // strict 模式冻结写抛 TypeError，同样满足冻结语义
            other => panic!("意外结果: {other:?}"),
        }
    }

    #[test]
    fn indicators_match_backtest_and_null_when_insufficient() {
        // 数据不足返回 null；足量后与 backtest::Indicators 口径逐点一致（ABI §2）。
        let code = r#"
            function on_bar(ctx) {
              var m3 = ctx.indicators.ma(3);
              return m3 === null ? -1 : m3;
            }
        "#;
        let mut inst = instantiate(code);
        let bs = bars(10);
        for (i, bar) in bs.iter().enumerate() {
            let ctx = BarCtx::new(i, bar.clone(), &bs, None);
            let got = inst.on_bar(&ctx).expect("on_bar");
            let expected = Indicators::new(&bs, i).ma(3).map_or(0.0, |v| v); // -1 clamp 到 0
            assert_eq!(got, expected, "bar {i} ma(3) 口径须与 backtest 一致");
        }
        // 前 2 根 ma(3) 为 null → 插件返回 -1 → clamp 到 0；第 3 根起为真实值。
        let ctx = BarCtx::new(2, bs[2].clone(), &bs, None);
        assert!(inst.on_bar(&ctx).unwrap() > 0.0);
    }

    #[test]
    fn load_without_hook_errors() {
        let mut inst = instantiate("function on_bar(ctx) { return 1; }");
        let res = inst.load(&serde_json::json!({}));
        assert!(matches!(res, Err(PluginError::JsException(_))), "实际: {res:?}");
    }

    #[test]
    fn non_finite_score_is_invalid() {
        let mut inst = instantiate("function on_bar(ctx) { return Infinity; }");
        let bs = bars(1);
        let ctx = BarCtx::new(0, bs[0].clone(), &bs, None);
        let res = inst.on_bar(&ctx);
        assert!(
            matches!(&res, Err(e) if matches!(e.root_cause(), PluginError::InvalidScore(_))),
            "实际: {res:?}"
        );
    }

    #[test]
    fn save_error_variants_are_reported() {
        // MAJOR-1：save() 契约 —— 未定义 → Ok(None)；抛错 → Err；正常 → Ok(Some)。
        let inst = instantiate("function on_bar(ctx) { return 1; }");
        assert!(matches!(inst.save(), Ok(None)));

        let inst = instantiate(
            "function on_bar(ctx) { return 1; } function save() { throw new Error('x'); }",
        );
        assert!(matches!(inst.save(), Err(PluginError::JsException(_))));

        let inst =
            instantiate("function on_bar(ctx) { return 1; } function save() { return {a: 1}; }");
        assert_eq!(inst.save().expect("save"), Some(serde_json::json!({"a": 1})));
    }
}
