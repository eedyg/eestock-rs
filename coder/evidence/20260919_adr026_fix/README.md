# ADR-026 整改批复验（R-G1 / R-G4 / R-G2 / R-G3）

- **本报告位置**：`coder/evidence/20260919_adr026_fix/README.md`（原始输出：同目录 `raw/`）
- **契约（冻结，只整改不改语义）**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`
- **上游（先读、复用其原始输出，不重跑已绿部分）**：
  - `tester/evidence/20260919_adr026_e2e_verify/README.md`（§1 判词 G1–G4、§11 裁决 FAIL(A7)）
  - `tester/evidence/20260919_adr026_backend_verify/README.md`
  - `coder/evidence/20260919_adr026_backend/README.md`、`coder/evidence/20260919_adr026_frontend/README.md`
- **基线**：`git rev-parse HEAD` = `e807385449a303a1090ac00a52c722b7b77e62ec`（本批**未** add/commit/checkout/stash/reset；`git diff --cached` 空、staged 文件数 = 0）
- **环境**：活库 `eestock`（127.0.0.1:5433，**只读**）；Web `:8081` + MCP `:8082`（PID 4160311，未重启）；前端 `web/dist` 被重建一次（静态托管刷新为新 bundle）
- **纪律**：未改引擎语义（`EngineExecutor`/`apply_sell`/`finish` 未触碰）、未改表结构、未新增迁移；需 DB 的测试全部走 ADR-025 临时库并已 `DROP … WITH (FORCE)`（§5）

## 0. 判词摘要

| 项 | 结论 | 关键读数 | 证据 |
|---|---|---|---|
| **R-G1** 新增套件并行 flake（必须修） | **PASS（确定性修复）** | 修复前：默认并行 **2/10 红**（tracing 捕获到并发用例 span，行 547）+ 根因确定性复现（跨用例 DELETE ⇒ 404/FK 23503）；修复后：目标套件默认并行 **15/15 绿**、`-p web --no-fail-fast` **5/5 绿（29 目标/173 用例）**、`--workspace --no-fail-fast` **3/3 绿（每次全新库，130 目标/895 用例）**；两项变异反证均红 | `raw/10*`、`raw/12`、`raw/20`、`raw/21`、`raw/22`、`raw/23`、`raw/61` |
| **R-G4** 口径措辞消歧（前端文案） | **PASS** | L1 →「成交合计 43 笔（含期末强平卖出 1 笔）…」，L2 →「…｜买入成交 42 笔｜…」（真库 run 真浏览器 DOM 原文）；E2E 7/7 绿、vitest 94 文件/916 用例绿、`tsc -b` exit 0；旧文案期望跑同一 bundle ⇒ **E2E 必红**（负面对照） | `raw/40`、`raw/41`、`raw/42`、`raw/43`、`raw/e2e/fix_10_baseline_trades_lines.json` |
| **R-G2** 既有红（阈值漂移） | **PASS** | 溯源：常量 `GUARD_CONFIRM_BARS=500_000` 由 ADR-024（commit `f2726da`，2026-09-18 用户「按推荐」修订）有意上移，并与 `contract-vectors.json::resource_guard.confirm_bars` 双向绑定 ⇒ **改测试资产**：夹具区间 `2021-01→2026-01`（292,092 bar）→ `2016-01→2027-01`（627,564 bar）；该目标 **4 passed / 0 failed** | `raw/30`、`raw/31`、`raw/32` |
| **R-G3** 跨目标共享库隔离 flake | **登记技术债（按派单「越界则登记」）** | 根因已钉死：owner 删除 symbol 但不删派生 cagg ⇒ 端点口径 `code not in symbols` 计到别人的残留；同一库连跑 **RUN1 绿 / RUN2 红**（rows=4）；归因实验证明新污染源 = `tester_p5_indep::t_p5_http_structured_error_shape`（留 6 行 raw 孤儿）；**未改任何 tester 资产** | `raw/50`、`raw/51`、`raw/52` |

---

## 1. R-G1 —— `crates/web/tests/adr026_run_audit.rs` 并行 flake 的确定性修复

### 1.1 修复前可观测的失败/flake 证据（复用 + 自采）

| # | 现象 | 原始输出 |
|---|---|---|
| ① | 上一轮（tester 阶段 4）：默认并行 **1/5 红**、串行 3/3 绿；端点套件在本阶段 4 次红 | `raw/12`[1] = `tester/evidence/…/raw/74_adr026_suite_flake_stats.txt` |
| ② | FK `23503`（`strategy_run_result` 外键违约，`run_id=sr_adr026_chunked_nofacts`「is not present in table strategy_run」） | `raw/12`[2] = `…/raw/71_reg_web_run1.txt:143` |
| ③ | **本批自采**：默认并行 ×10 ⇒ **2 红**（`audit_endpoint_emits_required_tracing_fields`） | `raw/10_prefix_flake_repro.txt` |
| ④ | **本批自采全量输出**：span 行命中**并发用例**的 run（`run_id=sr_1789752545741_000005`），断言在行 547 触发 | `raw/10b_prefix_flake_full_output.txt` |
| ⑤ | **根因确定性复现**：后台以 5ms 周期重放旧 `clean()` 的跨用例删除 `DELETE FROM strategy_run WHERE id LIKE 'sr_adr026%'` ⇒ 自造 run 被删，`/audit` 期望 200 实得 404（`运行不存在: sr_adr026_chunked_nofacts`）；与 ② 同源（同一 DELETETE 落在插入前=404 / 插入后=FK 23503） | `raw/10c_prefix_fk23503_rootcause_demo.txt` |

### 1.2 改动（单文件：`crates/web/tests/adr026_run_audit.rs`）

1. **夹具唯一化（隔离键）**：新增 `Fix { code, source, name_prefix, key }` + `fix(tag)`；唯一键 = **完整 pid**（跨进程）× **进程内原子自增 `FIX_SEQ`**（同进程并发用例）× tag。
   - `code` = `9<pid><seq:03>`（symbol 代码，纯数字）；`kline_accurate.source` = `adr026_<pid>_<seq>_<tag>`；strategy 名前缀同键；手工插入的 run id = `sr_<key>_<tag>`。
   - 每个用例**只读写自己造的行**（symbol/kline/strategy/run/result 全套私有）。
2. **删除跨用例删除**：`clean()` 去掉 `DELETE FROM strategy_run WHERE id LIKE 'sr_adr026%'`，只按本用例私有 `symbol`/名前缀清理（并保留 `storage::reader::ORPHAN_TABLES` 按 code 派生行清理）。
3. **「事实源缺失」场景改为自造行**：`audit_recorded_false_when_facts_are_missing` 用私有 id 插一条 run +一条 `chunked_v1` 结果行（无任何分块 ⇒ `per_bar`/`fills` 均不可得），断言 `recorded=false`/零值/`warnings=[]`，收尾只删自己这两行（`strategy_run_result` ON DELETE CASCADE）；**不再依赖「删掉别的 run」**。404 语义的 queued 行同样改为私有 id。
4. **tracing 断言改为 scoped 订阅器 + 唯一 run_id 过滤**（本项是 flake 的主因，见 §1.4）：
   - 装**全局**「interest-only」空订阅器（`InterestOnly`：`register_callsite → Interest::always()`，`enabled=false`，`new_span/event` 为 no-op）⇒ **任意线程**首次命中调用点都拿到 `always`，不会因并发用例线程的默认 `NoSubscriber` 把调用点**永久缓存成 never**；随后 `tracing::callsite::rebuild_interest_cache()` 把此前已被缓存成 `never` 的调用点抬起来。
   - 实际捕获用**线程本地** scoped 订阅器（`tracing::dispatcher::set_default`）：`#[tokio::test]` 默认 current-thread runtime ⇒ 本用例的 axum 任务与客户端同线程，端点 span/event 只进本缓冲区；并发用例的 span 进全局 no-op 订阅器，**不可能互相捕获**。
   - 断言按 `run_id={本用例 run}` 过滤 span/event，并新增**硬断言**：捕获到的 `workbench_run_audit` 行里**不得出现异己 run_id**（把「不互相捕获」变成可失败断言）。
   - 去掉原先的 `tokio::time::sleep(50ms)`（span/event 在 handler 内同步写入，无需等待；未新增任何 sleep）。

