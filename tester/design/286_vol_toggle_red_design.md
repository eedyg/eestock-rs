# 286 — VOL 副图 → 可关闭的普通指标开关：红测试设计（先红规格）

> **本报告位置**：`tester/design/286_vol_toggle_red_design.md`
> 角色：Tester（**只设计与执行测试**；本轮未修改任何产品实现 / tangle 生成物 / 设计文档 / 既有测试）
> 任务：为「VOL 成交量副图变成可关闭的普通指标开关」建立**先红**的可执行规格
> 被测对象（需实现，**当前不存在**）：`web/src/layouts/DashboardGrid.tsx`（`DASHBOARD_DEFAULTS.indicators.vol`）、
> `web/src/features/dashboard/Toolbar.tsx`（VOL 开关）、`KlineChart.tsx`（删除两处 VOL 特权）、
> `MultiPeriodChartStack.tsx`（兜底默认 + 继承）
> 红测试文件（本设计唯一落地产物）：`web/src/features/dashboard/volToggle.test.tsx`
> 执行报告：`tester/test/286_vol_toggle_red.md`
> 原始证据：`tester/evidence/286_vol_red/`

---

## 1. 口径（父级已裁决，本设计不得变更）

| 维度 | 口径 |
|---|---|
| 产品 | VOL 与 MA/MACD/KDJ/BOLL/DCAP **并列**的全局指标开关；**默认开**（`vol: true`）；**会话态**（不落服务端配置、刷新回默认） |
| 关掉的效果 | 主图 / 宫格 / 工作台 / **所有多周期卫星**都不再有 VOL 副图 |
| 类型 | `IndicatorName` 派生自 `DASHBOARD_DEFAULTS.indicators`（tangle 生成物 `web/src/layouts/DashboardGrid.tsx`，事实源 `design/06-web/01-dashboard.md`） |
| 本阶段禁令 | 不改该设计文档、不改生成物、**不改任何实现文件**、不改既有测试、不 git add/commit、不写 dist、不发 `/api` 写请求 |
| 现有两处 VOL 特权（实现阶段删除；本阶段**只写成断言**） | ① `KlineChart.tsx` `INDICATOR_DEFS` 的 `key: IndicatorName \| 'vol'` 类型逃逸；② `syncIndicators` 的 `def.key === 'vol' ? true : indicators[def.key]` 硬编码常开 |

## 2. 测试策略（六层，同一组判据）

| 层 | 载体 | 覆盖 | 为什么需要该层 |
|---|---|---|---|
| **L0 常量层** | `DASHBOARD_DEFAULTS` 直读（无渲染） | R1：`vol === true`、开关集合 = `{ma,macd,kdj,boll,dcap,vol}` | 「并列 + 默认开」是**数据契约**，出在 tangle 事实源；只需一条直读断言 |
| **L1 组件层（DOM）** | `@testing-library/react` 真渲染 `Toolbar` | R2：VOL 开关存在（文本含 VOL）、`aria-pressed` 反映开关态、点击回调 `onToggleIndicator('vol')` | 「开关」是**用户可见形态**：必须真渲染出一个可点开关，而不是只存在于 props 类型里 |
| **L2 图表层（组件 + 有状态 chart 模型）** | `KlineChart` + 迷你 klinecharts | R3：`vol:false` ⇒ 不创建 VOL（无残留空 pane）；`vol:true` ⇒ 有且仅有一个 VOL（独立副图 pane） | 硬编码常开的**唯一可见后果**就在这一层：`indicators.vol` 必须真正驱动 `createIndicator/removeIndicator` |
| **L3 图表层（pane 生命周期）** | 同上（拖拽 + pane id/高度读数） | R4：`true→false→true` 后**其它 pane** 的 id/顺序不被重建、用户拖拽过的既有高度不被重置、翻转期只允许 VOL 的 create/remove | 既有硬契约（`KlineChartDcapSaveLayout.test.tsx`）的延伸：状态差分**不得**退化为重建（重建会以布局默认高度重建 pane、吞掉用户拖拽） |
| **L4 卫星层** | 真渲染 `MultiPeriodSatellite` / `MultiPeriodChartStack`（feed 用既有 stub 口径） | R5：`vol:false` 时卫星同样不创建 VOL | 「所有多周期卫星都不再有 VOL」是产品口径的显式一句；卫星是**独立 chart 实例**，必须逐实例验证 |
| **L5 兜底与页面接线** | `MultiPeriodChartStack`（不传 `indicators`）/ 真渲染 `DashboardPage` | R6：栈内部兜底默认必须含 `vol:true`；R7（附加）：工具栏开关真的驱动主图且**不写服务端配置** | R6 是**守卫**：删特权时最容易连带删掉兜底默认（卫星变「永远无 VOL」）。R7 是**接线证明**：在此之前所有用例都是直接注入 props，页面接线（Toolbar ⇄ DashboardPage ⇄ KlineChart）无人验证 |

