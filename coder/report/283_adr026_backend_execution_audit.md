# 变更报告（283）：ADR-026 阶段 1 后端实现 —— 运行执行完整度审计与口径披露

- **本报告位置**：`coder/report/283_adr026_backend_execution_audit.md`
- **主报告（含全部原文证据索引）**：`coder/evidence/20260919_adr026_backend/README.md`
- **证据目录**：`coder/evidence/20260919_adr026_backend/**`
- **契约**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`（冻结）
- **基线**：`git rev-parse HEAD` = `e807385449a303a1090ac00a52c722b7b77e62ec`

## 1. 改了什么（文件 + sha256 见主报告 §1）

新增 2 个文件（`crates/application/src/audit.rs` 933 行纯函数审计；
`crates/web/tests/adr026_run_audit.rs` 563 行端点集成测试），修改 13 个已跟踪文件
（`git diff --stat`：14 files changed, 333 insertions(+), 6 deletions(-)，其中
`design/01-architecture/adr/ADR-023-*.md` 为**基线既有改动、本批未触碰**）。

## 2. 架构对齐

| 层 | 落点 | 理由 |
|---|---|---|
| Domain/Application（**纯逻辑、无 IO**） | `crates/application/src/audit.rs` | ADR-026 §4「审计计算为纯函数，落 domain/application」；依赖 `backtest::FeeModel` + `strategy_core::{ExecutionPolicy,OrderReason}`，domain 层无此二型 |
| Application（读侧接线） | `application::workbench::{RunAudit, WorkbenchService::run_audit}` | 复用既有 `series_all`/`fills_all`（ADR-024 P6 双读），不新造读径；404 复用 `WorkbenchNotFound` |
| 纯逻辑（引擎口径） | `strategy-core::engine` 增 `OrderReason::{as_str,parse}` + `apply_sell(reason)` | 仅**新增**来源透传，成交量/回合判定逐字不动 |
| ABI 类型 | `backtest::TradeDetail.reason`（`#[serde(default)]`） | ADR-026 §2.3；历史 JSON 可读，不改 `trade_count` 语义 |
| Presentation | `web::workbench::get_audit` + 路由；`mcp::tools::bt_get_run_audit` | **零重复算法**（web/MCP 同调用 application 纯函数） |

## 3. 解决的问题 / 新增能力

按 ADR-026 §2.2 冻结契约提供**只读派生**的执行完整度审计：投入率（**敞口** `deployed_*` 与**资金占用**
`cash_consumed*` 分别命名）、DCA 计划推进（`planned_tranches`/`reachable_batches`/`batches_done`）、
未执行挂单（`unexecuted_orders`/`last_bar_unfilled`）、回合与强平合成披露
（`round_trips_total`/`round_trips_force_closed`）、非阻断 `warnings[]`（阈值/警告码全部具名常量）。

## 4. 实施路径（每个变更均 Red→Green）

1. 纯函数：先 `todo!()` 全红（0 passed / 17 failed）→ 最小实现 → 18 passed。
2. `TradeDetail.reason`：先落字段（`None`）让断言测试**可编译地失败** → 引擎透传后绿。
3. 端点：先写集成测试（未注册路由 ⇒ 404 断言失败）→ handler/路由 → 4 passed（临时库）。
4. MCP：先改三处名单断言 + 契约测试（FAILED）→ 实现 → 绿。
5. 突变自检 2 次（常量替换/口径错配）→ 3~4 个测试变红 → sha256 校验还原 → 复绿。
6. 回归 5 个受影响 crate（50 个目标全绿）+ `cargo check --workspace --all-targets`。
7. A3/A4 用**真实 run 事实行**在临时库回放端点并独立 SQL 重算对照（原始响应见证据）。

## 5. 测试覆盖（新增/更新）

- 新增：`crates/application/src/audit.rs` 内 18 个表驱动单测；`crates/web/tests/adr026_run_audit.rs` 4 个集成测试。
- 更新：`crates/strategy-core/tests/engine.rs`（`TradeDetail.reason` 三值 + 兼容）；`crates/mcp/src/tools.rs`
  （工具名单断言 34→35 + `bt_get_run_audit` 契约/门禁）；`crates/mcp/src/rpc.rs` 与
  `crates/mcp/tests/mcp_protocol.rs` 名单/帧序断言同步。

## 6. 验证方式

`cargo test`（5 crate，临时库）+ `cargo check --workspace --all-targets` + Red/Green/突变原始输出 +
A3/A4 端点原始 JSON 与独立重算对照 + tracing span 字段实测捕获 + ADR-025 临时库 teardown 回读
（库清单只剩 `{eestock, postgres}`，`tmp_` 残留 0）。全部原文见 `coder/evidence/20260919_adr026_backend/`。

## 7. 需主代理知悉

- **未部署** :8081/:8082（部署与冻结归主代理）⇒ A6 前端 E2E 属后续阶段。
- **既有红**（与本批无关）：`cargo test -p web --test tester_p5rect_verify` 的 `resource_guard(confirm=false)`
  仍按旧阈值 200_000 期望 400（HEAD 常量为 500_000；ADR-024 向量注释已记载该 tester 资产滞后）。
- **GitNexus 影响分析工具不可用**（索引存储版本 43 vs build 42），已改用人工爆炸半径盘点（主报告 §9）。
- **未执行任何 `git add/commit/checkout/stash/reset`**（`git diff --cached` 为空）。