### 1.3 修复后证据（原始输出）

| 口径 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 目标套件默认并行 ×15 | `cargo test -p web --test adr026_run_audit` | **15/15 绿**（每次 `4 passed; 0 failed`，~0.7s） | `raw/20_postfix_adr026_parallel_x5.txt` |
| 全 web 套件默认并行 ×5 | `cargo test -p web --no-fail-fast`（**每次全新 ADR-025 临时库**） | **5/5 绿**：29 目标 / 173 用例 / 0 failed，每次 ~40s | `raw/21_postfix_web_suite_parallel_x5.txt` |
| 全 workspace ×3（仓内惯例） | `cargo test --workspace --no-fail-fast`（每次全新库 + 先校验哨兵表） | **3/3 绿**：130 目标 / 895 用例 / 0 failed，每次 ~84s | `raw/61_workspace_nofailfast_freshdb_x3.txt` |

> 说明：`raw/60_workspace_nofailfast_x3.txt` 为一次废弃尝试（RUN1 临时库名构造有误 ⇒ 哨兵表缺失、42 目标瞬时失败），已在文件头标注作废；其 RUN2/RUN3（同库连续跑）另有意义：见 §4 G3。

### 1.4 flake 的根因（本批新查明，值得留档）

`tracing` 的每个调用点（callsite）把 `Interest` **全局缓存**，且首次命中时的取值取决于**命中线程**当时的默认 dispatcher：

