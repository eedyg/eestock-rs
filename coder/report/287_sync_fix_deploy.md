# 287 跨图同步修复 + 286 VOL 开关 部署报告

- **报告自身路径**：`coder/report/287_sync_fix_deploy.md`（仓库 `/home/eestock/workspace/git/eestock/eestock-rs`，所有命令 cwd 均在此）
- **任务性质**：纯部署（构建 + 重启），**未改任何源码/配置/生成物**，**未对 /api/* 发任何 PUT/POST**，未执行 `git add/commit/stash/checkout/restore`，未跑 `./scripts/deploy.sh`，未碰 `/tmp/app_dev_8081.toml`。
- **结论**：成功。旧 PID 1247798 → 新 PID 1342449。

## 1. 基线

```
$ ss -lntp | grep -E ":8081|:8082"
LISTEN 0 128 0.0.0.0:8081 ... users:(("eestock-app",pid=1247798,fd=11))
LISTEN 0 128 0.0.0.0:8082 ... users:(("eestock-app",pid=1247798,fd=12))
```

- 旧 PID：**1247798**（8081+8082 同进程），进程启动时间 2026-09-15 22:27:43，cwd=`/home/eestock/workspace/git/eestock/eestock-rs`
- 旧 dist：`web/dist/index.html`（397 B，2026-09-15 22:27:23），`web/dist/assets/index-dH4SuwMy.js`（1214792 B）
  - `sha256(index-dH4SuwMy.js) = 5bca03b6f6f80c695ebb679dddf99a8d278fca7643cdc8959ba28fa847e0c53e`
  - `web/dist/assets/index-BpQVDpqf.css`（22931 B）
- 旧 index.html 引用 `<script type="module" crossorigin src="/assets/index-dH4SuwMy.js">`

## 2. 停机前检查（会话）

```
$ curl -s http://127.0.0.1:8081/api/sim-live/sessions
```
返回 12 个会话，**全部 status=ended**（含 3 个 "中断，部分数据" 的降级 ended），无 running / 非 ended 会话 → 允许继续，未 kill 任何会话。

## 3. 前端构建

```
$ cd web && npm run build:prod      # VITE_API_MOCK=0 vite build
✓ 180 modules transformed
dist/index.html                   0.40 kB
dist/assets/index-BpQVDpqf.css   22.93 kB
dist/assets/index-BGPCHS0j.js  1,217.68 kB │ gzip: 375.74 kB
✓ built in 1.88s                    # exit=0
```

- **新 bundle 名：`index-BGPCHS0j.js`**（旧 `index-dH4SuwMy.js` 已被 vite 清理，新旧名不同）
- 新 sha256：`b5ec462f1e789ce21f4631b655843444e7446aed3f4d4e2b3ee8884d72e0c3a2`（1217684 B）
- CSS 名未变 `index-BpQVDpqf.css`（22931 B，与旧一致）
- 新 index.html 引用 `/assets/index-BGPCHS0j.js`

```
$ npx tsc -b        # tsc_exit=0
```

## 4. 后端构建

```
$ cargo build -p app    # 仓库根目录
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s   # cargo_exit=0, real 0m0.093s
target/debug/eestock-app  207065864 B  2026-09-14 21:03:59
```

说明：cargo 无重编译（0.06s，二进制 mtime 仍为 09-14 21:03）——本次暂存改动 286/287 全部落在 `web/src/**` 与 `design/**`（前端/文档），Rust 源未变，故 `app` 二进制已是最新，符合预期。运行时静态目录来自配置 `static_dir = "./web/dist"`（运行时从磁盘读取）。

## 5. 重启

```
$ kill 1247798                       # rc=0（SIGTERM 优雅退出）
$ sleep 3
$ setsid nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml \
    >> logs/app_dev_8081_redeploy_20260915_230227.log 2>&1 &
```
- 启动 cwd = 仓库根目录（`/proc/1342449/cwd` 指向仓库根，静态目录 `./web/dist` 可正确解析）
- **日志路径：`logs/app_dev_8081_redeploy_20260915_230227.log`**

## 6. 自查结果

```
$ ss -lntp | grep -E ":8081|:8082"
LISTEN 0.0.0.0:8081 ... pid=1342449,fd=11
LISTEN 0.0.0.0:8082 ... pid=1342449,fd=12      # 新 PID 同时持有 8081+8082

$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/healthz   → 200
$ curl -s http://127.0.0.1:8081/ | grep -o 'index-[A-Za-z0-9_-]*\.js'    → index-BGPCHS0j.js   （与 dist/index.html 一致，且 != 旧 index-dH4SuwMy.js）
$ curl -s http://127.0.0.1:8081/ | sha256sum → 5d3eb79e...f35c7
$ sha256sum web/dist/index.html              → 5d3eb79e...f35c7   （服务端返回与磁盘逐字节一致）
$ curl -s -o /dev/null -w "%{http_code}" .../assets/index-BGPCHS0j.js   → 200

$ grep -ci error logs/app_dev_8081_redeploy_20260915_230227.log   → 0（ERROR 计数 0）
```

启动日志全文（7 行，无 ERROR/WARN）：`eestock-app starting` → `schema self-check ok` → `strategy registry 启动播种完成 seeded=0 skipped=0` → `sim-live 启动恢复完成 recovered=0 degraded=0` → `eestock-app serving listen=0.0.0.0:8081 static_dir=./web/dist` → `mcp server (HTTP/SSE) serving listen=0.0.0.0:8082` → `mcp sse session opened`。

**只读记录：`GET /api/config/multi_period` 当前值（原样，未做通过/失败判定）**

```json
{"enabled":true,"periods":["5m","1h","1d"],"heights":{"1d":180,"1h":180,"5m":231},"indicators":["dcap"]}
```

## 7. 变更范围声明（重要）

- **未改任何源码/配置/生成物**：全程只执行构建与重启；唯一新增文件是启动日志 `logs/app_dev_8081_redeploy_20260915_230227.log` 和本报告；`web/dist/**` 由 `npm run build:prod` 重建（该目录被 `web/.gitignore` 的 `dist/` 忽略，属构建产物，不在 git 跟踪范围）。
- **git 暂存状态未被改动**：
  - `git diff --cached --name-status | wc -l` = **21**（部署前 = 21，部署后 = 21）
  - `git diff --cached | sha256sum` = `0d0c402614de3dd8ee876eb6c37245f12cbfa48cdaf213e93aa0fbccaa4867aa`（部署前 = 部署后，逐字节一致）
  - `git rev-parse HEAD` = `8828d4621d9536687a380462f567590d5fc3ea3b`（未变）
  - `git diff --name-only`（未暂存的工作区改动）= 0 个跟踪文件
- **未发写请求**：所有 HTTP 调用均为 `GET`（`/api/sim-live/sessions`、`/api/config/multi_period`、`/healthz`、`/`、`/assets/*.js`），无 PUT/POST/DELETE。
- `/tmp/app_dev_8081.toml` mtime 仍为 `2026-09-10 12:14:46`，未被修改。

## 8. 关键数字汇总

| 项 | 旧 | 新 |
|---|---|---|
| PID | 1247798 | **1342449** |
| 前端 bundle | index-dH4SuwMy.js | **index-BGPCHS0j.js** |
| bundle sha256 | 5bca03b6…e0c53e | **b5ec462f…0e0c3a2** |
| bundle 字节 | 1214792 | 1217684 |

tsc exit=0；cargo exit=0；日志 ERROR=0；healthz=200；staged 文件数 21（未变）；旧/新 PID 均同时监听 8081+8082。
