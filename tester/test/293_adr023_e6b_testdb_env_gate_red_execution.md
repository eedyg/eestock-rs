# 293 — ADR-023 E6b 红测试执行报告（测试写活库 ⇒ 响亮失败）

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/test/293_adr023_e6b_testdb_env_gate_red_execution.md`
- 类型：**Execution report**（执行**本轮新编写**的红测试；不改实现、不改既有测试）
- 设计报告：`tester/design/292_adr023_e6b_testdb_env_gate_red_design.md`
- 证据目录：`/tmp/adr023-e6b-red-20260917T034707Z/EVIDENCE.md`

## 1. 运行环境

- 时间：2026-09-17 03:47Z → 03:51Z（UTC）
- 仓库 / commit：`/home/eestock/workspace/git/eestock/eestock-rs` @ `204cb77`（未 `git add/commit/stash`，`git diff --cached` 为空）
- 隔离载体：一次性库 `e6b_red_iso`（37 表，0001–0026 迁移按序应用）、`e6b_red_iso2`（R5 变异）
- 活库 `eestock`：仅 `SELECT`；在线 app PID 178558 全程存活（未重启/未杀）

## 2. 套件结果

| 套件 | 命令 | total | passed | failed | skipped | exit |
|---|---|---|---|---|---|---|
| 新增 Rust 门禁测试 | `cargo test -p storage --test adr023_e6b_testdb_env_gate_red --no-fail-fast` | 5 | 0 | **5** | 0 | 101 |
| 新增 shell 门禁测试 | `bash scripts/tests/test_adr023_e6b_testdb_gate.sh` | 6 检查点 | 0 | **1（R3-1 即止）** | 0 | 1 |
| 既有回归（加新文件前） | `DATABASE_URL=<iso> cargo test -p storage --no-fail-fast` | 87 | **84** | 3 | 0 | 101 |
| 既有回归（加新文件后） | 同上 | 92 | **84** | 8 | 0 | 101 |

## 3. 失败用例表（新增红测试）

| 用例 | 断言 | 错误摘要 | 崩溃/核心转储 |
|---|---|---|---|
| `r1_static_every_test_pool_must_read_eestock_test_database_url` | R1 静态 | `32/32 个「会连库」测试文件未从 EESTOCK_TEST_DATABASE_URL 取 URL` | 无 |
| `r2_static_every_test_pool_must_assert_sentinel_table` | R2 静态 | `32/32 …无哨兵表 _eestock_test_db 断言` | 无 |
| `r3_init_script_exists_executable_and_covers_contract` | R3 | `scripts/testdb-init.sh 不存在` | 无 |
| `r4_static_no_hardcoded_live_db_url_in_test_sources` | R4 | `35 处（其中 unwrap_or_else 兜底默认 33 处）` | 无 |
| `r1_behaviour_unset_env_var_must_fail_loudly_naming_the_variable` | R1 行为 | 探针 `kline_reader-6f8949196b1b62d8` exit 101，输出**未点名**变量（连接不可达 `127.0.0.1:1`） | 无 |
| shell `R3-1` | R3 存在性 | `FAIL scripts/testdb-init.sh 不存在` → `VERDICT: RED` | 无 |

**无崩溃、无 core dump、无 OOM/panic 连带失败。**

## 4. 既有回归失败（**本轮引入前即存在**，两轮完全相同）

| 用例 | 性质 |
|---|---|
| `for_symbol_resolves_profile_by_type_and_misses_fail_soft` | 一次性空库无种子数据 ⇒ 数据前提失败 |
| `merged_1m_branch_index_limit_performance` | 空库无 518880 真实 M1 行情（测试自带「不得假绿」门禁） |
| `migration_0025_idempotent_backfill_and_seed_in_rolled_back_tx` | 空库无回填种子 |

⇒ 新增文件**未破坏既有回归**（84 passed 两轮一致；failure 集合之差 = 本轮新增 5 例）。

## 5. 覆盖/性能备注

- 覆盖率工具本轮未启用（判据为静态 + 行为断言，非行覆盖）。
- 行为探针耗时 ~30s（15 例各自重试连接不可达地址）；静态 4 例 < 0.1s。
- 未对 `crates/web` / `crates/mcp` / `crates/strategy-runtime` 做运行级套件执行（时间盒 + 均需测试库）；其测试源码已被 R1/R2/R4 静态扫描覆盖。

## 6. 不做的事（合规声明）

- 未修改任何实现代码、接口、架构、既有测试与 `design/**`。
- 未尝试修复任何失败、未进入失败分支调试。
- 未对活库 `eestock` 做任何写；未 `git add/commit/stash`；未重启/杀在线 app。

## 7. 残留风险

见 `/tmp/adr023-e6b-red-20260917T034707Z/EVIDENCE.md` §7（要点：R3 的「全量套件全绿」因 3 例数据前提失败可能不可达；entangled 生成物须经 `design/**` + tangle 修改；R1 行为断言依赖已编译 `kline_reader` 二进制；库名覆盖变量名钉为 `EESTOCK_TEST_DB_NAME`；R5 为机制级变异，落地后建议在真实 `pool()` 上重做）。
