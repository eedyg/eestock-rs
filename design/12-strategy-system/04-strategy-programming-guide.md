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

8 款参考插件：dual_ma / ma_rsi / macd / boll / kdj / momentum / atr_channel / dcap——
覆盖金叉死叉、带过滤交叉、增量复算、双 mode、滚动窗口、通道突破、ATR 止损、假想定投收益率（见 §12）等典型模式，
是写新策略最好的模仿对象（策略列表 kind=strategy 的 seed 条目）。

## 11. MCP AI 使用指引

- `strategy_list` 看可用策略（含各版本与参数 schema）；`strategy_get` 看详情；
- 创建/修改：`strategy_create`（v1 草稿）→ `strategy_test_run` 反复试算 → `strategy_publish`；
- 回测：`bt_run_ensemble`（多策略 slots + 权重 + 阈值 + policy + stop）→ `bt_get_run` 轮询 →
  `bt_get_run_result` / `bt_compare_runs`；常用配置存预设（`bt_list_presets`/`bt_apply_preset`）；
- 本手册可经 `strategy_guide` 工具随时取回最新版。

## 12. dcap 指标（假想定投收益率，参考插件）

> 精确口径（唯一事实源）：`design/14-dcap-indicator/02-spec.md`；决策：ADR-021（`design/14-dcap-indicator/01-adr.md`）。
> **dcap 不是宿主指标 API** —— 没有 `ctx.indicators.dcap(...)`；它是一支**参考插件**（策略列表种子条目，§10），
> 需要按 §4.5 通道 2 自持滚动窗口。前端 K 线副图 `DCAP` 与本插件**同源同数**（ADR-021 双产物 + 门禁）。

### 12.1 指标语义："假想定投收益率"

在最近 `n` 根 bar 内，每根 bar 投入一笔资金，第 `k` 笔金额是首笔的 `r^(k−1)` 倍（`r=1` 即等额定投），
求「到当前 bar 为止这笔定投赚了多少」：

```
A_k    = A_1 · r^(k−1)                  k = 1..n（k=n 为当前 bar；P_k = 第 k 根 bar 的 close）
ROI    = (P_n·Σ(A_k/P_k) − ΣA_k) / ΣA_k
       = Σ_k w_k · (P_n/P_k − 1)        w_k = A_k / ΣA —— 各期收益率按投入资金加权平均
       = P_n / H_w − 1                  H_w = ΣA / Σ(A/P) —— 几何加权调和均值
```

- **买价与估值价都取 `close`**；窗口含当前 bar，逐 bar 滚动重算（不是锚定式实盘定投计划）。
- 值域 `[−1, +∞)`；单位是**比例**（`0.0048` = 0.48%，不是百分比）。
- 首批金额 `A_1` 会约掉 ⇒ **只有 `r` 影响结果**（没有资金规模参数，也不按 `r` 下单）。
- **`r = 1` 时恒等于遗留 DCAP**（`close / 近 n 根 close 的调和均值 − 1`）—— 旧口径是本指标的特例，
  不是另一个指标。

### 12.2 参数（9 个，全部标量）

| key | 类型 | 默认 | 范围 | 含义 |
|---|---|---|---|---|
| `n_s` | int | 8 | 2–250 | 短窗口：最近 n 根 close |
| `n_m` | int | 26 | 2–250 | 中窗口 |
| `n_l` | int | 60 | 2–250 | 长窗口 |
| `r_s` | float | 1.0 | 0.5–2.0 | 短窗口每期投入金额增长比 |
| `r_m` | float | 1.0 | 0.5–2.0 | 中窗口每期投入金额增长比 |
| `r_l` | float | 1.0 | 0.5–2.0 | 长窗口每期投入金额增长比 |
| `smooth` | int | 1 | 0–1 | 平滑开关：0=关（输出原始 ROI 线）/ 1=开（SMA） |
| `m` | int | 3 | 1–60 | 平滑周期；`smooth=0` 时忽略但**仍受平台校验** |
| `th` | float | 0.01 | 0.001–0.5 | **评分标度**：`roi = ±th` 映射到 0 / 100 分（只属策略参数，图表不用） |

