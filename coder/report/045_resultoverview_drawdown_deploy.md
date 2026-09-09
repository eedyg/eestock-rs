# 045 — 回测页缺陷修复部署（ee1bd20 前端唯一改动）

报告文件位置：`coder/report/045_resultoverview_drawdown_deploy.md`

## What changed（本次部署动作，非代码变更）

仅重建并重启 `eestock-app` 服务；未修改任何源码 / DB / SQL / Rust，未 commit，未 stage。

| 项 | 部署前 | 部署后 |
|----|--------|--------|
| app 镜像 | `eestock-rs_app:latest` = `sha256:c86773b4235d` | `eestock-rs_app:latest` = `sha256:10348bb47509` |
| app 容器 | `969a8a0900d6`（Up healthy） | `f51331ba5517`（Up healthy） |
| SPA bundle | `index-Dotb4dP2.js` | `index-Ci62AeY3.js` |

## Problem solved / feature added

部署提交 `ee1bd20`（前端唯一改动，3 文件：`web/src/features/backtest/ResultOverview.tsx`、`format.ts`、`MetricCards.tsx`）。修复结果图回撤着色负宽 rect 缺陷（长序列 n>981 时 `width` 为负 → React dev `console.error` + 着色失效），并新增 `formatAvgHold` 平均持仓按 ADR 换算取整。本次部署将修复后的 SPA 落到运行中的 `eestock-app`（Dockerfile.app frontend 阶段 vite build）。

## Implementation approach（在既定架构内的决策）

- 仅前端变 → Rust builder 层全部命中缓存（Dockerfile.app 第 9–26 步 `Using cache`），仅 frontend 阶段 `COPY web/ ./` 与 `npm run build` 重跑，产出新 bundle `index-Ci62AeY3.js`（vite 1.08s）。
- 多阶段镜像自包含：runtime（debian:bookworm-slim）从 frontend `COPY --from=frontend /web/dist /app/dist`；`static_dir=/app/dist` 与 `VITE_API_MOCK=0` 直连真后端，无 mock 数据。

## Compose 坑（本轮触发）

`docker-compose up -d app`（compose v1.29.2）在 Docker Engine 29.1.3 下崩溃：
`KeyError: 'ContainerConfig'`（`compose/service.py merge_volume_bindings → get_container_data_volumes → container.image_config['ContainerConfig']`）。重建流程在 recreate 时把旧容器改名为孤儿 `<oldid>_eestock-app`（`969a8a0900d6_eestock-app`，Exited 137）后崩溃。
处置：`docker rm 969a8a0900d6_eestock-app` 移除孤儿 → 重跑 `docker-compose up -d app` 成功。当前无任何孤儿容器。

## Test coverage / Verification（关键：长序列 run 0 console error）

`curl`/浏览器冒烟 + Playwright(chromium) 真容器交互验证，全部通过：

- `docker ps`：`eestock-app | f51331ba5517 | eestock-rs_app | Up healthy`；`timescaledb`、`data` 均 healthy（未动）。
- `/healthz` → `200 {"status":"ok"}`。
- `GET /api/backtest/strategies` → 200，7 款（dual_ma/ma_rsi/macd/boll/kdj/momentum/atr_channel）。
- `GET /api/backtest/runs` → 200，13 条（id 45..33）。
- 长序列 run38（518880 / M5 / done，`net_value.series` 8200 点，>981）打开 `/backtest` 点「查看」：
  - `console.error` = **0**，`console.warning` = 0，`pageerror`(uncaught) = 0，`requestfailed` = 0；
  - 结果图 render `<rect>` 共 **8103** 条，`minWidth=0.5`（= `Math.max(0.5, step-1)` 下限），**negative width = 0**——与提交记录中修复前 8103 次负宽 console.error 数量吻合，回归确认。
  - MetricCards 全量渲染（Net Profit / Max Drawdown / Sharpe / 胜率 19.2% / 盈亏比 3.46 / 年化 −19.6% / 总交易数 229 / **平均持仓 17bar** 经 formatAvgHold）；ResultOverview 净值/回撤着色、PeriodHeatmap 月/周均正常。

## 耗时

- `docker-compose build app`：**4s**（Rust 层缓存命中，仅前端 vite build）
- `docker-compose up -d app`（首次）：11s，崩溃于 `ContainerConfig`
- 移除孤儿后 `up -d app`：**1s**
- app 进入 healthy：约 6s
- Playwright 长序列 run 验证：约 5s

## 残留风险

- compose v1.29.2 + Docker Engine 29.1.3 的 `KeyError: 'ContainerConfig'` 在下一次 `docker-compose up` 触发 recreate 时仍会复现；处置已脚本化（`docker rm <oldid>_eestock-app` 后再 `up -d app`）。当前孤儿已清。
- 旧镜像 `c86773b4235d` 已无 tag（dangling layer），可后续 `docker image prune`；不影响运行。
- 新增/覆盖 3 个 untracked 部署日志：`logs/app_bt_deploy_build.log`（覆盖已有）、`logs/app_bt_deploy_up.log`、`logs/app_bt_deploy_up2.log`。该目录为既有的未跟踪 scratch 区（与仓库模式一致），非源码/DB/SQL/Rust，未 stage、未 commit。
- 生产构建剥除 React dev-mode 警告，故「0 console error」为生产产物口径；修复本身已由 DOM 结构（8103 rect / minWidth 0.5 / 0 负宽）落实，不受 dev 警告剥离影响。
