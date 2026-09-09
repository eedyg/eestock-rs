# 049 — P3a 回测工作台后端（任务制 ensemble 运行 + WS 进度 + 组合预设）

> 报告自身位置：`coder/report/049_strategy_workbench_p3a.md`
> 任务：12-strategy-system / P3a（ADR design/12-strategy-system/01-adr.md §6/§8/§11/§13.4/§13.5）。
> design/12-strategy-system/ 未改（只读权威文档）。

## 1. 变更文件清单（tangle 生成物已标注）

### 设计文档（事实源，tangle 输入）
- `design/02-domain/contracts.md` — §2.4 ports.rs 块末尾加法：StrategyRunStatus/NewStrategyRun/
  StrategyRunResult/StrategyRunView/StrategyRunFilter + `StrategyRunStore` + `StrategyPresetStore`
  （含 `find_preset_by_name`）+ `StrategyRunProgressSink` 端口与行类型/DTO。
- `design/04-storage/schema.md` — 新增 §4.3.14（表口径/迁移块/ storage 模块契约描述）。
- `design/04-storage/02-tushare-sync.md` — storage lib.rs 注册 `pub mod workbench;`。
- `design/04-storage/03-raw-writer.md` — migrate_check EXPECTED_RELATIONS 加
  strategy_run/strategy_run_result/strategy_preset。
- `design/07-app-plane/00-web-api.md` — 新增 §1.8（REST 端点表/错误语义/submit 口径/WS/DI 契约描述）；
  tangle 加法：ws.rs（Topic::StrategyRun + ClientMsg/Subscription.strategy_run_id +
  PushMsg::StrategyRunProgress + matches 臂 + 2 新单测）、state.rs（AppState.workbench 字段）、
  lib.rs（9 条路由 + mod 注册）、eestock-app.rs（DI 装配块）。

### 生成物（tangle 输出，禁止手改）
- `migrations/0023_strategy_workbench.sql` — strategy_run / strategy_run_result / strategy_preset
  三表 + 2 索引（status+created_at DESC、symbol）。已 apply 至 dev DB（:5433）。
- `crates/domain/src/ports.rs`、`crates/storage/src/lib.rs`、`crates/storage/src/migrate_check.rs`、
  `crates/web/src/ws.rs`、`crates/web/src/state.rs`、`crates/web/src/lib.rs`、
  `crates/app/src/bin/eestock-app.rs`。

### 手写代码（非 tangle，ADR-007 例外同模式）
- `crates/strategy-core/src/engine.rs` — **架构裁决 2026-09-09 批准的红线豁免增量加法**：
  `LoopControl` / `EnsembleError{Canceled, Plugin(From<PluginError>)}` /
  `run_ensemble_with_observer`（observer 每 bar 末恰调一次，Break → 跳出循环不做期末强平、
  返回 Canceled）/ `run_ensemble_with_quickjs_observed` 便捷入口；既有 `run_ensemble` 签名/行为
  零变更（内部 no-op observer 委托同一实现，Canceled 不可达分支 expect+注释）。
- `crates/strategy-core/src/lib.rs` — 导出新符号。
- `crates/storage/src/workbench.rs` — PgStrategyRunStore + PgStrategyPresetStore（条件更新状态机 /
  mark_succeeded 事务落结果 / mark_canceled 三态 / preset name UNIQUE）。
- `crates/application/src/workbench.rs` — WorkbenchService（见 §2）。
- `crates/application/src/lib.rs` — 注册 `pub mod workbench;`。
- `crates/application/src/strategy.rs` — 纯可见性重构：`new_id`/`fill_and_validate_params`/
  `schema_from_json` 改 `pub(crate)` 供 workbench 复用（零行为变更）。
- `crates/application/src/service.rs` — `to_bt_bar` 改 `pub(crate)` 复用（零行为变更）。

### 测试（手写）
- `crates/strategy-core/tests/observer.rs`（6 例）/ `crates/storage/tests/workbench_store.rs`（9 例）/
  `crates/application/tests/workbench.rs`（13 例）/ `crates/web/tests/api_workbench.rs`（5 例）。
- `crates/web/tests/` 既有 11 文件：AppState 新字段 `workbench: None`（api_strategies 为
  `Some` 保留）+ Subscription 新字段 `strategy_run_id: None` 编译适配（ws_poller/api_backtest）。

## 2. 任务制与进度模式复用说明
完全复用 BacktestService 模式：submit 校验 → `create_run`(queued) → `tokio::spawn` 后台任务
（`Semaphore` 限并发 4，`DEFAULT_MAX_CONCURRENT` 同口径）→ `spawn_blocking` 跑引擎（QuickJS 非 Send
实例闭包内创建/drop）→ 同步进度回调经 **mpsc unbounded 桥接**到异步报告任务（WS sink +
store.update_progress 双写）→ 任务结束 `report_task.await` 排空（确定可复现）。差异点：
进度值域 0..1（float8，WS 帧 `progress`），且引擎回调换成 strategy-core 新 observer 钩子
（每 bar 末 `(index, total)`），回调内做 0.1% 粒度节流（千分位前进或末 bar 才发帧，
防 20 万 bar 帧洪泛 WS/DB——既有回测 i32 pct 天然 100 帧，ensemble 需显式节流）。

## 3. 钉住版本快照设计
submit 时逐 slot 校验：version 存在（404）且 status=published（400）→ 快照
`{strategy_id, version_id, version, sha256, params(按版本 params_schema 校验+缺省填充), weight}`
连同 thresholds/policy/stop 原文/initial_capital/fee 原文整体入 `strategy_run.config`
（复现前提，ADR §13.4）。sha256 不失配由 0022 published 不可变 trigger 保证；运行素材 code
取自版本行原文（运行期不再查库——spawn 任务闭包携带）。preset create/update 同口径校验并
钉住（config 同形状）；apply 原样返回钉住 config，前端合并 symbol/period/from/to 即可 submit
（REST 集成测试锁定该闭环）。