- `n` 的下界是 **2**（`n=1` 恒为 0，无意义），与手册 §1/§5 的示例（`min:1`）不同；仓内参考插件实际普遍为 `min:2`。
- 三 n 的跨字段约束 `n_s < n_m < n_l`：**两个入口行为不同，务必分清**（见 §12.5）。

### 12.3 三条线 `s` / `m` / `l`

同一公式跑三遍，三组 `(n_i, r_i)` 各算一条：

| 线 | 字段 | 默认 | 语义 |
|---|---|---|---|
| 短 | `s` | `n_s=8, r_s=1.0` | 最快、最敏感 |
| 中 | `m` | `n_m=26, r_m=1.0` | 中枢 |
| 长 | `l` | `n_l=60, r_l=1.0` | 最慢、最稳 |

- 三条线**各自独立**：独立窗口、独立 `r`、独立平滑，并**各自判定数据是否充足**
  （可能 `s` 已有值而 `l` 仍为 null）。
- 三线同向 = 短中长共振（三重确认）；三线分歧 = 待观察。
- 平滑用 **`SMA(m)`**；`m=1` 或 `smooth=0` 时输出与原始 ROI **逐位相同**。开平滑后某条线
  最早在第 `n_i + m − 1` 根 bar（1 起数）才有值。

### 12.4 数据不足与评分映射

- **数据不足 = 放弃，不猜**：某线可用 bar 数 `< n_i`（开平滑时 `< n_i + m − 1`）⇒ 该线该 bar 无值：
  插件侧该线**不入 N**（分母只数有值的线），图表侧画断线（`null`）。
- **三线全不足 ⇒ 返回 50（中立）**，且**不打 `ctx.log`**（避免 run 日志爆炸）。
- 评分映射（连续式、三线等权）：

```
per_i = clamp(roi_i / th, −1, +1)               // 缺值的线跳过，不计入分子/分母
score = clamp(50 − (50/N) · Σ_i per_i, 0, 100)  // N = 参与计算的线数（1..3）
```

| `roi_i` | 该线贡献 |
|---|---|
| `≤ −th` | 100（强烈看多） |
| `0` | 50（中立） |
| `≥ +th` | 0（强烈看空） |
| 缺值 | 该线不参与（`N` 减一）；三线全缺 → 50 |

- **方向**：收益率越高 → 分数越低（"假想定投已经赚了 = 位置偏高" ⇒ 看空/逃顶）；
  收益率越负 → 分数越高（越跌越买）。
- **三线等权** = 平均"观感"（每条线最多贡献 ±50/N），不是按 ROI 大小加权 —— 保住三重确认语义。

### 12.5 参数归一化：两个入口语义**不同**（最易写错的地方）

平台参数校验只做**单参数 min/max**（`ParamDef{min,max}` 在结构上表达不了跨字段约束），因此同一个"非单调 n"
在两个入口的行为**有意不同**：

| 入口 | 行为 | 语义 |
|---|---|---|
| **插件面**（`init(params)`：策略参数 → 试算/回测/sim-live） | **归一化，不拒绝、不报错**：`n_m ← max(n_m, n_s+1)`、`n_l ← max(n_l, n_m+1)`（**顺序归一**：`n_l` 用已归一后的 `n_m`） | 对任何输入都产出合法且单调的三线；归一**确定 + 幂等**，且**只在 `init` 做一次** |
| **配置端点面**（`PUT /api/config/dcap`：图表显示参数） | **严格拒绝**：非单调 n ⇒ `400`，不写库（越界/非整数同样 400） | 宿主自有端点有跨字段校验能力，能真拒绝就真拒绝 |

- 写策略时**不要**依赖插件拒绝非法参数：传 `n_s=60, n_m=26` 给 `dcap` 插件会被**静默归一**成
  `n_m=61`（而不是报错），你拿到的是"归一后三线"的分数。
