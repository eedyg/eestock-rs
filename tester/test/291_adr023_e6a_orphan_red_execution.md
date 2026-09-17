# 291 — ADR-023 孤儿行治本（第一刀）红测试 —— **执行报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/test/291_adr023_e6a_orphan_red_execution.md`
- 类型：**Execution report**（执行既有/新写测试，无实现修复、无源码修改）
- 设计报告：`tester/design/291_adr023_e6a_orphan_red_design.md`
- 证据目录：`/tmp/adr023-e6a-red-20260917T010800Z/EVIDENCE.md`
- 运行时间戳（UTC）：2026-09-17T01:08Z 起（红跑）～2026-09-17T01:2xZ
- 提交：`git rev-parse HEAD` = 见证据目录 `git_and_redlines.log`（工作树含**本轮之前**已存在的 ` M design/01-architecture/adr/ADR-023-period-set-extension-30m.md`，sha256 见日志，本 agent 未触碰）
- **未做任何修复**：无源码/实现/接口改动；活库 `eestock` 零写（仅 `SELECT`/`GET`）；无 `git add/commit/stash`；未重启/未杀在线 app。

## 1. 总览（红/绿计数）

| 测试目标 | 总数 | 通过 | 失败 | 跳过 | 结论 |
|---|---|---|---|---|---|
| `crates/web/tests/orphan_detect_endpoint_red.rs`（新增：R1/R2静态/R4a/R5） | 4 | 0 | 4 | 0 | **红（4/4）** |
| `crates/web/tests/orphan_detect_sql_constant_red.rs`（新增：R2 符号契约） | 0（未编译成功） | 0 | 2 用例不可运行 | — | **红（E0432 编译失败）** |
| `/tmp/.../r3_r4b_isolated_db.sh`（R3/R4(b) 隔离库语义实验） | 5 步断言 | 5 | 0 | 0 | **绿（EXIT=0）—— 该判据验证「检测式/修法有效性」，与实现缺失无关** |
| 既有回归基线 `cargo test -p diagnose --lib` | 10 | 10 | 0 | 0 | 绿 |
| 既有回归基线 `cargo test -p web --lib` | 49 | 49 | 0 | 0 | 绿 |
| 既有 web 测试目标编译基线（移出新增文件后 `cargo test -p web --tests --no-run`） | 17 个目标 | 17 编译成功 | 0 | — | 绿（EXIT=0） |
| 崩溃 / core dump | — | — | — | — | **无** |

## 2. R1–R5 逐条红证据

### R1 — 端点不存在 ⇒ 404（红）
用例 `r1_orphan_endpoint_exists_and_reports_zero_on_clean_db`（in-process router，只读 GET）：

```
thread 'r1_orphan_endpoint_exists_and_reports_zero_on_clean_db' panicked at
crates/web/tests/orphan_detect_endpoint_red.rs:31:5:
assertion `left == right` failed: R1: GET /api/quality/orphans 必须存在并返回 200（当前实现缺失 ⇒ 404）
  left: 404
 right: 200
```
崩溃/core：无。红因 = **实现缺失**（路由未注册），非测试写错（编译通过、请求发出、状态码为 404 而非连接错误）。

### R2 — 检测口径即规范 + 单一可复用常量（红）
(a) 静态：`r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint`

```
panicked at crates/web/tests/orphan_detect_endpoint_red.rs:89:5:
assertion `left == right` failed: R2: 检测 SQL 必须在 crates/*/src 下**恰有一处**可复用定义（当前 0 处：[]）
  left: 0
 right: 1
```
（扫描器口径：归一化空白后「每张 cagg 作为 FROM 目标且其后 180 字符内有反连接」× 10 + `from symbols`；首轮曾误判 `crates/storage/src/reader.rs`（合并视图 SQL），已收紧判据并复跑，现为 0 处。）

(b) 符号契约：`cargo test -p web --test orphan_detect_sql_constant_red`

