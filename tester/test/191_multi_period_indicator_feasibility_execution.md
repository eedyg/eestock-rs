# 191 — 多周期 DCAP 同屏（多 pane）只读可行性调查 · 执行报告

- **本报告位置**：`tester/test/191_multi_period_indicator_feasibility_execution.md`
- **类型**：Execution report（执行探针测试；设计报告见 `tester/design/191_multi_period_indicator_feasibility_design.md`）
- **仓库/提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e2a04ee8cfc18904c93560fc77c10cd83f493ada`（工作区无源码改动）
- **运行时间（UTC）**：2026-09-14 08:52–09:20（时间盒内完成 P1–P4；P5/P6 仅源码判读）
- **被测引擎**：klinecharts **10.0.3**（`web/node_modules/klinecharts/dist/umd/klinecharts.min.js`，真 Chromium 渲染）
- **线上只读**：PID 3112540（:8081/:8082），仅 `GET /api/kline`、`GET /api/symbols`；**未发任何写请求**；未重启。
- **证据目录**：`tester/evidence/200_multiperiod_feasibility/`（`harness_result.json`、`probe2_result.json`、两张 render PNG）

## 0. 套件结果

| 类别 | 数量 |
|------|------|
| 探针脚本 | 2（harness.js / probe2.js） |
| 执行的探针断言点 | 15 |
| 得出确定结论 | 13 |
| 未能证实（如实标注） | 2（canvas 像素级取证、进行中桶分钟更新） |
| 崩溃 / core dump | **无**（Playwright 页面 `pageerror` 为空；host 无 core） |
| 源码改动 | **无**（`git status` 仅 `tester/` 新增文件；`git diff --cached` 为空） |
| 线上写请求 | **0** |

失败/未证实项表：

| 用例 | 状态 | 错误/原因 | crash/core |
|------|------|-----------|-----------|
| `probe2` canvas 像素采样（P2 可视证据） | **未能证实** | `getIndicators()` 在该探针返回对象字段全 `undefined`，`getDom()` 回退到整图容器 → 采样落到 candle pane，红线命中 0 | 否 |
| `in_progress_bucket_should_update_each_minute`（P3c 更新性） | **未能证实** | 实测时刻 A 股已收盘（最后 tick 07:00Z，now 08:52Z），只能取静态快照 | 否 |

---

## P1｜同实例多 pane 的 x 轴同步与独立 Y 轴 —— **结论：全部成立**

**实测方法**：一个 chart 实例内 `createIndicator(..., true)` 建 **5 个独立副图 pane**
（EXT_A/5m 与 EXT_B/15m 走 extendData、EXT_REG 走模块注册表、EXT_DRAW 自绘、VOL 内置）+ candle pane。
原始数据：`tester/evidence/200_multiperiod_feasibility/harness_result.json` → `logs[?][0]=="S1.firstRender"/"S2.afterZoomScroll"`。

### ① 共用时间轴 ✅

| pane | `convertToPixel({timestamp: mid_bar}).x`（S1） | 缩放+平移后（S2） |
|------|------------------------------------------------|-------------------|
| indicator_pane(EXT_A) | -2234 | -1807 |
| indicator_pane(EXT_B) | -2234 | -1807 |
| indicator_pane(EXT_REG) | -2234 | -1807 |
| indicator_pane(EXT_DRAW) | -2234 | -1807 |
| indicator_pane(VOL) | -2234 | -1807 |

- **同一 ts 在所有 pane 的 x 像素完全相等**（-2234 → -1807，整体被 zoom/scroll 同步改变）。
- `getVisibleRange()` 是 **chart 级单值**：`{from:515,to:600,realFrom:523,realTo:609}` → `{from:475,to:557,...}`。
  ⇒ klinecharts 10.0.3 的 x 轴**结构上就是全局共享的**，多 pane 无法各自独立平移/缩放（这正是需求想要的）。
- 副产物（实现要点）：`createIndicator()` **返回 indicator id 而非 paneId**；`getDom(返回值)` → `null`，必须
  `getIndicators({name})[0].paneId` 取真 paneId（`logs` 中 `paneIds.realPaneIds`）。

### ② 每 pane 独立 Y 轴 ✅

| pane | `yAxisId`（S1） | `realRange`（S1） | `realRange`（S2，zoom 后） | `convertToPixel(value=3).y` |
|------|-----------------|-------------------|---------------------------|-----------------------------|
| candle_pane | `yAxis_…757_1` | 0.111800 | 0.092690 | — |
| EXT_A(5m 外部) | `yAxis_…493_3`（自动生成，互异） | **2.08754** | **1.03896** | -3（超界） |
| EXT_B(15m 外部) | **`yA_extB`（显式传入被采纳）** | **3.182530** | **2.07779** | 61 |
| EXT_REG | `yAxis_…495_5` | 2.08754 | 1.03896 | -3 |
| EXT_DRAW | `yAxis_…495_8` | 13 | 13（`minValue/maxValue` 固定） | 69 |
| VOL | `yAxis_…496_3` | 5980 | 5980 | 92 |

- 每个 pane 有**互异 `yAxisId`**；`createIndicator({name, yAxisId:'yA_extB'})` 的显式 yAxisId **被采纳**。
- 各 pane `getRange().realRange` 相互独立（0.09 / 1.04 / 2.08 / 5980 / 13），且 zoom 后**各自重标度**（2.0875→1.0390 等）。
- 同一 `value=3` 在各 pane 落到**不同 y 像素**（-3 / 61 / -3 / 69 / 92）⇒ 量程确实互不影响。
- **代价**：0（免费能力）。但 pane 的 Y 轴自动量程来源是「该 pane 内各 indicator 各 figure 的 result 值」，
  故外部序列路径必须让 `calc` 返回真实序列值（见 P2-T1），否则量程会塌。

### ③ pane 高度可分别保存/回放 ✅

`probe2_result.json`（干净对照，未受 live 引用混入）：

```
heights.default            -> candle_pane:100(实际412) | indicator_A:100(实际100) | VOL:100(实际100) | x_axis:100(实际26)
heights.afterSet333        -> candle_pane:100(实际179) | indicator_A:333(实际333) | VOL:100(实际100) | x_axis:100(实际26)
heights.afterZoomScroll    -> candle_pane:100(实际179) | indicator_A:333(实际333) | VOL:100(实际100) | x_axis:100(实际26)
```

- `setPaneOptions({id:paneId, height:333})` → `getPaneOptions(id).height===333` 且 `getSize(id).height===333`，
  **zoom + scroll 后仍 333**（其余 pane 保持 100）⇒ pane 高度是每 pane 持久状态，等价「拖拽高度记忆」。
- 默认：每个 indicator pane `height=100`、`minHeight=30`；candle pane 吃掉剩余空间（412→179）。4 个副图 pane 需按容器高度分配。
- **坑（诚实标注）**：`getPaneOptions(id)` 返回**live 对象引用**；在同 tick 内先取「设置前」再设置，读到的会是设置后的值
  （首次日志 `P1.setPaneHeight.before` 已出现 222）。测/实现都应拷贝快照，勿缓存引用。

**代价**：0（全免费）。**风险**：低。

---

## P2｜指标吃「外部序列」的四条路径 —— **结论：三条可行，(a) 最稳，(c) 次稳，(b) 最脆**

原始数据：`harness_result.json` → `calcCalls` / `P2a…` / `P2c…` / `P2d…`。

### (a) `extendData` 注入 —— ✅ **可行、可响应式更新（推荐主选）**

```
calcCalls: [EXT_A extendData extLen=120 dataLen=600, …]
P2a.overrideExtendData: {ret:false, calcCallsBefore:1, calcCallsAfter:2, recalced:true,
                         resultLen:600, firstNonNull:{v:14.0765}}
