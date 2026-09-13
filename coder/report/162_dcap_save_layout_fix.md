# 报告 162 — 「保存 dcap 配置不得重置 pane 布局」修复（阶段 2 · 按诊断结论做最小实现）

- **本文件位置（self-location）**：`coder/report/162_dcap_save_layout_fix.md`
- **阶段 1 输入（诊断 + 红测试）**：`tester/test/051_dcap_save_layout_reset_diagnosis_execution.md`（**VERDICT: DIAGNOSED**）、`tester/design/016_dcap_save_layout_red_test_design.md`、证据 `tester/evidence/051/`
- **权威口径**：`design/14-dcap-indicator/02-spec.md` §6（图表契约，本次增补一条）、`03-test-plan.md` T8/T10
- **证据目录**：`coder/evidence/162_dcap_save_layout_fix/`（真渲染探针 fixed-run 29/29 + **pre-fix 对照 run 24/29** + 截图 + vitest/tsc/tangle/e2e 日志）
- **仓库根 / 基线**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `d74bfb8`（**未提交**；按派单要求**未 `git add`/`git commit`/`git stash`**）
- **纪律**：线上 8081/8082（PID 2102695）**全程未动**（无 kill/restart/改配置；探针只发 GET，PUT 一律浏览器侧本地兑现，全程 `nonGetOther=[]`）；临时资源已收尾（18092/18093 已释放、无残留 chromium）

**末行 VERDICT: GREEN（带 2 项观察）**

---

## 1. 改动文件清单（8 个 tracked 文件，+318 / −28）

| 文件 | 行数 | 层 | 内容 |
|---|---|---|---|
| `web/src/features/dashboard/KlineChart.tsx` | +100/−12 | 组件接线层（web/dashboard） | `syncIndicators` 改为**状态差分**；`AppliedIndicators` 基线（随建图重置）；warmup 热更新 effect；init 铺满加 `manualAdjusted` 守卫 |
| `web/src/features/dashboard/feed.ts` | +48/−3 | 数据流层（web/dashboard） | `warmupBars` 由 `readonly` 改为可变 + 新增 `setWarmupBars(warmup): Promise<boolean>`（向前补取差额，不重建 feed） |
| `web/src/features/dashboard/DashboardPage.tsx` | +8/−2 | 页面接线层 | `warmupBars` **移出 feed 身份（useMemo deps）**；`KlineChart` 传 `warmupBars={dcapWarmup}` |
| `web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx` | 551 行（**未跟踪**：阶段 1 新建，本车道扩展 +5 用例） | 测试 | 阶段 1 红测试转绿并保留；**新增 5 条防回归**（MA windows / MA 勾选 / DCAP 关态边界 / warmup 不 remount / 内置模板空 calcParams 守卫） |
| `web/src/features/dashboard/dcapWarmupP3.test.ts` | +78 | 测试 | `setWarmupBars` 4 条（差额补取前插 / 减小不取数 / 空 bars 不取数 / 失败不抛） |
| `web/src/features/dashboard/dcapWiringP3.test.tsx` | +49/−13 | 测试 | T10 家族改**端态口径**（窗口=viewport+warmup，差额补取）；新增「保存 n_l 不重建 feed（`setDataLoader` 仅一次）」集成用例；桩补 `overrideIndicator/resetData` |
| `web/src/features/dashboard/KlineChart.test.tsx` | +9/−4 | 测试 | MA churn 断言 → override 语义；桩补 `overrideIndicator/resetData` |
| `web/src/features/dashboard/DashboardPage.test.tsx` | +14/−3 | 测试 | MA 保存断言 → override 语义（不再期望 createIndicator 新参）；桩补两个 API |
| `design/14-dcap-indicator/02-spec.md` | §6 +2 行散文 | 契约文档 | 增补「配置保存不得重建 pane」+「取数 warmup 热更新口径」（**未触碰任何 `file=` 代码块**） |

> 新增未跟踪证据：`coder/evidence/162_dcap_save_layout_fix/`（探针 + 结果 + 截图 + 日志）。

## 2. 问题（用户需求）

修改 dcap 配置并**保存**后，K 线主图与各指标副图之间**用户拖拽过的高度被重置**（阶段 1 实测：VOL 237px → 100px，主图 460 → 597）。用户需求：**保存 dcap 配置不得重置当前布局**。

## 3. 实现方案（两条路径都修，均按诊断证据）

### 3.1 路径 A — `syncIndicators` 状态差分（参数变化走 `overrideIndicator`）

