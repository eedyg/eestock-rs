# 075 &mdash; sim-live 部署报告（迁移 0018 + app 镜像重建 L1-L3）

> 本报告文件位置（IMPORTANT）：`eestock-rs/coder/report/075_simlive_deploy.md`

## 概览 / 结论
已完成如下（未 commit、未 stage、未改 Rust/SQL/非迁移 DB）：
- **迁移 0018 已应用**（状态幂等确认）：`simsession` / `simsession_result` / `sim_trades` / `sim_positions` 四表 + 两个会话索引均已存在，schema 与 `migrations/0018_sim_session.sql` 完全一致；再次执行迁移脚本因非幂等 `CREATE TABLE` 报 `relation "simsession" already exists`（exit 3，无任何状态变更）。
- **app 镜像已重建**并滚动替换：新镜像 `sha256:6b7ed12ba07f…`（2026-09-07T07:26:35Z 构建），容器 `eestock-app`（`02a6ac08d68f`）运行中、healthy，端口 8081/8082。
- **build-recipe 修复（父级已批准方案 A）**：`crates/simlive` 为新 workspace crate（`application`/`mcp` 均已依赖），但 tangle 生成的 `Dockerfile.app` 未 `COPY crates/simlive/Cargo.toml`、空 lib 占位循环也未含 `simlive`，导致 `cargo fetch` 因缺 `crates/simlive/Cargo.toml` 失败。已改设计源 `design/07-app-plane/00-web-api.md#Dockerfile.app` 并 `entangled tangle` 重生成 `Dockerfile.app`（再跑 tangle 报 "Nothing to be done"，幂等）。
- **sim-live L1-L3 全部端点 + MCP sim_* 冒烟通过**；既有端点（`/api/symbols`、`/api/backtest/runs`、`/api/alerts`）回归正常。

## 迁移 0018 结果
命令：`docker exec -i eestock-timescaledb psql -U eestock -d eestock -v ON_ERROR_STOP=1 < migrations/0018_sim_session.sql`

- 执行前库内已有四表，`\d` 逐一核对与迁移脚本列/类型/约束/索引一致：
  - `simsession(id text PK, name, cash_init float8, strategy_set jsonb, stock_set jsonb, period, start_ts, end_ts, status CHECK('running'|'ended'), source)` + `simsession_status_check`。
  - `simsession_result(session_id text PK FK cascade, net_value_json, trades_json, metrics_json)`。
  - `sim_trades(id bigserial PK, session_id FK cascade, code, side CHECK buy|sell, qty, price, ts, fee, source)` + `sim_trades_session_idx`。
  - `sim_positions(session_id, code, qty, avg_cost, PK(session_id,code))` + `sim_positions_session_idx`。
- 再次执行输出：`ERROR: relation "simsession" already exists`，`exit code 3`。即 0018 已生效（迁移 SQL 本身非幂等 `CREATE TABLE`，但目标状态已在），未产生新变更。
- 四表初始均为 0 行；冒烟 `start-session` 生成 1 条 running 会话（见下记）。

## 镜像 / 容器 / bundle
- 新镜像 ID：`sha256:6b7ed12ba07f487eee89a28a4080d878e01583b785bfa9282abadea1e21c3c1d`（tag `eestock-rs_app:latest`），构建时间 2026-09-07T07:26:35Z。
- 构建日志：`logs/app_simlive_build.log`（`Finished release profile [optimized] target(s) in 22.08s`；明确重编 `simlive`/`application`/`web`/`mcp`/`storage`/`app` 等 crate，前端 node:22 阶段亦构建）。
- 容器：`eestock-app` = `02a6ac08d68f1f7ad7da4e6a88ca491c415c41b00a81bd4985f9a765b4c55b96`，status=running，health=healthy；端口 8081->8081、8082->8082。
- 前端 bundle（SPA 由镜像内构建）：`/assets/index-DIhzyPXq.js`（589,727 B）、`/assets/index-BbwmiVpc.css`（18,965 B）；`/` 返回 `<!DOCTYPE html> … eestock · 行情看板`。

## /api/sim-live/* 冒烟
| 端点 | 结果 | 摘要 |
|---|---|---|
| `GET /healthz` | 200 | `{"status":"ok"}` |
| `GET /api/sim-live/state` | 200 | 会话 s_1788766064_0 + account(cash/equity/market_value/pnl) + positions=[] |
| `POST /api/sim-live/start-session` | 200 | `{"session":{…},"started":true}`，id `s_1788766064_0` |
| `GET /api/sim-live/strategies` | 200 | `{"session_id":"s_1788766064_0","stocks":[],"strategies":[]}` |
| `POST /api/sim-live/trading {enabled:true}` | 200 | `{"session_id":"…","trading_enabled":true}` |
| `POST /api/sim-live/mcp-toggle` | 200 | `{"mcp_enabled":false}`（随后复位 true） |
| `GET /api/sim-live/sessions` | 200 | 列表含会话（metrics=null，running） |
| `GET /api/sim-live/positions` | 200 | `{"positions":[],"session_id":"…"}` |
| `GET /api/sim-live/orders` | 200 | `{"orders":[],"session_id":"…"}` |
| `GET /api/sim-live/pnl` | 200 | pnl net/realized/unrealized/total_fee=0 |
| `GET /api/sim-live/sessions/{id}` | 200 | 会话详情 |
| `GET /` (SPA) | 200 | 含 sim-live 面板（bundle 内 18 处 `sim-live` + `模拟实盘`） |

