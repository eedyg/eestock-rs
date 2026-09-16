# ADR-023 D1 上线实施 — 逐步骤证据（EVIDENCE）

- 本文件位置：`/tmp/adr023-deploy-20260916-230726/EVIDENCE.md`
- 时间戳 TS：2026-09-16 23:07:26 CST（会话开始）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- 起始 HEAD：`3094018f352dae25752340d78b5e108c284aeecc`（终未变）
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`
- 在线库：`eestock@127.0.0.1:5433/eestock`（PGPASSWORD=eestock）
- 时间盒：30 min；实际关键路径 = S0..S7 全绿

---

## S0 冻结与回滚件

### 命令 1：无其他车道在跑（勿自匹配）
```
$ pgrep -a -f eestock-app | grep -v pgrep
1342395 /bin/bash -c cd /home/.../eestock-rs && ... kill 1247798 ...   # 上一轮部署残留 shell
1342449 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml     # 在线 app
exit=0
$ pgrep -a cargo    → exit=1 (无)
$ pgrep -a -f 'cargo|entangled|psql|tangle' | grep -v pgrep
48045 /home/mdb/.../psql ... -d regression ...   # 属 mdb/ymatrix，非本车道
```
判据：无 cargo/entangled 编译或门禁在跑；唯一 psql 属他项目（mdb/ymatrix）。

### 命令 2：冻结基线
```
$ git rev-parse HEAD
3094018f352dae25752340d78b5e108c284aeecc
$ git status --porcelain -uno | wc -l
23
```

### 命令 3：在线 PID 详情（应为 1342449）
```
$ ps -o pid,ppid,lstart,etime,cmd -p 1342449
    PID    PPID                  STARTED     ELAPSED CMD
1342449 1342395 Tue Sep 15 23:02:29 2026  1-00:05:01 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
$ readlink /proc/1342449/cwd  → /home/eestock/workspace/git/eestock/eestock-rs
$ readlink /proc/1342449/exe  → /home/eestock/workspace/git/eestock/eestock-rs/target/debug/eestock-app
$ tr '\0' ' ' </proc/1342449/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
$ ss -ltnp | grep -E '8081|8082'
LISTEN 0 128 0.0.0.0:8081 0.0.0.0:* users:(("eestock-app",pid=1342449,fd=11))
LISTEN 0 128 0.0.0.0:8082 0.0.0.0:* users:(("eestock-app",pid=1342449,fd=12))
```

### 命令 4：抓回滚二进制（从 /proc/<旧PID>/exe，必须在 S2 覆盖前）
```
$ cp -L /proc/1342449/exe /tmp/adr023-deploy-20260916-230726/eestock-app.rollback ; rc=0
$ sha256sum .../eestock-app.rollback
dab4504c4e4b78c8c83084244a5391d4934d2efd2366c36c49cde09eecfc0224  .../eestock-app.rollback
（207065864 bytes；与落库前 target/debug/eestock-app 逐字节一致）
```

### 命令 5：web/dist 入口 bundle 标识（部署证据必须含）
```
$ grep -o 'index-[A-Za-z0-9_-]*\.js' web/dist/index.html → index-CB06bOVO.js
$ sha256sum web/dist/assets/index-CB06bOVO.js
f8df4bb1deb98b29347b2dd610108d1c3fb8f1b6b7196d970b6e0d85c42e9ebb  web/dist/assets/index-CB06bOVO.js
$ sha256sum web/dist/index.html
e39d7de15e3bf6e7f902c221b7808b71734239170ee64e48b4be20e0a45756cc  web/dist/index.html
```

---

## S1 R6 散文修正（仅散文，未动任何 file= 代码块）

改动文件：`design/04-storage/02-tushare-sync.md`（§2 工作流注记）与
`design/04-storage/03-raw-writer.md`（§3 标题 + 背景约束段）。精确 diff 见 `s1-diff.txt`
（该文件同时含 ADR-023 实现期既有的 doc-first 改动，见下）。

### 修改前（§2 注记）
```
⚠️ 工作流注记：initdb 仅在空数据卷首次启动时执行；0005 随本次重建卷生效，
**之后的迁移一律走 sqlx migrate**，不再享受免费 initdb。
```
### 修改后
```
⚠️ 工作流注记：initdb 仅在空数据卷首次启动时执行；0005 随本次重建卷生效。
**现网库上无 `_sqlx_migrations` 台账**（迁移由 initdb 或手工 psql 应用落地），sqlx migrate 无法直接重放；
app 启动只做 schema 自检（见 03 §3），**不再享受免费 initdb**。

