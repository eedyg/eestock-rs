# 287 — 跨图同步「当前配置下静默失效」修复：**红测试执行报告**（先红基线）

> **本报告位置**：`tester/test/287_sync_coverage_red.md`
> 角色：Tester（**只执行与观察**；未修改任何实现文件 / 设计文档 / 既有测试；未 git add/commit；未发 `/api` 请求）
> 被测红测试：`web/src/features/dashboard/syncCoverage.test.ts`
> 设计报告（契约钉死处）：`tester/design/287_sync_coverage_red_design.md`
> 证据目录：`tester/evidence/287_sync_red/`（见 §6）
> 运行环境：`eestock-rs@8828d4621d9536687a380462f567590d5fc3ea3b`（`master`）· node v22.22.2 · vitest 3.2.7 · jsdom

---

## 0. 任务与口径（父级裁决，本轮未变更）

- 目标：为「跨图同步在当前配置下静默失效」的修复建立**先红**可执行规格（**不改实现**）。
- 口径：**A** 守门统一（同周期 ∪ 实测表 ∪ 同锚点合成）；**B** 构造函数不抛错、不可同步卫星被排除且可观测；
  **C** 禁止静默（排列表 + 原因可从 `SyncStats` 读出；页面必须有可见角标 / 整组未建立可见状态）；
  **D** 被排除卫星完全不被写入。**硬约束不回退**：基准永不作为 follower、重入抑制、有界闭环、诚实降级。
- 缺陷真因（父级已核实）：`isSyncCombinationAllowed` 只认实测表 ⇒ `5m↔1h` 抛错 ⇒
  `chartSyncContext.ts` 只 `console.warn` ⇒ 整组不建立 ⇒ 同步全失效且页面无提示。
  真实 console 原文见 `tester/evidence/286_vol_acceptance/A6_zero_write.txt:31`。

---

## 1. 执行命令与结果（退出码）

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| A1 | `cd web && ./node_modules/.bin/vitest run src/features/dashboard/syncCoverage.test.ts` | **红**：`1 failed file`、`13 failed | 4 passed (17)` | `1` |
| A2 | `cd web && ./node_modules/.bin/vitest run` | `1 failed file | 85 passed (86)`、`13 failed | 793 passed (806)` | `1` |
| A3 | `cd web && ./node_modules/.bin/vitest run --exclude '**/syncCoverage.test.ts'` | **全绿基线**：`85 passed (85)`、`789 passed (789)` | `0` |

**红原因分类（门禁 A1 判定）**：13 例**全部为断言失败**（`AssertionError`）——
**无**「模块不存在」、**无**语法错误、**无**收集（collect）错误、**无**超时等待型失败。
其中「构造函数抛错」这类运行时异常**已被夹具显式捕获后转为断言失败**
（`buildGroup()` → `expect(error).toBeNull()`），故红原因分类不依赖异常形态。

---

## 2. 用例级状态（17 例：13 红 + 4 绿侧防护）

### 2.1 红（13）

