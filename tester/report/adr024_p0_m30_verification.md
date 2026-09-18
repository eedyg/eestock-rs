# ADR-024 P0（M30 打通 + 周期白名单单一事实源）—— 独立验收报告

- **报告自身路径（self-location）**：`tester/report/adr024_p0_m30_verification.md`（本文件）
- **执行记录**：`tester/test/298_adr024_p0_verification_execution.md`
- **证据目录**：`tester/evidence/246_adr024_p0_verify/`（索引：该目录 `EVIDENCE.md`）
- **执行者**：tester（**只验不改**）
- **执行时间**：2026-09-18 12:47:03 → 12:52:24 +0800
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`｜**被测交付**：仅 staged（48 files, +1807/−56），未 commit
- **结论依据**：全部为本目录**工具原始输出**；凡 worker 报告的转述一律以本报告重跑结果为准

---

# 判词：**PASS**

**5 项任务（① ~ ⑤）全部达成，无门禁失败项。** 唯一曾缺证的门禁「M30 真跑出结果」**已在本轮补齐并为 PASS**。

附 **2 项缺陷**（均**不构成门禁失败**，逐条列出、附原始输出）：

| # | 缺陷 | 严重度 | 是否阻塞 P0 Gate | 处置建议（不在本任务范围） |
|---|---|---|---|---|
| **D1** | **前端防漂移测试 `web/src/features/backtest/periods.test.ts` 未入 index（untracked）**；worker 报告 §3/§7 却将其列为已交付断言（§7 staged 清单也遗漏该文件） | 中（交付完整性） | 否（后端侧 drfit 断言仍在，见 §5） | commit 前 `git add web/src/features/backtest/periods.test.ts`（1 条命令） |
| **D2** | `web/src/features/workbench/ConfigPanel.test.tsx` 的「周期下拉 = `SUPPORTED_BACKTEST_PERIODS`（含 M30）」断言**对 M30 成员资格不敏感（恒真）**：删掉常量里的 `M30` 后仍 13/13 全绿 | 低（测试强度） | 否（M30 存在性由 `periods.test.ts` + 后端 drift 断言双重钉住，均已取证可红） | 断言改为与 `contract-vectors.json`（或硬编码六档字面量）比对的**独立**期望 |

**另有 1 项过程事实必须写入结论**（改变了本任务的执行路径）：**现网 8081 原先并不是含 P0 的二进制**——worker 报告 §6 R1 把「M30 真跑未取证」归因于「无可用测试库」，但**首要原因是在线进程陈旧**：在旧进程上 `POST period=M30` 返回 **400 旧硬编码文案**。按架构师批准，已用仓内既有技能 `rebuild-restart-app-8081` 让 P0 上线（回滚件已留、冒烟含负向对照、可回滚），随后完成真跑门禁。

---

## 0. 判词速览

| # | 任务项 | 判词 | 关键原始证据（本目录） |
|---|---|---|---|
| ① | **M30 端到端真跑**（经现网 REST 8081，生产 DB） | **PASS** | `05_m30_e2e_run.txt`、`05b_m30_run_assertions.txt`、`04_smoke.txt` |
| ①′ | 收尾：删 run + 回读 0 + 库清单不变（ADR-025 D3） | **PASS** | `06_teardown.txt` |
| ② | 独立重跑门禁（后端 / workspace / check / 前端 / 构建 / tangle） | **PASS**（64+137 个集成测试因「禁止建库」无法执行，属**环境前置**，非 P0 缺陷；已披露） | `10_*`~`14_*`、`11_*`、`02_*`、`13_*` |
| ③ | 防漂移断言的**独立**反向证据（自造红/绿） | **PASS** | `30_drift_reverse_evidence.txt` |
| ④ | 禁改项客观断言（值级 + 路径级，`git diff --cached`） | **PASS** | `20_forbidden_changes.txt`、`20b_constants_and_consistency.txt` |
| ⑤ | 测试有效性抽查（防空断言，含人为扰动） | **PASS**（附 D2 观察） | `32_web_test_falsifiability.txt`、`31_test_effectiveness.txt`、`30_*` |
| — | 交付完整性 | **⚠ D1** | `20b_constants_and_consistency.txt` |

---

## 1. 现网形态纠正：任务前提「8081 已含 P0」不成立（原始输出）

任务书假设「现网 REST 8081（app pid 178558，DB=生产 eestock）」可直接跑 M30。**实测不成立**：

```
$ ps -o pid,lstart,cmd -p 178558 --no-headers
 178558 Wed Sep 16 23:59:28 2026 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