- 反过来，参数面板 / `PUT` 端点会 400 —— 那是**配置面**的行为，不代表插件面也会拒绝。
- 归一化在 `init` 内完成一次，`on_bar` **不重复归一化**（否则窗口容量逐 bar 漂移 ⇒ 重放分叉）。

### 12.6 用法示例（可直接复制）

单线版（`n=26`、`r=1.0`，即遗留 DCAP 口径）；骨架与 `dcap.js` 同源（§4.5 通道 2 自持滚动窗口）：

```js
const PARAMS_SCHEMA = [
  { key: "n",  type: "int",   default: 26,   min: 2,     max: 250, description: "定投窗口：最近 n 根 close" },
  { key: "r",  type: "float", default: 1.0,  min: 0.5,   max: 2.0, description: "每期投入金额增长比（1.0 = 等额定投）" },
  { key: "th", type: "float", default: 0.01, min: 0.001, max: 0.5, description: "评分标度：roi = ±th → 0 / 100 分" }
];

let win = [];   // 滚动窗口有状态 ⇒ 必须进 save()/load()

// 单线定投收益率 = P_n / H_w − 1（口径与 design/14-dcap-indicator/02-spec.md §1.2 同源）
function dcapRoi(closes, n, r) {
  if (!(n >= 1) || n > closes.length) return null;   // 数据不足 → null（不猜）
  const base = closes.length - n;
  const w = [];                                       // ① k=1..n 升序：迭代乘法求权重（不用 Math.pow）
  let a = 1;
  for (let k = 0; k < n; k++) { w.push(a); a = a * r; }
  let sumA = 0, sumAP = 0;                            // ② k=n→1 往回累加；每 bar 在窗口上完整重算
  for (let j = n - 1; j >= 0; j--) {
    const p = closes[base + j];
    if (!(p > 0)) return null;                        // 非法价按数据不足处理，不抛错（避熔断计次）
    sumA += w[j]; sumAP += w[j] / p;
  }
  return closes[closes.length - 1] * sumAP / sumA - 1;
}

function on_bar(ctx) {
  const n = Math.floor(ctx.params.n);
  win.push(ctx.bar.close);
  if (win.length > n) { win.shift(); }
  const roi = dcapRoi(win, n, ctx.params.r);          // 最近 n 根（含当前 bar）
  if (roi === null) return 50;                        // 数据不足 → 中立
  let per = roi / ctx.params.th;                      // 连续式映射：−th→100 / 0→50 / +th→0
  if (per < -1) per = -1;
  if (per > 1) per = 1;
  return 50 - 50 * per;
}

function save() { return { win }; }
function load(s) { win = (s && Array.isArray(s.win)) ? s.win.slice() : []; }
```

想要**三线版**（`s`/`m`/`l` 等权 + 归一化 + 数据不足跳过）不必自己写：直接选策略列表里的 `dcap`
参考插件，或在编辑器里以它为起点派生新草稿。

### 12.7 口径提醒（用之前请知情）

- **它是滞后型加权动量指标**：窗口含当前 bar，本质是"相对近期成本的位置"，不领先、不预测。
- **与遗留 DCAP / BIAS 高度共线**：`r=1` 就是遗留 DCAP，`n` 越短越接近 BIAS —— 不要把它们当"互相独立的信息"叠加。
- **`th` 必须按 `n` 与 `r` 各自标定**：`r` 越大有效回看越短（加权平均年龄渐近 `1/(r−1)`，
  `r=1.1` 时 26 根窗口的有效年龄只有约 7.6 根），ROI 幅度随 `n`/`r` 变化；`th=0.01` 只是默认参数组的合理起点。
- 三线各自 `r` 才会产生"长中短"差异化；全为 `r=1.0`（默认）时，三线差别只来自 `n`。
- 指标"有没有预测价值"是**独立研究任务**（SWEEP IS/OOS，见 `design/14-dcap-indicator/03-test-plan.md` §3），
  本手册只保证口径正确。
