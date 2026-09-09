# 082 — ADR-007：sim-live 持仓最新价 fix 同步回 design 源并重生成

> 本报告文件位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/082_adr007_simlive_position_latest_design_sync.md`
> 任务：把「持仓最新价修复」（report 081）在 tangle 生成文件中的改动**同步回 design 源并重生成**（ADR-007），使 check-tangle 不再拦截提交。不 commit、无暂存。

## 1. 问题（Problem）

report 081 的持仓 latest/market_value fix 直接改了两个 **tangle 生成文件**（`crates/app/src/bin/eestock-app.rs` 加 `with_kline(sim_kline)`、`crates/mcp/src/tools.rs` 的 `sim_get_positions` 改 async），但 **design 源未同步**：

- `git status` 显示这两个生成文件在 worktree 有改动而 index/HEAD 未带（`entangled tangle` 因文件「changed outside control of Entangled」报 conflict，需 `--force` 才能重生成）。
- `scripts/check-tangle.sh`（pre-commit 门禁）在 `git diff --quiet` 上失败，拦截提交。

**根因**：ADR-007 的 fact source 是 `design/` 文档树，生成物不得手改；手改而未回写 design 源即破坏 fact-source 纪律。

## 2. 改动（What changed）——同步了哪些 design 块

### 2.1 `design/07-app-plane/00-web-api.md`（app 装配/DI 块）

1. **§DI（app bin §5）prose**（约 L210）：把 `sim_service` 构造描述更新为 `.with_backtest(backtest.clone()).with_kline(sim_kline.clone())`，并注明 `sim_kline = Arc::new(storage::reader::KlineReader::new(pool.clone()))`（`domain::ports::KlineRead`，与 `state.kline` 同款/同库；持仓 latest/market_value 经行情源解析）。
2. **app bin tangle 块** `crates/app/src/bin/eestock-app.rs`（约 L4177）：
   - 在 `ma_config` 之后、`AppState` 之前插入 `sim_kline` + `sim_service`（`with_default_fee(PgSimSessionStore, SystemClock).with_backtest(backtest.clone()).with_kline(sim_kline.clone())`），带注释「持仓 latest/market_value 经行情源读端口解析（复用 state.kline 同款 KlineReader）；缺行情才回退 0.000」。
   - `backtest,` → `backtest: backtest.clone(),`（因 sim_service 需要 `backtest.clone()`，AppState 不再 move 占用）。
   - 在 `ma_config` 字段后新增 `sim: Some(sim_service.clone()),`（AppState.sim，web 与 MCP 共享同实例）。
   - 新增 `SimLiveFeed` 实时评分 spawn 块（复用 sim_service/state.kline）。
   - 移除原 MCP 段中重复的 `let sim_service = Arc::new(...)` 定义（现复用上方同一实例）。

### 2.2 `design/07-app-plane/01-mcp.md`（tools.rs 块）

1. **call_tool 分支**：`"sim_get_positions" => sim_get_positions(..)` → `...=> sim_get_positions(..).await`。
2. **`sim_get_positions` fn**：`fn` → `async fn`，`sim.get_positions(session_id)` → `sim.get_positions(session_id).await`，注释改为「sim_get_positions(session_id)。持仓 latest/market_value 由 SimLiveService 经行情源解析」。
3. **`sim_service` fn**：新增 `mcp_enabled()` 门禁（关闭 → isError「已停用」）+ 更新 doc 注释。
4. 补 `sim_tools_gated_by_mcp_enabled_toggle` 测试（L3b mcp-toggle 关闭/重开）。

## 3. 重新生成（tangle）

- `entangled tangle --force`：写出 `crates/app/src/bin/eestock-app.rs`、`crates/mcp/src/tools.rs`（因文件被外部改动，`--force` 才继续）。**内容与 `--force` 前完全一致**（`diff` 无差别，无内容丢失）。
- 再次 `entangled tangle`（无 `--force`）→ `Nothing to be done`（filedb 已更新，幂等）。
- `./scripts/check-tangle.sh`（在暂存全部改动后）→ `✅ tangle 后无 diff，design 与生成物一致`，exit 0。

> 注：3 个 application/web 文件（`crates/application/src/simlive.rs`、`crates/application/tests/simlive.rs`、`crates/web/src/simlive.rs`）为**非 tangle 生成**的手写源，本就属于 report 081 fix 的一部分，未参与本 design 同步。

## 4. 分层归属（Architecture Alignment）

- 改动仅落在 **design 源文档**（`00-web-api.md` / `01-mcp.md`）的 app 装配/DI 块与 mcp tools 块，以及随之重生成的 2 个生成文件。
- 未改任何接口/边界/依赖方向；仍遵循 ADR-017（应用面只读库，经 `domain::ports::KlineRead`）与 ADR-009（MCP sim_* 经 `application::SimLiveService`）。
- 同步的 `sim_feed`/`AppState.sim`/mcp-toggle 门禁为生成文件中**既有、此前未回写 design** 的漂移；本次一并回写以恢复 fact-source 一致性（非新增功能）。

## 5. 验证（Verification）

| 命令/检查 | 结果 |
|---|---|
| design 块 vs 生成文件逐字 diff | `crates/app/src/bin/eestock-app.rs`: MATCH；`crates/mcp/src/tools.rs`: MATCH |
| `entangled tangle`（幂等） | `Nothing to be done` |
| `entangled tangle --force` 前后内容 | 生成文件 IDENTICAL（无内容丢失） |
| `./scripts/check-tangle.sh`（暂存后） | `✅ ... 无 diff，design 与生成物一致`，exit 0 |
| `cargo build --workspace` | ok，exit 0 |
| `cargo test -p application` | `26 passed; 0 failed`（含 3 个持仓 latest 新测试） |
| `cargo test -p mcp` | ok，exit 0（unit + mcp_protocol 2 + mcp_tools_db 3） |
| `git diff --cached` | **空**（无暂存） |

## 6. 残留风险（Residual Risks）

- **报告 081 固有风险仍存**：`get_account`/`get_pnl` 仍用内存 `Position.latest`（feed 不调 `mark_to_market`），`/state` 的 `account.equity`/`market_value` 与 `positions[].market_value` 在未打市值运行态下可能不一致（报告 081 已限定「只改持仓 DTO」）。
- **周期口径**：持仓最新价按会话周期 `latest_bar close` 解析（与评分表一致）；该周期无 cagg/bar 时回退 0.000。
- **行情源异常吞掉**：`latest_bar` 查询 Err 时回退 0.0，未区分「无行情」与「行情源异常」。
- **pre-existing 单测失败**：`crates/storage/tests/alert_store.rs::list_events_filters` 需 TimescaleDB :5433，在本改动前即失败，与本次无关（报告 081 已用 stash 验证）。
- **范围说明**：为通过 check-tangle，本次把 `eestock-app.rs`/`tools.rs` 生成块中此前未回写 design 的既有漂移（`sim_feed`、`AppState.sim`、`backtest: clone`、mcp-toggle 门禁及其测试）一并写回 design。此为恢复 fact-source 一致性的必要同步，非新增逻辑。

## 7. 一致性证明（Design ↔ Generated）

- 以 python 逐字比对 `design/` 块体与生成文件体（去掉 `// ~/~ begin/end` 标记）→ 两文件均 `MATCH`。
- 以 `entangled tangle`（无 force）幂等 → 无写、无 diff。
- 以 `check-tangle.sh`（暂存后）→ 通过。
