# 归档版本审计重跑（coder 报告 137）— 验收执行报告（只执行验证，不改代码；零容忍基线）

- 报告文件位置：`tester/test/034_archived_audit_rerun_acceptance_execution.md`
- 执行时刻：2026-09-10T23:40~23:44+08:00
- 仓库/提交：`eestock-rs` @ `12d770f7a7eeacf832f032e8a1d1b86e4e762d2e`（branch `master`；被验产物为 HEAD 之上 8 个 staged 文件）
- 执行者：Tester Agent（未修改任何实现代码 / 接口 / 架构 / 测试 / 构建配置；未做任何失败分析或修复尝试）
- 唯一仓内写入：本报告（`tester/test/034_...md`）
- 平台侧副作用：临时用**新构建二进制**在同一 DB 上起独立实例 `127.0.0.1:28081`（web）/`28083`（MCP）做只读+抽查，结束后已停；抽查产生的 2 个 run、2 个策略已清理（见 §6）。生产实例 `:8081`/`:8082` 无损。
- 无 crash、无 core dump（Rust 全量 + web 全量 + 抽查均无 SIGSEGV/SIGABRT/Aborted；`grep -icE 'SIGSEGV|SIGABRT|Aborted|panicked at|core dumped'` = 0；仓内/`/tmp` 无本次新 core 文件）。

## 0. 总结论：PASS

| # | 验收项 | 结论 |
|---|---|---|
| 1 | `cargo build`（0 error）/ `cargo test`（0 failed）/ clippy（0 warning）/ tangle（无 diff） | PASS |
| 2 | `web: npm run build`（0 error）&& `npm test`（0 failed） | PASS |
| 3 | 校验矩阵抽查（draft 400/isError、published 201 archived:false、archived 201 archived:true→succeeded、不存在 404）存在且通过 | PASS |
| 4 | 红线：`GET /api/strategies` catalog 仍仅 published（刚归档策略不出现） | PASS |
| 5 | `git diff --cached --stat` 变更面核查（仅 8 文件，未触红线模块） | PASS |

---

## 1. Rust 构建 / 测试 / clippy / tangle — PASS

### 1.1 `cargo build --workspace` — PASS（0 error）
```
$ cargo build --workspace
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.02s
BUILD_EXIT=0
```
日志：`/tmp/accept_*.log`（build 输出见会话）。0 error，exit 0。

### 1.2 `cargo test --workspace --no-fail-fast` — PASS（0 failed）
```
$ cargo test --workspace --no-fail-fast
汇总（86 个 test target 段）： passed=587  failed=0  ignored=1
grep -cE "test result: FAILED" /tmp/accept_test.log  → 0
grep -icE "SIGSEGV|SIGABRT|Aborted|panicked at|core dumped" /tmp/accept_test.log → 0
EXIT=0
```
日志：`/tmp/accept_test.log`。**587 passed / 0 failed / 1 ignored**。

### 1.3 `cargo clippy --workspace --all-targets` — PASS（0 warning）
```
    Checking ...（全 15 crate）
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.56s
CLIPPY_EXIT=0
grep -cE "^warning" /tmp/accept_clippy.log → 0
```
日志：`/tmp/accept_clippy.log`。0 warning，exit 0。

### 1.4 tangle 一致性门禁 — PASS（无 diff）
```
$ ./scripts/check-tangle.sh
[check-tangle] entangled tangle ...
[23:41:31] INFO     Welcome to Entangled v2.4.3!  Nothing to be done.
[check-tangle] ✅ tangle 后无 diff，design 与生成物一致。
TANGLE_EXIT=0
```
`design/**` → `src` 生成物无漂移（`crates/mcp/src/tools.rs` 与 `design/07-app-plane/01-mcp.md` staged 同步）。

---

## 2. 前端构建 / 测试 — PASS

### 2.1 `cd web && npm run build` — PASS（0 error）
```
> tsc -b && vite build
✓ 167 modules transformed.
✓ built in 1.67s
BUILD_EXIT=0
```
仅有 rollup 大 chunk 体积**告警**（非 error），不影响构建结果。

### 2.2 `cd web && npm test`（vitest run） — PASS（0 failed）
```
 Test Files  45 passed (45)
      Tests  447 passed (447)
WEBTEST_EXIT=0
```
日志：`/tmp/accept_webtest.log`。

---

## 3. 校验矩阵抽查（存在且通过）— PASS

抽查命令与结果（均在**新代码**上执行；集成测试自起 axum server + 真 TimescaleDB :5433）：

