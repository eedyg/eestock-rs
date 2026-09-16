# ADR-023 D2 在线部署证据 — VERDICT: PASS

- 证据目录（绝对路径）：/tmp/adr023-d2-deploy-20260916-235846
- 部署窗口：2026-09-16 23:58:43 → 2026-09-17 00:00:29 CST（用时约 1m46s，时间盒 25min 内）
- 被部署物：D2（多周期接入 30m）— 后端 `crates/web/src/dto.rs`（白名单 7 档 + rank 插位）+ 前端 dist 入口 bundle
- 结论：`/healthz` 200、`/api/symbols`=44、`period=30m` 端到端 200 且 60 bars、启动日志 ERROR=0、8081/8082 均属新 PID；S3 回滚路径**未触发**

## 新旧对照（核心）

| 项 | 旧（D1，已停） | 新（D2，在线） |
|---|---|---|
| PID | `68833`（23:10:21 启动，SIGTERM 后 2s 干净退出） | `178558`（23:59:28 启动） |
| 二进制 sha256 | `9a0586ffe2b336fbb97e255738735cf7ff54129e7f3bd34aba543b4a5d209c02`（207066920 B，`/proc/68833/exe` 已 (deleted)） | `d6fed24ef8a3d6839bb0191aeb881b323b256733f6ed9e6ec462475cb85f78d0`（207067000 B，`/proc/178558/exe` 指向真实路径） |
| 启动日志 | `logs/app_dev_8081_redeploy_20260916_231022.log` | `logs/app_dev_8081_redeploy_20260916_235929.log` |
| 8081/8082 属主 | pid=68833 fd=11/12 | pid=178558 fd=11/12 |
| dist 入口 bundle | `index-CB06bOVO.js`（D1 部署报告记载，sha `f8df4bb1…`） | `index-J50SI06a.js`（sha256 `980ea937b3a3ab0837fed2a4e39ec3588c02b4db251b47ea4094668e0e67b8b9`） |
| dist index.html | — | sha256 `80a4de47fd9d32b62b13d446860b8a20a335815353ee471fbfd4240956c79688` |
| dist css | — | `index-BpQVDpqf.css` sha256 `935e8bff272dc3ab3b23c51d7910799cb3e2bdcc94a663b8c1d912999fda5a95` |

## 回滚件（保留现场）

`/tmp/adr023-d2-deploy-20260916-235846/rollback_eestock-app`（sha256 `9a0586ff…`，207066920 B），抓取自 S0 时刻的 `/proc/68833/exe`；S3 未触发故未使用。

---


=== S2 RESTART ===
--- containers BEFORE (name, image, status, startedAt) ---
eestock-app	eestock-rs_app	Exited (137) 6 days ago	7 days ago
eestock-data	eestock-rs_data	Up 11 days (healthy)	11 days ago
eestock-timescaledb	timescale/timescaledb:2.29.2-pg16	Up 11 days (healthy)	11 days ago
scrylink-023c0fda-392a-4f0a-bed4-3253ef8c2cb2	a26e58a482fe	Up 4 days	4 days ago
scrylink-14bbed4d-455c-482a-b394-a87468c7497b	6bd6fb3ad658	Up 15 hours	15 hours ago
scrylink-8c08155f-cf85-446b-9f9e-75acbea75c47	a26e58a482fe	Up 4 days	4 days ago
scrylink-godot-023c0fda-392a-4f0a-bed4-3253ef8c2cb2	scrylink-godot:4.6	Up 4 days	4 days ago
--- all listeners on 8081/8082 before kill ---
LISTEN 0      128               0.0.0.0:8081       0.0.0.0:*    users:(("eestock-app",pid=68833,fd=11))   
LISTEN 0      128               0.0.0.0:8082       0.0.0.0:*    users:(("eestock-app",pid=68833,fd=12))   
--- identity re-confirm of 68833 ---
./target/debug/eestock-app --config /tmp/app_dev_8081.toml 
--- pre-restart /healthz (old binary 68833) ---
http_code=200
{"status":"ok"}
--- kill 68833 ---
kill rc=0
PID 68833 exited after 2s
--- ports after kill ---
(no listener on 8081/8082)
--- start cmd ---
setsid nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml < /dev/null >> logs/app_dev_8081_redeploy_20260916_235929.log 2>&1 &
--- NEW PID ---
178558
--- ps (pid,ppid,user,lstart,etime,cmd) ---
 178558  178552 eestock  Wed Sep 16 23:59:28 2026       00:11 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
