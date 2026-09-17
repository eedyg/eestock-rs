# 292 —— ADR-023 E6a 第一刀 证据链归档 · 汇总执行报告

- 本文件：`tester/test/292_adr023_e6a_acceptance_execution.md`
- 证据根目录：`tester/evidence/adr023_e6a/`（索引见 `tester/evidence/adr023_e6a/README.md`）
- 报告性质：**汇总归档 report**。本 agent **未新增也未改写任何测试**；只做
  ① 从 /tmp 搬运关键文本证据、② 逐条复算归档件里的硬读数、③ 写本汇总与残留登记。
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- 交付物提交：`fb5a7a64442c43cde446538d1019965712a676cd`（2026-09-17 09:37:45 +0800）
  提交标题：`fix(test,storage,diagnose): 孤儿行止血第一刀 —— clean() 删完即重算 + 孤儿检测端点 + 测试禁全量刷（ADR-023 E6a）`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §6.1 第 8 条（测试隔离债）与 §6.3 第 12 条（R1 生产 cagg 孤儿）
- 归档时间（UTC）：2026-09-17T02:2xZ
- 纪律遵守：**未**改 `design/**`、实现代码、既有测试文件；**未** `git add/commit/stash`；**未**重启/杀在线 app（PID 178558）；
  **未**对活库 `eestock` 发任何写语句（归档期只做文件读取/复制 + `git show/ls-tree` 只读 + 无 SQL）。仅新增 `tester/` 下文件。

> **口径前置声明（重要）**：三段证据（红 / 实现 / 独立验收）**全部**是在
> HEAD = `d3c2092ff34af5edd117f877d547b393c5080e50` 的**未提交工作区**上产生的
> （见 `tester/evidence/adr023_e6a/red/runs/final_checks.log`、`impl/V6_side_effects.txt`、
> `verify/logs/11_a7_post_test.log` 均记 `HEAD=d3c2092…`）；提交 `fb5a7a6` 于三段全部结束**之后**打上。
> 因此本证据链证明的是「被提交的那份工作区内容」，**不是**「提交后重跑绿」。提交后**未再重跑**全套。

---

## 0. 三段总览

| 段 | 角色 | 原始（易失）目录 | 归档子目录 | 段内自评 |
|---|---|---|---|---|
| 红 | 判据先行（Tester 设计 + 红执行） | `/tmp/adr023-e6a-red-20260917T010800Z/`（128 K / 26 文件） | `tester/evidence/adr023_e6a/red/`（26 文件，**全量收**） | — |
| 实现自证 | 实现方交付后自证（coder） | `/tmp/adr023-e6a-impl-20260917T011303Z/`（196 K / 25 文件） | `tester/evidence/adr023_e6a/impl/`（25 文件，**全量收**） | — |
| 独立验收 | 独立验收方只验不改 | `/tmp/adr023-e6a-verify-20260917-013013/`（23 M / 1535 文件） | `tester/evidence/adr023_e6a/verify/`（35 文件，**关键件收 + 差额登记**） | `VERDICT: PASS`（原文见 `verify/EVIDENCE.md:11`） |

**证据是否丢失的结论**：**没有丢失**。三个 `/tmp` 源目录**均未被清理，均实际存在**（`ls -d /tmp/adr023-e6a-*` 返回三个目录）。
本 agent 对已归档的 86 个文件逐个 `cmp` 与原始件比对 ⇒ **全部字节一致**（0 处差异）；
红/impl 两段为 26/26、25/25 **全量覆盖**；verify 段的未收项只有**编译产物 `r2harness/r2_harness`（4.3 M ELF）与 `mut/*` 的 6 棵整树副本（19 M）**，
且该两项的**判据承载内容**已由 `verify/logs/15_a3_mutations.log`（变异结论）与 `verify/mut/MUTANTS.diff`（变异体逐字差分）替代保留（取舍明细见 `tester/evidence/adr023_e6a/README.md`）。

---

## 1. 红阶段（判据先行）

来源：`tester/evidence/adr023_e6a/red/`（原 `/tmp/adr023-e6a-red-20260917T010800Z/`）

### 1.1 R1/R2/R4(a)/R5 —— 端点红测试

- **判据**：`cargo test -p web --test orphan_detect_endpoint_red` 必须**红**（端点不存在、检测 SQL 无单一定义、四个 clean 无重算、存在 `NULL,NULL` 全量刷）。
- **结论**：**红，4/4 失败**。
- **关键原始读数**（逐字取自 `red/runs/rust_endpoint_red.log`）：

```
test r4a_clean_functions_refresh_affected_cagg_windows ... FAILED
test r5_no_full_range_refresh_in_test_sources ... FAILED
test r1_orphan_endpoint_exists_and_reports_zero_on_clean_db ... FAILED
test r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint ... FAILED
...
test result: FAILED. 0 passed; 4 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
error: test failed, to rerun pass `-p web --test orphan_detect_endpoint_red`
```

四条 panic 原文（同文件）：

```
R1: GET /api/quality/orphans 必须存在并返回 200（当前实现缺失 ⇒ 404）   left: 404 / right: 200
R2: 检测 SQL 必须在 crates/*/src 下**恰有一处**可复用定义（当前 0 处：[]） left: 0 / right: 1
R4(a) 结构判据未达成: 4 个清理函数「无 refresh_continuous_aggregate ⇒ 只删不重算（孤儿根因）」
     （api_kline_period.rs::clean / api_rest.rs::clean_kline / api_rest.rs::clean_sym / kline_reader.rs::clean）
R5 refresh 调用点计数 = 24；NULL,NULL 违规点 = ["crates/web/tests/api_rest.rs:151"]
```