getYAxes: EXT_A pane realRange=2.08754  (= 外部 5m 序列在视口内的量程，不是 K 线价格量程)
```

- `calc(dataList, indicator)` **可以读到 `indicator.extendData`**；`result.length===dataList.length(600)`，
  且只在「高周期桶 ts」那根非 null（`firstNonNull={v:4.0765}`），其余 null → 线自然断开。
- `overrideIndicator({name, extendData})` **确实触发重算**（calc 调用 1→2，result 变为 +10 后的 14.0765），
  尽管**返回值仍为 `false`**（与仓库既有注释一致：不能以返回值判成败）。
- pane Y 轴按**外部序列**自标度（2.0875 而非价格 0.11）。
- **代价**：低。**确定性**：高（显式数据流，可单测）。**与 overlay 冲突**：无（overlay 是独立层）。
- **局限**：`overrideIndicator` 按 `name` 匹配 → 多个同名指标会被一起改，须用不同 `name`（如 `DCAP_5M`/`DCAP_15M`）。

### (b) 模块级注册表缓存 —— ⚠️ **可行但最脆**

```
P2b.registryReactivity: {regBefore:{"v":4.0765}, retSame:false, regAfterSame:{"v":104.0765},
                         regAfterReset:{"v":104.0765}, recalcWithoutReset:true, recalcAfterReset:false}