$ sha256sum /proc/178558/exe target/debug/eestock-app
d6fed24ef8a3d6839bb0191aeb881b323b256733f6ed9e6ec462475cb85f78d0  /proc/178558/exe
a044626d7816c8deadfc4a5d02213fddba8819d2e9780a75edf88bc8858a48f0  target/debug/eestock-app
$ strings -a /proc/178558/exe | grep -c "M1/M5/M15/M30/H1/D1"
0
$ curl -s -X POST http://127.0.0.1:8081/api/workbench/runs -H 'Content-Type: application/json' \
    -d '{"symbol":"518880","period":"M30",...}' -w '\nHTTP=%{http_code}\n'
{"error":"period 须为 M1/M5/M15/H1/D1"}
HTTP=400
```
（`00_preflight.txt`）——**旧文案、旧白名单**。时间线佐证：进程启于 **09-16 23:59**、磁盘产物构建于 **09-17 09:19**，而 P0 源码改动时间为 **09-18 12:38–12:41**。

> 因此 worker §6 R1 的表述需修正：「无测试库」是**次要**原因；**首要原因是 P0 从未上线到在线进程**。这条对后续任何"经 8081 验收"的任务都成立（**每次验收前必须先做 `strings /proc/<pid>/exe` 的形态确认**）。

**处置（架构师批准，附 5 条硬条件）**：

| 硬条件 | 落实 |
|---|---|
| 1 回滚件先行 | `cp /proc/178558/exe /tmp/eestock-app.rollback.20260918_124734`，sha `d6fed24e…`（== 旧在线 exe）；**未触发回滚**（构建/冒烟/门禁全绿） |
| 2 来源可追溯（**非 HEAD**） | 见 §1.1 |
| 3 冒烟含 M30 负向对照 | `W1 → 400`、`M300 → 400`（§2.1） |
| 4 M30 run 命名/删除/库清单 | §2.2 / §2.3 |
| 5 不改生产代码、不 add/commit | §8 |

### 1.1 新上线产物的来源（**= HEAD + P0 staged diff，不是 HEAD**）

```
$ git rev-parse HEAD
18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f
$ git diff --cached --stat | tail -3
 web/src/features/workbench/ConfigPanel.test.tsx    |   8 +
 web/src/features/workbench/ConfigPanel.tsx         |   9 +-
 48 files changed, 1807 insertions(+), 56 deletions(-)
$ cargo build -p app          # 3.31s, EXIT=0
$ ls -l --time-style=full-iso target/debug/eestock-app
-rwxrwxr-x 2 eestock eestock 207560064 2026-09-18 12:47:16 target/debug/eestock-app
$ sha256sum target/debug/eestock-app
f4d07dcce45f8d08f555761cb0c06573d6b19d7c2cac9511c505a5ce305712fc
$ strings -a target/debug/eestock-app | grep -c "M1/M5/M15/M30/H1/D1"
1
$ kill 178558; sleep 3; nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> logs/app_dev_8081_redeploy_20260918_124734.log 2>&1 &
$ ss -lntp | grep -E ':8081|:8082'
LISTEN 0 128 0.0.0.0:8081 users:(("eestock-app",pid=4083225,fd=11))
LISTEN 0 128 0.0.0.0:8082 users:(("eestock-app",pid=4083225,fd=12))
$ ps -o pid,lstart,cmd -p 4083225 --no-headers
 4083225 Fri Sep 18 12:47:37 2026 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
$ sha256sum /proc/4083225/exe target/debug/eestock-app
f4d07dcce45f8d08f555761cb0c06573d6b19d7c2cac9511c505a5ce305712fc  /proc/4083225/exe
f4d07dcce45f8d08f555761cb0c06573d6b19d7c2cac9511c505a5ce305712fc  target/debug/eestock-app
$ readlink /proc/4083225/cwd
/home/eestock/workspace/git/eestock/eestock-rs
$ grep -c '"level":"ERROR"' logs/app_dev_8081_redeploy_20260918_124734.log
0
```
（`03_redeploy_8081.txt`、`03b_app_log.txt`；停机门禁 sim-live = 12/12 `ended`、`non_ended []`）

**未 staged 的工作区改动（原样保留、未纳入构建表述）**：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`、`docker-compose.yml`（后者为 ADR-025 的 `max_worker_processes=32`，与本车道无关；见 §6.3）。

