# 报告 163 — 「切 period / 切 stock 不得重置指标视图布局」修复（阶段 2 · 按诊断结论做最小实现）

- **本文件位置（self-location）**：`coder/report/163_period_stock_switch_layout_fix.md`
- **阶段 1 输入（诊断 + 红测试）**：`tester/test/053_period_stock_switch_layout_diagnosis_execution.md`（**VERDICT: DIAGNOSED**，非 INSUFFICIENT ⇒ 阶段 2 可启动）、`tester/design/017_period_stock_switch_layout_red_test_design.md`、证据 `tester/evidence/053/`
- **权威口径**：`design/14-dcap-indicator/02-spec.md` §6（图表契约，本次增补 1 行散文）、`design/06-web/11-kline-viewport-bars.md`（ADR-020 视口=根数）、`design/06-web/01-dashboard.md`
- **证据目录**：`coder/evidence/163_period_stock_switch_layout_fix/`（真渲染探针 **修复后 27/27** + **修复前对照 19/27** + 只读 e2e 两份 + vitest/tsc/tangle 日志 + README）
- **仓库根 / 基线**：`/home/eestock/workspace/git/eestock/eestock-rs`，`HEAD = ece1d9d`（父提交含上一轮 `7949c0b`「保存 dcap 参数不重建 pane」）
- **纪律**：线上 8081/8082（PID 2102695）**全程未动**（无 kill/无 restart/**无任何 PUT**；探针 `nonGetOther=[]`）；未改线上 `web/dist`；**未 `git add`/`git commit`/`git stash`**（`git diff --cached --name-only` 为空）；未跑 tangle 回写；**未触碰 `design/14-dcap-indicator` 的任何 `file=` 代码块**；未改 `web/src/features/indicators/dcap.ts`（tangle 生成物）；未改 ABI/引擎/ExecutionPolicy；未改 workbench 图表（无需，见 §6.9）；临时端口 18098/18099 已释放、无残留进程

---

## 1. 改动文件清单（tracked：3 源/测试文件 + 1 契约文档；未跟踪：1 测试文件 + 1 证据目录）

| 文件 | 增/删 | 层 | 内容 |
|---|---|---|---|
| `web/src/features/dashboard/KlineChart.tsx` | +54/−26 | 组件接线层（web/dashboard） | 建图 effect **拆为 Effect L（图表生命周期，deps `[]`）+ Effect W（数据接线，deps `[feed]`）**；overlay 先清后建；WS/loader/视口归一归属调整；两处注释同步 |
| `web/src/features/dashboard/KlineChart.test.tsx` | +6/−0 | 测试（**加强**） | R7「feed 重建（周期切换）」用例新增断言：`init` 恰好 1 次、`dispose` 从未调用（切周期不得 remount） |
| `web/src/features/dashboard/DashboardPage.test.tsx` | +5/−0 | 测试（**加强**） | 「周期切换触发新周期数据加载」用例新增断言：`init` 恰好 1 次（主图 chart 实例不重建） |
| `design/14-dcap-indicator/02-spec.md` | +1/−0 | 契约文档（**只改散文**） | §6 表格新增一行「切 period / 切 stock 不得重置 pane 布局」，并写明与「配置保存不得重建 pane」的关系 |
| `web/src/features/dashboard/KlineChartSwitchLayout.test.tsx` | 455 行（**未跟踪**；阶段 1 由 tester 车道新建，本车道**未改动一个字符**） | 测试 | 阶段 1 红测试 → 现已转绿，保留为常驻防回归（2 条切换用例 + 1 条守卫） |
| `coder/evidence/163_period_stock_switch_layout_fix/` | 14 文件 | 证据 | 探针脚本 + 修复后/修复前 JSON/日志 + 只读 e2e 日志 + vitest/tsc/tangle 日志 + README |

> 说明：本轮**未** `git add`（派单明确禁止），故全部改动仍在工作区未暂存；阶段 1 的新增测试文件同样保持未跟踪状态，**请上游在合入时一并纳入**。

## 2. 与阶段 1 诊断结论的逐条对应

| 诊断结论（053） | 本实现如何落地 | 证据 |
|---|---|---|
| §2.1 触发路径 = `KlineChart` 的 `[feed]` 建图 effect 重跑（dispose+init = 整图 remount） | 建图 effect 拆成 **L（`[]`，只 init/dispose）+ W（`[feed]`，只换数据/接线）**；`feed` 变化不再触碰 `init/dispose` | 探针 `inits 1→1`；单测 `charts().length===1`；加强断言 `init` 调用次数 1 |
| §2.2 依赖面 = `state.selected / state.period / viewportBars` 变化 ⇒ feed 身份变化 | **保持** `DashboardPage` 的 `feed` useMemo 不变（仍随这三者新建 feed），改由 `KlineChart` 在同一实例上接管 | `DashboardPage.tsx` **零改动**（`git diff` 无此文件） |
| §3 首选「不 remount」实测可行（同一实例 `setDataLoader+setSymbol+setPeriod+resetData`：pane id/高度逐值不变、数据换新） | 按首选落地；顺序取诊断实测序列：**先 `setDataLoader` 后 `setSymbol`/`setPeriod`**（保证每次内部 init 取数都走新 feed，避免旧 loader 回灌旧数据竞态） | 探针 A/B：`burst = [setDataLoader, setSymbol, setPeriod]`，高度 199/140/357 逐值不变，pane id 不变；数据 `15m→1h`、`518880→161226` 均换新 |
| §3.3 冗余取数（四次隐式 resetData ⇒ 4 次 getBars） | **不再显式 `chart.resetData()`**：`setDataLoader`（必走）/`setSymbol`（对象身份永不等 ⇒ 必走）/`setPeriod` 三次已覆盖；实测 **3 次 getBars 共享同一 feed `loadInitial` 的 loadPromise ⇒ 每切换只发 1 次 HTTP** | 探针：`klineGetsDuring=1`；URL 窗口 `limit=188`（= viewport 120 + warmup 68） |
| §4 备选「remount 后回放 `setPaneOptions`」 | **不采用**（首选已达标）；若未来某路径必须 remount，§6 契约已写明回放要求与残余差异 | — |
| §5 #1 ADR-020：切周期后可见根数仍 ≈ `viewport_bars` | W 内**显式 `manualAdjusted=false`**，保持「切周期回自动视口归一」现状（`onInit → fitBarSpace` 生效） | 探针 A：`data-viewport-fit = {bars:120,space:11,visible:118}`；探针 C：真实 wheel 缩放（`bar 12.1`）后切周期 → 回到 `bar 11 / visible 115` |
| §5 #2 WS：旧订阅摘除、新订阅挂上、followLatest 跟随 | WS 接线随 W 重跑：cleanup `offRt()` 摘旧 feed 回调，新 feed `onRealtime` 挂上；cleanup 同时 `setRt(null)` 清旧实时标记 | 探针 run：`wsFrames` 记录 `unsubscribe bar:518880:15m → subscribe bar:518880:1h`；页面零 console error |
| §5 #3 overlay：`resetData` 不清 overlay，必须显式 remove 再重建 | W 内在装好新数据后 **`chart.removeOverlay()`（能力检测：桩环境无此 API 时跳过）→ 再 `createChartOverlays`**；marker overlay 仍在 `feed.loadInitial()` 后按新 bars 吸附创建，并新增 `cancelled` 代际守卫防旧 feed 迟到回调打点 | 工作台 `ResultView/WorkbenchPage` 用例全绿；契约 §6 已写明该要求 |
| §5 #4 DCAP warmup 取数口径 | W 不改变取数口径；warmup 仍由既有 hot-update effect（`feed.setWarmupBars` + `resetData`）负责，feed 换新时 `setWarmupBars(next===prev)` 短路 ⇒ 无额外取数 | 探针：DCAP 关 `limit=120`；开 → 差额补取 `limit=68`（窗口 188）；切周期请求 `limit=188` |
| §5 #5 另一消费者 `KlineResultChart`（工作台） | 结构同源 ⇒ 自动受益（切 run 不再 remount）；其 overlay（B/S 标记）在 W 里先清后建，故不会残留上一 run 的标记 | `WorkbenchPage.test.tsx` / `ResultView.test.tsx` 全绿 |
| §10 #2 决策点（原地切换是否清 `manualAdjusted`） | **按诊断默认保持现状（清）**：这是 ADR-020「切周期后可见根数 ≈ viewport_bars」的必要条件，派单亦要求不得破坏该口径 ⇒ 未引入新决策 | 探针 C |

## 3. 实现方案（最小实现，不新增依赖/接口）

### 3.1 Effect L —— 图表生命周期（deps `[]`）

`init(ref.current)` → `applyDarkTerminalStyles` → `appliedRef.current = new Map()` → `subscribeAction('onZoom'|'onScroll', manual)`（只依赖 ref，与数据面无关，生命周期内订阅一次即可，避免每次换 feed 重复订阅累积）；cleanup：`dispose(chart)` + `chartRef.current = null` + `setRt(null)`。

### 3.2 Effect W —— 数据接线（deps `[feed]`，语义 = 数据面变化）

1. `manualAdjusted.current = false`（保留 ADR-020「切周期回自动视口归一」）；
2. `chart.setDataLoader({getBars, subscribeBar, unsubscribeBar})`（loader 闭包只捕获当前 `feed`，与修复前同构）；
3. `chart.setSymbol({ticker: props.code, …})`；4. `chart.setPeriod(PERIOD_MAP[props.period])`；
5. **数据重置由引擎在这三步内部的 `store.resetData()` 完成**（`index.esm.js`：`setSymbol` 15083/store 13410、`setPeriod` 15092/13421、`setDataLoader` 15259/13518、`resetData` 13652）：三次 init 取数共用同一 feed `loadInitial()` 的 loadPromise ⇒ **1 次 HTTP**；不额外调用 `chart.resetData()`（只多一次幂等 `_addData('init')` 重绘，且会让未提供该 API 的既有工作台测试桩需要补齐）；
6. overlay：`chart.removeOverlay()`（`typeof` 能力检测，桩环境跳过）→ `createChartOverlays(chart, props.overlays)`；
7. WS：`feed.onRealtime(...)`（`rtCallback` 由 loader 的 `subscribeBar` 提供；`followLatest` 时 `scrollLatest()` + `markRealtime()`）；
8. marker overlay：`feed.loadInitial().then(() => { if (!cancelled && chartRef.current === chart) createMarkerOverlays(...) })`；
9. cleanup：`cancelled = true; offRt(); setRt(null)`。

### 3.3 关键取舍与理由

| 取舍 | 理由 |
|---|---|
| 不 remount，而不是 remount 后回放 `setPaneOptions` | 诊断 §4 已证备选方案固有缺陷（pane id 仍换、闪烁、时序敏感、顺序不还原）；原地切换 pane 高度/pane id/顺序**天然**保持 |
| loader **先于** symbol/period | 三步各自内部 `resetData` 会各发一次 init 取数；loader 在前保证每次取数都用新 feed（否则先触发的取数可能用旧 loader 回灌旧数据，且有乱序覆盖风险） |
| 不额外 `chart.resetData()` | 冗余（见 §2）；实测每切换仅 1 次 HTTP，引擎仅多 2 次幂等 `_addData('init')` 重绘（诊断 §10 #4 的「代际门闩」属性能微优化，本轮不做） |
| `removeOverlay()` 用 `typeof` 能力检测 | 与文件既有风格一致（`ensureTradeRangeOverlayRegistered` 同样检测 `typeof registerOverlay !== 'function'`）；既有 5 个 klinecharts 桩中 2 个工作台桩有该方法、3 个无（但都不传 overlays）⇒ 行为与修复前一致 |
| WS 回调/marker 加 `cancelled` 代际守卫 | 同一实例下旧 feed 的迟到 `loadInitial().then` 不再被 `chartRef.current === chart` 拦住 ⇒ 需要显式代际标记，防「旧 run 标记打在新数据上」 |
| `appliedRef` 不再随 feed 重置 | 指标挂在同一 chart 上 ⇒ 差分基线必须连续；这也是「切周期不重建指标」的直接原因（诊断 §7.1 明确要求） |

### 3.4 架构对齐

- 改动全部落在既有层内：**组件接线层**（`KlineChart`：klinecharts 生命周期 vs 数据接线分离）；**未新增**接口/依赖/跨层反向依赖；**未改动** `KlineChartProps`、`KlineChartFeedLike`、`DashboardPage` 的 props 形状与状态机。
- `KlineChartProps.feed` 的语义由「建图依据 + 数据源」收窄为「数据源（同一实例热切换）」——**这与 7949c0b 已经建立的 warmup 热更新语义一致**（当时已把「参数变化 ⇒ 不换 feed」）；本轮把「数据面变化 ⇒ 不换图」补齐，二者合起来即 02-spec §6 的完整「不得重建 pane」契约。

## 4. 红测试转绿 + 既有测试加强（TDD 记录）

### 4.1 阶段 1 红测试（本车道未改动该文件）

```
修复前（HEAD ece1d9d）：npx vitest run src/features/dashboard/KlineChartSwitchLayout.test.tsx
  Tests  2 failed | 1 passed (3)
  × 【红】切换 period…  AssertionError: 切 period 不得 dispose+init 重建 chart…: expected 2 to be 1
  × 【红】切换 stock …   AssertionError: 切 stock 不得 dispose+init 重建 chart: expected 2 to be 1
  ✓ 【防回归】同一 feed 的 rerender 不得重建 chart

修复后（本提交工作区）：
  Test Files  1 passed (1)      Tests  3 passed (3)
```

### 4.2 既有测试加强（**只加强，未放宽**）

| 用例 | 新增断言 | 加强前（HEAD） | 加强后（本轮） |
|---|---|---|---|
| `KlineChart.test.tsx` › `feed 重建（周期切换）→ 抑制状态重置，resize 重新生效` | 切周期后 `init` 恰好 1 次、`dispose` 从未调用 | 旧实现：**失败**（`init` 2 次、`dispose` 1 次）——已实测（见 §4.3） | 通过 |
| `DashboardPage.test.tsx` › `周期切换触发新周期数据加载` | 切周期后 `init` 恰好 1 次 | 旧实现：**失败**（`expected "spy" to be called 1 times, but got 2 times`）——已实测 | 通过 |

### 4.3 加强断言在旧实现上确实为红（防「假加强」）

为避免「新增断言在旧实现上也绿」的假防护，用 `git checkout HEAD -- src/features/dashboard/KlineChart.tsx`（改后即恢复，md5 已核对一致）把实现临时回退到 HEAD 后重跑：

```
× KlineChart.test.tsx › feed 重建（周期切换）… → init 2 次 / dispose 1 次 → 失败
× DashboardPage.test.tsx › 周期切换触发新周期数据加载 → expected "spy" to be called 1 times, but got 2 times
× KlineChartSwitchLayout.test.tsx ›【红】切 period /【红】切 stock
Test Files  2 failed (2)     Tests  3 failed | 12 passed (15)
```

## 5. 真渲染验收（临时构建 + 临时端口 + 真实 klinecharts + 线上只读数据）

- 形态：临时构建（root = 仓库 `web/`，alias `klinecharts` → 透传 spy，产物 `/tmp/fix2/dist`）+ `vite preview` `127.0.0.1:18098`；`/api`、`/ws` 代理到线上只读 8081；浏览器侧拦截非 GET（PUT `/api/config/*` 本地兑现、其余 abort）。
- **同一探针**跑「修复前构建」（`/tmp/fix2/dist-old`，HEAD 版 `KlineChart.tsx`，端口 18099）与「修复后构建」：

| 判据 | 修复前（对照） | 修复后 |
|---|---|---|
| 探针总判据 | **19 / 27 passed** | **27 / 27 passed** |
| 切 period（拖高后）VOL / DCAP / MA 渲染高度 | 199→**100** / 140→**100** / 357→**496** | 199→**199** / 140→**140** / 357→**357** |
| 切 period pane id | 全换（新时间戳） | **完全一致** |
| 切 period `__ACC__.inits` | 1→**2** | **1→1** |
| 切 period burst | `setDataLoader/setSymbol/setPeriod/createIndicator×3` | `setDataLoader/setSymbol/setPeriod`（无 create/remove） |
| 切 stock pane id / `inits` | 全换 / 3→**4** | 完全一致 / **1→1** |
| 数据确实重置 | ✓（1h 首根 `07-30T06:00Z`；161226 close 8.943→1.913） | ✓（同上） |
| 每次切换 `/api/kline` GET 次数 | 1 | 1（窗口 `limit=188` = viewport 120 + warmup 68） |
| 真实 wheel 手动缩放后切 period | 回 fit（visible≈118） | 回 fit（visible≈118，ADR-020 不变） |
| DCAP 关→开 pane 数 / `inits` / precision / zero figure | 3→2→3 / 不 remount / 5 / 有 | 3→2→3 / 不 remount / 5 / 有 |
| 非 GET 请求 / 页面异常 | 0 / 0 | 0 / 0 |

原始产出：`coder/evidence/163_period_stock_switch_layout_fix/probe_fix.json`、`probe_fix-run.log`（27/27）、`probe_fix-prefix-control-run.log`（19/27）。

## 6. 回归要点自查（逐条，对照派单「不得破坏」清单）

| # | 不得破坏项 | 结论 | 证据 |
|---|---|---|---|
| 1 | ADR-020：切周期后可见根数仍 ≈ `viewport_bars` | ✅ | 探针 A：`data-viewport-fit {bars:120,space:11,visible:118}`；`init` 回调 `fitBarSpace` 仍生效（W 内 `manualAdjusted=false`） |
| 2 | ADR-020：手动缩放后不重算（ResizeObserver `enabled`） | ✅ | `KlineChart.test.tsx` R7 三例全绿；`manualAdjusted` 只在用户动作/W 内改写，语义未变 |
| 3 | ADR-020：真实 wheel 手动缩放后切周期「回 fit」 | ✅ | 探针 C：`bar 12.1 → 11`（可见 105→115）与修复前一致 |
| 4 | WS 实时追加 + followLatest 锁定最右 | ✅（含 1 项既有环境性观察，见 §8 #3） | WS 帧证据 `unsubscribe 518880:15m → subscribe 518880:1h`；`followLatest` effect 未改；`KlineChart` R7「回到最新」用例绿 |
| 5 | overlay 创建/清理 | ✅ | W 内先 `removeOverlay()` 后重建；工作台 `ResultView/WorkbenchPage` 全绿；同日 e2e `dashboard-pane-separator`（真实渲染 + 分隔线/无残留线）1 passed |
| 6 | DCAP warmup 取数（开 = viewport+n_l+m−1；关 = viewport） | ✅ | 探针：关 `limit=120`；开 → 补取 `limit=68`（窗口 188）；`dcapWiringP3.test.tsx` T10 家族全绿 |
| 7 | 上一轮「保存参数不重建 pane」 | ✅ | `KlineChartDcapSaveLayout.test.tsx` / `dcapWiringP3.test.tsx` 全绿；W 与 warmup hot-update effect 互不干扰（feed 不变时 W 不重跑） |
| 8 | DCAP 独立副图 / precision 5 / 0 参考线 / 数据不足断线 | ✅ | 探针：`paneId != candle_pane`、`precision:5`、`figKeys ['s','m','l','zero']`、result 首 65 根 null 后出线（`n_l=66` 口径由既有 T1~T13 锁定） |
| 9 | workbench 图表（`KlineResultChart`） | ✅（未改其代码） | 结构同源自动受益：切 run 不再 remount，overlay 先清后建；`WorkbenchPage.test.tsx`/`ResultView.test.tsx` 全绿 |
| 10 | 宫格 `GridCell`（独立 chart 实现） | ✅ 不受影响 | `GridCell.tsx` 自己 `init`，未使用 `KlineChart`；其用例全绿 |
| 11 | 一键回归 | ✅ | `cd web && npx vitest run` → **58 files / 577 tests 全绿**（修复前基线 577 中 2 红） |

## 7. 契约同步（doc-first，只改散文）

- `design/14-dcap-indicator/02-spec.md` **§6 表格新增 1 行**：「**切 period / 切 stock 不得重置 pane 布局**（2026-09-14 补，同一「不得重建 pane」契约的数据面触发面）」——内容含：① 数据重置允许、pane 布局不得重置；② 必须同一实例原地切换（`setDataLoader` 先于 `setSymbol`/`setPeriod`，三次取数共用一个 loadPromise ⇒ 1 次 HTTP）；③ 若某路径确需 remount ⇒ 必须按「指标名 → pane」回放 `setPaneOptions` 并写明残余差异；④ 与 ADR-020 的关系（`manualAdjusted` 复位 ⇒ 仍回 fit）；⑤ overlay 必须显式 `removeOverlay()`；⑥ **与「配置保存不得重建 pane」的关系**：同一条契约的两个触发面——配置保存只改指标参数（连数据都不换），切周期/切标的改数据面（必须换数据、允许重取数），但同样禁止 `dispose`+`init`。附库依据行号与常驻防回归测试清单。
- `./scripts/check-tangle.sh` → **exit 0**（沙箱重新生成 + 逐字节比对通过）；`git diff` 该文件仅 **+1 行**，`file=` 代码块**零触碰**（`git diff … | grep -c file=` → 0）。

## 8. 测试与门禁输出

| 门禁 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 单元/组件 | `cd web && npx vitest run` | **58 files / 577 tests 全绿**（含阶段 1 的 3 条红测试转绿 + 2 处加强断言） | `evidence/vitest-full.log` |
| 类型 | `cd web && npx tsc -b` | exit 0，无输出 | `evidence/tsc-b.log`（0 字节） |
| 文学式一致性 | `./scripts/check-tangle.sh` | exit 0 | `evidence/check-tangle.log` |
| 真渲染探针（修复后） | `node /tmp/fix2/probe_fix.mjs` | **27/27 passed** | `evidence/probe_fix-run.log` / `probe_fix.json` |
| 真渲染探针（修复前对照） | 同上，HEAD 版构建 @18099 | 19/27 passed | `evidence/probe_fix-prefix-control-run.log` |
| 只读 e2e（修复后构建，临时端口） | `E2E_BASE_URL=http://127.0.0.1:18098 npx playwright test e2e/dashboard-pane-separator.e2e.ts` | **1 passed** | `evidence/e2e-fixedbuild-pane-separator.log` |
| e2e 子集（修复后构建） | `… npx playwright test e2e/kline-matrix.e2e.ts -g "D9\|D10\|G16\|G18" --retries=0` | 3 failed / 1 passed | `evidence/e2e-fixedbuild-kline-matrix-subset.log` |
| e2e 子集（**线上 8081 旧构建对照**） | `E2E_BASE_URL=http://127.0.0.1:8081 …` 同一 4 项 | **3 failed / 1 passed（完全相同的用例与断言消息）** | `evidence/e2e-oldbuild-8081-kline-matrix-subset-control.log` |
| e2e 全量矩阵（修复后构建，含 retries=1） | `… npx playwright test e2e/kline-matrix.e2e.ts` | 18 passed / 4 failed（= 上表 4 项，D10 为 retry 抖动） | 运行输出见报告正文 §8.1 |

### 8.1 e2e 的取舍与「非本轮引入」的判定

- 仓库 e2e 的默认 `baseURL` 是**线上 8081**，且套件内含**写用例**（`dashboard-periods-ma` 会 PUT `/api/config/ma`、`dashboard-favorites`/`alerts-settings-deep/simlive-deep` 会写库）⇒ **未跑全量**（派单禁止对线上做任何 PUT，且线上服务的是旧构建，跑它也无法验收本轮改动）。
- 因此只在**临时构建 + 临时端口 + 只读代理**上跑「明确只读」的用例（`dashboard-pane-separator.e2e.ts` 自带「拦截并 abort 任何非 GET + 末尾断言 0 条」安全网）。
- `kline-matrix` 子集 4 项失败（D9 分时、G16/G18 WS 实时、D10）**与本次改动无关**：同一 4 项在**线上旧构建**上以**同样的断言消息**失败（diff 两份日志仅耗时一行不同），属既有/环境性（分时当日数据与 WS 注入）失败；本轮改动路径（切周期/切标的/DCAP 开关/视口）在这些 spec 的其他 18 项上全绿。

## 9. 未达标 / 残余风险 / 观察项（如实登记）

1. **「旧数据窗口」语义变化（有意接受，非缺陷）**：同一实例的 `resetData` 是异步的（替换发生在 `getBars` 回调里）⇒ 切换瞬间屏上仍是**旧标的/旧周期的 bars 约 100~150ms**（诊断 §3.2 实测），随后原子替换；修复前 remount 路径表现为「短暂空白 → 新数据」。二者都无「半新半旧」脏态，但观感不同（用户可能看到一次「旧图一闪」）。诊断已认定为可接受。
2. **视口偏移不再被重建为默认**：remount 会把 `offsetRightDistance` 等重置到新图默认（诊断 §2.3）。现在这些值跨切换保持；ADR-020 要求的「可见根数 ≈ viewport_bars」已由 `manualAdjusted` 复位 + fit 覆盖（探针 A/C 实测 118/115，与修复前同），但**非 fit 场景下的滚动偏移会延续**（未观测到用户可见差异，登记为结构性残余差异）。
3. **WS 实时路径无活体证据**：探针期线上无推送 tick（`framereceived=0`，与阶段 1 相同）⇒ WS 只有「订阅帧 + 代码 + 单测」证据；e2e 的 WS 注入用例（G16/G18）在**新旧构建上都失败**，故无法用其反证 WS 已回归。**建议**：盘中有实时行情时人工/自动化复核一次「切周期后实时 bar 仍追加到正确序列、followLatest 锁最右」（口径与阶段 1 相同）。
4. **引擎仍会 3 次 `_addData('init')`**：3 次 getBars（`setDataLoader`/`setSymbol`/`setPeriod`）共享同一 loadPromise ⇒ HTTP 只 1 次，但引擎侧有 2 次幂等重绘。若要严格 1 次，需要「只响应最后一次 getBars」的代际门闩（诊断 §10 #4 的【建议】项，本轮判为性能微优化，未做）。
5. **`viewportBars` 变化仍会换 feed 身份**（改「默认K线根数」配置 / focus 重读）：现在**不再 remount**（布局不再被重置，已随本轮一并修好），但 feed 仍随该配置重建（诊断 §10 #5 建议单独登记「把 viewportBars 改为 feed 可变属性」）——**本轮范围外，未做**。
6. **StrictMode（dev）双调用**：`main.tsx` 使用 `StrictMode`，dev 下 effect 会 mount→cleanup→mount；L/W 拆分后行为与拆分前一致（都是 init→dispose→init），生产构建不受影响。未观察到问题。
7. **workbench 同 feed 内 overlays 变化**：W 依赖 `[feed]`，故同一 feed 下 `overlays` 变化不会重建 overlay——**与修复前行为完全一致**（旧实现的建图 effect 同样只依赖 `[feed]`），非本轮引入；本轮只保证「换 feed（切 run）时先清旧再建新」。

## 10. 明确不做（与派单一致）

- 未动线上 8081/8082（无 kill / 无 restart / **无 PUT**）；未改线上 `web/dist`；未用 deploy 脚本。
- 未改 ABI / 引擎 / ExecutionPolicy；未改 `web/src/features/indicators/dcap.ts`（tangle 生成物）；未改 `design/14-dcap-indicator` 的任何 `file=` 代码块。
- 未改 workbench 图表代码（诊断证明无需）；未改 `DashboardPage.tsx`、`feed.ts`、`GridCell.tsx`、`TimeshareChart.tsx`。
- 未 `git add` / `git commit` / `git stash`（工作区改动与新增文件一律保持未暂存，交上游合入）。
- 未引入新依赖、框架或库；未新增生产者事件/接口形状（仅拆分既有 effect 与内部接线）。

---

**末行 VERDICT: GREEN（带观察项）**

（观察项 = §9 的 5 条登记：旧数据 <150ms 窗口语义变化、视口偏移不再重建、WS 活体证据缺、引擎 3 次幂等 `_addData`、`viewportBars` 仍属 feed 身份；另有既有环境性 e2e 失败 D9/G16/G18/D10，已用旧构建对照证明与本轮无关。）