--- new exe link + sha256 ---
lrwxrwxrwx 1 eestock eestock 0 Sep 16 23:59 /proc/178558/exe -> /home/eestock/workspace/git/eestock/eestock-rs/target/debug/eestock-app
d6fed24ef8a3d6839bb0191aeb881b323b256733f6ed9e6ec462475cb85f78d0  /proc/178558/exe
--- new cwd ---
lrwxrwxrwx 1 eestock eestock 0 Sep 16 23:59 /proc/178558/cwd -> /home/eestock/workspace/git/eestock/eestock-rs
--- new cmdline ---
./target/debug/eestock-app --config /tmp/app_dev_8081.toml 
--- starttime_ticks ---
112832560
--- log file: logs/app_dev_8081_redeploy_20260916_235929.log ---
-rw-rw-r-- 1 eestock eestock 1126 2026-09-16 23:59:30.107393366 +0800 logs/app_dev_8081_redeploy_20260916_235929.log
--- log contents (startup) ---
{"timestamp":"2026-09-16T15:59:29.057788Z","level":"INFO","fields":{"message":"eestock-app starting","config":"/tmp/app_dev_8081.toml"},"target":"eestock_app"}
{"timestamp":"2026-09-16T15:59:29.102448Z","level":"INFO","fields":{"message":"schema self-check ok"},"target":"eestock_app"}
{"timestamp":"2026-09-16T15:59:29.103617Z","level":"INFO","fields":{"message":"strategy registry 启动播种完成","seeded":"0","skipped":"0"},"target":"eestock_app"}
{"timestamp":"2026-09-16T15:59:29.104428Z","level":"INFO","fields":{"message":"sim-live 启动恢复完成","recovered":"0","degraded":"0"},"target":"eestock_app"}
{"timestamp":"2026-09-16T15:59:29.104492Z","level":"INFO","fields":{"message":"eestock-app serving","listen":"0.0.0.0:8081","static_dir":"./web/dist"},"target":"eestock_app"}
{"timestamp":"2026-09-16T15:59:29.104514Z","level":"INFO","fields":{"message":"mcp server (HTTP/SSE) serving","listen":"0.0.0.0:8082"},"target":"mcp::server"}
{"timestamp":"2026-09-16T15:59:30.107701Z","level":"INFO","fields":{"message":"mcp sse session opened","session":"9a25e1a58310451e311f9e3e253813a9"},"target":"mcp::server"}
--- error count in startup log ---
0

