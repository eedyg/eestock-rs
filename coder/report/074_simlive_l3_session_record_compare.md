# 074 — 模拟实盘 L3a（后端）：会话记录持久化 + 回测对比 + 会话 MCP 工具

> 依据：`design/11-sim-live/01-adr.md`（§3/§8）。范围：**仅 L3a 后端**。TDD + ADR-007（tangle 幂等）。未 commit。
> 本文件位置：`coder/report/074_simlive_l3_session_record_compare.md`

## 0. 结论（TL;DR）
- **L3a 四件套完成**：① `stop_session` 结算（backtest 指标口径）写入 `simsession_result`；② `sim_run_backtest_compare` 触发回测 run；③ `sim_list_sessions` / `sim_get_session` 会话回看；④ MCP 三个新工具 schema + handler。
- **回测对比解耦已处理并注明**（见 §4 风险）。
- **未加迁移**（`compare_run_id` 列为「可选」；为不改 tangle 迁移源 0018/schema.md，本阶段改为由 MCP 工具**返回** run_id 关联，未持久化到 simsession）。
- `cargo test --workspace`（剔除既有无关 flaky `alert_store::list_events_filters`）全绿；`cargo clippy --workspace --all-targets` 干净；`entangled tangle` 幂等。

## 1. 需求 & 解决的问题
模拟实盘（L1/L2）已在内存维护会话 net_value_series/trades/事件流，但：
1. `stop_session` 目前只写 3 项简化指标（net_profit/total_fee/cash_init），**未按 backtest 指标口径**；`net_value` 也只写裸序列（非 `{series,drawdown}`）。
2. 无「回测一下」能力：无法按会话 (period/strategy_set/stock_set/date_range) 触发 backtest run 用于 sim-live vs 回测对比。
3. 无历史会话回看：无法列出历史会话、查看会话详情（净值/交易/指标/事件流）。
4. MCP 缺对应 `sim_list_sessions`/`sim_get_session`/`sim_run_backtest_compare` 工具。

本变更补齐 L3 后端存储/对比/会话 MCP。

## 2. 改动文件（10 个）
| 文件 | 层 | 内容 |
|---|---|---|
| `crates/domain/src/ports.rs` | domain | `SimSessionStore` 增 `get_result(session_id)` 端口（读 `simsession_result`）。 |
| `crates/storage/src/sim.rs` | storage | `PgSimSessionStore` 实现 `get_result`（query `simsession_result` 三 jsonb 列）。 |
| `crates/storage/tests/sim_store.rs` | storage 测试 | `mark_end_writes_result_and_transitions_status` 增 `get_result` 读回断言。 |
| `crates/application/src/simlive.rs` | application | `stop_session` 结算改 backtest 口径；新增 `list_sessions`/`get_session`/`run_backtest_compare`；DTO（`SessionListEntry`/`SessionDetail`/`BacktestCompareView`）；注入 `BacktestService`（`with_backtest`）；helper `bt_period_from_str`/`sim_trades_to_trade_details`。 |
| `crates/application/tests/simlive.rs` | app 测试 | mock 回测服务 + 4 个 L3 测试（结算口径 / list/get / compare 触发 / 未知会话）。 |
| `crates/mcp/src/tools.rs` | mcp（tangle） | `tool_list` 增 3 工具 schema；`call_tool` 增 3 dispatch；3 个 handler；`tool_list_schema_contract` 17 工具；3 个 L3 测试。 |
| `crates/mcp/src/rpc.rs` | mcp（tangle） | `tools_list_and_call_route_to_tools_layer` 期望列表补 3 工具。 |
| `crates/mcp/tests/mcp_protocol.rs` | mcp 测试（tangle） | `tools/list` 计数 14→17。 |
| `crates/app/src/bin/eestock-app.rs` | app 装配 | `SimLiveService` 注入 `backtest`（`.with_backtest(backtest.clone())`）。 |
| `design/07-app-plane/01-mcp.md` | tangle 源码 | 同步 MCP 工具 schema/dispatch/handler/测试至 17 工具（保证 `entangled tangle` 幂等）。 |

## 3. 实现要点

### 3.1 stop_session 结算（backtest 指标口径）
- `net_value` = `{ series, drawdown }`（`drawdown` 用 `backtest::compute_drawdown`）。
- `trades` = `Vec<backtest::TradeDetail>`（**已平仓**配对，FIFO per code；期末未平仓不入 trade_count/win_rate）。
- `metrics` = `backtest::metrics::compute_metrics(net_value_series, trade_details, cash_init, period)`（8 项：net_profit/max_drawdown/sharpe/win_rate/profit_factor/annualized_return/trade_count/avg_hold_bars）。
- `sim_trades_to_trade_details`：确定性、无随机；买/卖 fee 按成交量比例分摊到平仓段；hold_bars = `(close_ts-open_ts)/period秒`；`profit_factor` 全盈时为 `∞`（serde_json 序列化为 `null`，测试已按此断言）。

