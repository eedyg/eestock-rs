# 024 — K 线「循环/重复 bar」前端修复：重建镜像并上线上运行容器

> 本报告文件位置：`eestock-rs/coder/report/024_kline_deploy.md`
> 状态：部署完成；应用镜像 `eestock-rs_app:latest` 已更新，运行容器 `eestock-app` 已重建为 Up(healthy)，SPA bundle 哈希已切换。
> 范围声明：**纯部署操作**（镜像重建 + 容器重建）。未改动任何源码/测试/DB/SQL/Rust；未 commit，保持上一任务 worker 的暂存态。

---

## 0. 结论摘要

- 上一任务的 3 个暂存文件（`KlineChart.tsx` 修改 + `klineDataLoader.ts` + `klineDataLoader.test.ts`）已确认在工作区。
- 重建应用镜像 `eestock-rs_app:latest`：成功（exit 0）。Rust 阶段**全部缓存命中**（源码未动，未重编）；唯一实际变更 = 前端 `vite build` 产出新 bundle。
- 运行容器 `eestock-app` 已从新镜像重建，`Up (healthy)`，8081/8082 端口正常绑定。
- 前端 bundle 哈希前→后：`index-CxuMXxWR.js` → `index-_GWBq5Ak.js`（已更新，旧 bundle 已从 `/app/dist/assets` 消失，无历史残留）。
- 冒烟 API `GET /api/kline?code=518880&period=1m&limit=3` 仍返回正常 JSON（数据层未被本次改动影响）。
- 数据容器 `eestock-data` 与 `eestock-timescaledb` 均未受影响（保持原容器 ID 与 Up(healthy)）。

---

## 1. 执行环境与前置确认

- 工作区：`/home/eestock/workspace/git/eestock/eestock-rs`
- 镜像构建工具：本机只有 **docker-compose v1.29.2**（`docker compose` v2 插件不可用）。部署命令等效替换为 `docker-compose ...`。
- 前置确认（执行前基线）：
  - `git status`：3 个文件已暂存（`M KlineChart.tsx`、`A klineDataLoader.test.ts`、`A klineDataLoader.ts`），未 commit。
  - 旧运行容器 `eestock-app`（`f2d6d5a58326 / e45fa2a74a72`）Up(healthy)。
  - 旧前端 bundle：`index-CxuMXxWR.js`；健康检查 `GET /healthz` 返回 `{"status":"ok"}`。

## 2. 执行命令（按序）

### 2.1 重建应用镜像
`docker-compose build app`

- 输出要点：
  - frontend 阶段 `npm ci` 命中缓存；`RUN rm -rf dist`（清历史产物）执行；
  - `RUN VITE_API_MOCK=0 npm run build` 执行成功：产出 `dist/assets/index-_GWBq5Ak.js`（512.31 kB，gzip 148.69 kB）、`dist/assets/index-DXeTIV4V.css`（16.01 kB）；提示 chunk >500kB 仅为警告，非失败。
  - builder 阶段（rust）`cargo fetch`、`COPY crates ./crates`、`cargo build --release --bin eestock-app` **均为 `Using cache`** → 未重编 Rust，确认源码未动。
  - 结果：`Successfully built d9ddb9441c07` / `Successfully tagged eestock-rs_app:latest`（exit 0）。
  - 日志：`/tmp/kline_deploy_build.log`

### 2.2 重建运行容器（遇到 docker-compose v1 ↔ Engine 29.x 兼容性 bug）
`docker-compose up -d app` 首次执行**失败**于：
```
File ".../compose/service.py", line 1579, in get_container_data_volumes
    container.image_config['ContainerConfig'].get('Volumes') or {}
KeyError: 'ContainerConfig'
```
根因：docker-compose v1.29.2 在“重建已存在容器”时读取旧容器 image_config 的 `ContainerConfig` 字段；Docker Engine 29.x 的 image inspect 已不再返回该字段 → 崩溃。**与本次改动/应用无关，纯工具兼容性问题**。（日志 `/tmp/kline_deploy_up.log`）

