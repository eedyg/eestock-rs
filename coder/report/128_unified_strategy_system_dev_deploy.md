# 128 — 统一策略系统上线本地 dev 环境（部署报告）

- 时间：2026-09-10 12:15 (+08)
- HEAD：b75ece9（P0-P5 + 技术债清算全绿）
- 报告文件：`coder/report/128_unified_strategy_system_dev_deploy.md`
- 源码改动：**无**（任务约束：不改任何源码；仅新增部署配置 /tmp/app_dev_8081.toml 与本报告）

## 1. 端口/进程侦查（部署前）

| 端口 | 持有者 | 说明 |
|---|---|---|
| 8081/8082 | Docker 容器 `eestock-app`（Up 25h，镜像内 `/usr/local/bin/eestock-app --config /etc/eestock/app.toml`，host PID 973435） | 旧二进制，`/api/strategies` 404（基线已确认） |
| 18081/18082 | host `target/debug/eestock-app --config /tmp/app_smoke.toml`（PID 1858479） | tester 冒烟实例，**未触碰** |
| 5433 | Docker `eestock-timescaledb`（healthy） | 数据面，未触碰 |
| 8080 | Docker `eestock-data`（healthy） | 数据面，未触碰 |

**与任务假设的偏差（重要）**：8081 持有者不是 host 进程 `/usr/local/bin/eestock-app`（host 上该路径不存在），而是 **Docker 容器** eestock-app。logs/ 里历史 `docker-compose build/up` 日志全部以 `ContainerConfig` 错误失败（docker-compose 1.29.2 与新 Docker API 不兼容），即 docker 重建链路已断；scripts/ 下无现成 deploy 脚本（仅 check-tangle.sh）。因此按任务步骤 4 指定的「kill 旧进程→新二进制后台启动→日志落 logs/」惯例执行：`docker stop eestock-app`（容器保留可回滚）→ host debug 二进制接管 8081/8082。

## 2. 构建

- 前端：`cd web && VITE_API_MOCK=0 npm run build`（与 Dockerfile.app 口径一致）→ 成功，dist/index.html + assets（index-BI3dfGov.js 1.16MB）。
- 后端：`cargo build --bin eestock-app`（debug profile，与冒烟实例/logs 惯例一致）→ `Finished dev profile in 0.21s`（验收期已编译，无变更）。

## 3. 迁移验证（127.0.0.1:5433，to_regclass）

| 迁移 | 对象 | 结果 |
|---|---|---|
| 0022 | `strategy`, `strategy_version` | ✅ 存在 |
| 0023 | `strategy_run`, `strategy_run_result`, `strategy_preset` | ✅ 存在 |
| 0024 | `backtest_results`, `backtest_runs` | ✅ 均为 NULL（已 DROP） |

## 4. 重启

1. `docker stop eestock-app` → 端口释放（容器现为 `Exited (137)`，可 `docker start` 回滚）。
2. 配置 `/tmp/app_dev_8081.toml`（仿 /tmp/app_smoke.toml 惯例）：`database_url=...@127.0.0.1:5433/eestock`，`listen=0.0.0.0:8081`，`mcp_listen=0.0.0.0:8082`，`static_dir=./web/dist`，health_window/ws_poll/alert_eval 与 config/app.toml 对齐。
3. `RUST_LOG=info nohup target/debug/eestock-app --config /tmp/app_dev_8081.toml > logs/app_b75ece9_up.log 2>&1 &` → **PID 1243676**，8081/8082 已绑定。
4. 启动日志关键行：`schema self-check ok` / `strategy registry 启动播种完成 seeded=11 skipped=0` / `eestock-app serving 0.0.0.0:8081` / `mcp server (HTTP/SSE) serving 0.0.0.0:8082`。
   - 一条 WARN：`sim-live 会话 s_1788880758_0 旧内建策略配置不可恢复，标记 ended`（P4a 切源预期行为，非故障）。

## 5. 冒烟验证证据

