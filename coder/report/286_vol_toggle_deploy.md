# 286 · VOL 开关纯部署重新上线（前端重建 + 8081 重启）

- **本报告路径（自身位置）**：`coder/report/286_vol_toggle_deploy.md`
- **任务性质**：**纯部署**。未改任何源码/配置/生成物；未 `git add/commit/stash/checkout/restore`；未对任何 `/api/*` 发 PUT/POST；未触碰 `/tmp/app_dev_8081.toml`；未跑 `./scripts/deploy.sh`。
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`（所有命令 cwd 均在仓库根；后端亦在根目录启动，`static_dir=./web/dist`）
- **执行时间**：2026-09-15 22:27–22:28 +0800
- **结论**：部署**成功**（新 bundle 已上线并在 `/` 下发、单进程双端口、healthz 200、启动日志 0 error）。**唯一异常**：步骤 6 的 `multi_period` 一致性断言不成立 —— 详见 §7，**属部署前既有状态，与本次操作无关**。

---

## 1. 基线（步骤 1）

```
$ ss -lntp | grep -E ":8081|:8082"
LISTEN 0 128 0.0.0.0:8081 0.0.0.0:* users:(("eestock-app",pid=1080097,fd=11))
LISTEN 0 128 0.0.0.0:8082 0.0.0.0:* users:(("eestock-app",pid=1080097,fd=12))
```
- 旧 PID：**1080097**（单进程同时持有 8081/8082）
- `/proc/1080097/cmdline` = `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`

```
$ ls -la --time-style=full-iso web/dist/index.html web/dist/assets/
-rw-rw-r-- 1 eestock eestock      397 2026-09-15 21:28:05.068781866 +0800 web/dist/index.html
-rw-rw-r-- 1 eestock eestock    22931 2026-09-15 21:28:05.068781866 +0800 web/dist/assets/index-BpQVDpqf.css
-rw-rw-r-- 1 eestock eestock  1214769 2026-09-15 21:28:05.068781866 +0800 web/dist/assets/index-DVcJC1GO.js

