# ADR-023 E6b 红阶段证据（测试写活库 ⇒ 响亮失败）

- 本文件位置（绝对路径）：`/tmp/adr023-e6b-red-20260917T034707Z/EVIDENCE.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs` @ `204cb77`（工作区另含既有未跟踪文件；**本轮零 git add/commit/stash**）
- 时间窗：2026-09-17 03:47Z → 03:51Z（UTC）
- 新增测试文件：
  - `crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs`（Rust 红测试 5 例：静态扫描 + 子进程探针）
  - `scripts/tests/test_adr023_e6b_testdb_gate.sh`（shell 门禁红测试：R3）
- 设计报告：`tester/design/292_adr023_e6b_testdb_env_gate_red_design.md`
- 执行报告：`tester/test/293_adr023_e6b_testdb_env_gate_red_execution.md`

## 0. 安全边界（已核验）

| 项 | 证据 |
|---|---|
| 活库 `eestock` 零写 | 全程对活库只跑 `SELECT information_schema`（`live_sentinel_count.txt`）；所有会写库的执行一律 `DATABASE_URL=<一次性库>` |
| 活库无残留表 | `select count(*) ... table_name in ('_eestock_test_db','_e6b_probe_rows')` = **0** |
| 在线 app 未动 | `ps -p 178558` → 存活（etime 11:51:57），未重启/未杀 |
| 隔离载体 | 一次性库 `e6b_red_iso`（37 表，0001–0026 迁移已按序应用）、`e6b_red_iso2`（R5 变异专用） |
| 未改生成物 | 未触碰 `design/**`、任何 `file=` 生成物、任何既有测试与实现；`git diff --cached` 为空 |
| R1 探针零连库风险 | 子进程 `DATABASE_URL=postgres://eestock:eestock@127.0.0.1:1/eestock`（不可达地址） |

## 1. R1 — 未设环境变量必须响亮失败 ⇒ **红**

命令（**异于派单字面**：追加 `DATABASE_URL=<一次性库>` 以保证零写活库；语义不变——未设 `EESTOCK_TEST_DATABASE_URL`）：

```
env -u EESTOCK_TEST_DATABASE_URL DATABASE_URL=postgres://…@127.0.0.1:5433/e6b_red_iso \
  cargo test -p storage --test kline_reader -- --skip merged_1m_branch_index_limit_performance
```

- `R1b_EXIT=0`（**应为非零**）→ 红
- `cargo_output_mentions=0`（**输出不含 `EESTOCK_TEST_DATABASE_URL`**）→ 红
- 14 passed。证据：`r1b_run.txt`
- 未加 `--skip` 的原样运行（`r1_run.txt`）：`R1_EXIT=101`，但失败原因是**一次性空库缺 518880 真实行情**（`merged_1m_branch_index_limit_performance`），且输出同样不含变量名 ⇒ 该非零退出与门禁无关，不构成假绿。
- 机器判据（红测试 `r1_behaviour_…`）：子进程探针 exit=101（127.0.0.1:1 连接拒绝），输出**未出现变量名** ⇒ 断言失败（红）。
- 静态面（红测试 `r1_static_…`）：**32/32** 个「会连库」测试文件未引用 `EESTOCK_TEST_DATABASE_URL`。

## 2. R2 — 误指活库必须被拦 ⇒ **红**

以**无哨兵表**的一次性库模拟活库（等价的「非测试库」）：

```
EESTOCK_TEST_DATABASE_URL=$ISO DATABASE_URL=$ISO cargo test -p storage --test raw_writer
```

- `R2_EXIT=0`、`3 passed`、`sentinel_mentions=0`（**既未拦截，也未说明哨兵缺失**）→ 红
- **写确实发生了**（证明「会静默写非测试库，即会静默写活库」）：
  `e6b_red_iso` 的 `pg_stat_database`：`xact_commit 4918→4941`、`tup_inserted 10722→10728`、`tup_deleted 2906→2908`；跑前 `_eestock_test_db` 表数 = 0
  证据：`r2_run.txt`、`r2_sentinel_absent_count.txt`
- 静态面（红测试 `r2_static_…`）：**32/32** 个会连库测试文件无 `_eestock_test_db` 断言。
- **未**直接指向活库跑该测试（派单绝对禁止）；用等价的无哨兵隔离库完成，且已给出「写发生在隔离库」的计数证据。

## 3. R3 — 初始化脚本可用且幂等 ⇒ **红**

- `scripts/testdb-init.sh` **不存在**（`ls` 无此文件）⇒ 红。
- Rust 红测试 `r3_init_script_exists_executable_and_covers_contract`：FAILED（`R3 红：\`scripts/testdb-init.sh\` 不存在…`）。
- shell 红测试 `scripts/tests/test_adr023_e6b_testdb_gate.sh`：`R3_SHELL_EXIT=1`、`R3-1 FAIL`、`VERDICT: RED`。证据：`r3_shell_gate.txt`
- **可达性探针**（证明目标流程本身可行，缺口只在脚本本身）：在一次性库上手推「建哨兵 → export 风格环境变量 → 跑写测试」⇒ `raw_writer` `3 passed`。证据：`r3_feasibility_probe.txt`

## 4. R4 — 无硬编码兜底残留 ⇒ **红**

