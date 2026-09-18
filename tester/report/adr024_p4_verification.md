# ADR-024 P4 独立验收报告（结果分块落库 + 双读 + 端点）

- **本报告自身路径**：`tester/report/adr024_p4_verification.md`
- 角色：tester（**只验不改生产代码**；本批**未** `git add` / `commit`）
- 验收对象：`coder/report/adr024_p4_chunked_result_storage.md` + `coder/evidence/adr024_p4/`
- 契约出口：`design/16-backtest-scalability/02-spec.md` §1.2 / §2 / §3.2 / §4；`01-adr.md` D8/D9/D10；`design/04-storage/schema.md` §4.3.18
- 验收时间：2026-09-18 14:38–14:51（+08:00）；基线 commit `18d1b9a`（工作区 = 共享冻结批 index 快照，187 条）
- 证据目录：`tester/evidence/251_adr024_p4_verify/`（17 个原始输出文件，本报告逐项引用）
- 新增测试设计报告：`tester/design/293_adr024_p4_verify_design.md`

---

## 判词（最前）

### 结论：**PASS**（后端 P4 可冻结）—— 硬性未过项 **0** 项；非阻塞发现 6 项（F1/F2b/F3–F6，均不阻断冻结）；**上线前硬门槛 1 项：F2 前端 P6（未完成 ⇒ 0027 不得单独上线）**

| 项 | 结果 | 关键证据 |
|---|---|---|
| ① 迁移正确性 | **PASS** | `02-spec §2` == `schema.md §4.3.18` == `migrations/0027`（19 行逐字节相同）；沙箱 tangle 复算 sha256 相同（篡改探针可判红）；`check-tangle` 绿；活库 `strategy_run_bars` 不存在、`result_format` 列不存在 |
| ② 判别列 + 禁止静默读空 | **PASS**（含 F2b 形状说明） | chunked ⇒ `/result` 给 summary + 首页 5000 + `has_more` + `next_offset`；三列占位**未被当数据**返回（内联反探针：store 忽略调用方传入的非空内联数据）；legacy ⇒ 全量且零分块行 |
| ③ 分块读边界 | **PASS** | offset 0 / 恰好一整块 / 跨块 / 末页 / 超末尾 / 超上限；区间读跨块含外沿按 ts 精确过滤；逐页拼接逐值 == 期望序列（无重复无缺失） |
| ④ 写路径语义 | **PASS** | 分块先于 `mark_succeeded`（失败/取消场景无结果行）；写失败 ⇒ `failed`（fail_at=1/2）；取消 ⇒ `canceled`（分块保留，不落 succeeded）；`status='running'` 守卫不变；seq 单调、`ts_from/ts_to`=本块首末 bar ts |
| ⑤ 抽样端点 | **PASS** | `/curve` 缺省 2000 / 上限 20000 / 保首尾 / `downsampled`+`original_bars`；`/compare` 净值抽样且带标记；`/brief` 20 字段齐备 |
| ⑥ MCP | **PASS** | `bt_get_run_result` chunked ⇒ 首页 + `has_more`/`next_offset`（**不静默读空**）；legacy ⇒ 全量；无结果 ⇒ `isError` |
| ⑦ 回归 + 稳态 | **PASS** | `cargo test -p storage -p application -p web -p mcp` = **485 passed / 0 failed / 63 suites**（含 145 个既有 DB 门禁用例）；`cargo check --all-targets` 绿；`check-tangle` 绿；P4b 仪表在位且 `p4b_run_summary_counters_are_self_consistent` 绿 |
| ⑧ 范围与并发纪律 | **PASS（P4 侧）** | P4 自述 17 路径全部在 index 且 index==工作区（无末刻手改）；index 另含 40 个**非 P4** 路径（其它车道/架构师）——逐条见证据 14；设计/16 无 P4 侧改动证据（详见 §8） |
| 崩溃 / core | 无 | `ulimit -c 0`，无 core 文件，全部 suite `ok`（无 SIGSEGV/panic 逃逸） |

