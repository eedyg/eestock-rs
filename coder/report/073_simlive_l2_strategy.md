# 报告 073 — 模拟实盘 L2：实时策略评分 + 聚合 + 统一交易开关 + sim_* 策略工具 + 事件流

> 本报告自身位置：`coder/report/073_simlive_l2_strategy.md`
> （`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/073_simlive_l2_strategy.md`）

任务：实现「模拟实盘 **L2：多策略实时评分 + 聚合 + sim_* 策略工具 + 事件流**」，严格 TDD（Red→Green）+ ADR-007 + 可复现（固定输入/无实时 DB 用 mock）。
依据 `design/11-sim-live/01-adr.md`（§2/4/8/11）+ 定稿（3 策略×≤30 股、每新 bar 实时评估、每 stock 独立评分+聚合评分、聚合用于交易决策、统一交易开关、无每策略开关）。
仅 L2 范围，**未 commit**（工作树未暂存，index 为空）。

---

## 1. 改动了什么

### 新增模块：`crates/simlive/src/strategy_orchestrator.rs`（纯逻辑，手写，非 tangle）
- `RealtimeStrategyOrchestrator`：配置 3 策略实例（`StrategyConfig{id, params: StrategyParams, stocks, weight}`），复用 `backtest::{create_strategy, Indicators, Signal}`。
- **独立评分**：把每策略对单标的的 `Signal` 映射为数值分，映射见 `signal_to_score`（`Buy(_)→100`、`Hold→50`、`Sell→0`，映射注明）。
- **聚合评分**：`weighted_aggregate` —— `Σ(weight_i × score_i)/Σ(weight_i)`（仅覆盖该标的的策略）；`aggregate_to_signal` —— 聚合分阈值（`≥60→buy`，`≤40→sell`，否则 `hold`）。
- **输出**：每 `feed_bar`（喂入一根新 bar）→ `StockEvaluation{code, ts, latest_price, per_strategy_scores, aggregate_score, signal}`；`latest_evaluation`/`all_evaluations` 供查询。
- **内建状态按标的隔离**：策略 `on_bar` 内部状态（如 `dual_ma` 的 `prev_above`、`momentum` 滚动窗）按标的独立建实例（每「策略×标的」一个实例）。
- 纯逻辑、无 IO/无随机；固定 bar 序列黄金样本断言。

### `crates/simlive/src/session.rs`
- 新增 `SignalEvent{ts, code, strategy_id, score, signal, aggregate_score, ordered}`（ADR §10 事件流）。
- `SessionManager` 增 `signal_events: Vec<SignalEvent>` + `record_signal_event`/`signal_events()`；`SessionState` 增 `signal_events`；`start_session` 重置事件流。事件流测试。

### `crates/simlive/src/lib.rs`
- 注册 `strategy_orchestrator` 模块；再导出 `RealtimeStrategyOrchestrator`/`StrategyConfig`/`StockEvaluation`/`StrategyScore`/`signal_to_score`/`signal_str`/`aggregate_to_signal`/`weighted_aggregate` 及阈值常量、`SignalEvent`。

### `crates/application/src/simlive.rs`（SimLiveService，L2 方法）
- `LiveSession` 增 `orchestrator: Option<RealtimeStrategyOrchestrator>` + `trading_enabled: bool`（默认关）。
- `configure_strategies(session_id, configs)`：装配编排器。
- `set_trading(session_id, enabled)` / `trading_enabled(session_id)`：**统一交易开关**（无每策略开关）。
- `process_bar(session_id, code, bar)`：喂一根新 bar → 每策略×标的评估+聚合；`trading_enabled` 且聚合达阈值 → 经 `FillEngine` 下模拟单（同一会话/账户，`source=aggregate_strategy`；建仓不叠单、平仓清持仓）；每信号事件 append 到会话事件流；返回事件列表。
- `get_strategy_signal(session_id, code)` / `get_strategy_analysis(session_id)`：读取最近评估/全标的概览。
- `list_builtin_strategies()`：内置策略清单（复用 `backtest::builtin_strategy_catalog`）。
- 新增常量 `DEFAULT_AGGREGATE_QTY=100.0`（聚合策略开仓股数默认）。

### `crates/mcp`（tangle，design/07-app-plane/01-mcp.md）
- `tool_list`/`call_tool`/handlers 增 3 个 `sim_*` 策略工具（description 注明「模拟实盘，不触真实券商」）：
  - `sim_list_strategies`：内置策略清单 + 参数 schema（`strategy_id` 可选过滤）。
  - `sim_get_strategy_signal`：单标的当前信号（聚合分 + 各策略独立分 + 信号/最新价）。
  - `sim_get_strategy_analysis`：多标的评估概览。