### a. GET /api/strategies → 200 ✅
11 条 = 7 策略（双均线交叉 dual_ma / 均线+RSI ma_rsi / MACD / BOLL / KDJ / 动量 momentum / ATR 通道 atr_channel，kind=strategy）+ 4 模板（纯评分/两态门控/定投/趋势+止损，kind=template）。启动播种幂等：seeded=11 skipped=0（首启即播齐）。

### b. GET /api/strategies/manage → 200 ✅
items[] 每条含 `version_count:1`、`latest_version{version,sha256,status:published,approval_level:backtest_ok}`、`latest_published`。

### c. POST /api/strategies/test-run → 200 ✅
注：dev 库无 510300 数据（kline_1d 查询为 0 行），改用有数据的 ETF `516380`；区间近 1 年（2025-09-01~2026-09-10），mode=pure_score，params fast=2/slow=5。
响应：`{"mode":"pure_score","symbol":"516380","period":"D1","bar_count":248,"scores":[...],"signals":[...],"trades":[...],"events":[...],"truncated":...}`；scores 取值集合 = {20, 50, 80}（Buy80/Sell20/Hold50 评分映射生效）。

### d. GET /api/workbench/runs → 200 ✅（`[]`，部署前为空）

### e. 真实 ensemble 回测 → succeeded ✅
- POST /api/workbench/runs → **201**，run id `sr_1789013905608_000022`，2 slots（dual_ma v1 权重1 + macd v1 权重1，钉住 sha256/version 快照），516380 D1 近1年，LumpSum 100%，fee 0.025%/5元/2bp。
- 轮询 GET /api/workbench/runs/{id} → 第 1 次轮询即 `succeeded`。
- GET .../result → 200：`per_bar` 248 条（aggregate/scores/signal/orders/events 五要素）、`trades` 33 笔、`net_value` 248 点、`metrics` 8 字段齐全（annualized_return=-0.1877, max_drawdown=0.2551, net_profit=-18501.9, sharpe=-1.018, trade_count=33, win_rate=0.303, profit_factor=1.421, avg_hold_bars=3.61）。

### f. MCP tools/list（SSE）✅
- GET http://127.0.0.1:8082/sse → `event: endpoint, data: /messages?sessionId=794d5b6e…`；POST /messages `tools/list` → 33 个工具，含 **strategy_*×7**（strategy_archive/create/get/list/publish/test_run/update）与 **bt_*×8**（bt_apply_preset/cancel_run/compare_runs/get_run/get_run_result/list_presets/list_runs/run_ensemble），另有 sim_*×14、get_kline 等。

### g. SPA GET /strategies → 200 ✅
`content-type: text/html; charset=utf-8`，返回 index.html（`<title>eestock · 行情看板</title>`，新 dist）。

## 6. 访问入口

| 入口 | URL |
|---|---|
| Web SPA | http://127.0.0.1:8081/ （策略页 http://127.0.0.1:8081/strategies） |
| REST API | http://127.0.0.1:8081/api/... |
| MCP (SSE) | http://127.0.0.1:8082/sse + /messages?sessionId=... |
| 运行日志 | logs/app_b75ece9_up.log |
| 配置 | /tmp/app_dev_8081.toml |

## 7. 残留风险与回滚

- **拓扑变化**：8081/8082 现由 host debug 二进制（PID 1243676）承载，不再是容器。回滚：`kill 1243676 && docker start eestock-app`（旧容器保留）。
- debug 二进制性能低于 release；dev 环境可接受（与冒烟实例惯例一致）。
- 旧 docker-compose 链路已坏（ContainerConfig 错误），若需回到容器化部署须先修 compose/Docker API 兼容性——超出本任务范围，建议另行立项。
- dev 库无 510300 行情；冒烟用 516380 替代（任务允许「如 510300」任选 ETF）。
- 无源码改动；git 工作区无新增暂存/修改文件（仅本报告为未跟踪新文件）。