- 旧实现把 `CaptureSubscriber` 用 `set_global_default` 装成全局订阅器 ⇒ 会捕获并发用例的 span（行 547 的原始失败）；
- 改成「只用线程本地 scoped 订阅器」后仍有残余 flake：若调用点首次命中发生在**并发用例的线程**上（该线程默认 = 全局 `NoSubscriber`），会被缓存成 `Interest::never`；此后本用例即使装了 scoped 订阅器，宏也会在 `interest.is_never()` 处短路 ⇒ span **根本不创建**。
  - 实测形态：span 拿到、event 拿不到（因为 span 调用点在本次请求上完成注册 → 得 `always`，而 event 调用点被**另一线程**在 `rebuild_interest_cache()` 之后注册 → 得 `never`）；或拿到别人 run 的 span。
  - 修法即上述「全局 interest-only（always、不记录）+ `rebuild_interest_cache()` + 线程本地捕获 + run_id 过滤」，三者缺一仍可复现（见变异反证）。

### 1.5 变异/负面对照（证明断言非恒真）

| 变异 | 期望 | 实测 | 证据 |
|---|---|---|---|
| **M1**：夹具唯一键退化为「所有用例共用同一 code」 | 隔离失效 ⇒ 必红 | 第 1 次即红：`reachable_batches 须 = per_bar 的 Buy 意图数` 断言失败（并发用例互删行） | `raw/22_mutation_shared_code_RED.txt` |
| **M2**：把「捕获的 span/event 必须属于本用例 run」的期望改成不存在的 run id | 断言必红（证明确在检查捕获数据） | 红，并打印实际捕获到的 2 条（span+event）本用例 run_id | `raw/23_mutation_trace_expectation_RED.txt` |

两处变异均已逐字节还原（`sha256` 见 §6：`adr026_run_audit.rs` = `e9337ea4…`）。

---

## 2. R-G4 —— 摘要口径措辞消歧（前端一行文案 + 同步断言）

### 2.1 修复前（真浏览器基线文案，复用上一轮）

```
L1: 成交 43 笔（逐笔源 /fills）｜回合 1 条（其中强平合成 1 条）｜名义投入 41.40%（分母 = 初始资金）
L2: 现金消耗（含佣金）41.61%｜计划批数 100｜可达轮次 43｜已成交 42｜未执行挂单 1（末根 bar 无次 bar 可执行）
```
引用：`raw/12`[4] = `tester/evidence/…/raw/e2e/base_10_baseline_trades_lines.json`（L1 的 43 = 42 买入 + 1 期末强平卖出；L2 的 42 = 审计 `batches_done`，两者口径不同、极易误读）。

### 2.2 改动

| 文件 | 改动 |
|---|---|
| `web/src/features/workbench/ResultView.tsx` | L1：`成交 N 笔（逐笔源 /fills）` → **`成交合计 N 笔（含期末强平卖出 K 笔）`**（N = `/fills` total，K = 审计 `round_trips_force_closed`）；未记录的形态 → `成交合计 未记录（/fills 事实源缺失）`。L2：`已成交 M` → **`买入成交 M 笔`**（M = 审计 `batches_done`）。**数字全部来自接口响应，无硬编码**；`AuditSummary` 头注释补「口径消歧」段（说明 N = M + K 的实例分解）。 |
| `web/src/features/workbench/ResultView.test.tsx` | 同步 L1/L2 断言：`成交合计 ${fills.total} 笔（含期末强平卖出 ${AUDIT_BASELINE.round_trips_force_closed} 笔）`、`买入成交 ${AUDIT_BASELINE.batches_done} 笔`、并断言**不含**旧串 `已成交 42`；`/fills` 未记录用例改断言 `成交合计 未记录（/fills 事实源缺失）`。 |
| `web/e2e/adr026-audit.e2e.ts`（tester 资产，**同步**） | 基线断言集合 `summaryMismatches()` 的 L1/L2 两行期望同步新文案（否则 E2E 会因文案变更而假红）；`90_mutation_deployed` 的变异后断言 `已成交 7` → `买入成交 7 笔`。 |