```
error[E0432]: unresolved imports `diagnose::quality::ORPHAN_ROWS_SQL`, `diagnose::quality::ORPHAN_TABLES`
  --> crates/web/tests/orphan_detect_sql_constant_red.rs:15:25
15 | use diagnose::quality::{ORPHAN_ROWS_SQL, ORPHAN_TABLES};
   |                         ^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^ no `ORPHAN_TABLES` in `quality`
   |                         |                no `ORPHAN_ROWS_SQL` in `quality`
error: could not compile `web` (test "orphan_detect_sql_constant_red") due to 1 previous error
```
红因 = **实现缺失**（契约符号不存在）；测试代码自身无语法/类型错误（错误全部落在未定义符号）。
隔离库侧同一份 SQL 的**口径有效性**已由 R3 证明（见下）。

### R3 — 检测有效性（隔离库，红阶段以「正向验证」执行通过）
`runs/02_r3_before_refresh_detect.log` / `runs/03_r3_after_delete_and_refresh.log`：

- 建库 → `psql -f` 按序应用 `migrations/0001..0026`（26 文件，`ON_ERROR_STOP=1`，非单事务）⇒ `migrate exit=0`，`timescaledb_information.continuous_aggregates` = **10**（与 R2 的 10 张表一致）。
- 插入 2 行孤儿（`998801`@01:30Z、`998802`@01:35Z，`period='M1'`）→ `CALL refresh_continuous_aggregate('kline_accurate_5m','2026-09-03 01:00+00','2026-09-03 02:00+00')` ⇒ 同一份 `orphan_detection.sql` ⇒ **`R3-1 rows=2`**（逐表明细 `kline_accurate_5m|2`，其余 9 表 0）。
- 删除这两行 → 同窗 refresh ⇒ **`R3-2 rows=0`**。
- 收尾：`DROP DATABASE ... WITH (FORCE)`；`residual_databases=0`；`residual_tables_in_live=0`；活库只读复核 `live_total=0`（**未被本实验改动**）。

### R4(a) — 三处清理函数只删不重算（红，4/4）
用例 `r4a_clean_functions_refresh_affected_cagg_windows`：

```
R4(a) 结构判据未达成:
crates/web/tests/api_kline_period.rs::async fn clean(: 无 refresh_continuous_aggregate ⇒ 只删不重算（孤儿根因）
crates/web/tests/api_rest.rs::async fn clean_kline(: 无 refresh_continuous_aggregate ⇒ 只删不重算（孤儿根因）
crates/web/tests/api_rest.rs::async fn clean_sym(: 无 refresh_continuous_aggregate ⇒ 只删不重算（孤儿根因）
crates/storage/tests/kline_reader.rs::async fn clean(: 无 refresh_continuous_aggregate ⇒ 只删不重算（孤儿根因）
```
（对照实现：`api_kline_period.rs:74-77` 只 `DELETE`；`api_rest.rs:96-105` 只 `DELETE`；`kline_reader.rs:32-37` 只 `DELETE`；三者的 fixture 均已在测试内 refresh 过相应 cagg ⇒ 删除后留毒。）

### R4(b) — 语义实验（隔离库，证明「修法有效」）
`runs/04_r4b_A_no_refresh_after_delete.log` / `runs/05_r4b_B_refresh_after_delete.log`：

| 路径 | 观测 | 期望 | 结论 |
|---|---|---|---|
| A：插入→refresh→删除→**不再** refresh | `after_insert_refresh=2`，`after_delete_no_refresh=2` | 2（孤儿留存） | 达成 ⇒ 「只删不重算」确会留孤儿 |
| B：插入→refresh→删除→**再** refresh 同窗 | `after_insert_refresh=2`，`after_delete_and_refresh=0` | 0 | 达成 ⇒ 该修法有效 |

### R5 — 测试内禁 `refresh_continuous_aggregate(NULL,NULL)`（红，1 处违规）
用例 `r5_no_full_range_refresh_in_test_sources`：

