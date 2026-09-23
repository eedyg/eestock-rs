# 05-status — ADR-027 + ADR-028「结果载荷 v2」批次 · 落地状态与验收结论索引

> **状态：已落地（P0–P6 + 收尾文档回写），2026-09-20。**
> 契约事实源：`02-spec.md`（唯一出口）；判据：`03-test-plan.md`；派工/门禁：`04-implementation-plan.md`。
> 本文件**只作索引与状态台账**，不复制契约口径（口径冲突时以上述三件 + ADR-027/028 为准）。
> 文档回写的逐文档摘要与 `check-tangle` 原始输出见 `coder/evidence/20260920_adr027_p9_docs/report.md`。

---

## 1. 落地清单（逐阶段：内容 → 产物 → 证据）

| 阶段 | 内容（`04-implementation-plan.md` §1） | 落地产物 | 证据目录（原始输出落盘） |
|---|---|---|---|
| **P0** | 历史归档与清空：8 张回测/模拟实况表 `pg_dump` → 隔离库恢复校验（行数+校验和）→ `TRUNCATE`（保结构/迁移链，禁 DROP） | `coder/evidence/20260920_adr027_p0_archive/eestock_adr027_p0_tables_20260919T144156Z.dump`（+`.sha256`）、`manifest.tsv`、`restore_verify.log` | `coder/evidence/20260920_adr027_p0_archive/report.md` |
| **P1a** | 类型与纯聚合：`FillFact`/`RoundTrip` v2/`OrderSide` 迁 `backtest`/`ResultKind::Position` + 唯一聚合 `aggregate_round_trips`/`assign_rt_seq` | `crates/backtest/src/round_trip.rs`（新）、`types.rs`、`metrics.rs`、`crates/domain/src/ports.rs` | `coder/evidence/20260920_adr027_p1a_types_aggregation/report.md`（`10_red_backtest.txt` / `20_green_backtest_workspace.txt`） |
| **P1b** | 引擎：`EngineEvent::Fill` 增事实三件套+`rt_seq`、逐笔账本、在线 `RtSeqAssigner`、期末强平终结回合物化 L1、持仓序列 `PositionPoint` | `crates/strategy-core/src/engine.rs`、`lib.rs`、`crates/strategy-core/tests/{p1b_ledger.rs,adr027_repro.rs}` | `coder/evidence/20260920_adr027_p1b_engine/report.md` |
| **P2** | sim-live：费用拆列（`commission`+`stamp_duty`，`fee` 派生合计）、真实 `bar_index`、复用唯一聚合、**不引入期末强平**、Open 语义、运行中 L1/L2 读 | `crates/simlive/src/{fill,account,session}.rs`、`crates/storage/src/sim.rs`、`crates/application/src/simlive.rs`、`migrations/0028_sim_trades_fee_split.sql`（tangle 生成） | `coder/evidence/20260920_adr027_p2_simlive/report.md`（`03_check_tangle.txt`） |
| **P3** | application/web-api：`/round-trips`、`/round-trips/{rt_seq}/fills`、`/fills` 过滤与字段、`/curve` 窗口 + `kind=position`、`/audit` 逐回合自洽、完整性契约 | `crates/application/src/{workbench,audit}.rs`、`crates/web/src/{workbench,lib}.rs`、`crates/application/tests/workbench.rs`（C 段 C1–C8） | `coder/evidence/20260920_adr027_p3_app_api/report.md` |
| **P4** | MCP 面：新增 `bt_get_run_round_trips` / `bt_get_run_round_trip_fills` / `sim_get_round_trips` / `sim_get_round_trip_fills` + 4 处增量 | `crates/mcp/src/tools.rs`（tangle 回写）、`design/07-app-plane/01-mcp.md` | `coder/evidence/20260920_adr027_p4_mcp/report.md` |
| **P4b** | （闸门 E 段阻塞修复）`strategy_run_bars.kind` CHECK 扩 `position`：迁移 0029 + 真库应用 + 2 处「未挣得/假覆盖」整改 | `migrations/0029_strategy_run_bars_kind_position.sql`、`design/04-storage/schema.md` §4.3.20、`crates/web/tests/adr026_run_audit.rs`、`crates/strategy-core/tests/adr027_repro.rs` | `coder/evidence/20260920_adr027_p4b_kind_migration/report.md`（`30_migrate_apply_real_db.txt`、`70_end_to_end_position_chunk.txt`） |
| **P4c** | （闸门 2 低危修复）L-1 `/fills` 元素补 `code`、L-3 未知 `round_trip` ⇒ 404、L-2 参数形态错误 ⇒ 结构化 400 信封 | `crates/application/src/workbench.rs`、`crates/web/src/workbench.rs`、`crates/web/tests/adr027_fills_param_shape.rs` | `coder/evidence/20260920_adr027_p4c_consistency/report.md` |
| **P5a** | 前端：类型 v2、L1 一层 + 四枚按钮、L2 懒加载、双口径/累计列、对账告警、取数完整性 | `web/src/api/{types,mock,client}.ts`、`web/src/features/workbench/{RoundTripsTable,useRunSeries,roundTripAccum}.*` | `coder/evidence/20260920_adr027_p5a_frontend/report.md` |
| **P5b** | 前端：窗口状态机（节流/rev/回声抑制）、`mapLineByTs`、`KlineChart` 可选回调与程序化写窗、跳转断言、持仓比率视图 | `web/src/features/workbench/{resultWindow,useResultWindow,PositionRatioChart}.*`、`web/src/features/dashboard/{klineWindowOps,KlineChart}.*` | `coder/evidence/20260920_adr027_p5b_frontend_window/report.md` |
| **P5c** | 前端真渲染 E2E（闸门 2 中危 M1）：`adr028-window-sync.e2e.ts`（E1/E2/E4 + 变异反证），并修真渲染下两类跳转失真 | `web/e2e/adr028-window-sync.e2e.ts`、`web/vite.config.ts`（`preview.proxy`） | `coder/evidence/20260920_adr027_p5c_e2e/report.md`（`10_playwright_adr028.txt`：4 passed） |
| **P6** | 验收与文档回写（本批）：tester 独立验收 R/U/C/S/F/E；四份 design 文档口径注 + 本状态文件 | 本文 + `design/08-backtest/01-engine-adr.md` §10、`design/11-sim-live/01-adr.md` §12、`design/12-strategy-system/01-adr.md` §13.4/§13.5.2、`02-spec.md` 顶部状态注 | `coder/evidence/20260920_adr027_p9_docs/report.md` |