**P4 可否冻结**：**可以（条件式）**。三条前置已满足：① 契约出口逐字对齐且可复算；② 独立用例（非复用 worker 断言）全绿；③ 活库未迁移、临时库已销毁、无残留行。冻结时应把下列**批次级**事项写进冻结记录（非 P4 违约，但按 `04-implementation-plan.md §3.5 规则 2` 必须核验）：index 内 40 个非 P4 路径属其它未 commit 车道，冻结批须逐条确认为「半成品 or 已完成」。

**前端缺口确认（硬门槛）**：`web/src` 对 P4 新契约**零消费**——`has_more` / `next_offset` / `downsampled` / `original_bars` / `result_format` / `chunk_count` / `bars_total` 命中 **0**；URL 级 `runs/…/brief`、`runs/…/bars`、`runs/…/curve` 命中 **0**（唯一字面 `/bars` 命中是 `KlineChart.tsx:382` 注释里的 `W/bars`，非端点）；只有 `runs/…/result` 4 处命中（证据 `13_frontend_gap.txt`）。前端仍只走 `GET …/result` 全量，并按内联字段渲染：
`ResultView.tsx:165,169,170,188`（`result.per_bar` / `result.net_value` / `result.drawdown`）、`ComparePanel.tsx:41`（客户端 `downsample(r.net_value)`）、`types.ts:1000-1002`（`WorkbenchRunResult` 无判别列/分页字段）。
⇒ **0027 一旦上线，新 run 变 `chunked_v1`：净值/回撤图会「静默空」、逐 bar 表只显示前 5000 根且前端无任何提示**。因此：**P4 后端可冻结，但「应用 0027 + 重启 app」必须等 P6 前端消费 `/curve` `/bars` 与 `has_more`/`downsampled` 之后再上线**（与 spec §3.2 兼容矩阵、§6 第 7 行的 P6 归属一致）。

---

## 0. 环境与纪律

| 项 | 值 |
|---|---|
| 临时库 | `EESTOCK_TEST_DB_NAME=tmp_p4verify_20260918143844 scripts/testdb-init.sh` → 账本 27 条（含 0027）+ 哨兵表 `_eestock_test_db`；用完 `DROP DATABASE … WITH (FORCE)` |
| 收尾回读 | `count(tmp_p4verify_…) = 0`；库清单 `{eestock, postgres}`（证据 `17_teardown.txt`） |
| **活库 `eestock`** | **未应用 0027**：`to_regclass('public.strategy_run_bars') IS NULL` → `t`；`strategy_run_result.result_format` 列数 → `0`；近 3 小时新建 run 数 → `0`（总行数 374 不变）（证据 `03_live_db_untouched.txt` / `17_teardown.txt`） |
| 测试库残留 | 全套重跑后 `strategy_run` / `strategy_run_bars` / `strategy_run_result` 残留 **0 / 0 / 0**（证据 `16_residue_after_rerun.txt`；开发期失败尝试留下的 12 行已在临时库内清理并注明） |
| 提交面 | `git diff --cached --name-only` = 187（与验收开始时一致）；tester **未** `git add`/`commit`；新增 4 个测试文件为 `??` 未跟踪、1 个 design 报告 + 1 个本报告未跟踪 |

---

## 1. ① 迁移正确性

**(a) 三方逐字节**（`01_spec_vs_migration_bytes.txt`）：

```
02-spec §2 代码块行数: 19
schema.md §4.3.18 块行数: 19
0027 产物（去 ~/~ 包裹行）行数: 19
spec == schema.md : True     spec == 0027 产物 : True     schema == 0027 产物: True
```

点名核对（原文行号）：`ADD COLUMN IF NOT EXISTS result_format text NOT NULL DEFAULT 'legacy_single'`（L6）；`run_id text NOT NULL REFERENCES strategy_run(id) ON DELETE CASCADE`（L11）；`kind text NOT NULL CHECK (kind IN ('per_bar','net_value','drawdown'))`（L12）；`seq integer NOT NULL`（L13）；`ts_from/ts_to timestamptz NOT NULL`（L14/15）；`payload jsonb NOT NULL`（L16）；`PRIMARY KEY (run_id, kind, seq)`（L17）；两个 `CREATE INDEX IF NOT EXISTS`（L19/20：`(run_id,kind,seq)`、`(run_id,kind,ts_from,ts_to)`）；注释行 4 处逐字一致。

