# ADR-026 重新部署（8081/8082）证据包

- 本文件位置：`coder/evidence/20260919_adr026_redeploy/README.md`
- 原始输出目录：`coder/evidence/20260919_adr026_redeploy/raw/`
- 执行时间：2026-09-19 11:16:31 → 11:17:38 CST（Asia/Shanghai）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- 依据手册：`~/.pi/agent/projects-memory/eestock/skills/rebuild-restart-app-8081/SKILL.md`
- 纪律遵守：未执行 `git add / commit / checkout / stash / reset`；未改动任何业务代码（本轮 `git status` 与部署前一致，`git diff --cached --stat` 为空）；未自创部署流程。

## 裁决摘要

| 项 | 结果 |
|---|---|
| 旧进程 634454 | 已退出（SIGTERM 后 ~1–2s），8081/8082 端口已释放 |
| 新进程 818710 | 2026-09-19 11:17:10 启动，cwd=仓库根，持有 8081+8082 |
| 前端构建 | `cd web && npm run build` exit 0（先跑 `npx tsc -b` exit 0） |
| 后端构建 | `cargo build --bin eestock-app` exit 0（0.09s，无重链，见「口径说明 2」） |
| 线上 bundle | 与本次 build 产物 sha256 完全一致 |
| 启动日志 | 6 行启动 INFO（+后续请求产生的 INFO），ERROR=0 |
| Web 新功能 | `GET /api/workbench/runs/sr_1789738328788_000005/audit` → 200，含 `deployed_pct/planned_tranches/warnings` |
| MCP 新功能 | SSE `tools/list` = 35 个工具且含 `bt_get_run_audit`；未知 run → `isError: true` |
| 备份/回滚件 | 本阶段未新建；沿用冻结包 `coder/backups/adr026_frozen_20260919T105844Z.tar.gz`（27 文件） |

## 1. 部署前形态与门禁（raw/00_pre_state.txt）

```
### ss -lntp 8081/8082
LISTEN 0 128 0.0.0.0:8081 ... users:(("eestock-app",pid=634454,fd=11))
LISTEN 0 128 0.0.0.0:8082 ... users:(("eestock-app",pid=634454,fd=12))
### ps 634454
 634454 634452 Sat Sep 19 10:14:03 2026 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
### /proc/634454/cwd -> /home/eestock/workspace/git/eestock/eestock-rs
### /proc/634454/exe -> .../target/debug/eestock-app
### /proc/634454/cmdline: ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
### healthz: 200
```

手册第 2 步「停机前检查模拟实盘会话」：`curl -s http://127.0.0.1:8081/api/sim-live/sessions` 返回 12 个会话，**全部 `status=ended`**（非 ended 数为 0，见 raw/14_extra_checks.txt 重启后复核），故不存在「打断运行中策略会话」风险，可直接停机。

## 2. 构建

### 2.1 前端（raw/02_tsc_b.txt、03_npm_build.txt、04_post_build_dist.txt）

```
$ cd web && npx tsc -b            → exit 0 (3.4s)
$ cd web && npm run build         → exit 0 (5.45s)
  > tsc -b && vite build
  vite v6.4.3 building for production...
  ✓ 184 modules transformed.
  dist/index.html                     0.40 kB │ gzip:   0.29 kB
  dist/assets/index-CeUPb4uk.css     22.97 kB │ gzip:   5.77 kB
  dist/assets/index-CkI-1t1L.js   1,237.41 kB │ gzip: 381.77 kB
  ✓ built in 2.08s
```

build 前后 `web/dist` 三件产物 sha256 **完全相同**（说明 10:54 已落盘的 dist 内容 == 本次 build 产物）：

```
67f101bc7701119886e43c076f84360b66545876fe270e5e567e64cf120c8199  web/dist/index.html
cc991403600598936124bbd124e5306613b49957327447ffcd7e563ca393f90f  web/dist/assets/index-CeUPb4uk.css
4967c508e507cc2361620b74c56ed6a93cfa293df5a69fd5f64d71b71c437726  web/dist/assets/index-CkI-1t1L.js
```

### 2.2 后端（raw/05_cargo_build.txt）

```
$ cargo build --bin eestock-app
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.09s   → exit 0
$ cargo build --bin eestock-app -v | tail
    Fresh providers / storage / tushare / app
    Finished `dev` profile ... in 0.06s
```

## 3. 平滑替换进程

### 3.1 停机（raw/06_running_vs_disk_bin.txt、07_stop_old_pid.txt）

```
### 停机前：运行镜像 vs 磁盘二进制
sha256 /*proc/634454/exe*/        = 895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b
sha256 target/debug/eestock-app   = 895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b
readlink /proc/634454/exe -> /home/eestock/workspace/git/eestock/eestock-rs/target/debug/eestock-app

### kill -TERM 634454  @ 2026-09-19 11:17:07.672
exited after 2s
ps -p 634454            → 无输出（进程不存在）
ls -ld /proc/634454     → No such file or directory
ss -lntp | grep 808x    → (no listener on 8081/8082)
pgrep -a eestock-app    → (none)         # 无 nohup 包装残留（旧 PPID 634452 亦已不存在）
```

