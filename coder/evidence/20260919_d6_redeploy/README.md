# D6 修复重新部署（8081/8082）自证证据包

- **本文件位置**：`coder/evidence/20260919_d6_redeploy/README.md`
- **原始输出目录**：`coder/evidence/20260919_d6_redeploy/raw/`
- **执行时间**：2026-09-19 16:35:39 → 16:36:52 CST（Asia/Shanghai）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `40d16e1`
- **依据手册**：`/home/eestock/.pi/agent/projects-memory/eestock/skills/rebuild-restart-app-8081/SKILL.md`（逐步按第 1–6 步执行）
- **纪律遵守**：未执行 `git add / commit / checkout / stash / reset`；未改动任何业务代码（`git diff --stat` 起止相同，`git diff --cached --stat` 为空）；未跑 `./scripts/deploy.sh`；未 `docker compose up app`。本轮**未**创建/未 DROP 临时测试库（本阶段无 DB 测试）。

## 0. 裁决摘要

| 项 | 结果 |
|---|---|
| 旧进程 818710（运行镜像 `895c516e…`，ADR-026 旧二进制、**不含 D6**） | `kill -TERM` 后 ~100ms 退出；`/proc/818710` 消失；8081/8082 释放；`pgrep eestock-app` 无残留 |
| 新进程 1210738 | 2026-09-19 16:36:14 启动，cwd=仓库根，PPID=1，同时持有 8081+8082 |
| 前端构建 | `cd web && npx tsc -b` exit 0；`npm run build` exit 0（184 modules，1.96s） |
| 后端构建 | `cargo build --bin eestock-app` exit 0（重链 strategy-core/simlive/application/web/mcp/app，1.21s） |
| 二进制 | mtime `2026-09-19 16:35:59.32`，sha256 `ead45c29…b4d02`；`/proc/1210738/exe` 同 sha |
| 启动日志 | `logs/app_dev_8081_redeploy_20260919_163614.log` 启动 6 行 INFO；ERROR=0，WARN=0 |
| healthz | 200 |
| 线上静态资源 | `GET /`、`/assets/index-CkI-1t1L.js`、`/assets/index-CeUPb4uk.css` 三者 sha256 与本次 `npm run build` 产物**逐一相等** |
| **冒烟自证（新代码在跑）** | `interval=0` → **400** `policy_invalid`「Dca.interval 必须 ≥ 1（省略即为默认 1）」（旧二进制为 201，已实测基线）；省略 `interval` → **201**（旧二进制为 400 `missing field \`interval\``，已实测基线） |
| 语义等价（数值旁证） | 三个 run（旧 0 / 新省略 / 新显式 1）`batches_done`、`reachable_batches`、`deployed_pct` **全等** |

> ⚠️ 本节为**部署者自证**，不替代 tester 的独立验收（`tester/evidence/20260919_d6_live_verify/`）。

## 1. 部署前形态与门禁（raw/00_pre_state.txt）

```
### ss -lntp 8081/8082
LISTEN 0 128 0.0.0.0:8081  users:(("eestock-app",pid=818710,fd=11))
LISTEN 0 128 0.0.0.0:8082  users:(("eestock-app",pid=818710,fd=12))
### ps -o pid,ppid,lstart,etime,cmd -p 818710
 818710  1  Sat Sep 19 11:17:10 2026  05:18:28  ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
### /proc/818710/exe -> .../target/debug/eestock-app (deleted)
### sha256 /proc/818710/exe = 895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b
### /proc/818710/cwd     -> /home/eestock/workspace/git/eestock/eestock-rs
### 磁盘二进制（部署前）mtime=2026-09-19 16:31:25  sha256=ead45c291f632563524edbc14192adf843ecfb98660d5bce361012138cbb4d02
### healthz HTTP=200
### sim-live 会话：total=12, non_ended=[]      ← 手册第 2 步门禁：无运行中会话，可直接停机
### git diff --cached --stat → 空（无 staged）
```

手册第 2 步「停机前检查模拟实盘会话」：12 个会话全部 `status=ended`，非 ended 数为 0，不存在打断运行中策略会话的风险；重启后复核仍为 `non_ended=[]`（raw/14、15），即本次重启未产生中断会话。

