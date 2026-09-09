# P4a：eestock-rs 统一策略系统 — sim-live 切源（Registry 策略源 + QuickJS 实例）

- 任务：P4a（design/12-strategy-system/01-adr.md §13.6 切源口径定稿落地）
- 报告位置：`coder/report/121_simlive_strategy_source_switch_p4a.md`（本文件）
- 日期：2026-09-10

## 1. 问题与范围

sim-live 编排器内核从「backtest 内建 7 款 Rust 策略」切换为「Registry published 插件 +
QuickJS 实例」（保留骨架换内核：会话/账户/撮合/UI 配置流/会话记录全部不动）。
红线遵守：strategy-runtime / strategy-core / backtest **零改动**；migrations 零新增；
无新外部依赖（仅 workspace 内 crate 依赖边：simlive→strategy-runtime/strategy-core，
mcp dev-deps→strategy-core）。

## 2. 切源口径决策（任务书 + 父级裁决）

| 决策 | 口径 |
|---|---|
| 三档映射废止 | `Buy=100/Hold=50/Sell=0` 映射删除出 sim-live 评分路径；插件连续分 0-100 直通（host 已 clamp，G6）。聚合/阈值/信号判定语义**不变**（加权平均、60/40 可配、buy/sell/hold），复用 `weighted_aggregate`/`aggregate_to_signal` |
| 静默跳过废止 | 旧编排器「未知策略 create_strategy 返回 None 静默跳过」语义废止；实例化失败 = 会话启动失败（InvalidConfig → web 400 / MCP isError），显式报错含 strategy_id/version_id/sha256 |
| 破坏性 wire 变更（pre-1.0） | `sim_start_session` strategies 元素 `{strategy_id, version_id?, params, stocks, weight, stock_weights?}`；旧内建 id（dual_ma 等）不再接受 → 明确错误引导 `strategy_list`；MCP 工具描述已标注（sim_start_session / sim_list_strategies / sim_run_backtest_compare 三处） |
| 承载模型（父级决策点 1，批准 A） | QuickJS 实例 !Send → **每会话专用 worker 线程 actor 模式**：编排器本体在 crates/simlive 保持纯逻辑同步 !Send 可单测；application 层 `simlive_orch::OrchestratorHandle`（tokio mpsc bounded(4) + oneshot）。契约 4 条全部落地：① stop/end/重配 → drop sender → 线程退出（rx 断连即返回）；② worker panic → oneshot drop → 调用方 `OrchestratorDead` → 会话记错误事件 + 降级 ended（degrade_session），不毒化服务；③ async 侧 send().await + oneshot await，不阻塞 executor；④ 分层红线不破 |
| 回测对比（父级决策点 2，一处修正） | 每标的 1 个 ensemble run（WorkbenchService.submit）；slots=覆盖该标的的钉住策略（w[S,X]=stock_weights[X] ?? weight）；阈值=**会话钉住阈值**（非写死 60/40——裁决修正）；LumpSum{1.0} + cash_init + 会话 FeeModel；stop=None。run_ids 为 sr_ 前缀字符串（Vec\<i64\>→Vec\<String\>，wire 变更）。与切源前历史对比结果绝对值不可直接比，评分语义统一后可比性增强 |
| 事件流（父级决策点 3，批准） | `SessionManager.session_events: Vec<SessionEvent>`（tagged enum：plugin_error/circuit_breaker，含 ts/code/strategy_id/sha256/bar_index/error），内存态与 signal_events 同级不持久化；web `/api/sim-live/state` 附最近 50 条。熔断停用后按无覆盖处理；全部熔断 → 聚合中立 50 → 不产交易信号 |

## 3. position 注入设计（ABI §2.5）

- 应用层 `process_bar` 锁内取 `SimAccount.positions[code]`（qty/avg_cost）+ **成交台账 FIFO**
  推导当前持仓最早未平 lot 建仓时间（`simlive::current_entry_ts`，纯函数单测锁定）→
  `PositionInput`；台账缺失回退会话 start_ts。空仓 → `None`（插件见 null）。
