# D6 线上独立验收（tester / 只验不改）

- **本文件位置**：`tester/evidence/20260919_d6_live_verify/README.md`
- **原始输出目录**：`tester/evidence/20260919_d6_live_verify/raw/`
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `40d16e1`（工作区含未提交 D6 修复）
- **执行时间**：2026-09-19 16:37:48 → 16:41 CST（Asia/Shanghai），全程约 3 分钟（硬上限 25 分钟）
- **依据手册**：`/home/eestock/.pi/agent/projects-memory/eestock/skills/rebuild-restart-app-8081/SKILL.md`（重启口径按第 2/5/6 步）
- **上游部署证据**：`coder/evidence/20260919_d6_redeploy/`（本轮**先复核**新进程事实，再全部自行重取原始输出）
- **硬纪律**：未 `git add / commit / checkout / stash / reset`；**未改业务代码**（仅第 6 项授权的临时突变，且已逐字节还原）；DB 测试走 ADR-025 临时库并 DROP。探针脚本全部在 `/tmp/d6v/`，仓内零探针残留（唯一入仓文件为本证据包的 `.py` 对账脚本与 `.json`/`.txt` 原始输出）。

---

## 0. 裁决摘要

| # | 项 | 结果 |
|---|---|---|
| 1 | 二进制确为新的 | ✅ 新 PID **1217966**（16:40:12 启动）晚于 `policy.rs` mtime（16:33:57）、晚于二进制 mtime（16:35:59）；`grep -a -c 'Dca.interval 必须 ≥ 1（省略即为默认 1）'` = **1**（`/proc/<pid>/exe` 同 1）。注：题面给的 `strings \| grep -c` 口径为 **0**，因 `strings` 默认丢弃非 ASCII（中文）段，属口径问题而非缺陷（见 §1） |
| 2 | web 面 | ✅ `interval=0` → **400** `policy_invalid`（含 code，文案与契约一致）；省略 `interval` → **201** 且 config 回显（`policy={"Dca":{"amount":null,"mode":"Equal","tranches":2}}`，无 `interval` 字段） |
| 3 | 等价性（禁假绿） | ✅ A(省略) vs B(显式 1)：`reachable_batches` / `batches_done` / `deployed_notional` 及 `fills`、`trades` **逐字段全等**（唯一差异键 = `run_id`）；**负对照 C(显式 5) 与 A 明确不同**（batches_done 10 vs 11、fill bar 序列 1/1 间隔 vs 5 间隔）⇒ 该夹具**具有判别力**，非假绿 |
| 4 | 不回归 | ✅ `interval=5` 提交成功（201→succeeded），audit 与 k=5 语义一致（买入成交落在 bar 301/306/311/…，步长 5）；`cargo test -p strategy-core`（临时库 `tmp_d6live_1789807142`，已 DROP）**79 passed / 0 failed / 1 ignored**，EXIT=0 |
| 5 | MCP 面 | ✅ `bt_run_ensemble` + `interval=0` → `isError=true`，文本 `工具执行失败：Dca.interval 必须 ≥ 1（省略即为默认 1）`；省略 `interval` → 接受（返回 `run_id`）；显式 `interval=1` → 接受 |
| 6 | 突变反证 | ✅ 临时注掉校验（`if false && *interval == 0`）→ **2 条测试变红**（`dca_interval_zero_is_rejected_loudly`、`policy_validation`，34 passed/2 failed）；还原后 `sha256(policy.rs)=cec749d8…` 与突变前**逐字节相同**；重建二进制 `sha256=ead45c29…` 与突变前二进制**相同**；重启（pid 1217966，ERROR=0）后线上回到 **400** |
| 7 | 越界与门禁 | ✅ `./scripts/check-tangle.sh` EXIT=0（✅ 一致）；`git diff --cached` **空**（无 staged）；tracked 改动 4 个文件（3 个 D6 + 1 个**先存**的 ADR-023 记录，与本单无关，见 §7）；无 add/commit/checkout/stash/reset |

**VERDICT: PASS**

---

## 1. 二进制身份（`raw/10_step1_binary_identity.txt`）