---

## 2. 关键交付物索引

### 2.1 迁移（entangled tangle 生成，禁手改产物）

| 迁移 | 内容 | 真库应用证据 |
|---|---|---|
| `migrations/0028_sim_trades_fee_split.sql` | `sim_trades` 增 `commission` / `stamp_duty`（保留 `fee` = 两者之和） | `coder/evidence/20260920_adr027_p4b_kind_migration/30_migrate_apply_real_db.txt` |
| `migrations/0029_strategy_run_bars_kind_position.sql` | `strategy_run_bars.kind` CHECK 扩为五值（含 `position`） | 同上（+ 约束接受性冒烟 `31_constraint_acceptance_probe.txt`、空库路径 `41_testdb_fresh_path.txt`） |

### 2.2 HTTP 端点（`design/07-app-plane/00-web-api.md`）

- `GET /api/workbench/runs/{id}/round-trips?offset=&limit=`（L1 列表，§5.2）
- `GET /api/workbench/runs/{id}/round-trips/{rt_seq}/fills?offset=&limit=`（L2 切片，§5.3；未知 `rt_seq` ⇒ 404）
- `GET /api/workbench/runs/{id}/fills?offset=&limit=&round_trip=`（v2 元素 + `code`；未知 `round_trip` ⇒ 404；参数形态错误 ⇒ 结构化 400）
- `GET /api/workbench/runs/{id}/curve?kind=<per_bar|net_value|drawdown|position>&k=&from_ts=&to_ts=`（窗口 + `kind=position`）
- `GET /api/workbench/runs/{id}/audit`（`+ round_trips_closed/open`、`rt_reconcile`）

### 2.3 MCP 工具（`design/07-app-plane/01-mcp.md`）

- 回测：`bt_get_run_round_trips` / `bt_get_run_round_trip_fills`（新增）；`bt_get_run_result` / `bt_get_run_curve` / `bt_get_run_fills` / `bt_get_run_audit`（增量）。
- sim-live（运行中 L1/L2 读，键为 `session_id` + `code`）：`sim_get_round_trips` / `sim_get_round_trip_fills`（新增）。

### 2.4 前端（`web/src/`）