R5 的 shell 复核（`red/runs/r5_grep_evidence.log`）逐字：

```
$ grep -rn "refresh_continuous_aggregate" crates/*/tests | wc -l
24
$ grep -rn "refresh_continuous_aggregate([^)]*NULL, NULL" crates/*/tests
crates/web/tests/api_rest.rs:151:    sqlx::query("CALL refresh_continuous_aggregate('kline_5m', NULL, NULL)")
```

### 1.2 R2 符号契约 —— 编译期红

- **判据**：`cargo test -p web --test orphan_detect_sql_constant_red` 必须**红**（`ORPHAN_ROWS_SQL`/`ORPHAN_TABLES` 尚不存在）。
- **结论**：**红（编译失败 E0432）**。
- **关键原始读数**（逐字取自 `red/runs/rust_sql_constant_red.log`）：

```
error[E0432]: unresolved imports `diagnose::quality::ORPHAN_ROWS_SQL`, `diagnose::quality::ORPHAN_TABLES`
  --> crates/web/tests/orphan_detect_sql_constant_red.rs:15:25
   |
15 | use diagnose::quality::{ORPHAN_ROWS_SQL, ORPHAN_TABLES};
   |                         ^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^ no `ORPHAN_TABLES` in `quality`
   |                         |
   |                         no `ORPHAN_ROWS_SQL` in `quality`
error: could not compile `web` (test "orphan_detect_sql_constant_red") due to 1 previous error
```

### 1.3 隔离库口径验证（R3 / R4(b)）—— 红阶段内已先证「修法有效」

- **判据**：隔离库建库→26 迁移→插 2 孤儿→物化→检测报 2；删行后**不** refresh ⇒ 仍 2（A 路径）；删行后**同窗** refresh ⇒ 0（B 路径）；DROP 后无残留。
- **结论**：**绿（口径成立）**。
- **关键原始读数**：
  - `red/runs/01b_cagg_count.log` ⇒ `10`（隔离库 cagg 数）
  - `red/runs/02_r3_before_refresh_detect.log` ⇒ `kline_accurate_5m|2` + `R3-1 rows=2`
  - `red/runs/03_r3_after_delete_and_refresh.log` ⇒ `kline_accurate_5m|0` + `R3-2 rows=0`
  - `red/runs/04_r4b_A_no_refresh_after_delete.log` ⇒ `R4(b)-A: after_insert_refresh=2  after_delete_no_refresh=2（期望 2）`
  - `red/runs/05_r4b_B_refresh_after_delete.log` ⇒ `R4(b)-B: after_insert_refresh=2  after_delete_and_refresh=0（期望 0）`
  - `red/runs/08_residue.log` ⇒ `residual_databases=0（期望 0）` / `residual_tables_in_live=0`
  - `red/RESULT.txt` ⇒ `SEMANTIC_EXPERIMENT_EXIT=0（0=全部期望达成）`

### 1.4 红阶段的既有基线（证明「红只红在新增判据上」）

- `red/runs/green_baseline_diagnose_lib.log` ⇒ `test result: ok. 10 passed; 0 failed`
- `red/runs/green_baseline_web_lib.log` ⇒ `test result: ok. 49 passed; 0 failed`
- `red/runs/green_baseline_web_tests_norun.log` + `green_baseline_counts.log` ⇒ 既有 web 测试目标数 `17`（`--no-run` 全部 `Executable …`，编译 EXIT=0）
- 红阶段仓库红线（`red/runs/git_and_redlines.log`）⇒ `crates/` 下仅 3 条**新增未跟踪**、暂存区为空；新增文件 sha256 前后一致（`red/selfile_hashes.txt`：`orphan_detect_endpoint_red.rs 4815f0b7…` / `orphan_detect_sql_constant_red.rs c242eb7c…` / `orphan_probe/mod.rs 4494d908…`）

> **归档诚实项**：红原始目录另存 `runs_first_run_awk_bug/rust_endpoint_red.log` —— 首轮仅有**汇总 awk 漏 `-F'|'` 导致聚合为 0**（逐表明细正确），修后复跑全绿；原证据自述「保留以证无掩盖」。本 agent **照实归档，不作任何清理**。

---

## 2. 实现自证段

来源：`tester/evidence/adr023_e6a/impl/`（原 `/tmp/adr023-e6a-impl-20260917T011303Z/`）

开工戳：`impl/START.txt` ⇒ `START=1789607583`（= 2026-09-17 09:13:03 +0800）。

### 2.1 红 → 绿（本轮新增判据全部转绿）

- **判据**：新端点用例 4/4 ok + 符号契约用例 2/2 ok。
- **结论**：**绿 6 passed / 0 failed**。
- **关键原始读数**（逐字取自 `impl/V1_green_final.txt`）：

```
     Running tests/orphan_detect_endpoint_red.rs …
running 4 tests
test r4a_clean_functions_refresh_affected_cagg_windows ... ok
test r5_no_full_range_refresh_in_test_sources ... ok
test r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint ... ok
test r1_orphan_endpoint_exists_and_reports_zero_on_clean_db ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.41s

     Running tests/orphan_detect_sql_constant_red.rs …
running 2 tests
test r2_shared_sql_constant_shape ... ok
test r2_sql_result_equals_endpoint_payload ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.72s
```

