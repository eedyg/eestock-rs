# 032 — 前端 R1/R2 部署报告（4bdd1e0）

- 报告位置：`eestock-rs/coder/report/032_r1r2_frontend_deploy.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（嵌套 git 仓库，HEAD = `4bdd1e0`）
- 目标：把前端 R1（宫格行高）/ R2（格表头 D2）以镜像方式送入 `eestock-app` 容器。只部署，不改源码/DB/SQL/Rust，不 commit。

## 结论先行

**目标已达成，但以“已部署”而非“重新构建换 hash”的方式达成。**

运行中容器 `eestock-app` 已在本次操作之前就携带 4bdd1e0 的前端产物。原因：镜像 `5294d0cbd9f0` 构建于
`2026-09-05 11:31:02 +0800`，而此时工作区已包含 R1/R2 的**未提交**改动（提交 4bdd1e0 落库时间为
`11:46:26 +0800`）。因此 `docker-compose build app` 对 `COPY web/ ./` 及 vite build 层**全部命中缓存**，
产出与运行镜像**逐字节相同**的镜像 ID → `up -d app` 判定 `up-to-date`，无需重建容器。

## 运行容器/镜像新旧 ID

| 项 | 操作前 | 操作后 | 变化 |
|----|--------|--------|------|
| app 镜像 ID | `5294d0cbd9f0` | `5294d0cbd9f0` | 不变（缓存命中） |
| app 容器 ID | `c85ad3f58464` | `c85ad3f58464` | 不变（未 recreate） |
| 容器状态 | Up (healthy) | Up (healthy) | 不变 |

## Bundle 前后

- 操作前已服务：`index-l_1GiLir.js` + `index-B29X4Q2x.css`
- 操作后仍服务：`index-l_1GiLir.js` + `index-B29X4Q2x.css`
- **hash 未变化。** 其原因即上述缓存命中——运行镜像与当前源码快照逐字节相同。

### 运行中 bundle 已含 R1/R2 的证据
下载 `http://127.0.0.1:8081/assets/index-l_1GiLir.js`（506,690 B）grep：
- `已停用` ×2、`无数据` ×5（R2：停用/无数据标的不伪造 +0.00%）
- `grid-rows-2` ×1、`grid-rows-3` ×1（R1：grid-view 显式均分行高）
- 说明运行中 bundle 即为 4bdd1e0 的 R1/R2 构建产物。

## 冒烟结果（操作后）

- `docker ps`：`eestock-app | eestock-rs_app | c85ad3f58464 | Up (healthy) | 0.0.0.0:8081-8082`
- `/healthz`：HTTP 200
- `GET /api/kline?code=518880&period=1m&limit=3`：HTTP 200，合法 JSON（3 根 bar，ts/open/high/low/close/volume/amount/source 齐全）
- `docker exec eestock-app ls /app/dist/assets`：仅 `index-B29X4Q2x.css` + `index-l_1GiLir.js`，**无旧 bundle 残留**

## 耗时

| 步骤 | 起止 | 耗时 |
|------|------|------|
| docker-compose build app | 1788580038 → 1788580042 | ~4 s（全缓存命中） |
| docker-compose up -d app | 1788580093 → 1788580093 | ~0 s（up-to-date，无操作） |

## compose 坑（Docker Engine 29.x × compose v1 `KeyError: 'ContainerConfig'`）

- 环境：Engine 29.1.3 + `docker-compose 1.29.2`（v1），命中该已知崩溃组合。
- `build app`：exit 0，**未触发** KeyError。
- `up -d app`：exit 0，**未触发** KeyError。输出 `eestock-timescaledb is up-to-date` + `eestock-app is up-to-date`。
- 无 `<oldid>_eestock-app` 孤儿容器，无需执行“删除孤儿再 up”避坑路径。
- 规避状态：本次未触发该坑；若未来出现，处理方式见任务指引（先删孤儿容器再 `up -d app`）。

## 残留风险

- **无**新 bundle 残留：`/app/dist/assets` 仅当前 pair。
- 未触碰 `timescaledb` / `data` 服务（up 时二者均 up-to-date，未 recreate）。
- 未改源码、未 commit、未 stage（`git status --porcelain --untracked-files=no` 为空；`git diff --cached` 为空）。
- 说明性风险：若上游预期“重建必换 hash”，需知晓当前运行镜像已等同 4bdd1e0 源码快照，此后再改前端才需重新构建出新 hash。
