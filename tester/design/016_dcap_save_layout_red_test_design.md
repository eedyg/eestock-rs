# 测试设计 016 — 「保存 dcap 配置不得重置布局」红测试（jsdom + 有状态 klinecharts 模型）

- **本文件位置（self-location）**：`tester/design/016_dcap_save_layout_red_test_design.md`
- 关联执行报告：`tester/test/051_dcap_save_layout_reset_diagnosis_execution.md`
- 关联证据目录：`tester/evidence/051/`（真实渲染探针 probe1~5 + 沙箱候选修复复跑 + 只读 SELECT）
- 被测改动：**无**（阶段 1 只做证据；本设计产出的一条测试落在 `web/` 既有测试基建内，当前**必红**）
- 权威口径：`design/14-dcap-indicator/02-spec.md` §6（图表契约 C）、`03-test-plan.md` T8/T8-跨面板布局项；本次新增用户需求「保存 dcap 配置后当前布局不得重置」

---

## 1. 测试策略摘要

| 层 | 手段 | 本设计是否使用 | 理由 |
|---|---|---|---|
| 单元 | vitest + 纯函数 | 否（本次缺陷在组件接线层，非算法层） | — |
| 组件（jsdom） | vitest + **有状态的 klinecharts 迷你引擎** | **是（新建 `web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`）** | 缺陷判据是 **pane 生命周期语义**，空桩（`vi.fn()`）表达不了 ⇒ 会永久假绿；模型语义逐条对齐真实库源码行号（见 §4） |
| 真实渲染 | Playwright + 临时构建/临时端口 + 真实 klinecharts 10.0.3 | 是（`tester/evidence/051/probe3.mjs`，**诊断证据**，不进仓库测试栈） | 证明模型语义与真实引擎一致（VOL 237→100、pane id 更换、`init` 计数不变/增加） |
| E2E | `web/e2e/**`（需真实 app 实例） | 否 | 需要 18085 临时构建 + 只读代理；不适合作为仓库常驻测试（前置多、且会写 `/api/config/dcap`） |

**为什么真实渲染不写进仓库测试栈**：判据要求「真实 klinecharts」⇒ 必须真实浏览器（jsdom 无 canvas，既有 `KlineChart.test.tsx` 因此整体打桩）；而真实浏览器跑 `web/e2e` 需要可写后端（保存 dcap 会 `PUT /api/config/dcap` 落库），既污染共享 DB 又依赖外部实例 ⇒ 不可重复、不适合作为常驻回归。故常驻红测试用模型（可重复、无外部依赖），真实性由本设计 §4 的「模型↔真实实测」交叉表保证。

---

## 2. 层覆盖计划

| 契约点 | 覆盖方式 | 期望（修复前 → 修复后） |
|---|---|---|
| pane 高度在「参数保存」后不变 | 组件测试（红）| 红 → 绿 |
| pane 不被销毁重建（id 集合不变） | 组件测试（红）| 红 → 绿 |
| 保存期间无 `removeIndicator/createIndicator`（差分配置） | 组件测试（红）| 红 → 绿 |
| dcap 线值按新参数更新（真实 CORE 模板逐位对照） | 组件测试（红测内同一条用例） | 绿 → 绿（防「为保高度而丢掉重算」） |
| 指标启用状态翻转仍 create/remove | 组件测试（守卫，当前绿） | 绿 → 绿 |
| 真实引擎语义一致性（remove 销毁 pane / create 默认 100 / override 保高度） | 真实渲染探针（诊断证据） | — |
| 真值锚点：保存路径等价于 `dcapParams` props 变化且 feed 不换 | 真实渲染探针 A/C（`__KC_INITS__` 不变） | — |

---

## 3. 测试用例清单（Given-When-Then / should-when 命名）

文件：`web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`