对照（`impl/V1_red_endpoint.txt` / `impl/V1_red.txt`）⇒ 红 `0 passed; 4 failed` + 1 目标编译失败，与 §1.1/§1.2 逐字一致。

### 2.2 缠结门禁

- **判据**：`./scripts/check-tangle.sh` exit 0。
- **结论**：**exit 0**。
- **原始读数**（`impl/V2_check_tangle_final.txt`，逐字）：

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

### 2.3 后端全量回归

- **判据**：`cargo test --workspace --tests` ⇒ 90 个目标 ok、727 passed、0 failed。
- **结论**：**成立**（本 agent 从原始日志**逐行复算**，非转抄）。
- **关键原始读数**（`impl/V3_cargo_test_final.txt`）：

```
EXIT=0        （文件末行：1271:EXIT=0）
```

- **本 agent 独立复算**（对 `impl/V3_cargo_test_final.txt` 逐行正则汇总 `test result:`）：

| 指标 | 复算值 |
|---|---|
| 目标数（`test result:` 行数） | **90** |
| `test result: ok` 行数 | **90** |
| `test result: FAILED` 行数 | **0** |
| passed 合计 | **727** |
| failed 合计 | **0** |
| ignored 合计 | **1** |

同一复算对独立验收段的 `verify/logs/06_cargo_test_workspace.log` 得出**完全相同**的 `90 / 727 / 0 / ignored 1`，且该日志末行 `CARGO_EXIT=0`、`real 1m4.925s`。

> **归档诚实项**：`impl/V3_cargo_test.txt`（第一次全量）为 **FAIL**（kline_reader 1 fail — 全局宽窗物化干扰），修复后由 `V3_cargo_test_final.txt` 转绿；两份**均归档**，未做择优删减。

### 2.4 前端单测 / 构建

- **判据**：vitest 88 文件 / 839 用例全绿；`npm run build` 成功。
- **结论**：**成立**。
- **关键原始读数**：
  - `impl/V3_vitest_final.txt`（逐字）：`Test Files  88 passed (88)` / `Tests  839 passed (839)`
  - `verify/logs/10_vitest.log`（逐字）：同上两行 + `VITEST_EXIT=0` / `DONE_VITEST`
  - `verify/logs/13_npm_build.log`（逐字）：`✓ built in 1.95s` / `BUILD_EXIT=0` / `DONE_BUILD`

### 2.5 三个关键测试文件断言行与 HEAD 逐字相同（零弱化）

- **判据**：`api_rest.rs` / `kline_reader.rs` / `api_kline_period.rs` 的断言行集合与 HEAD **逐字相同**（只允许行号位移）。
- **结论**：**成立**（两段独立取证一致）。
- **关键原始读数**（`impl/V3_assertions_audit.txt`，逐字）：

```
crates/web/tests/api_rest.rs  HEAD_assert_lines=23  WORKTREE_assert_lines=23
crates/storage/tests/kline_reader.rs  HEAD_assert_lines=101  WORKTREE_assert_lines=101
crates/web/tests/api_kline_period.rs  HEAD_assert_lines=11  WORKTREE_assert_lines=11
--- crates/web/tests/api_rest.rs        (断言行逐字相同)
--- crates/storage/tests/kline_reader.rs (断言行逐字相同)
--- crates/web/tests/api_kline_period.rs (断言行逐字相同)
=== 非 clean/refresh/注释 的行为改动（工作区 vs HEAD 的删行）===
-use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
-    sqlx::query("CALL refresh_continuous_aggregate('kline_5m', NULL, NULL)")
```

独立验收方对同一命题的独立复核（`verify/logs/09_a6_assert_verbatim_norm.log`，逐字）：

```
=== crates/web/tests/api_rest.rs ===
HEAD=23 WORK=23
  ASSERTION CONTENT IDENTICAL (逐字) — only line numbers shifted
=== crates/storage/tests/kline_reader.rs ===
HEAD=101 WORK=101
  ASSERTION CONTENT IDENTICAL (逐字) — only line numbers shifted
=== crates/web/tests/api_kline_period.rs ===
HEAD=11 WORK=11
  ASSERTION CONTENT IDENTICAL (逐字) — only line numbers shifted
```

同时 `impl/V3_tester_file_audit.txt` 记录了**红测试自身未被弱化**：用例名/数量未变（`orphan_detect_endpoint_red.rs` 4 用例 / 17 assert 行；`orphan_detect_sql_constant_red.rs` 2 用例 / 8 assert 行），被改动的 assert 行**仅在 R2 断言内**（行号清单 `32 41 43 46 47 49 92 97 100 107 110 117 120 129 131 170 232`）。

### 2.6 实现轮活库只读自证 + 零副作用

- `impl/V5_orphan_readonly_count.txt`（开工前）⇒ 10 表全 `| 0`
- `impl/V5_orphan_after_suite.txt`（全量测试跑完后）⇒ 10 表全 `| 0`
- `impl/V6_side_effects.txt` ⇒ `HEAD = d3c2092ff34af5edd117f877d547b393c5080e50`（未变）；staged 空；`git stash list` 空；`entangled tangle` ⇒ `Nothing to be done.`；隔离库查询 0 行。
- **实现方照实披露**：全量测试按既有设计连**共享 dev 库** `eestock` 并写各自 fixture ⇒ 测试进程对活库有写；但修好后**写后即重算**，跑完留 0 孤儿。该披露被独立验收方确认为**属实**（见 `verify/EVIDENCE.md` A7 表末行）。

