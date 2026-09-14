# 261 — P0.1-D 设计报告：C1 门禁加强（A 方案）+ 旧断言同步

本文件路径：`tester/design/261_p01d_c1_gate_hardening_design.md`
角色：Tester（设计 + 落地测试；不改产品代码）
时间：2026-09-12（本地时区）· 仓库 `eestock-rs` @ `e2a04ee`（工作区含 P0.1-B 未提交改动）
背景：P0.1-B 已新增 `web/src/features/dashboard/overlayIndicator.ts`（`addOverlayIndicator(chart, spec, expectName)`），
并把 `KlineChart.tsx`（MA 分支）、`GridCell.tsx`（MA 热更新）改走该入口。全量 `vitest` 基线 = **542 passed / 75 failed**，
失败全部归因于 tester 侧待办：① 7 个测试文件的 chart 桩缺 `getIndicators`；② 门禁 C1 期望文件集/牙齿；③ 编码旧行为的断言。

---

## 1. 测试策略（本轮只动 tester 侧）

| 层次 | 目标 | 手段 |
|---|---|---|
| 静态门禁（C1） | “任何新增 `createIndicator` 调用点都不得以 `false`/省略/变量 `isStack` 创建” | `web/src/features/dashboard/indicatorCallGuard.test.ts` 源码级扫描（**加强**） |
| 契约（入口） | `addOverlayIndicator` = remove → create(true) → `getIndicators({name})` 非空断言 | `overlayIndicator.test.ts`（已存在，未改断言） |
| 集成（既有回归） | P0.1-B 之后既有集成测试不得因桩缺 API 连坐 | 7 个测试文件的 chart 桩补 `getIndicators`（保真、无跨用例状态） |
| 断言同步 | 把“编码旧行为”的断言同步到新契约（走入口 + `isStack=true` + remove 先于 create） | `KlineChart.test.tsx` ×3、`GridCell.test.tsx` ×2（**不删用例**） |

**不做**：不改产品代码（除变异验证的临时注入且已还原）、不改任何既有断言的**判据强度**（只改被产品契约变更所推翻的旧值）、不新增行为断言口径。

---

## 2. C1 门禁改动设计（逐条证明「加强」而非「放宽」）

期望文件集：`{KlineChart.tsx, GridCell.tsx}` → **`{overlayIndicator.ts, KlineChart.tsx}`**（两处 MA 已入口化 ⇒ 原地调用点消失；
`overlayIndicator.ts` 成为唯一新锚点；`KlineChart.tsx` 保留 DCAP 独立副图调用点）。

| # | 初版（P0.1-A） | 本版（P0.1-D） | 方向 |
|---|---|---|---|
| ① 扫描面 | `web/src/**` 全部调用点 | 不变（**未缩小**） | 持平 |
| ② 文件集作用 | 仅作“防空扫”样本（存在即可） | **白名单约束**：调用点文件 ⊆ `{overlayIndicator.ts, KlineChart.tsx}`，越界判红 | **加强** |
| ③ isStack 规则 | 红：字面 `false`；红：非入口处**省略**。⇒ 非入口处传**变量**可绕过 | 红：**非字面 `true` 一律判红**（`false` / 省略 / 变量 / 表达式） | **加强**（严格超集） |
| ④ 入口模块 | ≥1 次调用且 `isStack='true'`；源码含 `getIndicators(` | 追加**顺序契约**（去注释后 `removeIndicator` 先于 `createIndicator`） | **加强** |
| ⑤ 防空扫 | 断言扫到 KlineChart/GridCell 两文件的调用点 | 断言**扫描文件数 ≥ 30** + 白名单文件均真扫到 + 调用点总数 ≥ 2 | **加强** |

### 用例清单（Given-When-Then 摘要）

1. `扫描器自身有效性：白名单文件均扫到调用点，且扫描范围未塌缩（防空扫通过）`
   Given 扫描 `web/src/**` 生产源码；Then `SCANNED_FILES.length ≥ 30` 且 `overlayIndicator.ts`/`KlineChart.tsx` 均在命中文件集内且总调用点 ≥ 2。
2. `调用点只能出现在白名单文件（新增叠加指标必须走入口 overlayIndicator.ts）`
   Given 全部调用点文件集；Then 与白名单的差集为空，报告越界文件。
3. `每个 createIndicator 调用点都必须**显式** isStack=true（false / 省略 / 变量一律判红）`
   Given 每个调用点的第二实参原文；Then 必须字面等于 `'true'`，否则列出 `file:line  isStack=…`。
4. `入口模块 overlayIndicator.ts：显式 isStack=true 追加 + 先 remove 后 create + getIndicators 非空断言`
   Given 入口源码（注释已剥离）；Then 调用 ≥1 且全为 `'true'`、`getIndicators(` 存在、`indexOf('removeIndicator') < indexOf('createIndicator')`。

