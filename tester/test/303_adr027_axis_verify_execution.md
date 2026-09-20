# 执行报告：ADR-027/028 时间轴对齐复验（tester 车道，2026-09-20）

- **本文件位置**：`tester/test/303_adr027_axis_verify_execution.md`
- **主报告（判词/证据）**：`tester/evidence/20260920_adr027_axis_verify/report.md`
- **被测产物**：`web/dist` = `assets/index-Bv7MKg8J.js`（sha256 `dec86283e2169402aaa54a9ff8b958601c92e3eb5a2d7be90287a648b4ed8733`），由 8081 后端静态提供
- **目标 run**：`sr_1789832517800_000006`（518880 / M5 / 1949 根）
- **纪律**：单车道（不 spawn）；一律 `timeout` 前缀（curl 加 `--max-time`）；playwright 只跑指定规格；vitest 单文件 `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`；每步记 `free -h`；跑完核 `pgrep`

## 1. 执行矩阵（全部为真渲染 / 真容器）

| 步骤 | 命令 | 结果 | 原始日志 |
|---|---|---|---|
| ① 探针 v2（修复后产物，2 用例） | `timeout 900 env E2E_BASE_URL=http://localhost:8081 ADR027_ALIGN_OUT=…/raw npx playwright test e2e/adr028-axis-align-probe.e2e.ts --reporter=list --retries=0` | **2 passed（43.4s）** | `raw/logs/06_probe_fixed_build_green_after_restore.txt` |
| ② 类型检查 | `timeout 600 npx tsc -b --force` | **exit 0** | `raw/logs/02_tsc_b_fixed.txt` |
| ③ 冻结规格（断言未放松） | `timeout 900 … npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list --retries=0` | **6 passed（23.1s）** | `raw/logs/03_window_sync_frozen_fixed.txt` |
| ④ 单测子集（逐文件） | `timeout 600 env NODE_OPTIONS=--max-old-space-size=2048 npx vitest run <file> --maxWorkers=1` | **6 文件 / 67 tests 全绿** | `raw/logs/04_vitest_subset_fixed.txt` |
| ⑤ 变异 M1（曲线映射改回 ts 线性）→ 构建 → 探针 | `npm run build` + 探针 P1 | **探针变红**（期望行为） | `raw/mutations/m1_ts_linear/` |
| ⑥ M1 还原 → 构建 | `cp` 还原 + `npm run build` | 源码 sha256 与 bundle sha256 **逐字节一致** | `raw/logs/07_restored_hashes.txt` |
| ⑦ 变异 M2（撤销「回到全区间」重取）→ 构建 → 探针 | `npm run build` + 探针 P1 | **探针变红**（期望行为） | `raw/mutations/m2_no_full_refetch/` |
| ⑧ M2 还原 → 构建 → 探针复跑 | 同上 | **2 passed（43.4s）**（恢复后重新转绿） | `raw/logs/06_probe_fixed_build_green_after_restore.txt` |
| ⑨ 进程卫生 | `pgrep -af "[v]ite preview"` / `pgrep -c chromium` / `ps \| grep headless_shell` | 无 `vite preview`；无 chromium/headless_shell 残留 | — |

单测子集明细（逐文件、`--maxWorkers=1`）：
`workbench/chartUtils.test.ts` 17 ✓ ｜ `workbench/resultWindow.test.ts` 33 ✓ ｜
`workbench/resultAxisIndex.test.tsx` 4 ✓ ｜ `workbench/useRunSeries.test.ts` 6 ✓ ｜
`dashboard/KlineChartVisibleRange.test.tsx` 5 ✓ ｜ `workbench/resultBarSpaceLimit.test.tsx` 2 ✓
（合计 **67 passed / 0 failed / 0 skipped**）

## 2. 结果摘要（tester 主口径 = 同一根 bar 配对）

| 态 | 配对点 | max\|Δraw\| | max\|Δ984\| | 判据 |
|---|---|---|---|---|
| 初始 | 103 | 0.03 | 0.05 | ✓ |
| 跟随最新 | 613 | 0.03 | 0.05 | ✓ |
| 左滚若干根（194 根） | 614 | 0.03 | 0.05 | ✓ |
| 全览 | 614 | 0.03 | 0.05 | ✓ |
| 120 根跳转 | 123 | 0.03 | 0.05 | ✓ |
| 300 根（滚轮） | 317 | 0.51 | 0.98 | ✓ |
| （补充）无缺口对照 | 36 | 0.58 | 0.86 | ✓ |

跟随性 / 原子性 / 披露：**七态全绿**；变异 M1、M2 均**变红**；恢复后逐字节一致。

## 3. 失败用例

无（本波所有执行均通过；两次「红」为**故意注入的变异反证**，非被测产物缺陷）。

## 4. 崩溃 / core dump

无。无 chromium 残留进程（`pgrep -c chromium` = 0；`ps` 仅匹配到自身命令行）。

## 5. 覆盖率

- E2E：探针 2 用例覆盖六态 + 1 补充态 + 降级链 2 档；冻结规格 6 用例。
- 单测：上述 6 文件 67 tests。
- 未做：D1 / 其它标的 / 多周期栈内同类图。

## 6. 修正说明（探针口径，非产品代码）

`web/e2e/adr028-axis-align-probe.e2e.ts` 由 v1 升 v2：主口径改为**同一根 bar 配对**，v1 的 ts 线性反解口径
保留为诊断字段并显式标注「仅适用于修复前口径」；判据阈值不变（≤2px）。设计说明见
`tester/design/303_adr027_axis_verify_probe_v2.md`。**未修改任何生产代码**（变异注入为临时、已逐字节还原）。