**(b) 未经手改（tangle 产物 == 源块）**（`02_tangle_check_and_regen.txt`）：
- `git show :migrations/0027_…sql` 与工作区 sha256 均为 `ed972b0d506a7a89791d4aff09791c3aeff594602709dd00f549e28ffd1bf837`（无末刻手改）；`schema.md` 暂存==工作区。
- `./scripts/check-tangle.sh` → `✅ design 与生成物一致`，exit 0。
- **独立复算**：沙箱（拷贝 `design/` + 产物、清空 filedb）内 `entangled tangle -f` 重新生成 → 0027 sha256 与仓库相同。
- **判别力反向对照**：向沙箱产物注入一行手改 → `tangle -f` 后该行消失、sha256 回到仓库值（证明相等是「由文档生成」，不是偶合）。

**(c) 临时库落地形态 + 负向约束**（`05_tempdb_schema_probe.txt`）：
- `result_format | text | NO | 'legacy_single'::text`；六列类型/可空性逐条符合。
- `strategy_run_bars_pkey = PRIMARY KEY (run_id, kind, seq)`；`strategy_run_bars_kind_check = CHECK (kind = ANY (ARRAY['per_bar','net_value','drawdown']))`；`strategy_run_bars_run_id_fkey = FOREIGN KEY (run_id) REFERENCES strategy_run(id) ON DELETE CASCADE`；两个索引创建语句与文档一致（外加 PK 自带唯一索引）。
- 负向探针：非法 `kind` ⇒ `check_violation` 被拒；`DELETE strategy_run` ⇒ 分块 `1 → 0`（级联生效）；探针行收尾回读 0。

**(d) 活库未被迁移**：见 §0 表（`t` / `0`）。

**残项（非阻塞）R3**：`spec §2` 的「配套」第 3 条（`strategy_run.period` 列注释加 `M30`）**未做**——`migrations/0027` 与 `schema.md §4.3.18` 内 `COMMENT ON` 计数均为 0，活库该列注释当前为 NULL。worker 报告 §7.7 已自陈并建议归 P5。仅文档语义，无约束/行为影响。

---

## 2. ② 判别列与「禁止静默读空」

**(a) chunked_v1（真实写路径 / 手工造行两种）**
- `/result` 返回 `result_format = "chunked_v1"`、`summary`（含 `bars_total`/`chunk_count`/`result_format`）、**首页 bars 非空**（真实 run 5010 根 ⇒ 首页 5000 根，首根 ts == 首 bar ts）、`has_more = true`、`next_offset = 5000`（`08_indep_web_endpoints.txt`）。
- 与 `/bars?offset=0&limit=5000` 首页**逐值相等**（两路径同源，排除「首页是空占位」的可能）。
- storage 侧反探针（`07_indep_storage.txt` 之首用例）：调用方故意传 **非空**内联 `per_bar/net_value/drawdown` 且谎报 `result_format='legacy_single'` ⇒ 落库仍为 `chunked_v1` + 三列 `[]` 占位（原始行 `per_bar::text == "[]"`），trades/metrics 保留。**占位不是数据**在写入侧被硬保证。
- legacy 形态（手工插行、未指定判别列）⇒ `legacy_single`、内联三列逐值可读、**零分块行**（不回填）。

**(b) 形状说明 R2（非阻塞，需 P6 处置）**：chunked 下 `/result` 的 `net_value`/`drawdown` 为 `[]`（probe 原文：`[probe] /result(chunked_v1) net_value=[] drawdown=[]`），只有 `result_format`/`summary` 能判别「数据在别处」；这不是把占位内容当数据返回，但对「只看 net_value 数组」的旧客户端仍呈现为静默空。worker 已在 `design/07-app-plane/00-web-api.md` 与用例中固定口径（图表走 `/curve`）、落地 §3.2 兼容矩阵。建议 P6 上线前二选一：前端严格 gate `result_format`；或在响应中加显式 `net_value_omitted: true` / 返回净值首屏。