```
R5 grep 命令: grep -rn "refresh_continuous_aggregate" crates/*/tests | grep -c NULL
R5 refresh 调用点计数 = 24；NULL,NULL 违规点 = ["crates/web/tests/api_rest.rs:151"]
panicked at crates/web/tests/orphan_detect_endpoint_red.rs:197:5:
assertion `left == right` failed: ... 违规点：["crates/web/tests/api_rest.rs:151"]
```
shell 复核（`runs/r5_grep_evidence.log`）：
```
$ grep -rn "refresh_continuous_aggregate" crates/*/tests | wc -l
24
$ grep -rn "refresh_continuous_aggregate([^)]*NULL, NULL" crates/*/tests | grep -v orphan_detect_endpoint_red.rs | wc -l
1     # crates/web/tests/api_rest.rs:151  ("CALL refresh_continuous_aggregate('kline_5m', NULL, NULL)")
```
（未排除本红测试文件时计数为 4，多出的 3 条全是本文件内的**注释/文档串**——本测试的解析器已排除注释行与字符串字面量提及，shell 复核亦给出排除命令。）

## 3. 既有回归未被新文件破坏（绿基线）

- 新增是**纯增量**：`git status --porcelain crates/` 仅 3 条未跟踪新增（见 §4），`git diff --cached` 为空；既有测试与实现文件字节未变。
- `cargo test -p diagnose --lib`：`10 passed; 0 failed`。
- `cargo test -p web --lib`：`49 passed; 0 failed`。
- 编译基线（临时把 3 个新增文件移出后 `cargo test -p web --tests --no-run`）：**17 个既有测试目标全部编译成功，EXIT=0**；移出前后新增文件 sha256 一致（`selfile_hashes.txt`）。
- 说明：新增文件存在时，`cargo test -p web` 的**整体**构建会因 R2 符号契约（预期的编译期红）而失败——这是 TDD 红阶段的固有代价；单个既有目标仍可用 `--test <name>` 独立构建/运行。

## 4. 新增/改动文件

| 文件 | 性质 |
|---|---|
| `crates/web/tests/orphan_detect_endpoint_red.rs` | 新增（R1/R2静态/R4a/R5） |
| `crates/web/tests/orphan_detect_sql_constant_red.rs` | 新增（R2 符号契约，当前编译红） |
| `crates/web/tests/orphan_probe/mod.rs` | 新增（共用装配辅助，非测试目标） |
| `/tmp/adr023-e6a-red-20260917T010800Z/{orphan_detection.sql,r3_r4b_isolated_db.sh,EVIDENCE.md,runs/*}` | 新增（仓库外证据，零仓库残留） |

**未改动**：任何实现/接口/既有测试/`design/**`/entangled 生成物。

## 5. 崩溃与 core dump

无崩溃、无 core dump、无 panic 之外的进程异常；两个 Rust 目标均以 `test result: FAILED`（断言失败）退出，非 SIGSEGV/abort。

## 6. 残留风险

1. **编译期红扩散**：`orphan_detect_sql_constant_red.rs` 在实现落地前使 `cargo test -p web` 整体构建失败（单目标运行不受影响）。属预期，非回归。
2. **契约符号漂移**：实现若改名/换位置，须同步改该测试文件（本轮契约 = 文件内 import 行）。
3. **`AppState` 增字段**：`orphan_probe/mod.rs` 手工装配，需随装配面同步（否则新增测试目标编译失败）。
4. **R4(a) 的 cagg 集合是安全上界**：`kline_reader.rs::clean` 要求 4 张（含 W/MO）；实现若有更强推导可协商，但不得放宽为 0 张。
5. **R5 的静态口径**依赖「调用点单行」形态；跨行写法的 `NULL,\nNULL` 不被捕捉（当前仓库无此形态）。
6. **本红轮未验证**：端点对真实"有孤儿"库的数值正确性（活库当前 0 孤儿；R1 只断言 0 值路径 + 自洽），数值非零路径由 R2 符号测试的 DB 对拍 + R3 隔离库计数覆盖。
