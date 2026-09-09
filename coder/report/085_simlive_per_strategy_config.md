# 085 — sim-live 加「per-策略参数 + 策略×标的映射（+权重，含策略×股票级权重）」

> 本报告文件位置：`eestock-rs/coder/report/085_simlive_per_strategy_config.md`

## 需求
ADSR 11-sim-live §4 多策略 + 用户确认的「策略×股票」级权重。原会话配置为策略级多选 × 标的级多选（笛卡尔积、默认参数）。
改为：**每策略单独参数**（schema 驱动）+ **每策略指定股票子集** + **每策略权重** + **每策略×股票级权重**。
若提供 `strategies` 则用之；未提供回退 `strategy_set × stock_set`（缺省参数、weight=1）。

## 实现要点（在既有 sim-live 架构内）
- **`crate simlive`（`strategy_orchestrator.rs`）**：`StrategyConfig` 增 `stock_weights: HashMap<String,f64>`；
  `evaluate` 聚合权重改为 `w[S,X]=stock_weights[X] ?? weight`（`Σ(w·score)/Σ(w)`）；新增 `configs()` 供展示。
- **`crate application`（`simlive.rs`）**：新增 `StrategyConfigInput{id,params,stocks,weight,stock_weights}`（serde 默认 params={}/weight=1/stock_weights={}）；
  `StartSessionReq` 增 `strategies`；`InvalidConfig` 错误类型；`validate_strategy_config_input`（id 内置、params 按 schema、stocks 注册、weight>0、stock_weights 键∈stocks 且值>0）；
  `start_session` 提供 strategies → 校验 + 转 `StrategyConfig` 配置编排器，会话级 `strategy_set/stock_set` 由策略派生（去重、保序）；未提供 → 原回退。
  新增 `strategy_configs()` + `strategy_params_to_json()`；`feed_targets` 自动配置补 `stock_weights: Map::new()`。
- **`crate web`（`simlive.rs`）**：`start-session` handler 把 `InvalidConfig` 映射 **400**；`strategies` 端点每策略附 `config{params/stocks/weight/stock_weights}` 供面板展示。
- **`crate mcp`（`tools.rs` + `design/07-app-plane/01-mcp.md`）**：`sim_start_session` schema + handler 解析 `strategies`（含 stock_weights），透传；tangle 幂等（`entangled tangle` → Nothing to be done）。
- **前端**：`types.ts` 增 `SimStrategyConfigInput`，`SimStartSessionReq.strategies`，`SimStrategySummary.config`；
  `panels.tsx` `SessionControl` 每选中策略渲染「单策略卡」（schema 参数编辑 / 标的子集 multi-select / 权重 / 每标的权重），start 带 `strategies`（优先于简单档）；
  `StrategyPanel` 展示每策略 参数/标的/权重/标的权重；`store.ts` `startSession` 透传 `strategies`；`mock.ts` 按 strategies 派生会话集 + 权重聚合评分 + config。

## 分层归属
- 纯逻辑/领域：`crates/simlive`（编排器聚合，复用 backtest，未改 backtest 引擎）。
- Application：`crates/application`（校验/转换/会话派生）。
- Presentation：`crates/web`（REST + 400 映射）、`crates/mcp`（sim_* 工具）、`web/src`（前端 UI）。
- 未改 backtest 引擎、未触真实券商、未 commit。

## TDD 覆盖
- **simlive crate**：`orchestrator_stock_weights_override_default_weight`（策略×股票权重改变聚合分，固定输入参考运行断言）。
- **application**：`start_session_with_strategies_wires_orchestrator`（每策略 params/stocks 生效、会话集派生、未覆盖不评估）；`start_session_invalid_strategies_rejects`（未知 id/weight≤0/params 越界/未知标的/空标的集/stock_weights 键不在集/值≤0 → InvalidConfig）。
- **mcp**：`sim_start_session_with_strategies_wires_orchestrator`；`sim_start_session_invalid_strategies_is_error`。
- **前端**：`SimLivePage.test.tsx`「选中策略渲染单策略卡…→ start body 含 strategies」；`mock.test.ts`「startSimSession 带 strategies → 派生加权聚合评分」；既有 `store.test.ts` 简单档（不带 strategies）保留。

## 验证
- `cargo test --workspace --no-fail-fast`：除既有 flaky `crates/storage/tests/alert_store.rs::list_events_filters`（storage 不依赖本次改动 crate，预存失败）外全绿。simlive 27、application simlive 28、mcp 31+2+3、web 全绿。
- `cd web && npx vitest run`：39 文件 / 360 测试全绿。
- `cd web && VITE_API_MOCK=0 npx tsc -b && VITE_API_MOCK=0 npx vite build`：构建成功。
- `entangled tangle`：`Nothing to be done`（MCP tools.rs 与 design 幂等同步）。

## 残留风险
- **「注册标的」校验口径**：按 03-symbols §3 的 6 位数字 + 市场前缀（`domain::types::Code::market`）校验，未依赖 symbols 注册表（SimLiveService 不持注册表端口，避免扩依赖图）。如未来要求严格「仅注册表存在标的」，需注入 SymbolRegistry 端口。
- **web 400 映射**：`InvalidConfig → StatusCode::BAD_REQUEST` 由 handler 分支实现；应用层（InvalidConfig error）+ MCP isError 均已测，web handler 分支经代码检查确认，未单独写 web 集成测试（web 测试为真实 DB 集成，成本高）。
- **后端 `/api/sim-live/strategies` 附 config**：已实现并供前端展示；mock 同构。若未来策略集变更后 config 需按最新策略同步，编排器 configs() 为快照。
- **预存 flaky**：`crates/storage/tests/alert_store.rs::list_events_filters`（from/to 窗口计数 2 vs 1）与本次改动无关（storage 不依赖 application/simlive/mcp）。

## 暂存文件清单
未 `git add`（留工作区供父级审查；`noStagedFiles: true`）：
```
crates/application/src/simlive.rs
crates/application/tests/simlive.rs
crates/mcp/src/tools.rs
crates/simlive/src/strategy_orchestrator.rs
crates/web/src/simlive.rs
design/07-app-plane/01-mcp.md
web/src/api/mock.test.ts
web/src/api/mock.ts
web/src/api/types.ts
web/src/features/simlive/SimLivePage.test.tsx
web/src/features/simlive/panels.tsx
web/src/features/simlive/store.ts
```
本报告：`eestock-rs/coder/report/085_simlive_per_strategy_config.md`。