**边界/异常**：注释剥离保持字节偏移（行号可信）；括号配平 + 顶级逗号切分（字符串/嵌套结构内逗号不切）；字符串/模板串内忽略；
成员访问要求（`.createIndicator(`）避免把方法**定义**当调用；`web/src/test/**` 与 `*.test.*` 不参与扫描（测试基建豁免）。

**覆盖目标**：C1 对 `web/src` 内 100% 的 `createIndicator` 调用点做静态判定（当前实测 2 处，全部 `true`）。

---

## 3. 桩补 `getIndicators` 的设计

- 位置：`web/src/test/chartStoreStub.ts`（测试基建，新增 `IndicatorViewFilter` / `IndicatorView` / `indicatorViewFromCalls` / `bindGetIndicators`）。
- 语义：**由 `createIndicator` / `removeIndicator` 的调用记录派生**在场指标（按 `invocationCallOrder` 归并时序）：
  - `isStack=true` ⇒ 追加；`false`/省略 ⇒ **先清空同 pane**（复刻 `StoreImp.addIndicator`，`:14162-14165`）；
  - 过滤口径：`id` 优先，否则 `name`（未给即不筛）+ `paneId`；返回元素含 `name`/`paneId`/`id`（+ 透传 `calcParams`）；
  - 关键性质：`vi.clearAllMocks()` 清空调用记录 ⇒ **每个用例天然从“图里什么都没有”开始**，不引入跨用例残留状态把失败掩盖成绿。
- 接线：7 个文件的既有 `chartStub` 各加一行 `getIndicators: vi.fn((filter) => indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {}))` + 一行 import；**既有断言的期望值不动**（唯一例外见 §4）。

补桩清单：`KlineChart.test.tsx`、`KlineChart.realtime.test.tsx`、`GridCell.test.tsx`、`DashboardPage.test.tsx`、
`dcapWiringP3.test.tsx`、`ResultView.test.tsx`、`WorkbenchPage.test.tsx`（7 个；一次性缺失 `getIndicators` 的桩恰为此 7 个，
`KlineChartSwitchLayout.test.tsx` / `KlineChartDcapSaveLayout.test.tsx` 早已自带 `getIndicators`）。

---

## 4. 旧行为断言同步（不删用例，只改被契约推翻的期望）

| 文件:行（改后） | 旧断言（编码旧行为） | 新断言（同步方向） |
|---|---|---|
| `KlineChart.test.tsx` 不传 maWindows | MA `createIndicator(…, false)` | `createIndicator(…, true)` + `removeIndicator({name:'MA'})` + **remove 调用序 < create 调用序** |
| `KlineChart.test.tsx` maWindows=[7,20,60] | MA `false` | `true` |
| `KlineChart.test.tsx` maWindows 变化（原地 override） | `removeIndicator` **从未调用** | `removeIndicator` 恰 1 次（建图那一回）且 `{name:'MA'}`、remove 先于 create；参数变化仍不得再 remove/create |
| `GridCell.test.tsx` 默认 maWindows | MA `false` | `createIndicator(…, {paneId:'candle_pane'}, true)` + remove 先于 create |
| `GridCell.test.tsx` maWindows=[7,20,60] | MA `false` | `true` |

> 说明：架构任务书口径为“`KlineChart.test.tsx` 3 处”；实测同类的旧行为断言共 **5 处**（另有 `GridCell.test.tsx` 2 处，
> 其失败同样由 `isStack=false` 契约变更导致）。同步方向与任务书一致，未放宽任何判据。

---

## 5. 变异验证设计（必须做）

| 变异 | 位置 | 期望 | 目的 |
|---|---|---|---|
| M1 | `GridCell.tsx` 临时插入裸 `chart.createIndicator({name:'MA',…}, /*isStack=*/false)` | C1 **变红**（白名单 + isStack 两条） | 证明 C1 仍有牙齿 |
| M2 | `KlineChart.tsx` 临时把 DCAP 的 `true` 换成**变量** `legacyIsStack` | C1 **变红**（仅 isStack 条） | 证明本版**严格强于**初版（初版只查 `false`/省略，变量可绕过） |
| M3 | 临时删除入口 `overlayIndicator.ts` 的非空断言 | 有测试**变红**（`overlayIndicator.test.ts` 3 例） | 证明“加桩不掩盖失败”（桩与断言都在载荷路径上） |
| M4 | 临时令派生桩恒返回 `[]`（不忠实桩） | 3 个被测文件 **30 例变红** | 反向控制：证明测试真的消费桩结果，不是空跑绿 |

M1–M4 均要求**逐字节还原**后复绿（产品代码 sha256 前后一致）。

---

## 6. 依据

- `design/15-multi-period/02-spec.md` §4.3（框架级硬约束）、`03-test-plan.md` T7（G2 门禁）
- `tester/report/165_ma_candle_pane_root_cause.md`（零告警根因取证）
- 架构师裁决（P0.1-D）：A 方案 + C1 加强三条件（牙齿、变异验证、桩保真）
