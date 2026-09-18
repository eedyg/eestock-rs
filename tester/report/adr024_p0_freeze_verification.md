# ADR-024 P0 冻结前最终定向复验报告（tester，只验不改）

- **报告自身路径（self-location）**：`tester/report/adr024_p0_freeze_verification.md`（本文件，权威交付路径）
- **证据目录**：`tester/evidence/247_adr024_p0_freeze/`（索引见该目录 `EVIDENCE.md`）
- **执行者 / 时间**：tester（独立复跑，**未复用任何 worker 输出**）；2026-09-18 13:01:20 → 13:04:41 +0800
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（**未变**，未 commit）
- **被测交付**：**仅 index**（staged 55 files, +3464/−56）；工作区未 staged 3 条（既有/并发，见 §5）
- **纪律**：未改生产代码、未 `git add` / `git commit`、未新建数据库；一切扰动均为**临时**且在同一执行块内复原（triple proof：sha256 + `git diff` 空 + index blob 一致）

---

# 判词：**PASS** —— **P0 可以冻结**

**4 项任务全部达成，未过项：0 条。**

| # | 任务项 | 判词 | 关键原始证据 |
|---|---|---|---|
| ① | 独立复现 `TestRunPanel.test.tsx` 的可证伪性（自扰动，不复用 worker） | **PASS** | 删 `'M30'` ⇒ **1 failed / 6，EXIT=1**；复原 ⇒ 6/6, EXIT=0；`periods.ts` / `ConfigPanel.test.tsx` 逐字未变 |
| ② | 定向跑断言文件（Rust 3 + 前端 3 + 前端全量） | **PASS** | Rust **6+5+4=15** 全绿；前端定向 **22/22**；前端全量 **89 files / 850 tests**（不减） |
| ③ | **干净检出模拟（决定性证据）** | **PASS** | 纯 index 导出树内：Rust **6+5+4=15 全绿**、前端 **22/22 全绿**；负向对照（移走契约向量）⇒ Rust **EXIT=101**（ENOENT 带导出树路径）/ 前端 **EXIT=1** |
| ④ | 冻结前越界核对（最终快照） | **PASS** | index **恰好 = 声明的 55 条**（`diff` 空）；禁改常数三方一致；禁改路径 staged diff 全空 |

**「可否冻结 P0」的明确结论**：**可以**。①~④ 的原始输出均支持"只提交 index 即可、干净检出无缺失输入、无越界改动、无恒真断言残留"。**另有 3 条观察（O1~O3，均非阻塞）见 §5** ——其中最需知悉的是 O1：整改单 #2 的**报告文件** `coder/report/adr024_p0_rect2_testrunpanel.md` 未入 index（纯文档完整性，其描述的代码整改已入 index，且本报告 §1 已独立复现其修复效果）。

---

## 1. 任务① 独立复现 TestRunPanel 的可证伪性 —— **PASS**

> 本项**全为本任务自跑**，未读取/未复用 `coder/report/adr024_p0_rect2_testrunpanel.md` 的任何输出（该报告仅是任务背景；其结论在本节被独立复现）。

### 1.1 三段闭环（GREEN → RED → 复原 GREEN）

**(a) 扰动前（基线绿）** `web/`：
```
$ npx vitest --version        → vitest/3.2.7 linux-x64 node-v22.22.2
$ sed -n '17p' src/features/backtest/periods.ts
export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'M30', 'H1', 'D1'] as const;

$ npx vitest run src/features/strategies/TestRunPanel.test.tsx
 ✓ src/features/strategies/TestRunPanel.test.tsx (6 tests) 158ms
 Test Files  1 passed (1)      Tests  6 passed (6)
PRE_EXIT=0
```
（`01_A_pre_green_testrunpanel.txt`）