---

## 3. 独立验收段

来源：`tester/evidence/adr023_e6a/verify/`（原 `/tmp/adr023-e6a-verify-20260917-013013/`）
段内自评（`verify/EVIDENCE.md:11`，逐字）：`## VERDICT: PASS`

### 3.1 A2 —— 抽离 harness 重编译重算（断言集合是否被放宽）

- **判据**：把 R2 断言实现与 `orphan_probe::{CAGGS, rs_files}` **逐字抽出**成独立 harness（唯一改动 `repo_root()` 从 argv 取），`rustc` 重编译后在真仓复算，须得**同一结论**且断言集合**未被放宽**。
- **结论**：**HARNESS_VERDICT=GREEN；断言集合未被放宽**，且 (d)(e)(f) 为**净增强**。
- **关键原始读数**（`verify/logs/14_r2_harness_real_repo.log`，逐字）：

```
HARNESS_VERDICT=GREEN
```

（原文含括号注：`HARNESS_VERDICT=GREEN  (R2 断言全部通过)`；保真对照 = 与 `cargo test -p web --test orphan_detect_endpoint_red` 的 ok 一致。）

- **重算出的断言集合**（取自 `verify/EVIDENCE.md` A2 表；harness 源码归档于 `verify/r2_harness_main.rs`，被抽离的断言原文归档于 `verify/r2_body_original.txt`，`rs_files` 原文归档于 `verify/rs_files_original.txt`）：

| # | 断言（原文语义） | 契约项 | 运行时判定次数 |
|---|---|---|---|
| 1 | `defs.len() == 1`（`crates/*/src` 内谓词字面量恰一处） | (a) | 1（扫描 113 个 src .rs） |
| 2 | 该处 `ends_with("crates/storage/src/reader.rs")` | 归属钉死 | 1 |
| 3 | `hits == 10`（10 张 cagg 各作为 `from <t>` 且其后 120 字符内含谓词） | (b) | 1 |
| 4 | `!flat.contains(PREDICATE)` | (f) | 14（11 web + 3 diagnose src 文件各 1） |
| 5 | 每张 cagg `!flat.contains("from <t>")` | (f) | 140（14 文件 × 10 表） |
| 6 | `rest.rs.contains("st.quality.orphan_rows()")` | (c) | 1 |
| 7 | `diagnose/quality.rs.contains("self.quality.orphan_rows()")` | (c) | 1 |
| 8 | `cargo tree -e normal -p storage` 不含 `diagnose` | (d) | 1 |
| 9 | `cargo tree -e normal -p domain` 不含 `sqlx` | (e) | 1 |

- **未被放宽的判定依据**（`verify/EVIDENCE.md` A2「有没有被放宽？」节）：(a) 骨架不变（识别方式由 token 改为**字面谓词**，更精确）；(b) 三重等价（`hits==10` + 运行期 10 行 + 每表 `from <t>`）；(c) 语义等价并**增强**（钉调用点 + 保留运行期逐表对拍）；(d)(e)(f) 为**新增** ⇒ 严格更强；(iii) 120 字符窗口比旧 180 **收紧**，收紧只会造成**假红**、不可能假绿。
- **(b) 邻域距离独立重算**（`verify/logs/16_a2_proximity.log`，逐字）：`hits = 10 (assertion requires == 10)`；距离表 `kline_accurate_5m=34 / 15m=35 / 30m=35 / 1h=34 / 1d=34 / 1w=34 / 1mo=35 / kline_5m=25 / kline_15m=26 / kline_1d=25` ⇒ 阈值 120 有 **3.4× 余量**；`branches(UNION ALL / first SELECT) = 10`；`predicate occurrences in the constant = 10`。

### 3.2 A3 —— 变异验证（R2(f) 口径裁决复核）

- **判据**：逐字拷贝 / 等价改写必须变红；散文提及不得误伤；完全动态拼接允许逃逸但须登记。
- **结论**：**M1/M2/M3 红、M4 绿、M5 绿（逃逸）⇒ PASS**，M5 登记为残留 R-1。
- **关键原始读数**（`verify/logs/15_a3_mutations.log`，逐字）：

| 变异 | 注入内容 | 期望 | 实测（逐字） |
|---|---|---|---|
| M1 | `ORPHAN_ROWS_SQL` **逐字**抄进 `crates/diagnose/src/quality.rs` | 红 | `HARNESS_VERDICT=RED` — panic `R2(a): 孤儿检测谓词在全仓 crates/*/src 下必须**恰有一处**定义（当前 2 处：[…/m1/crates/diagnose/src/quality.rs, …/m1/crates/storage/src/reader.rs]） left: 2 / right: 1` |
| M2 | 同上抄进 `crates/web/src/rest.rs` | 红 | `HARNESS_VERDICT=RED` — `R2(a) … 当前 2 处：[…/storage/src/reader.rs, …/web/src/rest.rs]` |
| M3 | **手写等价式**（`NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code=c.code)`，谓词字面量不同）抄进 diagnose | 红 | `HARNESS_VERDICT=RED` — `R2(f): …/diagnose/src/quality.rs 不得内联 cagg 检测 SQL（命中 'from kline_accurate_5m'）` |
| M4 | 仅**散文注释**提到 `kline_5m/kline_accurate_15m/kline_1d`（无 SQL） | 绿 | `HARNESS_VERDICT=GREEN  (R2 断言全部通过)` |
| M5 | **完全动态拼接**（`format!("…FROM {} WHERE code NOT IN (SELECT code FROM {})", table, sym)`） | — | `HARNESS_VERDICT=GREEN`（**逃逸**）⇒ 登记 R-1 |

