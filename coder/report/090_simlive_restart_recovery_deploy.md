# 090 — sim-live 重启恢复特性 a826c4b 部署/重启验证

> 本报告所在文件：`eestock-rs/coder/report/090_simlive_restart_recovery_deploy.md`

## 需求/任务

部署 sim-live 恢复特性 `a826c4b`（实时落盘 + 重启恢复）。只部署/重启，不改源码/DB 非迁移，不 commit。
迁移 0019 已应用（本任务仅重建 `app` 服务）。

## 操作步骤（实际执行）

1. `cd /home/eestock/workspace/git/eestock/eestock-rs`
2. `docker-compose build app` → 成功，新镜像 `eestock-rs_app:latest = 4326afb96060`（旧 `b91c61e0de10`）。
   Rust `storage`/`application`/`web`/`app` 变更触发重编。
3. `docker-compose up -d app` → **复现** Docker29 + compose v1 崩溃
   `KeyError: 'ContainerConfig'`（`compose/service.py get_container_data_volumes` 读旧容器镜像 config）。
4. 删孤儿 → `docker rm -f 657147d82454_eestock-app`（compose 崩溃遗留的重命名 Exited 容器）。
5. `docker-compose up -d app` → 成功：`Creating eestock-app ... done`。

## 确认结果

### 镜像/容器
- `eestock-app`：`Up 36 seconds (healthy)`，image `eestock-rs_app`（sha256:4326afb9606028…）。
- 迁移 0019 `simsession_state` 表存在（已预应用）。
- 其它服务未受影响：`eestock-timescaledb`（Up healthy）、`eestock-data`（Up healthy）。

### /healthz
- `GET /healthz` → `{"status":"ok"}` HTTP 200。

### 恢复行为（核心验证点）
- 启动日志：
  - `WARN sim-live 运行中会话无 simsession_state，标记 ended` × 3（s_1788789836_9 / s_1788768814_0 / s_1788766064_0）
  - `sim-live 启动恢复完成 recovered=0 degraded=3`
- DB 中 3 个遗留 `running` 会话（其 `simsession_state` 为空）被降级为 `ended`，附结束结果
  `metrics note="中断，部分数据；运行态缺失"`、`net_value note="恢复降级：进程重启且无 simsession_state，已标记 ended"`。
- 说明：`recovered=0` 因旧 build 未落盘 ⇒ 无 state 可恢复，符合「无 state → 标 ended 不打崩」语义。
  （本环境无带 state 的 running 会话，故无法在本部署实例验证「有 state 续跑」路径；该路径由 crate 单测覆盖。）

### 查询不 500
- `GET /api/sim-live/strategies`（无运行中会话）→ HTTP 404（错误信息），**非 500**。
- `GET /api/sim-live/sessions/{id}`（降级会话 s_1788789836_9）→ HTTP 200，返回 ended + 部分结果（含 note）。

### 回归
- `GET /api/sim-live/sessions` → 200
- `GET /api/symbols` → 200
- `GET /api/backtest/runs` → 200
- `GET /api/backtest/strategies` → 200
- `GET /api/alerts` → 200
- 全量 app 日志无 ERROR/PANIC/FATAL。

## 耗时
- 任务操作窗口约 `00:55:20 → 00:56:29`（约 1–2 分钟；不含 build 等待，build 主耗时在 Rust release 重编 + 前端 npm ci/vite）。

## compose 坑
- Docker 29.1.3 + docker-compose 1.29.2（compose v1) `up -d app` 在重建容器时读旧容器
  `image_config['ContainerConfig']` 崩溃 `KeyError: 'ContainerConfig'`。
- 规避：先 `docker rm -f` 崩溃遗留的孤儿容器，再次 `docker-compose up -d app` 走新建路径即可。

## 残留风险
- GitNexus 索引 stale（indexed commit `1a1a798` < 当前 `a826c4b`）——与本次部署无因果；本次**未改任何源码**，故无需重建索引。
- 本实例无可恢复 state 的 running 会话，「有 state → 续跑」分支未在该容器启动路径执行（有单测覆盖）。
- compose v1 + Docker29 的 `up -d` 若再次对已有容器重建会重复崩溃；后续重建建议固定「先删孤儿再 up」步骤。
- 编排器内部 bars/评分状态不持久化：恢复后首根新 bar 重新评估（重启前实时评分不保留）——设计残差，非本次引入。

## 交付验证（change report 要求）
- changed-files：无（部署非源码变更；仅新增本报告 + logs 文件）。
- tests-added：无（只部署，不新增测试）。
- commands-run：见下。
- staged files：无（未 commit 未 stage）。
