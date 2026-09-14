# 274 — P3-D-1 红测试执行报告（Red 证据：忠实桩下 G1 / 跨周期 / T8bis 的右端差必红）

- **本文件路径**：`tester/test/274_p3d1_faithful_stub_red_execution.md`
- 角色：Tester（执行 + 取证；**未分析失败、未改任何产品代码**）
- 执行时间：2026-09-14 23:22–23:24（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD `ec32767d330b0dec4d31e0c8a138a00a32988865`
  （P3 实现在工作树未提交；本轮**未** `git add/commit/stash`）
- 设计报告：`tester/design/274_p3d1_faithful_stub_red_design.md`
- 证据目录：`tester/evidence/274_p3d1_faithful_stub/`
  （`red_focused.txt`、`full_suite.txt`、`tsc.txt`、`p3_sync_harness.json`、`p3_sync_harness.png`）

---

## 1. 命令与结果

| 命令（cwd = `web/`） | 结果文件 | 退出码 | 摘要 |
|---|---|---|---|
| `npx vitest run src/features/dashboard/chartSyncGroup.test.ts src/features/dashboard/chartSyncStubFidelity.test.ts` | `red_focused.txt` | 1 | **5 failed | 14 passed (19)**；1 file failed |
| `npx vitest run`（全量回归） | `full_suite.txt` | 1 | **5 failed | 694 passed (699)**；76 files（1 failed） |
| `npx tsc -b` | `tsc.txt` | 0 | 类型检查通过（新增测试文件与桩改动能编译） |
| `P3_HARNESS_OUT=…/tester/evidence/274_p3d1_faithful_stub node tester/p3-sync-harness/run.mjs` | `p3_sync_harness.json` / `.png` | 0 | klinecharts 10.0.3；**16 PASS / 0 FAIL**；`pageerrors = none`；**非本地网络请求 = 0** |

**崩溃 / core dump**：无（无进程异常退出、无 core 文件、无 `pageerror`）。

## 2. 失败用例表（同一根因：真身 `scrollToTimestamp` 落点距右缘固定 2 根，右偏移归零无法消除）

| # | 用例 | 断言 | 实测 | 容差 | crash/core |
|---|---|---|---|---|---|
| 1 | `chartSyncGroup.test.ts > G1/T3-1 同周期（1m↔1m）：≥20 轮镜像后**相对偏移 ≤1 根**、无回声（真渲染口径）` | `maxDrift ≤ 1` | **drift 序列 = [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]**，末轮 `base.to=395 sat.to=397` | 1 根 | 无 |
| 2 | `chartSyncGroup.test.ts > T3-2 跨周期 1m↔5m：…右端差 ≤1 根高周期 bar…` | `|b.to-s.to| ≤ 300000ms` | **504255.32ms**（`b.to=1789358795744.68` / `s.to=1789359300000`） | 300000ms | 无 |
| 3 | `chartSyncGroup.test.ts > T3-2 跨周期 1m↔15m：…右端差 ≤1 根高周期 bar…` | `|b.to-s.to| ≤ 900000ms` | **1918032.79ms** | 900000ms | 无 |
| 4 | `chartSyncGroup.test.ts > T3-2 跨周期 1d↔1w：…右端差 ≤1 根高周期 bar…` | `|b.to-s.to| ≤ 604800000ms` | **1133190578.16ms** | 604800000ms | 无 |
| 5 | `chartSyncGroup.test.ts > T8bis 诚实降级…退化 ⇒ barSpace=260…` | `|degradedS.to-degradedB.to| ≤ 3600000ms` | **8609523.81ms**（`barSpace=260` 断言已通过） | 3600000ms | 无 |

失败用例仅 1 个文件（`web/src/features/dashboard/chartSyncGroup.test.ts`）；**无其它测试文件受影响**（全量 76 文件仅此 1 个失败）。

## 3. 通过且**构成仪器**的用例（绿）

| 文件 | 用例 | 结果 |
|---|---|---|
| `chartSyncStubFidelity.test.ts` | F1 右偏移 64→0 但落点仍 +2 根 | PASS |
| | F2 同构双实例 `scrollToDataIndex` 右缘索引**精确相等** | PASS |
| | F3 跟随者落点索引差 `=== 2`、右端 ts 差 `=== 120000ms` | PASS |
| | F4 标定补偿 2 根后相对偏移 `0 ≤ 1`（判据可满足） | PASS |
| | F5 桩可见根数 `floor(520/8)=65`（真身 62，已标注残余差异） | PASS |
| `chartSyncGroup.test.ts` | T3-2 反向（名义比 7 必超容差）、T3-3（抑制双向）、T3-4（护栏）、T4-1、T4-2、边界 ×4 | PASS |
| `multiPeriodSyncBadge.test.tsx` | T8bis-④/⑤ 页面角标（2 例） | PASS（未受影响） |
| `p3-sync-harness`（真身） | F1–F6 + **F7（新增）** | 16 PASS / 0 FAIL |

## 4. 真渲染同一环境复现（F7，需另起页面的库事实仪器）

`tester/evidence/274_p3d1_faithful_stub/p3_sync_harness.json` → `steps.F7_scroll_to_timestamp_gap`：

```
offsetBefore = 64 ; offsetAfterZero = 0
scrollToDataIndex(300): a=[241,302]  b=[241,302]   (sameIndexScrollRangeEqual = true, 62 根可见)
scrollToTimestamp(a.toTs): b=[243,304]             edgeGapIndexBars = 2
edgeGapTsMs = 120000                               gapUnremovableByZeroRightOffset = true
```

⇒ 与 P3-C PROBE 数值一致 ⇒ 「jsdom 忠实桩下的红」= 真身手感的同一量，**不是桩内构造**。

性质：`file://` + 本地 UMD + 合成数据 ⇒ **0 网络请求**；未触碰线上端口，未重启 PID 3112540；**0 写请求**。

## 5. 合规声明

- 只改测试与测试基建：`web/src/test/syncChartStub.ts`（忠实化）、
  `web/src/features/dashboard/chartSyncGroup.test.ts`（加强/拆分）、
  `web/src/features/dashboard/chartSyncStubFidelity.test.ts`（新增）、
  `web/tester/p3-sync-harness/{harness.html,run.mjs}`（+F7 检查）。**未改** `chartSyncGroup.ts` 等产品代码。
- **未** `git add/commit/stash`；索引区为空（`git diff --cached --name-only` 无输出）。
- **未**在仓库内跑 tangle；**未**重启线上；**0 写请求**；临时实例用临时端口/`file://` 并已收尾（无残留进程）。
- 未对失败做任何分析、定位或修复（按 Tester 角色约束，仅观测与上报）。