**夹具口径**（沿用既有 `KlineChart*.test.tsx` / P2 卫星测试）：
- jsdom 无 canvas ⇒ `klinecharts` 整体打桩；
- L2/L3 用**有状态迷你引擎**（非空桩）：R4 的判据是 **pane 生命周期语义**，空桩（`vi.fn()`）表达不了
  「pane 被销毁/重建」「拖拽后的高度是 pane 的唯一记忆」⇒ 会让 R4 **永远绿**（同 `KlineChartDcapSaveLayout.test.tsx`
  的取舍与理由）；
- L4 用**每次 init 一个新实例**的桩（逐实例可断言；同 `multiPeriodSatellite.test.tsx`），卫星实例按
  `init` 容器是否位于 `[data-mp-satellite]` 子树内识别（既有 DOM 契约）；
- 所有 api/ws 均为本地 stub（0 出网、0 写请求）。

## 3. 接口 / DOM 契约（实现方必须满足；本文件与红测试共同钉死）

```ts
// ① tangle 生成物（事实源 design/06-web/01-dashboard.md）
DASHBOARD_DEFAULTS.indicators.vol === true;                 // 默认开
Object.keys(DASHBOARD_DEFAULTS.indicators).sort()            // 并列，不是隐藏特权
  === ['boll','dcap','kdj','ma','macd','vol'];
type IndicatorName = keyof typeof DASHBOARD_DEFAULTS.indicators;  // 自动含 'vol'

// ② Toolbar（DOM 契约）
// `<Button>`（`aria-pressed = indicators.vol`，文本含 `VOL`），点击 ⇒ `onToggleIndicator('vol')`；
// 不得引入新回调名（`onToggleIndicator` 是既有唯一开关通道）。

// ③ KlineChart
// `indicators.vol === false` ⇒ `getIndicators({name:'VOL'}).length === 0`（且无残留空 pane）；
// `indicators.vol === true`  ⇒ `=== 1`（独立副图 pane，paneId !== 'candle_pane'）；
// 翻转只允许对 VOL 做 create/remove；不得 remount（`init` 次数恒 1）；不得调用 `setPaneOptions`。

// ④ MultiPeriodSatellite / MultiPeriodChartStack
// 卫星沿用栈透传的 `indicators`（含 vol）；栈在**未收到** `indicators` 时内部兜底默认必须含 `vol: true`。
```

## 4. 用例清单（14 例：12 红 + 2 绿守卫）

