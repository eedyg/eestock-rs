# 策略编程手册（用户 & MCP AI 共用）

> 版本：v1（2026-09-10） · 权威契约：`02-plugin-abi.md`（冲突时以 ABI 为准）
> 适用：统一策略系统全部场景——回测工作台 / 模拟实盘 /（未来）实盘。同一插件三处行为一致。

---

## 1. 三分钟上手

策略 = 一段 JavaScript，**每根 K 线被调用一次，返回 0~100 的分数**。系统把多个策略的分数
按权重聚合成「总分」，总分驱动交易（默认 ≥60 买入、≤40 卖出，可配置）。

```js
// 最小完整策略：双均线
const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5,  min: 1, max: 250, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" }
];

function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  if (fast === null || slow === null) return 50; // 数据不足 → 中立
  return fast > slow ? 80 : 30;
}
```

分数语义（建议约定，参考插件同款）：**80=强烈看多 / 50=中立 / 20=强烈看空**。
聚合阈值默认 60/40，因此 80 会触发买入区、20 触发卖出区、50 落在观望区。

**新手路径**：策略列表 → 新建 → 选模板（纯评分/两态门控/定投/趋势+止损）→
试算面板选标的跑一遍 → 发布 → 工作台/模拟实盘下拉选用。

## 2. 插件结构（全部钩子）

```js
const PARAMS_SCHEMA = [ /* 可选：参数声明，驱动 UI 表单 */ ];

function init(params)        { /* 可选：实例化时一次，建内部状态 */ }
function on_bar(ctx)         { /* 必须：每 bar 调用，返回 0~100 数值 */ }
function save()              { /* 可选：返回 JSON 可序列化的内部状态快照 */ }
function load(state)         { /* 可选：从快照恢复状态 */ }
```

- **返回值**：有限数值，越界自动截断到 [0,100]；返回 NaN/非数值按插件异常处理。
- **内部状态**：模块级变量在实例生命周期内持续有效；**凡有状态必须实现 save()/load()**
  （快照是暂停/恢复/精确重放的前提）。恢复时做防御性判空（快照可能损坏）。
- **确定性红线**：插件必须是纯函数——**禁止 Date/Math.random/网络/文件/定时器**
  （沙箱已物理禁用，引用即报错）。相同代码+相同数据必须得到相同分数序列。

## 3. ctx 完全参考（宿主每 bar 注入）

```ts
ctx.index          // 当前 bar 序号（0 起）
ctx.params         // 参数对象（冻结，按 PARAMS_SCHEMA 校验/填缺省后的值）
ctx.bar            // { ts, open, high, low, close, volume }（ts 为 Unix 秒）
ctx.indicators     // 指标命名空间（见 §4）
ctx.position       // 持仓全景（只读；空仓为 null）：
                   // { qty, avg_cost, entry_ts, bars_since_entry, unrealized_pnl }
ctx.log(msg)       // 输出日志（插件唯一副作用通道；落运行事件流，试算/事件日志可见）
```

**position 要点**：
- 回测/模拟实盘中是**真实执行后的组合持仓**（position-aware 写法的根基）；
- 「纯评分」试算模式下恒为 `null`——调试门控/定投/止损逻辑请用「模拟持仓」试算模式；
- 只读：修改它不影响任何执行结果；插件永远拿不到下单接口（架构红线）。

## 4. 指标 API（宿主侧计算，口径统一；数据不足返回 `null`，务必判空）

| 调用 | 返回 | 说明 |
|---|---|---|
| `ma(n)` / `ema(n)` | 数值\|null | 简单/指数移动平均（收盘价） |
| `macd()` | `{dif, dea, macd}`\|null | 固定参数 (12,26,9)；需要自定义周期请自持 EMA 增量复算（参考 macd.js 插件） |
| `kdj()` | `{k, d, j}`\|null | 固定 (9,3,3) |
| `boll(n, mult)` | `{mid, upper, lower}`\|null | 参数可配 |
| `rsi(n)` | 数值\|null | |
| `atr(n)` | 数值\|null | Wilder 平滑 |

```js
const m = ctx.indicators.boll(20, 2);
if (m === null) return 50;                       // 判空是义务不是建议
if (ctx.bar.close < m.lower) return 85;          // 破下轨，超卖看多
```

需要指标历史序列（而非当前值）时，用模块级变量自持滚动窗口（参考 kdj.js/momentum.js 插件）。

## 4.5 历史数据的获取（边界与两条通道）

**插件拿不到原始历史 bar 数组**——`ctx.bar` 只有当前这一根，这是有意设计
（历史消费必须走受控通道，保证确定性与口径统一）：

**通道 1：指标（首选）**。宿主已对 `bars[0..=index]` 全窗口算好指标，`ma(20)` 就是
「过去 20 根的均价」——绝大多数历史需求指标已覆盖（见 §4 表）。

**通道 2：自持滚动窗口（需要原始值序列时）**。模块级变量自己攒：

