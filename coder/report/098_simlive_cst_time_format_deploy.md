# 098 — 部署 sim-live CST 时间格式修复 `f262774`（前端唯一）

> 部署任务，无源码改动。仅 `docker-compose build app` + `docker-compose up -d app`，不 commit、不 stage 源码。
> 对应源码修复报告：`097_simlive_cst_time_format.md`（HEAD 已含 `f262774`）。

## What changed (deployment only)

- 无源码/DB/SQL/Rust 改动（`git diff` 与 `git diff --cached` 均为空；`git status` 无 tracked 修改）。
- 重建并替换 `app` 服务镜像 & 容器。
  - 旧镜像 `sha256:337a32081b…`（镜像 Created 2026-09-08T09:00:49Z = 17:00 CST，**早于** `f262774` 提交 23:10 CST，未含修复）。
  - 新镜像 `sha256:1f96386a1c80…`（`eestock-rs_app:latest`，Created 2026-09-08T15:11:05Z = 23:11 CST，**晚于** 提交，含修复）。
  - SPA bundle：`dist/assets/index-B5n07HIE.js`（旧，md5 `3cec42fd03fa…`）→ `dist/assets/index-B0sI5hfi.js`（新，md5 `5c7a759a7ad1…`，598734 B）。新 bundle **无** `toLocaleTimeString`（旧浏览器时区路径已移除），含 `padStart(2,"0")` 与 `8*36…`（+8h CST 偏移）逻辑。

## Architecture alignment

仅替换**应用面**（`app`，Dockerfile.app 多阶段：frontend(node 构建 web/dist) → builder(rust) → runtime）。改动唯一落在前端展示层 `web/src/features/simlive/`（`format.ts` + `panels.tsx`），不涉及数据面 `data`、TimescaleDB、任何 crate/Rust 二进制重编（cargo fetch/build 层全命中 Docker 缓存，见 build 日志 Step 11–30 全 Using cache）。未改接口/事件契约/层边界/依赖。

## Problem solved (被部署的修复)

sim-live «模拟委托/成交» 列表「时刻」列由 `new Date(ts).toLocaleTimeString('zh-CN')`（取浏览器时区→非 CST 机器把盘中 14:xx 显示成 06:xx UTC，看似时段外；且仅 HH:mm 无日期）改为 `formatCstDateTime(ts)`（固定 Asia/Shanghai UTC+8，输出 `MM-DD HH:mm:ss`，含日期+时分秒）。`panels.tsx:479` `时刻` 列 `<td>{formatCstDateTime(o.ts)}</td>`。

## Implementation approach (验证口径)

- 部署方式：`docker-compose build app`（前端变→Rust 缓存命中）→ `docker-compose up -d app`；仅重建 `app`（`data`/`timescaledb` 未动）。
- 纯函数 `formatCstDateTime`：对 UTC unix 秒 `+8h` 后读 `getUTC*` 字段得 CST 墙钟（中国无夏令时，恒 UTC+8），与运行环境/浏览器时区无关。无效/<=0/非有限输入返回 `'—'`。

## Verification (复验证据)

- `docker ps`：`eestock-app  Up (healthy)`，Image `eestock-rs_app`，ImageID `sha256:1f96386a1c80…`，端口 8081-8082。
- `/healthz`：`{"status":"ok"}` HTTP 200。
- SPA bundle 变化：`index-B5n07HIE.js` → `index-B0sI5hfi.js`（filename hash + md5 均变）。
- 新 bundle 内无 `toLocaleTimeString`（count=0），含 `padStart(2,"0")` 与 `8*36…`（+8h 偏移）。
- `formatCstDateTime` 行为（node 复现同源码逻辑）：UTC `1788850457` = `2026-09-08T06:54:17Z` → **`09-08 14:54:17`**（CST 盘中 14:xx，非 06:xx 时段外）。格式匹配 `^MM-DD HH:mm:ss$`。invalid/null/<=0 → `'—'`。
- 真实数据：GET `/api/sim-live/sessions/s_1788830777_0` 返回 `result.trades[]`（40 条单，含 `open_ts/close_ts` 为 UTC unix 秒）。对 40 条全部 `open_ts`+`close_ts` 应用该函数 → 全部输出 `MM-DD HH:mm:ss` 且为 CST（如 `1788831983`=UTC `01:46:23Z` → `09-08 09:46:23`；`1788832084`→`09-08 09:48:04`），无时段外视感。`All formatted values match MM-DD HH:mm:ss? true`。
- `panels.tsx:13`/`:479` 确认 `import { formatCstDateTime }` 并用于「时刻」列。
- 回归：`/api/symbols`、`/api/backtest/runs`、`/api/alerts`、`/api/sim-live/sessions`、`/api/sim-live/sessions/{id}`、`/healthz` 全部 HTTP 200。
- app 启动日志：`schema self-check ok`，`sim-live 启动恢复完成 recovered:0 degraded:0`，`eestock-app serving listen:0.0.0.0:8081 static_dir:/app/dist`，`mcp server serving :8082`；无 error 行。

## Compose pitfalls (Docker29 + compose v1)

- `docker-compose build app` 正常（legacy builder，依赖层全缓存）。
- `docker-compose up -d app` **首次失败**：`KeyError: 'ContainerConfig'`（compose v1 `get_container_data_volumes` 读旧容器 image config；Docker 29 镜像配置不再含 `ContainerConfig`）。崩溃过程把旧容器改名 `e3187d556a62_eestock-app` 并停止(137)。
- 处置：删除孤儿 build-shim 容器（`charming_boyd/gifted_pike/sleepy_ganguly/pedantic_mahavira`，均为无 compose project label 的 Exited 构建中间容器）+ 删除崩溃残留 `e3187d556a62_eestock-app`；再次 `up -d app` 走 fresh-create 路径成功。

## Residual risks

- 当前**无运行中 sim-live 会话**，故 `/api/sim-live/orders|state|positions|pnl|strategies` 返回 `{"error":"无运行中会话…"}`（HTTP 404）。这是既有预期行为，非本次回归；运行态时间展示需启动会话后可见。已通过真实历史会话 `trades[]` 数据验证函数输出。
- 前端页面最终渲染未用真实浏览器截图核实（无浏览器驱动）；但已核验：打包产物含修复逻辑（无 `toLocaleTimeString`、含 +8h/padStart）、`panels.tsx` 接线、以及函数在真实 unix 秒数据上的逐条输出。
- 既有 `src/features/alerts/store.test.ts` 存在 6 个未通过（源码修复报告 097 已标记为既有失败、与本修复无关）；本次部署未触碰 alerts，不引入新失败。
- 手动删除了孤儿构建容器，无跨项目资源被误删（eestock-* 及 scrylink-* 均未受影响）。

report 自身位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/098_simlive_cst_time_format_deploy.md`