**关键判据（旧二进制不含 D6）**：运行中镜像 `sha256(/proc/818710/exe)=895c516e…`，`readlink` 带 `(deleted)`——说明 11:17:10 启动的进程仍在跑 **11:13 构建的 ADR-026 镜像**，之后磁盘二进制被重新链接过。D6 错误文案在该旧镜像中不存在、在新构建产物中存在（见 §4.2）。

## 2. 构建

### 2.1 前端（raw/02_tsc_b.txt、03_npm_build.txt、04_post_build_dist.txt）

```
$ cd web && npx tsc -b          → EXIT=0（3.4s 内，无类型错误）
$ cd web && npm run build       → EXIT=0
  > tsc -b && vite build
  vite v6.4.3 building for production...
  ✓ 184 modules transformed.
  dist/index.html                     0.40 kB │ gzip:   0.29 kB
  dist/assets/index-CeUPb4uk.css     22.97 kB │ gzip:   5.77 kB
  dist/assets/index-CkI-1t1L.js   1,237.41 kB │ gzip: 381.77 kB
  (!) Some chunks are larger than 500 kB after minification.  （vite 提示，非错误）
  ✓ built in 1.96s
```

build 前后 `web/dist` 三件产物 sha256 **完全相同**（见 §5「口径说明 1」）：

```
67f101bc…20c8199  web/dist/index.html
4967c508…437726   web/dist/assets/index-CkI-1t1L.js
cc991403…393f90f  web/dist/assets/index-CeUPb4uk.css
```

**非 mock 构建确认**：`VITE_API_MOCK` 未设置、`web/.env*` 不存在；`web/src/api/index.ts` 仅当 `=== '1'` 才启用契约 mock（默认站在生产一侧）——与手册 `build:prod`（`VITE_API_MOCK=0`）同为生产侧口径。

### 2.2 后端（raw/05_cargo_build.txt、06_bin_static_diff.txt）

```
$ cargo build --bin eestock-app
   Compiling strategy-core v0.1.0
   Compiling simlive v0.1.0
   Compiling application v0.1.0
   Compiling web v0.1.0
   Compiling mcp v0.1.0
   Compiling app v0.1.0
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.21s     → EXIT=0
### 产物
-rwxrwxr-x 213324216  2026-09-19 16:35:59.320782517 +0800  target/debug/eestock-app
ead45c291f632563524edbc14192adf843ecfb98660d5bce361012138cbb4d02  target/debug/eestock-app
### D6 文案是否编入
grep -ac "Dca.interval 必须 ≥ 1（省略即为默认 1）"  target/debug/eestock-app  → 1   （新产物：有）
grep -ac "Dca.interval 必须 ≥ 1（省略即为默认 1）"  /proc/818710/exe          → 0   （旧镜像：无）
```

cargo 明确因 `crates/strategy-core/src/policy.rs`（mtime 16:33:57）而重链 `strategy-core` 及其 5 个下游 crate（非 `Fresh` 跳过），即该二进制**确由当前工作区源码构建**。

## 3. 平滑替换进程

### 3.1 停机（raw/07_stop_old_pid.txt）

```
### kill -TERM 818710  @ 2026-09-19 16:36:10.045
exited after 200ms  (2026-09-19 16:36:10.151)
ps -p 818710            → 无输出（exit=1，进程不存在）
ls -ld /proc/818710     → No such file or directory
ss -lntp | grep 808x    → grep_exit=1（无监听 = 端口已释放）
pgrep -a eestock-app    → 无输出（exit=1，无 nohup 包装残留）
```

旧日志尾部（`app_dev_8081_redeploy_20260919_111711.log`）显示停机前 142ms 前落的那次基线 run 已 `outcome: succeeded`，无中断痕迹。

### 3.2 启动（raw/08_start_new.txt，与手册第 5 步同款 nohup 口径，cwd=仓库根）

