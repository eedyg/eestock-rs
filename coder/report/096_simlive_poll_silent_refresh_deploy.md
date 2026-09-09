# 096 · 部署 /sim-live 轮询静默刷新修复 9b31afc（前端唯一）

本文件位置：`eestock-rs/coder/report/096_simlive_poll_silent_refresh_deploy.md`
关联修复报告：`eestock-rs/coder/report/095_simlive_poll_silent_refresh.md`
部署目标 commit：`9b31afc794c9a7a174561f6b8f995e0b27591db8`（HEAD，web/src/features/simlive 前端唯一改动）

## 结论（一句话）
仅重建并重部署 `app` 服务；新镜像 `eestock-rs_app:337a32081b23`，容器 `e3187d556a62` healthy；SPA JS bundle 哈希由 `index-DYgiGFuX.js` → `index-B5n07HIE.js`；5s 轮询期间滚动位置保持、内容不塌缩、无骨架/回顶闪现；既有 /api/* 全回归 200；无源码改动、无 staged 文件、未 commit。

## What changed
- 无源码/DB/SQL/Rust 改动（部署任务）。变更仅发生在镜像层与运行容器：
  - 镜像 `eestock-rs_app:latest`：`fc3a7cf5a072` → `337a32081b23`（`docker-compose build app`）。
  - 容器：旧 `060a19010248`（orphan，因 compose 崩溃残留）被移除；新 `e3187d556a62`。
  - SPA bundle：`index-DYgiGFuX.js` → `index-B5n07HIE.js`；CSS `index-CD7i1kMQ.css` 未变（纯 JS 修复）。
  - 构建日志确认 Rust builder 阶段 `cargo build --release --bin eestock-app` 命中 Docker 缓存（前端变更只重建 frontend stage + 最终 `COPY --from=frontend /web/dist`），印证「前端唯一」。

## Problem solved / feature added
把 `SimLivePage` 的 5s 轮询（`refreshCurrent` → `loadCurrent/loadStrategies/loadOrders`）从「每次清空 data+置 loading」改为「静默/后台刷新」：轮询不再 `data:null`、不置 `loading:true`，原位保留旧 data、拉取后原位更新，失败保留旧 data。由此消除 `[data-region=sim-live]` 滚动容器每 5 秒在「完整运行态 ⇄ 空态」间塌缩/重建 → 不再滚回顶部，视觉不再整页刷新。首次/无数据 init 仍走骨架；用户主动动作仍保留 loading。

## Implementation approach（部署操作）
1. `cd /home/eestock/workspace/git/eestock/eestock-rs`
2. `docker-compose build app` —— 成功（Rust 缓存命中；新镜像 `337a32081b23`）。
3. `docker-compose up -d app` —— **触发 compose v1 + Docker 29 崩溃** `KeyError: 'ContainerConfig'`（见 compose 坑）。
4. 按既定工作法删除孤儿容器 `docker-compose rm -sf app`（移除残留的 `060a19010248`）。
5. 再次 `docker-compose up -d app` —— 成功 `Creating eestock-app ... done`（新容器 `e3187d556a62`）。
6. 等健康：约 5s 后 `health=healthy`；`Restarts=0`。

## Test coverage
- 本部署未新增/未修改测试。修复 commit 已含：`web/src/features/simlive/store.test.ts`（静默刷新：不 null/不 loading + 原位更新；静默失败保留旧 data）与 `web/src/features/simlive/SimLivePage.test.tsx`（fake timer 推进 5s 轮询 → 面板节点未重挂），由开发报告 095 覆盖。
- 本次部署以真实运行态 e2e（Chromium @ /sim-live, 真实 app 容器 + 真实 DB）做运行回归，重点验证「轮询后滚动保持」。

## Verification（部署后，浏览器真实运行态验证）
### 镜像/容器/bundle
```
IMAGE 337a32081b23 2026-09-08 17:00:49 +0800 CST
CONTAINER e3187d556a62 eestock-rs_app Up (healthy)  Restarts=0
BUNDLE index-B5n07HIE.js / index-CD7i1kMQ.css
ASSET index-B5n07HIE.js status=200
/healthz {"status":"ok"}
```

### 轮询后滚动保持验证（对运行会话 s_1788830777_0，有持仓/评分/委托数据）
滚动容器 `[data-region=sim-live]`：clientHeight=760, scrollHeight=3922, 可滚动（max scrollTop=3162）。
- 滚到底部 scrollTop=3162 → 等 6.5s（跨一次 5s 轮询）→ **after.scrollTop=3162，完全不变**；scrollHeight/clientHeight 不变。
- 轮询窗口 21 个样本（300ms 间隔）：`minCards=3, minRows=3, anyMissingPanel=false, anyNoStrongest=false` → **无骨架/空态闪现、无塌缩**。
- 挂点哨兵：scroller `__marker=SCROLLER_ALIVE`、panel `__marker=PANEL_ALIVE` 在轮询后仍存在 → **节点未重挂**。
- 继续滚动多次：topScroll=0，midScroll=1307 → **滚动仍可交互、无中断**；url 保持 `/sim-live`；`pageErrors=0, consoleErrors=0`。
- 补充轮询节奏：清空挂载请求后 11s 内 2 批 `/api/sim-live/{state,strategies,orders}`，间隔精确 5000ms → **5s 轮询确实触发**。

### 既有回归（全部 200）
```
200 /api/sim-live/state
200 /api/sim-live/sessions
200 /api/sim-live/strategies
200 /api/sim-live/orders
200 /api/sim-live/sessions/s_1788830777_0
200 /api/symbols
200 /api/backtest/runs
200 /api/alerts
```
`docker-compose ps`：app/data/timescaledb 三服务均 Up (healthy)。

### git / scope
`git status --short | grep -v '^??'` 为空（无 tracked 改动）；`git diff --cached` 为空（无 staged 文件）；`HEAD=9b31afc`；未 commit。DB/SQL/Rust 未触碰。仅 `app` 服务重建，`data`/`timescaledb` 未动。

## 耗时
- `docker-compose build app`：约 1–2 分钟（Rust 缓存命中，仅 frontend 重编 + 最终 dist COPY）。
- `docker-compose up -d app`（首次）：秒级崩溃（KeyError）。
- `docker-compose rm -sf app` + 再次 `up -d app`：约 1–2 分钟（含容器创建）。
- 健康等待：约 5s；e2e 滚动/轮询/回归验证：约 1–2 分钟。
- 总计约 5 分钟量级（含构建与验证）。

## Compose 坑
- Docker 29.1.3 + docker-compose v1 (1.29.2)：`docker-compose up -d app` 在 `recreate_container → get_container_data_volumes → container.image_config['ContainerConfig']` 抛 `KeyError: 'ContainerConfig'`（Docker 29 镜像 inspect 结构变化，compose v1 仍读旧 key）。
- 工作法：删除旧 app 容器（孤儿/残留 `060a19010248`）后重 `up`；`docker-compose rm -sf app` → `docker-compose up -d app` 成功。本环境 `docker compose`（v2）不存在，只能用 v1 + 该工作法。

## Residual risks
- 既有偶发触发的 compose v1 KeyError 为环境性/复现性运维摩擦；未来每次 app 部署都要预期「先 rm 孤儿再 up」，已文档化。
- 未重跑全量 vitest（dev 侧 095 已覆盖 store/page 单测）；且 commit 注明「7 例 alerts 既有失败与本次无关」，本部署对 `/api/alerts` 运行时已确认 200，但未解决该存量单测失败。
- 视觉「无闪现」采用 DOM 存在性 + scrollTop 哨兵 + 21 样本窗口强验证；未做逐屏截图 K 帧级比对，置信度已高但不能等同逐像素视觉回归。
- `app` 重部署后 frontend dist 内嵌于镜像；如未来 `.dockerignore`/Dockerfile.app 变动需保持「dist 不入库 + 镜像内构建」语义，避免旧哈希 bundle 残留（当前 Dockerfile.app 已 `rm -rf dist`，无此问题）。