⚠️ 运维注记：**现网增量迁移只能以手工方式应用**（无台账、sqlx migrate 不可重放）：
`psql -v ON_ERROR_STOP=1 -f migrations/<NNNN>_<name>.sql`
（不加 `--single-transaction`：cagg 建视图与 refresh 不可在显式事务块内）。
```

### 修改前（§3）
```
## 3. 启动自检（ADR-017：sqlx migrate 自检的落地口径）
... 因此 Wave 0 启动自检落地为**关键关系 + hypertable 存在性校验**（缺任一并列明缺失项、拒绝启动）；
0007+ 迁移的台账化接入随首个增量迁移一并设计（Wave 1 边界，见 wave-0.md「明确不做」无冲突）。
```
### 修改后
```
## 3. 启动自检（ADR-017：app 启动 schema 自检的落地口径）
... 因此启动自检落地为**关键关系 + hypertable 存在性校验**（缺任一并列明缺失项、拒绝启动）；
app 启动**只做该 schema 自检，不代管迁移台账**。**现网增量迁移只能以手工方式应用**：
`psql -v ON_ERROR_STOP=1 -f migrations/<NNNN>_<name>.sql`（不加 `--single-transaction`：
cagg 建视图与 refresh 不可在显式事务块内）。
```
> ADR-017 与 `design/10-wave-plans/wave-0.md` 未动（禁令遵守）。

### 命令 6：基线门禁（改动前，用于区分既有漂移）
```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。  exit=0
$ entangled tangle
INFO Nothing to be done.  exit=0
```

### 命令 7：改动后 entangled tangle（无 --force）
```
$ entangled tangle
INFO Nothing to be done.  exit=0
```

### 命令 8：产物逐字节不变（20 个生成物 sha256 前后对比）
```
$ diff gen-hashes-before.txt gen-hashes-after.txt && echo IDENTICAL-BYTES
IDENTICAL-BYTES
```
覆盖：`crates/storage/src/{accurate,events,kline,lib,migrate_check,symbols}.rs`、
`crates/storage/tests/{accurate_upsert,event_sink,raw_writer,symbols_registry}.rs`、
`crates/tushare/src/{bin/tushare_sync,client,daily,lib,parse,sync}.rs`、
`crates/tushare/tests/{daily_sync,golden_parse,sync_plan}.rs`、`migrations/0005_sync_checkpoints.sql`。

### 命令 9：改动后门禁复跑（必须 exit 0）
```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。  exit=0
```

---

## S2 构建新二进制

```
$ cargo build --bin eestock-app
   Compiling app v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/app)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.65s
real 0m1.691s     exit=0
```
（按既有运维口径：debug，不用 deploy.sh。依赖 crate 已在实现期编译，仅重链 app。）

二进制前后对照：
```
BEFORE: -rwxrwxr-x ... 207065864 ... target/debug/eestock-app
        sha256 dab4504c4e4b78c8c83084244a5391d4934d2efd2366c36c49cde09eecfc0224  (== 回滚件)
AFTER : -rwxrwxr-x 2 eestock eestock 207066920 2026-09-16 23:08:33.680585912 +0800 target/debug/eestock-app
        sha256 9a0586ffe2b336fbb97e255738735cf7ff54129e7f3bd34aba543b4a5d209c02
