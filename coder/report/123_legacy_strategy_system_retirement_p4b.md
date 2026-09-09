# 123 — P4b 旧策略系统退役（物理删除，D16 终章）

- **报告位置**：`coder/report/123_legacy_strategy_system_retirement_p4b.md`（eestock-rs/ 下）
- **日期**：2026-09-10
- **状态**：已 stage 未 commit（76 文件，+217/−10505）

## 任务

按 design/12-strategy-system/01-adr.md §11 P4 / §13.6 / §13.8 与架构裁决（彻底删除而非仅隐藏），
物理删除旧回测服务链、backtest crate 旧引擎+7 款内建策略、simlive 旧编排器、旧回测前端页。

## 架构冲突裁决（contact_supervisor，方案 A 批准）

任务书「删除 backtest engine.rs/strategies.rs」与「禁止删除任何 strategy-core 文件」在实现现实中冲突
（strategy-core 3 处测试依赖被删符号）。父级裁决**方案 A**：
- 删 `strategy-core/tests/equivalence.rs`（迁移等价性套件，并存期验收使命完成，旧参照物消失后不可运行亦无需运行）；
- `strategy-core/tests/engine.rs` 删旧引擎费用 parity 交叉验证尾部、保留 ensemble 自身断言（测试改名
  `e2e_buy_hold_force_close`）；
- `strategy-core/src/reference.rs` 插件顺序断言改硬编码 7 款 id（`dual_ma/ma_rsi/macd/boll/kdj/momentum/atr_channel`）。
- ABI 共用类型 `ParamValue`/`StrategyParams` 自 strategies.rs **迁入 types.rs**（批准报备），strategies.rs 整文件删除。

## 删除清单逐项 → 引用核查 → 保留判定

### 1. 旧回测服务链（已删）
- `application/src/service.rs`（BacktestService）、`params.rs`（网格展开）、`types.rs`（SubmitReq/SubmitOutcome）、
  `application/tests/service.rs` — 引用方仅 web/backtest.rs、app bin、自身测试，全删。
- `crates/web/src/backtest.rs`（REST handlers + BacktestWsSink，手写）、`crates/web/tests/api_backtest.rs`（手写）— 删除。
- web 路由 `/api/backtest/*`（lib.rs）、AppState `backtest`/`backtest_ws` 字段（state.rs）、旧 DTO/校验
  （dto.rs：BacktestSubmitReq/BacktestListQuery/BacktestCompareQuery/BacktestRunDto/BacktestStrategyDto/
  MetricsDto/TradeDto/parse_backtest_ids 等）— 经 design/07-app-plane/00-web-api.md tangle 源删除。
- WS：`Topic::Backtest`、`PushMsg::BacktestProgress`、`Subscription.run_id`、client subscribe run_id 字段 — ws.rs tangle 源同步删除。
- app bin BacktestService DI（eestock-app.rs，tangle 源）删除；`backtest_hub`（WsHub）保留——workbench sink 与 AppState.hub 复用。
- **保留判定**：
  - `BacktestBarRead` port / `storage::backtest::BacktestBarReader` — **保留**（application::strategy 试算、
    workbench、mcp bt_* 工具复用同一取数口径；逐引用核查：strategy.rs:31/325、workbench.rs:37/155、
    mcp/tools.rs:1277/2036、app bin ×3）。
  - `application/src/fee.rs`（to_fee_model）— **保留**（workbench.rs:44 复用）。
  - `parse_period`/`to_bt_bar` — **保留**，迁新模块 `application/src/bar_map.rs`（strategy.rs:623、
    workbench.rs:204/276 复用；strategy.rs 内另有私有同口径 to_bt_bar 未动）。
  - `domain::ports::validate_backtest_fee`（web dto.rs）— **保留**（workbench.rs:159 POST /api/workbench/runs 复用，
    删除后编译暴露，已在 tangle 源恢复并配专测 `backtest_fee_validation`）。
  - `dto.rs` 的 `Metrics`/`Trade`（api/types.ts 同名）— **保留**（页面⑪ 工作台与⑨ sim-live 沿用该 jsonb 形状）。