**(b) 扰动：删掉 `SUPPORTED_BACKTEST_PERIODS` 里的 `'M30'` ⇒ 目标用例必须变红 —— 确实红**：
```
$ sed -i "s/'M1', 'M5', 'M15', 'M30', 'H1', 'D1'/'M1', 'M5', 'M15', 'H1', 'D1'/" web/src/features/backtest/periods.ts
$ sed -n '17p' web/src/features/backtest/periods.ts
export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'H1', 'D1'] as const;
$ sha256sum web/src/features/backtest/periods.ts      # 扰动态（临时）
2dc4a4f63e113f5ae8408ead6ecba31e3a8e8417ad242c91fecca2f7f3809fe4

$ npx vitest run src/features/strategies/TestRunPanel.test.tsx
 ❯ src/features/strategies/TestRunPanel.test.tsx (6 tests | 1 failed) 171ms
   × TestRunPanel（试算面板：…） > 周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望） 24ms
     → expected [ 'M1', 'M5', 'M15', 'H1', 'D1' ] to deeply equal [ Array(6) ]
…
 FAIL  src/features/strategies/TestRunPanel.test.tsx > … > 周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望）
AssertionError: expected [ 'M1', 'M5', 'M15', 'H1', 'D1' ] to deeply equal [ Array(6) ]
-   "M30",
 ❯ src/features/strategies/TestRunPanel.test.tsx:41:50
 Test Files  1 failed (1)      Tests  1 failed | 5 passed (6)
RED_EXIT=1
```
（`01_B_perturb.txt`）——**失败恰为目标 1 条**（其余 5 条照常绿），且失败原因正是期望向量含 `M30` 而渲染下拉不含。

**同一扰动窗口内的旁证（激励 D1/D2 整改的原始缺陷面）**：
```
$ npx vitest run src/features/backtest/periods.test.ts src/features/workbench/ConfigPanel.test.tsx
 ❯ src/features/backtest/periods.test.ts (3 tests | 2 failed)
   × SUPPORTED_BACKTEST_PERIODS == contract-vectors.json::backtest_periods（逐字相等）
   × 集合为契约六档（含 M30），顺序即展示序
 ❯ src/features/workbench/ConfigPanel.test.tsx (13 tests | 1 failed)
   × 周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望）
 Test Files  2 failed (2)      Tests  3 failed | 13 passed (16)
BONUS_RED_EXIT=1
```
（`01_B_bonus_and_01_C_restore.txt`）⇒ **上一轮 D1（`periods.test.ts`）与 D2（`ConfigPanel.test.tsx`）两处恒真断言均已修复**：现在对 `M30` 成员资格**敏感**。

**(c) 复原 ⇒ 回绿**：
```
$ cp /tmp/adr024_frz/periods.ts.baseline web/src/features/backtest/periods.ts
$ sed -n '17p' src/features/backtest/periods.ts
export const SUPPORTED_BACKTEST_PERIODS = ['M1', 'M5', 'M15', 'M30', 'H1', 'D1'] as const;
$ sha256sum src/features/backtest/periods.ts
04b540dedf18f1e55625bbf0f6726077c8bc2f94dc69f691e2ad6a095d99f14a     ← 与扰动前基线逐字相同

$ npx vitest run src/features/strategies/TestRunPanel.test.tsx
 ✓ src/features/strategies/TestRunPanel.test.tsx (6 tests) 161ms
 Test Files  1 passed (1)      Tests  6 passed (6)
GREEN_EXIT=0
```
（`01_B_bonus_and_01_C_restore.txt`）

### 1.2 `periods.ts` 与 `ConfigPanel.test.tsx` 逐字未变（vs index blob）

```
--- sha256：磁盘（复原后） vs 扰动前备份 ---
04b540de…d99f14a  web/src/features/backtest/periods.ts
04b540de…d99f14a  /tmp/adr024_frz/periods.ts.baseline            → 相同
8c8b819c…22d3c0788  web/src/features/workbench/ConfigPanel.test.tsx
8c8b819c…22d3c0788  /tmp/adr024_frz/ConfigPanel.test.tsx.baseline → 相同

$ diff -u /tmp/adr024_frz/periods.ts.baseline web/src/features/backtest/periods.ts
(no diff: periods.ts byte-identical to pre-window backup)

$ git diff -- web/src/features/backtest/periods.ts web/src/features/workbench/ConfigPanel.test.tsx
[空输出；exit=0 —— worktree == index，零字节差异]

$ for f in periods.ts ConfigPanel.test.tsx; do echo idx=$(git rev-parse :$f) disk=$(git hash-object $f); done
web/src/features/backtest/periods.ts                  idx=799c18cc4aeea82a568f0a89ecb4fb3a2fe22a44 disk=… SAME=YES
web/src/features/workbench/ConfigPanel.test.tsx       idx=a96358690c9bcc36c0223228d82e6af8858fd0a9 disk=… SAME=YES

$ git diff --cached --name-status -- <两文件>
A	web/src/features/backtest/periods.ts            ← index 条目（与上轮一致）
M	web/src/features/workbench/ConfigPanel.test.tsx ← index 条目（与上轮一致）
```
（`01_D_unchanged_proof.txt`）