- `McpState.sim` 复用 L1 `SimLiveService`；传输沿 L1 SSE（**Streamable HTTP 未实现，记为残留风险**）。
- 测试（mock store + FixedClock，无实时 DB）：3 工具 schema/handler/参数校验。
- `mcp/Cargo.toml` 增 `backtest`/`simlive` dev-deps（仅测试构造 `StrategyConfig`；正常依赖图不变）。

### 复用未改动
- **未改 backtest 引擎/策略内部逻辑**（仅 `create_strategy`/`Indicators`/`Signal` 复用）；未改真实交易；未改现有迁移。
- 会话/账户/撮合/持久化沿用 L1（`SessionManager`/`SimAccount`/`FillEngine`/`SimSessionStore`）。

## 2. 架构对齐（分层）
- `simlive`（纯逻辑 crate）：`RealtimeStrategyOrchestrator` 复用 `backtest`（策略/指标/信号），产出评分/聚合；被 `application` 调用。
- `application::SimLiveService`：依赖注入 domain 端口 + `simlive` crate；把「喂实时 bar → 评分/聚合 → （统一开关下）下单 + 事件流」编排在应用层；不依赖 storage/sqlx/web。
- `mcp`：Presentation 层调用 `application::SimLiveService`（同 web→application 工艺）；只依赖 domain 端口 + application + diagnose，不依赖 storage/sqlx（测试用 mock store + 真实 backtest 造数）。
- `design/07-app-plane/01-mcp.md` 为 tangle 源 → `crates/mcp/src/{tools,rpc}.rs`、`crates/mcp/tests/mcp_protocol.rs` 经 `entangled tangle` 再生成。

## 3. 解决的需求 / 新增功能
- **多策略实时评分**：3 策略实例 × 其标的集，每新 bar（一根 bar 喂入）对每策略×每标的独立评分 + 聚合评分（加权）。
- **聚合用于交易决策**：`trading_enabled` 且聚合分达做多阈值 → 下模拟单（`source=aggregate_strategy`）；`trading_enabled=false` → 只评估/评分不入单。
- **统一交易开关**：`SimLiveService::set_trading(enabled)`（单开关；无每策略开关）；手动 `sim_place_order` 不受开关影响（仅约束聚合策略驱动下单）。
- **事件流**：每评估产 `SignalEvent`（ts/stock/strategy/score/aggregate_score/ordered）append 到会话；经 `SessionState.signal_events` 可查。
- **MCP sim_* 策略工具**：清单/信号/分析三工具；与 L1 账户/订单/会话工具同通道（SSE）。

## 4. 实现方式（TDD Red→Green，深测纪律）
- 每个新模块先写带断言的可复现测试（固定 bar 序列 / mock store / 固定时钟），再实现直到绿。
  - **Red**：先写 `strategy_orchestrator` 的映射/聚合/编排/状态隔离断言、`session` 事件流断言、`application` 的 `set_trading` on/off/阈值/事件流断言、`mcp` 三工具 schema/handler 断言（编写后运行确认失败范式见下）。
  - **Green**：实现直到通过；再 `cargo clippy` 修掉 2 处 `assert_eq!(bool)` 告警。
  - 本次实现与测试分模块推进（每步运行对应 `cargo test -p`）：
    `simlive`（26）→ `application --test simlive`（13）→ `mcp`（lib 25 + protocol 2 + tools_db 3）。
- **无实时 DB / 无随机**：评分输入为手工固定 bar 序列 + 显式策略参数；`application` 用 mock `SimSessionStore` + `FixedClock`（固定 2026-09-03 01:30:00）；`mcp` 测试同（mock store + FixedClock）。
- 策略信号的可信预期值：编排器末 bar 独立分/聚合分由「同样 bars/参数的独立策略实例（参考运行）」计算（非手抄），断言编排器正确接线并按 weight 聚合；纯映射/聚合函数（`signal_to_score`/`weighted_aggregate`/`aggregate_to_signal`）用黄金样本硬编码断言。

## 5. 测试覆盖
- `simlive`（26）：`signal_to_score` 映射、`weighted_aggregate` 加权（含空=50）、`aggregate_to_signal` 阈值、编排器 3 策略×2 股票独立分+聚合分（参考运行对照）、未覆盖标的不评估、策略状态按标的隔离、`session` 事件流记录/重置。
- `application --test simlive`（13，含 5 新增）：`set_trading on→聚合达阈值下单`（持仓 100 股、落库 `source=aggregate_strategy`、事件 `ordered=true`、聚合分=100/信号=buy）、`set_trading off→只评分不入单`、`on 但未达阈值→不下单`、`get_strategy_signal/analysis`、`未配置策略 Err / 未覆盖标的无事件`。
- `mcp`（30）：schema 合同（tools 收 14：3 只读 + 8 L1 + 3 L2 策略）、工具路由（rpc tools/list names 14）、协议集成（`mcp_sse_full_protocol_roundtrip` tools.len=14）、三策略工具 happy/filter/校验。
- 全 workspace（跳过既有 flaky `storage::alert_store::list_events_filters`）：**363 passed / 0 failed**。

