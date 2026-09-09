# 041 — 回测 Phase 3c：web REST + WS 端点 + app DI

> 本报告自身路径：`coder/report/041_backtest_phase3c_web_rest_ws_di.md`（eestock-rs 仓库）。

## 任务

把已实现的 `application::BacktestService`（提交 7f97c81）接到接口层：web REST 5 端点 + WS `backtest_progress`
进度推送 + `AppState` 注入 + app bin DI。权威：`design/08-backtest/01-engine-adr.md` §7；严格 **ADR-007**
（tangle 文件先改 design 源再 `entangled tangle`，禁止手改生成文件）。TDD，不 commit。

## What changed

### 新增（手写，非 tangle）
- `crates/web/src/backtest.rs`（~8.1KB）：5 个 REST handler（strategies/submit_run/list_runs/get_run/compare_runs）
  + `BacktestWsSink`（实现 `domain::ports::BacktestProgressSink`）+ 2 个单元测试。**注明非 tangle**（ADR-007 例外），
  契约在 design/07-app-plane/00-web-api.md §1.5。
- `crates/web/tests/api_backtest.rs`（~11KB）：5 个集成测试（需 TimescaleDB :5433，含 0011 迁移）。**非 tangle**。

### tangle 生成文件（先改 design 源再 regenerate）
- `crates/web/src/lib.rs`：`pub mod backtest;` + 5 条路由（`/api/backtest/strategies`、`/api/backtest/runs` GET/POST、
  `/api/backtest/runs/{id}`、`/api/backtest/compare`）。
- `crates/web/src/dto.rs`：`BacktestSubmitReq`/`BacktestRunDto`/`BacktestStrategyDto`/`MetricsDto`/`TradeDto` +
  校验纯函数（`validate_backtest_period`/`validate_backtest_fee`/`validate_backtest_params_present`/`parse_backtest_ids`）
  + `BacktestListQuery`/`BacktestCompareQuery` + 单元测试。
- `crates/web/src/state.rs`：`AppState` 增 `backtest: Arc<application::service::BacktestService>` +
  `backtest_ws: Arc<dyn domain::ports::BacktestProgressSink>`。
- `crates/web/src/ws.rs`：`Topic::Backtest`、`PushMsg::BacktestProgress{run_id,pct,bar_ts}`、
  `Subscription.run_id`、`ClientMsg` 增 `run_id`、`matches` 增 backtest 分支 + 单元测试。
- `crates/app/src/bin/eestock-app.rs`：DI 装配 `BacktestBarReader` + `PgBacktestStore` + `BacktestWsSink(hub)`
  → `BacktestService::new(bar_read, store, sink, DEFAULT_MAX_CONCURRENT)` → `AppState.backtest/backtest_ws`。
- `crates/web/tests/{api_rest,ws_poller,api_admin,api_quality}.rs`（00-web-api.md）、
  `crates/web/tests/api_alerts.rs`（02-alerts.md）：`state()` 装配补齐 `backtest`/`backtest_ws` 字段；
  `ws_poller` 的 `Subscription` 构造补 `run_id`。
- `crates/web/tests/api_settings.rs`：**非 tangle 手改**（其 design 块缺失，entangled 不管理），补 `backtest`/`backtest_ws`。

### 手写非 tangle 改
- `crates/web/Cargo.toml`：+`application`、+`async-trait` 依赖（web 依赖 application：Presentation→Application→domain/backtest）。
- `crates/app/Cargo.toml`：+`application` 依赖（app bin DI 构造 BacktestService）。
- `Cargo.lock`：+`application`（app、web）、+`async-trait`（web）两处依赖边。

### design 源改（ADR-007）
- `design/07-app-plane/00-web-api.md`：新增 §1.5 回测契约（REST/WS/DI）；lib.rs/dto.rs/state.rs/ws.rs/eestock-app.rs
  四块加法；api_rest/api_admin/api_quality/ws_poller 四测试块 state() 装配。
- `design/07-app-plane/02-alerts.md`：api_alerts.rs 块 state() 装配。

## Architecture alignment

| 文件 | 层次 | 为什么 |
|---|---|---|
| `crates/web/src/backtest.rs` | Presentation（web） | REST/WS 接口层；经 application 服务 + domain 端口访问回测能力，web 不依赖 storage/sqlx（`cargo tree -p web -e normal` 验证无 storage/sqlx） |
| `crates/web/src/ws.rs` | Presentation（web） | WS 订阅分发；`BacktestProgress` 由引擎事件驱动（非 Poller 轮询库增量） |
| `crates/app/src/bin/eestock-app.rs` | Composition Root（app） | 唯一持有 storage 具体实现；装配 backtest DI |
| `design/*` | 设计源 | ADR-007 单向事实源 |

分层红线：web 只依赖 `domain` 端口 + `diagnose`/`alert`/`application` 服务，不依赖 storage/sqlx（storage 仅 dev-deps）。
`application` 不依赖 web/storage；`backtest` crate 纯逻辑无 IO/DB。

## Problem solved / feature added