---

## 2. ① M30 端到端真跑（最高优先级）—— **PASS**

### 2.1 冒烟 + 负向对照（新进程 4083225）

```
--- 4.1 healthz ---
{"status":"ok"}                                    HTTP=200
--- 4.2 symbols ---
HTTP=200   len = 44   518880 in symbols = True
--- 4.3 kline 1d 518880 ---
HTTP=200   末根 2026-09-16T16:00:00Z close 8.856
--- 4.4 NEGATIVE CONTROL: period=W1 must still be 400 ---
{"error":"period 须为 M1/M5/M15/M30/H1/D1（未知周期: W1）"}   HTTP=400
--- 4.5 NEGATIVE CONTROL: period=M300 must still be 400 ---
{"error":"period 须为 M1/M5/M15/M30/H1/D1（未知周期: M300）"} HTTP=400
--- 4.6 startup log --- ERROR=0  WARN=0
```
（`04_smoke.txt`）—— 负向对照证明白名单**不是**被"放开成什么都收"：错误消息由 SSOT 生成（含 M30），而 W1/M300 仍 400。

### 2.2 真跑：原始请求 / 原始 201 响应 / 轮询输出

```
--- POST /api/workbench/runs ---
{"name":"ADR024-P0-verify-20260918_124754","symbol":"518880","period":"M30",
 "from":"2026-07-19T00:00:00Z","to":"2026-09-17T00:00:00Z",
 "slots":[{"version_id":"sv_1789013713975_000001","params":{"fast":5,"slow":20},"weight":1.0}],
 "policy":{"LumpSum":{"position_pct":1.0}},"initial_capital":100000}

{"id":"sr_1789706874229_000000","name":"ADR024-P0-verify-20260918_124754","symbol":"518880","period":"M30",
 "from_ts":"2026-07-19T00:00:00Z","to_ts":"2026-09-17T00:00:00Z",
 "config":{...,"warmup_effective":250,...},
 "status":"queued","progress":0.0,"error":null,
 "created_at":"2026-09-18T04:47:54.230129Z","started_at":null,"finished_at":null}
__HTTP__201
HTTP=201  submit_wall=.032s
run_id=sr_1789706874229_000000
--- poll GET /api/workbench/runs/{id} ---
[poll 1 @ 12:47:54] running 0.029411764705882353 None
[poll 2 @ 12:47:56] succeeded 1.0 None
--- GET /runs/{id}/result --- HTTP=200 bytes=123596
```
（`05_m30_e2e_run.txt`）

**断言（`05b_m30_run_assertions.txt`，原始输出）**：

```
run_view.period       = 'M30'
run_view.status       = 'succeeded' progress= 1.0 error= None
result keys           = ['drawdown', 'metrics', 'net_value', 'per_bar', 'trades']
per_bar / trades / net_value / drawdown len = 680 14 430 430
metrics               = {"annualized_return": 0.1985…, "max_drawdown": 0.0526…, "net_profit": 3938.24,
                         "profit_factor": 3.5477…, "sharpe": 1.5051…, "trade_count": 14, "win_rate": 0.2857…}
deltas Counter (s)    = [(1800, 544), (5400, 68), (66600, 53), (239400, 13), (325800, 1)]
all deltas % 1800 == 0 : True
non-monotonic pairs   = 0
first per_bar         = {"aggregate":50.0,"signal":"Hold","ts":1781227800,"warmup":true,...}
last  per_bar         = {"aggregate":50.0,"events":[{"bar_index":679,"price":8.903219,"qty":11656.19,"reason":"ForceClose","side":"Sell","type":"fill"}],...}

ASSERT OK: run_view.period=='M30' && status=='succeeded' && per_bar non-empty (n=680)
           && all bar deltas on the 1800s grid && trades=14 executed
```