### T-1（红）`改 dcapParams 后：既有 pane 高度不变（±1px）、pane 不被销毁重建、dcap 线值按新参数更新`
- **Given** `KlineChart` 以 `indicators={ma:true,dcap:true,...}`、`dcapParams=P0(8/26/60/1/1/1/1/3)`、同一 `feed` 渲染；用户已把 VOL 拖到 240、DCAP 拖到 200（模拟 `SeparatorWidget` 写 `pane.setOptions({height})`）
- **When** 以同一 feed、同一 indicators、仅 `dcapParams=P1(…,r_s=1.3,smooth=0)` rerender（= `DashboardPage.saveDcapParams` 的等价 props 变化）
- **Then** ① 每个 pane 的**渲染高度**与保存前逐值相等（±1px）；② pane id 集合不变；③ 期间无 `removeIndicator/createIndicator`；④ DCAP 的 `calcParams === dcapCalcParams(P1)` 且其 `result` 与 `DCAP_INDICATOR_TEMPLATE.calc(dataList, {calcParams: dcapCalcParams(P1)})` 逐位一致（±1e-12，`zero` 恒 0），并与旧参数结果**不相同**
- **当前状态**：**RED** —— `AssertionError: expected 240 to be less than or equal to 1`（VOL 渲染高度 240 → 0：pane 被销毁后新 pane 只有默认 100 且非弹性；模型按剩余高度分配 ⇒ 该 pane 拿到 0）

### T-2（守卫，当前绿）`指标启用状态翻转仍必须 create/remove（差分不得吞掉开关语义）`
- **Given** DCAP 开（DCAP pane 存在且 `calcParams` 8 参）
- **When** `dcap: false` → rerender；再 `dcap: true` → rerender
- **Then** 关闭时 `getIndicators({name:'DCAP'})` 为空且该 pane 消失；重开时恢复 1 个且带 `calcParams`
- **目的**：把「状态差分」的边界钉死——只有**参数变化**走 `overrideIndicator`，**启用状态翻转**必须回到 create/remove

---

## 4. 迷你引擎的语义依据（逐条对齐真实库源码；模型 ↔ 真实实测交叉）

| # | 模型语义 | 真实库依据（`klinecharts@10.0.3 dist/index.esm.js`） | 真实渲染实测交叉验证（本车道 probe3） |
|---|---|---|---|
| 1 | 新 pane 默认 `height:100 / minHeight:30 / state:'normal'` | `:13250-13256`（`_layoutOptions.pane` 默认） | 新建 VOL pane `getPaneOptions().height == 100` |
| 2 | `createIndicator` 未给 `paneId` ⇒ 新 pane；新 pane 取默认高 | `:15263-15290`（`_createPane(IndicatorPane, {...pane 模板, id})`） | VOL→新 id `…50507_3`，`height 100` |
| 3 | `removeIndicator` 清空 pane ⇒ pane 被销毁（candle/x_axis 除外） | `:15323-15355`（`pane.destroy()` + `_drawPanes.splice`） | A 场景 `removeIndicator VOL` 后 pane 从列表消失 |
| 4 | 拖拽写 `pane.setOptions({height})`（拖后高度是唯一记忆） | `:10764-10765`（`SeparatorWidget`） | 拖高 VOL：`getPaneOptions().height 100→237`，DOM 高度同值 |
| 5 | `measureHeight` 重排：非弹性 `max(minHeight, options.height)`，candle 吃剩余 | `:14787-14835` | A 场景 DOM：`candle 460→597`（吸收 VOL 释放的 137px） |
| 6 | `overrideIndicator` 原地改 `calcParams` 并重算，不销毁 pane；`layout` **不带** `measureHeight` | `:14242-14283`（store）、`:15296-15321`（chart） | E 场景：6 条 pane 渲染高度逐值相等、pane id 不变、线值/Y 轴变 |
| 7 | `overrideIndicator` 仅 calc 变化时**返回 false** | `:15296-15318`（`updated` 只在 draw/sort 置位） | E 场景：6 次调用全 `false`，但状态与线值确实已更新 ⇒ 禁用返回值判成功 |
| 8 | 容器总高/弹性分配是渲染高 | 同 5 | 主图区 724 − x_axis 26 = 698 = candle+副图之和（实测 496+100+100 / 597+100 等） |