- **删除**：`BacktestRunStore`/`BacktestProgressSink` 端口 + `RunStatus/NewRun/RunFilter/RunResult/RunView`
  （domain/ports.rs，tangle 源 contracts.md；contracts_test.rs 对应测试同步删）；
  `storage::backtest::PgBacktestStore`（storage/src/backtest.rs 手写）及其 3 个集成测试
  （storage/tests/backtest.rs 仅保留 bar_read_m1_accurate_first_in_range）。
  backtest_runs/backtest_results 表与迁移 0011/0012 不回收（DB 侧无破坏性变更）。

### 2. backtest crate 摘除（已删）
- 删 `engine.rs`（Engine/run/run_with_progress，291 行）、`strategies.rs`（7 款内建策略 + create_strategy/
  builtin_strategies/builtin_strategy_catalog/builtin_strategy_ids，1260 行）、`tests/golden_sample.rs`
  （旧引擎黄金样本）。
- 引用核查：`Engine/run/run_with_progress/create_strategy/builtin_*` 的 workspace 引用方 = application/service.rs（删）、
  simlive/strategy_orchestrator.rs 旧编排器（删）、strategy-core equivalence.rs（裁决删）、
  strategy-core/tests/engine.rs:156（裁决改）、strategy-core/src/reference.rs:111（裁决改）。无残留。
- **保留**：fee.rs/indicators.rs/metrics.rs/types.rs + lib.rs 再导出（strategy-core/simlive/strategy-runtime/
  application/mcp 引用 Bar/Period/FeeModel/Indicators/compute_metrics/ParamDef/ParamKind/Signal/Ctx/Strategy/
  TradeDetail 等）。`ParamValue`/`StrategyParams` 迁入 types.rs（取舍：strategies.rs 整文件可删，types.rs 本在
  保留清单，迁移优于原位留残）。`RunConfig`/`BacktestResult`/`StrategyResult` 无消费方但作为公开类型保留于
  types.rs（最小删除原则；pub 项无 dead_code 告警）。

### 3. simlive 旧编排器（已删）
- `RealtimeStrategyOrchestrator`/`StrategyConfig`/`signal_to_score`/`signal_str` 及其 4 个专属测试删除。
- **保留**（plugin_orchestrator.rs:38/253/273/330、application/simlive.rs、simlive_orch.rs 复用）：
  `weighted_aggregate`/`aggregate_to_signal`/`StockEvaluation`/`StrategyScore`/`NEUTRAL_SCORE`/
  `DEFAULT_BUY_LONG_THRESHOLD`/`DEFAULT_SELL_THRESHOLD` + 两个聚合纯函数测试。模块名 strategy_orchestrator 保留
  （避免新编排器 import 路径churn；文件头注释已重写说明）。

### 4. 旧回测前端（已删）
- 删：features/backtest 的 BacktestPage(+test)/CompareView/GridRank/MetricCards/PeriodHeatmap/
  ResultOverview(+test)/store(+test)/StrategyForm(+test)/TaskList(+test)/TradeDetailModal(+test)/TradeTable；
  layouts/BacktestGrid.tsx（tangle）+ design/06-web/preview/05-backtest.html（tangle，源 05-backtest.md
  代码块已移除并加退役 banner）；api client/mock/types 旧回测族（getStrategies/submitRun/listRuns/getRun/
  compare/deleteRun、Backtest* 类型、mock 种子/helpers）+ client.test.ts/mock.test.ts 旧回测测试。
- **保留**（逐引用核查，workbench 复用）：chartUtils.ts（workbench/chartUtils re-export + 4 组件）、
  format.ts（workbench 6 组件）、ScopedKlineFeed.ts（KlineResultChart）+ 三者测试；
  markerSnap.test.ts（测的是 dashboard/KlineChart 的 snapTsToBars，保留符号）。
- 导航：navItems.ts 删 ⑤ /backtest 项（NavBar.test.tsx/AppShell.test.tsx 同步 11→10 项）；
  App.tsx /backtest 路由改为 `<Navigate to="/backtest-workbench" replace>` 重定向。