## 4. 取消实现口径（协作式）
- **queued**：`mark_canceled` 条件更新（status IN queued/running）；后台任务获信号量后
  `mark_started`（WHERE status='queued'）认领失败 → 放弃执行（防「取消后又被跑起来」）。
- **running**：cancel() 置内存 `Arc<AtomicBool>` 标记 + DB 落 canceled；引擎 observer 每 bar
  回调点检查标记 → `LoopControl::Break` → `EnsembleError::Canceled`（**不**塞 PluginError，
  裁决契约第 2 条）→ 不落结果。任务结束摘销标记。
- 终态取消 → 409；未知 id → 404；mark_succeeded/mark_failed 亦条件更新（running/queued+running），
  并发取消胜出时结果不落库（0 行 → false，日志备案）。

## 5. 测试矩阵
| 层 | 文件 | 覆盖 |
|---|---|---|
| strategy-core | tests/observer.rs | observer 逐 bar 调用序列 / 中途+首 bar Break→Canceled 无结果泄漏 / 全 Continue 与 run_ensemble 逐点相等 / PluginError 包装+From 转换 / run_ensemble 零变更 / EnsembleError: std::error::Error |
| storage | tests/workbench_store.rs | run CRUD roundtrip / 列表排序+状态过滤+分页 / mark_started 原子认领 / update_progress 仅 running / mark_succeeded 事务+幂等防护 / mark_failed 终态防护 / mark_canceled 三态(None/false/true)+取消后不可认领 / FK 级联删结果 / preset CRUD+name UNIQUE(create/update)+find_by_name+updated_at 推进 |
| application | tests/workbench.rs | submit 校验全 13 路径（draft 400/archived 400/未知版本 404/未注册 symbol 400/区间超限 D1+M1+from≥to/slots 空与 11/weight=0/阈值倒挂/policy 非法/stop 非法/fee 缺字段/initial_capital=0/params 越界/空 bar/>20 万 bar）/ 端到端成功（结果五 jsonb 齐全+快照钉住+进度单调至 1.0）/ queued 取消不执行 / running 协作式 Break / 终态 409/未知 404 / compare 输入序+未知跳过 / preset CRUD+apply+重名 409+非法配置 400 |
| web | tests/api_workbench.rs + workbench.rs 内 sink 单测 + ws.rs 内 2 新单测 | submit 生命周期 REST 端到端（201→succeeded→result）/ 校验错误矩阵 400/404 / 取消 200/409/404 / compare 200+400 / preset REST 全端点+apply→submit 闭环 / WS 帧形状 strategy_run_progress / 订阅 strategy_run_id 匹配 |

## 6. 验证
- `cargo build --workspace`：0 error。
- `cargo test --workspace`：**323 passed / 1 failed**——唯一失败
  `storage::alert_store::list_events_filters` 为**既有环境依赖问题**（共享 dev 库 alert_events
  残留生产评测行 source=516380 落在测试固定时间窗内；干净 HEAD worktree 上同测同败，与本次
  改动零交集——本次未触碰任何 alert 代码路径）。
- `cargo clippy --workspace --all-targets`：本次新增 0 warning（残留警告全部位于未触碰文件：
  application/simlive.rs、web/simlive.rs、mcp/tools.rs、storage/reader.rs 及 simlive 测试）。
- `entangled tangle`：无 diff（"Nothing to be done"）。
- 迁移 0023 已 apply 至 dev DB；migrate_check 自检列表同步。

## 7. 歧义与处理
1. **引擎无进度/取消钩子**（红线冲突）→ intercom 升级，父级裁决批准方案 A（strategy-core
   增量 observer 钩子，红线豁免本次）；契约细节照裁决实现（EnsembleError 独立枚举/no-op 委托/
   逐 bar 调用点）。
2. **">20 万 bar 提交时拒绝"**：submit 期同步读 bar（顺带空区间 400，与 test_run 同口径），
   bar Vec 移入后台任务避免二次读；上限常数 MAX_BARS=200_000。
3. **preset 重名 409**：application 不依赖 sqlx，采用 `find_preset_by_name` 端口预检查 +
   DB UNIQUE 兜底（duplicate key 字符串映射 409）。
4. **进度节流**：任务书未规定帧率；取 0.1% 粒度（千分位）+ 末帧必发，report 内注明。
5. **compare 语义**：沿用回测 compare「只含存在 run」并收紧为「存在且已成功」（未成功无
   net_value/metrics 可比），输入序保持。
6. **AGENTS.md GitNexus MCP 工具**（gitnexus_impact 等）在本会话工具集中不可用，未能执行
   影响面分析；以人工调用链分析替代（改动均为加法，唯一行为触点是 run_ensemble 内部委托，
   由 observer_continue_all_matches_run_ensemble 测试锁定零漂移）。

## 8. 遗留风险
- alert_store 测试的共享库隔离缺陷（既有，非本次范围）：建议后续给 ranged 查询加 source 过滤
  或测试用独立时间窗。
- 进程重启后 running 行无恢复/收敛逻辑（sim-live 有 recover_sessions，工作台本期未做）：
  重启遗留 running/cancel_flags 丢失，行将卡在 running。建议 P3b 补启动收敛（running→failed
  "进程重启中断"）。
- per_bar 20 万 bar 全量 jsonb 单行体积可能达数十 MB（ADR §13.4 已拍板全量，上限护栏已加）；
  GET result 大包传输由前端降采样承接（ADR 既定）。
- MCP 工具族（bt_run_ensemble 等，ADR §8）不在本任务范围（P3 后续子任务）。