> **口径说明（我自己的首版断言写错过，如实记录）**：`period` 字段位于 **run view**（`GET /runs/{id}`），**不在** `/result` payload 里（`/result` keys = `per_bar/net_value/drawdown/metrics/trades`）。首版断言按字面"结果里 period==M30"写，触发 `AssertionError: period != M30`；修正为「run view 的 `period` == 'M30'」后通过。这不是产品缺陷，是本测试脚本的口径错误。**另**：首版还要求"所有 bar 间距恰为 1800s"，实际存在合法休市间隔（5400/66600/239400/325800s 均为 1800s 整数倍）⇒ 判据修正为**1800s 栅格整数倍**。
>
> **门禁结论**：M30 经 REST → application → 引擎 → 存储 → 读取全链路**真跑出结果**（680 根 per_bar、14 笔成交、五 jsonb 齐全），**非仅校验通过**。

### 2.3 收尾（ADR-025 D3：正向断言，非"无新增"）

```
--- 6.1 BEFORE ---
 sr_1789706874229_000000 | ADR024-P0-verify-20260918_124754 | M30 | succeeded   (matching count = 1)
--- 6.2 DELETE ---
DELETE FROM strategy_run WHERE name LIKE 'ADR024-P0-verify-%' RETURNING id, name;
DELETE 1
--- 6.3 AFTER（正向断言）---
strategy_run  matching count      = 0
strategy_run_result orphans by id = 0
--- 6.4 REST ---
{"error":"运行不存在: sr_1789706874229_000000"}  HTTP=404（/runs/{id} 与 /result 均 404）
--- 6.5 db list (AFTER) ---
 eestock
 postgres
count = 2
```
（`06_teardown.txt`；FK `strategy_run_result.run_id → strategy_run ON DELETE CASCADE` 已先行核验）

**未新建任何数据库**：库清单 BEFORE（`00_preflight.txt`）= AFTER（`06_teardown.txt`）= **`{eestock, postgres}`**。

---

## 3. ② 独立重跑门禁（不复用 worker 输出）

| 门禁 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 后端 4 crate | `cargo test -p backtest -p application -p web -p mcp --no-fail-fast` | **316 passed / 64 failed / 0 ignored** | `10_*` |
| 后端 workspace | `cargo test --workspace --no-fail-fast` | **611 passed / 137 failed / 1 ignored** | `14_*` |
| 全目标编译 | `cargo check --all-targets` | **EXIT=0** | `11_*` |
| 前端全量 | `npx vitest run` | **89 files / 850 tests passed**，EXIT=0（与 worker 声称一致） | `12_*` |
| 前端构建 | `npx tsc -b` + `npm run build:prod` | EXIT=0；`dist/assets/index-DI8Hug12.js` | `02_*` |
| tangle | `./scripts/check-tangle.sh` | ✅ 一致，EXIT=0 | `13_*` |
| P0 定向（Rust） | backtest --lib **22** / application ssot **6** / mcp drift **5** / web gate **4** | 全绿 | `15_*` |
| P0 定向（前端） | periods 3 / format 9 / mock 46 / ConfigPanel 13 / TestRunPanel 6 | **77/77** 全绿 | `15_*` |

### 3.1 失败项定性（**观察，不做归因式调试**）

64（子集）/137（全集）个失败的 panic 站点与文案**逐条完全相同**：

```
[137x] crates/test-support/src/lib.rs:32:14 ::
       集成测试拒绝运行：环境变量 `EESTOCK_TEST_DATABASE_URL` 未设置（或为空）。
       这是**刻意设计**的响亮失败——禁止回退到活库 `eestock`（测试会写库，误指即污染生产数据）。
```
→ **唯一失败因**（脚本对 panic 地点/文案做聚合统计，无第二种形态）。

涉及目标（33 个，全部为**既有**集成测试，**无一属 P0 新增/被改文件**）：`api_admin / api_alerts / api_favorites / api_kline_period / api_ma_config / api_multi_period_config / api_quality / api_rest / api_settings / api_strategies / api_workbench / ws_poller / orphan_detect_* / period30m_d2_multiperiod_red / mcp_tools_db / d11_fee_profile_e2e` 及 storage 侧 `*_store.rs / kline_reader / accurate_upsert / raw_writer / simulate …`。

**定性**：这是**环境前置未满足**——本任务纪律「禁止新建任何数据库」与仓内测试库门禁（ADR-023 E6b：连接串只能来自 `EESTOCK_TEST_DATABASE_URL` 且须含哨兵表，禁止回退活库）**共同决定**这些测试在本车道**不可执行**。**P0 的 4 个新测试文件与全部被改 crate 的单元测试 100% 通过。**