### 2.3 修复后证据（真浏览器 + 真库）

- 重建 `web/dist`（新 bundle `index-CkI-1t1L.js`，sha256 `4967c508…`），`:8081` 静态托管随之引用新 bundle（`GET /backtest-workbench` 的 `index-*.js` = `index-CkI-1t1L.js`）。
- 真浏览器 E2E（Playwright/Chromium，真库 run `sr_1789738328788_000005`，`--retries=0`）：**7 passed**（exit 0）——`raw/41_rg4_e2e_new_text_GREEN.txt`。
- 真库 DOM 原文（`raw/e2e/fix_10_baseline_trades_lines.json`）：
  ```
  L1: 成交合计 43 笔（含期末强平卖出 1 笔）｜回合 1 条（其中强平合成 1 条）｜名义投入 41.40%（分母 = 初始资金）
  L2: 现金消耗（含佣金）41.61%｜计划批数 100｜可达轮次 43｜买入成交 42 笔｜未执行挂单 1（末根 bar 无次 bar 可执行）
  ```
  （43 = 42 买入 + 1 期末强平卖出，两个数**分别命名**、可自洽复核；与审计响应逐字段一致。）
- 前端单测：`npx vitest run` → **94 文件 / 916 用例全绿**（`raw/42_frontend_vitest.txt`）；`npx tsc -b` → **exit 0**（`raw/43_frontend_tsc.txt`）。
- **负面对照（禁假绿）**：把 E2E 的两行期望**改回旧文案**、其余不动，跑同一入口 ⇒ **2 failed / 5 passed**，失败信息逐字打印新文案（`L1 成交合计（/fills 全口径）= 43 笔（含期末强平卖出 1 笔）‖ 成交合计 43 笔（含期末强平卖出 1 笔）…`）⇒ 断言确实绑在新文案与真实 DOM 上：`raw/40_rg4_e2e_old_expectation_RED.txt`。

> 未改动、需主代理知悉：服务端合成的 warning 文案（`DCA_PLAN_UNDERFILLED` → 「…、已成交 42 批（…）」）仍用「已成交」，它是 **ADR-026 §2.2 冻结的 message 示例**（服务端按当时 `deployed_pct` 合成下发），不在 R-G4 的 L1/L2 范围内，未改。

---

## 3. R-G2 —— `tester_p5rect_verify::t_n1_http_every_400_is_structured_object` 既有红（阈值漂移）

### 3.1 溯源（是否某 ADR 的有意变更 → **是**，且有双向绑定）

| 证据 | 内容 |
|---|---|
| 常量出处 | `crates/application/src/error.rs:150  pub const GUARD_CONFIRM_BARS: usize = 500_000;`（注释即「2026-09-18 用户『按推荐』修订：由 `200_000` 提到 500_000（≈M1 五年）」） |
| 变更提交 | `git log -S "500_000" -- crates/application/src/error.rs` → **`f2726da feat(adr024): 回测区间上限重构 + 引擎线性化 + 结果分块存储 + 结果页取数 + M30`**（本批动手前 HEAD 的最近功能提交之一；`crates/application/src/error.rs` 在本批工作树内**无改动**） |
| 契约向量（冻结另一侧） | `design/16-backtest-scalability/contract-vectors.json::resource_guard = {"max_bars_guard":2000000,"confirm_bars":500000,"note":"ADR-024 D1 修订（2026-09-18 用户「按推荐」）：confirm 阈值由 200000 提到 500000…"} ` |
| 双向绑定测试（既有绿） | `crates/application/tests/resource_guard_contract_vectors.rs`（常量↔向量）；`crates/web/tests/tester_p5_indep.rs:349` 亦已重钉为 `500_000`（tester 上一轮自述 §4.3/§5.3） |
| tester 自述 | `tester/report/adr024_p4b_fix_verification.md` §5.3：唯一红 = 本测试，「**阈值漂移，非回归**」，已因果证明（临时改回 200_000 ⇒ 该文件 4 passed），并建议「把该行区间换成 ≥50 万 bar」 |

