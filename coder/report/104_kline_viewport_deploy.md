# 104 kline_viewport_deploy — 部署看板K线视口配置容错 (commit 4431113)

> 本报告文件位置：`eestock-rs/coder/report/104_kline_viewport_deploy.md`
> 部署目标：commit `4431113`（fix(web): 看板K线视口配置偶发失败不生效：重试+focus重读）
> 前置：`102_kline_viewport_config_deploy.md`（06711eb 配置化）、`103_kline_viewport_retry_focus.md`（修复实现）

## 任务范围

仅部署前端唯一改动（4431113），**不改源码 / 不改 DB / 不改 SQL / 不改 Rust / 不 commit**。
只重建 **app** 镜像/容器（`eestock-rs_app` + `eestock-app`）；`data`/`timescaledb` 容器不动。

## What changed（部署产物）

| 项 | 部署前 | 部署后 |
|---|---|---|
| app 镜像 | `7cccc32e8953` (created 2026-09-08T16:29) | `05b408393846` (created 2026-09-08T16:52) |
| app 容器 | `ebade05a0eb3` (exited) | `6c9839b577b7` Up(healthy) |
| SPA bundle | `index-DEUHe7uo.js` | `index-D1ge0WGJ.js`（新哈希，证明前端重编） |
| timescaledb 容器 | Up 3d (healthy) | **未动**（created 2026-09-05） |
| data 容器 | Up 3d (healthy) | **未动**（created 2026-09-05） |

前端阶段确实重编（`RUN VITE_API_MOCK=0 npm run build` 产出新 bundle，`tsc -b` 通过，
仅既有 chunk>500kB 警告）；Rust 阶段（Step 8-30）全部 **Using cache**——吻合「前端变→Rust 缓存」。

## 部署步骤与实际行为

1. `docker-compose build app` → **exit 0**，`Successfully built 05b408393846`（build ≈4.6s，绝大部分层命中缓存）。
2. `docker-compose up -d app`（首次）→ **崩溃** `KeyError: 'ContainerConfig'`，
   旧容器被改名孤儿 `ebade05a0eb3_eestock-app`，原 `eestock-app` 消失。
3. `docker rm -f ebade05a0eb3_eestock-app` → removed（清孤儿）。
4. `docker-compose up -d app`（二次）→ **exit 0**，`Creating eestock-app ... done`（全新创建路径，绕过卷合并 inspect）。

### Compose 坑（复现+处置）
- 触发：compose **v1.29.2**（Python 旧二进制）+ Docker **29.1.3**（无 `docker compose` v2 plugin）
  + **存在需 recreate 的旧 app 容器**。
- 根因栈：`up → execute_convergence_plan → recreate_container → _get_container_create_options
  → _build_container_volume_options → merge_volume_bindings → get_container_data_volumes
  → container.image_config['ContainerConfig']`。Docker 29 的 image inspect 移除顶层 `ContainerConfig`，
  compose v1 读不到即 `KeyError`。
- 处置：`docker rm -f` 旧 app 容器（删孤儿）→ 再 `up`，走 **Creating（全新）** 分支即绕过。本次成功。
- 残留：未根治；下次对运行中的 app 容器做「配置/挂载变更而需 recreate」仍可能触发（见残留风险 1）。

## 验证结果

### 后端 / 静态确认
| 检查项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| `docker ps` | eestock-app healthy + 新镜像 | `6c9839b577b7` Up(healthy) img=`eestock-rs_app`(05b408393846) | ✅ |
| data/timescaledb | 不重建 | still Up(healthy), created 2026-09-05 | ✅ |
| `/healthz` | ok | `{"status":"ok"}` | ✅ |
| `GET /api/config/kline` | `{viewport_days:4}` | `{"viewport_days":4}` HTTP 200 | ✅ |
| SPA index | 新 bundle | `/` → `index-D1ge0WGJ.js` + `index-BLtE7SRY.css`；容器内 `/app/dist/assets` 仅此一档 | ✅ |
| bundle 内容 | 含重试+focus 逻辑 | grep：`visibilitychange`×2、`"focus"`×4、`api/config/kline`×2、`getKlineConfig`×3、`viewport_days`×5 | ✅ |

### 看板生效（limit = BARS_PER_TRADING_DAY × viewport_days，15m=17×4=68）
真实 backend 精确返回（非 mock）：
- `GET /api/kline?code=518880&period=15m&limit=68` → **bars=68**
- `?limit=34` → **bars=34**；`?limit=200` → **bars=200**；默认(无 limit) → **bars=240**