```

- 改注册表后**引擎不会自动失效**；必须显式 poke（`overrideIndicator`（同参数也触发）或 `resetData`）才重算。
  本探针里 poke 后确实更新为 4.0765→104.0765。
- **脆点**：poke 是隐式副作用（依赖库「同参数 override 也重算」这一未文档化行为）；忘记 poke 就画旧值；
  跨实例/多图共享注册表易串味。**代价**：低，但**可测性/确定性最低**。仅作兜底。

### (c) `draw` 自绘（indicator 级 `draw` 回调）—— ✅ **可行、最可控**

```
P2c.indicatorDraw: {drawCalls:6, drawLastCoords:{left:0, right:65, y0:92, y8:31}}
supportedFigures: [circle,line,polygon,rect,text,arc,path]
```

- 模板 `draw(params)` 被调用，`params.{ctx, chart, xAxis, yAxis, bounding}` 齐全；
  `xAxis.convertTimestampToPixel(ts)` / `yAxis.convertToPixel(v)` 在 pane 内可用 ⇒ 可任意自绘外部序列（含虚线、分段）。
- **必须**自行提供 Y 轴量程（`minValue/maxValue`，本例 0/8）或让 `calc` 仍返回用于标度的值，否则 pane 量程塌。
- **代价**：中（自绘代码 + 手工量程/裁剪；不与 tooltip/legend 自动集成）。**确定性**：高。**可测性**：中（像素级）。
- `registerFigure` 同理可行（`supportedFigures` 已含 `line/path` 等），但其 `draw(ctx, attrs, styles)` **拿不到 chart/axes**，
  自绘外部序列需依赖 `attrs` 回调预先算好坐标，比 indicator 级 `draw` 更绕 → 不推荐作为主路径。

### (d) 其他可行路径：overlay 多段 —— ⚠️ **可行但代价最高**

```
supportedOverlays: [fibonacciLine, horizontalRayLine, horizontalSegment, horizontalStraightLine,
 parallelStraightLine, priceChannelLine, priceLine, rayLine, segment, straightLine, verticalRayLine,
 verticalSegment, verticalStraightLine, simpleAnnotation, simpleTag, brush]