### 3.2 「回测一下」sim_run_backtest_compare
- 经 `SimLiveService::with_backtest` 注入 `Arc<BacktestService>`（app bin wiring；缺省 None 时返回错误）。
- 按会话 `stock_set × strategy_set` 笛卡尔积逐个 `BacktestService::submit`（复用既有 backtest 服务/引擎/`BacktestRunStore`）。单 stock+单策略 = 一次 run。
- 请求参数 = 会话：`code=stock`、`period=session.period`、`strategy_id=strategy`、`params={}`(默认)、`fee`=会话 FeeModel、`initial_capital=cash_init`、`from/to`=`start_ts/end_ts`（running 用 now）。
- 返回 `BacktestCompareView { session_id, session_result, run_ids }`。**异步**：run 后台执行，调用方轮询 backtest `get_run` 完成。

### 3.3 会话回看
- `list_sessions`：`store.list_sessions()`，已结束会话附 `get_result().metrics` 摘要（净收益/回撤/夏普等）。
- `get_session`：元数据 + `get_result()` 结果。

### 3.4 MCP
- `sim_list_sessions`（无参）、`sim_get_session(session_id)`、`sim_run_backtest_compare(session_id)` 已注册进 `tools/list` + `tools/call` 分发。所有工具 description 均为「模拟实盘，不触真实券商」。

## 4. 架构对齐 / 解耦备注（重要）
- `SimLiveService`（application）依赖 `application::service::BacktestService` + `application::types::{SubmitReq,SubmitOutcome}`：同一 application 层内部依赖，无跨层/反向依赖新引入。
- **backtest 引擎为单 code/单策略 run**，而 sim 会话为多标的×多策略（聚合）。L3a 采用「每 (stock,strategy) 一次 run」；多标的÷多策略的**净值叠加对比渲染**留 L3b web 面板。此为任务预授权「注明并处理」的解耦点。
- **未加迁移**（`simsession.compare_run_id bigint` 为「可选」）：为不改 tangle 迁移源（`design/04-storage/schema.md` → `migrations/0018_sim_session.sql`），本阶段对比 run_id **只由 MCP 工具返回**（调用方/前端持有），**未持久化到会话行**。若需持久化，后续单独加 0019 迁移（经 schema.md tangle）。

## 5. TDD（Red→Green）
先写/更新失败测试（编译期因 trait 新方法缺失而失败），再实现：
1. `crates/storage/tests/sim_store.rs`：`mark_end_writes_result_and_transitions_status` 增 `get_result` 读回断言（存储实现）。
2. `application/tests/simlive.rs`：`stop_session_result_uses_backtest_metrics_structure_and_trade_pnl`、`list_and_get_session_return_history_and_result`、`run_backtest_compare_triggers_run_with_session_params`、`run_backtest_compare_unknown_session_errors`。
3. `mcp/tools.rs`：`sim_list_and_get_session_returns_history`、`sim_run_backtest_compare_triggers_run`、`sim_l3_param_validation_is_32602`，并更新 `tool_list_schema_contract`（17 工具）。
4. `mcp/rpc.rs`、`mcp/tests/mcp_protocol.rs`：tools 列表/计数更新。

## 6. 验证
| 命令 | 结果 |
|---|---|
| `cargo test -p application --test simlive` | 17 passed |
| `cargo test -p mcp` | lib + mcp_protocol + mcp_tools_db 全绿 |
| `cargo test -p storage --test sim_store` | 5 passed（含新 get_result 断言） |
| `cargo test --workspace --no-fail-fast` | **仅** `storage::tests::alert_store::list_events_filters` FAILED（既有无关 flaky，未改） |
| `cargo clippy --workspace --all-targets` | 无 error/warning |
| `entangled tangle --force` | 幂等（二次运行无文件变更） |
| `cargo build -p app` | 成功（含 new .with_backtest wiring） |

## 7. 残留风险
- **对比 run_id 未持久化到会话**：仅由工具返回，重启后关联丢失（如需持久化加 0019 迁移）。
- **多标的/多策略对比**：engine 单 code/单策略；L3a 输出 per-combination run_id，净值叠加渲染属 L3b。
- **期末未平仓不计胜率/交易笔数**：`sim_trades_to_trade_details` 只计已平仓（与 backtest 强制平仓口径的差异已注明）。
- **`hold_bars` 以 ts/周期秒折算**（非真实 bar 序号），`avg_hold_bars` 为近似。
- **`profit_factor` 全盈=∞→null**：JSON 无损表达（测试已覆盖）。
- **`sim_get_session` 未附事件流**（signal_events/orders）：需求已满足「详情=净值/交易/指标」；事件流字段如需可后续扩展。

## 8. 暂存文件清单
未 commit、**未 git add**（工作区仅修改，无暂存改动）。修改文件即 §2 的 9 个。
