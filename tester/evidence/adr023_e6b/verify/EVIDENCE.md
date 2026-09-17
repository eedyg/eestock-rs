# ADR-023 E6b 第二刀（测试库隔离门禁）— 独立验收证据

- **本文件位置（绝对路径）**：`/tmp/adr023-e6b-verify-20260917-120416/EVIDENCE.md`
- 验收角色：独立 Tester（只验不改）。仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- 验收时刻：2026-09-17 12:04–12:10 CST；HEAD = `204cb77a2f345c7163b5a93da4540cd5c66f2d6f`（未变）
- 一次性测试库（自建、用毕已 DROP）：`e6b_verify_iso`、`e6b_verify_unreach_iso`
- 未采信实现自报；以下均为本机独立复现输出（原始日志见同目录 `A*` 文件）

---

## VERDICT: PASS

（唯一未满足项：父级裁决 (6) 中「README 写明**播种内容与行数**」缺失 —— 见 A3-(6)，属文档缺口，不阻断功能契约；详见 §A3 / §A9。）

---

## A1 响亮失败（独立复现两条）— PASS

### A1-1 未设变量
命令：
```
env -u EESTOCK_TEST_DATABASE_URL cargo test -p storage --test kline_reader
```
原始输出（`A1_case1.txt`，EXIT=**101**）：
```
thread 'weekly_monthly_deep_scroll_before_2024' (1176315) panicked at crates/test-support/src/lib.rs:26:14:
集成测试拒绝运行：环境变量 `EESTOCK_TEST_DATABASE_URL` 未设置（或为空）。
这是**刻意设计**的响亮失败——禁止回退到活库 `eestock`（测试会写库，误指即污染生产数据）。
前置步骤：先运行 `scripts/testdb-init.sh`，再 `export EESTOCK_TEST_DATABASE_URL=...`（见 README「跑集成测试的前置步骤」）。
...
test result: FAILED. 0 passed; 15 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
error: test failed, to rerun pass `-p storage --test kline_reader`
```
- 非零退出 ✓（101）；输出含变量名 ✓（`grep -c EESTOCK_TEST_DATABASE_URL` = 30）。

### A1-2 指向活库
命令：
```
EESTOCK_TEST_DATABASE_URL="postgres://eestock:eestock@127.0.0.1:5433/eestock" cargo test -p storage --test kline_reader
```
原始输出（`A1_case2.txt`，EXIT=**101**）：
```
thread 'merged_1m_branch_index_limit_performance' (1176512) panicked at crates/test-support/src/lib.rs:55:19:
哨兵表 `_eestock_test_db` 不存在/查询失败：`EESTOCK_TEST_DATABASE_URL` 很可能指向活库 `eestock`（哨兵拦截）。: error returned from database: relation "_eestock_test_db" does not exist
```
- 非零退出 ✓（101）；说明哨兵缺失 ✓（15/15 用例均在建池处被哨兵拦下，无一触达测试体）。
- 附：此命令对活库仅发起一次 `SELECT value FROM _eestock_test_db LIMIT 1`（失败），无写（见 A7）。

**A1 结论：PASS（两条均响亮失败）。**

---

## A2 端到端（关键）— PASS

### 初始化 ×2（幂等）在自建一次性库 `e6b_verify_iso`
命令：`EESTOCK_TEST_DB_NAME=e6b_verify_iso bash scripts/testdb-init.sh`

- **RUN 1**（`A2_run1.stderr`，EXIT=0）：建库 → 应用 26 条迁移（账本 26）→ 建哨兵 → 只读播种 → 刷 cagg。
  - **耗时：wall 16.23s**（`/usr/bin/time -v`：Elapsed (wall clock) 0:16.23；User 1.39s）
  - 播种行数：`symbols=44`、`strategy=23`、`strategy_version=24`、`kline_accurate=1,631,088`、派生 `kline_accurate_1d=6,768`
  - stdout 唯一一行：`export EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/e6b_verify_iso'`
- **RUN 2**（`A2_run2.stderr`，EXIT=0，耗时 **0.99s**）—— 幂等：
```
[testdb-init] 库 `e6b_verify_iso` 已存在（跳过建库）
NOTICE:  relation "_eestock_test_migrations" already exists, skipping
[testdb-init] 迁移应用完成（账本 26 条）
NOTICE:  relation "_eestock_test_db" already exists, skipping
[testdb-init] 哨兵表 `_eestock_test_db` 就绪（value=test）
[testdb-init] 跳过播种 symbols（目标已有 44 行）
[testdb-init] 跳过播种 strategy（目标已有 23 行）
[testdb-init] 跳过播种 strategy_version（目标已有 24 行）
[testdb-init] 跳过播种 kline_accurate（目标已有 518880/510050 的 M1）
```
  - 不报错 ✓、**不重复插入**（前后目标行数逐表一致，见 `A2_counts.txt`：symbols 44/44、strategy 23/23、strategy_version 24/24、kline_accurate 1,631,088/1,631,088、1d 6,768/6,768）✓、打印跳过原因 ✓。

