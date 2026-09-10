# 140 — api_workbench 并行 flake 根治（测试隔离债）

报告位置：`coder/report/140_api_workbench_parallel_isolation_fix.md`（本文件）

## 404 根因（证据链）

**机制：同测试二进制内两用例 symbol 撞码 → 一方 `clean()` 误删另一方 `strategy_run` 行 → GET run 404。**

取证过程（非猜测）：
1. 通读 `crates/web/tests/api_workbench.rs` 全部 6 用例 + `wait_terminal` + 装配：每用例各自 `spawn(state(pool))` 独立 app，但**共享同一个 dev 库**（:5433），隔离仅靠 symbol code / 名称前缀。
2. 发现 `submit_archived_version_audit_rerun_201`（L356）与 `cancel_run_semantics`（L392）均使用
   `code = format!("85{}", std::process::id() % 10000)`。同一测试二进制进程内 pid 相同 → **两用例 symbol code 完全相同**。
3. `clean()` 含 `DELETE FROM strategy_run WHERE symbol = $1` —— 任一用例开场/收尾清理都会删掉另一用例正在轮询/断言的 run 行。库内无其它删 `strategy_run` 的路径（无 DELETE 端点；全仓库 grep 确认仅 `clean()` 按 symbol 删行）。
4. 复现取证：修复前并行连跑 12 次，**9 次 FAILED**（失败率 75%），失败用例在 cancel/audit 间漂移，与 tester 035 报告一致。抓取的 panic 现场：
   - `cancel_run_semantics` L436：`succeeded 取消应 409  left: 404  right: 409` —— run 已 `succeeded` 后行被对侧 `clean()` 删除，cancel 端点查无此行返回 404；
   - `wait_terminal` 内 `assert_eq!(r.status(), 200)` 拿到 404 —— 轮询期间行被删。
5. 交叉二进制撞码排查：其它测试文件（api_strategies 等）均未使用 8x 码段，也无按 symbol 删 `strategy_run` 的逻辑 → 碰撞仅限本二进制内。

## 修复方案选择理由

**选隔离，不选互斥**（遵循任务「优先隔离而非互斥」指示）：
- 候选 A（采用）：给 `cancel_run_semantics` 换用未被占用的 symbol 前缀 `82`（文件内已用 83–88 + 86 子码；82 空闲）。一行改动，测试天然隔离、可全速并行，无锁开销、无串行化代价。
- 候选 B（弃用）：binary 内 `tokio::sync::Mutex` 互斥共享状态用例（api_settings 模式）。适用场景是「状态本质共享无法命名空间隔离」；本例纯属前缀笔误造成的撞码，加互斥会无谓串行化两个用例且掩盖真实隔离意图（文件头注释本就声明「每测试用独立 symbol 前缀（并行隔离）」，此修复恢复该意图）。

未削弱任何断言；未触碰生产代码；未改任何接口/层边界（纯测试文件内一个字面量）。api_workbench.rs 为 ADR-007 非 tangle 手写例外，design/ 无需同步。

## 变更文件

| 文件 | 变更 |
|---|---|
| `crates/web/tests/api_workbench.rs` | +1/-1：`cancel_run_semantics` symbol 前缀 `85` → `82` |

层级归属：测试层（crates/web/tests，集成测试装配），无架构影响。

## 测试覆盖

未新增/删除用例；修复的是既有 6 用例间的并行隔离缺陷（既有断言本身即为回归保护——撞码复发会立即以 404/409 断言失败暴露）。

## 验证记录（硬证据）

| 验收项 | 结果 |
|---|---|
| `cargo test -p web --test api_workbench`（默认全并行）连续 10 次 | **10/10 PASS**（修复前 12 次跑 9 次 FAILED） |
| `cargo test --workspace --no-fail-fast` 连续 3 次 | **3/3 exit 0**，无 FAILED/error 行 |
| `cargo clippy --workspace --all-targets` | exit 0，warning 计数 **0** |
| tangle 无 diff | 基线验证：stash 全部未提交改动后 `entangled tangle` → `git diff --quiet` 干净；本修复文件为 ADR-007 手写例外，tangle 不产生其 diff（已 stage 后复查无 unstaged drift） |
| `cd web && npm test` | **46 文件 / 451 用例全 passed** |

注：工作区存在其它 worker 在途的未暂存改动（Dockerfile.app、design/06-web、design/07-app-plane、web/package.json、web/src/api/index.ts 等），与本任务无关，未触碰。

## 遗留风险

- 无。若未来新增用例复用既有 8x 前缀会重现同类撞码；文件头注释已声明前缀隔离纪律，靠评审把关。

## 暂存状态

`git add crates/web/tests/api_workbench.rs` 已完成（未 commit）。工作区另有先前会话已 stage 的文件（coder/report/139、web/src/api/index.test.ts），非本任务产物，保持原样。
