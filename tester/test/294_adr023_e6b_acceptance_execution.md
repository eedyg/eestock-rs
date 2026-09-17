# ADR-023 E6b 第二刀 — 证据链落库 + 四段验收汇总执行报告

- **本文件位置（绝对路径）**：`/home/eestock/workspace/git/eestock/eestock-rs/tester/test/294_adr023_e6b_acceptance_execution.md`
- 证据归档目录：`tester/evidence/adr023_e6b/`（清单与取舍见该目录 `README.md`）
- 报告撰写时刻：2026-09-17 12:25Z 之后（归档时刻）；被归档证据的生成时间窗：2026-09-17 03:47Z → 04:24Z（red/impl/fixup）与 12:04–12:10 CST（verify）
- 交付提交：`cf9e19f`（`fix(test,infra): 第二刀 —— 测试池统一走 EESTOCK_TEST_DATABASE_URL + 哨兵门禁 + 幂等供应脚本（ADR-023 E6b）`）；四段证据生成时 HEAD 均为 `204cb77a2f345c7163b5a93da4540cd5c66f2d6f`
- 角色：Tester（只归档 + 只汇总，**不改任何实现 / design / 既有测试**；本轮零 `git add` / `git commit` / `git stash`；未重启或杀在线 app PID 178558；未对活库 `eestock` 做任何写）
- 文档性质：**本报告不产生新测试，只回放既有四段原始读数**（对应「执行报告」口径）。原 red 阶段的设计报告为 `tester/design/292_adr023_e6b_testdb_env_gate_red_design.md`，原 red 执行报告为 `tester/test/293_adr023_e6b_testdb_env_gate_red_execution.md`。

> 引用约定：每处读数后以 `[来源: <归档相对路径>]` 标注逐字出处；`…` 表示省略。凡证据文件未覆盖的推论一律不写入结论。

---

## 0. 归档动作与来源目录对照

| 归档子目录 | 原始 /tmp 来源 | 是否存在 | 处置 |
|---|---|---|---|
| `red/` | `/tmp/adr023-e6b-red-20260917T034707Z` | 存在（14 文件 / 100K） | 全量复制（14 文件 / 53,791 B） |
| `impl/` | `/tmp/adr023-e6b-impl-20260917T035254Z` | 存在（24 文件 / 308K） | 全量复制（24 文件 / 248,973 B） |
| `verify/` | `/tmp/adr023-e6b-verify-20260917-120416` | 存在（62 文件 / 392K） | 全量复制（62 文件 / 198,134 B） |
| `fixup/` | `/tmp/adr023-e6b-fixup-20260917T041228Z` | 存在（3431 文件 / 65M） | **取舍复制**（51 文件 / 149,205 B）：排除 `tree_*` 整仓副本（12 份 ×~3.1M）、`gate_bin_old/new`+`fake_deps` 二进制（3 ×~8.1M）、`migrations` 符号链接 |
| （无归档） | `/tmp/adr023-e6b-verify-1789617852` | **存在但为空目录**（0 文件） | 未归档：无内容。判读为一次未产出内容的尝试残留 |
| （无归档） | `/tmp/adr023-e6b-red-TS.txt` | 存在（4.0K） | 未归档：内容仅一行 `20260917T034707Z`（red 目录名时间戳指针），无判据载荷 |

**取舍理由与完整性核对已逐条写在 `tester/evidence/adr023_e6b/README.md`**（含被排除项清单）。归档总计 **152 文件 / 655,595 字节**，无大二进制、无整仓/整库镜像。

---

## 1. 红阶段（R1–R5：测试写活库 ⇒ 响亮失败）

**判据**：门禁落地前，新增门禁测试必须整体失败；shell 门禁测试必须 RED；且失败原因须指向「测试池可静默写非测试库」。

**结论：成立（红）。**

### 1.1 Rust 红测试 `0 passed; 5 failed`，exit 101

```
running 5 tests
test r3_init_script_exists_executable_and_covers_contract ... FAILED
test r4_static_no_hardcoded_live_db_url_in_test_sources ... FAILED
test r2_static_every_test_pool_must_assert_sentinel_table ... FAILED
test r1_static_every_test_pool_must_read_eestock_test_database_url ... FAILED
test r1_behaviour_unset_env_var_must_fail_loudly_naming_the_variable ... FAILED

test result: FAILED. 0 passed; 5 failed; 0 ignored; 0 measured; 0 filtered out; finished in 30.01s
error: test failed, to rerun pass `-p storage --test adr023_e6b_testdb_env_gate_red`
RED_GATE_EXIT=101
```
`[来源: red/red_gate_run.txt]`

