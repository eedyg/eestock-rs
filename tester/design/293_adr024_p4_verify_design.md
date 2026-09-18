# ADR-024 P4 独立验收 —— 新增测试**设计报告**

- **本报告自身路径**：`tester/design/293_adr024_p4_verify_design.md`
- 角色：tester（只验不改生产代码；本批**未** `git add` / `commit`）
- 判据来源：`design/16-backtest-scalability/02-spec.md` §1.2 / §2 / §3.2 / §4；`01-adr.md` D8/D9/D10；
  worker 交付 `coder/report/adr024_p4_chunked_result_storage.md`（自报口径需独立复核）
- 新增测试（4 个文件，**独立测试二进制**，不复用 worker 断言；均未 `git add`）：

| # | 文件 | 层 | 用例数 |
|---|---|---|---|
| 1 | `crates/storage/tests/tester_p4_store_indep.rs` | storage（真实 DB） | 6 |
| 2 | `crates/web/tests/tester_p4_endpoints_indep.rs` | web 端点（真实 axum server + 真实 DB） | 3 |
| 3 | `crates/web/tests/tester_p4_writepath_indep.rs` | application 写路径（真实 DB store + 故障/取消注入） | 4 |
| 4 | `crates/mcp/tests/tester_p4_mcp_indep.rs` | MCP 工具（真实 DB + rpc::dispatch） | 1 |

**合计 14 个用例**；加上 worker 既有用例后，四 crate 回归共 **485 passed / 0 failed**。

---

## 1. 测试策略（分层）

| 层 | 判据 | 手段 |
|---|---|---|
| 迁移正确性 | 产物 == 文档块 == 规格 §2（逐字节）；tangle 可复算 | 三方 byte diff + 沙箱 `entangled tangle -f` 回写探针（判别力反向对照） |
| 迁移落地形态 | 列/类型/PK/索引/CHECK/FK 级联/默认值 | 临时库 `information_schema` + `pg_constraint` + 负向 SQL（非法 kind、级联删除） |
| storage 端口 | `mark_succeeded` 新语义、失败可上报、分页/区间语义 | 真实 `PgStrategyRunStore` + **反探针数据**（调用方谎报 `legacy_single` 且内联三列非空 ⇒ 必须被忽略写占位） |
| application 写路径 | 分块先于 `mark_succeeded`、失败⇒failed、取消⇒canceled | 真实 DB store **外包注入层**（仅注入点异常，其余逐方法透传 ⇒ 生产同路径） |
| application/web 读路径 | 分页边界、区间外沿过滤、抽样保首尾、双读不回填 | 真实 run（5010 根）+ 手工造行（legacy / chunked / 异构块） |
| 端点 wire | 字段齐备、互斥 400、默认值/上限、标记字段 | 真实 server + reqwest；`/result` 与 `/bars` 首页逐值交叉核对 |
| MCP | 与 REST 同口径（首页 + `has_more`）、legacy 全量、无结果 ⇒ isError | `mcp::rpc::dispatch` tools/call |

## 2. 夹具与注入策略

- **真实 DB**：`test_support::test_pool()`（`EESTOCK_TEST_DATABASE_URL` 指向 `tmp_p4verify_<ts>` 临时库，带哨兵表断言）。
- **造行两种方式**：① 真实写路径（submit → 引擎 → 分块落库）；② 手工 SQL 造 `strategy_run(_result/_bars)`——
  用于构造 `legacy_single`、`chunked_v1` 占位形态、以及**唯一写路径不可能产出**的形态（异构块）作不变量探针。
- **注入点（写路径）**：`InjectStore` 包裹真实 `PgStrategyRunStore`，逐方法透传，仅
  ① 第 N 次 `append_result_chunk` 返回 `Err`（`fail_at`）；② 第 N 次成功写入后以 SQL 把 run 置 `canceled`（`cancel_at`，模拟并发取消胜出）。二者皆**确定性**，不依赖时序竞态。
- **隔离**：每个用例独立 symbol / 名字前缀（同 binary 并行执行互删是仓库既有踩坑；首版曾因共享 `clean` 出现 3 例假失败，已改为独立 symbol 后连续两次并行全绿 → 记录在案）。

## 3. 用例清单（should-when 命名）

### 3.1 `tester_p4_store_indep.rs`（storage，真实 DB）
| 用例 | 断言要点 |
|---|---|
| `t_mark_succeeded_forces_chunked_placeholders_and_keeps_trades` | 新 run 强制 `chunked_v1`；三列 `[]` 占位（**忽略**调用方内联数据）；trades/metrics 保留；分块内容原样 |
| `t_mark_succeeded_guard_blocks_non_running_and_writes_no_result` | queued / canceled ⇒ `false` + 无结果行 + 状态不翻；未知 id ⇒ `false` |
| `t_append_result_chunk_errors_are_surfaced` | 未知 run ⇒ FK Err；重复 (kind,seq) ⇒ PK Err（失败可上报 = 落 failed 的机制前提） |
| `t_result_chunks_paging_boundaries_and_kind_isolation` | offset 0 / 末块 / 越界 / 单块窗口；kind 隔离；逐页拼接 == 全量有序 |
| `t_result_chunks_in_range_intersection_matrix` | 恰好一块 / 跨块 / 外沿 / 单点 / 前后不相交 / 全量 / kind 隔离 |
| `t_legacy_single_default_discriminator_and_no_backfill` | 未指定判别列 ⇒ 默认 `legacy_single`；内联逐值可读；**无**分块行（不回填） |