| # | 用例（文件内 `it` 名） | 判据（Given–Then） | 实现前 | 红原因分类 |
|---|---|---|---|---|
| R1-1 | `indicators.vol === true（默认开）` | Given 生成物默认值 When 直读 Then `true`（索引访问，避免 TS 编译错代红） | **红** | 断言失败（`undefined !== true`） |
| R1-2 | `开关集合 = {ma,macd,kdj,boll,dcap,vol}` | Then 键集合逐项相等（VOL 是并列项） | **红** | 断言失败（缺 `vol`） |
| R2-1 | `VOL 开关存在（文本含 VOL），既有 5 个开关仍在` | Given Toolbar When 渲染 Then 6 个开关按钮都在 | **红** | 断言失败（`queryByRole` ⇒ null） |
| R2-2 | `默认开 ⇒ aria-pressed="true"` | Given `indicators.vol=true` Then 开关按下态 | **红** | 断言失败（`undefined`） |
| R2-3 | `关态 ⇒ aria-pressed="false"` | Given `indicators.vol=false` Then 未按下 | **红** | 断言失败（`undefined`） |
| R2-4 | `点击 VOL ⇒ onToggleIndicator("vol")` | Given 开关在场 When 点击 Then 回调实参 `'vol'` | **红** | 断言失败（开关不存在） |
| R3-1 | `初始 vol:false ⇒ 无 VOL、无残留 pane、其它指标不受影响` | Given 挂载即关 Then `VOL=0`、`MA=1`、`MACD=1`、candle pane 在 | **红** | 断言失败（`1 !== 0`） |
| R3-2 | `true ⇒ false ⇒ VOL 消失；MA/MACD 不被动到` | Given 开态 When 翻关 Then `VOL=0`、`MA=1`、`MACD=1`、实例数 1 | **红** | 断言失败（`1 !== 0`） |
| R3-3 | `vol:true ⇒ 有且仅有一个 VOL（独立副图 pane）` | Then `length===1` 且 paneId ≠ `candle_pane` | **绿（守卫）** | — |
| R4-1 | `true→false→true：非 VOL pane id/顺序不变、拖拽高度保持、无其它指标 churn` | Given VOL+MACD 在场、MACD 拖到 240 When 关再开 Then 非 VOL pane id 集合与顺序逐项不变、MACD `pane.height`/渲染高度仍 240、candle 仍是首 pane、翻转期 create/remove 只涉及 VOL、无 `setPaneOptions`、`init` 恒 1 次 | **红**（最早命中「关 VOL 未移除」） | 断言失败（`1 !== 0`）；**同用例的 pane/高度/churn 断言在本阶段为绿侧（守卫）** |
| R5-1 | `MultiPeriodSatellite（vol:false）⇒ 卫星不创建 VOL，MA 仍在` | Given 卫星直渲染 Then `VOL=0`、`MA=1` | **红** | 断言失败（`1 !== 0`） |
| R5-2 | `MultiPeriodChartStack 透传 vol:false ⇒ 卫星不创建 VOL` | Given 栈 + 1 卫星 Then `VOL=0` | **红** | 断言失败（`1 !== 0`） |
| R6-1 | `不传 indicators ⇒ 卫星仍创建 VOL（兜底默认 vol:true）` | Given 栈未收到 `indicators` Then `createIndicator({name:"VOL"})` 调用 ≥1 且 `VOL=1` | **绿（守卫）** | — |
| R7-1（附加，非父级枚举） | `点击 VOL ⇒ 主图 VOL 副图消失；不调用任何配置写接口` | Given 真渲染 `DashboardPage`（主图有 VOL） When 点工具栏 VOL Then 主图 `VOL=0` 且 `saveMaConfig/saveDcapConfig/saveMultiPeriodConfig/saveKlineConfig` 调用计数不变 | **红** | 断言失败（工具栏无 VOL 开关） |

> R3-3 / R6-1 是**守卫**（现状经硬编码常开恰好满足）：它们红不了，但必须在实现后仍绿 —— 分别覆盖
> 「删特权时把 VOL 从 `INDICATOR_DEFS` 一并删掉」与「删特权时把栈兜底默认漏掉 vol」两种退化。

## 5. 夹具与桩策略（可复现性）

1. **迷你 klinecharts（有状态）**：每条语义逐条对齐 `node_modules/klinecharts/dist/index.esm.js`（v10.0.3）
   - `createIndicator(value, isStack)`：未给 `paneId` ⇒ 新 pane（布局默认 `height:100, minHeight:30`）（`:15263-15290`）；
     `isStack !== true` ⇒ **先清空同 pane**（替换语义，`:14162-14166`）；
   - `removeIndicator(filter)`：指标清空的非 candle/x_axis pane **被销毁**（`:15323-15355`）；
   - `setPaneOptions({id,height})`：等价于用户拖拽分隔线写 `pane.height`（`:10764-10765`）；
   - measureHeight 重排：非弹性 pane = `max(minHeight, height)`（受剩余高度钳制），candle pane 吃剩余（`:14787-14835`）；
   - 读数助手（仅测试口径，非库 API）：`__paneIds()` / `__renderedHeights()` / `__renderedByIndicator()` /
     `__paneIdOf(name)` / `__log()`（**逐次 create/remove/override/setPaneOptions 调用记录**，R6 的
     「能记录 createIndicator 调用的桩」即用它表达）。
2. **夹具不污染**：`vi.clearAllMocks()` + 逐用例清空 `charts/initArgs/log`；`resetRealtimePollGateForTest()` 复位实时兜底闸门（同既有卫星测试）。
3. **不弱化判据的写法约定**：新增元素一律 `queryByRole(...)` + `expect(...).not.toBeNull()`（而不是 `getByRole`），
   保证**红必须是断言失败**，而不是「找不到元素」抛错（本任务门禁明确要求）；
   `DASHBOARD_DEFAULTS.indicators['vol']` 用**索引访问**，避免属性访问在生成物尚未含 `vol` 时变成 TS 编译错代红。

## 6. 边界与反例（均已落为断言）

