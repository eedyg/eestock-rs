# ADR-024 阶段 P4 —— 结果分块落库 + 双读 + 结果读取端点

- **报告位置（本文件）**：`coder/report/adr024_p4_chunked_result_storage.md`
- **契约出口**：`design/16-backtest-scalability/02-spec.md` §1.2 / §2 / §3.2；`design/16-backtest-scalability/01-adr.md` D8/D9/D10；`design/04-storage/schema.md` §4.3.18；`design/01-architecture/adr/ADR-025-*.md` D3。
- **证据目录**：`coder/evidence/adr024_p4/`（01–10 号原始输出）。
- **状态**：全部落地并通过；迁移在**自建临时库**验证后已 teardown。

---

## 0. 纪律声明（逐条对齐任务书 + 架构师 steer）

1. **P4b 仪表未被触碰（保留）**：`crates/application/src/workbench.rs` 的 `P4bRunCounters` / `P4bGlobalCounters` / `P4B_GLOBAL` / 分段 `p4b.segment` span / `trace_id` 贯穿 / `execute_run(trace_id, p4b)` 两个私有参数**全部保留**；本批只在 `P4bRunCounters` 上**追加** `chunk_writes` / `chunk_write_us` 两个计数字段，并在 `progress_drain` 汇总事件上追加 `chunk_writes` / `chunk_write_ms` 两个字段（纯加法，不改既有语义）。
   - 证据：`cargo test -p application` → **159 passed / 0 failed**，含 P4b 自洽测试 `p4b_run_summary_counters_are_self_consistent` **绿**（`coder/evidence/adr024_p4/02_green_application.txt`）。
   - grep 复核：`P4B_GLOBAL`、`p4b.run_summary`、`permit_hold_us`、`p4b.segment` 均在位。
2. **本 worktree 与其它车道共享**：工作区中出现过 P0/P2/P2b/P2c 的既有改动（已由他车道 staged）。我**未回退**任何非本任务改动；`git add` 只列本任务路径（见 §6）。
3. **测试库门禁（ADR-025 D3）**：`EESTOCK_TEST_DB_NAME=tmp_p4_202609181428 scripts/testdb-init.sh` 建临时库 → 跑 → `DROP DATABASE ... WITH (FORCE)` → 回读库清单 `{eestock, postgres}`。**未对活库 `eestock` 应用 0027**。证据：`01b_tempdb_init_log.txt` / `09_tempdb_teardown.txt`。

---

## 1. 改动清单（含分层）