> **index 未被本任务改动的强证据**：`sha256(git diff --cached)` 在 13:01:47（①窗口结束）与 13:04:41（全部任务+清理后）**完全相同** = `8f70a57a8db5ae9f0ff4105ffc2255856f39e919932088648f354199156c095b`（`01_D` §D.8、`05_cleanup_and_integrity.txt`）。staged 文件数全程 = **55**。

---

## 2. 任务② 定向跑断言文件（贴输出与退出码）—— **PASS**

| # | 命令 | 原始结果 | 退出码 | 证据 |
|---|---|---|---|---|
| 1 | `cargo test -p application --test backtest_periods_ssot` | `6 passed; 0 failed; 0 ignored` | **0** | `02_A_…txt` |
| 2 | `cargo test -p mcp --test adr024_period_ssot_drift` | `5 passed; 0 failed; 0 ignored` | **0** | `02_B_…txt` |
| 3 | `cargo test -p web --test adr024_workbench_period_ssot` | `4 passed; 0 failed; 0 ignored` | **0** | `02_C_…txt` |
| 4 | `npx vitest run`（3 个前端断言文件） | `3 passed (3) files / 22 passed (22) tests` | **0** | `02_D_…txt` |
| 5 | `npx vitest run`（前端全量） | `89 passed (89) files / 850 passed (850)` | **0** | `02_E_…txt` |

### 2.1 Rust（原始输出）

```
$ cargo test -p application --test backtest_periods_ssot
running 6 tests
test dashboard_and_non_backtest_tiers_still_rejected ... ok
test every_ssot_period_parses_roundtrip ... ok
test m30_maps_to_both_m30_variants ... ok
test ssot_is_the_canonical_six_tier_set ... ok
test ssot_has_no_duplicates ... ok
test ssot_matches_contract_vectors_backtest_periods ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
EXIT=0

$ cargo test -p mcp --test adr024_period_ssot_drift
running 5 tests
test backend_ssot_matches_frontend_mirror ... ok
test backend_ssot_matches_contract_vectors ... ok
test all_four_period_sources_are_byte_equal ... ok
test mcp_schema_enums_match_backend_ssot ... ok
test mcp_source_derives_from_ssot_not_handwritten ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
EXIT=0

$ cargo test -p web --test adr024_workbench_period_ssot
running 4 tests
test web_source_has_no_hardcoded_period_whitelist ... ok
test unknown_period_still_rejected_400 ... ok
test w1_still_rejected_400_with_period_message ... ok
test m30_passes_web_period_gate_not_400 ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.00s
EXIT=0
```

### 2.2 前端（原始输出）

```
$ npx vitest run src/features/backtest/periods.test.ts src/features/strategies/TestRunPanel.test.tsx src/features/workbench/ConfigPanel.test.tsx
 ✓ src/features/backtest/periods.test.ts (3 tests) 2ms
 ✓ src/features/strategies/TestRunPanel.test.tsx (6 tests) 164ms
 ✓ src/features/workbench/ConfigPanel.test.tsx (13 tests) 697ms
 Test Files  3 passed (3)      Tests  22 passed (22)
EXIT=0

$ npx vitest run            # 前端全量
 Test Files  89 passed (89)  Tests  850 passed (850)
EXIT=0
```
**用例数不减**：850（本轮） == 850（上一轮 P0 验收） == 850（worker 声称）；文件数 89 == 89。

