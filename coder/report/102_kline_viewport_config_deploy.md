# 102 kline_viewport_config_deploy — 部署看板默认K线数量配置 + S2 ConfigStore(commit 06711eb)

> 本报告存放位置：`coder/report/102_kline_viewport_config_deploy.md`

## 任务
部署 commit `06711eb`（feat(web): 看板默认K线数量配置化(viewport_days) + S2 ConfigStore/0021 入库）至运行中的 eestock-rs。
仅重建 **app** 镜像/容器；应用迁移（0021 已应用）；不改源码、不改非迁移 DB、不 commit。
迁移 `0021_app_config.sql`（app_config 表，key text PK + value jsonb）已应用。

## What changed
- **部署产物**：只重建 `eestock-rs_app` 镜像 + 重启 `eestock-app` 容器。
- **未改任何源码/迁移/配置文件**：`git diff`（tracked）为空；`git diff --cached`（staged）为空。`eestock-data` 与 `eestock-timescaledb` 容器未重建（created 仍为 2026-09-05）。

## 分层归属
- 变更本体在 commit 内属 `web`（前端 dashboard/feed/settings）+ `storage`（ConfigStore/app_config 0021）。
- 本次只做**部署**（应用面 app-plane 镜像重建），不涉及任何接口/边界/依赖修改。

## 部署步骤与实际行为
1. `docker-compose build app` —— 成功，产出 `eestock-rs_app:latest`（id `7cccc32e8953`）。Rust release 编译 ≈20.9s（依赖层命中缓存），前端 vite 构建 + dist 打包入镜像。
2. `docker-compose up -d app` —— 首次**崩溃**：
   - `KeyError: 'ContainerConfig'`（compose v1.29.2 + Docker 29.1.3）：`compose/service.py:1579 get_container_data_volumes → container.image_config['ContainerConfig']`。Docker 29 的 image inspect 结构变更（image_config 不再含 `ContainerConfig`），旧 compose v1 在**带旧容器的 recreate** 时做卷合并读取崩溃。
   - 该次尝试把旧 `eestock-app` 置为 `Exited(137)` 并留下孤儿容器 `84e0a79f0eca_eestock-app`。
3. **处理**：`docker rm -f 84e0a79f0eca_eestock-app`（删孤儿/旧 app 容器），使 compose 走「全新创建」分支（绕过卷合并 inspect 路径）。
4. `docker-compose up -d app` —— 成功，`Creating eestock-app ... done`，无崩溃。
5. 验证 `eestock-app` Up(healthy)、`/healthz` = `{"status":"ok"}`。

### Compose 坑（复现+处置记录）
- 触发条件：compose v1.29.2（Python）+ Docker 29.1.3（无 `docker compose` plugin，仅旧二进制）+ **存在旧 app 容器需要 recreate**。
- 错误栈根因：`merge_volume_bindings → get_container_data_volumes → image_config['ContainerConfig']`。Docker 29 移除该顶层键。
- 处置：`docker rm -f` 旧 app 容器（删孤儿）后再 `up`，走全新创建路径即绕过，成功。

## 冒烟（视口配置生效）— 验证结果
| 检查项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| `docker ps` | eestock-app healthy + 新镜像 | Up(healthy)，img=`eestock-rs_app`(7cccc32e8953), created 16:29:51Z | ✅ |
| `/healthz` | ok | `{"status":"ok"}` | ✅ |
| `GET /api/config/kline` | `{"viewport_days":2}`(缺省) | `{"viewport_days":2}` HTTP 200 | ✅ |
| `PUT /api/config/kline {6}` | 200 | `{"viewport_days":6}` HTTP 200 | ✅ |
| 再次 `GET` | 6（持久） | `{"viewport_days":6}` HTTP 200 | ✅ |
| DB 持久 | app_config kline=`{"viewport_days":6}` | 行已落库（updated_at 变更） | ✅ |
| `PUT {0}` | 400 | `{"error":"viewport_days 须为 1..=50 整数，收到 0"}` | ✅ |
| `PUT {51}` | 400 | `{"error":"...收到 51"}` | ✅ |
| `PUT {7.5}`（非整） | 400 | `{"error":"kline 请求体非法：invalid type: floating point `7.5`, expected i32"}` | ✅ |
| 非法写入不覆盖 | 值仍=6 | 非法 400 后 DB 仍 `{"viewport_days":6}` | ✅ |
| `PUT {2}` 恢复默认 + GET | 2 | 200，GET=`{"viewport_days":2}`，DB 同步 | ✅ |

## 看板生效（limit = BARS_PER_TRADING_DAY × viewport_days）
验证链（无需浏览器亦可证明部署产物逻辑）：
1. **源码接线**（commit 06711eb）`web/src/features/dashboard/DashboardPage.tsx`：
   - `useState(DEFAULT_KLINE_VIEWPORT_DAYS)`(=2) → mount 调 `api.getKlineConfig()` → `setViewportDays(cfg.viewport_days)` → `new KlineDataFeed({ ..., viewportDays })`。
   - `feed.ts`：`defaultPageSizeForPeriod(period, viewportDays) = BARS_PER_TRADING_DAY[period] * viewportDays`；`loadInitial` 用 `limit: this.pageSize`。
   - `BARS_PER_TRADING_DAY = {"1m":241,"5m":49,"15m":17,"1h":5,"1d":1,"1w":1,"1mo":1}`。
