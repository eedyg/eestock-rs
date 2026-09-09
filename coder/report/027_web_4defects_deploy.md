# 027 — 前端 4 缺陷修复部署上线（D1/D2/D9/N2）

> 本报告文件位置：`coder/report/027_web_4defects_deploy.md`
> 部署时间：2026-09-05 08:32–08:33（宿主机 UTC）

## 目标（铁律：仅部署，不改源码/DB/SQL/Rust，不 commit）

将已提交的 3 个前端修复提交部署到运行容器 `eestock-app`（宿主机 8081/8082）：
- `b2e011a` K线循环
- `7fab9f1` D1 详情面板降级 / D2 停用显示已停用 / D9 e2e 断言 / N2 告警定高
- `fc813de` QualityPage 日期测试

## 部署前状态（before）
- 运行容器：`d1dbde795f2a`（名 `eestock-app`，Up healthy），镜像 `eestock-rs_app:latest`
- 镜像 ID：`sha256:d9ddb9441c07...`
- 前端 bundle：`index-_GWBq5Ak.js`；assets：`[index-DXeTIV4V.css, index-_GWBq5Ak.js]`
- 镜像 ID / bundle 与任务描述一致（d9ddb9441c07，index-_GWBq5Ak.js）→ 确认尚未包含 D1/D2/D9/N2

## 实施（按序）
1. `docker-compose build app` → 退出码 0，成功产出新镜像 `sha256:5bc71314fd83...`
   - cargo 依赖层命中缓存（Step 27 `COPY --from=builder .../eestock-app` 标 `Using cache`），说明 Rust 源码未动、二进制复用缓存。
   - 前端阶段 `COPY --from=frontend /web/dist`（Step 28）**未**命中缓存 → `VITE_API_MOCK=0 npm run build` 重新产出 dist。变更仅限前端 vite build + 镜像 ID。
2. `docker-compose up -d app` → **触发已知坑 `KeyError: 'ContainerConfig'`**（Docker Engine 29.1.3 + docker-compose v1.29.2）。
   - 崩溃发生在 create_container → 读 `container.image_config['ContainerConfig']`。
   - 遗留孤儿容器 `d1dbde795f2a_eestock-app`（旧容器被 recreate 改名，现 Exited (137)）。
3. 清理孤儿：`docker rm -f d1dbde795f2a_eestock-app` → 退出码 0。
4. 重试 `docker-compose up -d app` → 退出码 0，`Creating eestock-app ... done`。
5. 等健康：容器新 ID `a69e022a2f3f`，`Up (healthy)`。

## 部署后状态（after）
| 项 | before | after |
|---|---|---|
| 镜像 ID | sha256:d9ddb9441c07... | sha256:5bc71314fd83... |
| 容器 ID | d1dbde795f2a | a69e022a2f3f |
| 前端 bundle | index-_GWBq5Ak.js | index-B8z_Abxt.js |
| assets | [css/index-DXeTIV4V.css, js/index-_GWBq5Ak.js] | [css/index-B10HbC_2.css, js/index-B8z_Abxt.js] |
| 旧 bundle 残留（_GWBq5Ak） | 存在 | 0（已清除） |

## 冒烟结果
- `GET /api/kline?code=518880&period=1m&limit=3` → 200 合法 JSON（bars 数组含 ts/open/high/low/close/volume/source）
- `GET /healthz` → `{"status":"ok"}`
- `GET /api/symbols` → 200 合法 JSON（数组含 code/name/enabled/latest 字段）
- 端口 8082（MCP）：GET `/` 无响应体（符合预期，MCP 非普通 GET 端；不影响本批上线验证）

## 已知 compose 坑是否触发及规避
- ✅ 触发：`up -d app` 首次运行即 `KeyError: 'ContainerConfig'`（Engine 29.1.3 不再返回 `container_config.ContainerConfig`）。
- ✅ 规避：删除 recreate 遗留孤儿容器 `d1dbde795f2a_eestock-app` 后重试 `up -d app` 成功。重试后无孤儿残留（`docker ps -a | grep _eestock-app` → NONE）。

## 残留风险
1. 本批修复的**前端渲染行为**（D2 停用不显示 0.000、D1 详情面板降级、D9 断言、N2 告警定高）以 tester 复跑验收为准；本报告仅确认镜像/容器/bundle/API 冒烟层面已上线。
2. `docker-compose v1` + Engine 29.x 存在结构性不兼容，任何未来 `up -d` 重建仍可能触发同一 `KeyError`，需按本流程清理孤儿后重试（或升级 compose v2）。
3. 镜像构建依赖 `npm ci` 按 `web/package-lock.json` 安装；若锁文件与源码不匹配，前端构建会失败（本次未发生）。

## Git 状态
- 未 commit、未 stage（`git diff --cached --name-only` 为空，`git status --short` 仅原有无跟踪文件）。
- 未改任何源码/测试/DB/SQL/Rust。