### 3.2 启动（raw/08_start_new.txt，与手册第 5 步同款 nohup 口径，cwd=仓库根）

```
$ LOG=logs/app_dev_8081_redeploy_$(date +%Y%m%d_%H%M%S).log
$ nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> "$LOG" 2>&1 &
  LOGFILE=logs/app_dev_8081_redeploy_20260919_111711.log   spawned bg pid=818710
### 6s 后
LISTEN ... 0.0.0.0:8081 users:(("eestock-app",pid=818710,fd=11))
LISTEN ... 0.0.0.0:8082 users:(("eestock-app",pid=818710,fd=12))
```

## 4. 部署后自证

### 4.1 新进程事实（raw/10_post_deploy_selfcheck.txt）

```
  PID    PPID   STARTED                    ELAPSED  CMD
 818710     1   Sat Sep 19 11:17:10 2026   00:27   ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
/proc/818710/cmdline = ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
/proc/818710/cwd     -> /home/eestock/workspace/git/eestock/eestock-rs
/proc/818710/exe     -> /home/eestock/workspace/git/eestock/eestock-rs/target/debug/eestock-app
/proc/818710/stat 字段22 starttime = 134178756
ss -lntp 8081/8082 → 均为 pid=818710
curl -w '%{http_code}' http://127.0.0.1:8081/healthz → 200
```

PPID=1（父 shell 已退出，nohup 生效，进程不随会话结束退出）。

### 4.2 二进制（raw/10_post_deploy_selfcheck.txt）

```
mtime=2026-09-19 01:13:57.457197250 +0800 size=213324544  target/debug/eestock-app
sha256 target/debug/eestock-app = 895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b
sha256 /proc/818710/exe        = 895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b
strings target/debug/eestock-app | grep -c bt_get_run_audit = 16   (>0 ✔)
```

### 4.3 启动日志（raw/09_startup_log.txt / 09_startup_log_full.log）

```
{"level":"INFO","message":"eestock-app starting","config":"/tmp/app_dev_8081.toml","target":"eestock_app"}
{"level":"INFO","message":"schema self-check ok","target":"eestock_app"}
{"level":"INFO","message":"strategy registry 启动播种完成","seeded":"0","skipped":"0"}
{"level":"INFO","message":"sim-live 启动恢复完成","recovered":"0","degraded":"0"}
{"level":"INFO","message":"eestock-app serving","listen":"0.0.0.0:8081","static_dir":"./web/dist"}
{"level":"INFO","message":"mcp server (HTTP/SSE) serving","listen":"0.0.0.0:8082","target":"mcp::server"}
--- 启动 6 行 INFO；ERROR=0；WARN=0（raw/09 统计口径）---
```

（后续请求在同一日志追加 INFO：`mcp sse session opened/closed`、`workbench_run_audit`；全文件最终 ERROR=0，见 raw/15_final_state.txt。）

### 4.4 静态资源同源（raw/11_static_origin.txt）

```
### 线上 http://127.0.0.1:8081/ 返回
<script type="module" crossorigin src="/assets/index-CkI-1t1L.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-CeUPb4uk.css">

### 线上 /assets vs web/dist（sha256 逐一相等）
4967c508...437726  /tmp/served_index_js.bin              ← GET /assets/index-CkI-1t1L.js
4967c508...437726  web/dist/assets/index-CkI-1t1L.js     ← 本次 npm run build 产物
cc991403...393f90f /tmp/served_index_css.bin             ← GET /assets/index-CeUPb4uk.css
cc991403...393f90f web/dist/assets/index-CeUPb4uk.css    ← 本次 npm run build 产物
67f101bc...20c8199 /tmp/served_index_html.bin            ← GET /
67f101bc...20c8199 web/dist/index.html                   ← 本次 npm run build 产物
```

前端新功能确在线上 bundle 内（raw/14、15）：

```
grep -c deployed_pct / planned_tranches / 口径 / 审计  web/dist/assets/index-CkI-1t1L.js → 1 / 1 / 1 / 1
线上片段：data-testid:"wb-audit-error" | "执行完整度审计加载中…" | "执行完整度审计：未记录（该 run 无 per_bar.orders/events 与 fills 事实源…）"
线上片段："口径：年化 / 最大回撤 / 夏普的分母 = 初始资金 …（未满仓时按实际投入口径的风险更高，故并列披露资金投入率）"
```

### 4.5 Web 审计端点（raw/12_web_audit_endpoint.txt、12_audit_resp.json）