| 分层 | 测试用例 | 结果 |
|---|---|---|
| web 集成 | `crates/web/tests/api_workbench.rs::submit_validation_error_matrix` | ok（draft→400 + 文案断言；未知版本→404） |
| web 集成 | `crates/web/tests/api_workbench.rs::submit_run_lifecycle_end_to_end` | ok（published→201 + `slots[0].archived==false` + 跑至 succeeded） |
| web 集成 | `crates/web/tests/api_workbench.rs::submit_archived_version_audit_rerun_201` | ok（archived→201 + `archived==true` + 详情标记 + 跑至 succeeded） |
| application | `crates/application/tests/workbench.rs`（14 用例） | ok（含 `submit_rejects_draft_version_400` / `submit_accepts_archived_version_with_audit_marker` / `submit_marks_published_version_not_archived` / `submit_rejects_unknown_version_404`） |
| MCP | `crates/mcp/src/tools.rs::{bt_run_ensemble_unpublished_and_invalid_config_are_is_error, bt_run_ensemble_archived_version_audit_rerun, bt_run_ensemble_happy_path_and_run_queries}` | ok（3/3；draft→isError；archived→钉住 + succeeded） |

```
# cargo test -p web --test api_workbench -- --test-threads=1
test result: ok. 6 passed; 0 failed; ...
# cargo test -p application --test workbench
test result: ok. 14 passed; 0 failed; ...
# cargo test -p mcp bt_run_ensemble
test result: ok. 3 passed; 0 failed; ... (41 filtered)
```

**活体抽查（新二进制实例 :28081，真实 HTTP + DB）**：
| 场景 | 结果 | 证据 |
|---|---|---|
| draft → 400 | PASS | `HTTP=400`，body：`策略版本 sv_... 未发布（status=draft），draft 版本不可运行（published/archived 版本可运行）` |
| published → 201 archived:false | PASS | `HTTP=201`，`slots[0].archived=false`；轮询至 `succeeded` |
| archived → 201 archived:true → succeeded | PASS | `HTTP=201`，`slots[0].archived=true`；轮询至 `succeeded`，`progress=1.0`，详情快照 `archived=true` |
| 不存在 → 404 | PASS | `HTTP=404`，body：`策略版本不存在: sv_none` |

---

## 4. 红线：catalog 仍仅 published — PASS

### 4.1 活体 GET `/api/strategies`（新二进制 :28081）
```
catalog count= 12  statuses= ['published']
wave2.5 已归档两条（sv_1789052338161_000145 / sv_1789052338173_000147） present? False
本轮新归档一条（sv_1789055037710_000003，审计重跑用） present? False
```
→ catalog 全部为 `published`；**刚刚归档的策略立即从 catalog 消失**（红线成立）。

### 4.2 生产实例（:8081，改动前二进制）交叉核对
```
count=12，statuses=published；sv_...145 / sv_...147 / sv_...120 均 ABSENT
```
注：`:8081` 进程启于 19:35，早于本次 staged 改动（源码 mtime 23:38），属改动前二进制；但本 diff 未触及 catalog 代码路径（见 §5），且 4.1 已在**新代码**上复验，红线结论一致。

### 4.3 静态佐证（未改动路径）
`crates/storage/src/strategy.rs:293`：catalog 查询 `JOIN strategy_version v ON ... AND v.status = 'published'`（本次 diff 未触及）。

---

## 5. `git diff --cached --stat` 变更面核查 — PASS

```
 .../137_workbench_submit_archived_audit_rerun.md   | 56 ++++++++++++++++++++++
 crates/application/src/workbench.rs                | 39 +++++++++++----
 crates/application/tests/workbench.rs              | 29 +++++++++--
 crates/mcp/src/tools.rs                            | 42 ++++++++++++++--
 crates/web/tests/api_workbench.rs                  | 43 ++++++++++++++++-
 design/07-app-plane/00-web-api.md                  | 10 ++--
 design/07-app-plane/01-mcp.md                      | 42 ++++++++++++++--
 design/12-strategy-system/01-adr.md                |  1 +
 8 files changed, 237 insertions(+), 25 deletions(-)
```
- 实现面改动仅 `crates/application/src/workbench.rs`（+ `crates/mcp/src/tools.rs`，tangle 自 `design/07-app-plane/01-mcp.md`）；其余为测试/文档/报告。
- **未触及红线模块**：catalog（`storage/strategy.rs`、`application/strategy.rs` 零改动）、`application/simlive.rs`（published-only 会话校验零改动）、strategy-runtime/core/backtest/simlive crate 零改动。
- `git diff`（未暂存 tracked）为空；无意外文件进入暂存区。

---

## 6. 副作用与清理
- 抽查用临时实例 `:28081/:28083` 已停止（端口已释放）。
- 删除抽查 run `sr_1789055038359_000004`、`sr_1789055041345_000005`（含 result），删除抽查策略 `accept-live-*`（2 策略）；复查剩余 0。
- 生产 `:8081`/`:8082` 保持存活（catalog HTTP 200）。

## 7. 结论
五项验收全部 PASS；0 error / 0 failed / 0 warning / tangle 无 diff；矩阵四态与 catalog 红线均在新代码上活体复验通过。FAIL 无。
