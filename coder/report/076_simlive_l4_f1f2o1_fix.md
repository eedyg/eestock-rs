# 076 — 模拟实盘 L4 修复（F1 订单 source 缺 / F2 策略评分 feed 未接线 / O1 单会话语义）

> 本文件位置（self-location）：`coder/report/076_simlive_l4_f1f2o1_fix.md`
> 任务：模拟实盘 L4 修复三件事（深测发现）。TDD + ADR-007,不 commit。
> 分支：`pr_realtime_use_hist_view`（子模块 `eestock-rs`）。

## 结论概览

| 项 | 状态 | 说明 |
|---|---|---|
| F1 订单 source 缺 | 已修复 | `SimOrder`/`OrderView` 增 `source` 并透传；orders 响应含 source |
| F2 策略评分 feed 未接线 | 已修复 | `SimLiveFeed`（poll 式）；`feed_targets` 自动配置；app DI 关联 |
| O1 单会话语义 | 已实现 | `start_session` 有 running 会话时返回 `AlreadyRunning`；web 映射 409 |
| 不 commit | 是 | 工作树改动未 `git add`（acceptance `noStagedFiles=true`） |

## F1 订单 source 缺（真实缺陷）

- **根因**：`simlive::SimOrder`（in-memory 订单）与 `application::OrderView`（读模型）未透传 `source`
  （`SimTrade.source` 已落库 manual/aggregate_strategy），导致 `GET /api/sim-live/orders` 缺 `source`
  → 面板「来源」列空白。
- **修复**：
  - `crates/simlive/src/session.rs`：`SimOrder` 增加 `pub source: String`（与 `SimTrade.source` 同口径）。
  - `crates/application/src/simlive.rs`：`OrderView` 增 `source`；`get_orders` 映射 `o.source`；
    3 处 `SimOrder { .. }` 构造补 `source`（手动单 `req.source`；聚合自动单 `"aggregate_strategy"`）。
  - 前端已有 `SimOrder.source` 类型 + 面板「来源」列（`OrderTradeList` 第 6 列），后端补上后即显示。

## F2 策略评分 feed 未接线（核心缺口）

- **根因**：部署无任何路径调用 `SimLiveService.configure_strategies/process_bar` → running 会话评分空。
- **修复（最小可行：poll 式）**：
  - `crates/application/src/simlive_feed.rs`（新增）：`SimLiveFeed{ svc, kline, interval, last_ts }`。
    - `run()` 循环：每 `interval`（`DEFAULT_POLL_INTERVAL`=5s）`tick()`。
    - `tick()`：`feed_targets()` 枚举 running 会话 → 每标的 `KlineRead::latest_bar(period, code)`
      → 新 ts 则 `SimLiveService::process_bar(session_id, code, bar)`（评估→评分→聚合→达阈值+开关开→自动单）。
    - 复用 storage `KlineRead`（`state.kline`），无新增行情数据链依赖（ADR-017 只读库，无数据面直连）。
    - **选择与周期**：poll 式（非 WS 订阅）——应用面不订阅实时事件源，按 `interval` 轮询最近 bar ts；
      `interval` 缺省 5s，足以在 M1/5m 下一根 bar 到来前发现新 ts。
  - `crates/application/src/simlive.rs`：新增 `FeedTarget` 结构 + `feed_targets()`——对每个 running 会话，
    若未配置编排器则用 `strategy_set × stock_set` 缺省参数自动配置（weight=1.0）；已配置（MCP/web 自定义参数）
    不覆盖，仅按其覆盖标的轮询。
  - `crates/application/src/lib.rs`：`pub mod simlive_feed;`
  - `crates/app/src/bin/eestock-app.rs`：`tokio::spawn(SimLiveFeed::new(sim_service.clone(), state.kline.clone(), DEFAULT_POLL_INTERVAL).run())`。

## O1 单会话语义（可选，低优先级）

- `crates/application/src/simlive.rs`：新增 `AlreadyRunning(pub String)` 错误；`start_session` 顶部
  `if let Some(existing) = self.current_session_id() { return Err(AlreadyRunning(existing).into()); }`。
- `crates/web/src/simlive.rs`：`start_session` handler 用 `downcast_ref::<AlreadyRunning>` 映射 409
  （`StatusCode::CONFLICT`，文案「已有运行中会话，请先停止会话再开始」）。
