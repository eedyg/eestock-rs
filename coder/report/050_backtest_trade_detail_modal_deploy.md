# 050 — 交易明细弹窗修复部署（前端唯一改动 a6c5cd0）

本报告路径：`coder/report/050_backtest_trade_detail_modal_deploy.md`

## Scope
纯部署任务。仅重建 `app` 服务（前端 `TradeDetailModal` 替代 navigate 跳行情看板）。不改源码/DB/SQL/Rust，不 commit。
提交：`a6c5cd0 feat(web): 交易明细改为弹窗展示(替代跳行情看板全重载)`，已位于 HEAD（部署前即已存在，无需 code 变更）。

## What changed
- 仅重建 `eestock-rs_app` 镜像 + `eestock-app` 容器。
- **源码零改动**：`git diff --cached --stat` / `git diff --stat` 均为空；`git status --porcelain` 出现的均为既有 untracked（reports/logs/tests）与本部署新增的 build/up 日志，无 tracked 源文件被改。
- 新增日志（untracked，非源码）：`logs/app_trade_modal_build.log`、`logs/app_trade_modal_up.log`、`logs/app_trade_modal_up2.log`。

## 镜像/容器 新旧 ID
- 旧镜像：`sha256:151c349c010b977d01fe35bec991f441488e2da7f0f1b1b2b244929ca4f4044f`（短 `151c3`）
- 新镜像：`sha256:e3353b39c7ddb38b3de8aa19438b0b51c8457e91764bc56ad54ef7f01fbc658d`（短 `e3353b`，对应 build 产物 `e3353b39c7dd`）
- 旧容器：`10ed797955c1`（重建后成为孤儿 `10ed797955c1_eestock-app`，已删除）
- 新容器：`2f25f1697947`（`Up (healthy)`）

## Bundle 前后（SPA 哈希）
- 前：`index-BNDUf0FO.js`
- 后：`index-BHzYnVG3.js`（curl SPA 首页提取 + `docker exec eestock-app ls /app/dist/assets` 一致；旧 `index-BNDUf0FO.js` 已无残留，dist 仅 `index-BHzYnVG3.js` 与 `index-BjkrQzlp.css`）

## 冒烟
- `/healthz` → HTTP 200
- `GET /api/backtest/runs` → 正常返回真实数据（`[{"id":35,...,"strategy_id":"dual_ma",...}]`）

## compose 坑（Docker Engine 29.1.3 + compose v1.29.2）
- `docker-compose up -d app` 首次触发 `KeyError: 'ContainerConfig'`（compose v1 在 `get_container_data_volumes` 读旧容器 `image_config['ContainerConfig']`，新 Docker Engine 镜像元数据无该键 → 崩）。
- 复现命中预判。处理：删除 recreate 遗留孤儿容器 `10ed797955c1_eestock-app`（由旧 `eestock-app` 重命名而来、Exited(137)），再 `docker-compose up -d app` → 成功 `Creating eestock-app`.
- 仅重建 app；timescaledb/data 保持 `up-to-date`，未受影响。

## 耗时（近似）
- build：Rust builder 阶段全部 cache-hit（Steps 8-26 全用缓存），仅前端阶段（npm build）重编，vite build ~1.09s；整体 build（含 Docker 分析）约 1-2 分钟。
- up：首次 `KeyError` 崩溃为瞬间失败；删除孤儿 + 二次 `up -d app` 秒级完成。

## 残留风险
- 无旧 bundle 残留（`index-BNDUf0FO.js` 已不在 dist）。
- KeyError 为 compose-v1 + 新 Engine 的已知不兼容；下次 recreate 若再触发，重复「删孤儿 → up -d app」即可。
- 新容器健康检查确认 `healthy`；前端改动为纯 UI（弹窗替代跳转），后端 REST/WS 未变。

## Verification
- `docker ps`：`2f25f1697947  eestock-rs_app  Up (healthy)  eestock-app` ✓
- 新镜像 ID = build 产物 ID ✓；bundle 前后哈希变化 ✓；healthz/runs 冒烟 ✓；dist 无残留 ✓
- 无 staged 文件（`git diff --cached` 为空）✓