### 全量测试
命令：`export EESTOCK_TEST_DATABASE_URL=.../e6b_verify_iso && cargo test --workspace --tests`
- **EXIT=0，耗时 55s；`732 passed / 0 failed / 0 ignored`**（`A2_workspace_rc.txt`、`A2_workspace_results.txt`，逐 target 93 行 `test result: ok`）。与实现自报 732 一致。
- 隔离佐证：全量跑完后测试库 `kline_raw=0`（用例自清）、`symbols=44`（种子未损）、`app_config=0`（`A2_isolation.txt`）；同刻活库零变化（A7）。

### 清理（无残留）
命令：`dropdb ... e6b_verify_iso` / `... e6b_verify_unreach_iso` → 均成功。
- DROP 前库清单（`A2_dblist.txt`）与 DROP 后（`A2_dblist_after.txt`）：`adr023_e6b_gate_iso, adr023_e6b_v3_test, e6b_red_iso, e6b_red_iso2, eestock, eestock_d11_probe, postgres, template0, template1`。
- `SELECT datname ... LIKE 'e6b_verify%'` 返回空 ⇒ **自建库已彻底清理**。未动 worker 保留的 `adr023_e6b_v3_test`，也未动实现/前置各阶段遗留的 `adr023_e6b_gate_iso / e6b_red_iso / e6b_red_iso2 / eestock_d11_probe`。

**A2 结论：PASS。**

---

## A3 播种边界逐条核（对应父级 (1)–(6)）

脚本源码片段（`scripts/testdb-init.sh`，163 行，mode 755）：

**(1) 最小集、由失败例真实前提反推，非整库克隆 — PASS**
- 全脚本仅 4 处播种：`seed_copy symbols/strategy/strategy_version` + `kline_accurate`（`518880`+`510050` 的 M1）。活库 `public` 有 37 张表，仅 4 张被播种（+ 派生 cagg）。
- 运行时证据：RUN1 仅打印 4 条「播种 …」，无其他表。

**(2) 对源库只读 — PASS**
- 源码：`PGOPTIONS='-c default_transaction_read_only=on' psql "$LIVE_URL"`（脚本第 123、148 行，两处播种均带）。
- 活库全程零写（A7 读数为证）。

**(3) 幂等 — PASS**：见 A2 RUN2（非 0 行即跳过 + 打印原因；前后行数不变）。

**(4) 源不可达非零退出并说明 — PASS**
命令：`EESTOCK_TEST_DB_NAME=e6b_verify_unreach_iso EESTOCK_LIVE_DB_NAME=no_such_live_db_xyz bash scripts/testdb-init.sh`
原始输出（`A3_unreach.stderr`，EXIT=**3**）：
```
[testdb-init] ❌ 源库 `no_such_live_db_xyz` 不可达：无法播种测试基线（测试库必须可用，否则集成测试会以难解方式失败）。
[testdb-init]    如源库不在默认位置，设 EESTOCK_TEST_DB_HOST/PORT/USER/PASSWORD 或 EESTOCK_LIVE_DB_NAME。
```
- 非零退出 ✓（3）；说明清楚 ✓；**stdout 为空 ⇒ 未打印 export 行**，调用方无从误用空库 ✓。
- ⚠ 次级观察（非阻断）：脚本在播种前已建库+跑迁移，故源不可达时**会在磁盘上留下一个仅含 schema+哨兵的库**（本例 `e6b_verify_unreach_iso`，已由我 DROP）。父级原话「不得产出空测试库」按「非零退出 + 无 export 行」口径满足；若要求「连空库都不留」，需脚本在 require_live 失败时回滚建库（补救建议见 §A9）。

**(5) 不得弱化/删除任何测试 — PASS**：见 A5。