- 变异体逐字差分归档于 `verify/mut/MUTANTS.diff`（5,585 字节，5 个 unified diff，完整保留注入文本；**未**镜像 6 棵 3.1 M 整树副本）。

### 3.3 A4 —— 隔离库检测有效性（绝不在活库）

- **判据**：26/26 迁移 rc=0；插 2 孤儿→检测报 2→删+同窗 refresh→0；端点经真链路报 2 且与单一 SQL 来源逐表相等；`DROP DATABASE … WITH (FORCE)` 后残留 0。
- **结论**：**PASS**。
- **关键原始读数**（`verify/logs/07_a4_isolated_db.log`，逐字）：
  - 迁移：`0001_init.sql exit=0` … `0026_period_30m.sql exit=0` ⇒ **26/26 rc=0**；`migrate_all_exit=0`
  - cagg 清点（STEP 3）⇒ 10 张表名逐行列出
  - STEP 4 基线 ⇒ 10 表全 `|0`
  - STEP 5/6 ⇒ `source_rows=2` / `symbols_rows_for_stub=0` / `refresh1_exit=0` / `materialized_rows=2`
  - STEP 7 检测 ⇒ `kline_accurate_5m|2`，其余 9 表 `|0`（total = 2）
  - STEP 8 删+**同窗** refresh ⇒ `DELETE 2` / `refresh2_exit=0` / 10 表全 `|0`（total = 0）
  - STEP 9 ⇒ `residual_db_count=0` / `live_db_still_exists=1`；`A4_SCRIPT_END_EXIT=0`
- 走**真端口链路**的读数（`verify/logs/12_a4ep_a8.log` STEP 5，逐字）：

```
thread 'r1_orphan_endpoint_exists_and_reports_zero_on_clean_db' (852532) panicked at crates/web/tests/orphan_detect_endpoint_red.rs:47:5:
assertion `left == right` failed: R1: 当前活库无孤儿（2026-09-17 清理后 0）⇒ rows 必须为 0
  left: 2
 right: 0
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.03s
```

（即：隔离库里真的有 2 行孤儿时，端点**报出 2** ⇒ 端点确实读同一份 SQL，同时 R1 的 `rows==0` 是**活哨兵**。）
- 端点与单一 SQL 来源逐表相等（同文件 STEP 5b，逐字）：

```
running 2 tests
test r2_shared_sql_constant_shape ... ok
test r2_sql_result_equals_endpoint_payload ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
```

- 用完即清（同文件 STEP 7）⇒ `DROP DATABASE` / `residual_db_count=0` / `live_db_exists=1`

> **归档诚实项（原始日志里的异常，照实登记）**：`verify/logs/12_a4ep_a8.log` 的 **STEP 4 有一处 psql 报错**：
> `psql: warning: extra command-line argument "…/orphan_rows_sql_extracted.sql" ignored` + `ERROR: syntax error at or near "-" LINE 1: -f`；
> 紧随其后仍打印出 `--- total = 2`（脚本 `a4ep_a8_isolated.sh:38` 用 `-Atf $D/orphan_rows_sql_extracted.sql` 的内联形式重算，成功）。
> 本 agent 只**登记**该行异常的原始形态（原始日志已归档于 `verify/logs/12_a4ep_a8.log`），**不做归因、不做修复**。

### 3.4 A5 —— clean() 语义与跨测试干扰穷举

- **判据**：四个 clean 的窗口须按夹具跨度推导并逐字符落在桶边界；且**全仓无测试依赖「某桶刻意未物化」被破坏**。
- **结论**：**PASS**（无跨测试干扰）。经验证据：全量 `727 passed / 0 failed`，其中 `symbols_latest_prev_close_is_prev_trading_day_d1` ok。
- **关键原始读数 ①（refresh 点计数，逐字）**：
  - `verify/logs/08_a5_terms.log` 与 `red/runs/rust_endpoint_red.log` 均记：`R5 refresh 调用点计数 = 24`
  - `verify/EVIDENCE.md` A5：`全仓测试 refresh 调用点 = 24 处（R5 打印计数）`；并列出承载文件为
    `storage/tests/kline_reader.rs`、`web/tests/api_rest.rs`、`web/tests/api_kline_period.rs`、`storage/tests/period30m_migration.rs`（后者只读迁移文本，不执行）
- **关键原始读数 ②（唯一依赖「刻意未物化」的断言，逐字）**（`verify/EVIDENCE.md` A5）：
  `crates/storage/tests/kline_reader.rs:671 symbols_latest_prev_close_is_prev_trading_day_d1` 的
  `assert!(new.prev_close.is_none(), "无 D1 历史的新标的 → prev_close NULL")`（CODE_D1_NEW=997775，夹具 `2026-08-20 01:30Z` 单行 M1）；
  且该「刻意未物化」的语境注释原文归档于 `verify/logs/08_a5_terms.log:27`：
  `crates/storage/tests/kline_reader.rs:62:    // 刻意保持未物化的桶（实测：全局宽窗会让 \`symbols_latest_prev_close_is_prev_trading_day_d1\``