逐例失败原文（节选，逐字）：
```
R3 红：`scripts/testdb-init.sh` 不存在（缺幂等建库 + 迁移 + 哨兵 + export 的一键入口）
R4 红：活库 URL 字面量在 crates/*/tests 下仍有 35 处（其中 `unwrap_or_else` 兜底默认 33 处）：
```
`[来源: red/red_gate_run.txt]`；红阶段 EVIDENCE 补充记载静态面为「32/32 个会连库测试文件未引用 `EESTOCK_TEST_DATABASE_URL`」、R1b 输出 `cargo_output_mentions=0` `[来源: red/EVIDENCE.md §1/§2]`

### 1.2 Shell 门禁 `PASS=0 FAIL=1` / `VERDICT: RED`

```
== R3: scripts/testdb-init.sh 存在 / 可执行 / 幂等 / export 行 ==
  FAIL R3-1 scripts/testdb-init.sh 不存在（红：缺幂等初始化入口）
VERDICT: RED (R3-1)  PASS=0 FAIL=1
R3_SHELL_EXIT=1
```
`[来源: red/r3_shell_gate.txt]`

### 1.3 红的**行为**佐证（不是空跑红灯）

- R1b（未设 `EESTOCK_TEST_DATABASE_URL`、`DATABASE_URL=<一次性空库>`）：`test result: ok. 14 passed; … R1b_EXIT=0`、`cargo_output_mentions=0` ⇒ 未设变量**不失败**，即会走库 `[来源: red/r1b_run.txt]`
- R2（无哨兵表的一次性库模拟「非测试库」）：`test result: ok. 3 passed; … R2_EXIT=0`、`sentinel_mentions=0`，且写确实发生 `AFTER|xact_commit=4941|tup_inserted=10728|tup_deleted=2908` `[来源: red/r2_run.txt]`；跑前无哨兵表计数 `0` `[来源: red/r2_sentinel_absent_count.txt]`
- 活库侧零写佐证：哨兵表/探针表在活库计数 `0` `[来源: red/live_sentinel_count.txt]`
- R3 可达性探针（目标流程本身可行，缺的只是脚本）：`[3] 结论：门禁落地后 raw_writer 在「有哨兵的测试库」上可跑通 ⇒ R3 的可达性成立（当前缺的是 scripts/testdb-init.sh 本身）` `[来源: red/r3_feasibility_probe.txt]`
- R5 机制级变异反证：门禁版在无哨兵库 `exit=2`；变异版（哨兵检查注掉）`exit=0` 且 `写入证据(_e6b_probe_rows 行数)=1`；哨兵值非 `test` 时门禁版 `exit=2` `[来源: red/r5_mutation_result.txt]`

---

## 2. 实现自证 + 独立验收

**判据**：绿（门禁测试全过）+ 未设变量响亮失败 + 误指活库被拦 + 供应脚本幂等 + 全量测试不回归 + doc-first 生成物同步。

**结论：成立（两段一致）。**

### 2.1 红 → 绿（实现自证）

```
--- GREEN rust --- test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
--- GREEN shell --- PASS=7 FAIL=0 / VERDICT: GREEN
```
`[来源: impl/V1_green_gate_final.log、impl/V1_shell_gate_final.log]`；红侧同段记载 `0 passed; 5 failed`（finished in 30.01s）与 `PASS=0 FAIL=1 / VERDICT: RED` `[来源: impl/V1_red_before.log、impl/V1_red_shell_before.log]`

### 2.2 `cargo test --workspace --tests` = 732 passed / 0 failed（两轮一致）

| 轮次 | 读数（逐字） | 来源 |
|---|---|---|
| 实现自证 · 绿后轮 | `passed=732 failed=0`（92 行 `test result: ok`） | `impl/V3_workspace_tests_after.log` |
| 实现自证 · 重跑轮 | `passed=732 failed=0`（92 行 `test result: ok`） | `impl/V5_rerun_tests.log` |
| 独立验收 | `EXIT=0 elapsed=55s`；`passed=732 failed=0`（92 行 `test result: ok`） | `verify/A2_workspace_rc.txt`、`verify/A2_workspace_tests.txt` |
| 收尾修正后复跑 | `passed=732 failed=0`（92 行 `test result: ok`） | `fixup/v3_tests.log` |

> **如实登记一处原始日志与叙述不一致**（不作分析）：`impl/V3_workspace_tests.log` 的原始读数是 `passed=724 failed=8`（92 行 `test result:`，尾部含 `error: test failed, to rerun pass …`，涉及 `-p mcp --test d11_fee_profile_e2e`、`-p mcp --test mcp_tools_db`、`-p storage --test fee_profile_store`、`-p storage --test kline_reader`、`-p storage --test symbol_type_fee_migration` 等 target）；而 impl EVIDENCE.md 将该轮记为 732/0。**两轮 732/0 的判据由 `impl/V3_workspace_tests_after.log` 与 `impl/V5_rerun_tests.log` 承载**（二者均为 732/0），并获独立验收与收尾修正两段各自复现。此不一致如实交父级裁决，本报告不做归因。

### 2.3 未设变量 → exit 101 且输出含 `EESTOCK_TEST_DATABASE_URL`