**(6) README 写明前置步骤、播种内容与行数、刻意响亮失败 — PARTIAL（未满足「播种内容与行数」）**
- README.md 第 96–114 行新增「跑集成测试的前置步骤」：前置三步 ✓；覆盖变量/库名 ✓；「未设变量即响亮失败是刻意设计」✓（第 109–111 行原文）；哨兵说明 ✓；清理命令 ✓。
- **缺失**：全 README `grep -iE "播种|基线|seed|symbols|strategy|M1|1,631|1631088"` **0 命中** ⇒ **播种清单与行数只写在实现报告 `coder/report/295…md §4.2`，未写入 README**。
- 结论：父级裁决 (6) 三要素中「前置步骤」「刻意失败」满足，「播种内容与行数」**未满足**（文档缺口，建议补齐）。

**A3 结论：5/6 满足，(6) 部分未满足。**

---

## A4 静态面空集问题（实现自报残留 #4）— 见结论

**(1) 现状「0 个测试文件硬编码活库 URL」？— 成立**
- `grep -rn "5433/eestock" --include=*.rs crates/ | grep /tests/ | grep -v adr023_e6b_testdb_env_gate_red` → **空**（无测试文件硬编码活库 URLs）。
- 命中仅 2 处、均非「测试池硬编码」：`crates/tushare/src/bin/tushare_sync.rs:23`（**src**，非测试，见 A5）与门禁红测试自身的 `LIVE_URL` 常量（该文件把自己排除在扫描外）。
- 33 个测试文件统一走 `test_support::test_pool`（`A4_poolbuilding.txt`）。

**(2) 新写一个硬编码活库池的测试文件，门禁抓得住吗？— 规范形态：抓得住（已实证）；规避形态：抓不住**

在 `/tmp/e6b_mut`（仓库副本，非仓库本体）做变异并运行门禁 `adr023_e6b_testdb_env_gate_red`：

- **变异 A（规范形态）**：新文件 `mutation_hardcoded_live_pool.rs`，`PgPool::connect("postgres://eestock:eestock@127.0.0.1:5433/eestock")`。
  - 结果（`A4_mutation_final.txt`，EXIT=101）：**R1 / R2 / R4 三条静态门禁全部 FAILED 并点出该文件**：
```
R1 红：1/1 个「会连库」的测试文件未从 EESTOCK_TEST_DATABASE_URL 取 URL …
  - crates/storage/tests/mutation_hardcoded_live_pool.rs
R2 红：1/1 个「会连库」的测试文件无哨兵表 `_eestock_test_db` 断言 …
  - crates/storage/tests/mutation_hardcoded_live_pool.rs
R4 红：活库 URL 字面量在 crates/*/tests 下仍有 1 处 …
  - crates/storage/tests/mutation_hardcoded_live_pool.rs:9
```
- **变异 B（仅注释提及变量名，不读变量）**：把 `EESTOCK_TEST_DATABASE_URL` 写进注释、代码硬编码活库池 → **R1 漏过**（R1 是对**整文件**的子串匹配），仅 R2/R4 命中（`A4_mutation2.txt`）。⇒ R1 判据可被「提及即通过」绕过。
- **变异 C（规避形态，抓不住）**：新文件 `mutation_lazy_obfuscated.rs`，用 `PgPoolOptions::new().connect_lazy(&url)` + `format!`/`concat!` 拼出 URL（非字面量）。
  - 单独存在时（`A4_mutation_lazy_alone.txt`，EXIT=**0**）：**R1/R2/R4 全过（门禁 GREEN）⇒ 未抓住**。原因：`builds_live_pool()` 只认 `PgPool::connect(` 或（`PgPoolOptions` 且 `.connect(`），排除 `connect_lazy`；R4 只匹配精确字面量。
  - 现实对照：仓库现存 `period30m_api_contract.rs` 即用 `connect_lazy` + 另一端口字面量（`127.0.0.1:59999`）从而不被扫——属同型盲区。

**A4 结论**：门禁对**规范**新硬编码池（`PgPool::connect` + 精确活库字面量）**抓得住**（R1/R2/R4 齐发，实证）；但对 `connect_lazy` / 非字面量拼接 / 仅注释提及三种**规避形态抓不住**。实现自报「R1/R2 静态面为空集」的表述**不准确**：空集指当前**输入**为空，一旦新增会连库文件，静态面立即生效（变异 A 即证）；真正缺口是**检测面覆盖不全**（漏 `connect_lazy` 与非字面量）。
最小补救建议：(a) `builds_live_pool()` 增补 `connect_lazy`/`sqlx::Pool::connect` 等一切 sqlx 建池调用；(b) R1 由「整文件含变量名」改为断言**实际读取**（如存在 `std::env::var("EESTOCK_TEST_DATABASE_URL")`，或更强：测试文件必须出现 `test_support::test_pool`，禁用裸池构造）；(c) 可选加一条「测试源不得出现 `eestock`@`5433` 语义」的语义化（去字面量）扫描。