- **无残留**：`vol:false` 时 `__renderedByIndicator()['VOL']` 必须 `undefined`（不得留空副图 pane）；
- **不连坐**：关 VOL 不得移除 MA（主图叠加）与 MACD（独立副图）；
- **不重建**：`init` 次数恒 1、非 VOL pane id 集合与**相对顺序**逐项不变、candle pane 仍为首 pane；
- **不重置**：用户拖拽过的 `pane.height`（240）与渲染高度在翻转前后不变，且翻转期**不得**调用 `setPaneOptions`；
- **churn 白名单**：翻转期的 `createIndicator/removeIndicator` 只允许涉及 `VOL`；
- **兜底**：栈未收到 `indicators` 时兜底默认含 `vol:true`（守卫）；
- **会话态**：页面级切换不得调用任何配置写接口（R7-1）。

## 7. 覆盖目标与**明确不覆盖**

- 覆盖：R1–R6 全部判据 + R7 附加接线；分支枚举见 §4（不做行覆盖率数值）。
- 明确不覆盖（附理由，避免被误读为漏测）：
  - **宫格（GridCell）**：现状即「K线 + MA 缩略、**无副图**」（`GridCell.tsx` 仅 `addOverlayIndicator(MA)`，无 VOL）
    ⇒ 宫格本就无 VOL 副图，无需新断言；
  - **工作台（`KlineResultChart`）**：直接传 `DASHBOARD_DEFAULTS.indicators`（静态默认，非会话态）⇒ 不属本次
    开关范围，且父级枚举 R1–R6 未要求；
  - **像素级渲染 / e2e**：jsdom 无 canvas，真实渲染取证属阶段 3（沿用 G4 口径）；
  - **服务端配置读写**：本阶段 0 写请求，仅以「写接口调用计数不变」表达会话态（R7-1）。

## 8. 变异反证计划（实现后 1 轮：每种变异必须至少翻红一条）

| 变异 | 预期被抓 | 抓它的用例 |
|---|---|---|
| M1 生成物漏加 `vol`（或默认设为 `false`） | 默认值/开关集合 | R1-1 / R1-2 / R2-2 |
| M2 Toolbar 加了 VOL 按钮但回调传 `'ma'`（或另立新回调） | 回调实参 | R2-4 |
| M3 Toolbar 有 VOL 但 `KlineChart` 仍不读 `indicators.vol` | 图表层 | R3-1 / R3-2 / R4-1 / R5-1 / R5-2 / R7-1 |
| M4 删特权时把 VOL 从 `INDICATOR_DEFS` 一并删掉（永无 VOL） | 开态在场 | R3-3 / R6-1 |
| M5 卫星用固定默认（不继承 `indicators`） | 卫星层 | R5-1 / R5-2 |
| M6 栈兜底 `DEFAULT_INDICATORS` 漏 `vol` | 兜底守卫 | R6-1 |
| M7 关 VOL 走「整图重建」（dispose+init） | 单实例 + pane id | R4-1（`init` 次数 / pane id / 高度） |
| M8 关 VOL 顺带 remove/create 全部指标 | churn 白名单 | R4-1 |
| M9 把 VOL 开关落成服务端配置（破坏会话态） | 写接口计数 | R7-1 |

> 执行方式（实现落地后）：对每条变异打一次临时补丁 → 跑本文件 → 要求**至少一条**红；M1–M9 全绿即视为
> 判据空洞。本轮（实现前）只做 M1–M6 的**自然形态**：当前实现即「M3 + M4 的反面」的组合（硬编码常开），
> 已由 12 条红覆盖。

## 9. 证据与命门

- 红运行原文：`tester/evidence/286_vol_red/vitest_volToggle_red.txt`
- 全量基线（改造前 / 改造后）：`vitest_full_suite_BEFORE.txt` / `vitest_full_suite_AFTER.txt`
- 类型检查：`tsc_b.txt`（0 字节 = 零输出；红阶段不被类型阻塞）
- 命门（实现方必读）：
  1. **不得**用「关掉 VOL 就重建图表/pane」达成（R4-1 会红）；
  2. **不得**只改 Toolbar 而不改 `syncIndicators`（R3/R4/R5/R7 会红）；
  3. 删 `INDICATOR_DEFS` 的 `'vol'` 类型逃逸时，**必须**保留 VOL 指标定义本身（否则 R3-3/R6-1 红）；
  4. 栈兜底默认与服务端 `indicators` 字段（多周期配置）**无关**：本开关是会话态，不得写回配置（R7-1）。
- 本报告路径：`tester/design/286_vol_toggle_red_design.md`