| # | 用例（文件内 `it` 名） | 失败断言（截断） | 红原因 | 崩溃/core |
|---|---|---|---|---|
| U1 | `U1 合成可用即放行：isSyncCombinationAllowed(5m,15m)/(5m,1h)/(15m,1h) === true` | `同锚点合成 D(1m→15m)/D(1m→5m) ≈ 2.596 可用 ⇒ 必须放行: expected false to be true` | 断言失败 | 无 |
| U1-2 | `U1-2 契约（A）：composeDensity 可直接调用…` | `expected 'undefined' to be 'function'`（模块内私有，未导出） | 断言失败 | 无 |
| U3-2 | `U3-2（补充）构造期排除原因码可读且优先级固定` | `构造函数不得抛错 … expected Error: 多周期同步组合不可用：基准 5m ↔ 卫星 1m … to be null` | 断言失败 | 无 |
| U4 | `U4 构造不抛错：base=5m + [1h,1d] … 排除列表含 1d、不含 1h；原因可读` | 同上（`基准 5m ↔ 卫星 1h`） | 断言失败 | 无 |
| U5 | `U5 无可同步跟随者：base=5m + 仅卫星 1d …` | 同上（`基准 5m ↔ 卫星 1d`） | 断言失败 | 无 |
| U5-2 | `U5-2（补充）基准缺失：无 isBase 成员 … groupReason === "missing-base"` | `无基准 ⇒ 不得建立组: expected undefined to be false` | 断言失败 | 无 |
| U6 | `U6 被排除成员零写入…` | 构造抛错（前置断言） | 断言失败 | 无 |
| U7 | `U7 密度来源可观测：base=5m + 卫星 1h … 合成密度（≈8.04）` | 构造抛错（前置断言） | 断言失败 | 无 |
| U7-2 | `U7-2 来源可区分（static vs composed）…` | `表内组合的密度读数必须可读: expected undefined to be defined` | 断言失败 | 无 |
| U9 | `U9 base=5m + [1h,1d] ⇒ onStats 必须广播…且先于任何交互` | `组（重）建后必须至少广播一次统计快照: expected undefined to be defined` | 断言失败 | 无 |
| U9-2 | `U9-2 base=5m + 仅卫星 1d ⇒ onStats 必须上报「整组未建立」原因` | `组未建立同样必须广播（不得只 console.warn）: expected undefined to be defined` | 断言失败 | 无 |
| U10 | `U10 base=5m + [1h,1d]：被排除卫星（1d）必须有可见角标…` | `口径 C：被排除的卫星必须渲染可见角标（[data-mp-sync-excluded="<period>"]）: expected null not to be null` | 断言失败 | 无 |
| U10-2 | `U10-2 base=5m + 仅卫星 1d：整组未建立也必须有页面可见状态` | `口径 C：「整组未建立」必须有页面可见状态（[data-mp-sync-group-unestablished]）: expected null not to be null` | 断言失败 | 无 |

### 2.2 绿侧防护（4；**不得回退**，用于锁既有硬约束）

| # | 用例 | 为什么现在必须绿 |
|---|---|---|
| U2 | `无公共锚点仍拒绝：(5m,1d)/(15m,1d)/(1m,1d)/(1h,1d)` | 修复**不得**把「真无重叠」也放开 |
| U3 | `既有护栏不回退：卫星<基准 / 含 1mo / 1w 需基准≥1d / 同周期 / 表内组合` | 合成口径不得冲垮既有护栏 |
| U8 | `基准永不作为 follower：卫星做 leader ⇒ 基准逐字段不变` | ADR-020 硬约束不回退（含 `echoEvents===0`、`suppressed>0`） |
| U10-H | `页面级夹具自检：1m+5m/15m ⇒ 两卫星都被写入` | 证明 L3 页面级夹具链路成立（否则 U10/U10-2 的「不存在」不可信） |

---

## 3. 崩溃 / core dump

- **无**崩溃、**无** core dump 文件、**无** unhandled rejection / unhandled exception 逃逸到测试外
  （A1 证据 stdout/stderr 仅含产品代码的 `console.warn` 原文，即缺陷自身的告警）。
- 退出码：A1/A2 = `1`（预期红）；A3 = `0`（基线全绿）。

---

## 4. 全量基线与既有 flaky 标注

| 口径 | Test Files | Tests |
|---|---|---|
| 全量基线（**排除**新文件，A3） | `85 passed (85)` | `789 passed (789)` |
| 全量（**含**新文件，A2） | `1 failed | 85 passed (86)` | `13 failed | 793 passed (806)` |
| 差额 | +1（= 新文件） | +17（= 新用例 13+4） |

- **唯一失败文件 = 新增的 `syncCoverage.test.ts`** ⇒ 既有测试**未被破坏**（无回归）。
- 既有**间歇 flaky** `StrategyEditorPage.test.tsx:60`（并行负载竞态，与本改动无关）**本轮未命中**（A2/A3 全绿；
  若后续命中请按既有 flaky 标注，**不得判为回归**）。