- 编排器构建 `PositionSnapshot`：`bars_since_entry` 按本会话已见 bar 序列计数
  （entry_ts 早于首根已知 bar 按已知序列计，恢复残差注明）；`unrealized_pnl = qty ×
  (bar.close − avg_cost)`（avg_cost 为 SimAccount 加权成本**未摊费用**，与 PositionView 一致）。
- 端到端测试：position_gate 插件（空仓 80/持仓 20）驱动真实建仓→平仓闭环。

## 4. 钉住与恢复设计

- **启动钉住**：`resolve_pinned_configs`——策略存在（未知 id → 400 + strategy_list 引导）→
  版本定格（显式 version_id 须属于该策略且 published；缺省 = 最新 published；无 published →
  400）→ params 按版本 schema 校验/缺省填充（ABI §1 NIT-6 消费方职责）→
  `PluginStrategyConfig{strategy_id, version_id, version, sha256, name, code, params, stocks,
  weight, stock_weights}`。上限：≤3 策略 / 每策略 ≤30 股（ADR §4 沿用，现显式强校验）。
- **落盘**：simsession_state.strategy_configs 改 schema=2 对象 `{schema, buy_long_threshold,
  sell_threshold, strategies:[...]}`（code 不落盘——version_id 为单一事实源）；domain 端口
  零改动（字段本就 serde_json::Value），无 migration。
- **恢复**：`reinstantiate_pinned` 逐钉住项读 strategy_version 表：存在 + 仍 published +
  strategy_id/sha256 与钉住一致 + **sha256_hex(code) 复核**（published 不可变由 DB trigger
  保证，此为双保险）→ 取表内 code 重建 worker。任一失败 → Err → 既有降级口径
  （ended + degraded_result(reason) 注解 + warn 告警）。旧内建形状（数组非空）→ Legacy →
  降级 ended。

## 5. 变更文件

| 文件 | 变更 |
|---|---|
| crates/simlive/src/plugin_orchestrator.rs（新） | PluginStrategyOrchestrator（纯逻辑 !Send）+ PluginStrategyConfig/PositionInput/OrchestratorError/current_entry_ts；上限 MAX_STRATEGIES=3/MAX_STOCKS_PER_STRATEGY=30 |
| crates/simlive/src/plugin_orchestrator_tests.rs（新） | 编排器单测（mock runtime + 真实 QuickJS） |
| crates/simlive/src/session.rs | SessionEvent tagged enum + SessionManager.session_events（record/read/reset/restore） |
| crates/simlive/src/strategy_orchestrator.rs | RealtimeStrategyOrchestrator/StrategyConfig/signal_to_score/signal_str 标 #[deprecated]（P4b 物理删除）；聚合纯函数保留 |
| crates/simlive/src/lib.rs / Cargo.toml | 再导出 + strategy-runtime/strategy-core 依赖边 |
| crates/application/src/simlive_orch.rs（新） | worker 线程承载壳（OrchestratorHandle/FeedOutcome/OrchestratorDead/spawn_orchestrator[_async]）+ 契约测试 |
| crates/application/src/simlive.rs | 切源主体：wire（StrategyConfigInput/StartSessionReq+阈值）/ 钉住解析 / worker 生命周期 / process_bar 三段式（锁内取持仓→锁外 await→锁内交易+事件）/ 恢复重建 / configure_strategies 重钉 / feed_targets 不再自动配置 / 对比走 Workbench / session_events + pinned_thresholds 查询 / degrade_session |
| crates/application/tests/simlive.rs | MockStrategyStore + 既有测试迁移新口径 + P4a 新增 12 用例 |
| crates/mcp/src/tools.rs（tangle↔design/07-app-plane/01-mcp.md） | sim_start_session schema/handler（新 wire + 阈值 + 破坏性标注）；sim_list_strategies → Registry catalog（async）；sim_run_backtest_compare 描述注口径；测试迁移 + 新增 wire 拒绝用例 |
| crates/web/src/simlive.rs | /strategies 名称/配置取自钉住快照（含 version/sha256）；/state 附 session_events 最近 50 条 |
| crates/app/src/bin/eestock-app.rs（tangle↔design/07-app-plane/00-web-api.md） | 装配：strategy_store 共享实例；SimLiveService.with_strategies + with_workbench（构造顺序移至 workbench 之后，消费式 builder）；移除 with_backtest |
| web/src/api/types.ts、mock.ts、mock.test.ts | SimStrategyConfigInput→strategy_id/version_id；SimPinnedConfig；SimSessionEvent；run_ids string[] |
| web/src/features/simlive/{SimLivePage,panels}.tsx + 测试 | 策略下拉 → getStrategyCatalog({kind:'strategy'})（Registry 数据源）；参数表单适配插件 schema（int/float）；start body strategy_id |
| design/12-strategy-system/01-adr.md | §13.6 P4a 落地注记回写 |
| Cargo.lock | 依赖边更新 |