**取舍说明（任务允许）**：两条命令都跑了；workspace 全量在既定编译缓存下很快完成，无需以"耗时"为由省略。若要消除这 137 个失败，需按 ADR-025 D3 先落地 `scripts/testdb-init.sh --drop`（**当前未实现，属 ADR-025 §4 待实现项**）——**不在本任务授权范围**。

---

## 4. ③ 防漂移断言的**独立性**复核（自造反向证据）—— **PASS**

**扰动**：把 `web/src/features/backtest/periods.ts` 的 `SUPPORTED_BACKTEST_PERIODS` 临时删掉 `'M30'`。

```
$ sed -i "s/\['M1', 'M5', 'M15', 'M30', 'H1', 'D1'\]/['M1', 'M5', 'M15', 'H1', 'D1']/" web/src/features/backtest/periods.ts
17:export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'H1', 'D1'] as const;
```

**Rust 侧（`crates/mcp/tests/adr024_period_ssot_drift.rs`）必须红 —— 确实红**：

```
test backend_ssot_matches_frontend_mirror ... FAILED
test all_four_period_sources_are_byte_equal ... FAILED
---- backend_ssot_matches_frontend_mirror stdout ----
assertion `left == right` failed: supported_backtest_periods() != web/src/features/backtest/periods.ts 的前端镜像常量
  left: ["M1", "M5", "M15", "M30", "H1", "D1"]
 right: ["M1", "M5", "M15", "H1", "D1"]
---- all_four_period_sources_are_byte_equal stdout ----
assertion `left == right` failed: backend != frontend mirror
test result: FAILED. 3 passed; 2 failed; 0 ignored
RUST_EXIT=101
```

**TS 侧（`web/src/features/backtest/periods.test.ts`）必须红 —— 确实红**：

```
❯ src/features/backtest/periods.test.ts (3 tests | 2 failed)
  × SUPPORTED_BACKTEST_PERIODS == contract-vectors.json::backtest_periods（逐字相等）
  × 集合为契约六档（含 M30），顺序即展示序
AssertionError: expected [ 'M1', 'M5', 'M15', 'H1', 'D1' ] to deeply equal [ Array(6) ]
-   "M30",
Tests  2 failed | 1 passed (3)      TS_EXIT=1
```

**复原 ⇒ 必须回绿 —— 确实回绿**：

```
$ cp /tmp/periods.ts.P0baseline web/src/features/backtest/periods.ts
$ sha256sum web/src/features/backtest/periods.ts
04b540dedf18f1e55625bbf0f6726077c8bc2f94dc69f691e2ad6a095d99f14a   （== 扰动前基线）
$ git diff -- web/src/features/backtest/periods.ts      → （空）
$ git rev-parse :web/src/features/backtest/periods.ts
799c18cc4aeea82a568f0a89ecb4fb3a2fe22a44               （staged blob 未变）
$ cargo test -p mcp --test adr024_period_ssot_drift
test result: ok. 5 passed; 0 failed; 0 ignored            RUST_EXIT=0
$ npx vitest run src/features/backtest/periods.test.ts
Test Files 1 passed (1)   Tests 3 passed (3)              TS_EXIT=0
$ git diff --stat
 design/01-architecture/adr/ADR-023-period-set-extension-30m.md | 7 ++++++-
 docker-compose.yml                                             | 7 ++++++-
 2 files changed, 12 insertions(+), 2 deletions(-)        ← 仅 2 处既有未 staged 文件
```
（全部见 `30_drift_reverse_evidence.txt`）

✅ **两处断言同时变红、复原同时回绿；`periods.ts` 与 worker 交付逐字节一致（sha 相同 + `git diff` 空 + staged blob 不变）。**

> **附带 D1**：强证据在此暴露一个交付问题——`periods.test.ts` **不在 index**（`git cat-file -e :…` → `exists on disk, but not in the index`）。若以"仅提交 index"的方式落地，前端一半的防漂移断言会**丢失**。§5 证明后端 drift 测试仍读取该 `.ts` 字面量（跨层），故功能门禁未被击穿，但**交付清单不完整**。

---

## 5. ⑤ 测试有效性抽查（防"空断言"）—— **PASS**（附 D2）