=== S4 SMOKE TESTS ===
--- timestamp ---
2026-09-16T23:59:46+08:00
--- S4.1 GET /healthz ---
exit_curl=0 http_code=200
body: {"status":"ok"}
--- S4.2 GET /api/symbols ---
http_code=200 size=10662
count: 44; keys: array
--- S4.3 GET /api/kline?code=518880&period=30m&limit=60 ---
http_code=200 size=8412
top-level keys: bars,code,next_before,period
period: 30m
bars count: 60
first bar: {"ts":"2026-09-09T01:30:00Z","open":8.97,"high":8.995,"low":8.97,"close":8.98,"volume":81137277,"amount":729113461.0,"source":"tushare"}
last bar: {"ts":"2026-09-16T07:00:00Z","open":8.905,"high":8.905,"low":8.905,"close":8.905,"volume":3246300,"amount":28908300.0,"source":"tushare"}
--- S4.4 GET /api/config/multi_period (single read-only GET, verbatim) ---
http_code=200 size=77
VERBATIM BODY:
{"enabled":false,"periods":["1m"],"heights":{"1m":420},"indicators":["dcap"]}
--- S4.5 startup log ERROR count ---
ERROR lines: 0
WARN lines: 0
--- S4.6 listeners ---
LISTEN 0      128               0.0.0.0:8081       0.0.0.0:*    users:(("eestock-app",pid=178558,fd=11))  
LISTEN 0      128               0.0.0.0:8082       0.0.0.0:*    users:(("eestock-app",pid=178558,fd=12))  
--- S4.7 static frontend served by new PID ---
index.html served sha: 80a4de47fd9d32b62b13d446860b8a20a335815353ee471fbfd4240956c79688  -
disk index.html  sha: 80a4de47fd9d32b62b13d446860b8a20a335815353ee471fbfd4240956c79688  web/dist/index.html
bundle js served sha: 980ea937b3a3ab0837fed2a4e39ec3588c02b4db251b47ea4094668e0e67b8b9  -
disk bundle js  sha: 980ea937b3a3ab0837fed2a4e39ec3588c02b4db251b47ea4094668e0e67b8b9  web/dist/assets/index-J50SI06a.js

=== S1/S4 provenance addendum ===
--- cargo freshness (grep of cargo build -v) ---
       Fresh webpki-roots v1.0.9
       Fresh domain v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/domain)
       Fresh webpki-roots v0.26.11
       Fresh application v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/application)
       Fresh web v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/web)
       Fresh storage v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/storage)
       Fresh tushare v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/tushare)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s
--- served bundle proof (D2 frontend live) ---
count of "30m" in served /assets/index-J50SI06a.js: 8
frozen density key 1m:30m occurrences: 1
frozen density key 5m:30m occurrences: 1
frozen density key 15m:30m occurrences: 1
frozen density key 30m:1h occurrences: 1
gdb read of MULTI_PERIOD_ALLOWED symbol: NOT AVAILABLE (const inlined; 'No symbol ... in current context') — runtime whitelist probe would require forbidden POST/PUT, deliberately NOT attempted.

