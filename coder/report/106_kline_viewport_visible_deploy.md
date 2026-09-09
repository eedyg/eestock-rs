# 106 — 部署「看板初始K线数随配置变化」修复 (commit 4c2de4e)

> 本文件位置：`eestock-rs/coder/report/106_kline_viewport_visible_deploy.md`
> 部署目标：commit `4c2de4e`（fix(web): 看板初始K线数不随 viewportDays 变化(fitBarSpace 用默认2视口)）。
> 前置：`105_kline_fitbars_space_viewport.md`（修复实现）、`104_kline_viewport_deploy.md`(4431113 部署)、
> `102_kline_viewport_config_deploy.md`(06711eb 配置化)。

## 任务范围
仅部署前端唯一改动（4c2de4e），**不改源码 / 不改 DB / 不改 SQL / 不改 Rust / 不 commit**。
只重建 **app** 镜像/容器（`eestock-rs_app` + `eestock-app`）；`data`/`timescaledb` 容器不动。

## What changed（部署产物）

| 项 | 部署前 | 部署后 |
|---|---|---|
| app 镜像 | `05b408393846` (created 2026-09-08T16:52) | `638837267c1a` (created 2026-09-09T00:37) |
| app 容器 | `6c9839b577b7` (Up healthy) | `ac3f0bdc68cb` Up (healthy) |
| SPA bundle | `index-D1ge0WGJ.js` (608717 B) | `index-DZS0mEDZ.js` (608821 B，新哈希) |
| SPA css | `index-BLtE7SRY.css` | `index-BLtE7SRY.css`（未变，仅 JS 逻辑改动） |
| timescaledb 容器 | Up (created 2026-09-05) | **未动** |
| data 容器 | Up (created 2026-09-05) | **未动** |
| DB `app_config.kline` | `{"viewport_days":7}` | `{"viewport_days":7}`（复验后还原） |

前端阶段确实重编（`RUN VITE_API_MOCK=0 npm run build`：`tsc -b` 通过、`vite build` 128 modules、新
`index-DZS0mEDZ.js`，仅既有 >500kB chunk 告警）；Rust 阶段（Step 24-30）全部 **Using cache**——吻合「前端变→Rust 缓存」。

## 部署步骤与实际行为

1. `docker-compose build app` → **exit 0**，`Successfully built 638837267c1a`（前端重编 ~1.17s，Rust 层全命中缓存）。
2. `docker-compose up -d app`（首次）→ **崩溃** `KeyError: 'ContainerConfig'`，旧容器被改名孤儿 `6c9839b577b7_eestock-app`。
3. `docker rm -f 6c9839b577b7_eestock-app` → removed（清孤儿）。
4. `docker-compose up -d app`（二次）→ **exit 0**，`Creating eestock-app ... done`（全新创建路径，绕过卷合并 inspect）。

### Compose 坑（复现+处置）
- 触发：compose **v1.29.2**（Python 旧二进制）+ Docker **29.1.3**（无 `docker compose` v2 plugin）
  + 存在需 recreate 的旧 app 容器。
- 根因栈（traceback）：`up → execute_convergence_plan → recreate_container → _get_container_create_options
  → _build_container_volume_options → merge_volume_bindings → get_container_data_volumes
  → container.image_config['ContainerConfig']`。Docker 29 的 image inspect 移除顶层 `ContainerConfig`，
  compose v1 读不到即 `KeyError`。
- 处置：`docker rm -f` 旧 app 容器（删孤儿）→ 再 `up`，走 **Creating（全新）** 分支即绕过。本次成功。
- 残留：未根治；下次对运行中 app 容器做「配置/挂载变更而需 recreate」仍可能触发（见残留风险）。

## 验证结果

### 后端 / 静态确认
| 检查项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| `docker ps` | eestock-app healthy + 新镜像 | `ac3f0bdc68cb` Up(healthy) img=`eestock-rs_app`(638837267c1a) | ✅ |
| data/timescaledb | 不重建 | still Up(healthy), created 2026-09-05 | ✅ |
| `/healthz` | ok | `{"status":"ok"}` | ✅ |
| `GET /api/config/kline` | 当前值 | `{"viewport_days":7}`（**注意：任务假设 4，实为 7**，详见下） | ⚠️记录 |
| SPA index | 新 bundle | `/` → `index-DZS0mEDZ.js`；容器内 `/app/dist/assets` 仅此一档 | ✅ |
| bundle 内容 | 含 viewportDays 感知的 fitBarSpace | grep 命中：`Fu(n.period,n.feed.viewportDays??Ea)`（fitBarSpace）；`get viewportDays(){return this.deps.viewportDays??Ea}`（KlineDataFeed getter）；`pageSize=t.pageSize??Fu(t.period,t.viewportDays)`；ScopedKlineFeed `viewportDays=Ea`；`viewportDays`×6 | ✅ |

> `Ea` = minify 后 `DEFAULT_KLINE_VIEWPORT_DAYS`(2)；`Fu` = `defaultPageSizeForPeriod`，`??` 为 nullish 兜底。

### 初始可见K线数随配置变化（关键复验）
真实浏览器（Playwright headless chromium，viewport 1360×900，访问真实 app :8081，主图默认 15m，
code=518880）。配置经 **真实 `PUT /api/config/kline` round-trip** 变更（非 route 拦截）。可见数 =
klinecharts `getVisibleRange().to - getVisibleRange().from`（主图可见 bar 数）；`BARS_PER_TRADING_DAY['15m']=17`。