```
$ LOG=logs/app_dev_8081_redeploy_$(date +%Y%m%d_%H%M%S).log
$ nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> "$LOG" 2>&1 &
  LOGFILE=logs/app_dev_8081_redeploy_20260919_163614.log   spawned bg pid=1210738
### 6s 后
  PID      PPID  STARTED                    ELAPSED  CMD
 1210738      1  Sat Sep 19 16:36:14 2026   00:06    ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
LISTEN ... 0.0.0.0:8081  users:(("eestock-app",pid=1210738,fd=11))
LISTEN ... 0.0.0.0:8082  users:(("eestock-app",pid=1210738,fd=12))
/proc/1210738/cwd -> /home/eestock/workspace/git/eestock/eestock-rs
/proc/1210738/exe -> .../target/debug/eestock-app        （无 (deleted)，即磁盘同款 inode）
sha256 /proc/1210738/exe = ead45c291f632563524edbc14192adf843ecfb98660d5bce361012138cbb4d02
/proc/1210738/stat 字段22 starttime = 136093150
curl -w '%{http_code}' http://127.0.0.1:8081/healthz → 200
```

## 4. 部署后自证

### 4.1 新进程事实与端口归属（raw/10_post_deploy_selfcheck.txt、15_final_state.txt）

```
PID 1210738 / PPID 1 / STARTED Sat Sep 19 16:36:14 2026 / cwd=仓库根 / exe=target/debug/eestock-app
ss -lntp：8081 → pid=1210738(fd=11)；8082 → pid=1210738(fd=12)
healthz → HTTP=200
旧 PID 818710：ps 无输出、/proc/818710 不存在、pgrep 仅剩 1210738
```

### 4.2 二进制（mtime + sha256）

```
mtime=2026-09-19 16:35:59.320782517 +0800  size=213324216  target/debug/eestock-app
sha256 target/debug/eestock-app = ead45c291f632563524edbc14192adf843ecfb98660d5bce361012138cbb4d02
sha256 /proc/1210738/exe       = ead45c291f632563524edbc14192adf843ecfb98660d5bce361012138cbb4d02  ✔ 同源
grep -ac "Dca.interval 必须 ≥ 1（省略即为默认 1）" /proc/1210738/exe = 1     ← D6 文案确在运行镜像内
D6 源码：crates/strategy-core/src/policy.rs  sha256=cec749d83b8bcbf1cfdd10a8780bd9ca881ef2df3144ef333ee93cb1956245c5（671 行，未提交）
```

### 4.3 启动日志（raw/09_startup_log.txt、10、15）

```
{"level":"INFO","message":"eestock-app starting","config":"/tmp/app_dev_8081.toml"}         08:36:14.957Z
{"level":"INFO","message":"schema self-check ok"}                                            08:36:15.003Z
{"level":"INFO","message":"strategy registry 启动播种完成","seeded":"0","skipped":"0"}        08:36:15.004Z
{"level":"INFO","message":"sim-live 启动恢复完成","recovered":"0","degraded":"0"}            08:36:15.005Z
{"level":"INFO","message":"eestock-app serving","listen":"0.0.0.0:8081","static_dir":"./web/dist"}  08:36:15.005Z
{"level":"INFO","message":"mcp server (HTTP/SSE) serving","listen":"0.0.0.0:8082"}            08:36:15.005Z
--- 启动 6 行 INFO；全文件（含自证请求日志）ERROR=0、WARN=0（16:36:27 时 16 行；16:36:52 终态 28 行仍 ERROR=0）---
```

### 4.4 静态资源同源（raw/11_static_origin.txt）

```
### 线上 http://127.0.0.1:8081/ 返回
<script type="module" crossorigin src="/assets/index-CkI-1t1L.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-CeUPb4uk.css">

### 三种资源 sha256（线上 GET vs 本次 npm run build 产物，逐一 diff 判定一致）
4967c508…437726  /tmp/served_index_js.bin    ==  web/dist/assets/index-CkI-1t1L.js    → JS 一致 ✔
cc991403…393f90f /tmp/served_index_css.bin   ==  web/dist/assets/index-CeUPb4uk.css   → CSS 一致 ✔
67f101bc…20c8199 /tmp/served_index_html.bin  ==  web/dist/index.html                  → index.html 一致 ✔
### 磁盘 dist/index.html 引用：assets/index-CkI-1t1L.js（与线上引用同名）
```

### 4.5 冒烟自证「新代码在跑」（raw/12、13）

