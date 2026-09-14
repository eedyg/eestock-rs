# 251 — P0.1-A「isStack 静默顶掉」防护 · 红测试设计报告

- **本报告位置**：`tester/design/251_multiperiod_p01a_stack_guard_red_design.md`
- **类型**：Design report（本任务**新设计并编写**的红测试；非既有用例执行）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e2a04ee8cfc18904c93560fc77c10cd83f493ada`
- **取证时间**：2026-09-14T19:09:50+08:00（本机时钟）
- **执行报告（Red 证据）**：`tester/test/251_multiperiod_p01a_stack_guard_red_execution.md`
- **证据目录**：`tester/evidence/251_multiperiod_p01a_stack_guard/`
- **权威依据**：`design/15-multi-period/01-adr.md`(ADR-022 口径 9/10 之外的本期仅涉及 §4.3 硬约束)/`02-spec.md` §4.3/`03-test-plan.md` T7（G2 门禁）/`04-implementation-plan.md` 0.1；库级根因取证 `tester/report/165_ma_candle_pane_root_cause.md`。
- **性质**：**只写测试与测试基建**。未改任何生产实现/接口/架构；未 git add/commit/stash；未跑 tangle；未触碰线上（PID 3112540）；**零网络/零写请求**；临时实例：无（全程仅本地 vitest + tsc）。

---

## 1. 目标与范围

把 klinecharts 10.0.3 的**库级陷阱**固化为测试与框架约束，并让任何裸调用被**门禁**拦住：

> 同一 pane 上，先建 A（`isStack=false`/省略）→ 再建 B（`isStack=false`/省略）⇒
> `StoreImp.addIndicator` 先 `removeIndicator({paneId})` **清空整个 pane** 再 push
> （`index.esm.js:14162-14166`），而 `createIndicator` 仍返回新 id（`:15292`）、**零告警**（`:15267`）
> ⇒ 先建的 A 被**静默顶掉**。

任务要求的三块（本报告逐条落地）：

| # | 要求 | 落地产物 |
|---|---|---|
| 1 | 框架入口契约（红：入口尚不存在）`addOverlayIndicator(chart, spec, expectName)` | `web/src/features/dashboard/overlayIndicator.test.ts` |
| 2 | 裸调用门禁（红：现存违规） | `web/src/features/dashboard/indicatorCallGuard.test.ts` |
| 3 | 陷阱回归（行为级证据 + 防护断言） | `web/src/features/dashboard/indicatorStackTrap.test.ts` |

**本期明确只做 P0.1-A 红测试**：不写实现、不调参、不扩大范围；`04-implementation-plan.md` 0.3（1w 的 barSpace 上限实测）是**另一份派单**，本报告不含（按「每期只做被指派的事」）。

## 2. 测试策略

| 层 | 手段 | 为什么 |
|---|---|---|
| 引擎语义层 | **忠实 store 桩**（`web/src/test/chartStoreStub.ts`）复刻「替换/追加/无论如何返回 id」三条语义 | jsdom 无 canvas ⇒ 真身 klinecharts 跑不起来；而本坑是**引擎内部语义**，用普通 `vi.fn()` 桩会把坑抹平（桩不“替换”就永远测不出静默消失）。语义模型逐条对齐 `index.esm.js` 行号，并附矩阵 D/F/R 的单元级指纹。 |
| 框架契约层 | 桩 chart + 调用参数/顺序断言 + 异常断言 | 入口的契约是「先 remove 再 create(true) 再断言非空」，全部可在纯单元层固定。 |
| 源码静态层 | 读源码 + 去注释 + 括号配平解析实参 | 该坑**运行时零信号**（返回 id、无告警）⇒ 任意**新增**调用点只能靠静态门禁提前拦（T7 末条“grep 断言”的工程化版本）。 |
| 端到端层 | **不引入**（见 §6 未覆盖项） | 真实渲染取证属 T7 的 G4/浏览器侧（`web/e2e` + 真身 klinecharts），不在 P0.1-A 范围内，避免与本期「只做红测试」冲突。 |

### 2.1 mock/stub 策略

- **不 mock klinecharts 模块**：本三份测试都不 `vi.mock('klinecharts')`，改由**注入式忠实桩**提供 `createIndicator/removeIndicator/getIndicators` 三方法（这正是入口用到的全部表面）。这样桩的行为可被独立断言（`mock.calls` / `invocationCallOrder`），且与库语义一一对应。
- **桩不允许“宽容”**：`createIndicator(..., false)` 必须真的清空 pane；`createIndicator` 必须**总是**返回新 id。桩若被改宽松，`[证据]` 三个用例会立刻红 ⇒ 桩自身也被测试锚定。
- **入口模块加载**：红阶段入口不存在，用**变量 specifier**（类型显式 `string`）动态 `import()`；字面量会让 `tsc`/vitest 在**收集期**整体报错，拿不到逐用例 red 证据。入口落地后同一代码路径立即成功，**测试无需改动**。

## 3. 分层覆盖计划

| 覆盖层 | 覆盖内容 | 对应用例 |
|---|---|---|
| 库语义（`chartStoreStub`） | 同 pane 替换语义 / 追加语义 / 返回值语义 | `indicatorStackTrap.test.ts` 「[证据]」3 例 |
| 框架入口（`addOverlayIndicator`） | 调用顺序、`isStack=true`、非空断言、幂等、异常 | `overlayIndicator.test.ts` 4 例；`indicatorStackTrap.test.ts` 「[防护]」1 例 |
| 源码门禁 | `isStack=false` / 省略 `isStack` 全仓扫描；入口模块存在性 | `indicatorCallGuard.test.ts` 4 例 |
| 回归安全网 | 全仓既有 610 例不受影响 | 全量 `vitest run`（见执行报告） |

## 4. 用例清单

### 4.1 `web/src/features/dashboard/overlayIndicator.test.ts`（4 例，**预计红灯 = 入口模块不存在**）

| # | 用例名 | Given-When-Then | 断言要点 |
|---|---|---|---|
| A1 | 正常路径：先 removeIndicator({name}) 再 createIndicator(spec, true)，且 getIndicators({name}).length > 0 | G 忠实桩 chart；W `addOverlayIndicator(chart, {name:'MA',calcParams:[5,10,20],paneId:'candle_pane'}, 'MA')`；T 生效且顺序正确 | `removeIndicator({name:'MA'})` 被调；`createIndicator(spec, true)` 被调（**第二参必须为 `true`**）；`getIndicators({name:'MA'})` 被调；实际 `length > 0`；`remove` 的 `invocationCallOrder` **小于** `create` |
| A2 | 重复调用幂等：连调两次仍只有 1 个同名指标；每次都以 isStack=true 追加 | 连调两次同一 spec | `getIndicators({name:'MA'})` 长度 **=1**（`create(true)` 是追加 ⇒ 幂等**必须**靠显式 remove 保证）；`createIndicator` 恰好 2 次且**每次** `call[1] === true` |
| A3 | 桩令 getIndicators 返回空 ⇒ 必须抛错（不得静默返回） | `getIndicators.mockReturnValue([])`（模拟“返回 id 但不在图中”） | `toThrow()` —— 非空断言存在 |
| A4 | 抛错信息包含指标名（可定位） | 同 A3 | `toThrow(/MA/)`（对齐 `02-spec.md` §4.3 的 `指标 ${expectName} 未生效`） |

### 4.2 `web/src/features/dashboard/indicatorStackTrap.test.ts`（4 例；3 绿 = 库事实指纹，1 红 = 防护）

| # | 用例名 | 场景 | 期望 | 当前 |
|---|---|---|---|---|
| B1 | A(false) → B(false)：A 消失、B 在，且两次 createIndicator 都返回了 id（零告警） | 同 pane：MA(false) → BOLL(false) | `idA`/`idB` 均 truthy（**返回 id ≠ 指标在图中**）；`getIndicators({name:'BOLL'})`=1；`getIndicators({name:'MA'})`=**0**；`getIndicators()`=**1** | **绿（证据）** |
| B2 | 对照：省略 isStack 与 isStack=false 等价（同样顶掉 A） | MA(false) → BOLL（省略） | MA=0、BOLL=1 | **绿（证据）** |
| B3 | 对照：A(false) → B(true) ⇒ A 存活（isStack=true 才是“追加/叠加”） | MA(false) → BOLL(true) | MA=1、BOLL=1 | **绿（证据）** |
| B4 | 走 `addOverlayIndicator`：同 pane 追加第二个指标后，先建的 A 仍在 getIndicators 中 | 入口 + MA → BOLL | MA=1、BOLL=1、总数=2 | **红（入口不存在）** |

### 4.3 `web/src/features/dashboard/indicatorCallGuard.test.ts`（4 例，**2 红**）

| # | 用例名 | 断言要点 | 当前 |
|---|---|---|---|
| C1 | 扫描器自身有效性：至少扫到 KlineChart.tsx / GridCell.tsx 的调用点（防空扫通过） | 调用点集合必须包含两文件（防止“门禁写坏 ⇒ 扫不到 ⇒ 假绿”） | **绿** |
| C2 | 源码内不存在 `createIndicator(..., false)` | 违规列表 `toEqual([])`；当前收到 `GridCell.tsx:86`、`KlineChart.tsx:155` | **红（预期）** |
| C3 | 源码内不存在省略 `isStack` 的 `createIndicator` | 省略 ⇒ false ⇒ 与 C2 同罪；仅入口模块 `overlayIndicator.ts` 内被容忍 | 绿（当前无省略调用点；前向护栏） |
| C4 | 入口模块 `overlayIndicator.ts` 存在，且其 `createIndicator` 显式 `isStack=true` 追加（+ 含 `getIndicators(` 非空断言） | 读文件（ENOENT = 红）；解析出的每个调用点第二参必须 `'true'` | **红（ENOENT）** |

**门禁实现口径**（可复现、可审计）：
1. 扫描范围 = `web/src/**/*.{ts,tsx}`，排除 `node_modules`、`*.test.*`、`*.d.ts`、`src/test/`（测试基建）与 `__*`；
2. **去注释但保持字节偏移**（非换行字符替换为空格）⇒ 行号可由索引直推；注释里的示例调用不参与；
3. 只认**成员访问** `X.createIndicator(`（避免把方法**定义**误判为调用）；
4. 从 `(` 起做括号配平（忽略字符串/模板串内部），顶级逗号切分实参；
5. 判据：第二实参 `=== 'false'` ⇒ 违规；第二实参**缺失**且不在入口模块 ⇒ 违规。

## 5. 边界与异常用例

| 类别 | 用例 | 期望 |
|---|---|---|
| 边界（幂等） | A2 连调两次 | 长度恒 1（不因 `isStack=true` 追加而变成 2） |
| 边界（追加 vs 替换） | B3 / B4 | `true` 下两指标共存；`false` 下后者胜（B1/B2） |
| 异常（静默失效） | A3 / A4 / C4 | 一律**抛错**；错误信息含指标名 |
| 异常（模块缺失，红阶段） | A1–A4、B4、C4 | 逐用例失败并给出明确原因：`Cannot find module './overlayIndicator'` / `ENOENT ... overlayIndicator.ts` |
| 防假绿（自检） | C1 | 门禁扫不到目标文件即红（防“空扫通过”） |
| 防假绿（桩自检） | B1–B3 | 桩若被改宽松（不替换）则立即红 |
| 空白/边界输入 | 不在本期（`spec` 形状由 `IndicatorCreate` 类型约束） | — |

## 6. 覆盖目标与未覆盖项（诚实声明）

**覆盖目标**：P0.1-A 的三条要求在**单元 + 静态**两层 100% 覆盖（12 例中 7 例当前红、5 例绿；红的 7 例即本期要转绿的目标集）。

**本期未覆盖（明确不做，非疏漏）**：

| 未覆盖 | 原因 | 归属 |
|---|---|---|
| 真身 klinecharts 渲染级取证（画布像素/图例文字） | 属 G4/T7 的浏览器侧；P0.1-A 只做红测试 | 后续（e2e 层，`web/e2e`） |
| `KlineChart.tsx` / `GridCell.tsx` 改走入口后的**集成行为**（组件级） | 需先有入口实现（本轮禁写实现） | 实现落地后的验收轮（tester 独立验收） |
| `04-implementation-plan.md` 0.3（1d↔1w 的 `barSpace`/`barSpaceLimit` 实测锚定） | 另一份派单，不在本期范围 | 独立任务 |
| 入口在**真实 pane**（非 candle_pane）上的行为 | 库语义与 paneId 无关（165 报告 §2 矩阵已证） | 由 B1–B4 的 paneId 参数化隐含覆盖 |

## 7. 交付物与指纹

| 文件（相对 `web/`） | 类型 | sha256 |
|---|---|---|
| `src/features/dashboard/overlayIndicator.test.ts` | 红测试（新增） | `ffa529be2e0b12249214c9b0cb14d598e841aaf6c7b9b5e3407a1d3b54fa62f5` |
| `src/features/dashboard/indicatorStackTrap.test.ts` | 红测试（新增） | `6c6718d9c3b41430883e702998a15f287cae9344169f8d363949f63c3fbb2219` |
| `src/features/dashboard/indicatorCallGuard.test.ts` | 红测试（新增） | `74620993dba410b41163bd02e2b7f46a947580950d370c20cba23a877f61c145` |
| `src/test/chartStoreStub.ts` | 测试基建（新增，忠实 store 桩） | `759dc390ea0acba1dbf626910a43a31a1989d499b437d1dd555fbac43c510715` |

**实现方需落地的目标接口**（本报告不改实现，只声明契约）：

```ts
// web/src/features/dashboard/overlayIndicator.ts
export function addOverlayIndicator(chart: Chart, spec: IndicatorCreate, expectName: string): void
// 1) chart.removeIndicator({ name: expectName });
// 2) chart.createIndicator(spec, /* isStack */ true);
// 3) if (chart.getIndicators({ name: expectName }).length === 0) throw new Error(`指标 ${expectName} 未生效（isStack 语义坑）`);
```

同时整改两处现存违规（本报告未改）：`KlineChart.tsx:155-158`（MA 走 `false`）、`GridCell.tsx:86`（MA 走 `false`）。

VERDICT: RED-READY（设计已落地为可运行红测试；7 红 / 5 绿，见执行报告）