---

## 3. ③ 分块读边界（真实 run 5010 根 = 5000 + 10；直查 DB 核对）

**分块不变量**（`08_indep_web_endpoints.txt`，真实 run）：
```
per_bar: 块数 2，seq [0,1]，长度 [5000, 10]
c0.ts_from = bars[0].ts      c0.ts_to = bars[4999].ts
c1.ts_from = bars[5000].ts   c1.ts_to = bars[5009].ts
net_value / drawdown 同构（各 2 块、同首末 ts）
```

**offset/limit 边界**：

| 请求 | 结果 |
|---|---|
| `offset=0&limit=5000`（恰好一整块） | 5000 根、`has_more=true`、`next_offset=5000`、`limit=5000` 回声 |
| `offset=4999&limit=2`（跨块） | 2 根 == `[bars[4999], bars[5000]]`（无重复/无缺失）；`next_offset=5001` |
| `offset=5009&limit=2`（跨块+末页） | 1 根 == `bars[5009]`、`has_more=false`、`next_offset=null` |
| `offset=5010`（超末尾） | 0 根、`has_more=false`、`total` 仍 5010 |
| `offset=0&limit=99999`（超上限） | `limit` 回声 **20000**、5001→5010 根全量、`has_more=false` |
| 逐页拼接（limit=1000，命中 `next_offset` 循环） | 5010 个 ts **逐值等于**期望序列（严格递增、无重复无缺失） |

**区间读（闭区间，块内按 ts 精确过滤）**：`from=bars[4998]&to=bars[5003]` ⇒ 6 根逐值等于期望切片（跨块边界 4999|5000 与末块外沿均正确）；单点区间 ⇒ 1 根；区间无数据 ⇒ 0 根（非报错）；区间读与等长分页切片**逐值相等**；`from/to` 回声与请求一致。
**参数面**：`offset/limit` 与 `from/to` 同给 ⇒ 400；只给 `from` ⇒ 400；非法 `kind` ⇒ 400；`from>to` ⇒ 400；非 RFC3339 ⇒ 400。
**storage 侧区间相交矩阵**（`07_indep_storage.txt`）：恰好一块 / 跨块 / 外沿（含「ts=10 同时是前块 to 外沿与后块首根」）/ 前后完全不相交为空 / 全量 / kind 隔离，全部符合。
**分页边界（storage，chunk 序号单位）**：offset 0、末块、越界（5/999）、单块窗口、kind 隔离、逐页拼接 == 全量有序。

**残项 R1（RISK，低概率但应显式化）**：应用侧的「bar offset → chunk 序号」映射与 `bars_total` 计算**假设非末块恰 5000 根**（`chunked_page`：`first_chunk = offset/5000`；`bars_total_of`：`(count-1)*5000 + last_len`），该不变量**只由唯一写路径保证**（引擎每 bar 必产一条 per_bar 记录 + non-last 块满 5000 落块，已核 `strategy-core/src/engine.rs:430/441`），**未写入 spec、storage 也不强制**。异构块探针（`[7000,3000]`，10000 根真值）实测：`/brief bars_total=8000`、`offset=6000&limit=2` 返回 `bars[8000]` 而非 `bars[6000]`、`total/has_more` 随之错；均匀块 `[5000,5000]` 对照完全正确。建议 P5/P6 前把该不变量写进契约（或改按 chunk 前缀长度定位 / storage 暴露 chunk span）。

---

## 4. ④ 写路径语义（真实 DB store + 确定性注入）