判据体（最小 body，`raw/baseline_body_*.json`）：
`518880 / M5 / 2026-09-17T01:30Z→07:00Z / slots=[sv_1789013713975_000001 weight 1.0] / warmup_bars=0 / confirm=true`，唯一变量是 policy。

**① `Dca.interval = 0`（raw/12_smoke_interval0.txt）**

```
$ curl -s -w '\nHTTP=%{http_code}\n' -X POST -H 'content-type: application/json' \
    --data '{"symbol":"518880",...,"policy":{"Dca":{"tranches":2,"mode":"Equal","amount":null,"interval":0}},...}' \
    http://127.0.0.1:8081/api/workbench/runs
{"error":{"code":"policy_invalid","detail":{"period":"M5"},"message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}
HTTP=400                                  ← 期望 400 ✔（旧二进制实测为 201，见 raw/01）
```

**② 省略 `interval`（raw/13_smoke_interval_omitted.txt）**

```
$ curl -s -w '\nHTTP=%{http_code}\n' ... --data '{"policy":{"Dca":{"tranches":2,"mode":"Equal","amount":null}},...}'
{"id":"sr_1789806985225_000000",...,"config":{...,"policy":{"Dca":{"amount":null,"mode":"Equal","tranches":2}},...},
 "status":"queued",...}
HTTP=201                                  ← 期望 201/202 ✔（旧二进制实测为 400 missing field，见 raw/01）
```

**③ 基线（同一判据体打旧进程，raw/01_baseline_smoke_old.txt，16:35:42 停机前）**

```
interval=0  → HTTP=201  {"id":"sr_1789806942293_000012",... "policy":{"Dca":{"interval":0,...}}, "status":"queued"}
省略 interval → HTTP=400  {"error":{"code":"policy_invalid","detail":{"period":"M5"},"message":"policy 非法: missing field `interval`"}}
```

**三条互斥 → 新二进制确在线上运行。**

### 4.6 补充（非替代 tester；raw/14、14b）

```
GET  /api/config/kline            → 200 {"viewport_bars":120}
PUT  /api/config/kline 130（合法）→ 200 {"viewport_bars":130}
PUT  /api/config/kline 0（越界）  → 400 {"error":"viewport_bars 须为 30..=600 整数，收到 0"}
PUT  /api/config/kline 99999（越界）→ 400 {"error":"viewport_bars 须为 30..=600 整数，收到 99999"}
PUT  /api/config/kline 120（恢复）→ 200，终态 GET 复核 = {"viewport_bars":120}   ← 已还原，未留副作用
GET  /api/sim-live/sessions       → total=12, non_ended=[]                        ← 重启未中断会话
显式 interval=1 → HTTP=201（sr_1789807001774_000001，"policy":{"Dca":{...,"interval":1,...}}）← 防「过度拒绝」回归
省略 interval 的 run sr_1789806985225_000000 终态 → status=succeeded
### 等价性数值旁证（同一 fixture：49 bars，tranches=2 Equal，warmup=0）
旧二进制+显式 0  : planned_tranches=2, reachable_batches=1, batches_done=1, deployed_pct=0.4999868167930293
新二进制+省略    : planned_tranches=2, reachable_batches=1, batches_done=1, deployed_pct=0.4999868167930293
新二进制+显式 1  : planned_tranches=2, reachable_batches=1, batches_done=1, deployed_pct=0.4999868167930293
```

### 4.7 契约同步（未提交修复，本阶段未改动、仅作对照）

- `design/12-strategy-system/01-adr.md`：`Dca{… interval?: k（**≥ 1**；省略 = 1）}` + 「`interval = 0` 非法，`ExecutionPolicy::validate` fail loud…省略时 serde default = 1」。
- `crates/strategy-core/src/policy.rs`：`#[serde(default = "default_dca_interval")]`（显式 1，**非** `usize` 的裸 `default`=0）+ `validate` 对显式 0 返回「Dca.interval 必须 ≥ 1（省略即为默认 1）」。
- `web/src/features/workbench/ConfigPanel.test.tsx`：表单层拦截 `interval=0` 且 `interval=1` 合法（**测试文件，不进 bundle**）。

## 5. 口径说明与偏差（如实记录）