```
$ curl -s -w '\nHTTP=%{http_code}\n' http://127.0.0.1:8081/api/workbench/runs/sr_1789738328788_000005/audit
HTTP=200
{"run_id":"sr_1789738328788_000005","recorded":true,"capital_basis":100000.0,"deployed_notional":41397.97208076086,
 "deployed_pct":0.4139797208076086,"cash_consumed":41607.97208076086,"cash_consumed_pct":0.41607972080760863,
 "planned_tranches":100,"reachable_batches":43,"batches_done":42,"unexecuted_orders":1,"last_bar_unfilled":true,
 "round_trips_total":1,"round_trips_force_closed":1,
 "warnings":[DCA_PLAN_UNDERFILLED(warn), PARTIAL_DEPLOYMENT(warn), ORDERS_UNEXECUTED(info)]}
```

三个必需字段齐备：`deployed_pct` ✔ / `planned_tranches` ✔ / `warnings` ✔（warnings 3 条，含 severity 与中文 message）。

### 4.6 MCP 真机 SSE（raw/13_mcp_sse_tools.txt）

```
GET http://127.0.0.1:8082/sse → event: endpoint  data=/messages?sessionId=d8d23251aecb6af2b4164f250883b556
initialize → {"name":"eestock-mcp","version":"0.1.0"}
notifications/initialized → 202
tools/list → TOOLS_COUNT=35   （预期 35 ✔）
             HAS_bt_get_run_audit=True
             [get_kline … bt_run_ensemble, bt_get_run, bt_get_run_result, bt_list_runs, bt_cancel_run,
              bt_compare_runs, bt_list_presets, bt_apply_preset, bt_get_run_audit]
tools/call bt_get_run_audit(run_id="sr_0000000000000_999999")
  → {"content":[{"text":"工具执行失败：运行不存在: sr_0000000000000_999999","type":"text"}],"isError":true}   ✔
tools/call bt_get_run_audit(run_id="sr_1789738328788_000005")
  → isError 未置位，content 为审计 JSON（deployed_pct=0.4139797208076086，warnings 3 条）                ✔
```

### 4.7 手册冒烟项补充（raw/14_extra_checks.txt）

```
GET /api/config/kline → 200 {"viewport_bars":120}
GET /api/sim-live/sessions → len=12, 非 ended = []    （重启未产生中断会话）
git diff --cached --stat → 空（无 staged 文件）
```

## 5. 口径说明与偏差（如实记录）

1. **前端构建命令**：任务单写 `cd web && npm run build`，手册写 `npx tsc -b` + `npm run build:prod`。两者不冲突：`npm run build` == `tsc -b && vite build`，且 `VITE_API_MOCK` 未设置时前端默认走真实 HTTP client（`web/src/api/index.ts`: 仅 `'1'` 启用 mock；仓库无 `.env*` 文件），与 `build:prod` 的 `VITE_API_MOCK=0` 同为生产侧。为同时满足两侧要求，先单独跑 `npx tsc -b`（exit 0，刻意记录类型结果），再跑 `npm run build`（含 tsc -b 增量）。未使用 `build:prod`，故「线上 bundle == 本次 `npm run build` 产物」按题面口径成立。
2. **`(deleted)` 旁证不适用**：本次 `cargo build` 判定 `Fresh`（0.09s，未重链），部署前运行中进程的 `/proc/634454/exe` 与磁盘二进制 **sha256 相同**（`895c516e…fbf4b`），即旧进程当时已运行同一份 ADR-026 镜像，故不存在「旧 inode 被 unlink 后变 `(deleted)`」的场景。采用了等价且更强的证据：运行镜像 `sha256(/proc/<pid>/exe)` == 本次构建产物 sha256，且重启后新进程同样相等（raw/06、raw/10）+ 旧 `/proc/634454` 目录消失 + 端口释放 + `pgrep` 无残留。
3. **后端构建命令**：手册 `cargo build -p app` 与任务单 `cargo build --bin eestock-app` 等价（bin 为 `crates/app/src/bin/eestock-app.rs`，包名 `app`）；本轮按任务单执行。
4. **未做的事**：未跑 `./scripts/deploy.sh`（手册明确禁用）；未 `docker compose up`（app 不在容器内）；未改任何业务代码或 schema；未执行任何 git 写操作。
5. **未按 ADR-025 临时库跑测试**：本阶段为纯部署+线上自证，未新增/执行需要 DB 的测试，故无临时库创建与 DROP 事项。

## 6. 残余风险

- `web/dist` 与二进制均非「本次命令新鲜产出」（内容哈希未变 / cargo Fresh）：即本机磁盘上早已是 ADR-026 版本，本轮的价值是**进程级重启 + 线上契约自证**，不能据此推断「改动是本次构建引入」。
- 前端 bundle 单 chunk 1.24 MB（vite 警告），浏览器需硬刷新才能拿到新 bundle（手册 Pitfall）。
- 未做浏览器端真渲染/截图验证（本阶段仅 curl 静态同源 + bundle 字符串断言）；若需像素级验收请在续作补 Playwright。
- 未知 run 的 MCP 错误文案依赖后端 `运行不存在: <id>` 文本；若后续改动错误类型，断言需同步。