- **关键原始读数 ③（逐窗口不可达判定）**：目标桶 = CST 2026-08-20 日桶 = UTC `[2026-08-19 16:00Z, 2026-08-20 16:00Z)`，逐窗口核对结论为
  「**无一包含 08-19 16:00Z**」，唯一会重算该桶的是 CODE_D1_NEW **自己的** `clean()`（`[2026-08-19 16:00Z, 2026-08-21 16:00Z)`，属测试自清理，其断言在此之前完成）；W/MO 窗只重算 `kline_accurate_1w/1mo`，与 D1 昨收路径无关。（全文见 `verify/EVIDENCE.md` A5(2) 逐窗口清单。）

> **归档边界项 ①（本 agent 独立复算发现的计数口径落差，照实登记）**：
> **「24 处」是红阶段（**修前**）读数，不是 HEAD 工作区读数。** 本 agent 复算：
> - 提交 `d3c2092` 的 **tracked** tests 文件里 `refresh_continuous_aggregate` 出现 **15** 次
>   （`kline_reader.rs 6` / `period30m_migration.rs 6` / `api_rest.rs 2` / `api_kline_period.rs 1`）；
> - 红阶段新增的未跟踪红测试 `orphan_detect_endpoint_red.rs` 自身含 **9** 次 ⇒ **15 + 9 = 24**，与红阶段打印**精确吻合**；
> - 修复给四个 clean() 加了 **4** 次 refresh（`kline_reader.rs +1`、`api_rest.rs +2`、`api_kline_period.rs +1`）
>   ⇒ **HEAD 工作区实测 = 28 次**（`kline_reader.rs 7 / period30m_migration.rs 6 / api_rest.rs 4 / api_kline_period.rs 2 / orphan_detect_endpoint_red.rs 9`）。
> ⇒ 因此 A5 的「24 处」应读作**修前基线**；**修后为 28 处**。A5 的「逐窗口不可达」结论覆盖的正是这四个 clean() 的窗口
> （清单里 `kline_reader::clean`、`refresh_d1`、`api_rest.rs:206`、`api_rest.rs:128` 等逐条在案），**该结论本身不因计数口径而改变**，
> 但**文档与提交信息里的「24 处」是修前数字**，此处登记以免后续误读。（来源：`impl/V1_red_endpoint.txt`、
> `red/runs/rust_endpoint_red.log`、`red/runs/r5_grep_evidence.log`、`verify/EVIDENCE.md` A5，以及本 agent 对
> `git show d3c2092:<file>` 与 HEAD 工作区的逐文件 `count` 复算。）

> **归档边界项 ②（引用行号不一致，照实登记）**：`verify/EVIDENCE.md` A5 把该唯一断言引作
> `crates/storage/tests/kline_reader.rs:671`，而 HEAD 工作区与 `fb5a7a6` 提交内容里该断言的**实际行号是 `718`**
> （`assert!(new.prev_close.is_none(), "无 D1 历史的新标的 → prev_close NULL（前端 --）");`，本 agent 在只读工作区 `grep -n` 复核）。
> 二者指同一断言（文本语义一致），**仅引用行号不同**；原始日志 `verify/logs/08_a5_terms.log` 里留下的是语境注释行 `:62`。此处照实登记口径差异。

### 3.5 A6 —— 端点与回归（独立验收方复跑）

- **判据**：端点逐表可读且总数 0；端点与 SQL 单一来源对拍；门禁 exit 0；后端全量 90 目标/727 passed/0 failed；前端 88/839；构建成功；既有断言零弱化。
- **结论**：**全部 PASS**（`curl` 一项为「记录」非 PASS，见 R-4）。
- **关键原始读数**：
  - `verify/logs/06_cargo_test_workspace.log` ⇒ 末行 `CARGO_EXIT=0`、`real 1m4.925s`；本 agent 逐行复算 = **90 目标 / 727 passed / 0 failed / 1 ignored**
  - `verify/logs/10_vitest.log` ⇒ `Test Files 88 passed (88)` / `Tests 839 passed (839)` / `VITEST_EXIT=0`
  - `verify/logs/13_npm_build.log` ⇒ `✓ built in 1.95s` / `BUILD_EXIT=0`
  - `verify/logs/05_check_tangle.log` ⇒ `[check-tangle] ✅ design 与生成物一致…` / `EXIT=0`
  - `verify/logs/09_a6_assert_verbatim_norm.log` ⇒ 三文件 `23=23 / 101=101 / 11=11` + `ASSERTION CONTENT IDENTICAL (逐字)`
  - `verify/logs/17_live_app_probe.log`（逐字）：`GET /api/quality/orphans on live app :8081 -> HTTP 404`（⇒ 未部署，见 R-4）

### 3.6 A7 —— 全量测试跑完后活库孤儿 10 表全 0

- **判据**：跑完全量测试后，活库 10 张 cagg 的孤儿计数须**全 0**（= 清理成果未被回退 + P1-1 自清洁）。
- **结论**：**成立**。
- **关键原始读数**（`verify/logs/11_a7_post_test.log`，逐字）：

```
### A7 1) post-test orphan counts (read-only)
kline_15m|0
kline_1d|0
kline_5m|0
kline_accurate_15m|0
kline_accurate_1d|0
kline_accurate_1h|0
kline_accurate_1mo|0
kline_accurate_1w|0
kline_accurate_30m|0
kline_accurate_5m|0
### A7 2) residual test fixture codes left in live DB (read-only)
symbols_99xxxx_9xxxxx=0
kline_accurate_stub=0
```