- 类型契约：`web/src/api/types.ts`（`RoundTrip` / `RoundTripFill` / `WorkbenchPositionPoint` / 窗口回显 / `rt_reconcile`，含口径注）。
- 结果页：`RoundTripsTable.tsx`（L1/L2 + 四枚按钮）、`useRunSeries.ts`（唯一取数入口，含 L2 懒加载与 K 线标记分页拉全）。
- 窗口联动：`resultWindow.ts` / `useResultWindow.ts` / `klineWindowOps.ts` / `PositionRatioChart.tsx`。

### 2.5 S 段跨侧共享向量

- `design/17-trade-detail-layering/contract-vectors.json`（7 组向量：单笔开平 / 多批加仓 / 部分卖出 / DCA 多批 / 零长回合 / Open 未平仓 / 清仓后再开）。
  设计说明见 `tester/design/296_adr027_s_contract_vectors_design.md`；独立 oracle 生成器见 `tester/evidence/20260920_adr027_accept/gen_contract_vectors.py`。

---

## 3. 验收结论索引（tester 闸门 3 / 闸门 2）

> 独立验收（非 coder 自证）：`tester/evidence/20260920_adr027_accept/report.md`（R/U/C/S/F/E 全段）、
> `tester/evidence/20260920_adr027_accept_e/report.md`（E 段复跑 + 闸门 2 反例挖掘）；
> 先红证据：`tester/evidence/20260920_adr027_repro/`（`00_SUMMARY.md` + `R1..R6*.md` + `raw/`）。

| 段 | 判据（`03-test-plan.md`） | 结论 | 证据 |
|---|---|---|---|
| **R**（复现，先红后绿） | R1 部分卖出 pnl / R2 L1 非全回合 / R3 sim `stamp_duty` 恒 0 / R4 `bar_index` 反算 / R5 零长回合归属 / R6 两源字段 | **通过**（6/6 红→绿；判据未削弱） | `tester/evidence/20260920_adr027_accept/report.md` §1；`.../adr027_repro/raw/` |
| **U**（引擎/聚合单测） | U1–U8 + I1/I3/I4 + 持仓序列 | **通过** | `.../adr027_accept/report.md` §2；`crates/strategy-core/tests/p1b_ledger.rs`（9 用例） |
| **C**（HTTP/MCP/TS 形状） | C1–C8 + C9（MCP） | **通过**（限服务层载体；HTTP 级端到端由 E 段补足） | `.../adr027_accept/report.md` §4；`crates/application/tests/workbench.rs` |
| **S**（跨侧共享向量） | 回测聚合 vs sim-live 聚合逐字段/逐字节一致 | **通过**（含突变验证） | `.../adr027_accept/report.md` §6；`crates/application/tests/adr027_contract_vectors_parity.rs` |
| **F**（前端单测） | F1–F12 | **通过**（`tsc -b` 退出码 0；`vitest` 99 文件 / 961 用例全绿） | `.../adr027_accept/report.md` §5；`.../adr027_accept_e/report.md` §3 |
| **E**（端到端） | 后端契约（活库真 run）+ I1/I3/I4 + 持仓序列 + 前端 tsc/vitest | **通过**（活库首次端到端成功取证，run 1/5/48 回合，恒等式 0 处不符） | `.../adr027_accept_e/report.md` §1–§2 |
| **E1–E4 真渲染** | L1/L2 跳转、窗口联动、全览/回退 | **通过（P5c 补齐）**（Playwright 4 passed；变异反证 M1） | `coder/evidence/20260920_adr027_p5c_e2e/report.md` + `10_playwright_adr028.txt` |

**闸门 2（反例挖掘）发现与处置**（`.../adr027_accept_e/report.md` §4.7）：

| ID | 严重度 | 内容 | 处置 |
|---|---|---|---|
| M1 | 中 | `setBarSpace` 越界静默 return 仅桩层断言，真渲染无证据 | **已修**：P5c 真身 E2E + `applyWindowOps` 每次 `setBarSpace` 读回校验（`coder/evidence/20260920_adr027_p5c_e2e/`） |
| L-1 | 低 | `/fills` 元素缺 `code`（L2 切片有） | **已修**：P4c L-1（`/fills` 元素键集 == L2 切片键集） |
| L-2 | 低 | 路径参数解析错误为纯文本 400 | **已修**：P4c L-2（结构化 `request_invalid` 信封） |
| L-3 | 低 | `/fills?round_trip=<未知>` 200 空页 vs L2 404 | **已修**：P4c L-3（未知 `round_trip` ⇒ 404，与 L2 对称） |