---

## A5 未弱化 / 未删除测试 — PASS

逐文件对照 HEAD（结构计数）：

- 34 个受影响的测试文件：**用例数 `#[test]`/`#[tokio::test]`、断言数逐文件与 HEAD 完全相等**（`A5_files.txt`，34 行全等）；行数仅 −1～−11（删去重复的建池样板）。
- 全量 diff 中**被删的含 assert/test/fn 行仅 31 行，全部是 `PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")` 建池样板**；**新增行中不含任何 assert/test** ⇒ 无断言被删/改宽（`A5_removed.txt`）。
- **`period30m_*`**：`period30m_d2_multiperiod_red.rs` 仅把 `live_snapshot()` 的 `DATABASE_URL`+`PgPoolOptions` 兜底换成 `test_support::test_pool()`（快照/恢复改作用于测试库），**6 用例 / 21 断言不变**；`period30m_api_contract.rs`、`period30m_scope_guard.rs` **未被改动**（各 2/3 用例、3/6 断言不变）。
- **`orphan_*`**：`orphan_detect_endpoint_red.rs`（4 用例/17 断言）、`orphan_detect_sql_constant_red.rs`（2 用例/8 断言）**未被改动**；`orphan_probe/mod.rs`（非测试目标、被 `mod` 引用的装配文件）仅把 `pool()` 的活库兜底换成 `test_support::test_pool()`（无断言，0→0）。⚠ 语义注记：orphan 探针由此**从查活库改为查测试库**（符合「测试禁触活库」之用刀意图，但该红测试已不再观测活库孤儿——见 A9 漏报项）。
- `crates/tushare/src/bin/tushare_sync.rs`：`git diff` 空 ⇒ **未被本轮改动**（其活库兜底默认属 src，按父级口径只登记不改）✓。

**A5 结论：PASS，无弱化、无删除。**

---

## A6 门禁与回归 — PASS

- `./scripts/check-tangle.sh` → **EXIT=0**：`[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。`（`A6_check_tangle.txt`）⇒ 13 个 doc-first 产物与 design/ 事实源**逐字节一致**（强于 mtime 口径）。
- doc-first 13 产物 mtime 均为 `2026-09-17 11:54:35`（`A6_docfirst.txt`）：`kline_reader.rs, api_rest.rs, ws_poller.rs, symbol_admin.rs, api_admin.rs, api_quality.rs, mcp_tools_db.rs, alert_store.rs, api_alerts.rs, accurate_upsert.rs, raw_writer.rs, event_sink.rs, symbols_registry.rs`；其 design 源 5 文档含 `test_support::test_pool` 共 14 处。
- 前端：`npx vitest run` → **EXIT=0，88 files / 839 tests passed**（`A6_vitest.txt`）；`npm run build` → **EXIT=0**（仅既有 chunk 体积警告，`A6_build.txt`）。`web/dist` 为 gitignore 产物。

---

## A7 活库零变化（关键）— PASS

跑完全量测试后，活库 `eestock` 只读对照（before=`live_*.txt` / after=`A7_after.txt`）：

| 指标 | before | after | 判定 |
|---|---|---|---|
| 10 张 cagg 孤儿码计数（997711/…997752） | 全 0 | 全 0 | 不变 |
| `symbols` 行数 / 指纹(md5) | 44 / `ed61bd8d72b74c685f4685911efe0693` | 44 / `ed61bd8d72b74c685f4685911efe0693` | 不变 |
| `app_config` 指纹(md5) | `fe3dbcbdf7a18743245cd8175d1b2b98` | `fe3dbcbdf7a18743245cd8175d1b2b98` | 不变（仅 `dcap` 一键） |
| `kline_accurate` count / max(ts) | 16,344,861 / 2026-09-16 07:00:00+00 | 16,344,861 / 2026-09-16 07:00:00+00 | 不变 |
| `kline_raw` count / max(ts) | 114,841 / 2026-09-17 03:30:00+00 | 114,841 / 2026-09-17 03:30:00+00 | 不变 |

**A7 结论：PASS，活库零变化。**

---

## A8 副作用审计 — PASS

