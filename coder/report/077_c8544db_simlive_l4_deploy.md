# 077 — 部署 sim-live L4 修复 `c8544db`（F1 order source / F2 feed 接线 / O1 单会话）

> 本报告文件位置（self-location）：`coder/report/077_c8544db_simlive_l4_deploy.md`
> 任务：部署 `c8544db`（已是 HEAD），只部署、不改源码/DB/SQL/Rust、不 commit、不 stage。
> 环境：Docker 29.1.3 + 独立 `docker-compose` v1.29.2（`docker compose` 子命令不存在）。

## 结论概览

| 项 | 状态 | 说明 |
|---|---|---|
| 镜像重建 | ✅ | 新镜像 `sha256:27be8225f2…`（tag `eestock-rs_app:latest`），Rust 重编 20.92s；前端阶段 `npm run build` 实跑（非缓存） |
| 容器滚动替换 | ✅ | `eestock-app` = `09254fb14668`，Up (healthy)，镜像 `27be8225f2…`，端口 8081/8082 |
| compose v1 崩 `KeyError` | ✅ 已处置 | `up -d app` 复现 → 删孤儿 `02a6ac08d68f_eestock-app` → 再 up 成功 |
| `/healthz` | ✅ 200 | `{"status":"ok"}` |
| SPA bundle | ✅ | `index-DIhzyPXq.js` (589.73 kB) / `index-BbwmiVpc.css` (18.97 kB)；含 18×`sim-live`、4×`来源`、1×`模拟实盘`（sim-live 面板在） |
| F1 orders 含 `source` | ✅ 通过 | `GET /api/sim-live/orders` 订单项含 `"source":"manual"` |
| F2 feed 接线（评分非空） | ✅ 通过 | `GET /api/sim-live/strategies` → `stocks`/`strategies` 非空（aggregate_score=50, signal=hold, per-strategy dual_ma/momentum） |
| F2 自动单 (aggregate_strategy) | ⚠️ 未产生（数据依赖） | 静态数据集下 feed 仅取到**单根**最近 bar → 聚合分 50(<60) → hold，无自动单；属环境/数据依赖，非缺陷（单测覆盖该路径） |
| O1 已有 running 再 start → 409 | ✅ 通过 | HTTP 409 + `"已有运行中会话，请先停止会话再开始（单运行会话约束）"` |
| 既有端点回归 | ✅ | `/api/symbols`/`/api/backtest/runs`/`/api/alerts` + 全部 `/api/sim-live/*` 200 |

## 关键背景：修复已在 HEAD，本次纯部署

- 当前 HEAD = `c8544db`（2026-09-07 16:10:04 +0800，9 文件、+1398/−4）。
- 运行中镜像（`6b7ed12ba07f`）构建于 **16:11 之前**（15:26），**不含** c8544db 修复 → 需重建。
- Dockerfile.app 已含 simlive crate 的 `COPY crates/simlive/Cargo.toml`（父级已批准 build-recipe 修复），本次无需改。

## 部署操作记（命令 + 结果）

```
cd eestock-rs
docker-compose build app        # 成功：Successfully built 27be8225f215 / tagged eestock-rs_app:latest
                                # Rust 重编：application/web/mcp/app 等；Frontend Step7 npm run build 实跑
docker-compose up -d app        # ✗ 复现 Docker29+compose v1：KeyError: 'ContainerConfig'
docker rm -f 02a6ac08d68f_eestock-app   # 删 recreate 产生的孤儿（Exited 137）
docker-compose up -d app        # 成功：Creating eestock-app ... done
```

- 构建日志：`logs/app_c8544db_build.log`；up 日志：`logs/app_c8544db_up.log` / `logs/app_c8544db_up2.log`。

## 冒烟 / 验收证据

### F1（orders 含 source）
```
POST /api/sim-live/place-order  body:{code:510880, side:buy, qty:1000, price:3.438, source:"manual"}
GET  /api/sim-live/orders   → 订单项含 "source":"manual"
```
（构造 `SimOrder.source` 已透传至 `OrderView.source`；面板「来源」列由后端补齐。）

### F2（feed 已接线：评分非空）
- 启动会话 `s_1788768814_0`（period=M1, stock_set=["510880"], strategy_set=["dual_ma","momentum"]）。
- 等 10s（feed poll=5s）→ `GET /api/sim-live/strategies`：
  ```
  "stocks":[{"code":"510880","aggregate_score":50.0,"signal":"hold",
             "per_strategy_scores":[{"strategy_id":"dual_ma","score":50.0,"signal":"hold"},
                                    {"strategy_id":"momentum","score":50.0,"signal":"hold"}]}]
  "strategies":[{"strategy_id":"dual_ma","name":"双均线交叉","strongest":{...}},
                {"strategy_id":"momentum","name":"动量突破","strongest":{...}}]
  ```