```
ss -lntp：8081 → pid=1210738(fd=11)；8082 → pid=1210738(fd=12)        ← 复核时（部署者启动的新进程）
ps 1210738：STARTED Sat Sep 19 16:36:14 2026  ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
target/debug/eestock-app  mtime=2026-09-19 16:35:59.320782517 +0800  size=213324216
sha256 target/debug/eestock-app = ead45c291f632563524edbc14192adf843ecfb98660d5bce361012138cbb4d02
sha256 /proc/1210738/exe        = ead45c29…b4d02   （同源，无 (deleted)）
源码 mtime：policy.rs 16:33:57 < 二进制 16:35:59 < 进程启动 16:36:14   ← 启动晚于源码/二进制 mtime ✔

题面口径：strings target/debug/eestock-app | grep -c 'Dca.interval 必须'  → 0
          （原因：strings 默认只输出可打印 ASCII，中文段被截断；该 &str 常量前后无 ASCII 边界故整串不可见）
改用 UTF-8 感知：grep -a -c 'Dca.interval 必须 ≥ 1（省略即为默认 1）' target/debug/eestock-app → 1
                grep -a -o 'Dca.interval 必须[^"]\{0,40\}' → Dca.interval 必须 ≥ 1（省略即为默认 1）Dca.tranches 必须 ≥ 1…
                grep -a -c 'Dca.interval 必须 ≥ 1（省略即为默认 1）' /proc/1210738/exe → 1   （运行镜像同款）
```
⇒ 运行镜像确含 D6 文案；题面给的 `strings` 命令因编码口径返回 0，**额外以「400 行为 vs 旧版」交叉佐证**（末节的旧版基线取自 coder raw/01：旧二进制 `interval=0`→201、省略→400 `missing field`，与新镜像 400/201 恰好互斥；本轮 §2 的两条线上行为即新镜像的直接证据）。

## 2. web 面（`raw/11_web_interval0.txt`、`raw/12_web_submit_abc.txt`）

判据体（最小 body，`/tmp/d6v/body_*.json`，除 policy 外同一变量）：
`518880 / M5 / 2026-09-17T01:30:00Z→07:00:00Z / slots=[sv_1789013713975_000001 weight 1.0 params={fast:5,slow:20}] / warmup_bars=0 / confirm=true`

**① `interval=0` → 400（完整响应体）**
```http
POST /api/workbench/runs   HTTP/1.1
{"policy":{"Dca":{"tranches":2,"mode":"Equal","amount":null,"interval":0}}}
```
```json
{"error":{"code":"policy_invalid","detail":{"period":"M5"},"message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}
HTTP=400
```
→ 断⾔成立：400 + **结构化错误对象含 `code`**（`policy_invalid`）+ 文案含「Dca.interval / ≥ 1 / 默认 1」。

**② 省略 `interval` → 201 且 config 回显**
```json
{"id":"sr_1789807098104_000002","status":"queued","config":{…,"policy":{"Dca":{"amount":null,"mode":"Equal","tranches":2}},…}}
HTTP=201            （回显 = 请求原文：省略时快照内无 interval 字段）
```

## 3. 等价性 A/B（关键，`raw/41_equivalence_discriminative.txt`、`raw/42_equivalence_audit_diffkeys.txt`、`raw/43_reconcile_equivalence.py|_output.txt`）

判据体（三条 run 唯一变量 = `policy.Dca.interval`；`tranches=10 / mode=Equal`）：
`518880 / M5 / 2026-09-10→2026-09-17 / slot sv_1789211104755_000012 (定投·均线偏离分档) params={ma_n:60,dev_open:0.005,dev_deep:0.01,stop_dev:0.5,plan_bars:10} / buy=60 sell=40 / warmup_bars=250`

| run | id | interval | status | reachable_batches | batches_done | deployed_notional |
|---|---|---|---|---|---|---|
| A | `sr_1789807182072_000017` | 省略 | succeeded | **67** | **10** | **99950.0** |
| B | `sr_1789807182146_000018` | 显式 1 | succeeded | **67** | **10** | **99950.0** |
| C（负对照） | `sr_1789807182207_000019` | 显式 5 | succeeded | 67 | **11** | **99945.00000000001** |