## 6. 验证
- `cargo test --workspace -- --skip list_events_filters`：**363 passed / 0 failed**（exit 0）。
- `cargo clippy --workspace --all-targets`：**0 warning / 0 error**。
- `entangled tangle`（修改 design 源后首次再生成 rpc.rs/tools.rs/mcp_protocol.rs，二次）**Nothing to be done**（幂等）。
- `cargo check --workspace`：app/mcp/web/application/storage/domain/simlive/backtest 全编译通过。
- 单独确认：simlive 26 / application simlive 13 / mcp lib 25 + protocol 2 + tools_db 3 全绿。

## 7. 暂存文件清单（index 为空，未 commit，工作树保留改动供父级审阅）
新增：
- `crates/simlive/src/strategy_orchestrator.rs`
- `coder/report/073_simlive_l2_strategy.md`（本报告）

修改：
- `crates/simlive/src/lib.rs`、`crates/simlive/src/session.rs`
- `crates/application/src/simlive.rs`、`crates/application/tests/simlive.rs`
- `crates/mcp/Cargo.toml`
- `design/07-app-plane/01-mcp.md`（tangle 源）
- `crates/mcp/src/tools.rs`、`crates/mcp/src/rpc.rs`、`crates/mcp/tests/mcp_protocol.rs`（tangle 再生成）
- `Cargo.lock`（mcp 增 dev-deps 触发的 lock 更新）

## 8. 残留风险
1. **MCP Streamable HTTP 仍未实现**：沿用 L1 SSE 传输；Streamable HTTP 迁移需大改 server.rs + 协议测试（L1/L2 均列残留，非本次目标）。
2. **实时行情数据链未接入**：`process_bar(session_id, code, bar)` 为**最小单 bar 喂入入口**（任务允许「一班喂入即可，注明」）；真实 eestock WS 行情→驱动编排器需 application 侧接入（属后续 L2 实时源接线，本次未连）。
3. **`StrategyConfig.params` 不可 serde**：`backtest::ParamValue` 未实现 serde，故 `StrategyConfig` 不导出 serde（限制在 application/simlive 层持有；MCP 仅传可序列化的评估/清单，不传 params）。若未来 MCP 需在线配置策略参数，需另立可序列化的 params DTO。
4. **聚合开仓数量固定**：`DEFAULT_AGGREGATE_QTY=100.0` 为 L2 简化（来源 `aggregate_strategy`）；未做资金占比/整手规则（真实 A 股 1 手=100 股整手规则不纳入，与 L1 FeeModel 同口径）。
5. **`feed_bar` 对未覆盖标的一直累计 bar**：未覆盖标的仍记录行情（不评估），长期可能累积；已知标的集受限（≤30 股），风险低。
6. **`storage::alert_store::list_events_filters` 既有失败**（与本次无关）：共享 dev DB 数据污染（`ranged` 查询按 `last_fired_at` 窗口过滤但未按 source，历史残留事件落入窗口 → 预期 1 实际 2）。非本次改动引入（未动 alert 表/代码），`--skip` 后全 workspace 绿。
7. **session id / order id 全局单调计数器**：跨进程不唯一（L1 已有；多实例一致性属 L4 加固）。

## 9. 与任务边界一致
- 只做 L2（策略评分/聚合/统一开关/事件流/sim 策略工具）；未改 backtest 引擎逻辑；未触真实券商；未 commit。
- 每 stock 独立评分 + 聚合评分；聚合用于交易决策；统一交易开关（无每策略开关）。
- 3 策略 × 标的集（≤30 股）由 `StrategyConfig` 配置（未在代码层强制 ≤30，属配置约定）。

