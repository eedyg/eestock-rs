# 043 — 回测功能部署报告（app 镜像重建 + 容器重建 + 冒烟）

**本文档位置**: `coder/report/043_backtest_deploy.md`
**任务**: 部署回测功能（前端+后端）到运行容器并验证。只部署，不改源码/DB/SQL/Rust，不 commit。
**状态**: 完成。app 容器已重建并 healthy，回测端点全部冒烟通过。

---

## 1. 背景与前提

- 回测 5 个提交已在本工作树：`97fe314`(引擎/策略)、`ae0ee00`(存储/域端口)、`7f97c81`(应用服务)、`a9c35d4`(web REST+WS+DI)、`212d6a7`(前端页面)。
- DB 迁移 0011 已应用（`backtest_runs`/`backtest_results` 表在）。
- 本次仅重建 `app` 镜像 `eestock-rs_app` 与 `eestock-app` 容器；未改产品源码、DB、SQL、Rust；未 commit。

## 2. 遇到并解决的阻塞 — build 基础设施修复（父级批准 方案 B）

### 现象
`docker-compose build app` 在 Step 22 `cargo fetch` 崩溃：
```
error: failed to load manifest for workspace member `/build/crates/app`
  Caused by: failed to load manifest for dependency `application`
    failed to read `/build/crates/application/Cargo.toml`
    No such file or directory
```
### 根因
workspace `members=["crates/*"]` 已含新增手写 crate `backtest`/`application`（依赖图：`app→application→backtest`，`web→application`），但 `Dockerfile.app` 的 cargo 缓存层仅列原 10 个 crate（`COPY crates/<c>/Cargo.toml` 清单 + `for c in ... lib.rs` 占位循环）。`cargo fetch` 解析整个 workspace 依赖图，找不到 `crates/application/Cargo.toml` → 失败。tangle 事实源 `design/07-app-plane/00-web-api.md#Dockerfile.app` 同样缺这两个 crate。

### 修复（父级裁决：方案 B，改设计源再 tangle，保持 tangle 一致性）
1. `design/07-app-plane/00-web-api.md` Dockerfile.app 块：
   - `COPY crates/<c>/Cargo.toml` 追加 `crates/application/Cargo.toml`、`crates/backtest/Cargo.toml`（12 个）。
   - 注释 "10 个 crate" → "12 个 crate"。
   - stub 循环追加 `application backtest`（`for c in alert app application backtest collector diagnose domain mcp providers storage tushare web`）。
2. 执行 `entangled tangle` 重生成 `Dockerfile.app`，与设计块一致（无 diff 漂移）。

> 该改动为 build 基础设施修复（非产品代码/DB/接口），仍在「部署该回测功能」必要范围内。**不 commit，保留在 working tree，随回测一并提交。**

## 3. 变更文件（仅 build 配置，已获批复）
| 文件 | 变更 |
|------|------|
| `design/07-app-plane/00-web-api.md` | Dockerfile.app tangle 块：追加 application/backtest 两 crate 到 COPY 清单 + 占位循环（+4/-2） |
| `Dockerfile.app` | 由 `entangled tangle` 从上述设计块重生成（+4/-2），含新两 crate 的缓存层清单 |

## 4. 镜像 / 容器新旧
| 项 | 旧 | 新 |
|----|----|----|
| app 镜像 ID（`eestock-rs_app`） | `22303381a980` | `c86773b4235d` |
| app 容器 ID（`eestock-app`） | `539fb12d0ee6`（孤儿化后删除） | `969a8a0900d6` |
| SPA bundle JS | `index-DT0b4Z2M.js` (517113B) | `index-Dotb4dP2.js` (550569B) |
| SPA bundle CSS | `index-DVa8V5AN.css` (17197B) | `index-B90A4RnG.css` (17652B) |
| `GET /healthz` | `{"status":"ok"}` | `{"status":"ok"}` |

`docker exec eestock-app ls /app/dist/assets` 仅含新 bundle（`index-Dotb4dP2.js` + `index-B90A4RnG.css`），无旧残留在 `index-DT0b4Z2M.js`（Dockerfile `rm -rf dist` 已防残留）。