- 仓库零改动：`git status --porcelain` 行数 = **97**（与验收开始时完全一致，`A8_git_status_now.txt`）；HEAD = `204cb77a…`（未变）；`git diff --cached` = **0**（无 staged）。我未 add/commit/stash，未改仓库任何被跟踪文件。
- 临时残留：仓库内无新增未跟踪文件；变异沙箱在仓库外 `/tmp/e6b_mut`（源已清理 `/tmp/e6b_mut_target`）。
- 在线进程未动：PID **178558** 仍为 `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（etime 由 12:05:14 → 12:10:12，仅自然增长，未重启）。
- 容器未动：`eestock-timescaledb`/`eestock-data` 均 Up 12 days (healthy)，scrylink-* 状态不变。
- `crates/test-support` 未进运行时依赖图：`cargo tree -e normal -i test-support` 仅返回其自身、**无任何 dependents**；`cargo tree -e normal --workspace | grep -c test-support` = 1（仅包定义行）。未进镜像：`grep -n test-support Dockerfile Dockerfile.app docker-compose.yml` = **无输出**。

---

## A9 残余风险独立复核

实现自报 6 条，逐条判定：

1. **播种依赖活库可达** — **成立**（源不可达 exit 3，A3-(4) 已验证）。可另设 `EESTOCK_LIVE_DB_NAME` 覆盖；属父级裁决边界，非缺陷。
2. **测试库 1.63M 行不可离线自举** — **成立**（实测播种 `kline_accurate=1,631,088` 行；纯离线 CI 需另出静态 fixture，超本轮）。
3. **`tushare_sync.rs:23` 仍有活库兜底默认** — **成立**（`git diff` 空，未被本轮触碰；属 src 工具，R4 不覆盖）。
4. **R1/R2 静态面在集中后为空集** — **部分成立但表述不准**（见 A4）：当前输入为空集属实，但静态门禁对新增会连库文件立即生效；真正缺口是**检测面漏 `connect_lazy`/非字面量/仅注释提及**三种规避形态。
5. **单文档 mtime 会被后续块编辑推后** — **成立**，且本轮以更强证据（`check-tangle.sh` 沙箱逐字节一致）覆盖，无实质影响。
6. **播种是活库快照，需同步** — **成立**（`symbols=44`/`strategy=23` 为活库快照；脚本按「目标非空即跳过」，故活库演进后需重建测试库方生效）。

**漏报项（父级应知）**：
- **(M1) README 未写「播种内容与行数」** —— 父级裁决 (6) 明文要求，只落在实现报告里。**未在自报残留中列出**。
- **(M2) 源不可达时脚本仍留下 schema-only 测试库**（见 A3-(4) 次级观察）—— 非零退出+无 export 行已足够响亮，但「不留空库」口径需脚本回滚建库。
- **(M3) oracle 语义漂移**：`orphan_probe/mod.rs` 与 `period30m_d2…live_snapshot` 由「查活库」改为「查测试库」——符合隔离意图，但该「活库孤儿守卫」红测试自此**不再观测活库**，等价于该守卫对活库失效（若活库再被污染，此测试无法发现）。属**行为语义改变**，未被自报为残留。
- **(M4) R1 判据可被「注释提及变量名」绕过**（A4 变异 B）—— 静态判据非语义化。

---

## 命令清单（原始日志均在同目录）
```
A1: env -u EESTOCK_TEST_DATABASE_URL cargo test -p storage --test kline_reader            -> exit 101
A1: EESTOCK_TEST_DATABASE_URL=.../eestock cargo test -p storage --test kline_reader        -> exit 101 (哨兵)
A2: EESTOCK_TEST_DB_NAME=e6b_verify_iso bash scripts/testdb-init.sh (x2)                   -> exit 0 / 0 (幂等, 16.23s/0.99s)
A2: EESTOCK_TEST_DATABASE_URL=.../e6b_verify_iso cargo test --workspace --tests            -> exit 0, 732 passed/0 failed
A2: dropdb e6b_verify_iso; dropdb e6b_verify_unreach_iso                                   -> 已清理
A3: EESTOCK_LIVE_DB_NAME=no_such_live_db_xyz bash scripts/testdb-init.sh                   -> exit 3
A4: (in /tmp/e6b_mut) cargo test -p storage --test adr023_e6b_testdb_env_gate_red (变异 A/B/C)
A6: ./scripts/check-tangle.sh                                                              -> exit 0
A6: npx vitest run (web/)                                                                  -> exit 0, 88 files/839 tests
A6: npm run build (web/)                                                                   -> exit 0
A8: cargo tree -e normal -i test-support ; grep -n test-support Dockerfile Dockerfile.app docker-compose.yml
```