对账脚本输出（`raw/43_reconcile_equivalence_output.txt`）：
```
A vs B  reachable_batches: 67 == 67 -> True
A vs B  batches_done: 10 == 10 -> True
A vs B  deployed_notional: 99950.0 == 99950.0 -> True
A vs B  deployed_pct: 0.9995 == 0.9995 -> True
A vs B  cash_consumed: 100000.0 == 100000.0 -> True
A vs B  planned_tranches: 10 == 10 -> True
A vs B  unexecuted_orders: 57 == 57 -> True
A vs B  last_bar_unfilled: False == False -> True
A vs B  fills field-wise equal: True
A vs B  trades field-wise equal: True
A vs B  audit differing keys: {'run_id'}          ← 唯一差异键
--- negative control (fixture discriminative?) ---
A vs C  batches_done: 10 vs 11 -> differ: True
A vs C  fills differ: True
fill bar_index A: [301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 548]
fill bar_index C: [301, 306, 311, 316, 321, 326, 331, 401, 406, 409, 432, 548]   ← 步长 5，与 k=5 语义一致
RESULT: PASS
```
`trades` 全量逐字段（A，`raw/41_E_OM_…_result.json`）：
```json
[{"open_bar":301,"open_price":8.906171314452099,"open_ts":1789090500,"close_bar":548,"close_price":8.8542288,
  "close_ts":1789628100,"hold_bars":247,"shares":11222.555290151508,"commission":74.84176806491296,
  "stamp_duty":0.0,"gross_value":99367.07225965183,"pnl":-657.7695084130974,"reason":"ForceClose"}]
```
B 的同结构记录与 A **逐字段相同**（`trades field-wise equal: True`）。

**方法学（重要，防假绿）**：最初用 coder 同款 49-bar 短窗夹具时，A(省略)/B(1)/C(5) 三者 audit 完全相同（`reachable_batches=1`）——该夹具**不具判别力**（`plan_bars` 窗口内的买入信号只落在单 bar，k 不参与）。故本轮另建上表的「持续买入区」夹具（`plan_bars=10` 连续 10 根 80 分），并以 **C 明确不同于 A** 作为**负对照**，证明 A==B 是「有判别力的相等」而非「恒等」。短窗夹具三 run 亦记录在 `raw/20_*`、`raw/40_*`（结论一致，仅作旁证）。

## 4. 不回归（`raw/40_*`、`raw/41_E_I5_*`、`raw/50_cargo_test_strategy_core.txt`）

1. **`interval=5` 提交成功且 audit 合理**：短窗夹具 `sr_1789807098205_000004` → 201/succeeded（`planned_tranches=2, reachable_batches=1, batches_done=1, deployed_notional=49998.68167930293`，与同夹具 omit/1 一致）；判别性夹具 `sr_1789807182207_000019` → 201/succeeded，`batches_done=11`，买入成交 bar = `[301,306,311,316,321,326,331,401,406,409,432]` **步长 5** ⇒ 计划推进数符合 k=5 预期。
2. **`cargo test -p strategy-core`（ADR-025 临时库）**：
```
临时库 tmp_d6live_1789807142（scripts/testdb-init.sh, init rc=0）→ 测试 → DROP DATABASE … WITH (FORCE)
test result 汇总：79 passed; 0 failed; 1 ignored（7 个测试二进制：lib 36、engine 26+1 ignored、observer 6、session 7、session_alloc 1、templates 3、doc 0）
CARGO_TEST_EXIT=0
teardown 后库清单：eestock / postgres / template0 / template1    ← 临时库已 DROP，无残留
```

## 5. MCP 面（`raw/30_mcp_probe.txt`，SSE + JSON-RPC over `:8082`）