| 场景 | 实测（`09_indep_writepath.txt`） |
|---|---|
| `append_result_chunk` 第 1 次失败 | `status=failed`、`error="结果分块落库失败: [tester 注入] 第 1 次 …"`、分块 0、**无结果行** |
| 第 2 次失败 | `status=failed`、分块 1（首块残渣可观测）、**无结果行** ⇒ `mark_succeeded` 未执行（分块写先于结果行） |
| 并发取消胜出（分块写成功后 DB 落 canceled） | `status=canceled`、分块 ≥1 **保留**、**无结果行**（`status='running'` 守卫拦住 succeeded）；分块 seq 无空洞、`ts_from/ts_to` = 本块首末 bar ts |
| 协作式取消（submit 后立即 `cancel`） | `status=canceled`、不落 succeeded、无结果行（分块 0..k 均可） |
| 成功路径（11000 根） | 三个 kind 各 3 块（5000/5000/1000），seq 单调，逐块 `ts_from/ts_to` 与喂入 bar 序列逐值对齐；结果行 `chunked_v1` + 三列 `[]` |
| storage 守卫直测 | queued/canceled ⇒ `mark_succeeded` 返回 `false` 且不写结果行；未知 id ⇒ `false`；取消后分块保留 |

机制前提（storage 侧失败可上报）：未知 run 的 append ⇒ FK Err；重复 `(kind,seq)` ⇒ PK Err（`07_indep_storage.txt` probe 原文）。这两个错误在应用层被 `chunk_err` 捕获 → `mark_failed`。

---

## 5. ⑤ 抽样端点

- **`/curve`**：`k=7` ⇒ 7 点、`downsampled=true`、`original_bars=5010`、首点 == 全量首点、末点 == 全量末点、ts 严格递增（无重复点）；缺省 ⇒ `k=2000`、2000 点、`downsampled=true`；`k=20000 (≥n)` ⇒ `downsampled=false`、点数 == n、`k=20000`；`kind=drawdown` 同样成立；非法 kind ⇒ 400。
- **边界观察（R4，INFO）**：`k=1`（以及 `k=0` 被钳到 1）实际返回 **2 个点**（保首尾），响应 `k=1` 与 `points.len()=2` 不一致（probe：`[probe] /curve k=1 → k=1 points=2 downsampled=true`）。契约未定义 k=1 语义，建议文档写明或钳到 2。
- **`/compare`**：`k=50` ⇒ `downsampled=true`、`original_bars=5010`、50 点、保首尾、`metrics` 并排；不传 `k` ⇒ 2000 点（禁止 N×全量）。
- **`/brief`** 字段齐备：`id/name/symbol/period/status/progress/error/created_at/started_at/finished_at/requested_from/requested_to/effective_from/effective_to/clamped/estimated_bars/bars_total/result_format/chunk_count/metrics`（20/20 命中）；值：`status=succeeded`、`progress=1.0`、`bars_total=5010`、`chunk_count=2`、`result_format=chunked_v1`、`clamped=false`、`effective_* == requested_*`、`estimated_bars=null`（P5 占位，与 worker §7.1 声明一致）；legacy 行 ⇒ `chunk_count=0`、`bars_total=3`。

---

## 6. ⑥ MCP

`10_indep_mcp.txt`（真实 DB + `mcp::rpc::dispatch`）：
- **chunked_v1**（6000 根 = 5000+1000）：`bt_get_run_result` ⇒ `result_format="chunked_v1"`、`per_bar` 5000 条（首条 ts == 首 bar）、`has_more=true`、`next_offset=5000`、`summary.bars_total=6000`、`summary.chunk_count=2`、`metrics` 透出；**不静默读空**。`limit=2` ⇒ 2 条 + `next_offset=2`。
- **legacy_single**：全量 3 条 `per_bar` + 全量 `net_value`/`drawdown`、`has_more=false`、`next_offset=null`。
- 无结果 run / 未知 run ⇒ `result.isError=true`（`工具执行失败：… 尚无结果（未成功完成）` / `运行不存在`）——无静默空成功。
- 工具 schema 实录：`{run_id, limit}`，描述明示「legacy 全量 / chunked 首页 + has_more/next_offset，显式截断非静默」。
- **残项 R5（INFO）**：`spec §4` 表格的 `offset/kind/from/to/sample_k` 参数面与 `bt_list_runs` 的 `bars_total/result_format` 摘要字段**未实现**（worker §7.4 已声明为非 P4 范围）。当前 MCP 侧只有 `limit` 首页，「大区间改走分页/抽样」在 MCP 无法落地 ⇒ 建议 P5/P6 或 MCP 车道补齐（否则 §4 目标形状未达成）。