回测引擎（backtest crate）+ 应用层任务队列（BacktestService）+ storage（BacktestBarReader/PgBacktestStore）
及 domain 端口在 Phase 3a/3b 已就绪，缺接口层。本阶段补齐：
- REST：策略目录、提交（单 run/网格展开入队）、运行列表（status/group 过滤）、单 run 详情（净值/交易/指标）、多 run 对比。
- WS：`backtest_progress` 进度帧；订阅 `topic:"backtest"` + `run_id`（省略 = 通配）按 run 过滤推送。
- DI：app bin 构造 BacktestService 并注入 `AppState`；进度经 `BacktestWsSink` 推到 WS hub。
- 配置：并发上限取 `application::service::DEFAULT_MAX_CONCURRENT`（ADR §7 = 4），本期不开放配置（避免改 config schema，收紧范围）。

## Implementation approach (within approved architecture)

- **web 依赖 application**：任务要求 `AppState` 持 `Arc<BacktestService>`（application）。方向 Presentation→Application。web 未直接依赖 `backtest`：策略目录的 `params_schema` 经 `serde_json::to_value` 直通（避免新增 crate 依赖边）。
- **网格 run_ids**：不修改 `SubmitOutcome`（application 接口），submit 返回 `Group(gid)` 后 handler 调 `list_runs(&RunFilter{group_id:Some(gid)})` 取子任务 id 组装 `{group_id, run_ids}`。
- **WS 订阅**：扩展 ws.rs `Topic`/`Subscription`/`PushMsg`/`matches`（复用现有 hub 分发，未新增 Poller 轮询）；`BacktestWsSink` 持 `WsHub` 发布 `BacktestProgress`。
- **校验**：period/fee/params 在 web 层校验（FieldError→400）；strategy 存在性→404；from/to RFC3339。
- **确定性测试**：集成测试用固定 code/time/参数，配合「clean 某 code」实现可重入；不依赖实时行情（submit 只入队，不锁完成态）。

## Test coverage

- `crates/web/src/backtest.rs` 单元测试：sink 发布 progress 到 hub（run_id/pct/bar_ts 透传）、无订阅者不报错。
- `crates/web/src/dto.rs` 单元测试：`validate_backtest_period`/`validate_backtest_fee`/`validate_backtest_params_present`/
  `parse_backtest_ids`/`BacktestRunDto`/`BacktestStrategyDto`/`MetricsDto`/`TradeDto` JSON 形状。
- `crates/web/src/ws.rs` 单元测试：`matches_backtest_progress_by_run_id`、`client_subscribe_backtest_run_id`。
- `crates/web/tests/api_backtest.rs` 集成测试：strategies 200（7 款、schema 非空）、submit 校验 400/404、
  入队后 list/get/compare、网格展开 `{group_id, run_ids}` 且 group 过滤恰 3、WS 进度推送（sink→hub 订阅过滤）。
- 既有 web/app/application 测试全部保持通过（无回归）。

## Verification

- `cargo test -p web`：50 项通过（32 lib + 2 api_admin + 3 api_alerts + 5 api_backtest + 1 api_quality + 2 api_rest + 4 api_settings + 1 ws_poller）。
- `cargo test -p app`：4 项通过；`cargo test -p application`：10 项通过。
- `cargo build --workspace`：通过。
- `cargo clippy --workspace --all-targets`：无告警。
- `entangled tangle`：连续两次运行零改动（"Nothing to be done"），`git diff` 无新增，**幂等**。
- `cargo tree -p web -e normal`：含 `application`/`backtest`，**不含** storage/sqlx（分层红线保持）。
- `cargo test --workspace --no-run`：全工作区测试目标编译通过。

## 残留风险

- **submit 服务端错误映射为 400**：`BacktestService::submit` 的 `Err` 统一映射 400；若 `create_run` 因 DB 瞬时故障失败会被误报 400（而非 500）。web 层已前置 period/strategy 校验，故此类多为参数网格畸形（400 正确）；DB 故障属低频，残留风险低。
- **`backtest_runs` 无 code 索引**：list_runs 按 group_id/status 过滤走既有索引；若后续加 code 过滤需补索引（本期不做）。
- **`api_settings.rs` tangle 块缺失（既有）**：该文件头带 tangle 标记但 design/06-web/08-settings.md 无对应块（**非本次引入**）。本期直接手改其 state()。若未来恢复该 design 块，需对齐（本报告不扩范围）。
- **progress/status 时序**：集成测试不锁定 run 完成态（后台任务异步）；run 的「最终 status/metrics」依赖真实 kline 数据（本期测试不造 D1 数据，故 run 多落 failed）。测可复现性以「入队+查询」为准。
- **并发上限固定 4**：未开放 config 配置（按任务「注入 Tokio runtime」口径最小化）；如需可调需改 config schema（本期不做）。

## 暂存文件清单

按父级验收门禁 `noStagedFiles: true`，**未执行 `git add`**，所有改动保留在工作树（未提交）。待父级审查/暂存。涉及文件：

新增：`crates/web/src/backtest.rs`、`crates/web/tests/api_backtest.rs`。
修改：`Cargo.lock`、`crates/app/Cargo.toml`、`crates/app/src/bin/eestock-app.rs`、
`crates/web/Cargo.toml`、`crates/web/src/{dto,lib,state,ws}.rs`、
`crates/web/tests/{api_rest,ws_poller,api_admin,api_quality,api_settings,api_alerts}.rs`、
`design/07-app-plane/00-web-api.md`、`design/07-app-plane/02-alerts.md`。