| viewport_days | 加载 limit（实况请求） | 期望可见数 =17×days | 实测可见数 | barSpace | 结论 |
|---|---|---|---|---|---|
| 4 | **68** | 68 | **67** | 16 | ✅ ≈68，**非 34** |
| 6 | **102** | 102 | **97** | 11 | ✅ ≈102 |
| 2 | **34** | 34 | **33** | 33 | ✅ ≈34 |
| 7（还原） | 119 | 119 | **118** | 9 | ✅ ≈119 |

> 判据：初始可见数从「恒 34」（修复前，fitBarSpace 恒用默认 2 视口）变为「随 viewport_days 变」
> （4→~68 / 6→~102 / 2→~34）。加载 limit 与可见数同源（`defaultPageSizeForPeriod(period, viewportDays)`），
> 后端精确返回 68/102/34/119，前端显示层同步铺满该目标，证明修复生效。

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
- 行为复验用临时 Playwright 脚本（`web/_probe_kline.mjs`、`web/_verify_kline_visible.mjs`），运行后已删除，不落源码/不入 git。
- 访问 klinecharts 实例：因生产 bundle 函数名被 minify（`t.name==='KlineChart'` 失效），改为沿 React fiber
  `memoizedState` hook 链查找「含 `getVisibleRange`/`getBarSpace` 的 chartRef.current」间接定位实例——与源码名无关，稳健。
- 可见数度量：klinecharts `getVisibleRange()`（`to-from`），真实显示层、非加载 limit。

## Test coverage
本次为**部署冒烟**，未新增/修改任何源码测试（源码测试由 105 已加：`KlineChart.test.tsx`、`store.test.ts`、
`ScopedKlineFeed.test.ts`；`git diff` tracked 为空）。验证：构建产物（无 type error）+ 后端精确 limit +
浏览器 4 档配置真实可见数 round-trip。

## Verification（命令 + 输出摘要）
- `docker-compose build app` → `Successfully built 638837267c1a`（exit 0）。
- `docker-compose up -d app`(1) → `KeyError: 'ContainerConfig'`（exit 1，孤儿 `6c9839b577b7_eestock-app`）。
- `docker rm -f 6c9839b577b7_eestock-app` → removed。
- `docker-compose up -d app`(2) → `Creating eestock-app ... done`（exit 0）。
- `docker ps` → eestock-app Up(healthy)；timescaledb/data Up(healthy，created 2026-09-05 未动)。
- `curl /healthz` → `{"status":"ok"}` (200)。
- `/` → `index-DZS0mEDZ.js`；容器 `/app/dist/assets/` 仅 `index-DZS0mEDZ.js`/`index-BLtE7SRY.css`。
- Playwright（真实 `PUT /api/config/kline` round-trip）：初始可见数 4→67(≈68)/6→97(≈102)/2→33(≈34)/还原7→118(≈119)，4 档全过；加载 limit 精确 =68/102/34/119。
- 回归：8 端点全 HTTP 200。
- `git diff --stat`（tracked unstaged）= 空；`git diff --cached --stat`（staged）= 空（无 stage、无 commit）；
  `git status --short -- web/` 无我新增文件（临时脚本已删，仅既有 `web/tester/`）。

## 耗时
- 镜像构建：前端重编 ~1.17s + 打包；Rust 层全缓存 → 总构建秒级。
- up（首次崩溃 + 删孤儿 + 二次 up）：~30s 以内。
- 浏览器复验（4 档配置 round-trip + 回归）：~2-3 分钟。
- 部署 + 复验总耗时（会话增量）：约数分钟。

## 残留风险 / 与任务假设的偏差
1. **任务假设偏差（须知）**：任务注明 `GET /api/config/kline` 应为 `{"viewport_days":4}`；实测当前值为 **7**
   （可能由先前某次测试/user 修改）。此次严格按任务要求验证 4/6/2 三档，另补 7（还原原值）确认，最终还原为 7。
   DB `app_config.kline` 复验后回到原值 **7**（未留下 4/6/2 残留），未造成持久化变更。
2. **compose v1 + Docker 29 不兼容未根治**：仅靠「rm 孤儿→全新创建」规避本次 `KeyError: 'ContainerConfig'`。
   未来对运行中 app 容器做触发 recreate 的变更仍可能崩。长期建议迁 `docker compose`(v2)。
3. **可见数略小于目标**：barSpace = `round(width/target)`，可见数 = `floor(width/barSpace)`，故略小于 target
   （如 67 vs 68、97 vs 102），属显示层舍入，符合「≈」验收语义。
4. **浏览器度量的环境依赖**：可见数需 headless chromium + React fiber 反查 chart 实例；本机 Playwright
   chromium 已装。若换成更小视口，可见数仍约等于 target（barSpace 按宽度归一），比值稳健。
5. **首屏瞬态**：本次用「页面重载后稳定采样」（连续 3 次同 ±2 才算稳定）读取，避开加载中瞬态未收敛态；
   未观察到「永停 34」现象（修复目标）。
6. 未运行 GitNexus `gitnexus_impact`/`gitnexus_detect_changes`：本任务为**纯部署**（零源码改动），
   无符号编辑/无 commit，blast-radius 不适用。

## 更改文件清单
- **源码/迁移/配置**：无（`git diff` tracked 为空、`git diff --cached` 为空）。
- 仅部署产物：重建 `eestock-rs_app` 镜像 + 重启 `eestock-app` 容器；DB（`app_config.kline`）复验后还原原值 7。
- 临时验证脚本 `web/_probe_kline.mjs`、`web/_verify_kline_visible.mjs`：运行后已删除（未入 git）。
- 本报告：`eestock-rs/coder/report/106_kline_viewport_visible_deploy.md`（新增，未 commit/未 stage）。