- 新增组件级「已应用状态」`appliedRef: Map<name, calcParams>`，**在建图 effect 内重建**（`appliedRef.current = new Map()`）；不跨建图复用，也不用模块级 `WeakMap`（会污染共享测试桩）与 `chart.getIndicators`（既有桩无此 API）。
- 逐步语义（每个 `INDICATOR_DEFS` 项）：
  - `enabled === false` 且曾应用过 → `removeIndicator({name})` + 删表项；未曾应用 → **什么都不做**（关态不产生空 pane）；
  - `enabled === true` 且未应用过 → 原 create 分支（MA → `paneId:'candle_pane', isStack=false`；DCAP → `ensureDcapIndicatorRegistered()` + `isStack=true` 独立副图；其余内置 → `isStack=true`）；
  - 已应用且 `calcParams` 变化 → **`chart.overrideIndicator({name, calcParams})`**（原地重算，不销毁 pane）；
  - 无变化 → 无操作（幂等 ⇒ 乐观更新 + 服务端回显两次 commit 天然安全）；**不依赖 `overrideIndicator` 返回值**（库事实：仅 calc 变化时返回 `false`）。
- **修复过程中由真渲染证据发现并修掉一个自引入回归**：内置模板指标（VOL/MACD/KDJ/BOLL）目标参数为空时**必须省略 `calcParams` 字段**，传 `[]` 会把模板默认参数覆盖为空（实测 VOL `calcParams` 变 `[]`）。故新增 `createIndicatorValue()`：空参数 → 仅 `{name}`。已补守卫单测 + 真渲染断言（`A. 内置 VOL 未被空 calcParams 覆盖`）。

### 3.2 路径 B — 断开 `warmup → feed 身份`

- `DashboardPage`：`feed` 的 useMemo **移除 `dcapWarmup` 依赖**（保留 `viewportBars` 等）⇒ 保存 `n_l`/`m`（或开/关 DCAP）不再重建 feed ⇒ `KlineChart` 不 remount ⇒ 整图 pane 不被重建。
- `KlineDataFeed.setWarmupBars(warmup)`：**不重建 feed**；warmup 增大时以「最左已加载 bar 的 ts」为排他游标**按差额补取**更早的 bar（前插、去重），使加载窗口回到 `viewportBars + warmup`（与「以新 warmup 重新构造 feed」端态等价）；warmup 减小/不变/尚无数据/已够宽 → 只更新字段不取数（ADR-020：关 DCAP 不多取）；取数失败不抛（保持既有数据）。
- `KlineChart`（新可选 prop `warmupBars`，看板传 `dcapWarmup`）：effect 调 `feed.setWarmupBars(warmupBars)`，仅当**真的补取了更早 bar** 时 `chart.resetData()` **原地**重载数据（只重跑 DataLoader init：不 `dispose`/不 `init` ⇒ pane id/高度/顺序/视口保持，阶段 1 `probe4` 已证）。未实现 `setWarmupBars` 的 feed（区间 ScopedKlineFeed/工作台）自动跳过，行为不变。
- 顺带守卫：DataLoader init 的 `fitBarSpace` 在 `manualAdjusted` 时跳过 ⇒ 原地重载不会把用户手动视口重置回配置视口（ADR-020 §2.6；这条只影响重载路径，建图路径行为不变——建图时 `manualAdjusted` 刚被重置为 `false`）。

### 3.3 架构对齐

- 全部改动落在既有层内：**数据流层**（`feed.ts`：取数窗口/bookkeeping）、**组件接线层**（`KlineChart`：klinecharts 生命周期与差分）、**页面接线层**（`DashboardPage`：配置 → props 装配）。
- **接口变更（需 parent 知悉）**：仅两处**加性**接口：`KlineChartFeedLike.setWarmupBars?`（可选方法）与 `KlineChartProps.warmupBars?`（可选数字 prop）。均为 web 前端组件/模块面（非 ABI/引擎/ExecutionPolicy/api-config），无新依赖，无跨层反向依赖。
- 未改：ABI/引擎/ExecutionPolicy/api-config、`dcap.ts` 生成物、`design/14-dcap-indicator` 的 `file=` 块。

## 4. 测试覆盖

- **阶段 1 红测试转绿并保留**：`KlineChartDcapSaveLayout.test.tsx` T-1（pane 高度 ±1px + pane id 不变 + 保存期间无 remove/create + DCAP 线值按新参数逐位重算）。
- **新增防回归（同文件）**：
  - MA `windows` 变化 → `overrideIndicator`、MA 仍在 `candle_pane`、无 remove/create、高度 ±1px；
  - MA 勾选开/关仍走 create/remove，主图 pane 不销毁，重开带当前窗口；
  - DCAP 关态改参数 → 不误建 DCAP pane、无 churn；
  - **warmup 变化不得整图重建**：`init` 不增（`charts.length===1`）、`setWarmupBars(新 warmup)`、`resetData` 被调用、无 create/remove、高度 ±1px；
  - **内置模板指标不得携带空 `calcParams`**（真渲染发现的回归守卫）。
- **feed 层**：`setWarmupBars` 差额补取/前插/游标、减小不取数、空 bars 只更新字段（供初始取数）、失败不抛。
- **页面集成**：`dcapWiringP3.test.tsx` 新增「保存 `n_l`（warmup 62→122）⇒ 不重建 feed（`setDataLoader` 仅一次）+ 只补差额 60」；T10 两个 warmup 用例改为**端态口径**（窗口 = `viewport_bars + (n_l+m−1)`，冷启动一次取满 / 热更新差额补取），语义未削弱（见 §6 观察 1）。
- **真渲染（临时构建 + 临时端口）**：`coder/evidence/162_dcap_save_layout_fix/probe.mjs`，**fixed-run 29/29 通过**；同探针在 **HEAD 原实现**上 **24/29**（5 条红=缺陷本身）。

