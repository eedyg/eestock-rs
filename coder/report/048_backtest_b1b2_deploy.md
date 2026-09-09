# 048 — 回测增强 B1 + B2 部署报告（app 镜像重建 + 容器重建 + 冒烟）

**本文档位置**: `coder/report/048_backtest_b1b2_deploy.md`
**任务**: 部署回测增强（提交 `f2d4f2b` 后端 B1 + `32b3331` 前端 B2）到运行容器并验证。只部署，不改源码/DB/SQL/Rust，不 commit。
**状态**: 完成。app 镜像/容器重建并 healthy，B1 持久化/删除 + B2 前端 bundle 全部冒烟通过。**未改源码/DB/SQL/Rust，未 commit。**

---

## 1. 背景与前置确认

- 目标提交已在本工作树：`f2d4f2b`（B1：迁移 0012 + 初始金额/区间持久化 + DELETE 端点）、`32b3331`（B2：前端初始金额/日期区间/删除/时间 x 轴）。
- 迁移 0012 **已应用**（进入前 DB 查询 `\d backtest_runs` 已含 `initial_capital/date_from/date_to`，既有行回填 `created_at`）。本次未重复执行任何迁移。
- 进入前基线：app 镜像 `10348bb47509`，容器 `f51331ba5517`，SPA bundle `index-Ci62AeY3.js`；`GET /api/backtest/runs` 列表项**无** `initial_capital/date_from/date_to`（确认旧镜像尚未含 B1）。
- 本次仅重建 `app` 镜像（`eestock-rs_app`）与其字段/后端；`timescaledb` 与 `data` 容器全程未动（冒烟前后均 Up 11h healthy）。

## 2. 部署操作

1. `docker-compose build app` → **成功**（exit 0）。frontend 阶段 `VITE_API_MOCK=0 npm run build` 产出 `index-BNDUf0FO.js`(554711B)/`index-BRYws9jb.css`(17781B)；rust builder 阶段重编 `providers/mcp/storage/web/tushare/app` 等，`Finished release in 19.50s`。新镜像 `151c349c010b`。
2. `docker-compose up -d app` → **首次触发已有坑（见 §4）**：Docker Engine 29.x + compose v1 崩 `KeyError: 'ContainerConfig'`，旧容器被重命名遗留为孤儿 `f51331ba5517_eestock-app`（Exited 137）。
3. 按预案删除孤儿容器 `docker rm -f f51331ba5517_eestock-app`，再次 `docker-compose up -d app` → **成功**（exit 0），新容器 `10ed797955c1` 自新镜像创建。

## 3. 镜像 / 容器 / bundle 新旧

| 项 | 旧 | 新 |
|----|----|----|
| app 镜像 ID（`eestock-rs_app`） | `10348bb47509` | `151c349c010b`（重新打 `latest`；旧镜像已 `tag=<none>` 悬空） |
| app 容器 ID（`eestock-app`） | `f51331ba5517`（孤儿化后删除） | `10ed797955c1` |
| 容器状态 | Up (healthy) | Up (healthy)，`StartedAt 2026-09-05T14:32:21Z` |
| SPA bundle JS | `index-Ci62AeY3.js` (550733B) | `index-BNDUf0FO.js` (554711B) |
| SPA bundle CSS | `index-B90A4RnG.css` (17652B) | `index-BRYws9jb.css` (17781B) |
| `GET /healthz` | `{"status":"ok"}` | `{"status":"ok"}` |

新容器 `/app/dist/assets` 仅含新 bundle（无旧残留）。容器内 bundle md5 = 磁盘 `web/dist` bundle md5 = `1ca39257628114f1134327d5a3d567a5`（构建一致性）。

## 4. 遇到的 compose 坑（Docker Engine 29.x + compose v1）

`docker-compose up -d app` 首次运行在 `_execute_convergence_recreate → recreate_container → create_container → _build_container_volume_options → merge_volume_bindings → get_container_data_volumes` 处崩：
```
KeyError: 'ContainerConfig'
```
根因：compose v1.29.2 读取旧容器 `image_config['ContainerConfig'].get('Volumes')`，Docker Engine 29.x 不再返回该键。旧容器被 compose 重命名为 `<oldid>_eestock-app`（形如 `f51331ba5517_eestock-app`）进入 Exited(137)，原 `eestock-app` 名消失。
**处理**：`docker rm -f f51331ba5517_eestock-app` 删除孤儿 → 再次 `docker-compose up -d app`（此时无既有同名容器，走 create 而非 recreate 路径）→ 成功。预留的坑已被预案覆盖，无需修改任何 compose/源码。