### 5.1 `crates/web/tests/adr024_workbench_period_ssot.rs` —— **可证伪（非空断言）**

**扰动**：把 P0 删掉的硬编码白名单临时回填到 `crates/web/src/workbench.rs::submit_run`：

```
INSERT: if !matches!(req.period.as_str(), "M1" | "M5" | "M15" | "H1" | "D1") {
            return err(StatusCode::BAD_REQUEST, "period 须为 M1/M5/M15/H1/D1"); }

$ cargo test -p web --test adr024_workbench_period_ssot -- --nocapture
[证据] POST /api/workbench/runs period=M30  状态码 = 400（无库 ⇒ 预期 500 亦合规）body = {"error":"period 须为 M1/M5/M15/H1/D1"}
---- m30_passes_web_period_gate_not_400 stdout ----
assertion `left != right` failed: ADR-024 P0：period=M30 被 web 硬编码白名单 400 拒绝
  left: 400   right: 400
test web_source_has_no_hardcoded_period_whitelist ... FAILED
   panicked at …:172: crates/web/src/workbench.rs 仍含硬编码 period 白名单（双事实源回归）
test unknown_period_still_rejected_400 ... ok
test w1_still_rejected_400_with_period_message ... ok
test result: FAILED. 2 passed; 2 failed          RED_EXIT=101
```
**复原后**：
```
$ sha256sum crates/web/src/workbench.rs → 3490988814317445909b…（== 基线）
$ git diff -- crates/web/src/workbench.rs → （空）；$ git rev-parse :… → 6b21cb7e…（未变）
$ cargo test -p web --test adr024_workbench_period_ssot
test result: ok. 4 passed; 0 failed; 0 ignored      GREEN_EXIT=0
```
（`32_web_test_falsifiability.txt`）

**判读**：`assert_ne!(s, 400)` **不是恒真**（有 400 的对照分支 W1/M300 在同 harness 内确实产生 400，且回填旧白名单即红）；源码级反回归断言同样**可红**。✅

### 5.2 `crates/mcp/tests/adr024_period_ssot_drift.rs` —— **可证伪**

已由 §4 的独立扰动证明（2 failed → 复原 5 passed）。✅

### 5.3 `web/src/features/workbench/ConfigPanel.test.tsx` 的 M30 下拉断言 —— **⚠ D2（强绑定组件，但对 M30 成员资格恒真）**

代码事实（`ConfigPanel.test.tsx:44-49`）：
```tsx
it('周期下拉 = SUPPORTED_BACKTEST_PERIODS（含 M30）', () => {
  render(<ConfigPanel {...mkProps()} />);
  const sel = screen.getByTestId('wb-period') as HTMLSelectElement;
  expect([...sel.options].map((o) => o.value)).toEqual([...SUPPORTED_BACKTEST_PERIODS]);
});
```
**两侧同源**（组件与测试 import 同一常量）⇒ 结构性恒真风险。

**扰动 A（删常量里的 `'M30'`）⇒ 仍全绿**：
```
$ sed -i …（periods.ts 去掉 'M30'）
$ npx vitest run src/features/workbench/ConfigPanel.test.tsx
 ✓ src/features/workbench/ConfigPanel.test.tsx (13 tests) 702ms
 Test Files 1 passed (1)   Tests 13 passed (13)      VITEST_EXIT_A=0     ← **不敏感**
```
**扰动 B（改组件本身：下拉硬编码 `['M1','M5','M15','D1']`）⇒ 变红**：
```
 FAIL … > 周期下拉 = SUPPORTED_BACKTEST_PERIODS（含 M30）
AssertionError: … -"M30" -"H1"
 Test Files 1 failed (1)   Tests 1 failed | 12 passed (13)   VITEST_EXIT_B=1
```
**复原**：两文件 sha256 均回到基线（`04b540de…` / `6cebff6c…`）；`git diff --stat` 仅剩 2 处既有未 staged 文件。（`31_test_effectiveness.txt`）

**判读**：
- ✅ 该断言**确实绑定组件**（改组件即红）⇒ 它证明了 §5.1 要求的"下拉**派生自 SSOT**、不再手写第二份"；
- ⚠ 但它**无法**证明"下拉里有 M30"——删掉常量里的 M30 时它**恒绿**。M30 的**存在性**改由 `periods.test.ts`（常量 ↔ `contract-vectors.json`，§4 已证可红）+ 后端跨层 drift 断言（读同一 `.ts` 字面量）钉住。**链路不缺环，但该条测试的表述（"含 M30"）名不副实**。
- 建议（非本任务范围）：断言改为与**独立期望**（硬编码六档字面量或 `contract-vectors.json`）比对。