P2d.overlay: {polyline:false, brush:true, segment:true, overlays:2, overlayNames:["brush","segment"]}
```

- **没有 `polyline`**；`brush`（多点自由路径）与 `segment`（两点线段）可创建，**接受 `styles.line.style:'dashed'`**（无报错）。
- 用 `brush` 单 overlay 画整条外部折线理论可行，但：不参与 pane 自动量程、不进 legend/tooltip、点数多时创建/重投影成本高、
  每点 ts→坐标重投影在 zoom/scroll 时由引擎负责（这点是优点）。**代价**：高。**定位**：只适合「单段虚线」点缀，不适合主序列。

### 路径对比（需求要求：确定性/可见性/重算成本/与 overlay 冲突/可测性）

| 路径 | 可行性 | 确定性 | 可见性 | 重算成本 | 与 overlay 冲突 | 可测性 | 判定 |
|------|--------|--------|--------|----------|-----------------|--------|------|
| (a) `extendData` | ✅ | 高 | 原生 line 图元、进 legend/量程 | 每次 poke 全量 600 重算（<1ms 级，未测） | 无 | 高（result 可断言） | **主选** |
| (c) indicator `draw` | ✅ | 高 | 自绘，不进 legend | 仅重绘 | 无 | 中（像素） | **备选** |
| (b) 模块注册表 | ⚠️ | 低（隐式 poke） | 同 (a) | 同 (a) | 无 | 中 | 兜底 |
| (d) overlay brush/segment | ⚠️ | 中 | 独立层、不进量程/legend | overlay 重投影 | 与 B/S 标记同层需避让 | 低 | 仅点缀 |

---

## P3｜时间对齐语义（口径 C）—— **结论：机制支持，但必须自行做 +1 桶的位移；ts=桶开始(UTC) 已实证**

### a) 「按桶结束 ≤ t 做 step-hold」在 1m 网格上 ✅（机制层面）

- 探针把高周期序列按「桶 ts」映射到 1m 网格：`extLen = 120 (=600/5)`、`40 (=600/15)`，非格点全覆盖 null，
  价值锚定在**单一 1m bar 索引**上（`firstNonNull`）→ **step-hold 完全可实现**，且「错一格」是可诊断的（桶数即可暴露）。
- ⚠️ **关键对齐结论（务必按口径 C 实现）**：后端 ts = 桶**开始**（见 b）。若把「桶 i 的指标值」锚在 `ts = s_i`（桶开始），
  就是「桶还没走完就用它的值」= **未来函数**。口径 C 要求锚在 **`ts = s_i + P`（= 桶结束 = 下一个桶开始）**，
  即 **整条高周期序列右移一个桶**。渲染机制不限定锚点（任意 ts→索引映射都支持），
  所以这个位移是**纯数据映射决策**，必须由实现显式完成（这也是最容易写错的一格）。

### b) `/api/kline` 各周期 ts 约定 = **桶开始（UTC）** ✅ 强证据

用 1m 序列本地聚合成 5m，与后端 5m 逐桶比对（`shift` = 1m 时间平移分钟数）：

```
shift=0min  5m: common=208 identical=50
shift=-1min 5m: common=200 identical=0
shift=+1min 5m: common=208 identical=1
```

- 只有 `shift=0`（1m bar 的 ts 直接 floor 到 5m 边界）能命中；±1min 全部不命中 ⇒ **1m/5m 的 ts 都是桶开始**。
- 跨周期样本（原始 JSON）：
  - `1m` 首根 `2026-09-14T01:30:00Z` = **09:30 CST**（A 股开盘）→ 桶开始。
  - `1d` ts = `2026-09-10T16:00:00Z` = **09-11 00:00 CST** → 桶开始（本地午夜）。
  - `1w` = `2026-09-06T16:00:00Z` = **09-07(周一) 00:00 CST**；`1mo` = `2026-08-31T16:00:00Z` = 09-01 00:00 CST。
- **UTC**：所有 ts 均为 `Z`（UTC），日/周/月桶按 **UTC+8 本地午夜** 对齐。⇒ step-hold 公式：
  `plot 高周期桶 i 的值 ⇔ 1m bar ts t 满足 s_i + P ≤ t`（即 t 取到 `s_i+P` 那根起）。

### c) 进行中桶 ⚠️（存在性已实证；分钟更新性未证实）

`GET /api/kline` 末根样本：

| period | 末根 ts | OHLC | volume | 判读 |
|--------|---------|------|--------|------|
| 1m | 2026-09-14T07:00:00Z | 8.878/8.878/8.878/8.878 | **0** | 末根零量平 bar（占位/进行中） |
| 5m | 2026-09-14T07:00:00Z | 8.878×4 | **0** | 同上（跨周期同值 8.878） |
| 15m | 2026-09-14T07:00:00Z | 8.878×4 | **0** | 同上 |
| 1h | 2026-09-14T07:00:00Z | 8.878×4 | **0** | 同上 |
| 1d | 2026-09-10T16:00:00Z | 8.895/8.963/8.852/8.943 | 617,832,329 | **无**当前日桶（落后 09-11/09-14 两个交易日） |
| 1w / 1mo | 09-06T16:00Z / 08-31T16:00Z | — | — | **有**当前周/月桶 |

- ⇒ **日内 4 周期（1m/5m/15m/1h）都带一根「进行中/占位」桶**（LOW=HIGH=OPEN=CLOSE=上一根 close，volume=0）。
- 机制佐证：`crates/providers/src/exchange.rs:51,72` 的 quote 明确 `volume: 0, amount: 0.0`（快照源只给 last），
  与观测到的零量平 bar 一致。`1d` 无当日桶、`1w/1mo` 有 → 不同周期的生成路径/刷新口径不一致（需架构师确认）。
- ❌ **未证实**：这些末根桶的 OHLC 是否**随分钟更新**（实测 08:52Z 时 A 股 07:00Z 已收盘，只能看到冻结快照）。
  → 需下一交易日盘中重测（P6 风险项）。
- **口径 C 影响**：进行中桶**不得**参与历史 step-hold（它就是「桶结束 > t」的桶）；只允许画在实时边缘（最右）。

### d) 「进行中未定稿」分段虚线 ⚠️ 可行，但**不能在同一 line figure 内分段**

- 指标 figure 的 `styles` 回调返回**每 figure 单一**样式（`IndicatorFigureStylesCallback` 拿 `NeighborData` 但只能给出一个样式对象）
  ⇒ 单条 `line` figure **无法**只把最后一段画成虚线。
- 可行替代（按代价排序）：
  1. **拆成两个指标/两个 figure**：`DCAP_CLOSED`（实线，桶结束 ≤ t）+ `DCAP_LIVE`（虚线，只画进行中桶那一段）；
     同一 pane、同一 yAxisId 即可叠加 → 代价低、可测（两条 result 可分别断言）。
  2. **overlay `segment`/`brush` 画最后一段虚线**（已实测接受 `style:'dashed', dashedValue:[4,4]`）→ 与 B/S 标记同层，需避让。
  3. indicator 级 `draw` 自绘（完全可控，代价中）。
- **成本**：方案 1 约等于「多注册一个模板 + 多一条 result」，最低。**风险**：低。

---

## P4｜数据面口径一致性 —— **结论：当前交易日尾段一致，但历史桶系统性不一致 ⇒ 应「直接取高周期 bar」**

对比方法：`GET /api/kline?code=518880` 取 `1m`(limit 2000) 与后端 `5m`/`15m`，把 1m 按桶开始做 OHLCV 聚合，逐桶逐值比对。

| 周期 | 公共桶 | 逐值一致 | 不一致 | 一致样例 |
|------|--------|----------|--------|----------|
| 5m | 208 | **50** | 158 | 见下（当前交易日尾段全对） |
| 15m | 76 | **48** | 28 | — |

**当前交易日尾段（5m）逐值完全一致**（原始输出节选）：

```
06:25Z backend o/h/l/c=8.899/8.903/8.898/8.902 vol=1,838,600  local 8.899/8.903/8.898/8.902 vol=1,838,600  ✅
06:45Z backend 8.891/8.898/8.891/8.894 vol=5,543,400       local 8.891/8.898/8.891/8.894 vol=5,543,400  ✅
06:55Z backend 8.885/8.885/8.878/8.878 vol=92,500           local 同值                                  ✅
07:00Z backend 8.878×4 vol=0                                local 同值                                  ✅
```

**历史桶系统性不一致**（示例，差异含 OHLC 与 volume，量级可达 ~10×）：

```
2026-09-08T06:25Z 5m  local (9.049,9.052,9.041,9.045, vol=9,978,300)  vs backend (…, low=9.042, close=9.043, vol=3,314,200)
2026-09-09T01:45Z 15m local (8.992,8.995,8.98,8.98,  vol=30,441,100) vs backend (open=8.97, high=8.994, vol=148,391,577)
```

**差异来源判读**：1m 视图的 `source` 分布为 `tushare:759 / tencent_ifzq:136 / sina_jsonp:105` —— 多源合并/事后修订视图，
与高周期 cagg/构建路径的取数层不是同一条 lineage（`ts` 约定已排除偏移因素：shift=±1min 命中 0）。

**结论 ⇒ 选「直接取高周期 bar」，不选「本地聚合 1m」**：
- 若本地聚合 1m 来喂 5m/15m DCAP，历史段会与「独立开 5m 图时后端算出的 DCAP」**不一致**，用户会看到两个页面同周期不同值。
- 直接 `GET /api/kline?period=<高周期>` 可保证与切到该周期单独看时**逐值一致**。
- **代价**：每标的每指标周期 1 次 `/api/kline`（limit = viewport_bars + n_l + m − 1），与 P5 的请求数结论联动。

---

## P5｜成本与范围（部分源码判读，未实测）

- **pane 高度/占比**：默认每 indicator pane 100px、minHeight 30；candle 吃剩余。4 周期（3 个 DCAP 副图 + VOL + candle）
  在小宫格里需分配，但 `setPaneOptions` 可分别设定并持久（P1③）。
- **取数量**：每周期 `viewport_bars + dcapWarmupBars(params)`（后者 = `n_l + m − 1`，`dcapIndicator.ts` 已定义）。
- **订阅/兜底请求**：`web/src/features/dashboard/realtimePoll.ts` 现按 **`(code, period)`** coalesce，
  全局并发上限 `MAX_CONCURRENT_POLLS=3`。⚠️ **多周期同屏 = 新增 N 个不同 period 的 key ⇒ 无法合并，兜底请求数 ×N**
  （仅受并发闸限流排队）。这是本方案最直接的成本放大项。
- **WS 订阅数**：未实测（按 period 维度预计 ×N）。
- **指标重算性能**：未测（600 根 1m + 3 条外部序列是否 <16ms，**未证实**）。
- **与既有契约 ①②③④ 的交互**：未测。

## P6｜风险与未知清单

1. **进行中桶是否分钟更新**（P3c）——需下一交易时段重测；直接决定「实时边缘虚线段」是否需要每分钟重算 + 是否触发 future-function 风险。
2. **1d 无当日桶 vs 1w/1mo 有**（P3c）——跨周期生成口径不一致，需架构师确认是否统一。
3. **P4 历史 lineage 不一致**——若上游合并/修订会回溯改动 1m，高周期与 1m 视图将持续漂移。
4. **`overrideIndicator` 同参数也重算**（P2-T2/T3）——库未文档化行为；若升级版本改变，模块注册表路径会静默失效。
5. **重算性能 & 视口平移时外部序列的重算触发次数**（P5）——未测。
6. **多 pane 与既有布局契约**（保存配置/切周期/切股票/模式切换不得重置布局或强拉视口）——未测，属既有回归面。
7. **同名指标不能跨 pane 区分**（`overrideIndicator` 按 name 匹配）——命名规范须固定（如 `DCAP_5M`）。
8. **canvas 像素级可视证据缺口**（probe2 工具问题）——建议后续用稳定探针补一条「红线确实渲染」的像素断言。

---

## 推荐实现路线

### 主选：**(a) `extendData` + 每周期一个独立 pane（显式 yAxisId）**
1. 注册**每周期一个模板名**（`DCAP_5M`/`DCAP_15M`/…，或单模板 + extendData 携带 `stepMin`），
   模板 `calc(dataList, indicator)` 从 `indicator.extendData`（=该周期高周期 DCAP 序列，按**桶结束 ts** 对齐）取数，
   映射到 1m 网格：`null` 除锚点外，**锚点 = 桶结束（=s_i+P）**，即整条序列右移一个桶（口径 C）。
2. 数据面：**每周期直接 `GET /api/kline?period=<P>`**（不用本地聚合），`limit = viewport_bars + n_l + m − 1`，
   用同一 8 参数在本地算该周期的 DCAP（`computeDcapSeries` 已在 `web/src/features/indicators/dcap.ts`）。
3. pane：`createIndicator({name:'DCAP_5M', extendData, yAxisId:'yAxis_dcap_5m'}, true)`；K 线只画最小周期；
   每次参数保存/序列刷新走 `overrideIndicator({name, calcParams, extendData})`（**不重建 pane**，保住拖拽高度）。
4. 「进行中未定稿」段：**再注册一个 `DCAP_5M_LIVE` 模板**（虚线样式，只画进行中桶那一小段），同 pane 同 yAxisId。

### 备选：**(c) indicator 级 `draw` 自绘 + `minValue/maxValue` 手动量程**
当 `extendData` 响应式路径出现不可控（如升级后 override 语义变化）时，用 `draw` 直接按 `xAxis/yAxis` 自绘外部序列，
量程由 `minValue/maxValue`（按视口内序列 min/max 计算）控制。代价更高但最可控、最不依赖未文档化行为。

---

## VERDICT

**FEASIBLE-WITH-CONSTRAINTS** — 约束：
1. **禁止用本地聚合 1m 代替高周期 bar**（P4：历史桶系统性不一致）⇒ 每周期必须直接取该周期 `/api/kline`。
2. **必须做 +1 桶位移**（口径 C）：高周期值锚在 `桶开始 + P`（= 桶结束）；进行中桶只画实时边缘。
3. **多周期 = 兜底请求/WS 订阅 ×N**（`realtimePoll` 按 `(code,period)` 合并，无法跨周期合并），需限流/预算。
4. **最多 4 周期、仅单图模式**（与用户裁决一致；多 pane 组件数与小宫格高度分配需设计）。
5. **`overrideIndicator` 返回值不可信**（恒 `false` 但生效）；且按 `name` 匹配 ⇒ 指标命名须按周期唯一。
6. **同名指标 + `extendData` 走通**，但「进行中虚线段」不能在同一 line figure 内分段 ⇒ 需第二条 live figure/指标或 overlay。
7. 未证实项：进行中桶分钟更新性、重算性能 <16ms、canvas 像素级可见性取证。
