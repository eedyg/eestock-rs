# 083 — sim-live 持仓修复 5e65c8b 部署报告（app DI with_kline 解析行情价）

> 本报告文件位置（IMPORTANT）：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/083_simlive_5e65c8b_deploy.md`
> 任务：只部署 `5e65c8b`（app DI `with_kline` 让 sim-live 持仓从行情源解析最新价）。不改源码/DB schema/SQL/Rust，不 commit。

## 结论
已将代码 **`5e65c8b`（HEAD）** 交付为运行态：`eestock-rs_app:latest` 重建为 `a758d0add8fe`，容器 `eestock-app` 运行中、healthy。
复验 **持仓 `latest_price=3.389`（行情价，非 0.000）、`market_value=338.9=100×3.389`**，经 REST 与 MCP 双路径确认。
既有端点全部回归 200；O1 单会话约束 409；MCP 14 个 sim_* 工具服务。
验收后已停止并删除本次验证会话（4 行测试数据），DB 恢复至验证前状态；无源码改动、无 stage、无 commit。

## 镜像 / 容器 / bundle
- 提交：`5e65c8b76c0dd29c7c592c7b199b15f9e23e99d3`（HEAD；`fix(sim-live): 持仓最新价=0.000 (未从行情源解析) + tangle同步`，2026-09-07 19:41 +0800）。
- 新镜像：`eestock-rs_app:latest` = `sha256:a758d0add8fe1c7b4fa71f033c514dfd3f6af13690f9094864d6bd5b13a95d45`（构建时间 2026-09-07T11:43Z，`--release` 重编 `application/simlive/web/mcp/storage/app` 等）。
- 容器：`eestock-app`，`Status=running`、`Health=healthy`、`Image=a758d0add8fe`，端口 8081->8081、8082->8082。
- 前端 SPA bundle（镜像内构建，`web/dist`）：`/assets/index-Cl3CGEO5.js`（591,095 B）+ `/assets/index-bGgdzUCM.css`（19,952 B）；JS 内含 `sim-live`×2、`模拟实盘`×1、`latest_price`/`market_value` 字段；`/` 返回 eestock 页面。
- 构建日志：`logs/app_5e65c8b_build.log`；`logs/app_5e65c8b_up.log`、`logs/app_5e65c8b_up2.log`。

## 持仓最新价复验（latest_price=3.389）
复现路径（510880 行情源最新 close=3.389，经 `kline_merged`(M1)/`kline_raw` 一致）：

1. `POST /api/sim-live/start-session`（M1, stock_set=[510880]）→ `s_1788781426_0` running。
2. `POST /api/sim-live/place-order {code:510880, side:buy, qty:100, price:3.389}` → `{"filled":true,"fill":{code:"510880",side:"Buy",qty:100,price:3.3896778}}`。
3. `GET /api/sim-live/positions?session_id=…` →
   ```
   {"positions":[{"avg_cost":3.3896778,"code":"510880","latest":3.389,"market_value":338.9,"qty":100.0,"unrealized_pnl":-0.06778}]}
   ```
   **`latest=3.389 = 行情价（非 0.000），market_value=338.9 = 100×3.389`**。
4. `GET /api/sim-live/state?session_id=…` → 同一 `positions[].latest=3.389 / market_value=338.9`。
5. MCP `sim_get_positions` → `"latest": 3.389`, `"market_value": 338.9`（REST 同源同价）。

**对照 081 根因**：旧镜像（07f7218b6e9c，构建于 5e65c8b 提交之前）此路径返回 `{"error":"internal error"}`（旧代码 `get_positions` 同步 + 未注入 kline 端口，5e65c8b 已改 async + `with_kline`）；新镜像正确解析到 3.389。证明修复已生效。

> 说明：`/state` 的 `account.market_value=0.0` 为**已记录的残留风险**（账户级估值仍用内存 `Position.latest`，`mark_to_market` 不被生产 feed 调用）。任务验收目标为**持仓 DTO**（`latest`/`market_value`），已正确解析；账户级实价属超范围（报告 081 §7 已立 issue）。

## O1 单会话约束
第二次 `POST /api/sim-live/start-session`（已有 running）→ **HTTP 409** `{"error":"已有运行中会话，请先停止会话再开始（单运行会话约束）"}` —— 与 077 报告一致。

## 既有端点回归（全部 HTTP 200）
- `GET /healthz` → `{"status":"ok"}`。
- `GET /api/symbols` → 200（44 个标的；510880 `latest.last=3.389`）。
- `GET /api/backtest/runs` → 200（run 列表）。
- `GET /api/alerts` → 200（告警列表）。
- `GET /api/sim-live/state|positions|orders|pnl|strategies|sessions|sessions/{id}` → 全部 200。
- `GET /sse`(8082 MCP) → 200；MCP `tools/list` 共 **17 工具**，其中 `sim_*` **14** 个。
- 相关服务：`eestock-data`（Up healthy）、`eestock-timescaledb`（Up healthy）。

## 清理（DB 恢复）
- `POST /api/sim-live/stop-session` → `{"session_id":"s_1788781426_0","stopped":true}`（会话 ended，写入 `simsession_result`）。
- 删除本次验证会话的 **4 行测试数据**（`simsession`/`simsession_result`/`sim_trades`/`sim_positions` 各 1 行，仅限 `session_id='s_1788781426_0'`）。
- 删后 DB 中仅剩 **4 个既有会话**（smoke-test running、L4-f2 running、verify_4d55f17 ended、verify_styled_manual ended），与部署前一致，验证时未改动。

## 架构对齐 / layer
纯**运行/打包层**部署。重建 `Dockerfile.app` 三阶段镜像并滚动替换容器，未触碰任何 crate 接口、layer 边界、依赖方向、DB schema/migration 或 SQL 文件；`5e65c8b` 修复本身位于 `application`（SimLiveService with_kline/get_positions async）+ `web/mcp/app` 装配（Presentation 调 application，复用 domain `KlineRead` 端口），本次仅交付运行态。

## 验证方式
- `docker-compose build app` / `docker-compose up -d app`（+ KeyError 处置）→ `docker ps` healthy + 新镜像。
- 8081/8082 curl 全量 REST + MCP（`/sse` + `tools/list` + `tools/call sim_get_positions`）冒烟；`docker exec` psql 核对/清理 DB。
- `git status` / `git diff --cached` 确认零 stage、零源码改动。

## 耗时
约 **3 分钟**（2026-09-07 11:42:47Z 构建开始 → 11:43:15Z build exit 0 → 11:43:35Z up 成功 → 11:45:45Z 冒烟+清理完成）。

## compose 坑（复现 + 处置）
- 环境：`Docker 29.1.3` + 独立 `docker-compose v1.29.2`（`docker compose` 无子命令）。
- `docker-compose up -d app`（重建）复现 **`KeyError: 'ContainerConfig'`**：`compose/service.py get_container_data_volumes → container.image_config['ContainerConfig']` 不存在（Docker 29 变更镜像配置结构），`UP_EXIT=1`。
- 处置：recreate 失败留下**孤儿容器** `05aa47755e6f_eestock-app`（Exited 137），`docker rm -f` 删除后再次 `docker-compose up -d app` 即成功（`Creating eestock-app ... done`）。旧容器已不存在，无卷合并依赖。
- 根因同报告 075/077 记录（compose v1 与 Docker 29 不兼容）；根治建议迁移 compose v2。

## 残留风险
1. **账户级市值/净值滞后**（报告 081 §7）：`/state.account.market_value`/`equity` 仍显示 0.000（用内存 `Position.latest`，feed 不调 `mark_to_market`），而 `positions[].market_value` 显示真实市值。属已知超范围项，另立 issue 处理。
2. **周期口径**：持仓最新价按**会话周期** `latest_bar` close 解析；若会话周期无对应 bar/cagg（如 D1 会话但标的存在 M1 数据）会回退 0.000（“缺行情兜底”符合规范）。
3. **错误吞掉**：`latest_bar` 查询失败按规范回退 0.0，未区分「无行情」与「行情源异常」。
4. **compose v1+ Docker 29 `KeyError`**：每次 `up/down` 重建 app 均需先删 recreate 孤儿；建议迁移 compose v2。
5. **既有 stale running 会话**（`smoke-test`/`L4-f2`）：DB 中 status=running 但 app 内存无记录，无法经 `stop-session` 清理（服务层只操作内存并提前返回）。非本次产物，未改动。
6. **静态行情数据**：M1 最新 bar 为 2026-09-07 07:00（静态，无新 bar 流入），`/api/sim-live/strategies` 的自动单/评分在无新行情时不触发（数据依赖，非缺陷；单测覆盖）。

## 变更清单（no staged files）
- **无源码改动、无 stage、无 commit**（`noStagedFiles: true`）。
- 仅有本次部署新增的未跟踪日志：`logs/app_5e65c8b_build.log`、`logs/app_5e65c8b_up.log`、`logs/app_5e65c8b_up2.log`。
- `git status` 中其余 untracked（`coder/report/*`、`crates/web/tests/api_kline_period.rs`、`qq…` 等）为**既有**未跟踪文件，非本次产物。
- `HEAD` 仍为 `5e65c8b`（未变）。