⇒ 结论：常量变更**有据、有意、与契约向量一致**，可疑性不成立；红的是**未同步的测试资产**。

### 3.2 修复前证据

```
thread 't_n1_http_every_400_is_structured_object' panicked at crates/web/tests/tester_p5rect_verify.rs:137:5:
assertion `left == right` failed: [runs/resource_guard(confirm=false)] 期望 400，实得 201；
  body={… "estimated_bars":292092, "status":"queued", …}
```
`raw/30_rg2_prefix_RED.txt`（本批自采复现，与 tester F5/§5.3 同现象）。

### 3.3 改动（只改测试资产 `crates/web/tests/tester_p5rect_verify.rs`）

1. 新增模块级夹具常量（含溯源注释）：
   `GUARD_TRIGGER_FROM = "2016-01-01T00:00:00Z"`、`GUARD_TRIGGER_TO = "2027-01-01T00:00:00Z"` ⇒ 518880 M1 **627,564 bar**（临时库实测），落在 `[GUARD_CONFIRM_BARS=500_000, MAX_BARS_GUARD=2_000_000]`。
2. 表驱动中两条 `resource_guard(confirm=false)` 用例（提交路径 `POST /api/workbench/runs`、试算路径 `POST /api/strategies/test-run`）区间由 `2021-01→2026-01`（292,092 bar，< 阈值 ⇒ 放行）改为上述区间 ⇒ **真的触发二次确认**后再断言 400 结构化对象。
3. `confirm=true` 两例同步换到同区间，并新增断言 `estimated_bars`/`bar_count` **必须落在 `[GUARD_CONFIRM_BARS, MAX_BARS_GUARD]`**——否则「confirm=true ⇒ 放行」会退化成「本就无需确认」的空放行（旧的 292,092 bar 区间在阈值上移后正是这种空放行）。

### 3.4 修复后证据

```
running 4 tests
test t_n1_frontend_code_map_covers_backend_codes ... ok
test t_n1_static_audit ... ok
test t_n3_long_d1_accepted_and_no_intersection_range_empty ... ok
test t_n1_http_every_400_is_structured_object ... ok
test result: ok. 4 passed; 0 failed; … finished in 17.89s
```
`raw/32_rg2_postfix_GREEN.txt`（`real 0m18.5s`；耗时升来自 627k bar 的试算/提交夹具，相对旧 4.3s 增约 14s，属夹具口径必然成本）。

**双向对照**：同一命令在只改夹具区间前后由 **RED → GREEN**（其它代码未动）⇒ 修复与阈值语义一致；且新断言自带「区间必须 ≥ 阈值」自检，防再次漂移后静默变空。

---

## 4. R-G3 —— 跨目标共享库隔离 flake（`orphan_detect_endpoint_red::r1_*`）

### 4.1 现象与复现概率（本批自采）

```
同一临时库连续跑 cargo test -p web --no-fail-fast：
RUN1: 29 目标全绿；跑完库内 raw 孤儿 = {836448}（cagg 孤儿 = ∅）⇒ r1 仍绿
RUN2: r1 FAILED（rows=4）；跑完库内 raw 孤儿 = {836448, 837934}，**cagg 孤儿 = {836448}（kline_accurate_1w/1mo 各 1 行）**
```
`raw/52_g3_same_db_twice_web_suite.txt`。另在 `--workspace --no-fail-fast` 同库连续跑中 **2/3 红**（`raw/60_workspace_nofailfast_x3.txt` RUN2/RUN3）；**每次全新库时 0 次红**（`raw/61` 3/3、`raw/50` 1/1）。上一轮 tester 的隔离实验（全新库 → orphan 单跑 → adr026 单跑 → orphan 再跑全绿）亦证明**与 ADR-026 代码无关**。

### 4.2 归因（本批逐目标实验）

`raw/51_g3_attribution_per_target.txt`：在**同一**临时库上按目标顺序单跑并每次查孤儿 ⇒ 只有 `tester_p5_indep` 使 raw 孤儿由 0 → 6（后续目标只是继承）。进一步定位到该文件唯一「真库播种 + 只删 symbol」的用例：

