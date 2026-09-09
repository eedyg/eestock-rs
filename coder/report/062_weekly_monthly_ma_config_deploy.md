# Report 062 — 周/月线 + MA 可配置 部署（34c1bdd 后端 W1 + ffea540 前端 W2）

**Report location:** `coder/report/062_weekly_monthly_ma_config_deploy.md`（本文件）

## 任务
只部署，不改源码/DB/SQL/Rust，不 commit。重建 `eestock-app` 服务（backend+frontend），迁移 0014/0015 已应用。

## What changed
**纯部署**（无任何源码/DB/SQL/Rust 变更，工作区无 tracked 改动、无 staged 文件）。
- 由源码 HEAD `ffea540`（前端 W2）+ `34c1bdd`（后端 W1）重建 `eestock-rs_app` 镜像并重启 `eestock-app`。
- `timescaledb` / `data` 服务未动（仅 app）。

### 镜像
- 旧镜像 ID: `sha256:708d54beca0ebab45067aa780bbe857b668daf5f23d5e92ba5f92a5040c75dc4`（构建于 2026-09-06 04:32:52Z，上一次收藏部署 059）
- 新镜像 ID: `sha256:a378ac61605cd6d713b51154a85e97dc438104967977225d84ecbf3d1c5b0c90`（构建于 2026-09-06 12:00:39Z），tag `eestock-rs_app:latest`（87.6MB）
- 旧镜像已成为 dangling（`latest` 被新镜像占用），无功能影响。

### 容器 `eestock-app`
- 旧容器 ID: `3f9592b8e520`（此前 Up healthy；recreate 时被改名 `3f9592b8e520_eestock-app` 并 Exited，随后被 docker rm -f 清除）
- 新容器 ID: `0f5c1814c09bd996eeed5f88cd37d7296b16af5d70b6baf13da0f0c0a1f7d0ff`，Up，health=healthy，image=`eestock-rs_app:latest`

### SPA bundle
- 旧: `index-CEHpFWf8.js`（`docker exec` 容器内 `/app/dist/assets/` 实测；CSS `index-o-r3oXQP.css` 见 059 报告）
- 新: `index-BJnMTbeF.js` + `index-Cxv8CfRK.css`（vite build 输出 + 容器 `ls /app/dist/assets/` + HTTP `/` 引用的 index.html 一致）
- 前端「先清后建」：Dockerfile.app frontend 阶段 `rm -rf dist`，故容器内只留下新 bundle（无历史残留）。

## Architecture alignment
纯部署，无分层改动。应用面（web REST/WS/SPA + storage/domain）按 ADR-017 使用应用面自有 `ma_config` 表（迁移 0015）与周/月 cagg（迁移 0014，accurate 层）；数据面未读/写。仅重建 `app` 服务，`timescaledb`/`data` 未动。

## Problem solved / feature added
把已合并的单格看板周线/月线周期 + MA 可配置（后端 W1 + 前端 W2）发布到运行容器。包含 `GET/PUT /api/config/ma`、`/api/kline?period=1w|1mo`、前端周期按钮与 MA 配置控件。

## Implementation approach
1. `docker-compose build app`（GET 20:00:14 → 20:00:39，~25s；多阶段：frontend npm ci+vite build → rust release build，命中依赖层缓存，仅重编变更源码；rust Finished in 19.79s）。
2. `docker-compose up -d app`（首试 20:00:49 → 20:01:00）→ 触发已知 Docker Engine 29.x + compose v1(`1.29.2`) bug：`KeyError: 'ContainerConfig'`（`get_container_data_volumes` 读 `image_config['ContainerConfig']`），recreate 失败（UP_EXIT=1）。旧容器被改名 `3f9592b8e520_eestock-app` 并 Exited。
3. 清除 recreate 遗留孤儿容器 `3f9592b8e520_eestock-app`（`docker rm -f`）。
4. 重跑 `docker-compose up -d app`（20:01:11 → 20:01:12）→ 无旧容器可迁移，fresh create 成功（UP_EXIT=0），容器经 ~20s 转 healthy（20:01:32）。