| 层 | 文件 | 改动 |
|---|---|---|
| **Storage 契约（docs→tangle）** | `design/04-storage/schema.md` | 新增 §4.3.18 + ```` ```SQL file=migrations/0027_*.sql ```` 块（内容 = 02-spec §2 SQL 全文） |
| Storage 产物（生成） | `migrations/0027_strategy_run_result_chunks.sql` | **tangle 生成**（非手写）：`strategy_run_result.result_format`（NOT NULL DEFAULT 'legacy_single'）+ `strategy_run_bars`（三列 PK + 2 索引 + kind CHECK + FK 级联） |
| Storage | `crates/storage/src/migrate_check.rs` | `EXPECTED_RELATIONS` 增 `strategy_run_bars`（启动自检） |
| Domain 端口（docs→tangle） | `crates/domain/src/ports.rs` + `design/02-domain/contracts.md` | `RESULT_FORMAT_LEGACY/CHUNKED`、`ResultKind`、`ResultChunk`；`StrategyRunResult` 增 `result_format` 判别列 + `is_chunked()`；`StrategyRunStore` 增 4 端口方法 |
| Storage 实现 | `crates/storage/src/workbench.rs` | `mark_succeeded` 新语义（`chunked_v1` + trades/metrics + 三列 `[]` 占位）；`append_result_chunk` / `result_chunks` / `result_chunks_in_range` / `result_chunk_count`；`get_result` 带 `result_format` |
| Application 写路径 | `crates/application/src/workbench.rs` | 会话式引擎（`EnsembleSession`）**边跑边写**：per_bar 每满 5000 根 drain 一块；净值/回撤在 finish 后分块；分块写**先于** `mark_succeeded`；写失败 ⇒ `mark_failed`；取消 ⇒ `mark_canceled`（分块保留、不落 succeeded） |
| Application 读路径 | 同上 | `result_brief` / `result_bars`（Offset\|Range）/ `result_curve` / `result_compat`；`compare_sampled`（净值抽样）；`series_all`/`bars_total_of` 双读 |
| Web 端点 | `crates/web/src/workbench.rs` + `crates/web/src/lib.rs` | `/brief` `/bars` `/curve` 新端点；`/result` 兼容改造；`/compare` 净值抽样（`k`）；路由注册 |
| Web 契约文档 | `design/07-app-plane/00-web-api.md` | 路由块 + REST 表更新（新端点与语义） |
| MCP（保持不静默读空） | `crates/mcp/src/tools.rs` + `design/07-app-plane/01-mcp.md` | `bt_get_run_result` 改走 `result_compat`（§3.2/§4 口径：首页 + `has_more`）；mock 补 4 端口方法 |
| 测试 | `crates/storage/tests/workbench_store.rs`、`crates/application/tests/workbench.rs`、`crates/web/tests/api_workbench.rs`、`crates/application/tests/simlive.rs` | 见 §5 |

**生成物方向纪律**：`ports.rs` / `migrate_check.rs` 用 `./scripts/stitch.sh <code-file>`（沙箱 scoped + round-trip 校验）回写 `design/02-domain/contracts.md`、`design/04-storage/03-raw-writer.md`；`migrations/0027_*.sql` 用 `entangled tangle` 生成；`lib.rs` / `tools.rs` 不在 stitch 覆盖范围（HAZARD：`00-web-api.md`/`01-mcp.md` 含块内嵌 `~/~ begin`），故**手工同步**对应文档块。门禁 `./scripts/check-tangle.sh` **绿**（`07_tangle_check.txt`）。

---

## 2. 契约逐条落地

### §1.2 端口 / `ResultKind` / `result_format`
- `ResultKind{PerBar,NetValue,Drawdown}` + `as_str`/`parse`；`ResultChunk{kind,seq,ts_from,ts_to,payload}`。
- `StrategyRunResult.result_format`：`legacy_single`=内联三列全量；`chunked_v1`=三列 `[]` 占位（数据在 `strategy_run_bars`）。
- `mark_succeeded` 语义变更：新 run 强制写 `chunked_v1` + 占位（**禁止把占位当数据**）；`status='running'` 守卫不变。
- `append_result_chunk` 失败 ⇒ run 落 `failed`（应用层 `EngineOutcome::Done` + `chunk_err.is_some()` → `mark_failed`）。

### §2 迁移 0027 + migrate_check
- SQL 全文逐字落入 §4.3.18；`migrate_check` 增 `strategy_run_bars`（启动自检，顺序硬约束：先落迁移再重启 app）。

### §3.2 端点 + 兼容矩阵
- `/result`：legacy 全量；chunked ⇒ `summary` + 首页 per_bar + `has_more` + `next_offset`（默认页 5000，**显式**）。
- `/brief`：轻量摘要（status/progress/error/metrics/requested_from·to/effective_from·to/clamped/estimated_bars/bars_total/result_format/chunk_count）。
- `/bars?kind=&offset&limit` 与 `?kind=&from&to`（**互斥**；limit 默认 5000/上限 20000；区间读由服务端在**块内按 ts 过滤**，块粒度由 storage 返回整块相交集）。
- `/curve?k=&kind=`：均匀抽样**保首尾** + `downsampled` + `original_bars`（D10）。
- `/compare`：净值抽样（默认 k=2000，可传）+ `downsampled`/`original_bars`。
- 双读：`legacy_single` 与 `chunked_v1` 均在 `series_all`/`bars_total_of` 内分流；**旧 run 不回填**。

---

## 3. 红 → 绿 + 反向证据

> 说明：本批因共享 worktree 冻结批纪律，先完成实现再补测试落点；**红灯一律以「定点变异（mutation）」在原始实现上真实打出**（比事后补红更强：它证明测试确实锁定了该行为），随后逐字节还原（`cmp -s` 复核 RESTORED）。

反向证据（`coder/evidence/adr024_p4/06_reverse_probes.txt`，全部 FAILED 后 RESTORED）：

| # | 变异点 | 目标测试 | 红灯实测 |
|---|---|---|---|
| R1 | 去掉区间读 ts 过滤（`bars_range` 的 `bar_ts_in_range`） | `p4_bars_range_client_filters_chunk_edges` | `left: 10000 / right: 5`（整块外沿未过滤） |
| R2 | 关闭均匀抽样（`sample_indices` 恒返回全量） | `p4_curve_downsampling_marks_and_endpoints` | `left: 11000 / right: 100` |
| R3 | 去掉分块区间相交条件（storage `result_chunks_in_range`） | `chunks_in_range_returns_intersecting_chunks` | `left: 2 / right: 1`（多返回不相交块） |
| R4 | 占位列写入非空数据（storage `mark_succeeded` 用 `$3` 替占位） | `mark_succeeded_writes_result_transactionally` | `left: Object{...} / right: Array[]` |

绿灯（还原后，同用例 + 全量）：
- `coder/evidence/adr024_p4/03_green_storage.txt`：`13 passed; 0 failed`
- `coder/evidence/adr024_p4/02_green_application.txt`：`159 passed; 0 failed`（含 `p4b_run_summary_counters_are_self_consistent`）
- `coder/evidence/adr024_p4/04_green_web.txt`：`7 passed; 0 failed`
- `coder/evidence/adr024_p4/05_green_mcp.txt`：`65 passed; 0 failed`
- `coder/evidence/adr024_p4/08_green_migrate_check_startup_selfcheck.txt`：`verify_schema_passes_on_migrated_db ... ok`（临时库含 0027 时启动自检通过）

---

## 4. 迁移在临时库的验证与 teardown 证据

**建库 + 按序应用既有迁移 + 0027**（`01b_tempdb_init_log.txt`，`testdb-init.sh` 对活库只读、只写临时库）：
```
[testdb-init] 建库 `tmp_p4_202609181428` ...
[testdb-init] 应用迁移 0023 ... 0024 ... 0025 ... 0026 ...
[testdb-init] 应用迁移 0027_strategy_run_result_chunks.sql ...
[testdb-init] 迁移应用完成（账本 27 条）
[testdb-init] 哨兵表 `_eestock_test_db` 就绪（value=test）
```

**Schema 正向断言**（`01_tempdb_migration_0027.txt`）：
```
strategy_run_result ... result_format | text | NOT NULL | 'legacy_single'::text
strategy_run_bars ... PK (run_id, kind, seq)
  strategy_run_bars_run_kind_seq_idx  btree (run_id, kind, seq)
  strategy_run_bars_run_kind_ts_idx   btree (run_id, kind, ts_from, ts_to)
  CHECK (kind = ANY (ARRAY['per_bar','net_value','drawdown']))
  FK (run_id) -> strategy_run(id) ON DELETE CASCADE