- grep 计数（`crates/*/tests/**/*.rs`，排除本门禁文件自身）：
  - 含活库 URL 字面量的**测试文件**：**34 个**（与派单「34 个测试文件」一致）
  - 字面量**出现次数**：**35 处**（其中 `unwrap_or_else` **兜底默认 33 处**；另 2 处是 `strategy-runtime` 测试里的 `psql` 文档注释）
  - 另有 `crates/tushare/src/bin/tushare_sync.rs:23`（**src 非测试**，同样含兜底默认，建议一并处理）
- 红测试 `r4_static_no_hardcoded_live_db_url_in_test_sources`：FAILED，`35 处（其中 unwrap_or_else 兜底默认 33 处）`，并逐条列出 `file:line`。
- 其中 12–13 个是 entangled 生成物（文件头 `// ~/~ begin <<design/…#file>>`）⇒ 只能经 `design/**` 源头 + tangle 修改，绝不能手改生成物。

## 5. R5 — 门禁有效性（变异反证，**只在 /tmp 副本**）⇒ 红测试成立且门禁被证明有效

实现尚未存在（红阶段），故用**机制级等价探针**（`/tmp/adr023-e6b-red-20260917T034707Z/r5_mutation/`）做变异对照；变异体与门禁体**唯一差异 = 哨兵检查被注掉**（`diff` 已留证）：

| 场景 | 门禁版 exit | 变异版 exit | 说明 |
|---|---|---|---|
| 未设 `EESTOCK_TEST_DATABASE_URL` | **2**（点名变量） | — | 契约(1) 成立 |
| 无哨兵库 | **2**（点名哨兵缺失） | **0**（并写入 1 行） | **变异后 R2 变红**（拦人失败）⇒ 门禁真在拦人 |
| 有哨兵（值=test） | 0（正常写） | — | 无误杀 |
| 哨兵值≠test（如 `prod`） | **2** | — | 防「有表无值」假绿 |

证据：`r5_mutation_result.txt`、`r5_mutation/probe_gate.sh`、`r5_mutation/probe_gate_mutated.sh`

## 6. 红/绿计数

| 运行 | 命令 | 结果 |
|---|---|---|
| 红（新增门禁测试） | `cargo test -p storage --test adr023_e6b_testdb_env_gate_red --no-fail-fast` | **0 passed / 5 failed**，exit 101（`red_gate_run.txt`） |
| 红（shell 门禁） | `bash scripts/tests/test_adr023_e6b_testdb_gate.sh` | **PASS=0 FAIL=1**，exit 1（`r3_shell_gate.txt`） |
| 绿基线（加新文件**之前**） | `DATABASE_URL=<iso> cargo test -p storage --no-fail-fast` | **84 passed / 3 failed** / 0 skipped（`baseline_storage_iso.txt`） |
| 绿基线（加新文件**之后**） | 同上 | **84 passed / 8 failed** = 3 既有 + 5 本轮新增红（`regression_after.txt`） |

- 既有 3 个失败（`for_symbol_resolves_profile_by_type_and_misses_fail_soft`、`merged_1m_branch_index_limit_performance`、`migration_0025_idempotent_backfill_and_seed_in_rolled_back_tx`）**在两轮中完全同名同数**，且**在加入新文件之前的基线就存在** ⇒ 新文件未破坏既有回归。
- 该 3 例是一致性空库（仅迁移、无行情/种子数据）导致的**数据前提失败**，不是本轮引入；注意：**在活库上它们大概率是绿的**（活库有真实数据）。

## 7. 残留风险

1. **R3「`cargo test -p storage` 全绿」可能不可达**：一次性空测试库上既有 3 例数据前提失败（见 §6），验收 R3 若要求全绿，需要实现方提供种子数据/夹具，或把该 3 例改为显式数据前提门禁（本轮不得改）。
2. **entangled 生成物占用 12–13 个文件**：统一规则落地必须改 `design/**` 后 tangle；手改生成物会被 `scripts/check-tangle.sh` 判为漂移。
3. **R1 的行为断言依赖已编译的 `kline_reader` 测试二进制**（`target/debug/deps` 内取最新 mtime）；缺二进制时该用例报「harness 前提缺失」而非红——运行前先 `cargo test -p storage --test kline_reader --no-run`。该探针自身耗时约 30s（15 例各自重试连接不可达地址）。
4. **`scripts/testdb-init.sh` 的库名覆盖变量名未被契约钉死**：本测试文件钉为 `EESTOCK_TEST_DB_NAME`（默认 `eestock_test`）。若实现方另择名字，需同步该 shell 测试。
5. **R5 是机制级（bash+psql）变异，不是 Rust 路径变异**：因目标实现尚不存在（红阶段无法对不存在的代码做变异）。落地后建议在真实 `pool()` 上重做一次变异反证。
6. **未覆盖**：`crates/web` / `crates/mcp` / `crates/strategy-runtime` 套件的运行级验证（时间盒 25 分钟，且它们同样需要测试库）；本轮只做了静态面（R1/R2/R4 扫描已覆盖这些 crate 的测试源码）。
7. `crates/tushare/src/bin/tushare_sync.rs` 的兜底默认在 **src**（非测试文件），R4 判据未覆盖；建议实现方一并处理。
