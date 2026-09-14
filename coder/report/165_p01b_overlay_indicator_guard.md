# 165 — P0.1-B 实现：`addOverlayIndicator` 框架入口 + 整改两处裸调用

- **本报告位置**：`coder/report/165_p01b_overlay_indicator_guard.md`
- **类型**：Change report（worker 实现轮；P0.1-B）
- **仓库 / 提交**：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `e2a04ee`；工作区改动**未 staged**）
- **权威依据**：`design/15-multi-period/01-adr.md`（ADR-022）· `02-spec.md` §4.3 · `03-test-plan.md` T7 · `04-implementation-plan.md` 0.1；库级根因 `tester/report/165_ma_candle_pane_root_cause.md`；红测试设计/执行 `tester/design/251_*`、`tester/test/251_*`
- **性质**：**只改产品代码**。未改任何 tester 测试文件与桩；未 `git add/commit/stash`；未在仓库内跑 `entangled tangle`（仅在 `check-tangle.sh` 的沙箱内）；未触碰线上 PID 3112540；**零写请求**；无临时实例/端口（无收尾项）。

---

## 1. What changed（改动文件清单）

| 文件（相对 `web/`） | 类型 | 行数 | 说明 |
|---|---|---|---|
| `src/features/dashboard/overlayIndicator.ts` | **新增** | +2/-0（45 行新文件） | 框架入口 `addOverlayIndicator(chart, spec, expectName)`；doc 注释引用 P7 根因（`index.esm.js:14162-14165`、`:15292`、`:15267`） |
| `src/features/dashboard/KlineChart.tsx` | 修改 | +9/-3 | MA 走 `candle_pane` 的裸调用（原 `createIndicator(..., false)`）改走入口 |
| `src/features/dashboard/GridCell.tsx` | 修改 | +8/-1 | MA 热更新裸调用（原 `removeIndicator` + `createIndicator(..., false)`）改走入口 |

`git diff --stat`（产品代码，未 staged）：`KlineChart.tsx | 9 +++++++--`、`GridCell.tsx | 10 ++++++++--`；新增入口为未跟踪文件。**staged 文件数 = 0**（`git diff --cached --name-only | wc -l` = 0）。

### 1.1 入口实现（逐字对齐 `02-spec.md` §4.3）

```ts
export function addOverlayIndicator(chart: Chart, spec: IndicatorCreate, expectName: string): void {
  chart.removeIndicator({ name: expectName });   // 1) 显式移除旧实例（create(true) 是追加）
  chart.createIndicator(spec, true);             // 2) 必须 isStack=true（追加语义）
  if (chart.getIndicators({ name: expectName }).length === 0) {
    throw new Error(`指标 ${expectName} 未生效（isStack 语义坑）`);  // 3) 空则抛错，禁止静默
  }
}
```

### 1.2 两处整改

- **KlineChart.tsx** `syncIndicators()`：`ma` 分支 `chart.createIndicator({...paneId:'candle_pane'}, false)` → `addOverlayIndicator(chart, {...paneId:'candle_pane'}, def.name)`。仅「`ma` 且首次启用（启用状态翻转）」路径变化；其余指标（VOL/MACD/KDJ/BOLL/DCAP，均为独立 pane 且 `isStack=true`）**一行未动**。
- **GridCell.tsx** MA 热更新 effect：`chart.removeIndicator({name:'MA'})` + `chart.createIndicator({...}, false)` → `addOverlayIndicator(chart, { name:'MA', calcParams: maWindowsProp, paneId:'candle_pane' }, 'MA')`。effect 依赖数组不变（`[maWindowsProp, period, symbol.code]`）。调用语义等价（入口内部第一步就是同一个 `removeIndicator({name:'MA'})`）。

## 2. Architecture alignment（分层）

- 入口落在 **features/dashboard 展示层**（与 KlineChart/GridCell 同层），无跨层依赖：仅 `import type { Chart, IndicatorCreate } from 'klinecharts'`（**type-only**，运行时零 import）+ 使用 `Chart` 的 `removeIndicator/createIndicator/getIndicators` 三个公开方法。未新增依赖、未改 ABI/引擎/接口契约。
- 该入口正是 ADR-022 / `02-spec.md` §4.3 指定的「**唯一**允许在已有指标 pane 叠加指标的入口」，承载库语义坑的防护与断言，符合「层内封装、不扩散」。

## 3. Problem solved（解决的问题）