该崩溃已把旧容器改名并停止为 `f2d6d5a58326_eestock-app`（Exit 137），未创建新容器。

### 2.3 变通（等效部署：清理孤儿容器后从新镜像重建）
1. `docker rm -f f2d6d5a58326_eestock-app` → 删除已停止的旧应用容器（仅只读 bind mount `config/app.toml`，无持久数据）。（exit 0）
2. `docker-compose up -d app` → `Creating eestock-app ... done`（exit 0）。此时无“已存在容器”需合并 volume，避开 `get_container_data_volumes` 崩溃。（日志 `/tmp/kline_deploy_up2.log`）

> 说明：该变通仅清理“本次失败 recreate 遗留的孤儿容器”并重建，不影响 `timescaledb`/`data`。

### 2.4 健康/前端/冒烟核验
- `docker ps --filter name=eestock-app` → `d1dbde795f2a  eestock-rs_app  Up (healthy)  0.0.0.0:8081-8082->8081-8082`
- `curl -s http://127.0.0.1:8081/healthz` → `{"status":"ok"}`
- `curl -s http://127.0.0.1:8081/` 解析 bundle：`index-_GWBq5Ak.js`（旧 `index-CxuMXxWR.js` 已不再被引用）
- `docker exec eestock-app ls -la /app/dist/assets/` → 仅 `index-_GWBq5Ak.js` + `index-DXeTIV4V.css`（无历史残留 `index-CxuMXxWR.js`）
- 冒烟 `curl -s 'http://127.0.0.1:8081/api/kline?code=518880&period=1m&limit=3'` → 正常 JSON（3 条 bar，`source:"tushare"`）

## 3. 镜像/容器 新旧现状

| 项 | 部署前 | 部署后 |
|---|---|---|
| 应用镜像 `eestock-rs_app:latest` | `e45fa2a74a72` | `d9ddb9441c07` |
| `eestock-app` 容器 | `f2d6d5a58326`（Up healthy） | `d1dbde795f2a`（Up healthy） |
| 容器实际使用镜像 | `e45fa2a74a72` | `sha256:d9ddb9441c07` |
| SPA bundle | `index-CxuMXxWR.js` | `index-_GWBq5Ak.js` |
| `eestock-data` | `f3c6b317d0c6`（Up 9h healthy，未动） | 同（未动） |
| `eestock-timescaledb` | `9c28754c1455`（Up 24h healthy，未动） | 同（未动） |

## 4. 耗时

- 开始：`2026-09-04T14:51:11Z`；完成：`2026-09-04T14:52:40Z`；总约 **89 秒**（含健康检查等待 ~16s 与首次 `up` 失败处理）。镜像构建本身约 7 秒（Rust 全命中缓存，仅前端 vite rebuild）。

## 5. 残留风险

1. **旧镜像 `e45fa2a74a72` 仍在宿主机**（Docker 仓库中残留，未被引用）。不影响运行；如需清理可后续 `docker image rm e45fa2a74a72`。
2. **首次 `docker-compose up -d app` 崩溃暴露的工具兼容性问题**：本机只有 docker-compose v1.29.2，与 Docker Engine 29.x 的 `recreate` 路径不兼容（`KeyError: 'ContainerConfig'`）。本次用“先删除旧容器再 `up`”变通规避。日后任何 `app/data` 的 `docker-compose up -d` 重建都可能遇到同样崩溃，建议父/架构师考虑升级到 Compose v2 插件（`docker compose`）。
3. 前端 bundle 体积提示 >500kB 为 vite 警告，非失败；无功能影响。
4. 本次为演示数据源（`source:"tushare"`），冒烟返回 3 条 bar 均来自正常接口，数据层未受影响。

## 6. 本次未做（明确边界）

- 未改任何源码/测试/DB/SQL/Rust。
- 未 commit `git`（保持上一任务 worker 的暂存态：`KlineChart.tsx` + 2 新文件）。
- 未清理旧镜像（见 §5.1）。
- 未升级 docker-compose/引擎（超出本次部署范围）。
