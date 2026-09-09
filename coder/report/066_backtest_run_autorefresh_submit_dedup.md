# 066 — 回测前端两项观测修复（2a 深测）：run 完成自动刷新 + 提交 in-flight 去重

本报告文件位置：`eestock-rs/coder/report/066_backtest_run_autorefresh_submit_dedup.md`

## 问题解决 / 功能实现

深测 2a 在回测前端确认两项观测缺陷：

1. **① run 完成后任务列表状态不自动刷新**：`TaskList` 依赖 REST `/api/backtest/runs` 快照 + WS
   `backtest_progress`（只有 `pct/currentTs`）。run 由 `running` → `done/failed` 后，页内行文案不自动
   翻「完成」，需手动 reload 才可见。修复由 WS 完成信号驱动该 run 的**详情重捞**，把该行翻为终态并
   「结果可点」，无需整页 reload，其它 run 保持不变（非全列表轮询）。
2. **③ 提交重复点击可发 2 POST**：`store.submit` 无 in-flight 去重，dblclick 会发 2 次
   `POST /api/backtest/runs`。提交按钮虽已禁用（`StrategyForm` `disabled={submitting}`），但 store 层
   仍防御性去重：提交进行中再次提交被忽略，成功/失败后清除标志。

## What changed（文件 + 行数）

| 文件 | 变更 | 行 |
|------|------|----|
| `web/src/features/backtest/store.ts` | ① `onProgress` 检测 `pct>=100` → 新增私有 `refreshRunInList(id)`（`GET /api/backtest/runs/{id}` 合并回 `runs` 列表）；② `submit` 顶部加 `if (this.current.submitting) return;` 进 in-flight 去重 | +22 / -3 |
| `web/src/features/backtest/store.test.ts` | 新增 2 用例：WS 到 100 重捞/未到 100 不重捞；提交中重复 submit 仅 1 次 POST | +40 |
| `web/src/features/backtest/BacktestPage.test.tsx` | 新增 1 集成用例：WS 到 100 → 行状态翻「完成」且 location 不变（不 reload） | +30 |

合计：92 插入、3 删除，范围严格限定在 `web/src/features/backtest/*`。

## Architecture alignment（分层归属）

- `store.ts`（应用状态层，`BacktestStore`）：WS 订阅回调整合点是状态机，`onProgress` 本就持有
  `api.getRun` 能力并拥有 `runs` 列表，故完成信号触发的局部刷新放在 store（而非组件）。新增
  `refreshRunInList` 为私有内部方法（仅 `onProgress` 调用），符合既有 onProgress 私有化风格。
- `TaskList.tsx` 不改：它是纯展示组件，仅消费 `runs`/`progressMap` props；完成信号驱动的刷新逻辑
  属 store 数据流，组件读到新 `runs` 后自动重渲染为「完成」+「查看」，无层级偏移。
- `submit` 去重：属 store 状态机防御逻辑，`BacktestPage.onSubmit` / `StrategyForm` / `BacktestGrid`
  均不改（按钮已禁用，store 兜底为最后一层防线），未触碰后端/DB/SQL/Rust。

## Implementation approach（批准架构内的决策）

- ① 完成信号：WS 帧契约 `{type, run_id, pct, bar_ts}` 无 `status` 字段，故以 `pct >= 100` 作为完成
  触发条件（与任务要求「progress 到 100%（或 done）」一致）。
- ① 局部刷新：`refreshRunInList` 只 `map` 替换目标 id 行，其余行原样保留；对已终态（`done/failed`）
  行为短路不重捞（避免对已完成 run 的无效 GET）；`getRun` 失败则吞掉并保留快照行（下次信号/手动重试兜底）。
  用 `GET /runs/{id}`（非全列表重拉）实现「非全列表轮询、其它 run 不变」。
- ② 去重：`submit` 顶部 `if (this.current.submitting) return;` —— `submit` 首行同步 `patch(submitting:true)`，
  后续并发调用读到的 `submitting` 已为真即被忽略；`finally` 清除标志，成功/失败均复位。

## Test coverage（TDD Red → Green）

- Red：先写用例跑出 `expected 'running' to be 'done'` 与 `submitRun called 2 times`（确认失败）。
- Green：实现后全部通过。
- 新增用例：
  - `store.test.ts`「WS progress 未到 100 仅推进度不重捞；到 100 重捞单 run 合并回 runs（行状态翻 done、不改其它行）」：
    断言 `pct=80` 不触发 `getRun`（非轮询）、`pct=100` 触发 `getRun(12)` 且行状态翻 `done`，并保持
    run 11/13/14 状态不变。
  - `store.test.ts`「submit 进行中再次 submit → 仅 1 次 POST（in-flight 去重，防御 dblclick）」：
    用 pending promise 挂起首次 `submitRun`，期间再 `submit`，断言 `submitRun` 仅 1 次、`submitting` 仍真，
    release 后 `submitting=false` 且仍只有 1 次调用。
  - `BacktestPage.test.tsx`「TaskList 自动刷新：WS progress 到 100 → 行状态翻「完成」且不重载（location 不变）」：
    用 location probe（现有 `LocationProbe`）断言整页不 reload（`location-path` 仍 `/`）、行文案由「运行中」翻「完成」。

## Verification（如何确认）

- `cd web && npx vitest run`（`web` = `eestock-rs/web`）：37 files / 327 tests 全绿（基线 324，新增 3 用例）。
- `VITE_API_MOCK=0 npx tsc -b && vite build`：TSC 通过，`vite build` 成功（121 modules，`built in 1.06s`）。
- 已确认不改变既有 `TaskList`/`BacktestPage`/结果/删除逻辑：全套 `src/features/backtest` 及其它页面测试均绿。

## Residual risks（残留风险）

- WS 帧不含 `status` 字段，完成判据仅基于 `pct>=100`。对「失败但未到 100%」的 run（如中途中断），
  WS 不会触发自动翻「失败」；真实前端口径下失败 run 通常以下一次进度/手动刷新兜底。若后续后端
  帧增加 `status` 字段，可在 `onProgress` 一并纳入判据（frontend-only，无需本改动扩展）。
- `refreshRunInList` 依赖 `GET /api/backtest/runs/{id}` 返回的 run DTO 含最新终态；若后端对「已完成
  但结果未回填」的 run 瞬时返回旧状态，会出现一次刷新仍为运行中的短暂窗口（由后续信号收敛）。
- e2e `backtest-form-task.e2e.ts -g "F2|F4"` 未运行：容器 `:8081` 服务的是预构建 bundle，不反映本次
  源码改动；且其写真实 DB（真库写用例），属可选验证，改以 vitest 单元+集成覆盖。

## 暂存文件清单

按父 AC `noStagedFiles:true`，本次**未暂存、未提交**（`git diff --cached` 为空）。变更文件为：
`web/src/features/backtest/store.ts`、`web/src/features/backtest/store.test.ts`、
`web/src/features/backtest/BacktestPage.test.tsx`（均在 `eestock-rs` 嵌套 git 仓库的工作树中）。
