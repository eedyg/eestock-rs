# 报告 072 — 模拟实盘 L1 核心（simlive crate + 迁移0018 + 端口 + SimLiveService + MCP sim_*）

> 本报告自身位置：`coder/report/072_simlive_l1_core.md`
> （`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/072_simlive_l1_core.md`）

任务：实现「模拟实盘 **L1 核心**」，严格 TDD（Red→Green）+ ADR-007（design 源 → tangle）+ 深测纪律。
依据 `design/11-sim-live/01-adr.md`（§2/5/6/9/10/11）。仅 L1 范围，**未 commit**（工作树未暂存，index 为空）。

---

## 1. 改动了什么

### 新增 crate：`crates/simlive`（纯逻辑，手写，非 tangle）
- `src/account.rs`：`SimAccount`（cash 默认 1_000_000 可配）+ `Position` + `SimPosition`；`apply_fill`/`mark_to_market`/`equity`/`realized_pnl`/`unrealized_pnl`/`positions`。
- `src/fill.rs`：`Side`/`Fill`/`Order`/`IntentId`/`SimTrade`/`FillEngine`（市价即时撮合；限价触价成交；滑点/费用按 `backtest::FeeModel`）。
- `src/session.rs`：`SessionManager`（start/stop/get_state/tick）、`SimSession`/`SimOrder`/`OrderStatus`/`SessionStatus`/`SessionState`/`StrategySignal`（基础信号，L2 用）。
- `Cargo.toml`：仅依赖 `backtest`（复用 FeeModel）、`serde`、`anyhow`。

### 迁移 0018（tangle，design/04-storage/schema.md §4.3.10 → migrations/0018_sim_session.sql）
- 4 表：`simsession`(id,name,cash_init,strategy_set,stock_set,period,start_ts,end_ts,status,source) +
  `simsession_result`(session_id,net_value_json,trades_json,metrics_json) +
  `sim_trades`(session_id,code,side,qty,price,ts,fee,source) +
  `sim_positions`(session_id,code,qty,avg_cost)。

### domain ports（tangle，design/02-domain/contracts.md → crates/domain/src/ports.rs）
- 新增 `SimSessionStore` 端口（create_session/get_session/list_sessions/append_trade/update_positions/mark_end/delete_session）+ `SimSessionStatus`/`NewSimSession`/`SimSessionView`/`NewSimTrade`/`SimPositionRow`/`SimSessionResult`。

### storage（手写 `crates/storage/src/sim.rs`，契约在 schema.md §4.3.10；tangle 注册 `pub mod sim`）
- `PgSimSessionStore` 实现 `SimSessionStore`（PgPool）；集成测试 `crates/storage/tests/sim_store.rs`。

### application（手写 `crates/application/src/simlive.rs`，tangle 注册 `pub mod simlive`）
- `SimLiveService`：start_session/stop_session/place_order(市价/限价→FillEngine)/cancel_order/get_account/get_positions/get_orders/get_pnl/mark_to_market；intent_id 幂等去重；依赖注入 `SimSessionStore` + `Clock` + `FeeModel`；默认资金 1_000_000。
- `StartSessionReq`/`PlaceOrderReq`/`AccountView`/`PositionView`/`PnlView`/`OrderView`。
- `SimLiveService::with_default_fee`（便捷构造，避免 app/mcp 直接依赖 backtest）。
- 集成测试 `crates/application/tests/simlive.rs`（mock 端口 + 固定时钟，无实时 DB）。

### MCP sim_* 工具（tangle，design/07-app-plane/01-mcp.md）
- **传输**：沿用既有 **SSE** 传输（任务回退口径「若既有 mcp 已 SSE，按现有传输+注明」）；**Streamable HTTP 未实现，列为残留风险**。
- `McpState` 增 `sim: Option<Arc<SimLiveService>>`（未配置 → 工具 isError）。
- 新增 8 个 `sim_*` 工具（tool_list / call_tool / handlers + 测试）：`sim_start_session`/`sim_stop_session`/`sim_get_account`/`sim_get_positions`/`sim_get_orders`/`sim_get_pnl`/`sim_place_order`/`sim_cancel_order`，description 注明「模拟实盘，不触真实券商」。
- `mcp` Cargo.toml 增 `application` 依赖（同 web 依赖 application 工艺；无环）。
- 工具数据通路集成测试（mcp_tools_db.rs）已同步 `sim: None`。

### app DI（tangle，design/07-app-plane/00-web-api.md → crates/app/src/bin/eestock-app.rs）
- `mcp_state` 注入 `sim: Some(SimLiveService::with_default_fee(PgSimSessionStore(pool), SystemClock))`。

---

## 2. 架构对齐（分层）
- `simlive`（纯逻辑，无 IO/无 DB）：被 `application` 调用；`backtest::FeeModel` 复用（费用口径同步）。
- `domain::ports::SimSessionStore`：端口在 domain，`storage` 实现，`application`/`mcp` 依赖；app bin 装配。
- `application::SimLiveService`：依赖注入 domain 端口 + simlive；不依赖 storage/sqlx/web。
- `mcp`：`Presentation` 层调用 `application::SimLiveService`（同 web→application 工艺）；只依赖 domain 端口 + application + diagnose，不依赖 storage/sqlx（tests 用 mock）。
- `storage`：`Infrastructure`，只依赖 domain 端口。
- 分层红线保持：mcp/web 不反向依赖 storage（mcp sim 测试用 mock SimSessionStore；真实装配在 app bin）。