（补充：`npx tsc -b` → `TSC_EXIT=0`，`04_E_tsc_build.txt`。）

---

## 3. 任务③【关键】干净检出模拟 —— **PASS（决定性）**

### 3.1 干净检出导出（纯 index）

```
$ rm -rf /tmp/adr024_clean_frz01 && mkdir -p /tmp/adr024_clean_frz01
$ git checkout-index -a --prefix=/tmp/adr024_clean_frz01/
EXPORT_EXIT=0        （导出 129M；含 Cargo.lock，不含任何 gitignored 产物）
```

### 3.2 4 个断言的**运行期输入**在该导出树里存在（逐条 `test -f`）

```
test -f design/16-backtest-scalability/contract-vectors.json            => PRESENT  (1678 bytes)
test -f crates/application/tests/backtest_periods_ssot.rs               => PRESENT  (4184 bytes)
test -f crates/mcp/tests/adr024_period_ssot_drift.rs                    => PRESENT  (6184 bytes)
test -f web/src/features/backtest/periods.test.ts                       => PRESENT  (1846 bytes)
--- 传递性运行期输入 ---
test -f web/src/features/strategies/TestRunPanel.test.tsx               => PRESENT
test -f web/src/features/workbench/ConfigPanel.test.tsx                 => PRESENT
test -f web/src/features/backtest/periods.ts                            => PRESENT
test -f crates/mcp/src/tools.rs                                         => PRESENT
test -f crates/web/src/workbench.rs                                     => PRESENT
--- 未入 index（gitignored，预期缺席，仅登记）---
test -e web/dist          => ABSENT
test -e web/node_modules  => ABSENT
test -e target            => ABSENT
```

**导出树 blob == index blob（逐字）**：`contract-vectors.json`、4 个断言文件、`periods.ts`、两个组件 —— **全部 SAME=YES**（`4bcaf350` / `7de0f1f4` / `b5586ad4` / `8eb8c80f` / `fe91ef4` / `a9635869` / `799c18cc`）。

**路径解析（与测试源码同表达式）**：
```
crates/application/tests/backtest_periods_ssot.rs:19  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../design/16-backtest-scalability/contract-vectors.json")
crates/mcp/tests/adr024_period_ssot_drift.rs:31       … .join("../../design/16-backtest-scalability/contract-vectors.json")
crates/mcp/tests/adr024_period_ssot_drift.rs:46       … .join("../../web/src/features/backtest/periods.ts")
$ realpath -e /tmp/adr024_clean_frz01/crates/application/../../design/16-backtest-scalability/contract-vectors.json
/tmp/adr024_clean_frz01/design/16-backtest-scalability/contract-vectors.json      → 解析成功
$ realpath -e /tmp/adr024_clean_frz01/crates/mcp/../../design/16-backtest-scalability/contract-vectors.json
/tmp/adr024_clean_frz01/design/16-backtest-scalability/contract-vectors.json      → 解析成功
```
（`03_A_clean_checkout_export.txt`）

### 3.3 在导出树里**真跑**（不是"仅文件存在"）—— 全部可行

**(a) Rust：在导出树内**从零编译**（`CARGO_TARGET_DIR` 为空目录，`rm -rf` 后启动）**：
```
$ cd /tmp/adr024_clean_frz01
$ CARGO_TARGET_DIR=/tmp/adr024_clean_target cargo test -p application --test backtest_periods_ssot
   Compiling backtest v0.1.0 (/tmp/adr024_clean_frz01/crates/backtest)
   … domain / strategy-runtime / strategy-core / simlive / application …
    Finished `test` profile [unoptimized + debuginfo] target(s) in 7.27s
     Running tests/backtest_periods_ssot.rs (/tmp/adr024_clean_target/debug/deps/backtest_periods_ssot-09b3f9833a545c5e)
running 6 tests … test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured
CLEAN_TREE_RUST_EXIT=0
```
（编译日志 82 行、target 从 0 → 490M ⇒ 确为**全新编译**；path 依赖全部位于导出树内部，**无需指向工作区**。）