```
exit=101
集成测试拒绝运行：环境变量 `EESTOCK_TEST_DATABASE_URL` 未设置（或为空）。
```
`[来源: impl/V4a_evidence.txt、impl/V4a_unset.log（该日志内 grep 变量名计数=30）]`

独立验收复现（逐字，含 panic 位置）：
```
thread 'weekly_monthly_deep_scroll_before_2024' (1176315) panicked at crates/test-support/src/lib.rs:26:14:
集成测试拒绝运行：环境变量 `EESTOCK_TEST_DATABASE_URL` 未设置（或为空）。
…
test result: FAILED. 0 passed; 15 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
`[来源: verify/A1_case1.txt；EXIT 读数见 verify/A1_case1_rc.txt]`

### 2.4 指向活库 → exit 101（哨兵 `_eestock_test_db` 拦下，15/15 用例压根未触达测试体）

```
exit=101
哨兵表 `_eestock_test_db` 不存在/查询失败：`EESTOCK_TEST_DATABASE_URL` 很可能指向活库 `eestock`（哨兵拦截）。: error returned from database: relation "_eestock_test_db" does not exist
```
`[来源: impl/V4b_evidence.txt、impl/V4b_live.log]`

独立验收复现（逐字）：
```
thread 'merged_1m_branch_index_limit_performance' (1176512) panicked at crates/test-support/src/lib.rs:55:19:
哨兵表 `_eestock_test_db` 不存在/查询失败：`EESTOCK_TEST_DATABASE_URL` 很可能指向活库 `eestock`（哨兵拦截）。: error returned from database: relation "_eestock_test_db" does not exist
```
`[来源: verify/A1_case2.txt；EXIT 读数见 verify/A1_case2_rc.txt]`；验收 EVIDENCE 记载「15/15 用例均在建池处被哨兵拦下，无一触达测试体」`[来源: verify/EVIDENCE.md §A1-2]`

### 2.5 `scripts/testdb-init.sh` RUN1 16.23s / RUN2 0.99s（幂等，逐表打印跳过原因）

RUN1：`EXIT=0`、`wall 16.23s`；stdout 仅一行 export `[来源: verify/A2_run1.stderr、verify/A2_run1.stdout、verify/A2_init_run1.txt]`
RUN2（幂等）：
```
RUN2 exit=0
[testdb-init] 库 `e6b_verify_iso` 已存在（跳过建库）
[testdb-init] 迁移应用完成（账本 26 条）
[testdb-init] 哨兵表 `_eestock_test_db` 就绪（value=test）
[testdb-init] 跳过播种 symbols（目标已有 44 行）
[testdb-init] 跳过播种 strategy（目标已有 23 行）
[testdb-init] 跳过播种 strategy_version（目标已有 24 行）
[testdb-init] 跳过播种 kline_accurate（目标已有 518880/510050 的 M1）
elapsed=0:00.99
```
`[来源: verify/A2_init_run2.txt]`

前后逐表行数不变（幂等硬证据）：
```
=== before run2 counts ===   symbols = 44 / strategy = 23 / strategy_version = 24 / kline_accurate = 1631088 / kline_accurate_1d = 6768
=== after run2 counts ===    symbols = 44 / strategy = 23 / strategy_version = 24 / kline_accurate = 1631088 / kline_accurate_1d = 6768
```
`[来源: verify/A2_counts.txt]`；收尾修正段复跑同构：首次 16.3s、二次 0.98s、四表全「跳过播种」`[来源: fixup/EVIDENCE.md §V3、fixup/v3_init.err、fixup/v3_init2.err]`

隔离佐证（测试确实写在测试库、种子未被损）：`kline_raw|0`、`kline_accurate|1631088`、`symbols_all|44`、`app_config|0` `[来源: verify/A2_isolation.txt]`

### 2.6 13 个 doc-first 产物更新

```
crates/storage/tests/kline_reader.rs test_support=1 literal=0 mtime=1789617275
…（共 13 行，另含 api_rest.rs / ws_poller.rs / symbol_admin.rs / api_admin.rs / api_quality.rs /
   mcp_tools_db.rs / alert_store.rs / api_alerts.rs / accurate_upsert.rs(test_support=2) /
   raw_writer.rs / event_sink.rs / symbols_registry.rs）
=== tangle wrote exactly 13 ===
13
```
`[来源: impl/docfirst_evidence.txt]`

独立验收以更强口径确认（沙箱重新生成 + 逐字节比对）：
```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
```
`[来源: verify/A6_check_tangle.txt、verify/A6_check_tangle_rc.txt(=exit 0)、impl/V2_check_tangle_final.log、fixup/v3_checktangle.log]`

### 2.7 未弱化 / 未删除测试（独立验收专项）

验收逐文件结构对照结论：「34 个受影响的测试文件：用例数 `#[test]`/`#[tokio::test]`、断言数逐文件与 HEAD **完全相等**」；「全量 diff 中被删的含 assert/test/fn 行仅 31 行，全部是 …建池样板；新增行中不含任何 assert/test」`[来源: verify/A5_files.txt、verify/A5_removed.txt、verify/EVIDENCE.md §A5]`