---

## 7. ⑦ 回归 + 稳态

```
cargo test -p storage -p application -p web -p mcp   → 63 suites: 485 passed; 0 failed; 0 ignored  (37.9s)
                                                        （含 tester 独立 14 例；145 个既有 DB 门禁用例真跑，无「环境性失败」）
cargo check --all-targets                            → Finished dev profile（exit 0，无 warning 升级为 error）
./scripts/check-tangle.sh                            → ✅ exit 0
verify_schema_passes_on_migrated_db                  → ok（含 EXPECTED_RELATIONS 的 strategy_run_bars）
```

- **P4b 仪表未被回退**（`12_p4b_instrumentation.txt`）：`P4B_GLOBAL` 6 处、`p4b.segment` 14 处、`permit_hold_us` 6 处、`chunk_writes` 3 处在位；定向用例 `p4b_run_summary_counters_are_self_consistent` **绿**，捕获输出显示既有分段（`mark_started/engine/progress_drain/progress_drain_tail/result_serialize/result_write`）与 `p4b.run_summary` 全字段齐全，且 `progress_frames_produced(300) == progress_db_writes(300)`；本批为纯加法（新增 `chunk_writes`/`chunk_write_ms`）。
- 崩溃/core：无（`ulimit -c 0`、无 core 文件、无 suite 失败）。

---

## 8. ⑧ 范围与并发纪律

**(a) P4 自述 17 路径**（worker 报告 §6）全部在 index，且 `git diff --name-only <path>` 为 0（index == 工作区，无末刻改动）：`migrations/0027_…sql`、`design/04-storage/{schema,03-raw-writer}.md`、`design/02-domain/contracts.md`、`design/07-app-plane/{00-web-api,01-mcp}.md`、`crates/domain/src/ports.rs`、`crates/storage/{src/workbench.rs,src/migrate_check.rs,tests/workbench_store.rs}`、`crates/application/{src/workbench.rs,tests/workbench.rs,tests/simlive.rs}`、`crates/web/{src/workbench.rs,src/lib.rs,tests/api_workbench.rs}`、`crates/mcp/src/tools.rs`（`14_scope_git.txt`）。

**(b) 无关文件（非 P4 自述路径）被 staged：40 条，逐条列出**（属其它车道 / 架构师，工作区共享所致；P4 报告未声明、内容与 P4 交付无耦合，但按冻结纪律必须逐条确认）：

```
crates/application/src/{bar_map,simlive,strategy}.rs
crates/application/tests/{adr024_p2b_tryrun,backtest_periods_ssot}.rs
crates/backtest/src/{indicators,lib,types}.rs
crates/mcp/tests/adr024_period_ssot_drift.rs
crates/simlive/src/plugin_orchestrator.rs
crates/simlive/tests/adr024_p2b_orchestrator.rs
crates/storage/src/backtest.rs
crates/strategy-core/src/{engine,lib}.rs
crates/strategy-core/tests/{session,session_alloc}.rs
crates/strategy-runtime/src/{history,lib,quickjs,types}.rs
crates/strategy-runtime/tests/{online_indicators_fixture,shared_history,shared_history_alloc}.rs
crates/web/tests/adr024_workbench_period_ssot.rs
design/16-backtest-scalability/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md,contract-vectors.json}
web/src/api/{mock.test.ts,mock.ts,types.ts}
web/src/features/backtest/{format.test.ts,format.ts,periods.test.ts,periods.ts}
web/src/features/strategies/{TestRunPanel.test.tsx,TestRunPanel.tsx}
web/src/features/workbench/{ConfigPanel.test.tsx,ConfigPanel.tsx}
```
（对照：P4 自述 17 + 非 P4 40 + `coder/` 证据报告 130 = 187 = `git diff --cached` 总数。）

