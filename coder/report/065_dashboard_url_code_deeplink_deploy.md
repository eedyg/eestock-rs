# 065 — 部署 1ebdbf5（看板 URL ?code= 深链选中）

> Report 自述路径：`coder/report/065_dashboard_url_code_deeplink_deploy.md`
> 任务：仅部署 commit `1ebdbf5`（看板 URL `?code=` 深链选中）。未改源码/DB/SQL/Rust，未 commit，未 git add。

## What changed（改了哪些文件）
- **无源码改动**。本次为纯部署动作。
- 仅重建 `app` 服务镜像并重启容器：`eestock-rs_app` → 新镜像 `1085092bcdb2`。
- 新增本部署报告文件（artifacts，未跟踪，不入库）。

## Architecture alignment（分层归属）
- 改动仅落在**部署交付层**：`docker-compose build/up app`，无跨分层变更。
- 前端（web/）与后端（Rust crates/）均未改动；仅镜像内 `vite build` 重新产出 `web/dist`。
- Rust 层命中 Docker 分层缓存（`cargo build --release --bin eestock-app` 未重编）；仅前端 dist 层重建。

## Problem solved / feature added
- 部署目标 commit `1ebdbf5`，其内容是：`store.ts` 增加 `readUrlCode()/resolveInitialSelected()`，首页 `init` 读 `location.search` 的 `code`，存在且在 symbols → 选中该只；无/无效 code → 默认首只；URL 仅 init 生效（点选不回写）；reload 重读保持。
- 部署前运行容器 bundle（`index-B9RewKvL.js`，sha `412a2e1d…`）**不含**该修复；部署后 bundle（`index-yw4TZbPb.js`，sha `de937c61…`）含 `readUrlCode/resolveInitialSelected/location.search` 标记。

## Implementation approach（在既定架构内做的关键决策）
- 严格按任务操作顺序：`docker-compose build app` → `docker-compose up -d app`。
- 遇 compose v1（1.29.2）+ Docker29 兼容崩溃 `KeyError: 'ContainerConfig'`（`get_container_data_volumes` 读旧镜像 `image_config['ContainerConfig']`），按任务预案「删孤儿再 up」：先 `docker-compose rm -f app` 移除旧容器，再 `docker-compose up -d app`，成功新建容器，绕开对旧容器 image_config 的 volume-merge 检查。
- 复现并绕过，未改 compose 源码/yml。

## Test coverage（测试覆盖）
- 本 commit 自带测试（已入库，未改动）：`store.test.ts`、`DashboardPage.test.ts`、`dashboard-state-consistency.e2e.ts`（批1c 回归）。
- 部署后补充真浏览器运行时验证：`npx playwright test e2e/dashboard-state-consistency.e2e.ts -g "C1b"`（C1b = URL-code 契约探测）→ **1 passed (6.1s)**。

## Verification（如何确认生效）
- `docker ps`: `eestock-app` Up, Healthy。
- 镜像新旧：旧 `3dec9b69f005` → 新 `1085092bcdb2`；容器新旧：`d0dbb06f2162` → `f4256b901b30`。
- SPA bundle 前后：`index-B9RewKvL.js` → `index-yw4TZbPb.js`（SHA `412a2e1d…` → `de937c61…`）。
- `/healthz`（8081）：`{"status":"ok"}` HTTP 200。
- URL-code 冒烟（真浏览器，Playwright）：`/?code=161226` → 选中 161226；`/?code=159577` → 选中 159577；均含 init 与 reload 两态（证据 `/tmp/dashboard_state_consistency/C1b.json`，截图 `C1b_*.png`）。C1b e2e PASS。
- 既有端点回归：`/api/symbols` 200（含 161226）、`/api/kline?code=161226…` 200（返回 bars）、`/api/backtest/strategies` 200。
- 仅重建 app；`eestock-timescaledb`/`eestock-data` 未重建（CreatedAt 仍为 2026-09-05）。数据面 /healthz（8080）200。
- 无 staged 文件（`git diff --cached --name-only` = 0）；无 tracked 修改（`git diff --name-only` = 0）。未 commit。

## Deployment 操作坑
- **compose v1（1.29.2）+ Docker 29.1.3**：`docker-compose up -d app` 在容器重建路径崩溃 `KeyError: 'ContainerConfig'`（`/usr/lib/python3/dist-packages/compose/service.py:1579` `container.image_config['ContainerConfig']`，Docker29 镜像 config 不再暴露该字段）。已用「`docker-compose rm -f app` → 再 `up -d app`」绕过。
- 影响面：仅影响容器重建动作，`build` 阶段无此崩溃（已正常产出镜像）。

## Residual risks（残留风险）
- 若日后用 compose v1 执行任何**重建**既有同镜像名容器（非新建），`KeyError: 'ContainerConfig'` 大概率复现；需沿用「先 rm 再 up」或改用 compose v2。
- C1b 测试内静态标签 `ENV_TAG` 仍写旧镜像/旧 bundle 名（仅为元信息，不影响断言）；若需精确反映部署态可后续更新（本次未改源码，故未动）。
- live 数据依赖 tushare 增量，行情为既有数据；未新增/变更数据。

## 耗时
- `docker-compose build app`：镜像命中 Rust/依赖缓存，仅前端 dist 层重建，约 1-2 分钟。
- `docker-compose rm -f app` + `up -d app`：秒级。
- C1b e2e 冒烟：6.1s（单 worker）。
- 整体部署+验证：分钟级完成。
