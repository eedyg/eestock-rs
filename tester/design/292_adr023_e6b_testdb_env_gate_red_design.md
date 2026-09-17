# 292 — ADR-023 E6b「测试池必须指向测试库」红测试 —— **设计报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/design/292_adr023_e6b_testdb_env_gate_red_design.md`
- 类型：**Design report**（本轮**新设计并新编写**红测试；不改实现、不改既有测试、不改 `design/**`）
- 执行报告（红证据）：`tester/test/293_adr023_e6b_testdb_env_gate_red_execution.md`
- 证据目录：`/tmp/adr023-e6b-red-20260917T034707Z/EVIDENCE.md`

## 1. 交付物

| 产物 | 落位 | 判据 |
|---|---|---|
| A. Rust 红测试（5 例：静态扫描 4 + 子进程探针 1） | `crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs` | R1 / R2 / R3 / R4 |
| B. shell 门禁红测试（存在性 + 可执行 + 两次幂等 + export 行 + 哨兵实物） | `scripts/tests/test_adr023_e6b_testdb_gate.sh` | R3（+R2 实物面） |
| C. 变异反证实验（**仅 /tmp 副本**，不入仓） | `/tmp/adr023-e6b-red-<TS>/r5_mutation/{probe_gate.sh,probe_gate_mutated.sh}` | R5 |

## 2. 钉死的接口契约（实现方须照此落地）

1. 变量名 `EESTOCK_TEST_DATABASE_URL`；**未设即非零退出**，stderr/stdout 含该变量名。
2. 哨兵表 `_eestock_test_db(value text)`，值恒为 `test`；池构造后断言「存在且值=test」，否则非零退出并点名哨兵。
3. `scripts/testdb-init.sh`（可执行）：幂等建测试库（默认 `eestock_test`，本设计钉死覆盖变量为 `EESTOCK_TEST_DB_NAME`）+ 按文件名序应用 `migrations/*.sql` + 建哨兵 + 打印 `export EESTOCK_TEST_DATABASE_URL=...`。
4. 「会连库」判定：`PgPool::connect(` 或 `PgPoolOptions` + `.connect(`；仅 `connect_lazy(` 到不可达地址的文件（`crates/web/tests/period30m_api_contract.rs`）不算，避免误伤。

## 3. R1–R5 → 断言映射

| 判据 | 断言 | 红阶段实测 |
|---|---|---|
| R1 未设即响亮失败 | 行为：`env_remove(ENV_VAR)` 后跑参照测试二进制（`DATABASE_URL` 指向不可达 `127.0.0.1:1`，零连库风险），要求输出含变量名；静态：32 个会连库文件须引用变量 | 行为 **FAILED**；静态 **32/32 缺** |
| R2 误指活库被拦 | 静态：32 个会连库文件须含 `_eestock_test_db` 断言 | **32/32 缺** |
| R3 脚本可用幂等 | 存在 + 可执行 + 含 `_eestock_test_db`/变量名/`migrations`；shell 侧跑两次须 exit 0 | 脚本不存在 ⇒ **FAILED** |
| R4 无兜底残留 | `crates/*/tests/**` 内活库 URL 字面量计数须为 0（并分别报「兜底默认」与「注释提及」） | **35 处（33 兜底 + 2 注释）** |
| R5 门禁有效性 | 变异反证：注掉哨兵检查 ⇒ 无哨兵库上从 exit 2 变 exit 0 并落写 | 机制级探针已证（见证据 §5） |

## 4. Mock/stub 与安全策略

- 无 mock：全部为**源码静态扫描** + **子进程探针** + **一次性隔离库**（`e6b_red_iso` / `e6b_red_iso2`，0001–0026 迁移）。
- 门禁文件自身**不连库**；探针刻意指向不可达地址；所有会写库的执行一律显式 `DATABASE_URL=<一次性库>` ⇒ 活库 `eestock` 零写。
- 门禁文件**自我排除**于扫描（否则其常量/自描述会自匹配），活库 URL 常量以 `concat!` 分片拼接避免自匹配。

## 5. 边界与例外用例

- 未设变量（R1）、无哨兵表（R2）、有哨兵但值≠`test`（防假绿，R5-E）。
- 脚本两次运行幂等（R3-3/R3-4）、export 行可 `eval` 且指向非活库（R3-5，含 `*/eestock` 拒绝守卫）。
- 扫描器排除本文件、区分「兜底默认」与「文档注释提及」、把 `connect_lazy` 不可达池从「会连库」中剔除。

## 6. 覆盖目标

- 静态覆盖面：`crates/{storage,web,mcp,strategy-runtime}/tests/**/*.rs`（34 个含字面量文件 / 32 个会连库文件）。
- 行为面：`kline_reader`（读）、`raw_writer`（写）各 1 条通路 + shell 门禁 1 条。
- 回归面：`cargo test -p storage` 全量（含新增 5 例），前后对照计数。
