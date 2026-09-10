# 131 — 策略删除 + 策略编程手册功能 重新部署（dev 8081/8082）

- 时间：2026-09-10 18:16 (+08)
- HEAD：**8d42fd8** `feat(strategy-registry): 策略删除（draft-only）+ 策略编程手册双通道暴露`
- 报告文件：`coder/report/131_strategy_delete_guide_redeploy.md`
- 源码改动：**无**（任务约束：不改源码；git 工作区无任何已跟踪文件修改）
- 部署惯例参照：`coder/report/128_unified_strategy_system_dev_deploy.md`

## 1. PID 切换

| 项 | 旧 | 新 |
|---|---|---|
| PID | 1243676（运行 5h59m，HEAD b75ece9 时代二进制） | **2326018** |
| 端口 | 8081/8082（host `target/debug/eestock-app --config /tmp/app_dev_8081.toml`） | 同配置同端口 |
| 切换方式 | `kill 1243676`（SIGTERM，2s 内端口释放，ss 确认无持有者） | `RUST_LOG=info nohup target/debug/eestock-app --config /tmp/app_dev_8081.toml > logs/app_8d42fd8_up.log 2>&1 &` |
| 运行日志 | logs/app_b75ece9_up.log | **logs/app_8d42fd8_up.log** |

启动日志关键行（无 ERROR/WARN）：
- `schema self-check ok`
- `strategy registry 启动播种完成 seeded=0 skipped=0`（11 条播种策略已在库，幂等跳过；冒烟 a 证实 11 条齐全）
- `sim-live 启动恢复完成 recovered=0 degraded=0`
- `eestock-app serving listen=0.0.0.0:8081 static_dir=./web/dist`
- `mcp server (HTTP/SSE) serving listen=0.0.0.0:8082`

## 2. 构建

- 前端：`cd web && VITE_API_MOCK=0 npm run build` → 成功（vite 6.4.3，167 modules，1.72s）：`dist/index.html 0.40kB` + `index-DwSJEjoC.js 1167.68kB` + `index-uiWjv_Cs.css 21.98kB`（hash 较 128 的 BI3dfGov 已变，即手册页前端已打包）。
- 后端：`cargo build --bin eestock-app`（debug）→ `Finished dev profile in 0.06s`（验收期已编译至 8d42fd8，无变更）。

## 3. 冒烟验证证据（全部通过）

### a. GET /api/strategies → 200，11 条 ✅
7 策略（双均线交叉 dual_ma / 均线+RSI / MACD / BOLL / KDJ / 动量突破 / ATR 通道，kind=strategy）+ 4 模板（纯评分/两态门控/定投/趋势+止损，kind=template），全部 `status=published`。

### b. GET /api/strategies/guide → 200 text/markdown 含 PARAMS_SCHEMA ✅
- `content-type: text/markdown; charset=utf-8`
- 标题「# 策略编程手册（用户 & MCP AI 共用）」，版本 v1（2026-09-10），权威契约 02-plugin-abi.md
- `PARAMS_SCHEMA` 出现 **5** 次（最小完整策略示例 + 钩子结构 + 参数声明等）

### c. 删除闭环实证（draft）✅
1. `POST /api/strategies`（name=smoke_delete_probe_tmp，code=`function on_bar(ctx) { return 50; }`）→ **201**，id `st_1789035365314_000000`，version 1 `status=draft`。
2. `DELETE /api/strategies/st_1789035365314_000000` → **204**（空响应体）。
3. 再 `GET /api/strategies/st_1789035365314_000000` → **404** `{"error":"策略不存在: st_1789035365314_000000"}`。

### d. published 守护实证 ✅
- `DELETE /api/strategies/st_1789013713975_000000`（播种「双均线交叉」，published）→ **409** `{"error":"含已发布版本的策略不可删除，请归档: st_1789013713975_000000"}`。
- 再 GET 同 id → **200**（策略完好，未被误删）。

### e. GET /api/workbench/runs → 200（零回归）✅
返回 128 期间创建的 run `sr_1789013905608_000022`（smoke-ensemble-2strat，516380 D1，status=succeeded），数据面无损。

### f. MCP tools/list 含 strategy_guide ✅
- SSE 握手：`GET http://127.0.0.1:8082/sse` → `event: endpoint, data: /messages?sessionId=6859993f…`。
- `POST /messages?sessionId=…`（JSON-RPC `tools/list`）→ HTTP 202，SSE 回流 33 个工具。
- 含 **strategy_guide**；strategy_* 家族 8 个：strategy_list/get/create/update/publish/archive/test_run/**guide**（delete 为 REST-only，draft-only 设计）。

## 4. 访问入口

| 入口 | URL |
|---|---|
| Web SPA | http://127.0.0.1:8081/ |
| 策略手册（REST） | http://127.0.0.1:8081/api/strategies/guide |
| REST API | http://127.0.0.1:8081/api/... |
| MCP (SSE) | http://127.0.0.1:8082/sse + /messages?sessionId=... |
| 运行日志 | logs/app_8d42fd8_up.log |
| 配置 | /tmp/app_dev_8081.toml（未变） |

## 5. 残留风险与回滚

- 回滚：`kill 2326018` 后用 b75ece9 时代二进制重启（或 `docker start eestock-app` 回到更旧容器，见 128）。旧进程日志 logs/app_b75ece9_up.log 保留。
- debug 二进制性能低于 release，dev 环境可接受（沿袭 128 惯例）。
- 冒烟 c 创建的临时策略已删除闭环，库中无残留。
- 无源码改动；git 无已跟踪文件修改（本报告为未跟踪新文件，部署日志 logs/ 亦为未跟踪目录）。
