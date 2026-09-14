# 测试设计 017 — 「切换 period / stock 不得重置指标视图布局」红测试（jsdom + 有状态 klinecharts 模型）

- **本文件位置（self-location）**：`tester/design/017_period_stock_switch_layout_red_test_design.md`
- 关联执行报告（阶段 1 诊断）：`tester/test/053_period_stock_switch_layout_diagnosis_execution.md`
- 关联证据目录：`tester/evidence/053/`（真实渲染探针 probe_period/probe_regress/probe_extra/probe_viewport + 截图 + 红测试原始输出）
- 被测新增测试文件：**`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`**（当前 **2 红 / 1 绿**）
- 上游需求（用户新需求，2026-09-14）：**切换 period（周期）或切换 stock（标的）时，指标视图的 layout 大小不得被重置；数据重置是允许的。**
- 权威口径：`design/14-dcap-indicator/02-spec.md` §6（图表契约 C，含「配置保存不得重建 pane」）、`design/06-web/11-kline-viewport-bars.md`（ADR-020 视口=根数）、`design/06-web/01-dashboard.md`
- 上一轮已入库修复：`7949c0b`（保存 dcap 参数不重建 pane；本设计是同一「不得重建 pane」契约在 **period/stock 切换**路径上的延伸）

---

## 1. 测试策略摘要

| 层 | 手段 | 本设计是否使用 | 理由 |
|---|---|---|---|
| 单元 | vitest + 纯函数 | 否 | 缺陷在组件接线层（effect 身份），非算法层 |
| 组件（jsdom） | vitest + **有状态 klinecharts 迷你引擎** | **是（新建 `web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`）** | 判据是 **chart 实例生命周期 + pane 语义**（整图 remount ⇒ 全部 pane 以默认 100 重建、pane id 全换、init 计数 +1），空桩（`vi.fn()`）表达不了 ⇒ 永久假绿 |
| 真实渲染 | Playwright + 临时构建/临时端口 + 真实 klinecharts 10.0.3 | 是（`tester/evidence/053/harness/probe_*.mjs`，**诊断证据**，不进仓库测试栈） | 证明模型语义与真实引擎一致（VOL 199→100、DCAP 140→100、`init` 1→2、pane id 全换；原地切换可行） |
| E2E | `web/e2e/**`（需真实 app 实例） | 否 | 需可写后端/线上实例；不宜作常驻回归（同 016 的判断） |

**为什么真实渲染不写进仓库测试栈**：判据要求「真实 klinecharts」⇒ 必须真实浏览器（jsdom 无 canvas，既有 `KlineChart.test.tsx` 因此整体打桩）；真实浏览器需临时构建 + 只读代理线上 8081（前置多、依赖外部实例）。故常驻红测试用模型（可重复、无外部依赖），真实性由 §4 的「模型 ↔ 真实实测」交叉表保证。

---

## 2. 层覆盖计划

| 契约点 | 覆盖方式 | 期望（修复前 → 修复后） |
|---|---|---|
| 切 period 后既有 pane 高度不变（±1px） | 组件测试（红） | 红 → 绿 |
| 切 stock 后既有 pane 高度不变（±1px） | 组件测试（红） | 红 → 绿 |
| 切换不得整图 remount（chart 实例不重建） | 组件测试（红） | 红 → 绿 |
| pane id 不变（不被销毁重建） | 组件测试（红） | 红 → 绿 |
| 切换期间无 `removeIndicator` / `createIndicator` | 组件测试（红） | 红 → 绿 |
| **数据确实重置**（新标的/周期的根数/首末时间戳/取值换入 loader） | 组件测试（红测内反断言） | 绿 → 绿（防「为保布局而不换数据」） |
| 同一 feed 的无关 rerender 不重建 chart | 组件测试（守卫，当前绿） | 绿 → 绿 |
| 真实引擎语义一致性（remount 重置 / 原地 setSymbol+setPeriod+setDataLoader+resetData 保高度） | 真实渲染探针（诊断证据） | — |

---

## 3. 测试用例清单（Given-When-Then / should-when 命名）

文件：`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`