**(c) `design/16-backtest-scalability/**`（架构师所有）**：5 个文件在本批 index 中**均为新增（`A`）**，即架构师的契约文档（ADR/规格/测试计划/实施计划/契约向量），**不在 P4 自述路径内**，P4 报告也未声明修改。mtime：`02-spec.md 09-17 23:58`、`contract-vectors.json 09-17 23:59`、`03-test-plan.md 09-18 00:39`（**早于** P4 车道窗口 14:19–14:35）、`01-adr.md 13:37`、`04-implementation-plan.md 14:32`（**AM**：暂存后又被改）。`git diff -- design/16/...` 显示未暂存内容为**架构师侧增补**（`P2b 已冻结`、新增 `P2c（微批）` 行、新增 `§3.5 派单与并发纪律`——其中规则 1 正是记录「P4 车道并发改 `workbench.rs`」的事故）。⇒ **无 P4 侧改动 design/16 的证据**；反方向的一致性我做了正向核对：`0027` == §2 SQL、`/brief|/bars|/curve` 路由 == §3.2、`ports.rs` 覆盖 §1.2 全部声明项（`ResultKind`/`ResultChunk`/四端口/`RESULT_FORMAT_*`；`ports.rs` 为超集：另加 `StrategyRunResult.result_format` 字段与 `is_chunked()`，与 §1.2 注释口径一致）。

**(d) 并发纪律提示（批次级，非 P4 违约）**：`04-implementation-plan.md §3.5 规则 2` 要求「冻结时核验 index 不含其它车道半成品」⇒ 本批 index 含 40 个非 P4 路径（含 `AM` 状态的 `04-implementation-plan.md`），冻结记录需逐条判定。

---

## 9. 发现清单（无 FAIL；3 RISK（F1/F2/F2b）+ 4 INFO（F3–F6））

| # | 级别 | 发现 | 证据 | 建议处置 |
|---|---|---|---|---|
| F1 | **RISK（低）** | 「非末块恰 5000 根」不变量未进契约：不满足时 `bars_total`/偏移映射错（异构块 `[7000,3000]`：`bars_total=8000`、`offset=6000` 取到 `bars[8000]`） | `08_indep_web_endpoints.txt` probe | 写进 §2/§3.2 或改按 chunk 前缀长度定位（worker §7.6 自陈） |
| F2 | RISK（medium，**上线门槛**） | 前端零消费 P4 新契约（7 个字段关键字 + 3 个端点 URL 命中 0）；chunked run 会让净值/回撤图静默空、逐 bar 表静默截断到 5000 | `13_frontend_gap.txt` | **必须 P6**（spec §3.2/§6 已定归属）；0027 上线不得先于 P6 |
| F2b | RISK（低-中） | chunked 下 `/result` 的 `net_value`/`drawdown` 返回 `[]` 且无 per-series 标记（唯一判别是 `result_format`/`summary`）；对只读数组的旧客户端呈现为静默空。契约（§3.2）已把图表指向 `/curve`，worker 已在 `00-web-api.md` 与用例固定口径 | `08_indep_web_endpoints.txt` probe：`/result(chunked_v1) net_value=[] drawdown=[]` | P6 前端严格 gate `result_format`；或后端加显式 `net_value_omitted: true` / 净值首屏（worker §7.2） |
| F3 | INFO | `strategy_run.period` 列注释未加 `M30`（spec §2 配套第 3 条） | 本报告 §1(d) | 归 P5 迁移（worker §7.7 同建议） |
| F4 | INFO | `/curve` `k=1`（`k=0` 钳到 1）返回 2 点，`k` 与点数不一致 | `08_indep_web_endpoints.txt` probe | 文档写明或钳到 ≥2 |
| F5 | INFO | MCP 仅实现 `limit`（§4 的 `offset/kind/from/to/sample_k`、`bt_list_runs` 摘要字段未做） | `10_indep_mcp.txt` schema 实录 | P5/P6 或 MCP 车道补齐 |
| F6 | INFO | `spec §1.1` 的 `bars_page`/`available_range` 端口在 `domain` 中不存在 | `ports.rs` 实读 | 架构师已裁定延后（`04-plan` P2 范围裁定），非 P4 违约；记录以免误判 |