## Verification (smoke)
- `docker ps`：`eestock-app` Up healthy，image `eestock-rs_app:latest`，容器 `0f5c1814c09b`。无 `_eestock-app` 孤儿残留。
- SPA bundle 前后哈希变化：`index-CEHpFWf8.js` → `index-BJnMTbeF.js`。
- 容器 bundle grep：`getMaConfig` / `saveMaConfig` 均命中。
- `/healthz` → 200 `{"status":"ok"}`。
- `GET /api/kline?code=518880&period=1w&limit=5` → 200 `{"period":"1w","bars":5,...}`；`period=1mo` → 200 `{"period":"1mo","bars":5,...}`。数据库中 `kline_accurate_1w`(5942 行, 518880 有 138 行) / `kline_accurate_1mo`(1425 行, 518880 有 33 行)。
- `GET /api/config/ma`（表空/默认）→ 200 `{"windows":[5,10,20]}`；`PUT {"windows":[3,7,21]}` → 200 `{"windows":[3,7,21]}`；随后 `GET` → 200 `{"windows":[3,7,21]}`（持久化）。
- 非法：`{"windows":[]}` → 400 `MA 至少 1 条`；`{"windows":[0]}` → 400 `MA 窗口须为 1..=500 整数，不合规值：0`；`{"windows":[1,2,3,4]}` → 400 `MA 最多 3 条`；`{"windows":[501]}` → 400 `MA 窗口须为 1..=500 整数，不合规值：501`。非法 PUT 后 GET 仍为 [3,7,21]（未落库）。
  - ⚠️`{"windows":[5,"x"]}`（非整型）→ **422**（axum `Json` 反序列化语义错误 `JsonDataError`），非 400。属 axum 反序列化层行为，非业务校验；业务校验（空/0/越界/条数）均正确返回 400。见残余风险。
- 恢复：测试结束用 `PUT /api/config/ma` 恢复到默认 `{"windows":[5,10,20]}`（当前行 = `{5,10,20}`，与测试前语义一致，亦为后端空表默认值）。
- 既有端点回归：`GET /api/symbols` → 200（44 项，含 favorite/favorite_sort 键）；`GET /api/backtest/strategies` → 200（含策略列表）；`GET /api/kline?period=1d&limit=5` → 200 `{"period":"1d","bars":5}`。
- 部署前基线：`period=1w`/`1mo` → 400（旧二进制不解析），`GET /api/config/ma` → 404，证实新功能确实由本次部署发布。

## Test coverage
无新增/修改测试（部署任务）。既有源码测试随容器构建通过（cargo build --release 成功产出二进制，rust Finished 无错）；`web/tests/api_kline_period.rs` 等未纳入 `--bin eestock-app` 构建（不影响部署产物）。

## Timing
- `docker-compose build app`: 20:00:14 → 20:00:39（~25s）
- `up` 首试 20:00:49 → 20:01:00（崩，KeyError, UP_EXIT=1）
- 孤儿清理 `docker rm -f 3f9592b8e520_eestock-app`: 成功
- `up` 重试（fresh create）20:01:11 → 20:01:12（UP_EXIT=0）
- 容器转 healthy: ~20:01:32（整体 ~78s）

## Docker-compose 坑
Docker Engine `29.1.3` + compose v1 `1.29.2`：Docker 29.x 镜像 config 移除了 `ContainerConfig`，compose v1 `get_container_data_volumes` 读 `image_config['ContainerConfig']` → `KeyError: 'ContainerConfig'`。仅在需要 **recreate**（有旧容器迁移卷）时触发；删除被改名的手工孤儿 `〈oldid〉_eestock-app` 后触发 fresh create 即绕开。（与 059 部署同坑。）

## Residual risks
1. ~~**非整型 422 非 400**~~：任务期望「非整 → 400」，实际 axum `Json<T>` 反序列化语义错误返回 422（`{"windows":[5,"x"]}`）。业务校验（空/0/越界/条数超限）均正确 400。此为 axum 行为，非缺陷；前端不会发送非整型。若需严格 400 需后端改 handler（超出本部署任务范围，不改源码）。
2. **旧镜像 `708d54beca0e` 成 dangling**（`latest` 被新镜像占用），无功能影响，可用 `docker image prune` 定期清理。
3. **`workspace` 内既有未跟踪文件**：`crates/web/tests/api_kline_period.rs` 为后端 coder 未 commit 的测试文件（不进入 `--bin eestock-app` 编译，不影响部署产物）；`coder/report/060/061` 等报告为既有未跟踪。均为既有状态，与本部署无关。
4. **ma_config 现为单行 `{5,10,20}`**（测试后恢复默认值），与测试前「空表→默认」语义一致；应用运行期可经 PUT 更新。
5. **周/月数据仅 2024+**（cagg 均 `WHERE ts >= '2024-01-01'`，与 0010 同口径）；2012-2023 旧数据周/月不可见（既有口径，非本次引入）。