```
（尺寸 +1056B，与 30m 代码增量一致。回滚件 sha256 仍为 dab4504c… 未被覆盖。）

---

## S3 落库（迁移 0026）

命令原文（**无 -1/--single-transaction**）：
```
$ psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -v ON_ERROR_STOP=1 -c '\timing on' \
        -f migrations/0026_period_30m.sql
```
START 2026-09-16T23:09:14+08:00 / END 2026-09-16T23:09:54+08:00

**总耗时：`real 0m40.350s`（user 0m0.016s / sys 0m0.004s）；psql exit=0**（完整输出见 s3-migration.txt）

分项计时（psql `\timing on`）：
```
CREATE MATERIALIZED VIEW (含创建时自动 refresh kline_accurate_30m): 37641.245 ms (00:37.641)
remove_continuous_aggregate_policy(kline_accurate_5m)  : 8.411 ms
remove_continuous_aggregate_policy(kline_accurate_15m) : 2.602 ms
remove_continuous_aggregate_policy(kline_accurate_30m) : 0.353 ms  (NOTICE: policy not found, skipping)
remove_continuous_aggregate_policy(kline_accurate_1h)  : 2.099 ms
add_continuous_aggregate_policy(kline_accurate_5m)     : 2.481 ms  (job 1051)
add_continuous_aggregate_policy(kline_accurate_15m)    : 1.642 ms  (job 1052)
add_continuous_aggregate_policy(kline_accurate_30m)    : 1.640 ms  (job 1053)
add_continuous_aggregate_policy(kline_accurate_1h)     : 1.662 ms  (job 1054)
CALL refresh_continuous_aggregate('kline_accurate_30m', NULL, NULL) : 1026.422 ms (00:01.026)
CALL refresh_continuous_aggregate('kline_accurate_5m',  NULL, NULL) : 1145.264 ms (00:01.145)
CALL refresh_continuous_aggregate('kline_accurate_15m', NULL, NULL) :  495.487 ms
```
> 三条 refresh 单独耗时：**30m = 1026.422 ms，5m = 1145.264 ms，15m = 495.487 ms**。
> 注：30m 建视图时（未带 WITH NO DATA）已自动全量刷新一次（37.6s，占了绝大部分总耗时），
> 故随后的显式 `CALL ... 30m` 命中 "already up-to-date" 仅 1.0s。1h 按迁移设计**未**全量刷（无已知缺口）。
> **未在生产库重跑 0026**（幂等性已由探测库与验收阶段证明；本次仅此一次应用）。

---

## S4 落库后只读校验（全部 SELECT）

源数据背景（只读）：`kline_accurate` period='M1' → 16,344,861 行，44 codes，区间 2012-01-04 .. 2026-09-16 07:00+00。

### (a) cagg 总数 = 10 且含 kline_accurate_30m
```
$ SELECT count(*) FROM timescaledb_information.continuous_aggregates;  → 10   ✅
$ SELECT view_name ... WHERE view_name='kline_accurate_30m';          → kline_accurate_30m  ✅
names: kline_15m, kline_1d, kline_5m, kline_accurate_15m, kline_accurate_1d,
       kline_accurate_1h, kline_accurate_1mo, kline_accurate_1w, kline_accurate_30m, kline_accurate_5m
```
（落库前基线 = 9，无 30m；见 baseline-cag-names.txt）

### (b) jobs：5m/15m/30m/1h start_offset 均 3 days，end_offset/schedule 保持现值
```
 job_id |  hypertable_name   | schedule_interval | start_offset | end_offset
   1051 | kline_accurate_5m  | 00:01:00          | 3 days       | 00:01:00
   1052 | kline_accurate_15m | 00:01:00          | 3 days       | 00:01:00
   1053 | kline_accurate_30m | 01:00:00          | 3 days       | 01:00:00
   1054 | kline_accurate_1h  | 01:00:00          | 3 days       | 01:00:00