---

## 3. 六格变异矩阵（门禁有效性反证，收尾修正段）

**判据**：同一**已编译**门禁二进制 + 指向 /tmp 副本的扫描根（`EESTOCK_GATE_REPO_ROOT`），对 5 个变异体 + 副本基线 + 正常仓库本体各跑一次；修前应存在绕过格，修补后全部变红且正常仓库不误伤。

**结论：成立。** 原始读数（逐字，`[来源: fixup/old_run_*.log / fixup/new_run_*.log / fixup/new_run_realrepo.log]`）：

```
OLD case=base exit=0   test result: ok.     5 passed; 0 failed
OLD case=mut1 exit=101 test result: FAILED. 2 passed; 3 failed     ← 规范形态本就被抓
OLD case=mut2 exit=0   test result: ok.     5 passed; 0 failed     ← 绕过（connect_lazy+format!）
OLD case=mut3 exit=0   test result: ok.     5 passed; 0 failed     ← 绕过（仅注释提及）
OLD case=mut4 exit=101 test result: FAILED. 2 passed; 3 failed
OLD case=mut5 exit=0   test result: ok.     5 passed; 0 failed     ← 绕过

NEW case=base exit=0   test result: ok.     5 passed; 0 failed
NEW case=mut1 exit=101 test result: FAILED. 2 passed; 3 failed
NEW case=mut2 exit=101 test result: FAILED. 4 passed; 1 failed     ← 补齐后变红（R1）
NEW case=mut3 exit=101 test result: FAILED. 3 passed; 2 failed     ← 补齐后变红（R1+R2）
NEW case=mut4 exit=101 test result: FAILED. 2 passed; 3 failed
NEW case=mut5 exit=101 test result: FAILED. 4 passed; 1 failed     ← 补齐后变红（R1）
```
`[来源: fixup/EVIDENCE.md §V2；逐格原始日志 fixup/old_run_base.log、old_run_mut1..5、new_run_base.log、new_run_mut1..5]`

变形体定义（每个变异体源码已归档）：`mutations/zz_mut1_eager_pgpool_connect_literal.rs`（lazy/eager：`PgPool::connect` + 精确活库字面量）、`zz_mut2_connect_lazy_format_splice.rs`（`connect_lazy` + `format!` 拼接）、`zz_mut3_comment_only_mention.rs`（仅注释提及变量名/哨兵表名）、`zz_mut4_doccomment_entry_eager.rs`（仅文档注释自称走 `test_support::test_pool`，代码是活库字面量）、`zz_mut5_doccomment_entry_lazy.rs`（仅文档注释自称入口 + lazy 规避）`[来源: fixup/mutations/*.rs]`

**正常仓库 GREEN 不误伤**（无 `EESTOCK_GATE_REPO_ROOT`，仓库本体）：
```
test r1_behaviour_unset_env_var_must_fail_loudly_naming_the_variable ... ok
test r1_static_every_test_file_that_builds_a_pool_must_use_test_support_entry ... ok
test r2_static_every_connecting_test_file_must_carry_sentinel_gate ... ok
test r3_init_script_exists_executable_and_covers_contract ... ok
test r4_static_no_hardcoded_live_db_url_in_test_sources ... ok
test result: ok. 5 passed; 0 failed; …
exit=0
```
`[来源: fixup/EVIDENCE.md §V2；原始日志 fixup/new_run_realrepo.log（`test result: ok. 5 passed; 0 failed`）]`

同段还给出静态面边界之**如实说明**（原文）：`connect_lazy` 指向「不可达地址」还是「活库地址」在**静态面无法区分**语义；处理 = 把所有池构造收束到 `test_support::` 单一入口 + 不可达 URL 常量只此一处；替代探针 = R1 行为探针 + 哨兵表拦截 `[来源: fixup/EVIDENCE.md §F3]`

---

## 4. 收尾修正（F1 / F2 / F4）

### 4.1 F1 — README 播种契约（4 张表与行数）

判据：README 须写明播种内容与行数（独立验收 A3-(6) 曾判 PARTIAL/未满足）。
结论：**满足**（`README.md:117` 新增小节）。读数（逐字）：
```
symbols 播种完成：目标现有 44 行
strategy 播种完成：目标现有 23 行
strategy_version 播种完成：目标现有 24 行
kline_accurate 播种完成：目标现有 1631088 行
kline_accurate_1d 现有 6768 行
```
`[来源: fixup/v3_init.err；同构读数亦见 impl/V1_shell_gate_final.log、verify/A2_init_run1.txt]`

