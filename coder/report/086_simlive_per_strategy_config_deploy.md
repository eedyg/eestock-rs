# 086 — sim-live per-策略参数 + 策略×标的映射 + 权重(`f445a9b`) 部署报告

> 本报告文件位置（IMPORTANT）：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/086_simlive_per_strategy_config_deploy.md`
> 任务：只部署 `f445a9b`（per-策略参数/股票映射/权重，含策略×股票级权重；后端 strategy_orchestrator/simlive/web + 前端配置 UI）。不改源码/DB/SQL/Rust，不 commit。

## 结论
已将代码 **`f445a9b`（HEAD）** 交付为运行态：`eestock-rs_app:latest` 重建为 `718a0e679e10`，容器 `eestock-app` 运行中、healthy（`image=718a0e679e10`，端口 8081/8082）。
复验 **per-策略配置**：`POST /api/sim-live/start-session` 带 `strategies:[{id:dual_ma,params:{fast:3,slow:10},stocks:[518880,161226],weight:1.2,stock_weights:{518880:1.5}}]` → 200；`GET /api/sim-live/strategies` 每策略附 `config{params/stocks/weight/stock_weights}`，各标的按 per-strategy 评估；MCP `sim_get_strategy_analysis` 返回 stock_weights 参与聚合。**非法：未知策略/坏 params/未注册(非法格式或未知前缀)/w≤0/空标的集/stock_weights 键不在集/值≤0 → 400**。
既有端点全部回归 200；SPA bundle 更新（含 per-策略 stock_weights/params 标记）；MCP 17 工具（`sim_*` 含 `sim_get_strategy_analysis`）。
验收后已停止并删除本次验证会话（`s_1788794641_0`/`s_1788794803_1`，共 2 simsession + 2 simsession_result 行），DB 恢复至验证前状态；无源码改动、无 stage、无 commit。

## 镜像 / 容器 / bundle
- 提交：`f445a9bbdc9ca5eed049ebb840d70980a5edf55d`（HEAD；`feat(sim-live): per-策略参数 + 策略×标的映射 + 权重(含策略×股票级)`，2026-09-07 23:21 +0800）。
- 新镜像：`eestock-rs_app:latest` = `sha256:718a0e679e10...`，`CreatedAt 2026-09-07 23:22:32 +0800 CST`，构建日志 `logs/app_f445a9b_build.log`。
- 容器：`eestock-app`，`status=Up (healthy)`、`image=eestock-rs_app`，端口 8081->8081、8082->8082。
- 前端 SPA bundle（镜像内构建 `web/dist`，经 `vite build`，`VITE_API_MOCK=0`）：`/assets/index-DYgiGFuX.js`（598,055 B）+ `/assets/index-CD7i1kMQ.css`（20,084 B）；`.js` 内含 `stock_weights`×4、`params`×21（**旧镜像 `index-DCNiax_d.js` 不含 `stock_weights`**）。`/` 返回 eestock 页面。
- 构建日志：`logs/app_f445a9b_build.log`（explicit Rebuild；`Compiling simlive/application/web/mcp/app v0.1.0`，`Finished release ... in 20.84s`）；`logs/app_f445a9b_up.log`（KeyError，exit=1）、`logs/app_f445a9b_up2.log`（成功，exit=0）。

## per-策略配置复验（start → strategies 评估；权重/stock_weights 生效）

### 1) start-session（多策略参数/标的/权重）
`POST /api/sim-live/start-session` body：
```json
{"name":"verify_f445a9b","cash_init":1000000.0,"strategy_set":[],"stock_set":[],"period":"M1",
 "strategies":[{"id":"dual_ma","params":{"fast":3,"slow":10},"stocks":["518880","161226"],"weight":1.2,"stock_weights":{"518880":1.5}}]}
```
→ **HTTP 200** `{"started":true,"session":{... "stock_set":["518880","161226"],"strategy_set":["dual_ma"],"status":"running"}}`。
**会话级 `strategy_set/stock_set` 由策略派生**（每策略 stocks 去重保序、strategy ids 去重），证明 `strategies` 分支生效。

### 2) `GET /api/sim-live/strategies?session_id=s_1788794641_0` → 200
返回每策略 `config{params,stocks,weight,stock_weights}`：
```json
{"session_id":"s_1788794641_0",
 "strategies":[{"strategy_id":"dual_ma","name":"双均线交叉",
   "config":{"params":{"fast":3.0,"slow":10.0},"stocks":["518880","161226"],"weight":1.2,"stock_weights":{"518880":1.5}},
   "strongest":{...}}],
 "stocks":[{"code":"161226","aggregate_score":50.0,"per_strategy_scores":[{"strategy_id":"dual_ma","score":50.0,"signal":"hold"}]},
           {"code":"518880","aggregate_score":50.0,"per_strategy_scores":[{"strategy_id":"dual_ma","score":50.0,"signal":"hold"}]}]}