```
## SSE endpoint /messages?sessionId=86bdf039aa786802b65534cbbd63bba6
## initialize ok（protocolVersion 2024-11-05）
## tools/list count= 35 has_bt_run_ensemble= True

### bt_run_ensemble policy.Dca.interval=0
RAW JSON-RPC RESP = {"id": 10, "jsonrpc": "2.0", "result": {"content": [{"text": "工具执行失败：Dca.interval 必须 ≥ 1（省略即为默认 1）", "type": "text"}], "isError": true}}
isError = True ; content[0].text 含「Dca.interval」「≥ 1」「默认 1」      ← 断⾔成立（**不要求** MCP 带 code：平台既有形状，已知并已登记 D5）

### bt_run_ensemble interval omitted
isError = None
PARSED run_id = sr_1789807279697_000001 | status = queued | config.policy = {"Dca": {"amount": null, "mode": "Equal", "tranches": 2}}

### bt_run_ensemble interval=1（对照）
isError = None
PARSED run_id = sr_1789807279753_000002 | status = queued | config.policy = {"Dca": {"amount": null, "interval": 1, "mode": "Equal", "tranches": 2}}
```
> 本节的 MCP 探针在**第 6 项重启之后**（新进程 pid 1217966 持有 :8082）重取，即 MCP 面证据同样出自「还原 + 重建后的二进制」。

## 6. 突变反证（`raw/60_mutation_red.txt`、`raw/61_restore_rebuild.txt`、`raw/62_restart_and_live.txt`、`raw/63_post_restart_live.txt`）

| 步骤 | 命令/结果 |
|---|---|
| 突变前基线 | `sha256 policy.rs = cec749d83b8bcbf1cfdd10a8780bd9ca881ef2df3144ef333ee93cb1956245c5`（备份 `/tmp/d6v/policy.rs.orig`，同 sha） |
| 临时注入 | `-                if *interval == 0 {` → `+                if false && *interval == 0 { // D6-MUTATION`（1 处；突变后 sha `b4617873…`） |
| 变红（定向） | `cargo test -p strategy-core --lib dca_interval` → `FAILED. 3 passed; 1 failed`（`dca_interval_zero_is_rejected_loudly`：`interval=0 必须被拒绝…`） |
| 变红（全 lib） | `cargo test -p strategy-core --lib` → `FAILED. 34 passed; **2 failed**`：`policy::tests::dca_interval_zero_is_rejected_loudly`、`policy::tests::policy_validation`（后者 `interval=0 必须拒绝（不再静默归一化为 1）`）⇒ **≥2 条变红 ✔** |
| 还原 | `cp /tmp/d6v/policy.rs.orig policy.rs`；`sha256 = cec749d8…` **与突变前逐字节相同**；`grep -c 'D6-MUTATION'` = **0**；`diff -q` = IDENTICAL |
| 重建 | `cargo build --bin eestock-app` → EXIT 0；`sha256 = ead45c29…b4d02` **与突变前二进制相同**（可复现构建 ⇒ 还原是逐字节的）；`grep -a -c` D6 文案 = 1 |
| 重启 | 门禁 `/api/sim-live/sessions`：total=12, **non_ended=0** → `kill -TERM 1210738`（~0.2s 退出，端口释放）→ `nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml &` → **新 pid 1217966**（8081+8082 双持），`/proc/1217966/exe` sha == 磁盘二进制 sha；启动日志 **ERROR=0**（16 行，含 6 行启动 INFO）；`healthz`=200 |
| 线上回到 400 | `interval=0` → **400** `{"error":{"code":"policy_invalid",…,"message":"Dca.interval 必须 ≥ 1（省略即为默认 1）"}}`；省略 `interval` → **201**（`sr_1789807223339_000000`, status=succeeded, 回显 policy 无 interval） |

**前后对照**：突变阶段仅影响测试二进制（线上进程持有旧 inode，从未被突变版本服务）；还原+重建后 sha 与突变前完全一致，重启后线上行为 = 400/201（与 §2 一致）。

## 7. 越界与门禁（`raw/70_check_tangle.txt`、`raw/71_git_state.txt`）

- `./scripts/check-tangle.sh` → `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。` **EXIT=0**
- `git diff --cached --stat` → **空**（无 staged 文件）；`git status --porcelain` tracked 改动：
```
 M crates/strategy-core/src/policy.rs                                ← D6
 M design/12-strategy-system/01-adr.md                               ← D6 契约同步
 M web/src/features/workbench/ConfigPanel.test.tsx                   ← D6 防回归用例
 M design/01-architecture/adr/ADR-023-period-set-extension-30m.md    ← **先存**（ADR-023 盘中观测闭环记录，非本单产出；本轮未触碰）
```
- 未跟踪但属 D6 的：`crates/application/tests/d6_dca_interval_serde.rs`、`crates/mcp/tests/d6_dca_interval.rs`、`crates/web/tests/d6_dca_interval.rs`（coder 新增用例，**未 staged**）、`coder/evidence/20260919_d6_*`、`tester/evidence/20260919_d6_*`。
- `git reflog -3` 顶层仍为 `40d16e1`；全程**无** add/commit/checkout/stash/reset。
- 探针均在 `/tmp/d6v/`（`mcp_probe.py`、`body_*.json`、`policy.rs.orig`、`run_strategy_core_tests.sh`），仓内无探针残留。