- 非空即证明 `SimLiveFeed`（c8544db 新增，仅 `process_bar` 调用者）已在 app 内运行并驱动了评分 → **feed 已接线**。
- **注**：`GET /api/sim-live/state` 返回的是 `active/session/account/positions/pnl/trading_enabled/mcp_enabled`，**不含** `strategies/evaluation`；
  评分/评估的实际接口是 `GET /api/sim-live/strategies`（`stocks`=StockEvaluation 数组、`strategies`=每策略最强）。已据此核验。

### F2（自动单 aggregate_strategy）— 未触发（数据依赖）
- 已 `POST /api/sim-live/trading {enabled:true}`，并等 8s 后复查 `GET /api/sim-live/orders`：
  仅手动 single（source=manual），**无** source=aggregate_strategy 单。
- 归因：本环境 kline_accurate 最新 bar 为 2026-09-04 07:00（静态，无新 bar 流入）；feed 对每 `(session,code)` 用 `last_ts` 去重，
  仅发送该**单根** bar → orchestrator 只有 1 bar → 双策略聚合分=50(<60 买阈值) → `signal=hold` → 不自动下单。
- 结论：自动单路径由单测覆盖（报告 076 `feed_polls_new_bar_drives_evaluation_and_auto_order`）；本环境无「达阈值」的行情数据，属数据依赖，非接线/代码缺陷。

### O1（单会话约束）
```
POST /api/sim-live/start-session  (第二次，已有 running s_1788768814_0)
→ HTTP 409  {"error":"已有运行中会话，请先停止会话再开始（单运行会话约束）"}
```

### 既有端点回归（全部 200）
- `GET /api/symbols`、`GET /api/backtest/runs`、`GET /api/alerts`。
- `GET /api/sim-live/state|positions|pnl|orders|strategies|sessions`。
- `GET /sse`（8082 MCP）→ 200；`GET /healthz` → ok。

## 变更文件清单（本次部署）
- **无源码改动**。仅新增未跟踪日志文件：`logs/app_c8544db_build.log`、`logs/app_c8544db_up.log`、`logs/app_c8544db_up2.log`。
- `git diff --cached` 为空（无 stage）；`git status` 中 `crates/web/tests/api_kline_period.rs`、`qq…` 为**既有**未跟踪文件（与本次部署无关）。

## 架构对齐 / layer
- 纯部署于**运行/打包层**：重建应用面镜像并滚动替换容器，未触碰任何 crate 接口、layer 边界、依赖方向、DB schema 或 SQL。
- c8544db 修复本身的归属：F1/F2/O1 均在 `application/web/simlive` 层；本次仅将其交付为运行态。

## 验证方式
- `docker-compose build app` / `docker-compose up -d app`（+ KeyError 处置）→ `docker ps` healthy + 新镜像。
- 对 8081/8082 用 curl 全量 REST/SSE 冒烟；用 `GET /api/sim-live/strategies` 非空证明 feed 接线、`/orders` 含 source 证明 F1、
  第二 `start-session` 409 证明 O1。
- `git status` / `git diff --cached` 确认零 stage、零源码改动。

## 耗时
约 **6 分钟**（2026-09-07 16:11:08 镜像构建 → 16:11:29 容器创建 → 16:13–16:17 冒烟）。

## 残留风险
1. **O1 单会话收紧为全局**：服务层 `start_session` 对任何 running 会话均拒绝（web 409 / MCP isError）。与既有 MCP/e2e 多会话预期可能冲突（报告 076 已标注）；若需保留 MCP 多会话，父级需决策是否仅收窄 web 面板。
2. **aggregate_strategy 自动单未在本环境触发**：静态单 bar → aggregate=50/hold，无「达阈值」行情；需真实 M1 行情流或多 bar 数据才能端到端复现（单测已覆盖）。
3. **DB 遗留 stale running 会话 `s_1788766064_0`**（075 冒烟产物）：status=running 存库但 app 内存无记录 → 无法经 `stop-session` API 清理（服务层只操作内存并提前返回）。本代理未改 DB。
4. **compose v1 + Docker 29 `KeyError: 'ContainerConfig'`**：每次 `up/down` 重建 app 均需先删 recreate 孤儿；建议迁移到 compose v2（`docker compose` 服务插件）。
5. **`state` 不含 strategies**：任务描述用 `/api/sim-live/state (strategies/evaluation)`，实际评分在 `/api/sim-live/strategies`；两者为不同端点（state 无该字段），已按实际接口核验、不影响判定。