### 3.2 `tester_p4_endpoints_indep.rs`（web 端点）
| 用例 | 断言要点 |
|---|---|
| `t_p4_real_run_chunked_endpoints_independent` | **直查 DB** 核对分块（5000+10、seq 单调、`ts_from/ts_to`=首末 bar ts）；`/brief` 20 字段齐备；`/result` 首页+`has_more`+`next_offset` 且与 `/bars` 首页逐值一致；分页边界（恰好一整块/跨块/末页/越界/上限 20000/逐页拼接逐值）；区间读跨块外沿 6 根且与分页切片一致；互斥与非法参数 5 类 400；`/curve` k=7 保首尾、缺省 2000、k≥n 不抽样、`kind=drawdown`；`/compare` k=50 抽样 + 标记 |
| `t_p4_crafted_legacy_and_chunked_dual_read_independent` | 手工 `legacy_single`：`/result` 全量内联 + `has_more=false` + `chunk_count=0`；`/bars` 分页可用；`/curve` 抽样取真值；无分块行。手工 `chunked_v1`：`/result` = summary + 首页（非空）+ `has_more`/`next_offset`（**不得把占位当数据**）；`net_value/drawdown` 实际形态记录 |
| `t_p4_probe_heterogeneous_chunk_size_invariant` | 异构块 `[7000,3000]` 探针（记录 `bars_total`/偏移映射的实际行为）+ 均匀块 `[5000,5000]` 对照（正确） |

### 3.3 `tester_p4_writepath_indep.rs`（application 写路径）
| 用例 | 断言要点 |
|---|---|
| `t_p4_chunk_write_failure_marks_run_failed_not_succeeded` | `fail_at=1/2` ⇒ 状态 `failed`、error 含「结果分块落库失败」、**无结果行**、分块数 0/≥1 |
| `t_p4_cancel_after_chunks_written_never_succeeds` | 并发取消胜出 ⇒ `canceled`、分块保留（≥1）、无结果行；分块 seq 无空洞且 `ts_from/ts_to` 自洽 |
| `t_p4_success_path_writes_all_chunks_before_result_row` | 11000 根 ⇒ 三 kind 各 3 块（5000/5000/1000）、seq 单调、逐块 `ts_from/ts_to` 与喂入 bar 对齐；结果行占位 |
| `t_p4_cooperative_cancel_never_marks_succeeded` | 协作式取消 ⇒ `canceled`、不落 succeeded、无结果行（分块 0..k 均可） |

### 3.4 `tester_p4_mcp_indep.rs`（MCP）
| 用例 | 断言要点 |
|---|---|
| `t_p4_mcp_bt_get_run_result_chunked_first_page_and_legacy_full` | chunked ⇒ 首页 5000 + `has_more` + `next_offset` + summary（非静默读空）；`limit=2` 生效；legacy ⇒ 全量 3 条 + `has_more=false`；无结果/未知 run ⇒ `isError` |

## 4. 边界与异常覆盖

- 分块序号：0 / 恰好一整块（5000）/ 跨块（4999+2）/ 末页 / 超末尾（offset=n）/ 超上限（limit 99999→20000）。
- 区间读：闭区间单点、跨块交集、块外沿（含末块外沿）、前后不相交、与分页切片等价。
- 抽样：k=0（钳到 1）、k=1（实际 2 点，记录）、k=7（保首尾）、k≥n（不抽样）、缺省 2000、上限 20000。
- 写路径异常：分块写失败（首块/第二块）、并发取消胜出、协作式取消。
- 迁移负向：非法 `kind`（CHECK 拒）、FK 级联删除、重复 PK。
- 未覆盖（明确声明）：`kind=net_value` 的 `/bars` 分页/区间读（仅覆盖 `per_bar` 分页区间 + `net_value/drawdown` 曲线）；
  多 run 并发的存储竞争；超大 run（>20 万根）内存/耗时。

## 5. 覆盖目标与达成

| 目标 | 达成 |
|---|---|
| 契约每个可观测出口至少 1 条独立断言（端口 4 方法 / `mark_succeeded` / `/brief` `/bars` `/curve` `/result` `/compare` / MCP） | 达成（14 用例） |
| 每个「不变量」类断言有判别力（能被打红） | 达成：异构块探针 + 均匀块对照；tangle 篡改回写探针；占位反探针（内联非空数据） |
| 失败可复现、无平台漂移 | 达成：注入式故障/取消确定性；并行与串行两次结果一致 |