### 浏览器行为（Playwright headless chromium 访问真实 app 容器 :8081，route 拦截 /api/config/kline）
| 场景 | 配置手段 | 实测 | 结果 |
|---|---|---|---|
| 正常生效 | 放行真实后端(config=4)，观察 15m kline limit | limits=`["34","68"]` → 收敛 68（=17×4） | ✅ |
| 失败重试收敛 | config 失败 2 次后成功 | configCalls=3；limits=`["34","68"]` → 收敛 68，**不再永停 34** | ✅ |
| 多 fail→默认 2 | config 3 次全失败 | configCalls=3；limits=`["34"]`，无 68 → 兜底默认 2（=17×2） | ✅ |
| focus 重读 | viewport 4 → dispatch focus → config 变 6 | before68=true；focus 后 limits=`["68","102"]` → 更新 102（=17×6） | ✅ |
| visibilitychange 重读 | 同 focus，改 dispatch visibilitychange(visible) | before68=true；后 limits=`["68","102"]` → 更新 102 | ✅ |

> 说明：`["34","68"]` 中首个 34 是**默认渲染态**（`useState(DEFAULT_KLINE_VIEWPORT_DAYS)=2`）在异步配置解析前
> 发出的首屏请求，随后收敛到配置值 68；此为既有设计（不引入新缺陷），非故障。关键判据是「收敛到 68 而非永停 34」。

### 既有回归
| 端点 | 结果 |
|---|---|
| `/api/symbols` | 200 |
| `/api/backtest/runs` | 200 |
| `/api/alerts` | 200 |
| `/api/sim-live/state` | 200 |
| `/api/sim-live/positions` | 200 |
| `/api/sim-live/orders` | 200 |
| `/api/sim-live/pnl` | 200 |
| `/api/sim-live/strategies` | 200 |
| `/api/sim-live/sessions` | 200 |

## Implementation approach
- 严格按「仅重建 app」：`build app` → 预期 compose v1 崩溃/孤儿 → `rm -f` 孤儿 → 二次 `up -d app`（全新创建）。
- 前端行为用一个临时 Playwright 独立脚本（`web/_verify_kline_viewport.mjs`）验证，
  运行后立即删除，不落源码/不入 git。脚本覆盖正常、重试收敛、全失败兜底、focus/visibilitychange 重读 5 场景。

## Test coverage
本次为**部署冒烟**，未新增/修改任何源码测试（源码测试由 103 已加：dashboard 113/113、tsc、vite）。
验证通过：构建产物（无 type error）+ 后端精确 limit + 浏览器 5 场景真实执行。

## Verification（命令 + 输出摘要）
- `docker-compose build app` → `Successfully built 05b408393846`（exit 0）。
- `docker-compose up -d app`(1) → `KeyError: 'ContainerConfig'`（exit 1，孤儿 `..._eestock-app`）。
- `docker rm -f ebade05a0eb3_eestock-app` → removed。
- `docker-compose up -d app`(2) → `Creating eestock-app ... done`（exit 0）。
- `docker ps` → eestock-app Up(healthy)；timescaledb/data Up(healthy)。
- `curl /healthz` → `{"status":"ok"}`；`curl /api/config/kline` → `{"viewport_days":4}`。
- `/` → `index-D1ge0WGJ.js`；容器 `/app/dist/assets/` 仅 `index-D1ge0WGJ.js`/`index-BLtE7SRY.css`。
- Playwright：5/5 场景 PASS（见上文表）。
- `git diff --stat`（tracked unstaged）= 空；`git diff --cached --stat`（staged）= 空（无 stage、无 commit）。

## 耗时
- 镜像构建：~4.6s（绝大多数层命中缓存；前端重编 1.22s + 打包）。
- up（含首次崩溃 + 删孤儿 + 再次 up）：~1 分钟以内。
- 后端 + 浏览器验证：~2 分钟。
- 总部署 + 复验（会话增量）：约数分钟。

## 残留风险
1. **compose v1 + Docker 29 不兼容未根治**：仅靠「rm 孤儿→全新创建」规避本次 `KeyError: 'ContainerConfig'`。
   未来对运行中 app 容器做触发 recreate 的变更（如 app.toml 挂载/端口改动）仍可能崩。长期建议迁 `docker compose`(v2)。
2. **首屏瞬态 limit=34**：默认渲染态（viewport=2）先发一次 34，异步配置解析后收敛到 68。属既有设计，
   非本次引入；若追求「首屏即 68」需改动初始化策略（超出本次范围）。
3. **browser 验证用 route 注入 mock 配置**：正常场景放行真实后端；重试/重读场景用 route 注入
   `viewport_days`（4/6）以确定性触发。真实 `PUT /api/config/kline` round-trip 未复验（已在 102 覆盖；
   本次避免写库以遵守「不改 DB」）。DB config 现值仍为 `{viewport_days:4}`，未改动。
4. **同窗口配置变更**：focus/visibilitychange 仅覆盖「跨 tab 改配置 / 后台回来」场景；用户在当前焦点窗口内
   改配置后直接回看板不会触发 focus，需切焦点/刷新（需求边界，见 103 残留风险 2）。

## 更改文件清单
- **源码/迁移/配置**：无（`git diff` tracked 为空、`git diff --cached` 为空）。
- 仅部署产物：重建 `eestock-rs_app` 镜像 + 重启 `eestock-app` 容器。
- 临时验证脚本 `web/_verify_kline_viewport.mjs`：运行后已删除（未入 git）。