```
crates/web/tests/tester_p5_indep.rs::t_p5_http_structured_error_shape（:590）
  seed_symbol_and_m1(&pool, &code, 6)            // 播 6 根 M1（code = 83<pid%10000>，source='tushare'）
  …
  DELETE FROM strategy_run WHERE symbol = $1     // 收尾只删 run
  DELETE FROM symbols      WHERE code   = $1     // 与 symbol，**不删 kline_accurate、不删派生 cagg**
```
⇒ 残留 6 行 raw +（被任何一次 1w/1mo 宽窗 `refresh_continuous_aggregate`，例如 `api_kline_period` 的刷新）物化的 **cagg 行**；端点口径（ADR-023 §6.3 冻结：`cagg 行的 code not in symbols`）如实计到 ⇒ `r1` 断言 `rows == 0` 在共享库上假红。

### 4.3 处置决定：**登记技术债，不动其它 lane 的资产**

派单允许的两种「≤10 行」修法在本例均不成立，理由（写清以免下轮再试）：

1. **在测试查询里加 source/watermark 过滤** —— 不可行：端点的孤儿谓词被 `orphan_detect_endpoint_red::r2` 钉死为「全仓 `crates/*/src` 恰一处定义、覆盖 10 张 cagg、谓词 = `code not in (select code from symbols)`」，且 ADR-023 §6.3 冻结检测式语义；过滤 = 改契约/改端点语义（本次禁止）。
2. **让写入方清干净自己** —— 单点修复不消除不确定性：`tester_p5_indep` 只是**已确认的一个** owner；物化 cagg 的刷新可能由**别的**测试的宽窗 refresh 触发（`api_kline_period` 对 `kline_accurate_1w/1mo` 刷新），因此必须**所有**播 kline 的测试（≥4 个文件、tester/worker 各自资产）都补 `ORPHAN_TABLES` 按 code 清理 —— 超「≤10 行」预算且跨 lane 授权（与上一轮 tester 报告 §5.3 的边界处理一致）。
3. 也不采用「在 r1 里先删孤儿再断言 0」：那会把 ADR-023 §6.3 缺陷类的红线断言变成恒真（假绿），且会删掉别人留下的行（正是 G1 已判定的反模式）。

**建议修法（供主代理裁量，建议单独立项）**：在 `crates/test-support` 提供 `cleanup_kline_fixture(pool, code)`（删 `kline_accurate` + 遍历 `storage::reader::ORPHAN_TABLES` 按 code 删 cagg），所有「真库播种」测试的收尾统一调用；或给 orphan 检测类测试固定使用**专用一次性库**（`--test-threads=1` 或独立 DB），把「共享库无孤儿」从隐含前提变成显式前置条件。

**本批不动**：`tester_p5_indep.rs`、`api_workbench.rs`、`api_kline_period.rs` 等一律未改（`git status` 可见），G3 结论为**技术债**，不影响 R-G1/R-G2/R-G4 的验收（每次全新库 3/3 全绿）。

---

## 5. 环境与 DB（含 teardown）

- **ADR-025 临时库**（`EESTOCK_TEST_DB_NAME=tmp_<lane>_<ts> scripts/testdb-init.sh`）：本批复用/新建共 `tmp_g1_1789752501`、`tmp_g3_1789754000`、`tmp_g3b_1789754127`、`tmp_ws_1789753699`，以及 5 个 `tmp_web*`、3 个 `tmp_wf*`（每次全新库，跑完即 `DROP … WITH (FORCE)`）。
- **teardown 回读**（`raw/71_db_teardown.txt`）：
  ```
  teardown 前：eestock / tmp_g1_1789752501 / tmp_g3_1789754000 / tmp_g3b_1789754127 / tmp_ws_1789753699
  DROP DATABASE IF EXISTS … WITH (FORCE)  ×4 → DROP DATABASE
  teardown 后（排除 Postgres 内建 template0/template1）：eestock, postgres
  tmp_% 计数 = 0
  ```
- **活库解析**：`eestock` 全程只读（无写入；G3 实验中也只对临时库做清理性写入）。本批为定位 G3 曾在 `tmp_g1` 上建过一次性 `BEFORE DELETE` 审计触发器（`_del_log`），该库已 `DROP` ⇒ 无残留。
- **在线进程**：未重启（PID 4160311 未动）；`web/dist` 重建一次（前端整改），`:8081/backtest-workbench` 现引用 `index-CkI-1t1L.js`。