契约要素（逐字节选）：只播 **4 张表**；活库 `public` 共 **37** 张关系 = 26 表 + 11 视图（`r|26` / `v|11` 实测分组）；**从活库只读快照**（`PGOPTIONS='-c default_transaction_read_only=on'`）；**目标表非空即跳过**；**活库演进后需重新供应**（dropdb + 重跑）`[来源: fixup/EVIDENCE.md §F1]`

> 派单项要求口径将 4 张表行数记为 `symbols=44 / strategy=23 / strategy_version=24 / kline_accurate=1,631,088`（派生 `1d`=6,768）——与上述原始读数逐项一致。

### 4.2 F2 — 源不可达 → exit 3 且**库清单无新库**

判据：修后「源库不可达」须 `exit 3` 且 `pg_database` 清单与基线 `diff` 无输出；修前对照只留 schema-only 脏库。
结论：**满足**。

修后（真实脚本）：
```
exit=3
[testdb-init] ❌ 源库 `eestock_nonexistent_xyz` 不可达：无法播种测试基线（测试库必须可用，否则集成测试会以难解方式失败）。
[testdb-init]    如源库不在默认位置，设 EESTOCK_TEST_DB_HOST/PORT/USER/PASSWORD 或 EESTOCK_LIVE_DB_NAME。
--- stdout:（空）
```
`[来源: fixup/V1.log、fixup/v1_after.err、fixup/v1_after.out（0 字节）]`
库清单（`fixup/db_list_before.txt` vs `db_list_after_fixed.txt` vs `db_list_final_v1.txt`）：三份内容逐行相同 —— `adr023_e6b_gate_iso / adr023_e6b_v3_test / e6b_red_iso / e6b_red_iso2 / eestock / eestock_d11_probe / postgres / template0 / template1`，**无新库** `[来源: fixup/db_list_before.txt、fixup/db_list_after_fixed.txt、fixup/db_list_final_v1.txt、fixup/EVIDENCE.md §F2「V1: DB LIST IDENTICAL TO BEFORE」]`

修前对照（`mut_script/testdb-init-prefix.sh` = 同脚本仅去掉建库前预检）：同样 `exit=3`，但**留下** `adr023_e6b_f2_before_iso`（schema-only 脏库）：
```
[testdb-init] 迁移应用完成（账本 26 条）
[testdb-init] 哨兵表 `_eestock_test_db` 就绪（value=test）
[testdb-init] ❌ 源库 `eestock_nonexistent_xyz` 不可达：…
$ … select datname from pg_database order by 1 | grep f2_before
adr023_e6b_f2_before_iso          # ← 脏库（schema-only：select count(*) from symbols = 0）
```
`[来源: fixup/v1_before.err、fixup/db_list_after_prefix.txt、fixup/EVIDENCE.md §F2]`；该脏库已 `DROP DATABASE`，最终清单回到基线 `[来源: fixup/db_list_final_v1.txt]`

### 4.3 F4 — M3 登记（活库孤儿守卫迁移为运维检查，端点未部署线上仍 404）

判据：语义变更须在 README 明文登记，并给出替代判据与当前空窗。
结论：**满足**（`README.md:138` 新增「活库孤儿守卫的归属变更（M3 登记）」）。
关键读数（只读 GET，未重启/未杀 app）：
```
GET http://127.0.0.1:8081/api/quality/orphans -> 404
{"error":"not found"}
GET http://127.0.0.1:8080/api/quality/orphans -> 404
```
`[来源: fixup/EVIDENCE.md §F4、fixup/v4_live_after.log]`
登记要点（逐字节选）：判据 = 部署后对在线实例调 `GET /api/quality/orphans` 应为 `rows: 0`；当前该端点**尚未部署**（线上仍 404，见 ADR-023 R-4）；需运维在部署后手工执行并登记；不得把孤儿用例改回查活库 `[来源: fixup/EVIDENCE.md §F4]`

### 4.4 收尾修正后不回归

`fixup/v3_tests.log`：`passed=732 failed=0`（92 行 `test result: ok`）；shell 门禁 `PASS=7 FAIL=0 / VERDICT: GREEN` `[来源: fixup/v3_shellgate.log]`；`check-tangle` ✅ exit 0 `[来源: fixup/v3_checktangle.log]`；一次性库 `adr023_e6b_fixup_test` DROP 后清单回基线 `[来源: fixup/V3.log、fixup/db_list_after_v3.txt]`

本轮 5 个被编辑文件（收尾段自报，原始清单见证据）：`README.md` / `scripts/testdb-init.sh` / `crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs` / `crates/test-support/src/lib.rs` / `crates/web/tests/period30m_api_contract.rs` `[来源: fixup/EVIDENCE.md §V4、fixup/v4_repo_state.log、fixup/v4_scope.log]`；门禁文件本体哈希 `537bd03025bf30a4e1381c6c0b4b7370  crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs` `[来源: fixup/gate_orig.md5]`

---

## 5. 活库零变化（before/after 指纹 IDENTICAL）

判据：四段执行全程对活库 `eestock` 只读；before/after 快照一致。