- TradeDetailModal/KlineChart 核查：TradeDetailModal 仅 BacktestPage 引用 → 删；KlineChart 属 dashboard 未动。

### 5. MCP（核查，无删除）
- tools.rs 工具族清单核查：sim_*（11-sim-live）、strategy_*（P2/P3c）、bt_*（P3c 新工作台工具）——
  **无旧回测工具**，零改动。mcp 测试全绿（42+2+3）。

### 6. 文档收尾（已完成）
- design/12-strategy-system/01-adr.md §11 P4 行标注「P4b 已完成删除（2026-09-10）」。
- design/99-decisions-log.md 追加「旧策略系统退役」条目（删除/保留判定全量）。

## 层级归属（架构对齐）
- domain：ports.rs 旧端口/类型删（tangle：contracts.md）— 契约层收口。
- storage：PgBacktestStore 删、BacktestBarReader 留 — 基础设施层。
- application：BacktestService 删、bar_map 共享件留 — 应用层。
- web/mcp：旧 REST/WS/DTO 删（tangle：00-web-api.md、02-alerts.md）— 表现层；mcp 零改动。
- strategy-core/simlive/backtest：纯逻辑层，按裁决执行。
- 前端：页面⑤ 退役、⑪ 为唯一回测入口。

## 验证证据（逐步）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 编译 | `cargo build --workspace` | 0 error |
| 全量测试 | `cargo test --workspace --no-fail-fast` | 86 套件 85 ok；唯一失败 = storage alert_store `list_events_filters`（**pre-existing**，HEAD stash 复跑同样 FAILED，证据见下） |
| clippy | `cargo clippy --workspace --all-targets` | 与 HEAD 基线逐条 diff 一致（8 项固有 warning，**新增 0**） |
| tangle | `entangled tangle`（非 force） | 无 write/无 WARNING/无 ERROR（无 diff） |
| 前端构建 | `cd web && npm run build` | 0 error（✓ built in 1.66s） |
| 前端测试 | `npm test` | 431 passed / 7 failed —— 7 项全为 alerts（**pre-existing**：HEAD stash 复跑 alerts 同样 7 failed） |
| 新系统抽查 | `cargo test -p strategy-core -p simlive -p mcp -p application` | 全绿：strategy-core 32+23+6+3、simlive 40、mcp 42+2+3、application 8+55+28+13 |

pre-existing 复核：`git stash -u` 后 HEAD 分别复跑 `cargo test -p storage --test alert_store`
（list_events_filters FAILED 同现）与 `npx vitest run src/features/alerts`（7 failed 同现），随后 stash pop 恢复。

## 意外发现 / 处理记录
1. **tangle 漂移（pre-existing）**：P3a 曾绕开 design 源直接改 5 个 tangle 测试文件（ws_poller 等），
   md 块缺 `workbench: None` 字段与 `strategy_run_id` 订阅字段。本次在 design 源补齐（修复漂移）后再 tangle。
2. **entangled 2.4.3 bug**：目标文件被物理删除后 `entangled tangle` 崩溃（FileNotFoundError）。处置：
   从 `.entangled/filedb.json`（gitignored 工具状态）摘除两个已删目标条目后正常。
3. `validate_backtest_fee` 初删后暴露 workbench.rs:159 复用 → tangle 源恢复（见保留判定）。

## 遗留风险
- backtest_runs/backtest_results 表现存但无任何代码读写（DB 残留数据无害；如需回收另起迁移任务）。
- design/07-app-plane/00-web-api.md §1.5 旧 API 散文段落未改写（代码块已删；散文为历史记录，
  ADR §13.8 + 99-decisions-log 已标注退役）。如父级要求可将 §1.5 散文一并标注。
- `types.rs` 保留的 `RunConfig`/`BacktestResult`/`StrategyResult` 暂无消费方（公开类型，无告警；
  如需进一步瘦身另议）。
- 旧回测页 URL 书签经 301 重定向兜底，无功能真空。

## 变更文件统计
76 文件 staged：+217 / −10505。新增仅 `crates/application/src/bar_map.rs`（共享件迁移）。
