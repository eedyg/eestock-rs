# 278 — P5-E-1 红测试执行报告：**持久化载荷恒合法（`onHeightsChange.heights ∈ [80,1200]`）**

- **本文件路径**：`tester/test/278_p5e1_payload_domain_red_execution.md`
- 角色：Tester（执行 + 取证；**未改任何产品代码**、未跑 tangle、未触碰线上、0 写请求、未起临时实例）
- 时间：2026-09-15 01:01–01:03（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`；**commit = `78eb68d95d149e091c678a5a2a97aecd872f895f`**（HEAD）
- 设计报告：`tester/design/278_p5e1_payload_domain_red_design.md`
- 证据目录：`tester/evidence/277_p5e1_red/`
- 被测对象：`web/src/features/dashboard/MultiPeriodChartStack.tsx` + `multiPeriodLayout.ts`（P5 工作树未提交实现）
- 本轮新增用例的落点：`web/src/features/dashboard/multiPeriodLayoutDom.test.tsx`（**唯一被 Tester 触碰的文件**；
  `sha256 = 09a79cabb046e50f91c7f93d1e694cfedb1f985c4d89cd6895b5d5459d51eb9f`）

---

## 1. 测试运行清单

| # | 命令 | 结果 | 证据文件 |
|---|---|---|---|
| 1 | `cd web && npx vitest run src/features/dashboard/multiPeriodLayoutDom.test.tsx`（**编辑前基线**） | **13 passed / 0 failed** | 本次会话终端输出（未归档；见 §2 说明） |
| 2 | `cd web && npx vitest run src/features/dashboard/multiPeriodLayoutDom.test.tsx`（**新增 B14/B15 后**） | **13 passed / 2 failed / 0 skipped（15）** | `tester/evidence/277_p5e1_red/layout_dom_b14_b15_red.txt`（exit=1） |
| 3 | `cd web && npx vitest run multiPeriodHeightsPageContract.test.tsx multiPeriodDragDomainClamp.test.ts multiPeriodLayout.test.ts` | **28 passed / 0 failed**（3 文件；C1–C9、D1–D4、A1–A15 全绿） | `tester/evidence/277_p5e1_red/related_suites_after_edit.txt`（exit=0） |
| 4 | `cd web && npx tsc -b` | **exit 0（无类型错误）** | §4 |
| 5 | 进程/实例卫生核对（staged 文件、改动面、tangle 进程、实例） | **无 staged 文件；仅 1 个测试文件被改；无 tangle 进程；未启实例** | `tester/evidence/277_p5e1_red/process_hygiene.txt` |

**汇总**：目标套件 `multiPeriodLayoutDom.test.tsx` = 15 tests / **13 passed / 2 failed** / 0 skipped；
**失败全部且仅为本轮新增的 B14、B15**；既有 13 例（B1–B13）无一回归。
**无崩溃、无 core dump**（vitest 正常退出，exit=1 = 断言失败，非异常终止）。

## 2. 红测试前置基线（诚实标注）

编辑前对同一套件跑过一次基线（01:01:29）：`Test Files 1 passed (1) / Tests 13 passed (13)`——
该输出未落盘归档（会话内观察）。替代性论证：编辑后同一次运行中 **既有 13 例仍全绿**（§3 表），
证明本轮改动**只新增**用例、未触碰既有断言（B8 仅加注释，断言逐字节不变）。

## 3. 失败用例表（红证据）

| 用例 | 断言（Given/When） | 错误信息（摘） | 崩溃/core |
|---|---|---|---|
| **B14** 超宽屏（可用 1800px）⇒ 基准吸收余量使渲染分配 1261 > 1200：载荷必须还是 clamp(分配) 且各项 ∈ [80,1200] | G: 真 `MultiPeriodChartStack`，4 pane（基准 420 + 3×180 卫星），`availableHeight = 1800`；W: 对 `15m\|1h` 拖 `+1px` 并推进 `DRAG_DEBOUNCE_MS` | `AssertionError: 15m 载荷必须 ≤ 1200（超宽屏基准吸收余量 ⇒ 回流的是分配值），收到 1261；口径要求 payload == clamp(DOM 1261, 80, 1200) = 1200`（`multiPeriodLayoutDom.test.tsx:635`） | 无 / 无 |
| **B15** 1400px 容器 + 两颗 80px 卫星 ⇒ 基准分得 1240 > 1200：载荷 == clamp(分配)，Σ 分配仍 == 1400 | G: 真 `MultiPeriodChartStack`，3 pane（基准 420 + 卫星 `1h`/`5m` 各 80，Σ请求 580 ≤ 1400 ⇒ `fit`），`availableHeight = 1400`；W: 对 `15m\|1h` 拖 `+1px` 并推进防抖窗 | `AssertionError: 15m 载荷必须 ≤ 1200，收到 1240；口径要求 payload == clamp(DOM 1240, 80, 1200) = 1200`（`multiPeriodLayoutDom.test.tsx:692`） | 无 / 无 |

观察到的**事实**（不作失败分析）：
- 两例的失败点在**载荷上界**断言（`payload[15m] > HEIGHT_MAX`）；失败消息内联打印了 `DOM` 分配值与
  `clamp(DOM)` 值（1261→1200 / 1240→1200），即口径等式 `payload == clamp(DOM)` 亦不成立；
- 两例的**前置断言**（DOM 分配 `> HEIGHT_MAX`）与**渲染侧不变量**断言（`Σ DOM == 可用高度`）**已通过**
  —— 即失败发生时，渲染侧 `Σ == 可用` 未被破坏。
- 未执行任何失败分析、未进入失败分支、未修改产品代码。

## 4. 类型与静态面

`npx tsc -b`（web/）⇒ **exit 0，无输出**。`stackTree(opts)` 的新增可选参数（`availableHeight`/`panes`）
对既有 12 处调用**向后兼容**。

## 5. 覆盖率

未生成覆盖率报告（本轮为红测试取证，非覆盖率门禁）；口径覆盖目标见设计报告 §6
（载荷域：键集合 + `[80,1200]` + 整数 + `== clamp(DOM)`，在「分配越域」夹具上逐项断言）。

## 6. 硬约束遵守情况

| 约束 | 状态 | 证据 |
|---|---|---|
| 禁 `git add` / `commit` / `stash` | ✅ 未执行任何 git 写命令 | `process_hygiene.txt`（`git diff --cached --name-only` 为空） |
| 禁在仓库内跑 tangle | ✅ 未运行（`entangled.toml` mtime 仍 `2026-09-03T23:39:40`，sha `3c1751c1…`；无匹配进程） | `process_hygiene.txt` |
| 不重启线上（PID 3112540） | ✅ 未发出任何针对线上实例的命令 | `process_hygiene.txt` |
| 0 写请求 | ✅ 全部本地 `vitest + jsdom`；`saveMultiPeriodConfig`/`onHeightsChange` 均为 `vi.fn` 桩 | 设计报告 §4 |
| 临时实例用临时端口并收尾全拆 | ✅ **未启动任何临时实例**（无需拆） | `process_hygiene.txt` |
| 清理进程用不自匹配写法 | ✅ 无进程需清理；核对命令用 `printf 'tan%s' gle` 组装模式避免自匹配 | `process_hygiene.txt` |
| 既有测试只允许加强 | ✅ 既有 13 例断言未改；B8 **仅新增注释**（口径注记），断言逐字节不变；`stackTree` 仅加可选参数 | §3 + §2 |
| 不实现产品代码 | ✅ 产品文件 0 编辑（`multiPeriodLayout.ts` / `MultiPeriodChartStack.tsx` / `DashboardPage.tsx` 本轮未被 Tester 触碰） | `process_hygiene.txt` |
| 输出末行打印 VERDICT | ✅ 见最终回复末行 | — |

## 7. 残余风险 / 交接提示（观察性，非修法）

- 两例在写入载荷的**唯一出口**（`onHeightsChange`）上钉死域；若实现选择在**页面侧**夹取
  （`DashboardPage` 的 PUT body 前），**本组用例仍会红**（组件级载荷未夹）——即实现落点需覆盖组件侧载荷。
- 既有 B7 断言「载荷之和 == 可用高度」在 600px 夹具下依然成立（域内 ⇒ `clamp` 恒等）；
  若实现把载荷夹取**同时**用在域内场景以外的路径上，需自行确认 `Σ` 断言的适用边界（本报告不预判）。
