# 029 — N2 告警列表定高 h-[680px] 部署上线（04f34e0）

> 本报告文件位置：`coder/report/029_alertlist_h680_deploy.md`
> 部署时间：2026-09-05 09:05:16–09:05:52（宿主机 CST）

## 目标（铁律：仅部署，不改源码/DB/SQL/Rust，不 commit）

将已提交的最后一笔前端提交 `04f34e0`（AlertList `max-h-[680px]` → `h-[680px]`，防御性一致化）部署到运行容器 `eestock-app`（宿主机 8081/8082）。使已部署 bundle == 已提交代码。

## 部署前状态（before）
- 运行容器：`a69e022a2f3f`（名 `eestock-app`，Up healthy），镜像 `eestock-rs_app:latest`
- 镜像 ID：`sha256:5bc71314fd83...`
- 前端 bundle：`index-B8z_Abxt.js`；assets：`[index-B10HbC_2.css, index-B8z_Abxt.js]`
- 8 像素级验证：`index-B8z_Abxt.js` 内 `680px` 上下文为 `max-h-[680px]` → 确认为旧代码（7fab9f1 的 N2），**不含** 04f34e0 的 `h-[680px]`。
- 时间线佐证：容器构建/启动于 08:32（CST），04f34e0 于 09:04:15 提交（晚于镜像构建），故必须重建。

## 实施（按序）
1. `docker-compose build app` → 退出码 0，成功产出新镜像 `sha256:9d39b951b98f...`
   - Rust 依赖层命中缓存（Step 22 `cargo fetch`、Step 24 `cargo build --release`、Step 27 `COPY --from=builder .../eestock-app` 均标 `Using cache`）→ 源码/二进制复用缓存，**未重编 Rust**。
   - 前端阶段 Step 28 `COPY --from=frontend /web/dist` **未**命中缓存 → `VITE_API_MOCK=0 npm run build` 重新产出 dist。变更仅限前端 vite build + 镜像 ID。
2. `docker-compose up -d app` → **触发已知坑 `KeyError: 'ContainerConfig'`**（Docker Engine 29.1.3 + docker-compose v1.29.2）。
   - 崩溃发生在 `merge_volume_bindings → get_container_data_volumes → container.image_config['ContainerConfig']`（Engine 29.x 不再返回该键）。
   - 遗留孤儿容器 `a69e022a2f3f_eestock-app`（旧容器被 recreate 改名，现 Exited (137)）。
3. 清理孤儿：`docker rm -f a69e022a2f3f_eestock-app` → 退出码 0。
4. 重试 `docker-compose up -d app` → 退出码 0，`Creating eestock-app ... done`。
5. 等健康：容器新 ID `2360f767339e`，`Up (healthy)`。

## 部署后状态（after）
| 项 | before | after |
|---|---|---|
| 镜像 ID | sha256:5bc71314fd83... | sha256:9d39b951b98fd16c3e528eb1cf3ea8b54ef53bdfacb623051fe336696a1d0897 |
| 容器 ID | a69e022a2f3f | 2360f767339e |
| 前端 bundle | index-B8z_Abxt.js | index-DLbas1AF.js |
| assets | [css/index-B10HbC_2.css, js/index-B8z_Abxt.js] | [css/index-CwueOuTM.css, js/index-DLbas1AF.js] |
| 旧 bundle 残留（B8z_Abxt） | 存在 | 0（已清除） |
| 类名（680px 上下文） | `max-h-[680px]` | `h-[680px]` |

## 冒烟结果
- `GET /healthz` → `{"status":"ok"}`（HTTP 200）
- `GET /api/kline?code=518880&period=1m&limit=3` → HTTP 200，合法 JSON（`code`/`period`/`bars[]` 含 ts/open/high/low/close/volume/amount/source，`next_before`）
- SPA bundle 哈希变化：`curl -s http://127.0.0.1:8081/ | grep -oE 'index-[A-Za-z0-9_]+\.js'` → `index-DLbas1AF.js`
- `docker exec eestock-app ls /app/dist/assets` → 仅 `[index-CwueOuTM.css, index-DLbas1AF.js]`，无旧 `index-B8z_Abxt.js` / `index-B10HbC_2.css`。

## 已知 compose 坑是否触发及规避
- ✅ 触发：首次 `up -d app` 即 `KeyError: 'ContainerConfig'`（Engine 29.1.3 不再返回 `container_config.ContainerConfig`）。
- ✅ 规避：删除 recreate 遗留孤儿容器 `a69e022a2f3f_eestock-app` 后重试 `up -d app` 成功。重试后 `docker ps -a | grep _eestock-app` → NONE，无孤儿残留。

## 对源码/DB/SQL/Rust 的影响
- **零**。未改动任何源码、测试、DB、SQL、Rust crate（cargo 层命中缓存，未重编）。
- `git diff --cached --name-only` 为空 → 无 staged 文件；`git status --short` 仅原有无跟踪文件（reports/logs/.claude 等，均为既有）。
- 未 commit。

## 残留风险
1. 本批 `h-[680px]` 的**前端视觉/行为**（容器恒 680px + 内部滚动）以 tester/visual 基线复跑为准；本报告仅确认镜像/容器/bundle/API 冒烟层面已上线。
2. `docker-compose v1` + Engine 29.x 存在结构性不兼容，任何未来 `up -d` 重建仍可能触发同一 `KeyError`，需按本流程清理孤儿后重试（或升级 compose v2）。
3. 镜像构建依赖 `npm ci` 按 `web/package-lock.json` 安装；若锁文件与源码不匹配，前端构建会失败（本次未发生）。
