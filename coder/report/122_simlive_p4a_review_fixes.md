# P4a 评审修复包：sim-live 切源 review findings（4 MINOR + NIT-3/5）

- 任务：reviewer「可合入」4 MINOR + NIT 修复（架构裁决已定；MINOR-4 为 strategy-core 红线豁免项）
- 报告位置：`coder/report/122_simlive_p4a_review_fixes.md`（本文件）
- 基线：报告 121（P4a 切源主体，已 staged）；日期：2026-09-10
- 红线遵守：除批准的 strategy-core `validate` 加法外，strategy-runtime/backtest **零改动**；
  domain ports.rs 注释经 design 源 `contracts.md` 修改 + `entangled tangle` 再生成；无新外部依赖、
  无新 crate 依赖边（panic/gate 注入复用 application 已有的 strategy-runtime 依赖边）。

## 1. finding → 修复 → 测试证据对应表

| Finding | 修复（文件:位置） | 测试证据（Red→Green） |
|---|---|---|
| **MINOR-1** 在飞 bar 在 ended 会话补成交；configure_strategies 在飞期间旧 worker 迟到 eval 写 latest | `application/src/simlive.rs`：`LiveSession.generation` 代际字段（start/恢复=0，configure/inject +1）；`process_bar` 阶段 1 捕获 `(handle, generation, position)`；阶段 3 锁内下单前守卫「会话仍 Running 且代际未变」——迟到结果整体丢弃（不下单/不写 latest/不归集事件）；未覆盖标的分支的事件归集同守卫 | `tests/simlive.rs::p4a_late_feed_after_stop_does_not_trade`（门控插件阻塞 on_bar → 确定性在飞窗口 → stop → 释放 → 断言不落 sim_trades/无订单/latest 空）；`p4a_late_eval_from_replaced_worker_does_not_pollute_latest`（在飞期间 configure_strategies 重配 → 旧 worker 迟到 eval 不写 latest）。**Red 验证**：临时 `if false` 禁用守卫两测试均 FAILED，恢复后 ok |
| **MINOR-2** entry_ts 口径对齐引擎 sticky-first-entry | `simlive/src/plugin_orchestrator.rs::current_entry_ts` 由 FIFO 最早未平 lot 改为 sticky-first-entry（空仓以来首笔建仓 ts 钉死；加仓/部分卖出不前进；清仓后重新钉），与 strategy-core `Holding.entry_ts` 一致；avg_cost 含佣金差异在头注释注明「有意保留，勿对齐」；doc 同步（模块头/`PositionInput.entry_ts`/函数 doc/`simlive.rs::position_input` doc/ADR §13.6） | `plugin_orchestrator_tests.rs::current_entry_ts_sticky_first_entry`（卖超 FIFO 首 lot 仍钉 100——旧实现返 105，**Red 确认**；清仓→None→重钉 130；卖超损坏数据防御 None）；`partial_sell_keeps_entry_ts_and_bars_since_entry_monotonic`（部分卖出后 echo 插件回显 bars_since_entry = 0,1,2,3 不分叉） |
| **MINOR-3a** worker 退出观测 | `application/src/simlive_orch.rs`：`OrchestratorHandle` 持 `Arc<JoinHandle>`；新增 `WorkerExitProbe`（`is_finished` 观测 OS 线程实际退出；不持通道所有权）+ `exit_probe()` | `simlive_orch::tests::worker_thread_actually_exits_after_handle_drop`（drop 句柄 → 探针 2s 内报退出；drop 前存活断言） |
| **MINOR-3b** panic 故障注入 → OrchestratorDead → 降级 ended | `simlive_orch.rs`：新增 `spawn_orchestrator_with(build)` 泛化入口（构造闭包在 **worker 线程内**执行——编排器 !Send 不能捕获跨线程），`spawn_orchestrator` 委托之；`simlive.rs` 新增 `#[doc(hidden)] __test_inject_orchestrator`（测试故障注入，同 configure 语义：旧句柄 drop + 代际 +1） | 承载壳级：`worker_panic_yields_orchestrator_dead_and_thread_exits`（PanicRuntime 真 panic → feed 收 OrchestratorDead + 线程实际退出 + 后续 feed 仍 Err）；应用层：`p4a_worker_panic_degrades_session_to_ended`（真 panic → process_bar Err → 内存+落库 ended + 降级事件入流 + 再 feed 明确报错 + 不落成交） |
| **MINOR-4** 阈值夹中立 50 校验（strategy-core 红线豁免已批准） | `strategy-core/src/engine.rs::EnsembleConfig::validate` 增加 `buy > 50 && sell < 50`（doc 注明「全熔断→中立 50→Hold」契约）；`simlive/src/plugin_orchestrator.rs::new` 同规；`application/src/simlive.rs::start_session` 校验同规（InvalidConfig → web 400 / MCP isError，映射既有：web/src/simlive.rs:218） | strategy-core：`tests/engine.rs::ensemble_config_validate_rejects_illegal_configs` 增 4 例（45/40、50/40、60/50、60/55；**Red 确认**）；simlive：`thresholds_must_straddle_neutral_50`（45/40 等 6 例，**Red 确认**）；application：`p4a_thresholds_must_straddle_neutral_50`（45/40 → InvalidConfig 且错误含「50」；50/55 恰值/越界拒绝）。既有用例核查：全 workspace 无 45/40 类「旧合法新非法」用例需适配（workbench 30/50、simlive 40/60 倒挂用例新规则下仍 Err；70/30 仍合法） |
| **NIT-3** 陈旧注释/测试名 | `simlive_feed.rs` 头注释步骤 1 改为「仅 running+已钉住编排器会话，feed 不再自动配置」；测试更名 `feed_targets_auto_configures_session_strategies` → `feed_targets_returns_pinned_session_poll_targets`（doc 同步）；`domain/ports.rs:710 strategy_configs` 注释 → 改 design 源 `design/02-domain/contracts.md` 后 `entangled tangle` 再生成（schema=2 对象形状） | 更名后测试仍绿；`entangled tangle` 复跑 Nothing to be done |
| **NIT-5** position_snapshot_fields_full 补实际断言 | `plugin_orchestrator_tests.rs`：`ScriptedInstance.seen_positions` 改为 `Rc<RefCell>` 共享记录器（`MockRuntime.recorders` + `seen_positions()` 访问口） | `position_snapshot_fields_full` 现实际断言 qty=200/avg_cost=9/entry_ts=100/bars_since_entry=1/unrealized_pnl=400（原先仅注释口径锁定） |