### T-1（红）`【红】切换 period：既有 pane 高度 ±1px 不变、pane id 不变、无 create/remove；数据确实换成新周期`
- **Given** `KlineChart` 以 `indicators={ma:true,dcap:true,...}`、`feed=makeFeed('518880','15m',barsA)` 渲染（MA 叠主图、VOL/DCAP 独立副图）；用户把 VOL 拖到 240、DCAP 拖到 200（`setPaneOptions`，等价 `SeparatorWidget`）
- **When** rerender 为 **新 feed**（`makeFeed('518880','1h',barsB)`）= `DashboardPage` 切 period 的等价 props 变化（feed 身份更换 ⇒ 新 `KlineDataFeed`）
- **Then**
  1. `H.state.charts.length === 1`（**不得 dispose+init 重建 chart**）；当前 = 2 ⇒ **红**
  2. 所有既有 pane 渲染高度与切换前 **±1px 不变**
  3. pane id 集合不变
  4. 切换后无 `removeIndicator` / `createIndicator`
  5. **数据确实重置**：chart 的 DataLoader `getBars('init')` 回调的根数/首末时间戳/close 序列 = `barsB`（≠ `barsA`）；`getSymbol().ticker === '518880'`、`getPeriod() === {type:'hour',span:1}`
- **当前红状态**：`AssertionError: 切 period 不得 dispose+init 重建 chart（否则 pane 全部回默认高度）: expected 2 to be 1`

### T-2（红）`【红】切换 stock：既有 pane 高度 ±1px 不变、pane id 不变、无 create/remove；数据确实换成新标的`
- **Given** 同 T-1（feed A = `518880/15m`，拖高 VOL/DCAP）
- **When** rerender 为新 feed（`makeFeed('161226','15m',barsB)`）= 切 stock 的等价 props 变化（period 不变、code 变）
- **Then** 同 T-1 ①②③④；⑤ 数据 = `barsB`、`getSymbol().ticker === '161226'`
- **当前红状态**：`AssertionError: 切 stock 不得 dispose+init 重建 chart: expected 2 to be 1`

### T-3（守卫，当前绿）`【防回归】同一 feed 的 rerender（如指标/参数变化）不得重建 chart`
- **Given** `feed=feedA`，拖高 VOL/DCAP
- **When** 同一 feed、仅无关 props 变化（等值新对象）rerender
- **Then** `charts().length === 1`、高度 ±1px 不变
- **目的**：把「feed 身份变化才允许重新接线」与「同一 feed 永不重建」两条边界钉死

---

## 4. 迷你引擎的语义依据（逐条对齐真实库源码；模型 ↔ 真实实测交叉）

| # | 模型语义 | 真实库依据（`klinecharts@10.0.3 dist/index.esm.js`） | 真实渲染实测交叉验证（`evidence/053`） |
|---|---|---|---|
| 1 | 新 pane 默认 `height:100 / minHeight:30 / state:'normal'` | `:13250-13256` | 切换后 VOL/DCAP `getPaneOptions().height == 100`、DOM 100 |
| 2 | `createIndicator` 未给 `paneId` ⇒ 新 pane（新 id）取默认高 | `:15263-15290` | 切 period 后 VOL/DCAP pane id 全换 |
| 3 | `removeIndicator` 清空 pane ⇒ pane 销毁 | `:15323-15355` | （沿用 051 证据） |
| 4 | 拖拽写 `pane.setOptions({height})`；`setPaneOptions` 亦写 `options.height` | `:10764-10765` / `:15406-15468` | 拖高 VOL→199、DCAP→140（DOM 同值） |
| 5 | `measureHeight`：非弹性 pane = `max(minHeight, options.height)`，弹性 `candle_pane` 吃剩余 | `:14787-14835` | 切 period：candle 357→496（吸收 VOL/DCAP 释放的 139） |
| 6 | `overrideIndicator` 原地改 calcParams、不销毁 pane | `:15296-15321` | （沿用 051 证据） |
| 7 | `init(container)` = 新建 ChartImp；组件 `[feed]` effect 重跑 = dispose + init（整图 remount） | 组件 `KlineChart.tsx:349-450`（deps `[feed]`） | 切 period/stock 各 `__ACC__.inits` +1；burst 以 `setDataLoader/setSymbol/setPeriod/createIndicator×3` 开头 |
| 8 | `setSymbol` / `setPeriod` / `setDataLoader` 各自内部 `resetData()`（原地重载，不重建图） | `:13410-13434`、`:13518-13524`、`:15253-15261` | 原地切换：pane id/高度**逐值不变**、`inits` 不变、数据换新（probe_period `C`） |