- 注：MCP `sim_start_session` 经 `tool_fail` 呈现该错误（isError）。**风险**：此约束把设计从「多 running 会话」
  收紧为「单 running 会话」；与既有 MCP/e2e 多会话预期可能冲突（见残留风险）。

## TDD（Red → Green）

在 `crates/application/tests/simlive.rs` 新增 4 条（均固定输入/固定时钟/无随机，可复现）：

1. `orders_include_source_manual_and_aggregate`（F1）：手动市价单 `source=="manual"`；策略开启+达阈值
   聚合自动单 `source=="aggregate_strategy"`。
2. `feed_polls_new_bar_drives_evaluation_and_auto_order`（F2）：`SimLiveFeed::tick()` 逐根推进 mock kline
   → `process_bar` → `get_strategy_analysis` 非空（aggregate_score=100/signal=buy）+ 自动单
   （`DEFAULT_AGGREGATE_QTY` 100，source=aggregate_strategy）。
3. `feed_targets_auto_configures_session_strategies`（F2）：无编排器 running 会话经 `feed_targets` 自动配置
   并返回 poll 目标（codes=["510300"]）；tick 后评估出现（默认参数单 bar → Hold）。
4. `start_session_when_already_running_returns_already_running_error`（O1）：重复 start → `AlreadyRunning`。

## 验证

- `cargo build --workspace`：通过（app/web/mcp/application/simlive 全编译）。
- `cargo test -p application --test simlive`：23 通过（此前 19，新增 4）。
- `cargo test --workspace --lib`：全部单元测试通过（mcp 29 / application 10 / simlive 26 / backtest 45 / web 36 …）。
- `cd web && npx vitest run`：38 文件 349 通过。
- `VITE_API_MOCK=0 npx tsc -b && vite build`：tsc 0 错误；vite build 产出 dist。
- `entangled tangle --show` / `entangled tangle -f`：no-op（幂等；手动 app-bin 编辑被保留）。
- `npx playwright test e2e/simlive-deep.e2e.ts`：**未运行**（需真实容器+TimescaleDB+运行中 app，本环境无）；已更新
  A5/B2/C1 断言以反映修后契约（feed 驱动评分非空、orders 含 source）。

## 变更文件清单

- 修改：
  - `crates/simlive/src/session.rs`（SimOrder.source）
  - `crates/application/src/simlive.rs`（OrderView.source / get_orders / 3×SimOrder.source / FeedTarget / feed_targets / AlreadyRunning / start_session 约束）
  - `crates/application/src/lib.rs`（pub mod simlive_feed）
  - `crates/application/tests/simlive.rs`（MockKline + 4 条新测试）
  - `crates/web/src/simlive.rs`（start_session 409 映射）
  - `crates/app/src/bin/eestock-app.rs`（装配 SimLiveFeed）
  - `web/e2e/simlive-deep.e2e.ts`（A5/B2/C1 断言对齐修后契约；文件在 git 中为未跟踪新文件）
- 新增：
  - `crates/application/src/simlive_feed.rs`（SimLiveFeed / feed_targets 消费端）

## 残留风险

1. **O1 单会话收紧**：服务层 `start_session` 全局返回 `AlreadyRunning` → 若环境已有 running 会话，
   后续 `start-session`（web 409 / MCP isError）会拒绝，与既有 MCP/e2e 多会话预期（如 A2/B2 直接 start、
   B8「重复 start」观察项）可能冲突。建议父级确认是否仅收窄 web 面板当前会话，保留 MCP 多会话。
2. **e2e 未真跑**：A5/B2 已改断言为「feed 驱动后评分非空」，依赖容器内 kline DB 有 600000/510300 的
   M1 bar && feed 在 ≤20s 内完成首轮 tick；未在本环境验证。
3. **feed 采用缺省策略参数**：自动配置用各策略 schema 默认参数；需自定义参数的会话须由 MCP/web 先
   `configure_strategies`（feed 不覆盖已配置编排器）。
4. **cargo 全 workspace**：storage/web 集成测试依赖 TimescaleDB，本环境无 `DATABASE_URL`，未运行；
   仅跑 lib 单元测试 + application 集成测试。
5. e2e 文件 `web/e2e/simlive-deep.e2e.ts` 在 git 中为未跟踪（新）文件。

## 产物（不 commit；未 `git add`）

6 个修改 + 1 个新增 Rust/TS 文件，见上述清单；AC 要求 `noStagedFiles=true`。
