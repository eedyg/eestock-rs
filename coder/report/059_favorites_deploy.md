# Report 059 — 看板收藏部署（F1+F2）到运行容器

**Report location**: `coder/report/059_favorites_deploy.md`

## What changed
**部署**（非源码变更）：
- 由源码 HEAD `0be85f9`（前端 F2）+ `344753b`（后端 F1）重建并重启 `eestock-app`。源码已在 HEAD，未做任何源码/DB/SQL/Rust 修改，未 commit。
- 应用镜像 `eestock-rs_app`:
  - 旧镜像 ID: `sha256:7c191c43c613...`（构建于 2026-09-06 09:36+0800，旧容器 `073c7787c812`）
  - 新镜像 ID: `sha256:708d54beca0e...`（构建于 2026-09-06 12:32+0800），tag `eestock-rs_app:latest`
- 运行容器 `eestock-app`:
  - 旧容器 ID: `073c7787c812`（此后被 compose recreate 改名为孤儿 `073c7787c812_eestock-app` 并 Exited）
  - 新容器 ID: `3f9592b8e520`，Up, health=healthy，image=`eestock-rs_app:latest`
- SPA bundle：
  - 旧: `index-ClPhQAKK.js` + `index-CA9E95tC.css`（builder 于旧镜像，容器 bundle 无收藏标记）
  - 新: `index-CEHpFWf8.js` + `index-o-r3oXQP.css`（builder 于新镜像，容器 bundle 含 `reorderFavorites`/`starSymbol`/`unstarSymbol`/`favorite_sort`）

## Architecture alignment
纯部署，无分层改动。应用面（web REST/WS/SPA + storage/domain）按 ADR-017 应用面自有 `favorite_symbols` 表（迁移 0013），数据面未读写。仅重建 `app` 服务，`timescaledb`/`data` 未动。

## Problem solved / feature added
把已合并的看板收藏功能（一键收藏置顶 + 收藏区拖拽重排 + 星标切换）发布到运行容器。修复了 Docker 29.x + compose v1(`1.29.2`) 在 recreate 时的 `KeyError: 'ContainerConfig'` 崩溃（images 缺少 `Config.ContainerConfig`）。

## Implementation approach
1. `docker-compose build app` → 走 multi-stage（frontend npm ci+vite build → rust release build → runtime）。依赖层命中缓存，仅重编变更源码（前端 dist 哈希变，rust 全量重编 30.58s）。
2. `docker-compose up -d app` → 首次触发已知 compose v1+Engine 29.x bug：`get_container_data_volumes` 访问 `image_config['ContainerConfig']` 抛 KeyError，recreate 失败（UP_EXIT=1）。
3. 清除 recreate 遗留孤儿容器 `073c7787c812_eestock-app`（docker rm -f）。
4. 重跑 `docker-compose up -d app` → 无旧容器可迁移，fresh create 成功（UP2_EXIT=0），容器转 healthy。

## Verification (smoke)
- `docker ps`：`eestock-app` Up healthy，image `eestock-rs_app`，容器 ID `3f9592b8e520`；SPA bundle `index-CEHpFWf8.js`。
- 容器 bundle grep：`reorderFavorites`/`starSymbol`/`unstarSymbol`/`favorite_sort` 均命中。
- `/healthz` → `200 {"status":"ok"}`。
- `/api/symbols`（44 项）每项含 `favorite`(bool) 与 `favorite_sort`(int|null)。
- 收藏流程：
  - baseline：518880 位于 index 38，无收藏。
  - `POST /api/symbols/518880/favorite` → `200 {"code":"518880","favorite":true}`；随后 `GET /api/symbols`：518880 `favorite=true, favorite_sort=1`，index 0，收藏先于非收藏（FAVORITES_BEFORE_NONFAV=True）。
  - 追加 2 个收藏（159337、159577）得 `[518880(1),159337(2),159577(3)]`。
  - `PUT /api/symbols/favorites/order {"codes":["159577","518880","159337"]}` → `200 {"codes":[...],"reordered":true}`；`GET` 次序 → `[159577(1),518880(2),159337(3)]`，仍收藏优先。
  - `PUT .../order {"codes":["159577","000000"]}`（未收藏 code）→ `400 {"error":"code 000000 未收藏"}`（额外佐证）。
  - `DELETE /api/symbols/518880/favorite` → `200 {"code":"518880","favorite":false}`（幂等）。
  - `POST /api/symbols/NONEXISTENT_XYZ/favorite` → `404 {"error":"code 未注册"}`。
  - 清理测试收藏后 favorites 为空（0），与测试前一致。
- 既有端点回归：`GET /api/kline?code=518880&period=1d&limit=5` → 200 含 bars；`GET /api/backtest/strategies` → 200 含策略列表。

## Test coverage
无新增/修改测试（部署任务）。既有源码测试已在仓库并随容器构建通过（cargo build --release 成功产出二进制）。

## Verification how confirmed
真实 HTTP 冒烟（curl 到 `localhost:8081`）与容器内 grep bundle；`docker inspect health=healthy`；`docker logs` 显示 `schema self-check ok` / `eestock-app serving`，无报错。

## Timing
- build: 12:32:14 → 12:32:52（~38s）
- up 首试 12:32:56 崩（KeyError, UP_EXIT=1）
- 孤儿清理 + up 重试 12:33:36 成功
- 冒烟完整至 ~12:35（外）；容器 healthy 于 12:33:56

## Docker-compose 坑
Docker Engine `29.1.3` + compose v1 `1.29.2`：Docker 29.x 镜像 config 移除了 `ContainerConfig`，compose v1 `get_container_data_volumes` 读 `image_config['ContainerConfig']` → `KeyError`。仅在需要 **recreate**（有旧容器迁移卷）时触发；删除被改名的手工孤儿 `〈oldid〉_eestock-app` 后触发 fresh create 即绕开。

## Residual risks
1. 旧镜像 `7c191c43c613` 已成 dangling（untagged `latest` 被新镜像占用），无功能影响，可用 `docker image prune` 定期清理。
2. 无 `_eestock-app` 残留孤儿容器（已核）。
3. favorite_symbols 表当前 0 收藏，处于干净初始态。
4. 前端构建有 chunk>500kB 提示（vite 警告，非错误，既有情况）。
