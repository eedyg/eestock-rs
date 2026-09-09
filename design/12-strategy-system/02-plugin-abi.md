# 12-strategy-system / 02 — 插件 ABI 接口契约（权威）

> 状态：**待批复**。本文件是 PluginRuntime 与策略插件之间的**唯一权威契约**；
> 任何运行时实现（QuickJS 首期 / WASM 未来）必须满足本契约 + 通过契约测试套件（01-ADR §9）。

---

## 1. 插件形态（JS，纯文本，存 strategy_version.code）

插件为一个 JS 文件，导出（定义为全局函数）下列生命周期钩子。**除 host 注入对象外无任何全局能力**（无 Date/Math.random/setTimeout/fetch/require 等）。

```js
// 参数 schema：编辑器/消费方 UI 据此渲染表单（声明式，必须为首行级字面量）
const PARAMS_SCHEMA = [
  { key: "fast",    type: "int",   default: 5,  min: 1, max: 250, description: "快线周期" },
  { key: "slow",    type: "int",   default: 20, min: 2, max: 250, description: "慢线周期" },
  { key: "weight_hint", type: "float", default: 1.0, description: "建议聚合权重（仅提示）" }
];

// 可选：初始化。params 为已按 schema 校验/填缺省后的对象。
function init(params) { /* 建内部状态 */ }

// 必须：每 bar 调用。返回 0-100 连续分（越界由 host clamp；非数值视为错误）。
function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  return fast > slow ? 80 : 30;
}

// 可选：状态快照（host 持有，用于暂停/恢复/精确重放）。必须 JSON 可序列化。
// save() 抛错不会静默吞没——host 上报错误事件（ADR §10 禁止静默吞错）。
function save() { return { /* state */ }; }
function load(state) { /* 恢复 */ }
```

> 参数归属（评审 NIT-6 裁决）：params 按 schema **校验/填缺省是引擎/Registry 职责**（消费方传入前完成）；运行时原样透传，不做缺省填充。

## 2. Host 注入对象（ctx）

```ts
ctx = {
  index: number,                       // 当前 bar 序号（0 起）
  params: Record<string, number|string>,// init 时同一对象（冻结）
  bar: { ts, open, high, low, close, volume },   // ts = Unix 秒
  indicators: {
    ma(n): number|null,                // 数据不足返回 null（策略需自行判空）
    ema(n): number|null,
    macd(): { dif, dea, macd }|null,
    kdj(): { k, d, j }|null,
    boll(n, mult): { mid, upper, lower }|null,
    rsi(n): number|null,
    atr(n): number|null
  },
  log(msg: string): void               // 唯一副作用通道；落 run 事件流，带 Trace ID
}
```

- 指标由 **host 侧确定性计算**（复用 `backtest::Indicators`，口径与 Rust 策略完全一致）——插件不可自行取数。
- `ctx` 每 bar 新建，插件不得跨 bar 持有其引用（状态必须存于自身并经 save/load 导出）。

### 2.5 持仓全景（D9 增补，只读）

```ts
ctx.position: null | {
  qty: number,              // 当前持仓股数（0 等同空仓时 host 给 null）
  avg_cost: number,         // 摊薄成本价
  entry_ts: number,         // 首次建仓时间（Unix 秒）
  bars_since_entry: number, // 建仓以来经过的 bar 数（定投节奏/门控用）
  unrealized_pnl: number    // 浮动盈亏（金额）
}
```

- 回测/模拟实盘中为**真实执行后的组合持仓**（共享组合视角，所有插件看到同一份）；
  纯评分试算模式下恒 `null`。
- **只读**：插件修改该对象不影响任何执行结果；插件永远不获得下单/账户写接口（红线）。
- 语义后果：position-aware 插件在纯试算与组合回测中分数可能不同——文档注明，非 bug。

## 3. 确定性守卫（机制强制）

| # | 守卫 | 违约后果 |
|---|---|---|
| G1 | 沙箱无 Date/Math.random/IO/timer/网络全局对象 | 引用即 ReferenceError → 按插件异常处理 |
| G2 | 每次 `on_bar` 调用：超时（默认 50ms/次，可配）+ 内存上限（默认 64MB） | 超时/超限 → 异常事件 + 中立分 50 |
| G3 | 状态仅经 save/load（JSON），host 快照 | — |
| G4 | 发布版本 sha256 寻址；run 落库 {strategy_id,version,sha256,params,数据区间} | 重放用同哈希代码，逐分不差 |
| G5 | 异常隔离：单插件错误 → 该 bar 中立分 50 + 错误事件（**事件须含 sha256 + bar_index**——runtime 在 on_bar 路径的错误自含两字段）；连续 10 次 → 熔断停用并告警（**熔断计数/停用属引擎层 strategy-core 职责，非 runtime**） | 引擎永不因插件崩溃中断 |
| G6 | 返回值：有限数值 clamp 至 [0,100]；NaN/非数值 → 按异常处理 | — |

## 4. Rust 侧 Port（PluginRuntime trait，要点）

```rust
trait PluginRuntime {
    fn instantiate(&mut self, code_hash: &str, code: &str, params: &StrategyParams)
        -> Result<Box<dyn PluginInstance>, PluginError>;
}
trait PluginInstance {
    fn on_bar(&mut self, ctx: &BarCtx) -> Result<f64, PluginError>;  // host 侧 clamp；错误自含 sha256+bar_index
    // 评审 MAJOR-1 裁决（2026-09-09）：save 失败必须可上报，不得静默折叠为 None。
    fn save(&self) -> Result<Option<serde_json::Value>, PluginError>;
    fn load(&mut self, state: &serde_json::Value) -> Result<(), PluginError>;
}
```

- 实现以**燃料/超时+内存上限**配置构造（RunConfig 级可配，测试可收紧）。
- QuickJsRuntime 为首个实现；WASM 实现届时满足同一 trait + 契约测试即可插拔。

## 4.5 官方策略模板（D10）

模板 = 仓内 fixture 化参考插件，编辑器「新建策略」可选起点：
- `纯评分模板`：不读 position，最小骨架；
- `两态门控模板`：`position==null` 时才给买入区高分，持仓期给中立分——示范门控；
- `定投模板`：按 `bars_since_entry`/`qty` 与计划批次控制高分时机，配合 DCA Policy；
- `趋势+止损模板`：趋势评分 + `close < avg_cost×(1−stop_pct)` 时输出 0（软止损示范）。
模板代码入仓管理，随契约测试回归（模板本身也过确定性双跑）。

## 5. 契约测试套件（P0 交付物，任何实现必过）

| 用例 | fixture 插件 | 断言 |
|---|---|---|
| 确定性双跑 | dual_ma_ref | 同 fixture 两次运行分数序列逐点相等 |
| 状态 round-trip | stateful_counter | save→新实例 load→后续分数与原实例一致；save() 抛错时宿主收到错误（非静默 None） |
| 超时打断 | infinite_loop | 超时事件 + 中立分 + 引擎完成运行（「连续 N 次后熔断停用」断言归**引擎层契约测试**（P1 strategy-core），不在本套件） |
| 内存上限 | （内联大数组分配脚本，收紧限额） | 超限报 MemoryExceeded，runtime 可继续调度 |
| 栈深递归 | stack_overflow | 深递归抛错归类 JsException/InternalError，**进程不崩溃** |
| 异常隔离 | thrower | 错误事件含 sha256/bar_index + 其余插件不受影响 |
| 越界 clamp | boundary_clamp | -5→0、150→100；NaN → 异常处理 |
| 能力禁区 | 引用 Date.now() | ReferenceError 按异常处理，引擎继续 |