```
✅ 四者 start_offset 均 3 days；5m/15m schedule=1 min、30m/1h schedule=1 hour；end_offset 与现值一致。
（落库前：5m start 2h / 15m start 6h / 1h start 2 days；30m 不存在。job id 1048/1049/1050 → 1051/1052/1054。）

### (c) kline_accurate_30m max(ts) 与逐日计数
```
$ SELECT max(ts) FROM kline_accurate_30m;  → 2026-09-16 07:00:00+00   ✅（== 最近交易日收盘）
逐交易日计数：09-07..09-16 每个交易日 = 440（非 0）✅
2026-09-07|440  09-08|440  09-09|440  09-10|440  09-11|440  09-14|440  09-15|440  09-16|440
```
（09-12/09-13 为周六/周日，无交易，预期无行。）

### (d) kline_accurate_5m 9/7 以来缺口补齐 —— 落库前/后逐日对照
```
落库前(基线):  09-07|2200   其余 09-08..09-16 全部无行(=0)   【基线对照】
落库后       :  09-07|2200  09-08|2200  09-09|2200  09-10|2200  09-11|2200
                09-14|2200  09-15|2200  09-16|2200
max(ts): 落库前 2026-09-07 07:00+00  →  落库后 2026-09-16 07:00+00  ✅
零计数交易日（09-08..09-16 中的交易日）查询结果：空  ✅（仅周末 09-12/09-13 无行，符合预期）
```

### (e) kline_accurate_1h 无缺口
```
逐交易日 09-07..09-16 每个交易日 = 264（非 0）✅
2026-09-07|264 09-08|264 09-09|264 09-10|264 09-11|264 09-14|264 09-15|264 09-16|264
```
（1h 按迁移设计未全量刷，但无已知缺口 —— 与落库前一致。）

### 幂等性说明
**未在生产库重跑 0026**（避免对活库重复执行）。幂等性已由探测库 + 独立验收阶段证明；
本节均为只读 SELECT 断言。

---

## S5 重启 app（部署新代码）

```
$ kill 1342449        → rc=0
（4s 后）ps -p 1342449 → 进程不存在 (rc=1)；ss 8081/8082 → 无监听 (rc=1)
```
启动（沿用既有运维口径：setsid + nohup + `< /dev/null` + 落 `logs/app_dev_8081_redeploy_<ts>.log`）：
```
$ cd /home/eestock/workspace/git/eestock/eestock-rs
$ LOGF="logs/app_dev_8081_redeploy_$(date +%Y%m%d_%H%M%S).log"   # = logs/app_dev_8081_redeploy_20260916_231022.log
$ setsid nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> "$LOGF" 2>&1 < /dev/null &
```
> 与任务字面命令的差异说明：既有运维口径（见历史 `logs/app_dev_8081_redeploy_*.log` 与上一轮部署 shell 1342395）
> 使用 `setsid nohup ... < /dev/null` 且日志落到 `logs/app_dev_8081_redeploy_<ts>.log`；
> 为保持会话无关的稳定脱离（避免父 shell 退出带走进程），沿用既有方式，并按任务要求说明。

新 PID：**68833**，启动时刻 `Wed Sep 16 23:10:21 2026`（`ps -o lstart`）
```
$ pgrep -x eestock-app  → 68833
$ tr '\0' ' ' </proc/68833/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
$ readlink /proc/68833/exe → /home/eestock/workspace/git/eestock/eestock-rs/target/debug/eestock-app  (非 deleted)
$ readlink /proc/68833/cwd → /home/eestock/workspace/git/eestock/eestock-rs
```
启动日志（新二进制）全文：
```
INFO eestock-app starting   config="/tmp/app_dev_8081.toml"
INFO schema self-check ok                    <-- 新自检含 kline_accurate_30m，通过
INFO strategy registry 启动播种完成 seeded="0" skipped="0"
INFO sim-live 启动恢复完成 recovered="0" degraded="0"
INFO eestock-app serving    listen="0.0.0.0:8081" static_dir="./web/dist"
INFO mcp server (HTTP/SSE) serving listen="0.0.0.0:8082"
INFO mcp sse session opened session="84aeaf5c..."
```
**未触发回滚**（未用 eestock-app.rollback）。

---

## S6 冒烟（全部实测）

```
$ curl -s -w '\nhttp=%{http_code}\n' http://127.0.0.1:8081/healthz
{"status":"ok"}   http=200                                            ✅
$ curl -s http://127.0.0.1:8081/api/symbols | (json len)              → count=44  ✅
$ curl -s -o smoke-30m.json -w 'HTTP=%{http_code}' \
    'http://127.0.0.1:8081/api/kline?code=518880&period=30m&limit=120'
