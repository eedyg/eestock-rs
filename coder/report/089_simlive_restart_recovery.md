# 089 — sim-live 重启恢复：实时落盘 + 从落盘重建续跑

> 本报告所在文件：`eestock-rs/coder/report/089_simlive_restart_recovery.md`

## 需求/要解决的问题

sim-live 会话状态在内存（`SimLiveService.sessions: Map<String, LiveSession>`），DB `simsession.status='running'`
但在进程重启后内存态消失 → 对之查 `sim_get_strategy_*` / `/api/sim-live/strategies` / `get_account` 等 →
「会话不存在」→ 500 / MCP isError（僵尸会话）。

**用户/父进程澄清（重构方向）**：不是「标记中断」，而是 **实时落盘运行态 + 重启后从落盘恢复并继续**。

## 实现方案（用户澄清版）

### 1. 实时落盘（每次变更即写盘）

新增 `simsession_state` 表（迁移 0019），存 `state_json`（= `domain::ports::SimSessionState`）+ `updated_at`。
`SimLiveService` 在以下每次变更后调用 `persist_state(session_id)`（幂等 upsert）：
- `start_session`（初始：cash=cash_init、净值序列=[(start_ts,cash_init)]）
- `process_bar`（每次评估/成交后）
- `place_order`（每次下单/成交/pending 后）
- `cancel_order`（每次撤单后）
- `configure_strategies`（策略配置变更后，方法改为 async）
- `set_trading`（统一交易开关变更后，方法改为 async）

`SimSessionState` 捕获：cash / realized_pnl / total_fee / 持仓（qty/avg_cost）/ 各持仓最新价
（latest_prices，重建 market_value/unrealized_pnl）/ 运行期净值序列 / `trading_enabled` /
策略配置（JSON 数组，id/params/stocks/weight/stock_weights）/ 订单（JSON 数组）。

### 2. 重启恢复（`recover_sessions`）

app bin 构造 `SimLiveService` 后调用 `sim_service.recover_sessions().await?`（见
`crates/app/src/bin/eestock-app.rs`，由 `design/07-app-plane/00-web-api.md` tangle 生成）。

`recover_sessions()`：
- 遍历 `store.list_sessions()`，只处理 `status='running'` 且**不在内存**的会话。
- 有 `simsession_state` → `restore_live_session()` 重建 `LiveSession`（账户/持仓/PnL/订单/意图去重/
  编排器按配置重建/净值序列续），插入内存 → **续跑（不标记中断）**。
- 无 state / 损坏 → `store.mark_end(..., degraded_result())` 标记 ended + 告警（不打崩；
  `get_session` 返回 ended + 部分结果，不 500）。

### 3. 幂等

- 仅「DB 中 running 且内存不存在」的会话收敛；已 ended / 已恢复 / 已在内存的不动。
- `restore` 是读重建，重复执行结果一致；`recover` 二次调用对已在内存会话不再收敛。

### 4. 查询不 500

- 恢复后会话在内存（Running），`get_account/get_positions/get_pnl/get_strategy_*/strategy_configs`
  均正常返回。
- `get_strategy_signal/analysis/strategy_configs` 对**不在内存**会话改为返回 `None/空`（而非 Err），
  覆盖降级 ended 会话，避免 500 / isError。

## 关键决策（注明）

- **标记语义**：对「无运行态可续」的降级会话用 `ended`（DB `simsession.status` CHECK 仅允许
  `running/ended`，不做迁移放宽；任务允许「ended + error」语义）。区分「正常结束」与「中断降级」通过在
  `simsession_result.metrics/net_value` 的 `note` 注解：「恢复降级：进程重启且无 simsession_state，已标记 ended」。
- **不标记 interrupted**：按用户澄清改为「续跑」而非「标记中断」；无 state 才降级 ended。
- **net_value 序列续**：`SessionManager::restore` 直接恢复持久化的 `net_value_series`，续跑不断层。
- **编排器内部 bars/评分状态不持久化**：恢复后编排器按配置重建、内部 bar 序列清空，首根新 bar 后重新评估
  （残差：重启前的实时评分/信号不保留，仅恢复账户与配置）。

## 分层对齐