说明：`/api/sim-live/strategies` 返回空 strategies 为**数据依赖**（环境内 `kline_accurate` 对 600000 为 0 行，无行情可评分），非部署失败；端点为 200 且函数正确。

## MCP sim_* 列表（SSE 冒烟，`GET /sse` + `POST /messages?sessionId=…` tools/list）
`POST /messages` 返回 202；`tools/list` 共 **17 个工具**，其中 `sim_*` 14 个：
`sim_start_session, sim_stop_session, sim_get_account, sim_get_positions, sim_get_orders, sim_get_pnl, sim_place_order, sim_cancel_order, sim_list_strategies, sim_get_strategy_signal, sim_get_strategy_analysis, sim_list_sessions, sim_get_session, sim_run_backtest_compare`；另有 `get_kline, get_data_quality, get_sources_health`。
工具描述均含「模拟实盘，不触真实券商」——**「仿真/模拟」标识确认**（SPA bundle 亦含 `模拟实盘`）。

## 既有端点回归
- `GET /api/symbols` → 200（返回标的列表）。
- `GET /api/backtest/runs` → 200（返回回测 run 列表）。
- `GET /api/alerts` → 200（返回告警列表）。
- `GET /healthz`（8081）200；`GET /` 200；`GET /sse`(8082) 200。

## 改动（build-recipe 修复，父级已批准方案 A）
`git status --short`：
```
 M Dockerfile.app
 M design/07-app-plane/00-web-api.md
```
- 设计源 `design/07-app-plane/00-web-api.md#Dockerfile.app`：加 `COPY crates/simlive/Cargo.toml crates/simlive/Cargo.toml`；空 lib 占位循环追加 `simlive`（`… web simlive`）；注释「12 个 crate」→「13 个 crate」。
- 生成物 `Dockerfile.app`：同上三处（由 `entangled tangle` 重生成；再跑 `entangled tangle` 报 `Nothing to be done`，幂等）。
- 其余无改动；未 stage、未 commit。

## 架构对齐 / layer
- 修复位于**构建/打包层**（`Dockerfile.app` builder 阶段的 manifest COPY 与占位 recipe），对应 `design/07-app-plane/00-web-api.md`（tangle 事实源）。不触碰 `storage/domain/application/mcp/web/app` 等 crate 的接口、layer 边界或依赖方向；`simlive` 已是 `application`/`mcp` 的既有 path 依赖，本次仅让 Docker 构建上下文包含其 manifest。

## 验证方式
- `docker-compose build app`（成功后）与 `docker-compose up -d app`；全部用 curl 对 8081/8082 做 REST/MCP 冒烟（见上表）；SSE MCP 用 `/tmp/mcp_smoke.sh` 打开 `/sse` 抽取 sessionId → `POST /messages` → grep tools。
- `git diff --cached` 为空（无 stage）；`git status --short` 仅显示上述 2 个未提交改动。

## compose 坑（复现 + 处置）
- 环境：Docker 29.1.3 + 独立 `docker-compose` v1.29.2（`docker compose` 无该子命令）。`docker-compose up -d app` 复现 `KeyError: 'ContainerConfig'`（`get_container_data_volumes → container.image_config['ContainerConfig']` 不存在，Docker 29 变更镜像配置结构）。
- 处置：先 `docker rm -f` 由 recreate 产生的孤儿容器（`<oldid>_eestock-app`），再 `docker-compose up -d app` 即成功创建（旧容器已停、无卷合并依赖）。

## 残留风险
1. `/api/sim-live/strategies` 空：环境无该标的 kline 数据（仅 0 行），无法产生产生 strategy 评分；接入行情/数据后即可看到策略分数与聚合分。属环境/数据依赖，非代码缺陷。
2. 冒烟会话 `s_1788766064_0` 状态 `running` 已落库（1 行）——刻意保留以佐证 full-flow；如需清场可 `POST /api/sim-live/stop-session`（会写 simsession_result）。
3. `Dockerfile.app` 与设计源 2 处为**未提交改动**（父级已批准方案 A，并说明随 sim-live 一并提交）；本代理按要求**未 commit**。
4. `docker-compose` v1 与 Docker 29 的 `KeyError` 属工具组合缺陷，后续任何 `up/down` 若需重建 app 均需先清孤儿；可考虑迁移到 compose v2（`docker compose` 服务插件）。

## 耗时
总计约 **6 分钟**（2026-09-07 15:23:29 → 15:29:38 +0800）：迁移确认秒级、build-recipe 修复+重生成约 1 分钟、`docker-compose build app` 约 47 秒（多数层命中缓存，Rust 重编 22 秒）、`up` + 冒烟约 2 分钟。