klinecharts 10.0.3 的 `createIndicator(value, isStack)` **省略 `isStack` 即 `false` = 整 pane 替换**语义（`index.esm.js:14162-14165` 先 `removeIndicator({paneId})` 清空再 push），但**仍返回新 id**（`:15292`）且**零告警**（`:15267`）⇒ 同一 pane 上后建的 `isStack=false` 指标会**静默顶掉**先建指标（实测 MA→EMA/BOLL 复现，见 tester 165 报告矩阵 D/F/R）。

本次整改消除现存的**两处裸调用**风险面，并把「叠加到共享 pane」收敛到带**非空断言**的唯一入口：一旦指标被静默顶掉（`getIndicators` 为空）立即**抛可定位错误**（含指标名），不再静默失效。

## 4. Implementation approach（关键决策）

1. **严格照抄规格签名与三步顺序**（remove → create(true) → assert），不做任何“顺手优化/调参”。
2. **入口对 `createIndicator` 的第二参显式写 `true`**（满足裸调用门禁 C3/C4 的字面/结构判据）。
3. **两处调用点只改 MA 路径**，其余指标分支不动（最小改动、不扩大范围）。
4. 行为等价性：入口第一步的 `removeIndicator({name:'MA'})` 对 GridCell 是**原有步骤的位移**（原来就调用）；对 KlineChart 是**新增的一次** `removeIndicator`（旧实现 MA 首次创建不 remove）——这是 §4.3 契约的**预期**行为，需 tester 相应用例同步（见 §7）。

## 5. Test coverage（本轮未新增/未改测试）

- **本轮 worker 未新增也未修改任何测试文件与桩**（遵守 supervisor 裁决分工：测试侧改动归 tester）。
- 既有红测试（P0.1-A）直接覆盖新入口：`overlayIndicator.test.ts`（4 例）、`indicatorStackTrap.test.ts`（4 例）、`indicatorCallGuard.test.ts`（4 例），**无需改动即转绿 11/12**（见 §6）。

## 6. Verification（自测证据）

原始输出留存于 `coder/evidence/165_p01b_overlay_indicator_guard/`：`vitest_p01a_3files.txt`、`vitest_full_summary.txt`、`tsc_b.txt`（0 字节 = 零输出 = 通过）、`check_tangle.txt`。

| # | 命令（cwd=`web/` 或仓库根） | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npx vitest run src/features/dashboard/{overlayIndicator,indicatorStackTrap,indicatorCallGuard}.test.ts` | 1 | **Tests 11 passed \| 1 failed (12)**；唯一失败 = `indicatorCallGuard.test.ts` 的 **C1**（防空扫自检，见 §7） |
| 2 | `npx tsc -b` | **0** | 通过（零输出） |
| 3 | `npx vitest run`（全量） | 1 | **Test Files 8 failed \| 58 passed (66)；Tests 75 failed \| 542 passed (617)**；失败**全部**可归因于「测试桩缺 `getIndicators`」（7 文件，`TypeError: chart.getIndicators is not a function`）+「门禁 C1」（1 文件）——按 supervisor 裁决属 tester 交付（见 §7） |
| 4 | `./scripts/check-tangle.sh`（仓库根） | **0** | ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对；工作区未被修改） |

### 6.1 逐用例结果（P0.1-A 三文件）

```
✓ src/features/dashboard/indicatorStackTrap.test.ts (4 tests)
✓ src/features/dashboard/overlayIndicator.test.ts (4 tests)
✓ indicatorCallGuard · 源码内不存在 createIndicator(..., false)        （C2 转绿）
✓ indicatorCallGuard · 源码内不存在省略 isStack 的 createIndicator     （C3 绿，前向护栏）
✓ indicatorCallGuard · 入口模块 overlayIndicator.ts 存在且 isStack=true（C4 转绿）
× indicatorCallGuard · 扫描器自身有效性：至少扫到 KlineChart.tsx / GridCell.tsx 的调用点（C1，见 §7）
```

### 6.2 行为未变化的证据（MA 仍显示）——临时自证（已删除）

因既有桩缺 `getIndicators`，本轮**临时**新建了一个自证文件 `web/src/features/dashboard/__scratch_p01b_verify.test.tsx`（带忠实 `getIndicators` 桩），仅本机运行取证后**立即删除**（`rm` + `git status` 确认无残留；不是交付物、未改任何 tester 文件）。运行结果：

```
✓ __scratch_p01b_verify.test.tsx (2 tests)
  · KlineChart：MA 以 isStack=true 走入口创建，且 getIndicators({name:'MA'}).length === 1（MA 仍显示）
  · GridCell  ：MA 以 isStack=true 走入口创建，且 getIndicators({name:'MA'}).length === 1（MA 仍显示）
```

