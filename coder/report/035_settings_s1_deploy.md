# 部署报告：设置页 S1（c6061b6）→ 运行容器

> 本报告文件位置：`coder/report/035_settings_s1_deploy.md`
> 任务：只做部署，不改源码 / DB / SQL / Rust，不 commit。仅重建 `app` 服务。

## 需求
将 commit `c6061b6`（设置页 S1：后端 6 端点 + 前端 /settings 路由与导航）部署到运行容器。
sources/collector/mcp），与设置页前端路由（/settings SPA fallback）。

## 做与不改
- 只执行 `docker-compose build app` 与 `docker-compose up -d app`（服务 `app`，多阶段 Dockerfile.app：frontend node 构建 web/dist → builder rust 编 eestock-app → runtime 拷 /app/dist + 二进制）。
- 未触碰 timescaledb / data 容器、未改任何源码 / DB / SQL / Rust、未 commit。

## 执行结果（含耗吋）

### 1. 构建 `docker-compose build app`
- 镜像旧 ID：`5294d0cbd9f0`（eestock-rs_app:latest）
- 镜像新 ID：`22303381a980`（eestock-rs_app:latest）
- 构建耗时：约 **23s**（BUILD_START=14:07:33 → BUILD_END=14:07:56）
- 关键层：Step 23 `COPY crates ./crates` 因源码变而失效 → Step 24 `cargo build --release --bin eestock-app` 重编。
  日志显示重编了 workspace 目标（domain/diagnose/alert/collector/providers/mcp/web/storage/tushare/app）及其在当前
  builder 容器内的依赖，最终 `Finished release in 18.96s`（依赖 fetch 层 Step 22 命中缓存）。
- 前端：`rm -rf dist` 后 `VITE_API_MOCK=0 npm run build`，106 modules，built in 1.03s。

### 2. 部署 `docker-compose up -d app`
- 首次尝试触发 **compose v1 坑**：`ERROR: for eestock-app 'ContainerConfig'`，Traceback 末尾
  `KeyError: 'ContainerConfig'`（Docker Engine 29.1.3 + compose 1.29.2：Engine 29.x 不再返回 image `ContainerConfig`，
  而 compose v1 `get_container_data_volumes` 读它）。耗时约 11s，容器重建中止。
- 按预案清理遗留孤儿容器：`docker rm -f c85ad3f58464_eestock-app`（旧容器重建时被 compose 改名为 `<oldid>_eestock-app`，Exited 137）。
- 二次部署 `docker-compose up -d app`：成功，创建新容器，约 **1s**。

### 3. 确认
- `docker ps`：`539fb12d0ee6  eestock-app  Up (healthy)  eestock-rs_app`（新镜像 `22303381a980`）。
- `docker ps`：timescaledb `Up 2 hours (healthy)`、data `Up 3 hours (healthy)` —— 未受影响。
- 前端 bundle：
  - 旧：`index-l_1GiLir.js`（506690B） / `index-B29X4Q2x.css`（16088B）
  - 新：`index-DT0b4Z2M.js`（517113B） / `index-DVa8V5AN.css`（17197B）——哈希变化，无旧残留。

### 4. 冒烟（curl 127.0.0.1:8081）

| 端点 | 结果 |
|---|---|
| `GET /healthz` | `{"status":"ok"}` |
| `GET /api/system/info` | `{"app_version":"0.1.0","crate_versions":{"collector":"0.1.0","storage":"0.1.0","diagnose":"0.1.0"},"db_ok":true,"uptime_secs":13}` |
| `GET /api/config/sources` | 200，只读 JSON（8 个源：tencent_ifzq/sina_jsonp/tencent_qt/sina_hq/ths_cs/push2delay/exchange/tushare，含 circuit_fail_count/backoff_steps/enabled/rotation_locked） |
| `GET /api/config/collector` | 200，`{"default_interval_sec":60,"trading_hours":"09:30-11:30/13:00-15:00"}` |
| `GET /api/config/mcp` | 200，`{"enabled":true,"trading_tools_enabled":false,"daily_limit_amount":50000,"daily_limit_count":20}` |
| `POST /api/system/reset-circuits`（body `{}` 缺 confirm） | 400 `{"error":"confirm 须为 RESET（危险操作：全部源熔断重置）"}` |
| `POST /api/system/reset-circuits`（body `{"confirm":"wrong"}` 错 confirm） | 400（同上）—— 未真实执行 |
| `POST /api/system/reset-circuits`（无 body/无 content-type） | 415 `Expected request with Content-Type: application/json`（防御性拒绝） |
| `GET /settings` | 200 `text/html; charset=utf-8`，返回 SPA index.html（含 `<title>eestock · 行情看板</title>` 与 `/assets/index-DT0b4Z2M.js`、`/assets/index-DVa8V5AN.css`） |
| `GET /api/system/info` | 200 |
| `docker exec eestock-app ls /app/dist/assets` | 仅 `index-DT0b4Z2M.js` + `index-DVa8V5AN.css`，无旧残留 |

## 问题解决 / 特性
- 将 c6061b6 的 6 个后端端点与设置页前端产物真正落到运行容器（此前运行镜像 `5294d0cbd9f0` 的 `GET /api/system/info`
  返回 `{"error":"not found"}`，说明后端端点尚未部署；`/settings` 返回 200 仅是 SPA fallback 命中，不代表页面已部署）。
- 运维端点 `reset-circuits` 采用危险操作确认（confirm=RESET）保护，错误/缺失 confirm 一律 400，未误触发。

## 实现方式（架构内）
- 纯部署：利用 Dockerfile.app 多阶段缓存。`COPY crates ./crates` 层因源码变失效，cargo 仅重编受影响 crate 及其
  依赖（fetch 层命中缓存）；前端 `rm -rf dist` 清空历史 bundle 后重建，杜绝旧哈希残留。
- 仅重建 `app` 服务；timescaledb/data 未动（故障隔离）。

## 残留风险
- 本次构建的 builder 阶段 `cargo build` 层整体失效（因 `COPY crates` 失效），导致连依赖 crates 也一并重编，
  未命中编译级增量缓存（但 fetch 层缓存仍在，故仅 19s）。后续接续小改动时如 `COPY crates` 又失效，会再次全量重编。
- 未对 `reset-circuits` 传 `confirm:"RESET"` 做真实执行（按要求拒绝 400）；真实重置路径端到端未被验证。
- 前端仅验证了 `/settings` 返回 SPA index.html 与 bundle 哈希；未在浏览器实际渲染 settings 组件（超出本部署确认范围）。
- Docker daemon 非 root 运行 flannel？——无。保留提示：Engine 29.x + compose v1 的 `ContainerConfig` 兼容问题仍存在，
  后续再用 `docker-compose up -d app` 重建 `app` 时可能再次触发，需先清理 `docker ps -a` 中 `<oldid>_eestock-app` 孤儿。

## 验证方式
上述冒烟表所有 curl 均返回预期状态码/JSON；`docker ps` 显示新容器 Up (healthy) 且镜像为 `22303381a980`；
`/app/dist/assets` 仅含新 bundle；`git status` 无已跟踪修改、无暂存、HEAD 仍为 `c6061b6`。