---

## 6. 变更文件与 sha256（本批）

| 文件 | 修复前 sha256 | 修复后 sha256 | 角色 |
|---|---|---|---|
| `crates/web/tests/adr026_run_audit.rs` | `fe974d7a5d950b32eee7ab4d41fa524edf3f03c34427b0978018de917207a86e`（coder 阶段 2 交付所载） | `e9337ea4fcd5a367443c30170f2d32ce42b63cf2af9b9ebf267a994934809e6b` | R-G1 |
| `crates/web/tests/tester_p5rect_verify.rs` | `18119a46ad32ebbbb165cac0e0afea22e135c6b94dc2ace499ff58eb8a874b2c`（= HEAD 版，tester §5.3 所载） | `8dfe5fe0c9d1e525ddddf1c26f2c1cc587b67553f152add8469d5c3135472f5e` | R-G2 |
| `web/src/features/workbench/ResultView.tsx` | `1226b2e7a3acc62679533fe21f9f9e2793af0268089741b967bcab66492ba446`（阶段 3 交付所载） | `46eb787e586aaf99e1d2f3ecdfe1c269531675bea8216bb29da99eeae1eeac4a` | R-G4 |
| `web/src/features/workbench/ResultView.test.tsx` | `089788b0d952aba0f463965d9124c1893e2f979449bcd3dd983bb6e0d90e4ab1`（阶段 3 交付所载） | `7cf2ba781b4e46f4dbca9eedf2d8d5abc810d32515dc62d5b01354a4e3b72454` | R-G4 |
| `web/e2e/adr026-audit.e2e.ts` | `b8aaee0e6c5da0de0e2637054bd87ebaa678840877f206e2ce73fd2bc4988219`（tester 阶段 4 所载） | `f9b855819b5984d6ced4ae08174e875350bf9ba0a66093a3136b37324224d756` | R-G4 同步 |
| `web/dist/assets/index-CkI-1t1L.js`（gitignore 产物） | （旧 `index-CxpxqtmC.js`） | `4967c508e507cc2361620b74c56ed6a93cfa293df5a69fd5f64d71b71c437726` | R-G4 构建产物 |

清单原文：`raw/70_changed_files_sha256.txt`。**staged 文件数 = 0**（未 `git add`/`commit`/`checkout`/`stash`/`reset`）。

---

## 7. 自行取舍清单（写清我的判断，供主代理裁量）

1. **G3 不修**：派单允许的 ≤10 行修法在本例不成立（端点谓词被契约钉死、owner 多文件跨 lane），且任何「先删孤儿再断言 0」都会制造假绿 ⇒ 登记技术债并给建议修法（§4.3）。
2. **R-G4 的 K 取 `round_trips_force_closed`（审计响应）而非前端数 `/fills` 里的 Sell 笔数**：两者在实例 run 上同为 1；取审计值可与同行的「其中强平合成 K 条」自洽，且满足「数字来自响应、不硬编码」；`/fills` 可能分页/截断时也不会自相矛盾。
3. **同步改了 tester 的 E2E 资产**：R-G4 改文案后，tester 的 `web/e2e/adr026-audit.e2e.ts` 若不改会假红（文案断言），已在报告显式登记该跨 lane 改动与新旧 sha256。
4. **R-G2 顺带修强 `confirm=true` 两例**（换到触发阈值的区间 + 断言 `estimated_bars/bar_count` 落在 `[500k, 2M]`）：否则它们在阈值上移后退化为空放行；代价是该目标耗时 4.3s → 18s。
5. **R-G1 的 tracing 修法采用「全局 interest-only + scoped 捕获」**：这是唯一在并发下确定性的组合（只用 scoped 会因 tracing 的全局 callsite-interest 缓存在并行下间歇性不创建 span，本批已复现并定位）；全局订阅器 `enabled=false`、不记录任何东西，捕获仍在本线程，且断言按 run_id 过滤 + 禁止异己 run_id。
6. **未重启在线应用**：本批唯一影响运行时的改动是前端文案，已重建 `dist` 并经真浏览器 E2E 验证；后端二进制未变（未重启）：无需冒重启风险。
7. **残留不确定性**：`vite` 构建产物文件名随内容变化（`index-CkI-1t1L.js`）；若后续再改前端需再构建，E2E 依赖 `:8081` 提供最新 bundle。