## 5. 冒烟结果（app :8081）

### B1 后端
| 项 | 用例 | 结果 |
|----|------|------|
| `GET /api/backtest/runs` | 列表 | 200；列表项**含** `initial_capital`（=100000.0）、`date_from`、`date_to`（新 DTO 字段） |
| `GET /api/backtest/runs/{id}` | — | 200，返回 B1 字段 |
| `POST /api/backtest/runs` | 临时 run（body `initial_capital:200000, from:2026-08-03T00:00:00Z, to:2026-09-02T00:00:00Z`） | 200 → `{"run_id":77}` |
| `GET /api/backtest/runs/77` | 持久化校验 | `initial_capital=200000.0`, `date_from=2026-08-03T00:00:00Z`, `date_to=2026-09-02T00:00:00Z`, status=done（与提交一致） |
| `DELETE /api/backtest/runs/77` | 删除 | 200 → `{"deleted":true}` |
| `GET /api/backtest/runs/77` | 删除后 | 404 → `{"error":"run 不存在"}` |
| `GET /api/backtest/runs` | 删除后 | count=14，不含 id 77 |
| `DELETE /api/backtest/runs/999999` | 不存在 | 404 → `{"error":"run 不存在"}` |
| DB 级联 | `backtest_results` | `WHERE run_id=77` 行数 0（FK ON DELETE CASCADE 生效） |

### B2 前端
| 项 | 结果 |
|----|------|
| 容器内 bundle 含 B2 标记 | `initial_capital`×1、`api/backtest/runs/`×3、`deleteRun`×4、`删除`×2（B2 客户端/移除按钮/确认文案） |
| `GET /`（SPA） | 200 `text/html`，`index.html` 引用 `index-BNDUf0FO.js` + `index-BRYws9jb.css` |
| `GET /assets/index-BNDUf0FO.js` | 200 `text/javascript` |
| 旧 bundle `index-Ci62AeY3.js` | 容器 dist 无此文件（`/app/dist/assets` 仅新 bundle）；URL 200 系 SPA catch-all 回退 index.html |

### 既有端点回归
| 项 | 结果 |
|----|------|
| `GET /api/backtest/strategies` | 200；恰 7 款：`dual_ma, ma_rsi, macd, boll, kdj, momentum, atr_channel` |
| `GET /api/kline?code=518880&period=1d` | 200；返回 `{code,period,bars:[...]}`（kline 端点周期形参为 `1m/5m/15m/1h/1d`，`D1` 会 400 属预期格式） |
| `GET /api/symbols?with_stats=1` | 200；44 个 symbol，含 `code/name/latest/...` |
| `GET /healthz` | 200 `{"status":"ok"}`；容器 `State.Health.Status=healthy` 稳定 |

## 6. 耗时
- `build app`：22:31:16 → 22:31:41（约 25s，依赖层缓存命中，仅变更 crate 重编 + 前端构建）。
- `up -d app`（首崩）：22:31:51 → 22:32:01（触发 `KeyError: 'ContainerConfig'`）。
- 删孤儿 + `up -d app` 再次：22:32:21 → 22:32:22（成功）。
- 冒烟与复检至 22:34:25。整体部署+验证约 3 分钟。

## 7. 残留风险
- **悬空镜像**：旧镜像 `10348bb47509` 现为 `<none>`（原 `today` 无 tag）。无害，可 `docker image prune` 回收；未主动清理（任务不要求）。
- **B2 前端只做了负载/bundle/静态验证，未做真实浏览器交互回归**（初始金额输入、删除二次确认、时间轴渲染为 DOM 交互；bundle 内含对应代码标记，独立前端回归由 tester 承担）。
- 旧 bundle URL（`index-Ci62AeY3.js`）因 SPA catch-all 仍回 200（返回 index.html），非实际旧文件存在。
- 部署产物新增 untracked 日志：`logs/app_bt_b1_b2_build.log`、`app_bt_b1_b2_up.log`、`app_bt_b1_b2_up2.log` 与本报告（均未 commit，与既有部署日志模式一致）。

## 8. 变更文件
无源码/DB/SQL/Rust 改动（`git diff --name-only` 空，`git diff --cached --name-only` 空，HEAD 仍为 `32b3331`）。仅新增本报告与 3 个部署日志（untracked 产物）。