**(b) Rust：导出树内另两条断言同样绿**：
```
$ CARGO_TARGET_DIR=… cargo test -p mcp --test adr024_period_ssot_drift
test result: ok. 5 passed; 0 failed; 0 ignored          CLEAN_TREE_MCP_EXIT=0
$ CARGO_TARGET_DIR=… cargo test -p web --test adr024_workbench_period_ssot
test result: ok. 4 passed; 0 failed; 0 ignored          CLEAN_TREE_WEB_EXIT=0
```
（`03_E_…txt`；导出树无 `web/dist` 也不影响 web gate 的 4 条断言。）

**(c) 前端：导出树内跑 3 个断言**（`node_modules` 为 symlink，属构建产物、非提交物）：
```
$ cd /tmp/adr024_clean_frz01/web && ln -sfn <worktree>/web/node_modules node_modules
$ npx vitest run src/features/backtest/periods.test.ts src/features/strategies/TestRunPanel.test.tsx src/features/workbench/ConfigPanel.test.tsx
 RUN  v3.2.7 <CLEAN_TREE>/web
 ✓ src/features/backtest/periods.test.ts (3 tests)
 ✓ src/features/strategies/TestRunPanel.test.tsx (6 tests)
 ✓ src/features/workbench/ConfigPanel.test.tsx (13 tests)
 Test Files  3 passed (3)      Tests  22 passed (22)
CLEAN_TREE_TS_EXIT_RAW=0
```
（`03_B_…txt`）

### 3.4 负向对照：证明"读不到契约向量"确实会报错，且读的**就是**导出树那份

```
$ strings -a /tmp/adr024_clean_target/debug/deps/backtest_periods_ssot-09b3f9833a545c5e | grep …
/tmp/adr024_clean_frz01/crates/application../../design/16-backtest-scalability/contract-vectors.json…
  → 编译期内嵌 CARGO_MANIFEST_DIR = 导出树 ⇒ 运行期读取目标 = 导出树文件（非工作区副本）

$ mv /tmp/adr024_clean_frz01/design/16-backtest-scalability/contract-vectors.json /tmp/cv.hidden
$ CARGO_TARGET_DIR=… cargo test -p application --test backtest_periods_ssot
test ssot_matches_contract_vectors_backtest_periods ... FAILED
---- stdout ----
thread 'ssot_matches_contract_vectors_backtest_periods' panicked at crates/application/tests/backtest_periods_ssot.rs:26:29:
契约向量文件不可读 /tmp/adr024_clean_frz01/crates/application/../../design/16-backtest-scalability/contract-vectors.json：No such file or directory (os error 2)
test result: FAILED. 5 passed; 1 failed; 0 ignored
NEGATIVE_CONTROL_EXIT=101

$ mv …back ; $ git hash-object /tmp/adr024_clean_frz01/design/.../contract-vectors.json
4bcaf35085da20145695b4e0fba14555a2dcd4ee     ← == index blob
$ cargo test …  → test result: ok. 6 passed; 0 failed      RESTORE_EXIT=0

--- 前端同型负向对照（导出树）---
$ npx vitest run <3 files>
 FAIL src/features/backtest/periods.test.ts  Error: ENOENT: no such file or directory, open '<CLEAN_TREE>/design/16-backtest-scalability/contract-vectors.json'
 FAIL src/features/strategies/TestRunPanel.test.tsx   （同 ENOENT）
 FAIL src/features/workbench/ConfigPanel.test.tsx     （同 ENOENT）
 Test Files  3 failed (3)      Tests  no tests          TS_NEGATIVE_EXIT=1
$ 复原后 → Test Files 3 passed (3) / Tests 22 passed (22)   TS_RESTORE_EXIT=0
```
（`03_D_…txt`、`03_F_…txt`）

### 3.5 对"发现②"那个失败模式的**结论**