## 5. 冒烟结果（后端 eestock-app :8081）
### 回测端点
| 端点 | 用例 | 结果 |
|------|------|------|
| `GET /api/backtest/strategies` | — | 200；恰 `7` 款：`dual_ma, ma_rsi, macd, boll, kdj, momentum, atr_channel`；每款含 `id/name/description/params_schema` |
| `POST /api/backtest/runs` | 合法 body（period=D1, RFC3339 from/to） | 200 → `{"run_id":33}` |
| `GET /api/backtest/runs` | — | 200 列出 run；`status/current_ts/progress/net_value` 随状态推进 |
| `GET /api/backtest/runs/33` | — | 200；`status=done`、`progress=100`；`net_value:{series,drawdown}`(98 点)、`metrics:` 8 项、`trades:` 3 笔（含 close_bar/open_bar/pnl/shares/stamp_duty/commission…） |
| `POST /api/backtest/runs` | period=`1s`（非法） | 400 `period 须为 M1/M5/M15/D1，实际 1s` |
| `POST /api/backtest/runs` | strategy_id=`does_not_exist` | 404 `未知策略 id: does_not_exist` |
| `GET /api/backtest/compare?ids=33` | — | 200，返回该 run |
| `GET /api/backtest/compare?ids=abc` | — | 400 `ids 含非数字: abc` |
| WS `/ws` | `{"type":"subscribe","topic":"backtest"}` + 提交长 run(34, 2018→2024) | 实时收到数百条 `{"type":"backtest_progress","run_id":34,"pct":63→100,"bar_ts":…}`；run 34 最终 `status=done`、`trades=49` |

### 既有功能未破坏
| 端点 | 结果 |
|------|------|
| `GET /api/kline?code=518880&period=1d&from=…&to=…` | 200，240 bars |
| `GET /api/symbols?with_stats=1` | 200，44 symbols，含 `latest`/`today_bars` |

### 其他服务
`eestock-app`、`eestock-timescaledb`、`eestock-data` 均 `Up (healthy)`。

## 6. 部署耗时
- `docker-compose build app`（全新重编 backtest/application/storage/web/app + 前端）：约 **120 秒**（失败首发 ~1s 的 cargo fetch 为阻塞；修复后重编成功）。
- `docker-compose up -d app`（含孤儿容器清理 + 重试）：秒级。
- 冒烟测试：数十秒。

## 7. compose 坑与处置
- 已命中 **Docker Engine 29.x + compose v1 1.29.2** 的 `KeyError: 'ContainerConfig'` 崩溃（`_build_container_volume_options` → `merge_volume_bindings` → `get_container_data_volumes` 读旧容器 `image_config['ContainerConfig']`）。
- 处置：找到 recreate 遗留孤儿容器 `539fb12d0ee6_eestock-app`（Exited），`docker rm -f` 删除后，`docker-compose up -d app` 以全新创建（绕过 volume-merge 路径）成功。

## 8. 残留风险
1. **compose v1 + Engine 29.x 不兼容（build 基础设施坑）**：`ContainerConfig` schema 变更，compose 1.29.2 不再兼容。本次靠删孤儿容器绕行；未来任何需要 recreate `eestock-app` 的操作（`docker-compose up -d` 重建）可能再次触发，需保留「删孤儿 → 重试」处置流程，或迁移到 compose v2 plugin。
2. **build 配置修复未 commit**：`Dockerfile.app` 与 `design/07-app-plane/00-web-api.md` 两处为未提交 working-tree 修改（父级要求随回测一并提交）。若被丢弃，重建镜像将再次 failed cargo fetch。
3. **旧镜像残留**：旧 `22303381a980` 已变 dangling `<none>` 镜像（重 tag 所致）；另有多个中间 build 层 `<none>`。均为 Docker 正常产物，`docker image prune` 可清理，非本项目风险。
4. **前端仍在镜像内构建**：`VITE_API_MOCK=0`，SPA 由镜像内 `npm run build` 产出；若后续要接真后端 mock 之外的分支，需重构建。当前已验证 bundle 引用全新哈希。

## 9. 验证结论
- 回测「策略目录(7) → submit(200/run_id) → list → get(完成含净值/指标/交易) → compare → 非法校验(400/404) → WS 实时进度」全链路通过。
- 既有 kline/symbols 正常，healthz ok，三容器 healthy。
- 未改产品源码/DB/SQL/Rust，未 commit，无 staged 文件。