$ sha256sum web/dist/assets/*.js
f30c9b00d08d29231c81b99200bbd0a04580079b94e15f01fbe3d4d10e3e38c3  web/dist/assets/index-DVcJC1GO.js
```
旧 `index.html` 引用：`/assets/index-DVcJC1GO.js` + `/assets/index-BpQVDpqf.css`。

**旧 bundle（部署前）**：`index-DVcJC1GO.js`，1214769 B，`f30c9b00d0…3e38c3`

## 2. 停机前会话检查（步骤 2，只读 GET）

```
$ curl -s http://127.0.0.1:8081/api/sim-live/sessions
```
返回 **12 条会话，`status` 全部为 `ended`**（含 `s_1789042836_0`、`s_1788880758_0`、`s_1788802857_0` …）。
⇒ **无 running/非 ended 会话**，满足停机条件，继续执行（未 kill 任何会话）。

## 3. 前端重建（步骤 3）

```
$ cd web && npm run build:prod          # VITE_API_MOCK=0 vite build
✓ 180 modules transformed.
dist/index.html                     0.40 kB │ gzip:   0.29 kB
dist/assets/index-BpQVDpqf.css     22.93 kB │ gzip:   5.76 kB
dist/assets/index-dH4SuwMy.js   1,214.79 kB │ gzip: 374.85 kB
✓ built in 1.92s
build:prod exit code = 0

$ npx tsc -b
tsc exit code = 0            # 无输出、无错误；未改任何代码去“修”它

$ sha256sum dist/assets/*.js
5bca03b6f6f80c695ebb679dddf99a8d278fca7643cdc8959ba28fa847e0c53e  dist/assets/index-dH4SuwMy.js
```
- **新 bundle**：`index-dH4SuwMy.js`，1214792 B，`5bca03b6f6…0c53e`（CSS 名 `index-BpQVDpqf.css` 未变）
- 新 `web/dist/index.html` 引用已切到 `/assets/index-dH4SuwMy.js`
- 新/旧 bundle 名**不同**（`index-DVcJC1GO.js` → `index-dH4SuwMy.js`）
- VOL 开关产物标记：`"VOL"` 出现 4 次、`"vol"` 2 次（`INDICATOR_DEFS` 的 VOL 项与 `vol: true` 默认值已进产物）

## 4. 后端构建（步骤 4）

```
$ cargo build -p app
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s
real 0m0.092s / user 0m0.064s / sys 0m0.023s
cargo exit code = 0
```
None-op：`target/debug/eestock-app`（mtime 2026-09-14 21:03:59，与旧进程 `/proc/1080097/exe` 同一路径）已是最新。**本轮为纯前端变更**（`static_dir=./web/dist` 运行时读盘），故后端无需重编。

## 5. 重启（步骤 5）

```
$ kill 1080097 && sleep 3 && nohup ./target/debug/eestock-app \
      --config /tmp/app_dev_8081.toml >> logs/app_dev_8081_redeploy_20260915_222740.log 2>&1 &
```
（在仓库根目录内启动；等待约 5 s）
- 旧 PID 1080097 已消失（`/proc/1080097` 不存在）
- **启动日志**：`logs/app_dev_8081_redeploy_20260915_222740.log`
- 日志 7 行，顺序：`eestock-app starting` → `schema self-check ok` → `strategy registry 启动播种完成 seeded=0 skipped=0` → `sim-live 启动恢复完成 recovered=0 degraded=0` → `eestock-app serving listen=0.0.0.0:8081 static_dir=./web/dist` → `mcp server (HTTP/SSE) serving listen=0.0.0.0:8082` → `mcp sse session opened`

## 6. 自查（步骤 6，全部只读）

| 检查 | 结果 |
|---|---|
| `ss -lntp \| grep -E ":8081\|:8082"` | **新 PID 1247798** 同时持有 `:8081`(fd=11) 与 `:8082`(fd=12)，单进程双端口 |
| `GET /healthz` | **200** |
| `grep -ci error <启动日志>` | **0** |
| `GET /` 下发脚本名 | `index-dH4SuwMy.js`（= `web/dist/index.html` 引用，一致） |
| 新 bundle ≠ 旧 bundle | **是**（`index-dH4SuwMy.js` ≠ `index-DVcJC1GO.js`） |
| `GET /api/config/multi_period` | **与任务给定期望值不一致** → 见 §7 |

## 7. ⚠️ `multi_period` 一致性断言不成立（非本次操作所致）

**任务期望**：`{"enabled":true,"periods":["1m","5m","15m"],"heights":{"1m":630,"5m":231,"15m":292},"indicators":["dcap"]}`
**实际实测**：`{"enabled":true,"periods":["5m","15m","1h"],"heights":{"15m":180,"1h":180,"5m":231},"indicators":["dcap"]}`

**定位（只读取证，未做任何写操作）**：
1. 该值持久化在 Postgres `app_config`，key=`multi_period`（`/tmp/app_dev_8081.toml` 内 **无** multi_period 项，其内容仅 `database_url/listen/mcp_listen/static_dir/health_window_secs/ws_poll_ms/alert_eval_ms`）。
2. `psql` 只读查询：`multi_period` 行 **`updated_at = 2026-09-15 13:37:28.593748+00`（= 21:37:28 +0800）**；`dcap` 行 updated_at 为 2026-09-13。
3. 本次 `kill` + 重启发生于 **22:27:40 +0800**，比该行写入时间**晚约 50 分钟**（本报告时为 22:28）。
4. `ConfigStore::get` 为**逐请求直读 SQL**（`crates/storage/src/config_store.rs`: `SELECT value FROM app_config WHERE key = $1`，**无内存缓存**），⇒ 旧进程在被 kill 前读同一行，**重启前 GET 必为同值**；GET 亦不写库（写仅发生于 `PUT`）。启动日志无任何配置播种/回写 multi_period 的行。
5. 报告 `coder/report/285_p5.5_redeploy_ops.md`（21:28 那次部署）记录的仍是 `1m/5m/15m`，故该值是 **21:37:28 被外部（用户 UI 或其它会话）改写**，早于本次部署。

**结论**：`multi_period` 差异是**部署前既有状态**（21:37:28 落库），**不由本次部署产生**；按禁令**未做任何纠正性写入**（未 PUT），保持用户当前实际配置不动。任务步骤 6 的“必须仍是 1m/5m/15m”前提已过时。

## 8. 变更与暂存状态

- **未修改任何源码/配置/生成物**：无 `.ts/.tsx/.rs/.toml/.json` 编辑；`/tmp/app_dev_8081.toml` 未被触碰；`git status --porcelain` 无任何未暂存修改（仅 `M `/`A `/`??` 行）。
- **暂存状态原封不动**：`git diff --cached --name-only | wc -l` = **14**（与基线一致：`design/06-web/01-dashboard.md`、`web/src/layouts/DashboardGrid.tsx`、`Toolbar.tsx`+`.test.tsx`、`KlineChart.tsx`+3 测试、`MultiPeriodChartStack.tsx`、`multiPeriodLayoutAuthority/Dom/Handshake.test.tsx`、`web/src/features/dashboard/volToggle.test.tsx`(A)）；`git diff --cached --stat` = `14 files changed, 838 insertions(+), 17 deletions(-)`。**未执行 add/commit/stash/checkout/restore。**
- 前端产物 `web/dist/` 受 `web/.gitignore`（`dist/`）忽略，重建未污染工作区。
- **未发任何写请求**：全程仅 `GET`（`/healthz`、`/api/sim-live/sessions`、`/api/config/multi_period`、`/`）与 `psql` 只读 `\d`/`SELECT`；**未对任何 `/api/*` 发 PUT/POST**（multi_period/kline/ma/dcap 均未写）。

## 9. 汇总

| 项 | 旧 | 新 |
|---|---|---|
| PID | 1080097 | **1247798** |
| JS bundle | `index-DVcJC1GO.js` | **`index-dH4SuwMy.js`** |
| JS sha256 | `f30c9b00d0…3e38c3` | **`5bca03b6f6…0c53e`** |
| CSS | `index-BpQVDpqf.css` | 同（未变） |
| tsc `-b` exit | — | **0** |
| cargo `build -p app` exit | — | **0**（耗时 0.092s，no-op） |
| 启动日志 | — | `logs/app_dev_8081_redeploy_20260915_222740.log`，**ERROR 计数 0** |
| healthz | — | **200** |
| multi_period | （285 记录）1m/5m/15m | **5m/15m/1h（21:37:28 既有，非本次所致）** |

## 10. 遗留风险

1. `multi_period` 现值与任务期望不符（用户侧或其它会话于 21:37:28 改写；本次未纠正，遵禁令不写）。
2. `sim-live 启动恢复完成 recovered=0` —— 与 285 一致（历史会话均 ended），非本轮新增风险。
3. 前端 bundle 1.21 MB 超过 500 kB 提示阈值（Vite 警告，历史既有）。