=== S5 SIDE-EFFECT AUDIT ===
--- timestamp ---
2026-09-17T00:00:23+08:00
--- git rev-parse HEAD ---
3094018f352dae25752340d78b5e108c284aeecc
--- staged files (must be empty except git's own) ---
0
--- git status --porcelain -uno count (baseline 27) ---
27
--- git status --porcelain count (baseline 92) ---
92
--- diff vs baseline status snapshot ---
(untracked additions in after-status not in S0 list are shown below)
--- .gitignore mtime/untouched ---
-rw-rw-r-- 1 eestock eestock 448 2026-09-13 20:30:48.376881573 +0800 .gitignore
7a25f270a6a218da7708ef205a4bdfd9e87add167ddf69c9cd6bbb631896866f  .gitignore
--- containers AFTER ---
eestock-app	eestock-rs_app	Exited (137) 6 days ago	7 days ago
eestock-data	eestock-rs_data	Up 11 days (healthy)	11 days ago
eestock-timescaledb	timescale/timescaledb:2.29.2-pg16	Up 11 days (healthy)	11 days ago
scrylink-023c0fda-392a-4f0a-bed4-3253ef8c2cb2	a26e58a482fe	Up 4 days	4 days ago
scrylink-14bbed4d-455c-482a-b394-a87468c7497b	6bd6fb3ad658	Up 15 hours	15 hours ago
scrylink-8c08155f-cf85-446b-9f9e-75acbea75c47	a26e58a482fe	Up 4 days	4 days ago
scrylink-godot-023c0fda-392a-4f0a-bed4-3253ef8c2cb2	scrylink-godot:4.6	Up 4 days	4 days ago
--- logs dir new file only (untracked? ignored?) ---
.gitignore:23:/logs/	logs/app_dev_8081_redeploy_20260916_235929.log
--- any staged changes to ADR/design? ---

=== S1 bundle freshness determination ===
newest web/src file mtime : 2026-09-16 23:48:54.5562678070 web/src/api/mock.ts
web/dist/index.html mtime : 2026-09-16 23:55:23.448150375 +0800 web/dist/index.html
web/dist/assets/*   mtime : 2026-09-16 23:55:23.448150375 +0800 web/dist/assets/index-BpQVDpqf.css|2026-09-16 23:55:23.448150375 +0800 web/dist/assets/index-J50SI06a.js|
=> dist mtime 2026-09-16 23:55:23 is LATER than newest web/src change 2026-09-16 23:48:54 => no npm run build needed (D2 frontend already in dist)
entry bundle name: D1 report = index-CB06bOVO.js ; now = index-J50SI06a.js (rebuilt in D2 impl, sha 980ea937...)

=== FINAL STABILITY RECHECK (t+~90s) ===
2026-09-17T00:00:29+08:00
--- new PID alive? ---
 178558 Wed Sep 16 23:59:28 2026       01:00 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
--- old PID 68833 gone? ---
68833 absent (good)
--- /healthz ---
http_code=200
--- listeners ---
LISTEN 0      128               0.0.0.0:8081       0.0.0.0:*    users:(("eestock-app",pid=178558,fd=11))  
LISTEN 0      128               0.0.0.0:8082       0.0.0.0:*    users:(("eestock-app",pid=178558,fd=12))  
--- startup log ERROR/WARN totals over full runtime ---
ERROR=0  WARN=0
--- log line count ---
7

=== ROLLBACK ARTIFACT RETAINED ===
-rwxrwxr-x 1 eestock eestock 207066920 Sep 16 23:58 /tmp/adr023-d2-deploy-20260916-235846/rollback_eestock-app
9a0586ffe2b336fbb97e255738735cf7ff54129e7f3bd34aba543b4a5d209c02  /tmp/adr023-d2-deploy-20260916-235846/rollback_eestock-app
=== VERDICT: S3 rollback NOT triggered (no failure) ===

=== S5 FINAL RE-AUDIT (after writing report 293) ===
2026-09-17T00:00:56+08:00
HEAD: 3094018f352dae25752340d78b5e108c284aeecc  (baseline 3094018f352dae25752340d78b5e108c284aeecc)
staged count: 0
status --porcelain -uno count: 27  (baseline 27)
status --porcelain count: 93  (baseline 92; +1 = this report)
--- delta vs baseline untracked list ---
new untracked entries in this session:
?? coder/report/293_adr023_period30m_d2_deploy.md
--- .gitignore untouched ---
7a25f270a6a218da7708ef205a4bdfd9e87add167ddf69c9cd6bbb631896866f  .gitignore
--- containers RunningFor (must equal S0) ---
eestock-app	7 days ago
eestock-data	11 days ago
eestock-timescaledb	11 days ago
scrylink-023c0fda-392a-4f0a-bed4-3253ef8c2cb2	4 days ago
scrylink-14bbed4d-455c-482a-b394-a87468c7497b	15 hours ago
scrylink-8c08155f-cf85-446b-9f9e-75acbea75c47	4 days ago
scrylink-godot-023c0fda-392a-4f0a-bed4-3253ef8c2cb2	4 days ago
--- final online state ---
 178558 Wed Sep 16 23:59:28 2026       01:27 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
LISTEN 0      128               0.0.0.0:8081       0.0.0.0:*    users:(("eestock-app",pid=178558,fd=11))  
LISTEN 0      128               0.0.0.0:8082       0.0.0.0:*    users:(("eestock-app",pid=178558,fd=12))  
healthz=200