对照组（测试**前**）：`verify/logs/04_orphans_pre.log` ⇒ 同样 10 表全 `|0`（⇒ 净 0 且前后一致）。
同文件另记录：`HEAD=d3c2092ff34af5edd117f877d547b393c5080e50` / `staged=[]` / `stash=[]` / `cargo_changes=[]`；
在线 app `178558    09:34:26 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（未重启）；容器 `eestock-timescaledb … Up 11 days (healthy)`、`eestock-data … Up 11 days (healthy)`。

### 3.7 A8 —— 哨兵有效性（机械证明）

- **判据**：R1 的 `rows==0` 断言必须是**活哨兵** —— 当出现「未被 clean 覆盖的窗口」留下孤儿时，它必须变红。
- **结论**：**PASS（机械证明成立）**。
- **关键原始读数**（`verify/logs/12_a4ep_a8.log` STEP 5 / STEP 6，逐字）：
  - 正向：隔离库物化 2 行孤儿 ⇒ R1 **变红**，`left: 2 / right: 0`（见 §3.3 引文）
  - 未覆盖窗口形态：`998911`@`2026-09-04 05:00Z` → refresh `[05:00,05:05)` → **删行但不 refresh 该窗** ⇒
    `--- after delete WITHOUT refresh of that window: probe (uncovered orphan) =>` `kline_accurate_5m|3`
    （= 原 2 孤儿 + 1 未覆盖孤儿）；随后**同窗 refresh** ⇒ `kline_accurate_5m|2`
  ⇒ 机械上证明「将来某测试 refresh 未被 clean 覆盖的 cagg/窗口」会留下**可被同一份 SQL 检出**（且被 R1 抓住）的孤儿。

---

## 4. 残留与口径边界登记（R-1 … R-6）

以下**逐字取自** `verify/EVIDENCE.md`「残留风险 / 未决项」节，并交叉引用
`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §6.1 / §6.3。
**均非 FAIL，属交接项**；本 agent 只登记，不分析、不修复。

| ID | 等级 | 内容（原文摘要） | ADR 交叉引用 |
|---|---|---|---|
| **R-1** | 低 | R2(f) 是**文本级规则**；**完全动态拼接**的 SQL（表名与谓词都运行时构造）**可逃逸**（A3 变异 **M5 实证 GREEN**）。建议后续可加「禁止 web/diagnose 出现 `refresh_continuous_aggregate`/`code NOT IN` 动态拼接」或改 AST/白名单式检查 | ADR-023 §6.3 #12（孤儿根因治本范围）；本刀范围外 |
| **R-2** | 低 | R2(a) 扫描域仅 `crates/*/src`（**不含 tests**）；测试内若出现第二份检测 SQL 不会报（生产层意图不受影响） | — |
| **R-3** | 中（既有） | `cagg_refresh_lock()` 只在**单 binary 内**串行化；`storage/tests/kline_reader.rs` 与 `web/tests/api_rest.rs`/`api_kline_period.rs` 属**不同进程**，窗口重叠时仍可能 **55P03**。本轮全量只跑 **1 次**（EXIT=0），**未做重复跑以证不 flaky**（时间盒） | ADR-023 §6.3 #14（调度层失败 / `concurrent refresh` 记录） |
| **R-4** | 流程 | 新端点**未部署**：在线 app（PID 178558，启动早于本轮改动）**未含**本端点 ⇒ `:8081/api/quality/orphans` 线上**仍 404**（`verify/logs/17_live_app_probe.log` 逐字）。端点的 200/0 由**进程内 router 用例（活库，只读 GET）**建立；**部署/重启不在本验收范围且被纪律禁止** ⇒ 属「**已提交未部署**」落差 | ADR-023 §6.1 #8（测试写共享 dev 库）之外；部署流程项 |
| **R-5** | 既有债（P0） | 全量测试仍按既有设计连**共享活库** `eestock` 并写各自 fixture（隔离债本轮**未动**）。A7 证明「跑完**净 0** 孤儿」，但**测试中途中止/崩溃**仍可能留残留（本轮**未构造**该故障） | **ADR-023 §6.1 第 8 条**（「测试隔离债：集成测试写共享 dev 库」）；§6.3 #12 实证其真实危害 |
| **R-6** | 低 | R2(c) 的两条是**子串**匹配（注释里出现调用文本亦可满足）；由「运行期逐表对拍」+ A4 隔离库端点实证兜底 | — |

**另需登记的流程/口径边界（本 agent 归档期新发现，非 verify 原文）**：

- **B-1（证据时点 vs 提交时点）**：三段证据均在 **HEAD=d3c2092 未提交工作区**产生；提交 `fb5a7a6` 在其后。⇒ 证据**未**覆盖「提交后重跑」。
- **B-2（refresh 点计数口径）**：文档与提交信息里的「**24 处**」为**修前**读数；**HEAD 工作区实测 28 处**（复算与分解见 §3.4 归档边界项 ①）。
- **B-3（引用行号）**：`verify/EVIDENCE.md` A5 引 `kline_reader.rs:671`，HEAD/提交内实际为 **`:718`**（同一断言，见 §3.4 归档边界项 ②）。
- **B-4（原始日志内异常）**：`verify/logs/12_a4ep_a8.log` STEP 4 有一处 psql 参数解析报错（`-f` 被当作文件名），其后同义内联命令成功并得 `total = 2`（见 §3.3 归档诚实项）。
- **B-5（红阶段首轮 awk 缺陷）**：`red/runs_first_run_awk_bug/` 保留首轮日志；缺陷仅在**聚合**（漏 `-F'|'`），逐表明细正确，修后复跑全绿（见 §1 归档诚实项）。
- **B-6（时间盒）**：实现轮（`impl/EVIDENCE.md`）与验收轮（`verify/EVIDENCE.md`）均**自述超出时间盒**（实现轮含一次父级裁决往返 + 两次回归失败返工；验收轮 30 min 略超）。收尾均已完整（隔离库 DROP 且残留复核 0；未改仓库文件）。