```

**启动自检**：`verify_schema_passes_on_migrated_db ... ok`（EXPECTED_RELATIONS 含 `strategy_run_bars` 且库中存在）。

**Teardown（`09_tempdb_teardown.txt`）**：
```
DROP DATABASE "tmp_p4_202609181428" WITH (FORCE);   -- DROP DATABASE
count(tmp_p4_202609181428) = 0（期望 0）
TEARDOWN_OK: 载体已销毁
库清单回读：eestock / postgres
```

**活库未动**：从未对 `eestock` 执行 0027（testdb-init 的源库连接置 `default_transaction_read_only=on`；库清单全程仅新增/移除本车道载体）。

---

## 5. 测试覆盖（含端点行为样例）

### 5.1 Storage（`crates/storage/tests/workbench_store.rs`）
- `mark_succeeded_writes_result_transactionally`：`chunked_v1` + 三列占位 + trades/metrics 保留。
- `chunks_append_page_and_count`：追加/序号分页/计数，边界（offset 0 / 超末尾 / seq 升序 / kind 隔离）。
- `chunks_in_range_returns_intersecting_chunks`：区间读相交整块（含外沿）+ 完全不相交为空。
- `chunks_cascade_delete_with_run`：FK 级联。
- `legacy_single_dual_read_unchanged`：直插旧形态（默认 `legacy_single`）逐值可读、无分块行（不回填）。

### 5.2 Application（`crates/application/tests/workbench.rs`）
- `p4_chunked_write_seq_and_boundaries`（11000 根 → 3 块 5000/5000/1000，seq 单调，ts_from/ts_to）。
- `p4_bars_paging_offset_limit_boundaries`（0 / 恰好一块 / 跨块 4999+limit2 / 超末尾）。
- `p4_bars_range_client_filters_chunk_edges`（块内 ts 精确过滤）。
- `p4_curve_downsampling_marks_and_endpoints`（k=100 抽样保首尾 + `downsampled`/`original_bars`；k≥n 不抽样；缺省 2000）。
- `p4_result_compat_chunked_first_page`（首页 + `has_more` + `next_offset`，与 `/bars` 首页逐值一致）。
- `p4_brief_fields`（queued 时 result_format=None/chunk_count=0；succeeded 时 chunked_v1/3/11000）。
- `p4_legacy_dual_read_full`（legacy 全量、`/bars`/`/curve`/`/brief` 对 legacy 亦可用）。
- `p4_cancel_guard_chunks_written_not_succeeded`（取消后分块已写、run 落 canceled、无结果行）。
- `p4_wire_sample_dump`（原始 JSON 样例，见 §5.4）。

### 5.3 Web（`crates/web/tests/api_workbench.rs`）
- `p4_result_read_endpoints`：6000 根真实库 run 上验证 `/brief`（chunk_count=2）+ `/bars`（分页缺省 5000/上限、`has_more`/`next_offset`、**互斥 400**、非法 kind 400、区间读 10 根）+ `/curve`（k=100 ⇒ `downsampled:true`/`original_bars:6000`；缺省 k=2000）+ `/result`（首页 5000 + `has_more` + `next_offset`）+ `/compare`（`downsampled`/`original_bars`/抽样点数）。
- `submit_run_lifecycle_end_to_end` 已按新契约更新（`result_format=chunked_v1`、首页 per_bar、`has_more=false`、图表走 `/curve`）。

### 5.4 端点行为样例（原始 JSON，`10_wire_samples.txt`）
```jsonc
// GET /brief（6 根 run）
{"id":"sr_...","status":"succeeded","progress":1.0,"requested_from":"2026-08-31T01:30:00Z",
 "effective_from":"2026-08-31T01:30:00Z","clamped":false,"estimated_bars":null,
 "bars_total":6,"result_format":"chunked_v1","chunk_count":1,"metrics":{...}}