- `domain/ports`：`SimSessionState` 结构 + `SimSessionStore` 增 3 方法（`list_trades`/`upsert_state`/`get_state`）——
  端口加法；storage 实现；application/mcp/web 只依赖端口。
- `simlive` crate（纯逻辑）：`SessionManager::restore`（账户/会话/净值序列/成交/信号事件重建）。
- `application`（SimLiveService）：持久化/恢复编排。
- `storage`：`PgSimSessionStore` 实现 3 方法。
- `app`（组合根）：启动调用 `recover_sessions`（tangle 生成）。
- 未改 backtest / 数据面 / 真实券商。

## 测试覆盖

- `simlive`：`restore_reconstructs_running_session`（运行态重建 + 续跑打市值）。
- `application/tests/simlive.rs` 新增 4：
  - ① `process_bar_persists_running_state`
  - ② `recover_sessions_restores_running_session_and_continues`
  - ③ `recover_sessions_degraded_when_no_state_marks_ended`
  - ④ `recover_sessions_is_idempotent`
- `storage/tests/sim_store.rs`：`list_trades_and_upsert_get_state_roundtrip`（新读写端口 CRUD）。

## 验证

- `cargo test -p simlive` → 28 通过。
- `cargo test -p application --test simlive` → 35 通过。
- `cargo test -p mcp --lib` → 31 通过。
- `cargo test -p storage --test sim_store` → 6 通过（已 apply 迁移 0019）。
- `cargo test -p web` → 36 通过。
- `cargo test --workspace --no-fail-fast` → **唯一失败 `storage::alert_store::list_events_filters`**，
  与 sim-live 无关（alert 功能，`last_fired_at` 窗口断言），属既有问题/需剔除项；其余全绿。
- `entangled tangle` → 「Nothing to be done」（幂等）；`cargo check -p app` 通过。

## 残留风险

1. **DB 写放大**：`process_bar` 每 bar 每标的 upsert `simsession_state`（含 updated_at）。高标的多、bar 频繁时
   DB 写较多。可后续加节流（如仅账户/配置变更才写，或 debounce）。
2. **净现值序列稀疏**：`process_bar` 不追加净值点（历史即如此，仅 start/mark_to_market 更新），恢复后
   净值序列可能只有初始点+成交记录，非逐 bar。属既有设计限制，未在本次扩大。
3. **编排器实时评分不恢复**：重启前 `bars`/内部策略状态/最近评估不持久化，恢复后从首根新 bar 重新评估
   （账户/持仓/PnL/配置一致，但评分信号有冷启动窗口）。
4. **信号事件流不持久化**：`SessionManager.signal_events` 未纳入 `SimSessionState`，恢复后为空；
   不影响账户/交易，但会话事件流回看不完整。
5. **mark_to_market / feed_targets 不即时落盘**：`mark_to_market`（同步）与 `feed_targets`（同步自动配置）
   不持久化；其影响会在下一次 `process_bar`/`place_order` persist_state 时捕获。
6. **迁移 0019 未纳入 migrate_check**：`storage::migrate_check::EXPECTED_RELATIONS` 仍只覆盖 0001-0009；
   0019 的 apply 走显式迁移路径（本次本地已手动 apply 用于跑 storage 集成测试）。后续宜把 sim 系列表纳入自检。
7. **降级 `ended` 语义**：无 state 会话标记 ended（非中断），与正常 ended 仅在结果 `note` 区分；如需强区分，
   应放宽 `simsession.status` CHECK 加 `interrupted`（本次按任务选项未做）。

## 暂存文件清单（已 `git add`，未 commit）

- `crates/app/src/bin/eestock-app.rs`（tangle 生成）
- `crates/application/src/simlive.rs`
- `crates/application/tests/simlive.rs`
- `crates/domain/src/ports.rs`（tangle 生成）
- `crates/mcp/src/tools.rs`
- `crates/simlive/src/session.rs`
- `crates/storage/src/sim.rs`
- `crates/storage/tests/sim_store.rs`
- `crates/web/src/simlive.rs`
- `design/02-domain/contracts.md`（tangle 源）
- `design/04-storage/schema.md`（tangle 源）
- `design/07-app-plane/00-web-api.md`（tangle 源）
- `migrations/0019_sim_session_state.sql`（新增，tangle 生成）