> **问：只提交 index，干净检出会不会因读不到契约向量而报错？**
>
> **答：不会。** 决定性证据三条：
> 1. **输入在 index**：`contract-vectors.json` 的 index blob（`4bcaf350…`）与工作区、与导出树**逐字相同**，且 `git checkout-index -a` 已把它带进纯 index 检出树（§3.2）。
> 2. **真跑通过**：在该导出树内（Rust 全新编译 + 前端 symlink 依赖）**4 个断言的 15 条 Rust + 22 条前端用例全绿、退出码 0**（§3.3）。
> 3. **依赖是真的、也是硬的**：把该文件移走 ⇒ Rust `exit 101`（panic 文案含导出树绝对路径 ENOENT）、前端 3 文件 `exit 1`（ENOENT，命中导出树路径）（§3.4）。即"发现②"的失败模式**真实存在**（若 `design/16/**` 未入 index，则**必然红**），而架构师已把它入 index，**该失败模式已被消除**。

---

## 4. 任务④ 冻结前越界核对（最终快照）—— **PASS**

### 4.1 `git diff --cached --name-only` 全量（55 条）与逐类计数

```
coder/**              : 26   （24 条 evidence/adr024_p0_m30 + coder/report/adr024_p0_m30.md + coder/report/adr024_p0_rectification.md）
design/16-.../**      : 5    （01-adr / 02-spec / 03-test-plan / 04-implementation-plan / contract-vectors.json）
design/02-domain/     : 1    （contracts.md）
design/07-app-plane/  : 1    （01-mcp.md）
design/ (other)       : 0
crates/**             : 11   （application×4 / backtest×1 / domain×1 / mcp×2 / storage×1 / web×2）
web/**                : 11   （api×3 / features/backtest×4 / features/strategies×2 / features/workbench×2）
other                 : 0    （无 tester/、migrations/、scripts/、config/、deploy/、.github/、data/）
合计                  : 55
```
（全量清单见 `04_A_index_surface_full.txt`）

**相对上一轮验收（48 条）的增量逐条可解释**：`+5` = `design/16-backtest-scalability/**`（架构师亲自入 index）；`+1` = `web/src/features/backtest/periods.test.ts`（**D1 整改**）；`+1` = `coder/report/adr024_p0_rectification.md`（整改单#1 报告）。48+7 = **55** ✓（与整改单#2 报告 §6.1 的"55"一致）。

### 4.2 禁改项：常数**值**无 diff

```
$ git diff --cached -U0 -- crates/ | grep -E '^[-+].*(MINUTE_MAX_SPAN_DAYS|D1_MAX_SPAN_DAYS|MAX_BARS)'
(no output；grep exit=1 → staged diff 无任何提及这三个常数的 +/- 行)

常数定义 HEAD / INDEX / WORKTREE 三方逐字比对：
 MINUTE_MAX_SPAN_DAYS : pub const MINUTE_MAX_SPAN_DAYS: i64 = 93;         sha16 ac01c6d0c488efec ×3  IDENTICAL=YES
 D1_MAX_SPAN_DAYS     : pub const D1_MAX_SPAN_DAYS: i64 = 366 * 5;        sha16 a9ba2649a8f8203f ×3  IDENTICAL=YES
 MAX_BARS             : pub const MAX_BARS: usize = 200_000;               sha16 745f1cbb70110331 ×3  IDENTICAL=YES
```
（`04_B_forbidden_items.txt`）——`strategy.rs` 虽在 staged 内，但改动**仅注释文字**（`M1/M5/M15` → `M1/M5/M15/M30`）与穷尽性说明，**值行原样**；含 `MAX_BARS` 的 `crates/application/src/workbench.rs` **完全不在 staged 清单**。

### 4.3 禁改路径：staged diff 全空

```
$ git diff --cached --name-only -- crates/strategy-core        → (空)
$ git diff --cached --name-only -- crates/strategy-runtime     → (空)
$ git diff --cached --name-only -- crates/storage/src/workbench.rs → (空)
$ git diff --cached --stat -- <同 3 条>                         → (空)
$ git diff --name-only -- <同 3 条>                             → (空)   # worktree == index
$ git diff HEAD --name-only -- <同 3 条>                        → (空)   # 亦无未 staged 改动
$ git diff --cached --name-only | grep -E '^crates/(strategy-core|strategy-runtime)/|^crates/storage/src/workbench.rs'
(grep exit=1 → index 内不存在这三个禁改路径的任何条目)
```
**附**：`docker-compose.yml`（ADR-025 车道的 `max_worker_processes=32`）**未被 stage**：`git status --porcelain -- docker-compose.yml` = `" M docker-compose.yml"`（未 staged 工作区改动）。