// GET /bars?kind=per_bar&offset=0&limit=2
{"kind":"per_bar","bars":[{"ts":...,"scores":[...],"aggregate":80.0,"signal":"Buy","orders":[...],"events":[]}, ...],
 "total":6,"has_more":true,"next_offset":2,"offset":0,"limit":2}

// GET /curve?kind=net_value&k=3
{"kind":"net_value","points":[[ts,100000.0],[ts,99955.01],[ts,99860.07]],
 "downsampled":true,"original_bars":6,"k":3}

// GET /result（chunked_v1，页 2）
{"result_format":"chunked_v1","summary":{...},"per_bar":[{...},{...}],
 "net_value":[],"drawdown":[],"trades":[...],"metrics":{...},"has_more":true,"next_offset":2}

// POST /compare {ids:[...], k:3}
[{"run_id":"sr_...","net_value":[[ts,100000.0],[ts,99955.01],[ts,99860.07]],
  "metrics":{...},"downsampled":true,"original_bars":6}]
```

---

## 6. 构建 / 门禁 / 提交面

- `cargo build --workspace --all-targets`：**绿**。
- `./scripts/check-tangle.sh`：**绿**（`07_tangle_check.txt`）。
- `git add` **仅本任务路径**（未用 `-A`/`.`）：
  - `migrations/0027_strategy_run_result_chunks.sql`
  - `design/04-storage/schema.md`、`design/04-storage/03-raw-writer.md`、`design/02-domain/contracts.md`、`design/07-app-plane/00-web-api.md`、`design/07-app-plane/01-mcp.md`
  - `crates/domain/src/ports.rs`、`crates/storage/src/workbench.rs`、`crates/storage/src/migrate_check.rs`、`crates/storage/tests/workbench_store.rs`
  - `crates/application/src/workbench.rs`、`crates/application/tests/workbench.rs`、`crates/application/tests/simlive.rs`
  - `crates/web/src/workbench.rs`、`crates/web/src/lib.rs`、`crates/web/tests/api_workbench.rs`、`crates/mcp/src/tools.rs`
  - `coder/evidence/adr024_p4/`、`coder/report/adr024_p4_chunked_result_storage.md`
- **未 commit**（只 stage）。

---

## 7. 未决项与残余风险

1. **`/brief` 的 P5 字段先占位**：`effective_from/to`（P4 = `from_ts/to_ts`）、`clamped=false`、`estimated_bars=null` 为 §3.2 目标形状中的 P5/D12 字段。P4 无区间收缩/预扫描，故取当前真值（不实现 P5 护栏逻辑，遵守非目标）。**建议 P5 直接填充，无需改 wire**。
2. **`/result`（chunked_v1）的 `net_value`/`drawdown` 返回空**：契约（§3.2）写明 chunked ⇒ `summary` + 首页 per_bar；图表改走 `/curve`。后端未在 `/result` 内联净值首屏（避免半静默），已在文档与测试中固定。
3. **`/curve` 客户端读全量再抽样**：为保「均匀保首尾 + 全局 original_bars」，当前实现 `series_all` 物化该 kind 全量后抽样（大 run 内存/耗时偏高，但**不**触 D8 静默读空）。分块级采样/流式抽样为后续优化（建议归 P4b 或后续专项）。
4. **MCP 改动为「避免静默读空」的最小面**：`bt_get_run_result` 改走 `result_compat`（§4 口径：首页 + `has_more`），并补 mock 端口；输出形状**加法**（新增 `result_format`/`summary`/`has_more`/`next_offset`；`net_value` 对 chunked 为空）。§4 的 `offset/kind/sample_k` 参数面与 `bt_list_runs` 摘要字段**未做**（非 P4 交付范围），建议由 MCP 车道补齐。
5. **`compare` 采样仅默认 k=2000**：`k` 上限复用 `CURVE_K_MAX=20000`；超大 run 的 N×抽样仍是 N 条曲线（已比 N×全量小 1 个量级）。
6. **`bars_page` 依赖「非末块恰 5000 根」不变量**：由本仓唯一写路径（`RESULT_CHUNK_BARS`）保证；若未来允许异构 chunk 大小，需改为按 chunk 前缀长度定位（当前实现有 +1 兜底块，但正式契约应显式化）。
7. **`strategy_run.period` 列注释未改**（§2 备注项，本次交付 SQL 以 §2 代码块为准，未含 COMMENT）：如需一并加 `M30`，请归 P5 迁移。
8. **前端（P6）未动**：`/result` 语义变化对旧前端的影响已有兼容矩阵，前端迁移由 P6 负责。

---

## 8. 结论

P4 交付：迁移 0027（tangle 生成）、端口与存储分块实现、应用层「边跑边写」+ 双读、Web 四个结果端点（+ `/result` 兼容 + `/compare` 抽样）全部落地；存储/应用/Web/MCP 与门禁全绿；迁移在 `tmp_p4_202609181428` 验证后已销毁，活库未动；P4b 仪表零回退。