> 模型只保留**判据相关**语义（pane 生命周期 + 高度分配 + calcParams 传递 + DCAP 真算）；渲染像素、K 线数据加载、overlay、WS 一律不在模型内（由既有测试与真实探针覆盖）。

---

## 5. Mock / Stub 策略

- **klinecharts 整体 `vi.mock`**（对应真实模块面）：`init()` 返回有状态 chart；`dispose()`；`registerIndicator(tpl)` 收集模板，并为内置 `MA/VOL/MACD/KDJ/BOLL` 预置最简等价模板（只为验证 `calcParams` 传递，不验证其数值）。
- **DCAP 用真身**：`ensureDcapIndicatorRegistered()` 落到 stub 的 `registerIndicator` ⇒ stub 的 `createIndicator/overrideIndicator` 用**真实 `DCAP_INDICATOR_TEMPLATE.calc`** 计算 `result`（输入是 stub 内确定性合成行情，150 根，保证三线在 `n_l=60,m=3` 下出值）⇒ 「线值按新参数更新」是**真算**（并用独立 oracle 逐位对照）。
- **不 mock 被测组件**：直接渲染 `KlineChart`（含两处 `syncIndicators` 调用点、两处 useEffect）。
- **不依赖实现细节**：断言只落在「渲染高度 + pane id + 指标 result + 调用差分的**空集**」；不断言具体调用次数/顺序，避免把候选实现锁死（`overrideIndicator` 的返回值也不参与断言）。

---

## 6. 边界与异常用例

| 场景 | 处理 |
|---|---|
| 参数变化等价于**两次** setState（乐观更新 + 服务端回显） | 真实路径实测为 2 个 React commit ⇒ 2 次 effect。本测试只做一次 rerender（更弱条件）；修复若通过则双次必然通过（差分是幂等的：第二次 desired==applied ⇒ 无操作） |
| feed 身份变化（warmup 变 ⇒ 整图 remount，路径 B） | **本测试不覆盖**（模型/单测无法表达"整图重建"的布局后果，属另一条路径）。真实证据见执行报告 §3-B；修复建议见执行报告 §6 的第 2 步 |
| DCAP 关 → 参数仍变化（DCAP pane 不存在） | 不应误建 DCAP pane（真实实测 A7 绿）；模型下 T-1 用 DCAP 开态，另在守卫测试里覆盖关态 |
| 非弹性 pane 已被拖到 `minHeight` | 不新增用例（高度判据是"不变"，与具体值无关） |
| `vi.clearAllMocks()` 但 stub chart 对象跨用例共享 | 模型每次 `init()` 生成**新** chart 对象；组件侧已应用状态也应随建图重置（见执行报告 §6 副作用面：模块级 WeakMap 会被共享桩污染） |

---

## 7. 覆盖目标（定性，本项目未启用覆盖率工具）

- **必须覆盖**：`syncIndicators` 的两条调用路径（mount effect / deps effect）在**参数变化**下不得产生 pane 级副作用；`overrideIndicator` 作为参数热更新的唯一通道（模型侧断言其被使用或至少「无 churn」）。
- **不覆盖**：klinecharts 自身渲染正确性、DCAP 数值正确性（T1~T7 已有）、视口/barSpace（ADR-020 既有测试）。
- **回归门**：`cd web && npx vitest run` 全绿（除本红测试在修复前必红）+ `npx tsc -b` 干净。

---

## 8. 与其他车道的边界

- 本设计只产出**测试**（`web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`），不改产品代码、不改接口/架构、不改 `design/14-dcap-indicator` 的 `file=` 代码块、不跑 tangle。
- 修复由 coder 车道执行；修复后本红测试应变绿，且 §3-T2 守卫必须保持绿（`fix-candidates/sandbox-fix-runs.txt` 已用沙箱副本预演：v3 候选修复下 T-1/T-2 双绿，仅 2 条既有测试因「churn 断言过期」需同步更新）。