### 4.4 反向核对：index 中**不存在未声明的本批文件**（防"多提"）

以显式声明清单（55 条，含 P0 源码/测试 11 + 前端 11 + design 7 + coder 26）与 index 实际逐条做集合比对：

```
$ wc -l declared.sorted actual.sorted
  55 /tmp/declared.sorted
  55 /tmp/actual.sorted
$ diff declared.sorted actual.sorted
(no output; diff exit=0)  → index **恰好等于**声明的 P0 交付面
$ git diff --cached --name-only | grep -vE '^(coder/evidence/adr024_p0_m30/|coder/report/adr024_p0_(m30|rectification)\.md$|crates/(application|backtest|domain|mcp|storage|web)/|design/(02-domain/contracts\.md|07-app-plane/01-mcp\.md|16-backtest-scalability/)|web/src/)'
(空 → 无任何越界/异车道条目)
```
（`04_C_reverse_declared_check.txt`）

### 4.5 终态快照

```
$ git rev-parse HEAD                      → 18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f（未变）
$ git log -1 --oneline                    → 18d1b9a docs(report): ADR-023 E6b 第二刀的报告与四段验收证据
$ git diff --cached --name-only | wc -l   → 55
$ git diff --cached --shortstat           → 55 files changed, 3464 insertions(+), 56 deletions(-)
$ git status --porcelain | wc -l          → 122   （staged 55 / unstaged 3 / untracked 64）
$ git status --porcelain | grep '^ M'     → design/01-architecture/adr/ADR-023-period-set-extension-30m.md
                                            design/99-decisions-log.md
                                            docker-compose.yml
$ 4 断言文件 + periods.ts + contract-vectors.json：disk blob == index blob 全部 SAME=YES
$ sha256sum web/src/features/backtest/periods.ts → 04b540de…d99f14a（== 基线，扰动已完全复原）
$ grep -c "'M30'" web/src/features/backtest/periods.ts → 1（含 M30）
```
（`04_F_final_snapshot.txt`、`05_cleanup_and_integrity.txt`）

---

## 5. 观察与登记（非门禁失败项，逐条附原始输出）

| # | 观察 | 严重度 | 是否影响"可冻结 P0" | 原始输出 |
|---|---|---|---|---|
| **O1** | 整改单 #2 的**报告文件** `coder/report/adr024_p0_rect2_testrunpanel.md` 仍为 **untracked**，**未入 index**（其描述的代码整改 `TestRunPanel.test.tsx` 已入 index，blob `fe91ef4`） | 低（纯文档完整性） | **否**（不改变任何测试输入与门禁；本报告已独立复现其 F1 修复效果，见 §1） | `04_C_reverse_declared_check.txt` §C.4 |
| **O2** | 本任务窗口内（13:00:54）`design/99-decisions-log.md` 被**并发**修改（+23 行，ADR-024/ADR-025 决策日志条目），当前为 **unstaged**；另两条 unstaged 为既有改动（`ADR-023…md`、`docker-compose.yml`）。三者**均不在 index** | 低（信息：工作区非冻结态≠提交面） | **否**（冻结面 = index；`git diff --cached` 哈希在窗口内恒定 `8f70a57a…`，未被这些改动污染） | `01_E_…txt`、`04_F_…txt` |
| **O3** | **契约向量已成为跨层测试夹具**：4 个断言文件（3 Rust + 3 前端代码路径）在**运行期**硬依赖 `design/16-backtest-scalability/contract-vectors.json`（缺则 Rust exit 101 / 前端 exit 1，见 §3.4）。这意味着"仅提交代码、略过 `design/**`"的任何提交切分都会**必然红** | 中（治理，非缺陷） | **否**（当前 index 恰好含该文件，P0 冻结不受影响） | `03_D_…txt`、`03_F_…txt` |

**未发现任何与 worker 报告不符之处**（逐条对照见 §7）。

---

## 6. 纪律与收尾合规

