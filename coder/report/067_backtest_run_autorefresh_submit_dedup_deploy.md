# 067 — 部署 32931f7（回测 run 自动刷新 + 提交去重）

> Report 自述路径：`coder/report/067_backtest_run_autorefresh_submit_dedup_deploy.md`
> 任务：仅部署 commit `32931f7`（回测 run 完成后任务列表自动刷新 + 提交 in-flight 去重）。未改源码/DB/SQL/Rust，未 commit，未 git add。

## What changed（改了哪些文件）
- **无源码改动**。本次为纯部署动作（`docker-compose build/up app`）。
- 仅重建 `app` 服务镜像并重启容器：`eestock-rs_app` → 旧镜像 `1085092bcdb2` → 新镜像 `10e9aff0df2e`；容器 `f4256b901b30` → `edf109709952`。
- 新增本部署报告文件（artifacts，未跟踪，不入库）。

## Architecture alignment（分层归属）
- 改动仅落在**部署交付层**：`docker-compose build/up app`，无跨分层变更。
- 前端（web/）与后端（Rust crates/）均未改动；仅镜像内 `vite build` 重新产出 `web/dist`。
- **Rust 层命中 Docker 分层缓存**：`cargo build --release --bin eestock-app`（Step 26）显示 `Using cache` → `24a5eaa358e0`，未重编；仅前端 dist 层重建（Step 30 `COPY --from=frontend /web/dist` → 新层 `def7d46a21e2`）。与任务「前端变→Rust 缓存」预期一致。

## Problem solved / feature added
- 部署目标 commit `32931f7`，内容为：`store.onProgress` 收 `backtest_progress` `pct>=100` → 调用新增私有 `refreshRunInList(run_id)`（`GET /api/backtest/runs/{id}` 单 run 重捞合并回 `runs` 列表，仅该行翻终态 done/failed、其它行不变，非全列表轮询；已终态短路）；`store.submit` 顶部加 `if (this.current.submitting) return;` in-flight 去重（防御 dblclick 2 POST），`finally` 清除标志。
- 部署前运行容器 bundle（`index-yw4TZbPb.js`，sha `de937c61…`）**不含** `refreshRunInList`；部署后 bundle（`index-CTRGEV1F.js`，sha `8b5b7419…`）含 `refreshRunInList`/`getRun`/`submitRun` 标记。

## Implementation approach（在既定架构内做的关键决策）
- 严格按任务操作顺序：`docker-compose build app` → `docker-compose up -d app`。
- 遇 compose v1（1.29.2）+ Docker 29.1.3 兼容崩溃 `KeyError: 'ContainerConfig'`（`compose/service.py:1579` `container.image_config['ContainerConfig']`，Docker29 镜像 config 不再暴露该字段），按任务预案「删孤儿再 up」：先 `docker-compose rm -f app` 移除旧容器，再 `docker-compose up -d app` 新建容器，绕开对旧容器 image_config 的 volume-merge 检查。
- 复现并绕过，未改 compose 源码/yml。

## Test coverage（测试覆盖）
- commit 自带测试（未改动）：`store.test.ts`（WS 到 100 重捞/未到 100 不重捞；提交中重复 submit 仅 1 次 POST）、`BacktestPage.test.tsx`。vitest 37 文件 327 通过、tsc+vite 已由上游证明。
- 部署为纯交付，不新增源码测试；运行时以 bundle 标记 + 端点冒烟验证生效。

## Verification（如何确认生效）
- `docker ps`：`eestock-app` Up, Healthy（`State.Health.Status=healthy`）。
- 镜像新旧：`1085092bcdb2`（1ebdbf5）→ `10e9aff0df2e`（32931f7）；容器新旧：`f4256b901b30` → `edf109709952`。
- SPA bundle 前后：`index-yw4TZbPb.js`（sha `de937c61…`）→ `index-CTRGEV1F.js`（sha `8b5b7419…`）；CSS `index-Cxv8CfRK.css` 未变。
- bundle 标记：部署后含 `refreshRunInList`(2)、`getRun`(3)、`submitRun`(2)、`submitting`(13)；部署前无 `refreshRunInList`。
- `/healthz`（8081）：`{"status":"ok"}` HTTP 200。
- 既有端点回归：`/api/backtest/runs` 200（返回 run 列表，含 done/failed/progress）、`/api/kline?code=161226&period=1d&limit=5` 200、`/api/symbols` 200、`/api/backtest/strategies` 200。数据面 `/healthz`（8080）200。
- 仅重建 app；`eestock-timescaledb`/`eestock-data` 未重建（StartedAt 仍为 2026-09-05，Up 37h）。`docker-compose ps app` = Up (healthy)。
- 无 staged 文件（`git diff --cached --name-only` = 0）；无 tracked 修改（`git diff --name-only` = 0）；HEAD 仍为 `32931f7`（未 commit）。

## Deployment 操作坑
- **compose v1（1.29.2）+ Docker 29.1.3**：`docker-compose up -d app` 在容器重建路径崩溃 `KeyError: 'ContainerConfig'`（`/usr/lib/python3/dist-packages/compose/service.py:1579` `container.image_config['ContainerConfig']`，Docker29 镜像 config 不再暴露该字段）。崩溃后旧容器被置为 `Exited (137)`。已按任务预案「`docker-compose rm -f app` → 再 `up -d app`」绕过，成功新建容器。
- 影响面：仅影响容器重建动作，`build` 阶段无此崩溃（已正常产出镜像）。

## Residual risks（残留风险）
- 若日后用 compose v1 执行任何**重建**既有同镜像名容器（非新建），`KeyError: 'ContainerConfig'` 大概率复现；需沿用「先 rm 再 up」或改用 compose v2。
- 本次 `up -d app` 时未指定 `--no-recreate` 之外的标注；数据/timescaledb 仍为不动（37h），未受波及。
- live bundle 验证基于静态标记/端点冒烟，未跑真浏览器交互（上游 vitest+tangle 已覆盖该逻辑）。

## 耗时
- `docker-compose build app`：Rust/依赖层命中缓存，仅前端 `npm ci`+`vite build` 重建（dist 层），约 1-2 分钟。
- `docker-compose up -d app`（崩溃）+ `rm -f` + 再 `up -d app`：秒级。
- 验证（bundle 抓取、5 端点、状态确认）：约 30 秒。
- 整体部署+验证：分钟级完成。