```js
// 例：Donchian 通道（需要过去 N 根的最高价，momentum.js 参考插件同款模式）
let highs = [], lows = [];
const N = 20;

function on_bar(ctx) {
  // 先用「不含当前 bar」的窗口判定（避免当前 bar 恒 ≤ 自身 high 的自破位）
  if (highs.length >= N) {
    const upper = Math.max(...highs.slice(-N));
    if (ctx.bar.close > upper) return 85;   // 突破 N 日新高
  }
  highs.push(ctx.bar.high); lows.push(ctx.bar.low);   // 判定后推窗
  if (highs.length > N) { highs.shift(); lows.shift(); }
  return 50;
}
// 滚动状态必须进快照，否则恢复/重放后行为分叉：
function save() { return { highs, lows }; }
function load(s) { highs = s.highs || []; lows = s.lows || []; }
```

可模仿的仓内模式：`kdj.js`（RSV 滚动窗）、`macd.js`（EMA 增量复算）、
`momentum.js`/`atr_channel.js`（Donchian 通道 + 状态快照）。

> 若确需直接读「k 根前那根 bar」（指标覆盖不了的场景），ABI 预留了扩展候选
> `ctx.bar_at(k)`（0=当前，越界 null）——尚未启用，启用时手册会更新。

## 5. 参数（PARAMS_SCHEMA）

```js
const PARAMS_SCHEMA = [
  { key: "period", type: "int",   default: 14, min: 1, max: 100, description: "周期" },
  { key: "ratio",  type: "float", default: 0.5, min: 0, max: 1,   description: "比例" }
];
```

- `type` 仅支持 `int` / `float`；`default` 必填；`min/max/description` 可选；key 不可重复。
- 消费方（工作台/试算/sim-live）按 schema 渲染参数表单并校验（未知键/越界 → 400）。
- **仓位不是参数**：买多少由运行配置的 ExecutionPolicy 决定（LumpSum 一次性 / DCA 分批），
  插件不要声明 position_pct 类参数。

## 6. 四个官方模板（新建策略的起点）

| 模板 | 教你什么 |
|---|---|
| 纯评分 | 最小骨架 + null 判空 |
| 两态门控 | `position === null` 时才给买入区高分——持仓中保持中立，避免重复买入 |
| 定投 | 用 `position.bars_since_entry` / `qty` 控制分批节奏（配合 DCA Policy） |
| 趋势+止损 | `close < position.avg_cost × (1−stop_pct)` 时输出 0 拖低总分（软止损） |

## 7. 评分如何变成交易（理解系统行为）

1. 每 bar：各策略评分 → 按权重加权平均（权重运行时可调）→ **总分**；
2. 总分 ≥ 买阈（默认 60）→ 买信号；≤ 卖阈（默认 40）→ 卖信号；否则观望；
3. ExecutionPolicy 把信号换算成目标仓位（重复信号无副作用）；
4. 可配硬止损（fixed_pct/trailing/atr × bar 内或收盘触发）——触发时**绕过评分直接平仓**。

**设计你的分数**：想"持仓中不再加仓"→ 持仓时给 50；想"尽快逃顶"→ 条件满足给 0~20；
想让策略在聚合中更有话语权 → 让运行配置调高它的权重，而不是把分数拉满。

## 8. 调试与排错

- **试算双模式**：纯评分（position=null，看原始反应）/ 模拟持仓（自己的分数驱动模拟成交，
  调 DCA/止损/门控必选）。
- `ctx.log()` 输出出现在试算结果与工作台「事件日志」Tab。
- 插件出错不会炸掉回测：该 bar 记中立分 50 + 错误事件；**连续错 10 次会被熔断停用**
  （事件日志有告警）。错误事件含代码哈希与 bar 序号。
- 超时/内存：单次 on_bar 限 50ms（试算更紧），内存限 64MB——死循环会被打断记为超时。
- 常见错误：`ma(250)` 数据不足返回 null 未判空；参数 key 拼错读到 undefined；
  模块级状态忘记写进 save()（恢复后行为分叉）。

## 9. 生命周期与治理

- **草稿（draft）**：随便改、可删除；**发布（published）**：不可变——编辑它会自动产生新草稿版本，
  历史回测钉住旧版本不受影响；**归档（archived）**：不再出现在选用列表。
- 发布前系统会做真实实例化冒烟（语法/on_bar 存在/schema 合法），坏代码发不出去。
- 每个 published 版本有 sha256；每次回测/会话钉住 {strategy_id, version, sha256}——
  完全可复现。

## 10. 参考实现（仓内可读）

7 款参考插件：dual_ma / ma_rsi / macd / boll / kdj / momentum / atr_channel——
覆盖金叉死叉、带过滤交叉、增量复算、双 mode、滚动窗口、通道突破、ATR 止损等典型模式，
是写新策略最好的模仿对象（策略列表 kind=strategy 的 seed 条目）。

## 11. MCP AI 使用指引

- `strategy_list` 看可用策略（含各版本与参数 schema）；`strategy_get` 看详情；
- 创建/修改：`strategy_create`（v1 草稿）→ `strategy_test_run` 反复试算 → `strategy_publish`；
- 回测：`bt_run_ensemble`（多策略 slots + 权重 + 阈值 + policy + stop）→ `bt_get_run` 轮询 →
  `bt_get_run_result` / `bt_compare_runs`；常用配置存预设（`bt_list_presets`/`bt_apply_preset`）；
- 本手册可经 `strategy_guide` 工具随时取回最新版。