**结论：IDENTICAL。**

实现自证段（`impl/V5_live_before.txt` 与 `impl/V5_live_after.txt` 经 `diff` 判为字节相同）：
```
## orphans_per_cagg   kline_accurate_5m=0 … kline_1d=0   （10 张 cagg 全 0）
## app_config         dcap  {"m": 3, "n_l": 66, "n_m": 36, "n_s": 8, "r_l": 1.0, "r_m": 1.0, "r_s": 1.0, "smooth": 1}
## symbols            count=44   95c8535651189b60954400cb3a4ea382
```
`[来源: impl/V5_live_before.txt、impl/V5_live_after.txt、impl/EVIDENCE.md §V5「live snapshot before/after diff --- IDENTICAL」]`

独立验收段（before=`live_*.txt` / after=`verify/A7_after.txt`）：10 张 cagg 孤儿全 0（before 与 after 均全 0）；`symbols=44 fp=ed61bd8d72b74c685f4685911efe0693`（before 同值）；`app_config_fp=fe3dbcbdf7a18743245cd8175d1b2b98`（before 同值，仅 `dcap` 一键）；`kline_accurate=16344861|2026-09-16 07:00:00+00`（before 同值）；`kline_raw=114841|2026-09-17 03:30:00+00`（before 同值）`[来源: verify/live_cagg_orphans.txt、live_symbols_count.txt、live_symbols_fp.txt、live_appconfig_fp.txt、live_ka.txt、live_kr.txt、verify/A7_after.txt、verify/EVIDENCE.md §A7]`

收尾修正段（04:18:04Z 与 04:24:12Z 两次只读复核）：
```
symbols=44 strategy=23 strategy_version=24 kline_accurate=16344861 kline_accurate_M1_518880_510050=1631088 kline_raw=114841
--- cagg 孤儿行（code 不在 symbols）：10 rows 全 0   TOTAL_ORPHANS=0
### 最终只读复核：symbols=44 kline_accurate=16344861 kline_raw=114841  TOTAL_ORPHANS=0
```
`[来源: fixup/v4_live_after.log]`

仓库侧零副作用（独立验收）：`git status --porcelain` 行数 97 与验收开始时一致；HEAD 未变；`git diff --cached` 为空 `[来源: verify/A8_git_status_now.txt、verify/git_head.txt、verify/git_staged.txt（0 字节）]`

---

## 6. 残留登记（如实，逐条交叉引用）

> 全部残留均**只登记、不修**。交叉引用：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §6.1 第 8 条（文件第 220 行，测试隔离债）与 `coder/report/295_adr023_e6b_impl_testdb_env_gate.md` 附录 A（第 132 行起，收尾修正 4 项的残留 A.3 第 1–4 条）。

| # | 残留 | 出处 |
|---|---|---|
| ① | **静态面分不清 lazy 的「不可达」/「活库」语义**（两者都是 URL）；靠「单一入口 `test_support::` + 不可达 URL 常量唯一落点」收束，替代探针是行为面（未设变量必须响亮失败 + 哨兵拦截）。若有人把 `UNREACHABLE_TEST_DB_URL` 改成活库地址，静态面抓不住 | `fixup/EVIDENCE.md §F3 末段`；`coder/report/295…md` 附录 A.3 第 1 条 |
| ② | **门禁去注释实现不认 raw string / 字符字面量**：`code_only()` 是简化实现（不识别 `r#"…"#` 与字符字面量）⇒ 若把入口串写进字符串字面量，静态面可能误判「已走入口」。R4 仍按原始源码扫描（活库字面量逃不掉），行为探针不受影响 | `coder/report/295…md` 附录 A.3 第 2 条 |
| ③ | **F2 采「预检提前」而非「失败即 DROP」**：只保证「源不可达不留新库」；若建库后**迁移中途**失败，仍可能留下半成品库（幂等可重跑，运维可 `dropdb` 重跑） | `coder/report/295…md` 附录 A.3 第 3 条；`fixup/EVIDENCE.md §F2` |
| ④ | **运维检查目前无人自动执行**（端点未部署，线上仍 404）—— M3 语义变更的已知空窗，需部署后手工执行 `GET /api/quality/orphans` 并登记 `rows: 0` | `coder/report/295…md` 附录 A.3 第 4 条；`fixup/EVIDENCE.md §F4`；`fixup/v4_live_after.log`（两个端口的 404 读数） |
| ⑤ | **测试库 1.63M 行、不可纯离线自举**：播种实测 `kline_accurate=1,631,088` 行；纯离线 CI 需另出静态 fixture（超本轮） | `verify/EVIDENCE.md §A9 第 2 条`；`verify/A2_counts.txt`、`fixup/v3_init.err` |
| ⑥ | **`crates/tushare/src/bin/tushare_sync.rs:23` 仍有活库兜底**（`src` 非测试 → R4 判据不覆盖；本轮 `git diff` 空、未被触碰；**只登记不改**） | `red/EVIDENCE.md §4/§7`；`verify/EVIDENCE.md §A5/§A9 第 3 条`；`coder/report/295…md` 附录 A.1「未改」 |
| ⑦ | **播种是活库快照，活库演进后需 `dropdb` + 重跑**：`symbols=44` / `strategy=23` 为活库快照；脚本按「目标非空即跳过」，故活库演进后需重建测试库方生效 | `verify/EVIDENCE.md §A9 第 6 条`；`fixup/EVIDENCE.md §F1`（README 已写明该契约） |