## 6. 测试矩阵（TDD）

- **编排器单测**（simlive，Red→Green 严格）：评分直通+聚合不变 / stock_weights 覆盖 /
  未覆盖不评估 / params 透传 / 实例化失败显式 Err / 上限 3×30 / position 注入（真实 QuickJS
  门控 + bars_since_entry 回显）/ G5 中立分+事件+熔断+成功清零 / 熔断告警事件 /
  全熔断→中立 50→hold / session_events 生命周期 / current_entry_ts FIFO。
- **worker 承载壳**（application::simlive_orch）：feed 往返 / 坏代码 spawn Err /
  drop 句柄线程退出 + 重 spawn 互不干扜。
- **服务集成**（application/tests/simlive.rs，51 绿）：钉住（缺省最新 published / 显式版本）/
  wire 错误（未知 id 引导 strategy_list / 无 published / draft version_id / 张冠李戴 /
  >3 策略 / >30 股 / Registry 未注入 / 阈值倒挂）/ 自定义阈值钉住生效 / position 注入 E2E /
  G5 事件流 E2E（10 plugin_error + 1 circuit_breaker + 熔断后不下单）/ 恢复（成功重建续跑 +
  archived 版本降级 + legacy 形状降级）/ 对比走 ensemble（钉住 slots/阈值/policy 断言 +
  手动会话报错 + 未知会话报错）/ feed_targets 纯手动会话不轮询。
- **MCP**（42 lib + 集成 5 绿）：新 wire happy/拒绝（旧内建 id isError + 引导文案）/
  catalog 数据源形状 / 对比 ensemble 钉住断言。
- **web**（49 lib + REST 集成全绿）；**前端** vitest simlive+api 116 绿（全量 492 绿 /
  7 failed 为 alerts pre-existing，干净 HEAD 同败）。

## 7. 验证命令与结果

- `cargo test -p simlive -p application -p mcp -p web` → **293 passed / 0 failed**
- `cargo build --workspace` → 0 error
- `cargo clippy --workspace --all-targets` → 新增 0 warning（diff 前后告警清单：仅 pre-existing
  行号位移；storage/reader.rs:222 等为存量）
- `entangled tangle` → Nothing to be done（tools.rs/eestock-app.rs 已回写 design 源；
  --force 同步 db 后复跑无 diff）
- `cargo test --workspace` → 唯一失败 storage alert_store::list_events_filters 为
  pre-existing（干净 HEAD 复现同败；P3c 提交注记同源）

## 8. 遗留风险 / 后续

1. **web/e2e/simlive-deep.e2e.ts 未适配**（playwright 需 docker 栈，不在本任务验收命令内；
   且 P3c 起 A1 工具数断言已 stale）。需后续任务把 hardcode 内建 id 改为 strategy_list 动态发现。
2. **worker panic 隔离路径**仅有契约层测试（oneshot drop → OrchestratorDead），未注真 panic
   故障注入（QuickJS 实例在沙箱内不 panic；风险低）。
3. 恢复后插件内部状态（如 dual_ma prevAbove）不恢复（沿用既有「残差：重启前实时评分丢失」
   口径；钉住配置/账户/持仓/订单完整）。
4. process_bar 的 position 快照在锁外评估期间可能与并发手动单有微妙交错（评估用 bar 时刻
   持仓，下单判定用最新账户——语义自洽，已注明）。
5. P4b 待办：物理删除 RealtimeStrategyOrchestrator/内建策略 + 旧 wire 清理。