---

## 5. 归档清单（`tester/evidence/adr023_e6a/`）

- 文件数：**86**（不含 `README.md`；含索引共 **87**）；总字节（`du -sb`）：**407,267**（含索引 **412,372**）；`du -sh`：**692K**
- `red/` 26 文件（**与源目录 26/26 全量一致，逐字节 `cmp` 通过**）
- `impl/` 25 文件（**与源目录 25/25 全量一致，逐字节 `cmp` 通过**）
- `verify/` 35 文件 = `EVIDENCE.md` + `logs/` 20 件 + 脚本/SQL 3 件 + 抽离件 4 件 + 参考副本 3 件 + `r2_harness_main.rs` + `mut/MUTANTS.diff`（逐字节 `cmp` 通过）
- 未收（含理由与替代）：`r2harness/r2_harness`（4.3 M ELF 二进制）/ `mut/{base,m1..m5}`（19 M 整树镜像）
  ⇒ 替代件为 `verify/logs/15_a3_mutations.log` + `verify/mut/MUTANTS.diff`（明文差分，5,585 字节）

---

## 6. 纪律遵守自述（本 agent）

| 纪律 | 执行 |
|---|---|
| 只允许在 `tester/` 下新增文件 | ✅ 新增 `tester/evidence/adr023_e6a/**`（86 文件）+ `tester/test/292_adr023_e6a_acceptance_execution.md` |
| 禁改 `design/`、实现代码、既有测试文件 | ✅ 未触碰（本次新增全部落在 `tester/`） |
| 禁 `git add` / `git commit` / `git stash` | ✅ 未执行（只用了只读 `git log/show/ls-tree/status/rev-parse`） |
| 禁重启/杀在线 app（PID 178558） | ✅ 未执行任何 `kill`/重启 |
| 禁对活库 `eestock` 做任何写（只读 SELECT 允许） | ✅ 归档期**未连库、未发任何 SQL**（纯文件读写 + git 只读） |
| 不分析/不修复失败 | ✅ 全部残留与异常仅**登记**（R-1…R-6、B-1…B-6），无归因推断、无补丁 |

## 7. 证据索引（本报告引用的归档件）

| 命题 | 归档文件（相对 `tester/evidence/adr023_e6a/`） |
|---|---|
| 红：0 passed; 4 failed | `red/runs/rust_endpoint_red.log` |
| 红：E0432 | `red/runs/rust_sql_constant_red.log` |
| 红：R5 24 点 + `api_rest.rs:151` | `red/runs/rust_endpoint_red.log`、`red/runs/r5_grep_evidence.log` |
| 红：隔离库 R3/R4b/无残留 | `red/runs/02_*` `03_*` `04_*` `05_*` `07_drop_db.log` `08_residue.log`、`red/RESULT.txt` |
| 实现：红→绿 6 passed | `impl/V1_green_final.txt`、`impl/V1_red_endpoint.txt`、`impl/V1_red.txt` |
| 实现：门禁 exit 0 | `impl/V2_check_tangle_final.txt` |
| 实现：全量 90/727/0 + EXIT=0 | `impl/V3_cargo_test_final.txt` |
| 实现：vitest 88/839、build | `impl/V3_vitest_final.txt`、`impl/V3_npm_build_final.txt` |
| 实现：断言零弱化 | `impl/V3_assertions_audit.txt`、`impl/V3_tester_file_audit.txt` |
| 实现：活库只读净 0 / 零副作用 | `impl/V5_orphan_readonly_count.txt`、`impl/V5_orphan_after_suite.txt`、`impl/V6_side_effects.txt` |
| 验收：HARNESS_VERDICT=GREEN | `verify/logs/14_r2_harness_real_repo.log`、`verify/r2_harness_main.rs`、`verify/r2_body_original.txt` |
| 验收：(b) 邻域距离重算 | `verify/logs/16_a2_proximity.log` |
| 验收：A3 变异 M1–M5 | `verify/logs/15_a3_mutations.log`、`verify/mut/MUTANTS.diff` |
| 验收：A4 隔离库 26/26 + 2→0 | `verify/logs/07_a4_isolated_db.log`、`verify/logs/12_a4ep_a8.log`、`verify/a4_isolated_db.sh`、`verify/a4ep_a8_isolated.sh` |
| 验收：A5 refresh 点 + 未物化断言 | `verify/logs/08_a5_terms.log`、`verify/EVIDENCE.md` A5 |
| 验收：A6 全量/vitest/build/门禁/断言 | `verify/logs/06_cargo_test_workspace.log`、`10_vitest.log`、`13_npm_build.log`、`05_check_tangle.log`、`09_a6_assert_verbatim*.log` |
| 验收：A7 跑完 10 表全 0 | `verify/logs/11_a7_post_test.log`、`verify/logs/04_orphans_pre.log` |
| 验收：A8 哨兵机械证明 | `verify/logs/12_a4ep_a8.log`、`verify/a8_probe_uncovered.sql` |
| 验收：线上端点 404（未部署） | `verify/logs/17_live_app_probe.log` |