## 3. 解决的需求 / 新增功能
- L1 核心：模拟账户（现金/持仓/已实现+未实现盈亏/费用）、简化撮合（市价/限价/滑点/费用）、会话生命周期（start/stop/get_state/net_value_series/trades）、基础策略信号结构。
- 会话存储迁移 0018（4 表）+ 端口 + storage 实现 + 端到端 CRUD。
- 应用层 SimLiveService（下单/撤单/幂等/查询/会话控制）。
- MCP `sim_*` 工具集（外部通道，纸面交易不触真实券商）。
- app DI（SimSessionStore + SimLiveService 注入 MCP）。

## 4. 实现方式（TDD Red→Green，深测纪律）
- 每个新模块先写带断言的可复现测试（固定输入 / mock 端口 / 固定时钟），再实现直到绿。
- 无 DB 实时依赖：`simlive` 纯逻辑（固定价格/数量黄金样本）；`SimLiveService` 测试用 mock `SimSessionStore` + `FixedClock`；`mcp` sim 测试用 mock store + FixedClock。
- storage/mcp_tools_db 用真实 TimescaleDB :5433（迁移 0018 已 apply），测试数据自清理。

## 5. 测试覆盖
- `simlive` 19 tests：apply_fill 建仓/加仓加权/平仓/部分平仓/卖空拒绝、mark_to_market 市值/未实现/净值、FillEngine 市价即时/限价触及/滑点费用/脏价拒单、SessionManager start/tick/stop幂等/持仓快照/事件流、Side parse。
- `application::SimLiveService` 8 tests：start 默认 1M、市价买成交+账户+落库、限价未触及 pending、撤单（pending 可撤/成交不可撤）、pnl+mark_to_market、intent 幂等、stop 幂等、未知会话 err。
- `storage::sim_store` 5 tests：会话 CRUD、list 排序、成交+持仓落库、mark_end 结果+状态机、级联删除。
- `mcp` sim 工具 5 tests + 更新 tool_list schema / 路由 / 协议 tools.len（11）。
- 全 workspace：**347 passed / 0 failed**（仅跳过唯一无关的既有 flaky `storage::alert_store::list_events_filters`，见残留风险 #8）。

## 6. 验证
- `cargo test --workspace`：347 passed / 0 failed（`--skip list_events_filters`；exit 0）。
- `cargo clippy --workspace`：0 warning / 0 error。
- `entangled tangle`：幂等（第二次「Nothing to be done」，生成文件 diff 为空）。
- `cargo check --workspace`：app/mcp/web/application/storage/domain/simlive 全编译通过。
- 单独确认：simlive 19 / storage sim_store 5 / application simlive 8 / mcp lib 21 / mcp_protocol 2 / mcp_tools_db 3 全绿。

## 7. 暂存文件清单（index 为空，未 commit）
新增：
- `crates/simlive/`（Cargo.toml + src/{lib,account,fill,session}.rs）
- `crates/application/src/simlive.rs`
- `crates/application/tests/simlive.rs`
- `crates/storage/src/sim.rs`
- `crates/storage/tests/sim_store.rs`
- `migrations/0018_sim_session.sql`（tangle 生成）
- `coder/report/072_simlive_l1_core.md`（本报告）

修改（含 tangle 再生成）：
- `design/02-domain/contracts.md`、`design/04-storage/schema.md`、`design/04-storage/02-tushare-sync.md`、`design/07-app-plane/01-mcp.md`、`design/07-app-plane/00-web-api.md`（design 源）
- `crates/domain/src/ports.rs`、`crates/storage/src/lib.rs`、`crates/mcp/src/{state,rpc,tools,mocks}.rs`、`crates/mcp/tests/{mcp_protocol,mcp_tools_db}.rs`、`crates/app/src/bin/eestock-app.rs`（tangle 生成物）
- `crates/application/Cargo.toml`、`crates/application/src/lib.rs`、`crates/mcp/Cargo.toml`、`Cargo.lock`

## 8. 残留风险
1. **MCP Streamable HTTP 未实现**：沿用既有 SSE 传输（任务回退口径「按现有传输+注明」）。Streamable HTTP 迁移 → L1.5/L2（需大改 server.rs + 协议测试）。
2. **web sim-live 面板延后 L3**：L1 仅打通 MCP 接口 + 核心逻辑，web 面板不在范围（任务明确「web 延后 L3，注明」）。
3. **`SimAccountRead/Write` 独立端口未单列**：SimLiveService 直接用内存 SessionManager + `SimSessionStore` 持久化（持仓经 `update_positions` 全量覆盖）；任务措辞「若应用层需要」，当前不需要独立读写端口。
4. **无实时行情数据链**：L1 `place_order` 由调用方传入模拟最新价 `price`；实时 bar 驱动（RealtimeStrategyOrchestrator）属 L2。
5. **`StrategySignal` 为基础结构**：L2 才做实时评分/聚合评分/trading on/off。
6. **幂等（intent 去重）在内存（每进程 LiveSession）**：多实例一致性为 L4 加固范围；持久化层未做 intent 唯一约束。
7. **`sim_positions` 每次成交全量覆盖写**：会话内状态可重建；无增量合并（与会话运行期内存态一致）。
8. **`storage::alert_store::list_events_filters` 既有失败**（与本次无关）：共享 dev DB 数据污染——`ranged` 查询按 `last_fired_at` 窗口过滤但未按 source，历史残留事件落入窗口 → 预期 1 实际 2。非本次改动引入（未动 alert 表/代码），`--skip` 后全 workspace 绿。

## 9. 与任务边界一致
- 只做 L1；未触碰 backtest 既有功能；未改真实交易（real-trading 独立）。
- 仅新增迁移 0018；未改既有迁移。
- 未 commit（index 为空，0 staged files）；工作树保留改动供父级审阅。