---

## 6. ④ 禁改项核验（客观断言，不看报告措辞）—— **PASS**

### 6.1 常数「值」未被改

```
$ git diff --cached -U0 -- crates/ | grep -E '^[-+].*(MINUTE_MAX_SPAN_DAYS|D1_MAX_SPAN_DAYS|MAX_BARS)'
(no +/- lines mentioning those constants)

$ grep -rn "const MINUTE_MAX_SPAN_DAYS\|const D1_MAX_SPAN_DAYS\|const MAX_BARS" crates/ --include=*.rs
crates/application/src/strategy.rs:61:pub const D1_MAX_SPAN_DAYS: i64 = 366 * 5;
crates/application/src/strategy.rs:62:pub const MINUTE_MAX_SPAN_DAYS: i64 = 93;
crates/application/src/workbench.rs:55:pub const MAX_BARS: usize = 200_000;
```

`crates/application/src/strategy.rs` **确实**在 staged 改动内，但完整 diff 显示仅**注释**与穷尽性文字变化（`+  // ADR-024 P0：M30 仍属分钟级档…`），**值行 `366 * 5` / `93` 原样未动**；`MAX_BARS` 文件（`crates/application/src/workbench.rs`）**完全不在 staged 清单内**。（`20b_constants_and_consistency.txt`）

### 6.2 禁改路径：staged diff 全空

```
$ git diff --cached -- crates/strategy-core          → (EMPTY)
$ git diff --cached -- crates/strategy-runtime       → (EMPTY)
$ git diff --cached -- crates/storage/src/workbench.rs   → (EMPTY)   ← 结果落库
$ git diff --cached -- docker-compose.yml            → (EMPTY)
$ git diff HEAD -- <同 4 条>  → 0 / 0 / 0 / 18 行
```
`docker-compose.yml` 的 18 行差异是**未 staged 的工作区改动**（ADR-025 的 `max_worker_processes=32` + 根因注释），与 P0 车道无关、**未被 stage**；worker 报告对此的声明属实（`20b_*` §20c 附其完整 diff）。

### 6.3 staged 清单与报告 §7 一致性

`git diff --cached --name-status` = 48 条（25 条 coder 证据/报告 + 23 条源码/文档/前端），与 worker 报告 §7 逐一吻合——**唯一例外是 §7 未列（且实际未 stage）的 `web/src/features/backtest/periods.test.ts`（D1）**。

---

## 7. 缺陷清单（逐条，均附原始输出）

### D1（中｜交付完整性）前端防漂移测试未入 index

```
$ git status --porcelain -- web/src/features/backtest/periods.test.ts
?? web/src/features/backtest/periods.test.ts
$ git ls-files --error-unmatch web/src/features/backtest/periods.test.ts
error: pathspec '…periods.test.ts' did not match any file(s) known to git   → 未被跟踪
$ git cat-file -e :web/src/features/backtest/periods.test.ts
fatal: path '…periods.test.ts' exists on disk, but not in the index          → **不在 staging**
$ ls -l --time-style=full-iso web/src/features/backtest/periods.test.ts
-rw-rw-r-- 1 eestock eestock 1846 2026-09-18 12:41:02 …periods.test.ts
```
同期 worker 报告：§3「前端断言：`web/src/features/backtest/periods.test.ts`（常量 == JSON 向量）」、§4 命令 #9/#10 用它取证、§7「交付清单（staged）」**未列该文件**（`grep -c periods.test.ts` = 5 次，均为正文/证据引用）。
**影响**：仅提交 index 时，`常量 ↔ contract-vectors.json` 的前端断言丢失（该测试当前确实在跑、也确实会红，见 §4）；后端 drift 测试仍跨层读该 `.ts`，故**门禁未被击穿**，但交付与报告声明不符。
**处置**：commit 前 `git add web/src/features/backtest/periods.test.ts`。

### D2（低｜测试强度）ConfigPanel 下拉断言对 M30 恒真