---

## 4. 残差与未决项（诚实留白，不阻断）

1. **两处契约偏差待闸门 1 裁决/追认**（见 `02-spec.md` 顶部状态注）：
   ① `/curve` 响应多 `recorded: bool`；② `KlineChartProps` 多两个可选 prop（`windowCommand`/`onWindowApplied`）。
2. **`aggregate_round_trips` 退化分组 `open_price = 0.0`**（仅孤儿卖出分组、正常路径不可达）：改 `Option<f64>` 属 ABI 二次变更，未获授权（`coder/evidence/20260920_adr027_p1a_types_aggregation/report.md` §4-迁移点 4）。
3. **前端 `WorkbenchRunFill` 未含 `code`**（后端 `/fills` 元素已含）：前端类型保持 `02-spec` §7 最小增量集（多余键被忽略），P4c §7.3 已登记。
4. **无正样本分支**（`Open` 回合 `pnl=null`、`nav ≤ 0 ⇒ position_ratio=0`、同 bar 反手）：仅由 U/S 段单测与向量锁定；活库真 run 未取到正样本（`.../adr027_accept_e/report.md` §2.1/§2.4/§4.1）。
5. **跨标 / 目标 bar 在已加载 K 线区间外的 L1 跳转取数**（ADR-028 D4「超出则先按区间取数再定位」）与初次装载时序竞态：未实现（属独立增量，`coder/evidence/20260920_adr027_p5c_e2e/report.md` §7）。
6. **真库门禁测试覆盖**：`crates/storage/tests/*`、`crates/mcp` 真库用例、`scripts/testdb-init.sh` 供应的 `EESTOCK_TEST_DATABASE_URL` 路径——本轮已跑通 `web --test adr026_run_audit`（P4b，4 passed），其余仍受环境门禁（缺失即响亮失败，非静默跳过）。

---

## 5. 证据目录索引（相对仓库根）

**coder（实现侧）**
```
coder/evidence/20260920_adr027_p0_archive/             # 归档 + 恢复校验
coder/evidence/20260920_adr027_p1a_types_aggregation/  # 类型 + 纯聚合
coder/evidence/20260920_adr027_p1b_engine/             # 引擎接线
coder/evidence/20260920_adr027_p2_simlive/             # sim-live 费用拆列/真实 bar/Open
coder/evidence/20260920_adr027_p3_app_api/             # HTTP/application 读模型
coder/evidence/20260920_adr027_p4_mcp/                 # MCP 工具族
coder/evidence/20260920_adr027_p4b_kind_migration/     # kind=position 迁移 + 真库应用
coder/evidence/20260920_adr027_p4c_consistency/        # L-1/L-2/L-3 修复
coder/evidence/20260920_adr027_p5a_frontend/           # 前端类型/L1-L2/懒加载/对账
coder/evidence/20260920_adr027_p5b_frontend_window/    # 窗口状态机/跳转/持仓比率
coder/evidence/20260920_adr027_p5c_e2e/                # 真渲染 E2E（M1）
coder/evidence/20260920_adr027_p9_docs/                # 文档回写（本文件所引报告 + check-tangle 输出）
```

**tester（验收侧）**
```
tester/evidence/20260920_adr027_repro/                 # R1–R6 先红证据
tester/evidence/20260920_adr027_accept/                # 闸门 3 验收（R/U/C/S/F/E + 反假绿）
tester/evidence/20260920_adr027_accept_e/              # E 段复跑 + 闸门 2 反例挖掘
tester/design/296_adr027_s_contract_vectors_design.md  # S 段向量设计
```

---

## 6. 批次后修订（非本批次范围，索引用）

| 日期 | 修订 | 裁决 | 方案/证据 |
|---|---|---|---|
| 2026-09-22 | **ADR-028 D2.4「评估段裁剪」**：分数曲线（聚合总分/各策略评分）不再画 warmup 预热段 ⇒ 与净值/持仓、K 线同段对齐 | `design/01-architecture/adr/ADR-028-*.md` §2.2e + `design/99-decisions-log.md` 条目 | `06-plan-d2.4-warmup-clip.md`（方案正文） + `coder/report/adr028_curve_y_scaling_mismatch_analysis.md`（取证/实施） |