> 模型只保留**判据相关**语义（chart 实例计数 + pane 生命周期/高度分配 + symbol/period/DataLoader 传递 + 真实 DataLoader 取数）。渲染像素、overlay、WS、视口细节不在模型内（由既有测试与真实探针覆盖）。

---

## 5. Mock / Stub 策略

- **klinecharts 整体 `vi.mock`**：`init()` 每次返回**新的**有状态 chart 并计入 `state.charts`（**这是「整图 remount」的观测通道**）；`dispose(chart)` 清空该 chart 的 pane；`registerIndicator(tpl)` 收集模板并为内置 `MA/VOL/MACD/KDJ/BOLL` 预置最简等价模板。
- **DCAP 用真身注册**：`ensureDcapIndicatorRegistered()` 落到 stub 的 `registerIndicator`（只为「DCAP 副图存在」判据，不验证其数值）。
- **feed 用真身 `loadBarsForKc`**：stub 的 `setDataLoader` 保存 loader；测试调用 `loader.getBars({type:'init',callback})` ⇒ 真实走 `loadBarsForKc` → `feed.loadInitial()` + `feed.bars.map(toKcData)` ⇒ **数据重置是「真接线」，不是桩**。
- **不 mock 被测组件**：直接渲染 `KlineChart`（含建图 effect、指标差分 effect、warmup effect）。
- **不依赖实现细节**：断言只落在「chart 实例数 + 渲染高度 + pane id + 指标生命周期调用集合 + loader 返回的 KLineData」；不断言具体调用次数/顺序。

---

## 6. 边界与异常用例

| 场景 | 处理 |
|---|---|
| 同一次切换产生**多个** React commit（如 period + code 同帧变） | 修复后 effect 复用同一 chart，多 commit 幂等；本测试用单次 rerender（更弱条件） |
| 切换时同时翻转指标开关 | 不属于本需求（开关翻转仍需 create/remove）；由既有 `KlineChartDcapSaveLayout.test.tsx` T-2/守卫覆盖 |
| 切换后 DCAP warmup 窗口 | 数据重置断言在模型里用 `feed.bars`；真实 warmup 口径由 probe_regress 覆盖（DCAP 关→120、开→120+68） |
| 用户已手动缩放（manualAdjusted=true）后切换 | 见执行报告 §5 回归面：原地切换不会重算 fit ⇒ 需在修复里显式 `manualAdjusted=false` 以保持 ADR-020 现行语义 |
| `vi.clearAllMocks()` 但 stub chart 跨用例共享 | 模型每次 `init()` 生成**新** chart；`state.charts` 在 `beforeEach` 清空 |

---

## 7. 覆盖目标（定性，本项目未启用覆盖率工具）

- **必须覆盖**：`KlineChart` 建图 effect 在 **feed 身份变化**下不得 dispose+init；pane 高度/pane id 保持；数据必须换新。
- **不覆盖**：klinecharts 自身渲染正确性、DCAP 数值正确性（T1~T13 已有）、barSpace 视口口径（ADR-020 既有测试）。
- **回归门**：`cd web && npx vitest run`（修复前：58 files / 577 tests，2 failed = 本文件两条红测）+ `npx tsc -b` 干净。

---

## 8. 可重复运行前置

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs/web
npx vitest run src/features/dashboard/KlineChartSwitchLayout.test.tsx
# 修复前期望：Test Files 1 failed (1) / Tests 2 failed | 1 passed (3)
# 修复后期望：Tests 3 passed (3)
```

- 无外部服务依赖（纯 jsdom + 迷你引擎 + 真实 `loadBarsForKc`/`toKcData` 纯函数）。
- 确定性：合成 bars 为固定序列（无时间/随机依赖）。

---

## 9. 与其他车道的边界

- 本设计只产出**测试**（`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`），不改产品代码、不改接口/架构、不改 `design/14-dcap-indicator` 的 `file=` 代码块、不跑 tangle。
- 修复由 coder 车道执行；修复后本文件 3 条应全绿，且**不得**引入既有测试桩缺失的 chart API（否则大面积 TypeError）。