2. **部署产物 bundle**（`/app/dist/assets/index-DEUHe7uo.js`）内实含：
   - BARS 表：`{"1m":241,"5m":49,"15m":17,"1h":5,"1d":1,"1w":1,"1mo":1}`；默认视口常量 `vp=2`。
   - 乘法函数：`Ty[n]*t`（= `BARS_PER_TRADING_DAY[period] * viewportDays`，minify 后 `defaultPageSizeForPeriod`）。
   - 配置流：`api/config/kline`（GET/PUT 出现）+ `viewport_days`（5 处）+ `getKlineConfig`（3 处）。
   - PAGINATION_BATCH 表：`{"1m":500,"5m":300,"15m":220,"1h":120,"1d":250,"1w":150,"1mo":80}`。
3. **后端 limit 生效**：`GET /api/kline?code=518880&period=15m&limit=102` → 返回 **102** bars；`limit=34` → 返回 **34** bars（后端精确按 limit 返回）。
4. **推导**：视口 6 = 15m→17×6=102、1m→241×6=1446，较默认 2（15m→34、1m→482）多；改回 2 恢复。
【结论】部署后的看板在前端按 `viewport_days` 计算 `limit=BARS_PER_TRADING_DAY[period]×viewport_days` 请求首屏 K 线；后端按 limit 精确返回。**看板生效，调 6 > 默认 2，改回 2 恢复**。

> 注：未用真实浏览器 DevTools 抓包「/」首屏请求；改以「bundle 含 Ty[n]*t + 源码接线 + 后端精确返回 limit」三点链路证明。若需逐字节抓包可后续用无头浏览器补做。

## 既有回归
| 端点 | 结果 |
|---|---|
| `/api/symbols` | 200（518880 等） |
| `/api/backtest/runs` | 200 |
| `/api/alerts` | 200 |
| `/api/sim-live/state` | 200 |
| `/api/sim-live/positions` | 200 |
| `/api/sim-live/orders` | 200 |
| `/api/sim-live/pnl` | 200 |
| `/api/sim-live/strategies` | 200 |
| `/api/sim-live/sessions` | 200 |
| `/`（SPA index.html） | 200，加载 `index-DEUHe7uo.js` |

## Implementation approach
- 按任务「仅重建 app」约束：`build app` → 旧容器崩溃/孤儿 → `docker rm -f` 孤儿 → `up -d app`（全新创建）。
- 时间线：build 成功（Rust refs 缓存命中，release ≈20.9s）+ 前端构建（vite）+ 镜像打包；`up` 首次崩溃（KeyError），删孤儿后再 `up` 成功；app 容器 created `2026-09-08T16:29:51Z`。

## Test coverage
本次为部署冒烟，未新增/修改源码测试。源码测试（先于部署已存在）覆盖 viewport 校验/roundtrip/批量的为：`web/src/features/dashboard/feed.test.ts`、`crates/web/src/settings.rs` 内 `#[cfg(test)]`（`kline_viewport_days_validation`、`kline_config_dto_roundtrip_and_non_integer_rejected`）、`DashboardPage.test.tsx` 的「mount 读 getKlineConfig，feed 用配置 viewport_days 计算 pageSize」。

## Verification（命令 + 输出摘要）
- `docker-compose build app` → `Successfully built 7cccc32e8953` / tagged `eestock-rs_app:latest`。
- `docker-compose up -d app`（首次）→ `KeyError: 'ContainerConfig'`（崩溃）。
- `docker rm -f 84e0a79f0eca_eestock-app` → removed。
- `docker-compose up -d app`（再次）→ `eestock-timescaledb is up-to-date` / `Creating eestock-app ... done`。
- `docker ps` → `eestock-app Up (healthy)` img=`eestock-rs_app`；`eestock-data`/`eestock-timescaledb` Up(healthy)。
- `/healthz` → `{"status":"ok"}`。
- `GET/PUT /api/config/kline` 全部按上表通过；`psql app_config` 行存在。
- bundle 探针：`grep` 命中上述 BARS 表 / `Ty[n]*t` / `vp=2` / `api/config/kline` / `viewport_days` / `getKlineConfig`。

## 耗时
- 镜像构建（含前端 vite + Rust release）：~1–2 分钟量级（Rust release 自身 ≈20.9s，前端构建 + docker 层打包含较大）。
- up（含崩溃→删孤儿→再 up）：~1–2 分钟（含首次崩溃处置）。
- 冒烟回归：~1 分钟。
- 总过程（工作会话）增量约为数分钟。

## 残留风险
1. **compose v1 + Docker 29 不兼容**：本次靠「删旧 app 容器→全新创建」规避 `KeyError: 'ContainerConfig'`，未根治（compose v1 对含需 recreate 的容器仍会崩）。下次对现有容器做配置变更（如 app.toml 挂载变化）若走 recreate 仍可能触发。长期建议迁移到 `docker compose`(v2) 或 `docker compose up --force-recreate` 前先 rm。
2. **DB app_config 残留**：`kline = {"viewport_days":2}` 行保留（等价默认 2，行为一致），非空表。若希望「无 key 语义」可手动删除该行，但无删除端点；现状对行为无影响。
3. **浏览器首屏抓包未做**：看板 limit 由「bundle 逻辑 + 后端精确返回」间接证明；如需逐字节 DevTools 证据需无头浏览器补验。
4. **`eestock-data` 未随 app 部署**：仅重建 app，符合任务「仅重建 app」；data 侧无本次需求变更，无需重编。