### 6.1 额外条目（不在派单 ①–⑦ 内，但证据文件中已登记，一并如实转记）

| # | 残留 | 出处 |
|---|---|---|
| ⑧ | **M3 语义漂移**：`orphan_probe/mod.rs` 与 `period30m_d2…live_snapshot` 由「查活库」改为「查测试库」⇒ 该「活库孤儿守卫」红测试自此不再观测活库（若活库再被污染，此测试无法发现）。F4 已把它迁移为运维检查（见 ④） | `verify/EVIDENCE.md §A5「语义注记」、§A9「漏报项 (M3)」；`fixup/EVIDENCE.md §F4` |
| ⑨ | **R1 判据非语义化**：修前可被「注释提及变量名」绕过（变异 B）；修后以去注释 `code_only()` + 「行为落点」断言补齐（见 ② 的实现边界） | `verify/EVIDENCE.md §A4 变异 B、§A9 (M4)`；`fixup/EVIDENCE.md §F3` |
| ⑩ | **测试池未运行级验证的 crate**：`crates/web` / `crates/mcp` / `crates/strategy-runtime` 在红阶段只见静态面（时间盒限制）；绿阶段全量 `--workspace` 已覆盖（见 §2.2） | `red/EVIDENCE.md §7 第 6 条` |
| ⑪ | **R1 行为断言依赖已编译测试二进制**（`target/debug/deps` 取最新 mtime）；缺二进制时报「harness 前提缺失」而非红 —— 运行前先 `--no-run` | `red/EVIDENCE.md §7 第 3 条` |
| ⑫ | **`scripts/testdb-init.sh` 的库名覆盖变量名**由 tester 侧 shell 测试钉为 `EESTOCK_TEST_DB_NAME`（默认 `eestock_test`）；若实现方改名需同步该 shell 测试 | `red/EVIDENCE.md §7 第 4 条` |
| ⑬ | **数据前提失败**：一致性空库（仅迁移、无行情/种子）下 `cargo test -p storage` 存在 3 例既有数据前提失败（`for_symbol_resolves_profile_by_type_and_misses_fail_soft`、`merged_1m_branch_index_limit_performance`、`migration_0025_idempotent_backfill_and_seed_in_rolled_back_tx`），红阶段基线与加新文件后同名同数 ⇒ 非本轮引入；由供应脚本播种基线后消失 | `red/EVIDENCE.md §6/§7 第 1 条`；`red/baseline_storage_iso.txt`、`red/regression_after.txt` |

---

## 7. 是否有证据已丢失

**结论：没有。四段证据目录全部存在，判据承载件已全部落库。**

- `/tmp/adr023-e6b-red-20260917T034707Z`：存在 → 14/14 全量归档
- `/tmp/adr023-e6b-impl-20260917T035254Z`：存在 → 24/24 全量归档
- `/tmp/adr023-e6b-verify-20260917-120416`：存在 → 62/62 全量归档
- `/tmp/adr023-e6b-fixup-20260917T041228Z`：存在 → 51/3431 有意取舍（排除 3380 个文件：`tree_*` 整仓副本 12 份、`gate_bin_old/new`+`fake_deps` 二进制 3 份、`migrations` 符号链接 1 份；牺牲的仅为**可由 `gate_orig.rs`/`gate_orig.md5`+仓库重建的编译产物**与整仓镜像，六格矩阵的全部输入与输出（变异体源码、修前脚本、门禁源、12 次运行结果）均已落库）
- `/tmp/adr023-e6b-verify-1789617852`：**空目录**（0 文件），非「丢失」，是「从未产出内容」
- `/tmp/adr023-e6b-red-TS.txt`：存在，内容仅 `20260917T034707Z`（指针），内容已逐字转记于 `tester/evidence/adr023_e6b/README.md`

**已丢失/无从复核的项**：无（唯一不可复核的方式是「用归档前的二进制重跑变异」，但矩阵结论可由归档的变异体源码 + 门禁源码重建）。

---

## 附录 A — 归档文件清单（相对 `tester/evidence/adr023_e6b/`）

- `README.md`（本归档说明，含取舍与来源对照）
- `red/`：`EVIDENCE.md`、`red_gate_run.txt`、`r3_shell_gate.txt`、`r5_mutation_result.txt`、`r1_run.txt`、`r1b_run.txt`、`r2_run.txt`、`r2_sentinel_absent_count.txt`、`live_sentinel_count.txt`、`r3_feasibility_probe.txt`、`baseline_storage_iso.txt`、`regression_after.txt`、`r5_mutation/probe_gate.sh`、`r5_mutation/probe_gate_mutated.sh`
- `impl/`：`EVIDENCE.md`、`V1_red_before.log`、`V1_red_shell_before.log`、`V1_green_gate.log`、`V1_green_gate_final.log`、`V1_shell_gate.log`、`V1_shell_gate_final.log`、`V2_check_tangle.log`、`V2_check_tangle_final.log`、`V3_workspace_tests.log`、`V3_workspace_tests_after.log`、`V5_rerun_tests.log`、`V4a_evidence.txt`、`V4a_unset.log`、`v4a.out`、`V4b_evidence.txt`、`V4b_live.log`、`v4b.out`、`V5_live_before.txt`、`V5_live_after.txt`、`seed_run1.log`、`docfirst_evidence.txt`、`tangle_output.log`、`mtime_before_tangle.txt`
- `verify/`：`EVIDENCE.md`、`git_head.txt`、`git_staged.txt`、`A1_case1{,_rc}.txt`、`A1_case2{,_rc}.txt`、`A2_{init_run1,init_run2,counts,isolation,dblist,dblist_after,workspace_rc,workspace_results,workspace_tests}.txt`、`A2_run{1,2}.{stdout,stderr}`、`A3_unreachable.txt`、`A3_unreach.{stdout,stderr}`、`A4_{mutation,mutation_rc,mutation_final,mutation_final_rc,mutation_evade,mutation_evade_rc,mutation2,mutation2_rc,mutation3,mutation4,mutation_lazy_alone,mutation_lazy_alone_rc,mutation_build,build_norun,poolbuilding}*.txt/.log`、`A5_{files,removed,orphan_diff,period30m_diff}.txt`、`A6_{build,build_rc,check_tangle,check_tangle_rc,docfirst,vitest,vitest_rc}.txt`、`A7_after.txt`、`A8_{git_status_now,side,tree}.txt`、`live_{appconfig,appconfig_count,appconfig_fp,cagg_orphans,caggs,ka,kr,symbols_count,symbols_fp}.txt`
- `fixup/`：`EVIDENCE.md`、`baseline_meta.txt`、`build_{old,new}.log`、`db_list_{before,after_fixed,after_prefix,after_v3,final_v1}.txt`、`diffs.txt`、`gate_orig.{rs,md5}`、`gate_bin_{old,new}_path.txt`、`V1.log`、`v1_{before,after}.{out,err}`、`V3.log`、`v3_{init,init2}.{out,err}`、`v3_{tests,shellgate,checktangle}.log`、`v4_{changed_tracked.txt,final_state.log,live_after.log,repo_state.log,scope.log}`、`old_run_{base,mut1..mut5}.log`、`new_run_{base,mut1..mut5,realrepo}.log`、`mutations/zz_mut{1..5}*.rs`、`mut_script/testdb-init-prefix.sh`

（精确字节数与逐目录核对见 `tester/evidence/adr023_e6b/README.md`。归档总计 152 文件 / 655,595 字节。）

## 附录 B — 被归档证据所对应的执行主体

| 段 | 执行角色 | 原始 EVIDENCE.md |
|---|---|---|
| red | Tester（红测试设计 + 执行） | `red/EVIDENCE.md`（原 `/tmp/adr023-e6b-red-20260917T034707Z/EVIDENCE.md`） |
| impl | Coder（实现自证） | `impl/EVIDENCE.md`（原 `/tmp/adr023-e6b-impl-20260917T035254Z/EVIDENCE.md`） |
| verify | 独立 Tester（只验不改）；其自评 `VERDICT: PASS`，唯一未满足项为当时 README 缺「播种内容与行数」（后由 F1 补齐） | `verify/EVIDENCE.md`（原 `/tmp/adr023-e6b-verify-20260917-120416/EVIDENCE.md`） |
| fixup | Coder（收尾修正 4 项 F1/F2/F3/F4） | `fixup/EVIDENCE.md`（原 `/tmp/adr023-e6b-fixup-20260917T041228Z/EVIDENCE.md`） |

## 附录 C — 本次归档动作执行过的命令（只读 / 只新增 `tester/` 文件）

```
ls -d /tmp/adr023-e6b-* ; du -sh /tmp/adr023-e6b-*
find <各 /tmp 证据目录> -type f -printf '%10s  %p\n'      # 目录清点
cp -p /tmp/adr023-e6b-{red,impl,verify,fixup}-<TS>/<关键文本证据> tester/evidence/adr023_e6b/{red,impl,verify,fixup}/
md5sum / diff                                             # 逐字读数核对（V5_live_before vs _after = IDENTICAL）
# 未执行：git add / git commit / git stash；未改 design/、实现代码、既有测试；未对活库 eestock 写
```