## 5. 验证（命令与输出）

| 命令 | 结果 |
|---|---|
| `cd web && npx vitest run` | ✅ exit=0 · **57 files / 574 tests passed**（基线 57/564 ⇒ 净增 10 条，无破坏、无 skip）`evidence/vitest.log` |
| `cd web && npx tsc -b` | ✅ exit=0（无输出）`evidence/tsc.log` |
| `./scripts/check-tangle.sh` | ✅ exit=0「design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）」`evidence/tangle.log` |
| `E2E_BASE_URL=http://127.0.0.1:18092 npx playwright test e2e/dashboard-pane-separator.e2e.ts e2e/dashboard.e2e.ts`（**临时端口**，build 来自本车道源码） | ✅ 2 passed `evidence/e2e.log` |
| 真渲染探针（`BASE=http://127.0.0.1:18092 node probe.mjs`） | ✅ **29/29**；pre-fix 对照（HEAD 源码构建、18093）**24/29** `evidence/probe-*.json`、`base-prefix-run/` |

**红 → 绿的量化证据（真渲染，同一探针）**

| 判据 | pre-fix（HEAD） | fixed |
|---|---|---|
| A 拖高 VOL 后保存 dcap 参数：分隔线位移 | **+128px（569→697）✗** | 0px ✓ |
| C 拖高 VOL+DCAP 后保存参数：两条分隔线位移 | **[101, 81] px ✗** | [0, 0] px ✓ |
| C pane id 集合 / 渲染高度 | 全部更换、回默认 100 ✗ | 逐值不变 ✓ |
| B 保存 `m`（warmup 变化） | **整图 `init` 2→3（remount）✗** | `init` 不变 ✓ |
| `/api/kline` 请求序列 | `120, 188, 190, 120, 190`（每次参数变化整窗重取） | `120, +68(before 游标), +2`（只补差额） |
| 保存后 DCAP 仍独立副图 / `precision=5` / `figures=[s,m,l,zero]` | — | 不变 ✓ |
| DCAP 线值按新参数重算（s/m/l 采样变化、zero 恒 0） | — | ✓ |
| 勾选开/关（BOLL/MACD/DCAP）分隔线 1↔2 可逆、无空 pane、不 remount | — | ✓ |
| 全程页面错误 / 非 GET 外发 | 0 / 0 | 0 / 0 ✓ |

单测红→绿证据：`evidence/probe-run.log` 同目录；红测试原始失败（阶段 1）`tester/evidence/051/red-test-run.txt`，修复后 `vitest.log` 全绿。

## 6. 未达标项 / 观察项（诚实标注）

1. **T10 的措辞口径**（`03-test-plan.md` T10：「DCAP 开启时请求 `limit = viewport_bars + (n_l+m−1)`」）：修复后**冷启动**仍是一次取满；但**运行中开 DCAP/保存参数**改为「差额补取」（`limit = 目标窗口 − 已加载根数`）。**端态不变**（加载窗口仍 = `viewport_bars + warmup`，视口最左一根仍有 dcap 值），但改的是**请求模式**。已在 `02-spec.md` §6 加「热更新口径」散文说明；**未改 `03-test-plan.md`**（本次派单的文档范围只到 §6，作为观察项上报，建议后续 doc-first 同步一行）。
2. **`setWarmupBars` 与用户深翻并发的边角**：若保存瞬间正有 `loadBefore` 在飞（`loadingBefore`），本次差额补取会被跳过（warmup 字段仍更新）⇒ 该次保存后最左 warmup 段可能短暂断线，向左翻页即自然补齐。未做重试/排队（避免为边角引入并发状态机）。
3. **klinecharts `overrideIndicator` 返回值恒 `false`**（库事实）：本实现不依赖返回值（已在注释与 §6 契约写明），但**外部读者**若以返回值判成败会误判——已在文档标注。
4. 未跑需要**写后端**的 e2e（如 `dashboard-periods-ma.e2e.ts` T5 会 `PUT /api/config/ma`）——派单禁止改用户配置，故只跑只读 e2e。
5. 覆盖率工具未启用 ⇒ 无覆盖率数字（沿既有口径）。

## 7. 交付状态

- 8 个 tracked 文件 + 1 个未跟踪测试文件（`KlineChartDcapSaveLayout.test.tsx`，阶段 1 由 tester 新建、本车道扩展）+ 证据目录已就位；**未 stage、未 commit**（严格遵守派单「禁 git add/commit/stash」）⇒ parent 复核：`git diff`（tracked）+ `cat web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`。
- 临时构建/预览（`/tmp/fix162/{dist,dist-base}`、18092/18093）已停，端口已释放；`git status` 中除本次改动与 `coder/evidence/162_*`、`coder/report/162_*` 外无新增。
