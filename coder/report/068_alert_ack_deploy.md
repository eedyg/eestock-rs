# 068 — 告警 ack catch 兜底 (c06914b) 部署

## 概要
仅部署交付（无源码/DB/SQL/Rust 变更，不 commit）。目标 commit `c06914b`（告警 ack 失败 catch 兜底，A7 latent）。该 commit 已在工作区 HEAD（`git rev-parse --short HEAD` = `c06914b`），本次仅重建运行容器使该改动生效。
本报告文件位置：`coder/report/068_alert_ack_deploy.md`

## What changed（部署交付层）
- 重建 `eestock-rs_app:latest` 镜像（`docker-compose build app`）：仅前端 `web/` 变更触发 frontend 阶段重建（tsc+vite build）；Rust builder 层（Step 23-30）全部命中缓存，未重编 Rust。
- 重建 `eestock-app` 容器（`docker-compose up -d app`）。
- 无 git stage / 无 commit；未触碰源码、DB/SQL、Rust、compose、Dockerfile。

## 前后对比

| 项 | 之前 | 之后 |
|----|------|------|
| 镜像 `eestock-rs_app:latest` ID | `sha256:10e9aff0df2e` (created 2026-09-06T16:18:07Z) | `sha256:8563f4bc55e5` (created 2026-09-06T18:02:07Z) |
| 容器 `eestock-app` ID | `edf109709952` (started 16:18:36Z, healthy) | `26fd1642e0c1` (started 18:02:25Z, healthy, restarts=0) |
| SPA JS bundle | `index-CTRGEV1F.js` (570488B) | `index-CHhXzvJa.js` (570845B) |
| SPA CSS bundle | `index-Cxv8CfRK.css` (18722B) | `index-Cxv8CfRK.css` (18722B) |
| `ackError` marker in bundle | 无 | 有（`/app/dist/assets/index-CHhXzvJa.js`） |
| `确认失败` 文案 in bundle | 无 | 有 |

## 部署命令/耗时
| 步骤 | 时间点(epoch) | 耗时 | 结果 |
|------|---------------|------|------|
| `docker-compose build app` | 1788717723 → 1788717727 | ~4 s | RC=0，成功产出 `8563f4bc55e5` |
| `docker-compose up -d app`（首试） | 1788717730 → 1788717741 | ~11 s | RC=1，崩溃 `KeyError: 'ContainerConfig'` |
| `docker rm -f edf109709952_eestock-app` | — | ~0 s | RC=0，孤儿已删 |
| `docker-compose up -d app`（重试） | 1788717745 → 1788717745 | ~1 s | RC=0，`Creating eestock-app ... done` |
| 容器转健康 | 18:02:25 启动 → (2 s 内) | ~2-4 s | healthy |

## compose 坑
- 环境：Docker Engine `29.1.3` + compose v1 `1.29.2`（无 compose v2 plugin，`docker compose` 返回 `unknown command`）。
- `docker-compose up -d app` 首试复现该已知崩溃：`compose/service.py:1579 get_container_data_volumes` 访问 `container.image_config['ContainerConfig']` → `KeyError: 'ContainerConfig'`。Docker Engine 29.x 镜像 config 不再暴露 `ContainerConfig`，仅当 compose 走 **recreate**（旧容器迁移卷）路径时触发。
- 处置（按任务预案「删孤儿再 up」）：崩溃后旧容器 `edf109709952` 被 compose 改名遗留为孤儿 `edf109709952_eestock-app`（Exited 137）。`docker rm -f` 删除该孤儿 → 再次 `docker-compose up -d app` 走 **fresh create**（无旧容器可迁移）→ 成功。全程未改 compose/源码/Dockerfile。

## 冒烟（确认）
- `/healthz`：HTTP 200 ×3，body `{"status":"ok"}`。
- SPA bundle：`/app/dist/index.html` 引用 `index-CHhXzvJa.js`；`grep -rlc ackError /app/dist/assets/` → `index-CHhXzvJa.js`；`确认失败` 文案存在。
- 既有 API 回归：
  - `/api/symbols`：HTTP 200 ×3。
  - `/api/alerts`：HTTP 200，返回告警 JSON 数组。
  - `/api/backtest/runs`：HTTP 200，返回回测 runs JSON 数组。
- 启动日志：`eestock-app starting` → `schema self-check ok` → `serving 0.0.0.0:8081 static_dir=/app/dist` → `mcp server serving 0.0.0.0:8082`，无 error。
- 无 `_eestock-app` 孤儿残留（`docker ps -a | grep _eestock-app` → NONE）。

## 残留风险
1. **compose v1 + Engine 29.x 结构性不兼容**：任何未来 `docker-compose up -d app` 需要 recreate `eestock-app`（更换镜像/配置）仍大概率复现 `KeyError: 'ContainerConfig'`；需沿用「删孤儿 → rm → 再 up」或迁移 compose v2 plugin。本次仅重建 app，`timescaledb`/`data` 未受影响（均仍 Up healthy）。
2. **一次性部署**：本改动为纯部署；若源码又有新 commit 需重新 build+up 时，重复本流程（含孤儿清理）。

## 验证
- `docker image inspect eestock-rs_app:latest` → `sha256:8563f4bc55e5`。
- `docker inspect eestock-app` → `Image=sha256:8563f4bc55e5`、`Health=healthy`、`Restarts=0`、`Running=true`。
- `git diff --cached --name-only` → 空（无 staged）。
- `git status --porcelain | grep -v '^??'` → 空（无 tracked 修改）。
- `git rev-parse --short HEAD` → `c06914b`。
