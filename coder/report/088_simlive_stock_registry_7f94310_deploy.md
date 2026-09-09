# 088 — sim-live 股票注册校验 `7f94310` 部署报告（application 层；未注册 → 400）

报告文件位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/088_simlive_stock_registry_7f94310_deploy.md`

本报告为纯部署/复验报告：未修改源码、未改 DB/SQL/Rust、未 commit、未 stage。

## What changed
- **无源码改动**。仅重建并重启 `app` 服务（application 层），将二进制更新为 commit `7f94310` 的版本。
- 镜像：`eestock-rs_app:latest` → `718a0e679e10`（旧） → `b91c61e0de10`（新，created 2026-09-07T15:38:06Z）。
- 容器：`eestock-app` 重建，现 `Up (healthy)`，端口 8081/8082。

## Architecture alignment
- 变更仅发生在 **application 层**（`crates/application` / `crates/web` 的构建产物），通过 `Dockerfile.app` 多阶段构建生成。
- 唯一耦合点 `timescaledb` 与数据面 `eestock-data` 未触碰（均 `Up 2 days (healthy)`）。

## Problem solved / feature added
- 部署 commit `7f94310`：semi-live 股票校验从「格式」改为「注册表成员」。未注册股票 → 400「策略配置非法：股票 X 未注册」，已注册股票 → 正常 200 开会话。

## Implementation approach
- `docker-compose build app`（Rust 变 → 重编；耗时 23s）→ `docker-compose up -d app`。
- **Docker29 + compose v1 坑**：首次 `up -d app` 崩溃 `KeyError: 'ContainerConfig'`（compose v1 读取旧容器 `image_config['ContainerConfig']` 在 Docker29 缺失）。按任务预案**删除孤儿容器**（`docker rm -f` 掉崩溃产生的 `a419e4b3fe4b_eestock-app` 及被 recreate 顶掉的旧 `eestock-app`）后重跑 `up -d app`，第二次成功。

## Verification
- `/healthz` → `200 {"status":"ok"}`。
- **未注册拒绝**：`POST /api/sim-live/start-session`（含 name/period）`stocks:["999999"]` → `400 {"error":"策略配置非法：股票 999999 未注册"}`。
- **已注册**：`stocks:["518880"]` → `200`，session 启动（`s_1788795526_0`，已 `stop-session` 清理）。
- **既有回归**：`/api/symbols` `200`、`/api/backtest/runs` `200`、`/api/alerts` `200`、`/api/sim-live/sessions` `200`、`/api/sim-live/strategies`（live session）`200`。

## Test coverage
- 该改动由 `crates/application/tests/simlive.rs`（registry 校验单测）承载；本次部署复验通过 HTTP 复现未注册 400 / 已注册 200。本次未新增/修改测试。

## Verification method
- 手动 curl 复验 + `docker ps`/`docker inspect` 确认 healthy + 新镜像；`git diff --cached` / `git diff --stat` 均为空。

## Key observations
- **请求体字段差异**：任务给出的 body 仅含 `strategies`。但 `StartSessionReq` 实际要求 `name: String` 与 `period: String`（无默认值），缺省时 axum 返回 **422**（missing field），不会走到注册表校验。若要触发「未注册→400」，需补 `name`/`period`。已用完整字段复验得到预期 400/200。
- `/api/sim-live/strategies` 对 `s_1788789836_9`（DB 中仍标记 running 的会话）返回 500「会话不存在」——这是**容器重启后 in-memory orchestrator 会话丢失**的预期 artifact，非代码回归；对重启后新开的 live session 返回 200。

## Residual risks
- demo/in-memory sim-live 会话在 app 容器重启后丢失，DB 中残留的 `status=running` 记录成为「死会话」（此点与 400 校验无关，属既有行为）。
- `999999` 未注册校验为白名单（注册表成员）；新增标的需要先在注册表/`/api/symbols` 中登记，否则一律 400。
- 任务文档所述 body 与真实 web 契约（需 name/period）不一致，前端若不传 name/period 会收 422 而非 400。
