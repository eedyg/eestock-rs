# 127 · 技术债收尾包：e2e 残留清理（MINOR-1）+ NIT-1/2/3

- 报告位置：`eestock-rs/coder/report/127_tech_debt_wrapup_minor1_nit123.md`
- 范围：4 项 reviewer findings（用户指令「解决所有技术债」，含此前知情延期项）；已 `git add`，未 commit

---

## MINOR-1：e2e 残留 backtest_runs / 旧 /api/backtest 引用清理（必修）

### 判定依据
- 迁移 `0024_drop_legacy_backtest_tables.sql` 已 `DROP TABLE IF EXISTS backtest_results, backtest_runs`。
- 后端 `/api/backtest/*` 已随 P4b 删除（`crates/` 全仓 grep 仅余 `backtest/src/types.rs` 一条历史注释）；前端旧回测页已物理删除（`App.tsx:26` `/backtest` 301 重定向至 `/backtest-workbench`）。
- 三个 backtest-*.e2e.ts **整个文件**均 `page.goto('/backtest')` 且全部断言围绕已删 `POST/GET/DELETE /api/backtest/runs` → 按任务规则整文件删除：
  - `web/e2e/backtest-form-task.e2e.ts`（810 行，删）
  - `web/e2e/backtest-compare-gridrank.e2e.ts`（924 行，删）
  - `web/e2e/backtest-result-trade-modal.e2e.ts`（806 行，删；grep 全目录排查出的额外残留，同属旧页）
- `web/e2e/simlive-deep.e2e.ts` 主体仍测现存 sim-live 功能（`sim_run_backtest_compare` MCP 工具与 `POST /api/sim-live/sessions/{id}/backtest-compare` REST 均存活，P4a 起走统一 ensemble 引擎）→ 仅修清理段：
  - `sqlDeleteBacktestRuns(ids: number[])`（:276-280）→ `sqlDeleteStrategyRuns(ids: string[])`：`DELETE FROM strategy_run WHERE id IN (...)`（`strategy_run_result` 由 0023 FK `ON DELETE CASCADE` 级联；id 为 `sr_` 前缀字符串，经既有 `q()` 引号助手转义）。
  - `btRunIds: number[]` → `string[]`；A8/B7 三处 `as number`/`as number[]` 断言改为 `as string`/`as string[]`（`BacktestCompareView.run_ids: Vec<String>` 现口径）。
  - 文件头清理口径注释 + afterAll 第 3 步注释同步更新。
  - 保留头注中一句「旧 backtest_runs 已由迁移 0024 DROP」作为事实注记（非可执行引用）。
- 全目录复 grep：清理后 `web/e2e` 内 `backtest_runs|backtest_results|/api/backtest` 仅剩 simlive-deep 头注事实注记一条。

### 延期登记同步（改为已完成注记）
- `design/99-decisions-log.md` TD-3「遗留」条 → 「遗留（已结案 2026-09-10 收尾包）」注记。
- `coder/report/125_tech_debt_backend_td1_td3.md` 遗留风险第 1 条 → 「已结案」注记。
- 说明：逐字含「前端车道后续清理项」的延期登记实际仅这两处（grep 全仓确认）；其余报告（121/123/124/126、tester/024/026）无该登记，未动。

## NIT-1：99-decisions-log.md:188 括注订正
- 原：「先子后父虽无外键依赖残留但保持依赖序」（与事实不符——FK 存在过）。
- 改：「先子后父：子表 `backtest_results.run_id` 存 FK 约束 `backtest_results_run_id_fkey` 引用父表 `backtest_runs(id)`（0011 建表，`ON DELETE CASCADE`），先 DROP 子表再 DROP 父表顺序正确且必要」。

## NIT-2：workbench store TD-4 catch 分支调度复核（TDD）
- **Red**：`web/src/features/workbench/store.test.ts` 新增 2 测试，先跑确认失败（`expected 4 times, but got 1` / `expected 2 times, but got 1`）：
  1. `TD-4：GET 复核异常 → 仍调度一次短延迟复核，复核到 succeeded 翻终态（不卡 running@100%）`
  2. `TD-4：GET 持续异常时最多复核 3 次后停手（catch 复核仍受 REFRESH_MAX_RETRIES 上限约束）`
- **Green**：`web/src/features/workbench/store.ts` `refreshRunInList` catch 分支由「仅保留当前行」改为「保留当前行 + `attempt < REFRESH_MAX_RETRIES` 时 `scheduleRefreshRetry(id, attempt+1)`」（复用既有去重定时器/disposed 守卫，无新抽象）。
- 结果：`store.test.ts` 16/16 通过；全量 `npm test` 45 文件 442 测试 0 失败（较上轮 440 +2）。

## NIT-3：mock.ts:211 initialAlertEvents 种子注释
- `web/src/api/mock.ts` `initialAlertEvents` 头注补：「种子时间为绝对日期（2026-09-07），依赖测试侧 FIXED_NOW 注入钉住时钟（TD-5 口径）——新增依赖真实时钟的 alerts 测试须同样注入 `now`」。

## 架构对齐
- 全部改动属 web 前端车道（e2e 用例 / store 内部行为 / mock 注释）+ 文档事实源（decisions-log/既有报告注记）；未触任何接口、事件契约、层边界、迁移或后端代码。
- AGENTS.md 约定的 gitnexus_impact / detect_changes 工具在本环境不可用（未挂载 MCP），以全仓 grep + 全量构建/测试/clippy 替代验证影响面。

## 验证证据
| 命令 | 结果 |
|---|---|
| `cargo build --workspace` | 0 error（Finished dev profile） |
| `cargo test --workspace --no-fail-fast` | **570 passed / 0 failed** |
| `cargo clippy --workspace --all-targets` | **0 warning / 0 error** |
| `entangled tangle` | Nothing to be done（无 diff） |
| `cd web && npm run build` | 0 error（chunk >500kB 为既有提示） |
| `cd web && npm test` | **45 files / 442 passed / 0 failed** |
| `npx playwright test --list` | 137 tests in 22 files 可列出；simlive-deep 17 用在列；`backtest-*` 0 引用（语法检查认可口径，未真跑 e2e） |

## 残余风险
- 三个被删 e2e 文件的执行/设计台账（`web/tester/test/017*`、`web/tester/design/014*`、`design/10-test-coverage/web-interaction-matrix.md:51` 回测⑤行）仍提及这些文件，属历史记录/设计矩阵，未在本任务范围内改动；如需可由文档车道另行结案。
- simlive-deep.e2e.ts 的 A8/B7 compare 断言按 P4a 现口径（ensemble run、sr_ 字符串 id）改写，未在真实容器复跑（验收口径允许只列清单）。