## 8. 残留不确定性（显式列出）

1. **题面 `strings | grep -c` 口径返回 0**（非缺陷）：D6 文案含中文，`strings` 默认丢弃非 ASCII 段。已改用 `grep -a`（UTF-8 感知）=1，并以线上 400/201 行为交叉佐证。若验收脚本硬编码 `strings`，会在任何含中文的 Rust 字符串上误报。
2. **等价性证据是「行为等价」而非「实现等价」**：live 层能证的只是「省略 ≡ 显式 1」的可观测输出全等（audit/fills/trades）。`interval` 在实际执行路径中的 k 语义由单测 `dca_interval_batch_counts_unchanged_for_1_5_20`（k=1/5/20 → 20/4/1 批）承担；本轮 live 亦以负对照 C(k=5) 证明该夹具对 k 敏感（成交 bar 步长 5）。
3. **未观察到的边界组合**：未覆盖 warmup 与 DCA 的交互、`mode=FixedAmount` 的 interval=0（web 面只测了 Equal；MCP/单测覆盖 FixedAmount 拒绝）、archived 版本重跑路径、以及前端 ConfigPanel 在**真实浏览器**中的拦截（本单前端改动为测试文件，未进 bundle，未做 E2E）。
4. **`interval=5` 的一条观测（仅登记，不作分析）**：判别性夹具中 `batches_done=11 > planned_tranches=10`（k=1 时为 10=10；成交 bar 含 311/331 等超出 `plan_bars=10` 窗口的 bar）。原始数据见 `raw/41_E_I5_*`。这是 interval≠1 的批次推进形态，**非 D6 触及的代码路径**（D6 只改 serde default 与 0 值校验），但若产品对「计划批次数上限」有硬约束，建议另行立案核对。
5. **本单前端防回归用例未执行**：`web/src/features/workbench/ConfigPanel.test.tsx` 的新用例需 `vitest`，本阶段未跑前端测试（未在验收范围内，且前端 bundle 未变）；未做浏览器渲染验证。
6. **线上进程为 debug 二进制 + `nohup` 包装**：与现网口径一致（手册要求），非生产形态；`pgrep -a eestock-app` 仅 1 行（无残留 shell）。

### 附：raw 文件索引

| 文件 | 内容 |
|---|---|
| `00_started.txt` / `01_mtimes.txt` | 时间戳与 mtime/进程启动时刻 |
| `10_step1_binary_identity.txt` | 二进制/进程/文案 判据（含 `strings` 口径说明） |
| `11_web_interval0.txt`、`12_web_submit_abc.txt` | web 面 400 全文 + 三条 201 提交 |
| `20_*`、`40_*`、`41_E_*` | 各 run 的 `/audit`、`/fills`、`/result` 原始 JSON（短窗夹具 + 判别性夹具） |
| `41_equivalence_discriminative.txt`、`42_equivalence_audit_diffkeys.txt` | 等价性 A/B/C 数字与字段级比对 |
| `43_reconcile_equivalence.py` / `_output.txt` | **对账脚本**与输出（可复跑） |
| `30_mcp_probe.txt` | MCP SSE 三条原始 JSON-RPC 响应 |
| `50_cargo_test_strategy_core.txt` | 临时库初始化 + `cargo test -p strategy-core` + DROP |
| `60_mutation_red.txt`、`61_restore_rebuild.txt` | 突变变红 2 条 + 逐字节还原 + 重建 sha |
| `62_restart_and_live.txt`、`63_post_restart_live.txt` | 重启门禁/新进程/日志 + 线上 400/201 复核 |
| `70_check_tangle.txt`、`71_git_state.txt` | 门禁与 git 状态 |