1. **前端构建命令**：任务单写 `cd web && npm run build`，手册写 `npx tsc -b` + `npm run build:prod`。按任务单执行，并额外先单独跑 `npx tsc -b` 记录类型结果（EXIT=0）；`npm run build == tsc -b && vite build`，且 `VITE_API_MOCK` 未设置时前端默认走真实 HTTP client（`web/src/api/index.ts` 仅 `'1'` 启用 mock，仓库无 `.env*`），与 `build:prod` 同为生产侧。故「线上 bundle == 本次 `npm run build` 产物」按题面口径成立。
2. **前端 bundle 哈希与上一轮相同**：D6 的前端改动是**测试文件** `ConfigPanel.test.tsx`（不进 bundle），因此 `web/dist` 三件产物 sha256 与 2026-09-19 11:16 ADR-026 轮次完全相同。本轮前端构建仍按手册执行以证明「磁盘 dist == 本次构建产物」，但**不能**用 bundle 哈希变化来证明 D6 生效；D6 的线上可判别证据是 §4.5 的 400/201 契约行为（后端）与 §4.2 的二进制文案。
3. **`(deleted)` 说明与二进制同 sha 现象**：部署前磁盘二进制（16:31 构建）与本次构建产物 **sha256 相同**（`ead45c29…`），即 D6 源码在 16:31 已被编译过；但**在跑进程**是 11:17:10 启动、镜像为 `895c516e…`（`readlink` 带 `(deleted)`）的 ADR-026 旧镜像。故本轮的实质价值 = **进程级重启 + 线上契约行为自证**；「D6 代码已编入运行镜像」由 §4.2 `grep -a` 命中 + §4.5 线上 400/201 直接证明，不依赖 mtime。
4. **后端构建命令**：手册 `cargo build -p app` 与任务单 `cargo build --bin eestock-app` 等价（bin = `crates/app/src/bin/eestock-app.rs`，包名 `app`）；本轮按任务单执行。
5. **手工冒烟产生的业务侧副作用（已如实记录）**：workbench run 3 条（`sr_1789806942293_000012` 旧二进制 interval=0 基线、`sr_1789806985225_000000` 新二进制省略 interval、`sr_1789807001774_000001` 新二进制显式 1），均 `succeeded`；`/api/config/kline` 临时 PUT 130 后已恢复 120。未删除任何数据。
6. **未做的事**：未跑 `./scripts/deploy.sh`（手册禁用，避免 --force 打掉在线进程）；未 `docker compose up`（app 不在容器内）；未改业务代码/schema；未执行任何 git 写操作（`git reflog -3` 顶层仍为 `40d16e1`，`git diff --cached --stat` 为空）。
7. **等价性旁证的可判别性上限**：本次 live fixture（49 bars、tranches=2 Equal）`reachable_batches=1`，因此三个 run 的 `batches_done` 全等**可以**证明「省略 ≡ 显式 1 ≡ 旧 0」，但该 fixture **无法**区分 k=1 与 k=5 的批次数差异；k∈{1,5,20} 的数值不变性由 `crates/strategy-core/src/policy.rs` 单测（`dca_interval_batch_counts_unchanged_for_1_5_20`）与 tester 独立验收覆盖，不在本部署自证口径内。

## 6. 残余风险

- 本阶段仅做**部署 + 部署者自证**；未做 tester 的独立 live 验收，也未跑浏览器端渲染/E2E。D6 的「省略 == 1」执行等价性只在本机单次 run 上对照（同 fixture 3 run），未覆盖多周期/多 tranche 组合。
- 前端 bundle 未变（D6 无 bundle 级改动），浏览器无需硬刷新即可；但若用户已缓存旧 SPA，其行为与本轮无关。
- `interval` 的**配置快照回显**为「请求原文」（省略时快照内无 `interval` 字段，显式 0 被拒后不会落库），与执行语义（default 1）存在「快照不含字段」的表象差异——如需审计口径将 default 落进快照，属产品/接口决策，本阶段未改。
- 未知 run/非法 body 的 400 文案（`Dca.interval 必须 ≥ 1（省略即为默认 1）`）若后续被改动，本包与 tester 的字符串断言需同步。
- `web/dist` 单 chunk 1.24 MB（vite 警告）；二进制为 debug 形态（213 MB），与现网口径一致。