## 10. Acceptance Evidence

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "实现严格限定 L2 范围：新增 simlive::RealtimeStrategyOrchestrator + SignalEvent 事件流 + SimLiveService 统一交易开关/process_bar/信号查询 + MCP 三个 sim_* 策略工具；复用 backtest 现有 create_strategy/Indicators/Signal，未修改 backtest 引擎/策略内部逻辑；未触真实券商；未改既有迁移；未新增任何超出 L2 的功能（无 L3 记录/对比、无 web 面板、无真实行情接线）。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "独立验收证据齐全：changed-files（报告 §7）、tests-added（§5）、commands-run（§6：cargo test/clippy/tangle/check 全绿）、residual-risks（§8 共 7 项）、no-staged-files（index 为空，§7）、validation-output（363 passed/0 failed；clippy 0 warning；tangle 幂等）。"
    }
  ],
  "changedFiles": [
    "crates/simlive/src/strategy_orchestrator.rs",
    "crates/simlive/src/lib.rs",
    "crates/simlive/src/session.rs",
    "crates/application/src/simlive.rs",
    "crates/application/tests/simlive.rs",
    "crates/mcp/Cargo.toml",
    "crates/mcp/src/tools.rs",
    "crates/mcp/src/rpc.rs",
    "crates/mcp/tests/mcp_protocol.rs",
    "design/07-app-plane/01-mcp.md",
    "Cargo.lock",
    "coder/report/073_simlive_l2_strategy.md"
  ],
  "testsAddedOrUpdated": [
    "crates/simlive/src/strategy_orchestrator.rs (tests: signal_to_score, weighted_aggregate, aggregate_to_signal, orchestrator 3策略x2股票, feed_unknown_stock, strategy_state_isolated)",
    "crates/simlive/src/session.rs (tests: signal_event_recorded_reset_on_start)",
    "crates/application/tests/simlive.rs (tests: set_trading_on_buy_threshold_places_order, set_trading_off_only_scores, trading_on_no_threshold_no_order, get_strategy_signal_and_analysis, process_bar_unconfigured_errors)",
    "crates/mcp/src/tools.rs (via design source, tests: sim_list_strategies, sim_get_strategy_signal_and_analysis, sim_get_strategy_tool_param_validation; updated tool_list_schema_contract & rpc tools/list & mcp_protocol count)"
  ],
  "commandsRun": [
    { "command": "cargo test --workspace -- --skip list_events_filters", "result": "passed", "summary": "363 passed / 0 failed (skip 既有 flaky alert_store list_events_filters)" },
    { "command": "cargo test -p simlive", "result": "passed", "summary": "26 passed / 0 failed" },
    { "command": "cargo test -p application --test simlive", "result": "passed", "summary": "13 passed / 0 failed" },
    { "command": "cargo test -p mcp", "result": "passed", "summary": "lib 25 + protocol 2 + tools_db 3 = 30 passed" },
    { "command": "cargo clippy --workspace --all-targets", "result": "passed", "summary": "0 warning / 0 error" },
    { "command": "entangled tangle", "result": "passed", "summary": "首次再生成 rpc.rs/tools.rs/mcp_protocol.rs；二次 'Nothing to be done' (幂等)" },
    { "command": "cargo check --workspace", "result": "passed", "summary": "app/mcp/web/application/storage/domain/simlive/backtest 全编译通过" }
  ],
  "validationOutput": [
    "cargo test --workspace -- --skip list_events_filters: TOTAL passed=363 failed=0",
    "cargo clippy --workspace --all-targets: no warnings/errors",
    "entangled tangle: first run rewrote rpc.rs/tools.rs/mcp_protocol.rs; second run 'Nothing to be done'",
    "cargo check --workspace: Finished (app/mcp/web/application/storage/domain/simlive/backtest)",
    "git index: empty (0 staged files); working tree holds changes"
  ],
  "residualRisks": [
    "MCP Streamable HTTP 仍沿用 L1 SSE（未实现 Streamable HTTP，列残留）",
    "实时行情数据链未接入：process_bar 为最小单 bar 喂入入口；真实 eestock WS 行情接线属后续 L2",
    "StrategyConfig.params（backtest::ParamValue）不可 serde，MCP 不传 params；未来在线配置需另立可序列化 params DTO",
    "聚合开仓数量固定 DEFAULT_AGGREGATE_QTY=100（L2 简化，未做资金占比/整手规则）",
    "feed_bar 对未覆盖标的一直累计 bar（已知标的集受限，风险低）",
    "storage::alert_store::list_events_filters 既有失败（共享 dev DB 污染，与本次无关，--skip 后全绿）",
    "session/order id 全局单调计数器跨进程不唯一（L1 已有，属 L4 加固）"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增 simlive 实时策略编排器（评分/聚合/信号映射）+ signal 事件流 + application SimLiveService 统一交易开关/process_bar/策略信号查询 + MCP 3 个 sim_* 策略工具；修改 design tangle 源 + mcp 再生成文件 + mcp Cargo.toml dev-deps；复用 backtest 未改其逻辑。",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "工作树未暂存、未 commit（index 为空），改动保留供父级审阅。cargo test --workspace 需 --skip list_events_filters（既有 flaky，非本次引入）。"
}
```