即：两组件整改后 **MA 依旧被创建且留在 `getIndicators` 中（行为不变）**，且创建第二参由 `false` 变为 `true`（整改生效）。参数变更路径未触碰（仍走 `overrideIndicator`），勾选启用/关闭的差分语义未变。

### 6.3 grep 门禁结果

```
$ grep -rnE '\.createIndicator\s*\(' web/src --include='*.ts' --include='*.tsx' | grep -v '/test/' | grep -v '\.test\.'
KlineChart.tsx: ...createIndicator(createIndicatorValue(def.name, desired), true)   ← 显式 true（非 MA 指标，独立 pane）
overlayIndicator.ts: chart.createIndicator(spec, true)                               ← 入口，显式 true
```

`web/src` 生产代码内**已无** `createIndicator(..., false)`，也**无**省略 `isStack` 的调用点（KlineChart 的 MA 分支已改走入口）。

## 7. ⚠️ 需 tester 执行的三件事（supervisor 裁决：A 方案；测试侧改动**归 tester**）

> worker **未改**任何 tester 测试文件与桩。以下为按裁决交接给 tester 的必要改动（均属**加强**，需按 supervisor 口径附**变异/牙齿验证**）：

1. **C1 期望文件集**：`indicatorCallGuard.test.ts` C1 的 `{KlineChart.tsx, GridCell.tsx}` → `{overlayIndicator.ts, KlineChart.tsx}`（`overlayIndicator.ts` 成为新锚点）。★ supervisor 要求：不能只换文件名，必须**保留/强化判据牙齿** —— 扫描 `web/src` 下**所有** `createIndicator(` 调用点，断言每个要么**显式 `true`**、要么**位于入口模块内**；`false`/省略一律判红。
2. **变异验证（必做）**：临时注入一处裸 `createIndicator(spec, false)`（如 GridCell/KlineChart）⇒ C1 必须变红；还原后复绿。
3. **8 个测试文件的 chart 桩新增 `getIndicators`**（DashboardPage / dcapWiringP3 / GridCell / KlineChart / KlineChart.realtime / ResultView / WorkbenchPage，+ C1 所在文件）：允许（桩保真度提升，不改既有断言），但须 ①忠实（支持 `name` 过滤，返回形状含被测代码读取的字段）；②做「**加桩不掩盖失败**」验证（临时去掉入口非空断言 ⇒ 必须有测试变红）。

### 7.1 另有 3 处既有断言按 §4.3 契约需 tester 同步（属整改的预期副作用，非放宽）

- `KlineChart.test.tsx`（2 处，约 :155 / :178）：断言 MA 以 **`false`** 创建 → 应改为 **`true`**（本整改的核心行为变更）。
- `KlineChart.test.tsx`（约 :190）：`expect(chartStub.removeIndicator).not.toHaveBeenCalled()` —— 入口在**创建时**会先 `removeIndicator({name:'MA'})`（§4.3 明定的三步之一），该断言应细化为「**rerender（参数变更）之后**不得 remove/create」，而非全局「从未调用」。
- 上述两点若不改，即便补齐 `getIndicators` 桩，`KlineChart.test.tsx` 仍会红。

## 8. 逐条对照任务要求

| 要求 | 状态 |
|---|---|
| 新增框架入口 `addOverlayIndicator(chart, spec, expectName)`（先 remove→create(true)→断言非空→抛错；doc 引用 P7 根因） | ✅ |
| 整改 KlineChart.tsx MA 裸调用（false → 入口） | ✅ |
| 整改 GridCell.tsx:86 附近裸调用（false → 入口） | ✅ |
| P0.1-A 红测试全部转绿 | ⚠️ **11/12 转绿**；余 1（C1）为 tester 文件、按 supervisor 裁决归 tester（§7.1）；另 7 文件因桩缺 `getIndicators` 归 tester（§7.3） |
| `npx vitest run` / `npx tsc -b` / `./scripts/check-tangle.sh` | ✅ tsc=0、tangle=0；全量 542 passed / 75 failed（失败全部归因 tester 侧，§6） |
| 行为不变（MA 仍显示） | ✅ §6.2（临时自证，已删） |
| 禁 git add/commit/stash；不跑 tangle；不重启线上；不 PUT 线上 | ✅ 全部遵守 |
| 不扩大范围（不改多周期 / dcap 口径 / ABI / 引擎） | ✅ |

**未做（明确边界）**：多周期功能（P1+）、dcap 口径、ABI/引擎、线上重启与写请求、`04-implementation-plan.md` 0.3（1w barSpace 实测）——均不在本轮。

VERDICT: GREEN（带观察项）