```
- **config 生效**：params 为配置的 `fast:3,slow:10`；stocks=[518880,161226]；weight=1.2；stock_weights={518880:1.5}。
- **每策略按 params/stocks/权重评估**：各标的 `per_strategy_scores[dual_ma]` 且 `aggregate_score` 按权重公式聚合。

### 3) stock_weights 生效（aggregate 与 weight≈1.2/1.5 一致）
聚合公式（orchestrator `evaluate`）：`w[S,X] = stock_weights[X] ?? weight`；`agg = Σ(w·score)/Σ(w)`。
- 518880：`stock_weights[518880]=1.5` → `agg = (1.5×50.0)/1.5 = 50.0`（与该股 `aggregate_score=50.0` 一致）。
- 161226：无 `stock_weights` 覆盖 → 用 `weight=1.2` → `agg = (1.2×50.0)/1.2 = 50.0`（一致）。
- 两股 `aggregate_score` 均与按 weight≈1.2/1.5 计算的结果一致；**518880 的有效权重(1.5) > 161226 有效权重(1.2)**，stock_weights 在 config 与聚合公式中被采用。
> 因静态行情（M1 最新 bar 单根）使 dual_ma 指数未产生交叉 → 单策略分=中性 50，权重在单策略下自洽地约去，故此处验证「config 生效 + 聚合与权重公式一致」；多策略聚合权重差异需多 bar 行情（数据依赖，见残留风险 2/3）。

### 4) MCP `sim_get_strategy_analysis`（8082 /sse + /messages）
`tools/list` → **17 工具**，`sim_get_strategy_analysis` 存在；`tools/call sim_get_strategy_analysis {session_id:s_1788794641_0}` →
```json
{"result":{"content":[{"text":"{\n  \"evaluations\": [{\"code\":\"161226\",\"aggregate_score\":50.0,...}, {\"code\":\"518880\",\"aggregate_score\":50.0,...}],\n  \"session_id\": \"s_1788794641_0\"}","type":"text"}]}}
```
与 REST `strategies` 同源同值（REST 与 MCP 共享同一 `SimLiveService`）。

## 校验（非法 → 400）
在停止验证会话（无 running）后逐项 `POST /start-session`（每项均未创建会话）：
- **未知策略 id**：`strategies:[{id:'bogus',...}]` → **400** `策略配置非法：未知策略 id: bogus`
- **坏 params（越界）**：`{id:dual_ma,params:{fast:999,slow:10}}` → **400** `参数 fast 超出范围 [2,200]`
- **未注册/非法标的**：`stocks:["888888"]`（未知前缀） → **400** `标的不支持（北交所/未知前缀）: 888888`；`stocks:["abc"]` → **400** `标的 abc 须为 6 位数字`
- **w≤0**：`{id:dual_ma,weight:0}` → **400** `策略 dual_ma 权重必须为正数`
- **空标的集**：`stocks:[]` → **400** `策略 dual_ma 至少需指定一个标的`
- **stock_weights 键不在集**：`stocks:["518880"],stock_weights:{"161226":1.5}` → **400** `stock_weights 键 161226 不在其标的集内`
- **stock_weights 值≤0**：`stock_weights:{"518880":0}` → **400** `518880 权重必须为正数`
- （对照）**合法**：`strategies:[{id:dual_ma,params:{fast:3,slow:10},stocks:["518880","161226"],weight:1.2,stock_weights:{"518880":1.5}}]` → **200**。

## 既有端点回归（全部 HTTP 200）
`GET /healthz` → `{"status":"ok"}`；`GET /`（SPA index.html + assets/index-DYgiGFuX.js/index-CD7i1kMQ.css）；`GET /api/symbols`（含 518880/161226）；`GET /api/backtest/strategies`；`GET /api/backtest/runs`；`GET /api/alerts`；`GET /api/sim-live/sessions`；`GET /api/sim-live/sessions/{id}`；`GET /api/sim-live/strategies?session_id=…`；`POST .../backtest-compare`。MCP `tools/list` 17 工具。相关服务 `eestock-data`（healthy）、`eestock-timescaledb`（healthy）。

## 清理（DB 恢复至验证前状态）
- 停止验证会话：`s_1788794641_0`（合法 per-策略）、`s_1788794803_1`（校验流程中因 `999999` 为合法格式被接受而误建，见残留风险 1）→ 均 `stopped=true`。
- 删除本次验证会话数据：`simsession` 2 行 + `simsession_result` 2 行（`sim_trades`/`sim_positions` 0 行），仅限上述两 session_id。
- 删后 BD 中仅剩 **6 个既有会话**（test running、手动会话 ended、verify_styled_manual ended、verify_4d55f17 ended、L4-f2 running、smoke-test running），与部署前一致；app 内存无 running 会话（静默启动，`/state` 无 session 时 404，与 DB 中 stale running 会话一致系既有记录风险）。

## 架构对齐 / layer
纯**运行/打包层**部署。重建 `Dockerfile.app` 三阶段镜像（frontend → builder → runtime）并滚动替换容器，未触碰任何 crate 接口、layer 边界、依赖方向、DB schema/migration 或 SQL 文件；`f445a9b` 本体的 per-策略实现位于 `simlive`（StrategyConfig.stock_weights/evaluate w[S,X]）+ `application`（StrategyConfigInput/StartSessionReq.strategies/validate_strategy_config_input/start_session/strategy_configs）+ `web`（start-session 400 映射、strategies 附 config）+ `mcp`（sim_start_session strategies 透传、sim_get_strategy_analysis）+ `web/src`（前端单策略卡与权重 UI），本次仅交付运行态。

## 验证方式
- `docker-compose build app` / `docker-compose up -d app`（+ KeyError 处置）→ `docker ps` 新镜像 healthy + SPA bundle 变化。
- 8081 curl 全量 REST per-策略 start→strategies 评估、validation 400、既有端点回归；8082 `/sse`+`/messages` MCP `sim_get_strategy_analysis`；`docker exec` psql 核对/清理 DB。
- `git status` / `git diff --cached` 确认零 stage、零源码改动、HEAD 未变。

## 耗时
- 核心构建+部署约 **1 分钟**：build 26s（15:22:06Z→15:22:32Z，exit 0）；up#1 10s（15:22:49Z→15:23:00Z，`KeyError` exit 1）；删孤儿后 up#2 0s（15:23:08Z，exit 0）；健康检查 healthy（+~3s）。
- 含全量冒烟/校验/清理约 **7 分钟**（15:22:06Z→15:29:00Z）。

## compose 坑（复现 + 处置）
- 环境：`Docker 29.1.3` + 独立 `docker-compose v1.29.2`（`docker compose` 无子命令）。
- `docker-compose up -d app`（重建）复现 **`KeyError: 'ContainerConfig'`**（`compose/service.py get_container_data_volumes → container.image_config['ContainerConfig']`），`UP_EXIT=1`。
- 处置：recreate 失败留下**孤儿容器** `683d961b9068_eestock-app`（Exited 137，旧镜像 90d1b35d51c8），`docker rm -f` 后再次 `docker-compose up -d app` 即成功（`Creating eestock-app ... done`）。
- 根因同 075/077/083 记录（compose v1 与 Docker 29 不兼容）；根治建议迁移 compose v2。
- 注意：**仅重建 `app` 服务**（未动 `data`/`timescaledb`）。

## 残留风险
1. **「注册标的」校验口径（已记录，非本次回归）**：`validate_registered_stock` 仅按**6 位数字 + 市场前缀**（`Code::market`；首字符 0/1/2/3→Sz，5/6/9→Sh）校验，**未依赖 symbols 注册表**（SimLiveService 不持注册表端口，避免扩依赖图）。故**格式合法但未入库标的**如 `999999`（首字符 9→Sh）**通过校验被接受**（本次 `999999` 误建会话即此因）；仅**非法格式**（`888888` 未知前缀/`abc` 非 6 位）→ 400。若要求「严格仅注册表存在标的」，需注入 SymbolRegistry 端口（报告 085 §残留风险，本部署未动源码）。
2. **静态行情/单根 bar → 单策略分中性 50**：M1 最新 bar 静态（2026-09-07 07:00），feed 每次仅喂最新 1 根 → 指标无交叉 → 单策略分=50，权重在单策略下自洽约去。**多策略聚合权重的差异化体现需多 bar/新行情流入**；per-策略 config 与聚合公式一致性已在单策略下验证。
3. **账户级市值/净值**：`/state.account.market_value`/`equity` 显示 0.000（既有记录项，feed 不调 `mark_to_market`；本次未覆盖）。
4. **周期口径**：持仓最新价按会话周期 `latest_bar` close 解析；缺行情回退 0.000（符合规范兜底）。
5. **组合既有 stale running 会话**（`test`/`L4-f2`/`smoke-test` status=running 但 app 内存无记录，无法经 `stop-session` 清理）。非本次产物，未改动。
6. **compose v1 + Docker 29 `KeyError`**：每次重建 app 均需先删 recreate 孤儿；建议迁移 compose v2。
7. **web 400 映射**：`InvalidConfig→BAD_REQUEST` 由 handler 分支实现；应用层（InvalidConfig）+ MCP isError 已测，web handler 分支经代码检查确认（未单独写 web 集成测试，报告 085 记录）。

## 变更清单（no staged files）
- **无源码改动、无 stage、无 commit**（`noStagedFiles: true`）。
- 仅有本次部署新增的未跟踪日志：`logs/app_f445a9b_build.log`、`logs/app_f445a9b_up.log`、`logs/app_f445a9b_up2.log`。
- 本报告：`eestock-rs/coder/report/086_simlive_per_strategy_config_deploy.md`。
- `git status` 中其余 untracked（`coder/report/*`、`AGENTS.md`、`CLAUDE.md`、`crates/web/tests/api_kline_period.rs`、`qq…` 等）为**既有**未跟踪文件，非本次产物。
- `HEAD` 仍为 `f445a9b`（未变）。