- 说明：`chartSyncDensity.test.ts` / `chartSyncGroup.test.ts` / `chartSyncAlignClosedLoop.test.ts` /
  `chartSyncStubFidelity.test.ts` / `multiPeriodSyncBadge.test.tsx` 本轮**全部绿**且**一字未改**。

---

## 5. ⚠️ 既有测试冲突（**阻塞实现阶段，父级须裁决**）

`web/src/features/dashboard/chartSyncGroup.test.ts:316-324`（T3-4）断言 `1m↔1w` **构造即抛错**
（`expect(...).toThrow(/1m|1w|不可用|退化|reject|unsupported/i)`）；而修复口径 **B** 要求构造函数**不抛错**
（改排除 + 可观测）。`1m↔1w` 修复后仍是「不可同步组合」（`1w` 需基准 ≥ `1d`）⇒ 该既有断言**必然转红**，
两者在 `1m↔1w` 这一输入上**不可同时成立**。

- 本轮禁令：不得改既有测试 ⇒ **未改**（原文证据 `tester/evidence/287_sync_red/A4_existing_T3-4_conflict.txt`）；
- 本文件按父级裁决 B 钉死「不抛错」；实现阶段需父级在以下二者中择一授权：
  ① 改写 T3-4 为「不得抛错 + 该卫星被排除 + 整组未建立可观测」；
  ② 改口径为「仅当**全部**卫星均不可同步时才抛错」（则需复核 U3-2/U5/U10-2）。

---

## 6. 证据清单（`tester/evidence/287_sync_red/`）

| 文件 | 内容 |
|---|---|
| `00_INDEX.txt` | 索引 + 环境（HEAD / node / vitest / 测试文件 sha256） |
| `A0_env.txt` | HEAD、分支、node/vitest 版本、时间、`syncCoverage.test.ts` sha256（`319b16eb55cc…`） |
| `A1_syncCoverage_RED.txt` | 新用例单独运行全文：`13 failed | 4 passed (17)`（红原因逐条可核） |
| `A2_full_suite_WITH_new_file.txt` | 全量（含新文件）全文：`1 failed file | 13 failed | 793 passed` |
| `A3_full_suite_baseline_excl_new_file.txt` | 全量基线（排除新文件）全文：`85 files / 789 tests` 全绿 |
| `A4_existing_T3-4_conflict.txt` | 既有 T3-4「必须抛错」断言原文 + 现有只认实测表的守门实现行 |
| `A5_workspace_untouched.txt` | 已暂存 14 个 VOL 文件未被本工作改动；本工作新增（未跟踪）文件列表 |

---

## 7. 观察记录（**只陈述事实，不做失败分析、不给修复建议**）

1. 卫星在 `ChartSyncGroup.start()` 后被订阅（`__listenerCount()===3`：`onScroll/onZoom/onVisibleRangeChange`）。
2. 挂载期卫星自身 init 会先触发一次对齐并打开 16ms 抑制窗（`suppressUntil`）；紧随其后的手势进入
   `handleEvent` 的 `suppressUntil` 分支被吞（`suppressed++`，**不广播**）。本报告夹具因此在页面级用例的
   手势前 `settle()` 40ms（L1 组级用例 `start()` 后首手势 `suppressUntil===0`，无需等待）。
3. 缺陷形态的可执行证据：`5m + [1h,1d]` 在 `chartSyncContext.register()` 内构造抛错 ⇒
   `onStats` 在**任何交互之前**均无快照（U9/U9-2 实测 `snapshots.length === 0`）。
4. 本次**未**修改任何实现文件、设计文档、既有测试；**未**执行 git 写操作；**未**发任何 `/api` 请求；
   **未**构建/部署。
5. 本轮**未执行**项（已在设计报告 §6.3 标注）：M3–M8 沙箱变异执行、真渲染（Playwright）像素级取证、
   `DashboardPage` 全页形态验证（本轮以 `MultiPeriodChartStack` 直接渲染 + U10-H 自检替代）。