HTTP=200                                                              ✅
  period field = "30m" ; bars count = 120 ; ts 严格单调递增 = True
  first ts = 2026-09-01T01:30:00Z ; last ts = 2026-09-16T07:00:00Z
  bar keys = [amount, close, high, low, open, source, ts, volume]
$ curl -s -w '\nHTTP=%{http_code}\n' 'http://127.0.0.1:8081/api/kline?code=518880&period=30x'
{"error":"period 须为 1m/5m/15m/30m/1h/1d/1w/1mo"}   HTTP=400          ✅（含全部 8 档）
$ grep -ciE '\bERROR\b' <新启动日志>  → 0                              ✅
$ ss -ltnp | grep -E '8081|8082'
LISTEN 0.0.0.0:8081 users:(("eestock-app",pid=68833,fd=11))            ✅
LISTEN 0.0.0.0:8082 users:(("eestock-app",pid=68833,fd=12))            ✅
```

---

## S7 副作用审计

```
$ git rev-parse HEAD                      → 3094018f352dae25752340d78b5e108c284aeecc   (未变) ✅
$ git status --porcelain -uno | wc -l     → 23   （与 S0 基线一致，未新增/删除行）      ✅
$ git diff --cached --name-only | wc -l   → 0    （无 staged）                          ✅
$ git status --porcelain -uno .gitignore  → 空   （.gitignore 未改）                    ✅
$ git status --porcelain | grep '^??'     → 与 S0 基线一致（无新增未跟踪文件；新日志在 logs/ 已被 .gitignore 忽略）✅
$ docker ps → eestock-timescaledb "Up 11 days (healthy)" / eestock-data "Up 11 days (healthy)"
              （容器未重启）；其他项目 scrylink-* "Up 3 days/14 hours"（未动）           ✅
```
- 无 `git add` / `git commit` / `git stash`；无 `entangled tangle --force`；无全局 `entangled stitch`。
- web/dist 入口 bundle 前后**逐字节不变**：`index-CB06bOVO.js`
  sha256 = f8df4bb1deb98b29347b2dd610108d1c3fb8f1b6b7196d970b6e0d85c42e9ebb（磁盘与服务端一致）。
- 临时残留：仅本证据目录 `/tmp/adr023-deploy-20260916-230726/`（按任务要求保留供取证）。

---

## 关键数值汇总

| 项 | 值 |
|---|---|
| 迁移总耗时 | `real 0m40.350s`（psql exit 0） |
| refresh 30m / 5m / 15m | 1026.422 ms / 1145.264 ms / 495.487 ms |
| 30m 建视图自动刷新 | 37641.245 ms |
| 旧 PID / 新 PID | 1342449（2026-09-15 23:02:29）/ 68833（2026-09-16 23:10:21） |
| 旧二进制 sha256（回滚件） | dab4504c4e4b78c8c83084244a5391d4934d2efd2366c36c49cde09eecfc0224 |
| 新二进制 sha256 | 9a0586ffe2b336fbb97e255738735cf7ff54129e7f3bd34aba543b4a5d209c02 |
| 入口 bundle | index-CB06bOVO.js @ f8df4bb1…（前后不变） |
| HEAD | 3094018f352dae25752340d78b5e108c284aeecc（未变） |