---

## 10. 未覆盖与局限（诚实声明）

1. `/bars?kind=net_value`（及 `drawdown`）的**分页/区间读**未独立覆盖（仅覆盖 `per_bar` 分页区间 + `net_value/drawdown` 曲线）；两路径共用 kind 泛化实现，风险低但未实测。
2. 未跑 >20 万根超大 run 的真实端到端（暂存/耗时）；分块体量以 11000 根量级实测。
3. 未验多 run 并发争用（同一 `strategy_run_bars` 表并发写/取消竞争）。
4. 未复现 worker 的 4 个定点变异反向证据（R1–R4）——我以**独立用例**覆盖同一行为（区间过滤 / 抽样 / 相交 / 占位硬写）并各自能做红（异构块对照、tangle 篡改探针、内联非空反探针），但未逐条重放其变异脚本。
5. MCP 只回归 `bt_get_run_result`（其余工具面本批未变）。
6. 前端"缺口"以**静态消费点**确认（关键字 + 调用点 + 类型定义），未做真实浏览器渲染验证（P6 由 tester 真渲染验收承担）。

---

## 11. 证据索引（`tester/evidence/251_adr024_p4_verify/`）

| 文件 | 内容 |
|---|---|
| `01_spec_vs_migration_bytes.txt` | ① 三方逐字节 + DDL 元素点名 + 暂存区一致性 + sha256 |
| `02_tangle_check_and_regen.txt` | ② check-tangle 原始输出 + 沙箱复算 + 篡改回写探针 |
| `03_live_db_untouched.txt` | ①-d 活库只读断言（`strategy_run_bars` 不存在 / `result_format` 列不存在 / 现列清单） |
| `04_tempdb_init.txt` | 临时库建立（testdb-init 原始输出，账本 27 条 + 哨兵） |
| `05_tempdb_schema_probe.txt` | ④-b/④-c 落地形态 + 约束负向 + 级联删除探针 |
| `06_regression_4crates.txt` | ⑦ 四 crate 回归终稿（485 passed / 0 failed / 63 suites） |
| `07_indep_storage.txt` | tester 独立：storage 端口 6 例（含后台探针原文） |
| `08_indep_web_endpoints.txt` | tester 独立：端点 3 例（真实 run + 手工 legacy/chunked + 异构块探针） |
| `09_indep_writepath.txt` | tester 独立：写路径 4 例（fail_at / cancel_at / 成功 / 协作式取消） |
| `10_indep_mcp.txt` | tester 独立：MCP 1 例 + 工具 schema 实录 |
| `11_check_all_targets.txt` | `cargo check --all-targets` |
| `12_p4b_instrumentation.txt` | P4b 仪表 grep + 自洽用例捕获 |
| `13_frontend_gap.txt` | 前端缺口确认（关键字命中计数 + 调用点） |
| `14_scope_git.txt` | ⑧ 提交面分类（P4 自述 / 非 P4 逐条 / design/16 状态与 mtime） |
| `15_tempdb_residue.txt` | 临时库残留复核（开发期失败尝试的 12 行溯源） |
| `16_residue_after_rerun.txt` | 全套重跑后残留 0/0/0 |
| `17_teardown.txt` | ⑤ teardown（DROP … WITH (FORCE) + 库清单回读 + 活库终检） |

**新增测试与报告（均未 `git add`）**：`crates/storage/tests/tester_p4_store_indep.rs`、`crates/web/tests/tester_p4_endpoints_indep.rs`、`crates/web/tests/tester_p4_writepath_indep.rs`、`crates/mcp/tests/tester_p4_mcp_indep.rs`、`tester/design/293_adr024_p4_verify_design.md`、`tester/report/adr024_p4_verification.md`（本文件）。