| 纪律 | 落实 |
|---|---|
| 不改生产代码 | 仅执行任务①要求的**临时扰动**（`periods.ts` 删 `M30`）与任务③的**临时负向对照**（在**临时导出树**内移走契约向量），全部在同一执行块内复原；每次均给 sha256 前后一致 + `git diff` 空 + index blob 不变（§1.2、§3.4） |
| 不 `git add` / `git commit` | 未执行任何 index 写操作；staged 数 55 全程不变；`sha256(git diff --cached)` 在 13:01:47 与 13:04:41 **相同**（`8f70a57a…`）；HEAD 仍 `18d1b9a` |
| 不新建数据库 | 全程无任何 DB 命令（仅 vitest / cargo test / tsc / git 只读） |
| 不修复失败 / 不做失败归因 | 负向对照的失败仅登记 panic 原文与退出码（§3.4），未改动任何源文件以求绿 |
| 临时物清理 | `/tmp/adr024_clean_frz01`（129M）、`/tmp/adr024_clean_target`（2.1G）、`/tmp/adr024_frz` 已删除；`/tmp/adr024_p1b` 为**既有**（非本任务）（`05_cleanup_and_integrity.txt`） |
| 无永久新增测试 | 本任务**未新增/未修改任何测试或源码**；产物仅为 `tester/evidence/247_adr024_p0_freeze/**` 与本报告 |

---

## 7. 与 worker 报告的一致性核对

| 来源声称 | 本轮独立核验 | 一致? |
|---|---|---|
| 整改单#2（`coder/report/adr024_p0_rect2_testrunpanel.md`）：删常量 `M30` ⇒ `TestRunPanel.test.tsx` 由恒绿变红（1 failed / 6, exit 1） | **独立复现成立**（§1.1b，自跑，未复用其输出） | ✅ |
| 整改单#2：`periods.ts` / `ConfigPanel.test.tsx` 逐字未变（sha256 + blob == index） | **独立复现成立**：`04b540de…` / `8c8b819c…`，`git diff` 空，blob 与 index 相同（§1.2） | ✅ |
| 整改单#2：完整套件 89 files / 850 tests、`tsc -b` EXIT=0 | **复跑一致**（§2.2、§4 末） | ✅ |
| 整改单#2 §6：staged = 55（含架构师所入 `design/16` 5 条） | **一致**：55，且反向核对 = 声明的 55（§4.1/§4.4） | ✅ |
| 架构师：已 `git add design/16-backtest-scalability/`（5 文件，含 `contract-vectors.json`） | **一致**：5 条 `A`，`contract-vectors.json` index blob `4bcaf350…` == 工作区 == 导出树（§3.2） | ✅ |
| 上一轮 D1（`periods.test.ts` 未入 index） | **已整改**：现为 `A web/src/features/backtest/periods.test.ts`（blob `8eb8c80f…`），且**可红**（§1.1 旁证） | ✅ |
| 上一轮 D2（`ConfigPanel.test.tsx` 对 `M30` 恒真） | **已整改**：期望改取契约向量，扰动下**变红**（§1.1 旁证） | ✅ |
| 上一轮禁改项结论 | **复验一致**（§4.2/§4.3） | ✅ |
| 任务书对 staged 面的预期（P0 源码/测试 + `design/16/**` 5 + `design/02` + `design/07` + `coder/**` 本批产物） | **逐条吻合**（§4.1/§4.4；唯一"缺"的是 O1 那份**未入 index 的报告文件**） | ✅（附 O1） |

---

## 8. 产物

| 类型 | 路径 |
|---|---|
| **报告（本文件，判词在最前，self-location）** | `tester/report/adr024_p0_freeze_verification.md` |
| 证据目录（26 个原始输出文件 + `EVIDENCE.md` 索引） | `tester/evidence/247_adr024_p0_freeze/` |
| 临时物（**已删除**） | `/tmp/adr024_clean_frz01`、`/tmp/adr024_clean_target`、`/tmp/adr024_frz` |

**本任务未新增永久测试文件**（故无 `tester/design/*` 交付）；未修改任何生产代码；未 `git add` / `git commit`。