见 §5.3。**影响**：该条不能作为"M30 在下拉中"的证据（其断言的名称如此宣称）；M30 存在性仍被 `periods.test.ts` + 后端 drift 断言覆盖。
**处置**：断言改为独立期望；或在报告/测试名中限定其语义为"下拉派生自 SSOT"。

### 过程性事实 P1（非缺陷，须写入结论）现网 8081 原为 pre-P0 二进制

见 §1。**影响**：任何"M30 经 8081 验收"在重启前都不可能通过；worker §6 R1 的归因（"无测试库"）不完整。
**处置**：本车道已按技能重启上线；建议后续验收任务在开头加入 `strings /proc/<pid>/exe | grep <新符号>` 的形态断言。

---

## 8. 纪律与收尾合规

| 纪律 | 落实 |
|---|---|
| 不改生产代码 | 仅 ③⑤ 要求的**临时扰动**，全部在同一执行块内复原；每次均给 sha256 前后一致 + `git diff` 空 + staged blob 不变（`30_*`/`31_*`/`32_*`） |
| 不 `git add` / `commit` | 未执行任何 index 写操作；终态 `git diff --cached --stat` = 48 files, +1807/−56（与 worker 交付一致），`git diff --stat` 仅剩 2 处既有未 staged 文件（`15_*` §19） |
| 不新建数据库 | 库清单 BEFORE=AFTER=`{eestock, postgres}`（`00_*`/`06_*`） |
| 不修复失败 / 不做失败归因 | 失败仅登记 panic 原文与聚合统计（§3.1），未改动任何源文件以求绿 |
| ADR-025 D3 收尾 | run 删除 + **正向回读 0** + REST 404 + 库清单断言（`06_*`）；残留 run 总数 `strategy_run name LIKE 'ADR024-P0-verify-%' = 0` |
| 过程副作用（如实披露） | ① 8081/8082 pid 178558→**4083225**（二进制 `d6fed24e…`→`f4d07dcc…`）；② 回滚件 `/tmp/eestock-app.rollback.20260918_124734`（sha `d6fed24e…`，**未触发**）；③ `web/dist/**` 重建（gitignored）；④ `logs/app_dev_8081_redeploy_20260918_124734.log`（gitignored）；⑤ 生产库 1 行 `strategy_run`（级联 1 行 result）创建后已删除 |

---

## 9. 与 worker 报告（`coder/report/adr024_p0_m30.md`）的差异

| worker 声称 | 本轮独立核验 |
|---|---|
| §0/§6 R1：M30 真跑未取证，原因＝「无可用测试库（纪律禁止建库）」 | **不完整**：首因是**在线进程陈旧**（旧二进制无 M30，返回 400）；已按技能重启后**真跑 PASS**（§1/§2） |
| §3：前端 `periods.test.ts` 是防漂移断言之一 | **属实且可红**（§4 独立复现）——但该文件**未入 staging**（D1） |
| §3：反向证据（改前端常量 ⇒ Rust 与 TS 双红） | **独立复现成立**（§4） |
| §5：禁改项未触碰（含常数、引擎、落库、compose） | **客观断言成立**（§6） |
| §4 #11：`npx vitest run` 全量 850 passed | **复跑一致**：89 files / 850 passed（§3） |
| §4 #13：`cargo check --workspace --all-targets` 全绿 | **复跑一致**：`cargo check --all-targets` EXIT=0（§3） |
| §7：交付清单 | 与 `git diff --cached --name-status` **逐条吻合**；唯一遗漏即 D1 文件 |
| （未声称）测试强度 | 本轮发现 **D2**（ConfigPanel 下拉断言对 M30 恒真） |

---

## 10. 产物

| 类型 | 路径 |
|---|---|
| **报告（本文件，判词在最前）** | `tester/report/adr024_p0_m30_verification.md` |
| 执行记录 | `tester/test/298_adr024_p0_verification_execution.md` |
| 证据目录（30 个原始输出文件 + 索引） | `tester/evidence/246_adr024_p0_verify/`（索引 `EVIDENCE.md`） |
| 回滚件（未触发） | `/tmp/eestock-app.rollback.20260918_124734`（sha256 `d6fed24e…`） |
| 新进程日志（gitignored） | `logs/app_dev_8081_redeploy_20260918_124734.log` |

**本任务未新增永久测试文件**（故无 `tester/design/*` 交付）；未修改任何生产代码；未 `git add` / `git commit`。