附带文档同步（保持 design 与实现一致，均非 tangle 文件或与 tangle 配对回写）：
- `design/12-strategy-system/01-adr.md` §13.6：position 注入 entry_ts 口径改 sticky-first-entry
  （MINOR-2 注记）+ 阈值夹中立 50 校验条目（MINOR-4 注记）。
- `design/07-app-plane/01-mcp.md` + `crates/mcp/src/tools.rs`（tangle 再生成）：
  sim_start_session 阈值 description 补「夹中立 50 契约」。

## 2. 分层归属

- strategy-core（Domain 内核）：仅批准的 validate 加法 + 注释（红线豁免项）。
- simlive（纯逻辑）：`current_entry_ts` 语义 + 编排器构造校验 + 注释——纯函数/构造器内改动，无边界变化。
- application（应用层）：`simlive_orch.rs` actor 壳（探针 + 泛化 spawn，接口为纯加法）；
  `simlive.rs` 服务（代际守卫 + 校验 + doc-hidden 测试注入钩子）；`simlive_feed.rs` 注释。
- domain：仅注释，经 contracts.md → tangle 生成（流程合规）。
- mcp：description 文案，经 design 源 → tangle（流程合规）。

## 3. 验证命令与结果

- `cargo test -p simlive -p application -p strategy-core` → **249 passed / 0 failed**
  （simlive 43→45；application lib 13→15、tests/simlive 51→55；strategy-core 82→86 含新增断言组）。
- `cargo test -p web -p mcp` → 134 passed / 0 failed（tools.rs 文案再生成后回归）。
- `cargo build --workspace` → 0 error。
- `cargo clippy -p simlive -p strategy-core --all-targets` → 0 warning；
  `cargo clippy -p application --all-targets` → 5 warning 全部为 pre-existing
  （stash 隔离基线对比：改动前同为 5——2×doc_lazy_continuation + 2×four_forward_slashes +
  1×iter_overeager_cloned，均在未改动代码行，仅行号位移）；新增代码 0 warning。
- `entangled tangle` → Nothing to be done（contracts.md/01-mcp.md 改动已 tangle 落盘且无 diff）。
- MINOR-1 守卫 Red↔Green 双向验证：禁用守卫 → 2 测试 FAILED；恢复 → ok。

## 4. 遗留风险 / 注记

1. 恢复路径：切源后至本修复前启动的会话若持久化了「非夹 50」自定义阈值（如 45/40），
   重启恢复时编排器重建会因新校验 Err → 按既有口径降级 ended（可接受的 fail-closed；
   实际窗口极小——P4a 尚未发布上线）。
2. `__test_inject_orchestrator` 为 doc-hidden 测试钩子（MINOR-3 故障注入唯一可行路径：
   JS 异常由 QuickJS 捕获走 G5，无法经生产路径触发 worker panic）；生产路径不使用。
3. 门控插件测试依赖 worker 线程阻塞语义（std mpsc），已用 entered 信号保证确定性在飞窗口，
   无 sleep 竞态。
4. P4b 待办不变：物理删除 deprecated RealtimeStrategyOrchestrator + 旧 wire 清理。
