# 081 — sim-live 持仓「最新价」=0.000 修复（510880 行情 3.389 但持仓显示 0.000）

> 本报告文件位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/081_simlive_position_latest_quote_fix.md`
> 任务：只改 sim-live（application/simlive + web 若持仓 DTO）；TDD；不 commit。

## 1. 根因（Root Cause）

「现价」列读取的是持仓 DTO `PositionView.latest`。该字段来源于内存持仓 `simlive::account::Position.latest`：

- `Position.latest` 在 `apply_fill`（建仓）时被初始化为 **0.0**，在此后**从未被写入**。
- 唯一刷新 `latest` 的入口是 `SimAccount::mark_to_market(latest_map)`/`SessionManager::tick`。但生产运行链路（web/MCP 面板 + `SimLiveFeed`）**从不调用** `mark_to_market`（仅 `application/tests/simlive.rs` 的测试直接调用过），因此运行态持仓的 `latest` 恒为 0.000。
- 结果：`GET /api/sim-live/state` / `GET /api/sim-live/positions` 返回的 `PositionView.latest`/`market_value` 均为 0.000，尽管 `/api/symbols latest` 显示 510880 最新价为 3.389。

即：**持仓 DTO 的最新价没有从本系统行情源解析**，而是依赖一个从未被喂价的 `Position.latest`。

## 2. 修复（Fix）

把「持仓读模型 latest/market_value」改为**从本系统行情源读端口解析**（对每持仓 code 取 `KlineRead::latest_bar(session_period, code).close`），复用既有 `KlineRead`（与评分表同源同价）；缺行情（未上市/停牌/未注入端口/查询失败）才回退 `0.000`。

改动全部在 sim-live 应用面 + 其调用装配：

- `crates/application/src/simlive.rs`
  - `SimLiveService` 新增 `kline: Option<Arc<dyn KlineRead>>` 字段（复用 domain `KlineRead` 端口）。
  - 新增 builder `with_kline(Arc<dyn KlineRead>)`（未注入 → `None`，此时持仓 latest 回退 0.000）。
  - `get_positions` 由同步改为 `async`：锁内取持仓快照 + 会话周期（不跨 await 持锁），对每 code `resolve_latest_price`。
  - 新增 `resolve_latest_price(period, code)`：`kline.latest_bar(...).close`；无行情回退 0.0。
  - 新增 `dom_period_from_str(s)`：会话周期字符串 → `domain::types::Period`（域名，用于行情查询）。
- `crates/app/src/bin/eestock-app.rs`
  - 装配 `sim_service` 时注入 `.with_kline(sim_kline)`（`KlineReader` 实现了 `KlineRead`，与 `state.kline` 同款/同库）。
- `crates/web/src/simlive.rs`
  - `state`/`positions` handler 改为 `.await` 调用 `get_positions`。
- `crates/mcp/src/tools.rs`
  - `sim_get_positions` 改 `async fn`，dispatch `sim_get_positions(..).await`（与其它 `sim_*` async 工具一致；共用同一服务实例）。

> 说明：`get_positions` 变 async 是「从行情源解析」的必然结果（`KlineRead::latest_bar` 为 async）。web/mcp 为共享该服务的调用方，做最小 async 接线即编译器可过。

## 3. 分层归属（Architecture Alignment）

- 改动均在 **application（SimLiveService）** 与 **web/ mcp 的 sim-live 装配/接线**（Presentation 调 application）。
- 复用 **domain** 既有只读端口 `KlineRead`（`latest_bar`/`KlineBarView`），未新增端口/依赖（`application` 已依赖 `domain`）。
- 未动 `simlive`（纯逻辑）crate 的 position/account 结构，未动 **backtest/storage/collector/providers/tushare**。
- 满足 ADR-017：应用面只读库（经 `KlineRead` 端口），无数据面直连。

## 4. TDD（Red → Green）

新增 3 个应用层集成测试（`crates/application/tests/simlive.rs`，mock 端口、确定性）：

1. `place_order_position_latest_resolves_from_market_quote`
   - start（period=M1, stock_set=[510880]）→ `place_order`(buy 510880，注 mock `KlineRead.set_latest("510880", close=3.389)`) → `get_positions().await`。
   - 断言：`pos[0].latest==3.389`、`market_value==1000×3.389`。
2. `place_order_position_latest_falls_back_zero_without_quote`
   - 不注入 `KlineRead` → `get_positions().await` 断言 `latest==0.000`、`market_value==0.0`（缺行情兜底）。
3. `position_latest_matches_scoring_latest_price_same_quote_source`
   - 手动建仓 + 配置策略 + `process_bar`（close=10.0）→ 断言 `pos[0].latest == signal.latest_price == 10.0`（评分/持仓同源同价）。

**Red 验证**：临时把 `resolve_latest_price` 恒定返回 0.0（复现 bug 行为）→ 运行上述测试，`resolves_from_market_quote` 与 `matches_scoring` **失败**（`expected 3.389/10, got 0`），`falls_back` 通过（无行情本应 0）。证明测试能捕获该 bug。
**Green 验证**：恢复 `resolve_latest_price` 查询行情源 → 全部 3 个测试通过。

## 5. start/place 持仓 latest=行情价 验证

重复复现路径（mock 行情源注入）：

- `POST /api/sim-live/start-session`（M1, stock_set=[510880]）。
- `POST /api/sim-live/place-order`(buy 510880, price=3.389) → 成交。
- `GET /api/sim-live/state` 或 `/positions` → `positions[].latest == 3.389`，`market_value == qty×3.389`。

对应测试：`place_order_position_latest_resolves_from_market_quote`（上方通过）。

## 6. 验证输出（commands-run）

| 命令 | 结果 |
|---|---|
| `cargo test -p application --test simlive` | ok，26 passed（23 既有 + 3 新增） |
| `cargo build --workspace` | ok（application/web/mcp/app 编译） |
| `cargo test -p application` | ok（10+11+26+0） |
| `cargo test -p simlive` | ok（26） |
| `cargo test -p web` | ok（Rust 单测） |
| `cargo test -p mcp` | ok（29 + 2 + 3） |
| `cargo test --workspace --no-fail-fast` | 仅 1 个既有失败（见下）；其余全绿 |
| `entangled tangle` | idempotent（Nothing to be done） |
| `cd web && npx vitest run` | ok，38 files / 352 tests passed |
| `VITE_API_MOCK=0 npx tsc -b` | ok（exit 0） |
| `VITE_API_MOCK=0 npx vite build` | ok（exit 0；仅预既有 chunk-size 警告） |

未触碰 DTO 字段名（`SimPosition` 仍有 `latest`/`market_value`），故前端 `types.ts`/mock 无需改，前端测试保持通过。

## 7. 残留风险（Residual Risks）

- **账户市值/净值滞后**：`get_account`/`get_pnl` 仍用内存持仓 `Position.latest`（feed 不调 `mark_to_market`），故 `/state` 的 `account.equity`/`market_value` 可能显示 0.000，而 `positions[].market_value` 显示真实市值——二者在未打市值的运行态下不一致。已按「只改持仓 DTO」范围限定；如需账户也实价，需同步让 `get_account` 走行情源（超本次范围，另立 issue）。
- **周期口径**：持仓最新价按**会话周期**的 `latest_bar` close 解析（与评分表一致）。若该会话周期无对应 cagg/bar（如 D1 会话但该标的仅 M1 数据），`latest_bar` 返回 None → 回退 0.000（符合「缺行情兜底」）。
- **错误吞掉**：`latest_bar` 查询失败（Err）时按规范回退 0.0，未向调用方暴露错误码；后续可考虑区分「无行情」与「行情源异常」。
- **pre-existing 失败**：`crates/storage/tests/alert_store.rs::list_events_filters`（需 TimescaleDB :5433 共享），在本改动前即失败（已用 stash 验证与本次无关），属既有 DB 状态/time-window 问题，未纳入本修复。

## 8. 暂存/变更清单（no staged files）

**未 `git add`、未 commit**（满足 acceptance 的 `noStagedFiles: true`；变更留工作树供父级审阅）。

- 改动文件（5）：
  - `crates/application/src/simlive.rs`（+kline 端口、get_positions async、resolve_latest_price、dom_period_from_str）
  - `crates/application/tests/simlive.rs`（+3 个新测试；6 处既有调用改 `.await`）
  - `crates/web/src/simlive.rs`（state/positions handler 改 `.await`）
  - `crates/mcp/src/tools.rs`（sim_get_positions async + dispatch）
  - `crates/app/src/bin/eestock-app.rs`（注入 `.with_kline(sim_kline)`）
- 未触碰：`backtest`、`storage`、`simlive`（纯逻辑）、`collector`、`providers`、`tushare`。
- 无关的既有 untracked 文件 `crates/web/tests/api_kline_period.rs`（时间早于本次，非本次产物，未动）。

## 9. 结论

修复后，sim-live 持仓「最新价/市值」从本系统行情源（`KlineRead::latest_bar`）解析，510880 场景 latest=3.389、market_value=qty×3.389，与评分表同源同价；缺行情回退 0.000。TDD Red→Green 已验证；无 commit、无暂存。
