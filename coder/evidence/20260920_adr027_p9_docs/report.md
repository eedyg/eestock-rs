# ADR-027 批次 P9 —— 文档回写报告

**判词（前置）**：`design/08-backtest/01-engine-adr.md` §10 完成 ｜ `design/11-sim-live/01-adr.md` §12 完成 ｜ `design/12-strategy-system/01-adr.md` §13.4/§13.5.2 完成 ｜ `design/17-trade-detail-layering/05-status.md` 完成（+ `02-spec.md` 顶部状态注） ｜ **check-tangle 绿** ｜ **spec 偏差项 2（另 2 项非违约登记）**。

- 本报告文件位置：`coder/evidence/20260920_adr027_p9_docs/report.md`
- 同目录原始输出：`00_check_tangle_baseline.txt`、`10_check_tangle_final.txt`、`20_tsc.txt`、`21_vitest.txt`、`30_diffstat.txt`
- 角色/边界：**worker（文档车道）**。只动 `design/` 文档 + `web/src/api/types.ts` 的**注释**；**未改任何 Rust 逻辑**、未改接口/迁移/依赖、未 commit、未 `git add`。
- 目的：ADR-027 D3 清空历史后，**文档是唯一口径载体**——把本批（TradeDetail v2 全回合口径、L1/L2 端与曲线 kind=position 与时间窗、sim-live 费用拆列/Open 语义/不强平）落成的口径回写进既有设计文档，防止下一轮踩口径坑。

---

## 1. 逐文档改动摘要

| # | 文件 | 改动 | 行数 |
|---|---|---|---|
| 1 | `design/08-backtest/01-engine-adr.md` | 追加 **§10 结果载荷 v2 引擎口径注（ADR-027）**：§10.1 `TradeDetail` v2 字段表 + 全回合现金流口径（`pnl = proceeds − invested`，Open 禁造数，费用三件套禁复算，绩效只吃 Closed）；§10.2 `rt_seq` 归属键 = `assign_rt_seq` 唯一实现 + `aggregate_round_trips` 唯一聚合 + `OrderSide/FillReason` 类型归属；§10.3 持仓序列 `PositionPoint` + `ResultKind::Position` + 迁移 0029 + **期末强平仍保留** + 三比率消歧 | +80 |
| 2 | `design/11-sim-live/01-adr.md` | 追加 **§12 结果载荷 v2 口径注（ADR-027）**：§12.1 费用拆列（`commission`+`stamp_duty`，`fee` 派生合计，迁移 0028，禁下游复算）；§12.2 真实 bar 序号（禁 `ts/bar_sec`）；§12.3 Open 回合语义 + **不引入期末强平** + `source→FillReason` 映射；§12.4 结算与运行中读共用唯一聚合实现；§12.5 运行中 L1/L2 读能力（`SimLiveService::round_trips`/`round_trip_fills` + MCP `sim_get_round_trips`/`sim_get_round_trip_fills`） | +50 |
| 3 | `design/12-strategy-system/01-adr.md` | §13.4 增**三比率分别命名 + 各自分母**消歧表（`position_ratio`/`cash_ratio` 时点净值 vs `deployed_pct`/`cash_consumed_pct` 初始资金）；新增 **§13.5.2 交易明细 L1/L2 分层与懒加载**（L1 回合/L2 逐笔懒加载、`rt_seq` 唯一归属、双口径均价+累计列、对账不一致强制告警、取数完整性、结果页时间窗），置于 §13.5.1 之后、§13.6 之前 | +28 |
| 4 | `design/17-trade-detail-layering/05-status.md` | **新建**：落地清单（P0–P6 逐阶段：内容→产物→证据目录）、关键交付物索引（迁移 0028/0029、HTTP 端点、MCP 工具、前端、S 段向量）、验收结论索引（tester R/U/C/S/F/E 逐段 + 闸门 2 findings 处置）、残差/未决项、证据目录索引（coder + tester） | 新增 13.5 KB |
| 5 | `design/17-trade-detail-layering/02-spec.md` | **顶部**加「实施状态：已落地（P0–P6）」块：验收结论摘要 + **2 项 spec 偏差（待裁决/追认）** + **2 项非违约登记**，并指向 `05-status.md` | +15（相对既有工作区） |
| 6 | `web/src/api/types.ts`（**仅注释**） | `WorkbenchRunFill` 增口径注：三件套为引擎事实禁复算；登记「后端 `/fills` 元素实际还含 `code`（读径注入），本类型保持 `02-spec §7` 最小增量集」 | +7/−1 |

> **未触碰**：任何 `crates/*/src/**.rs` 生产逻辑、迁移产物、`migrations/**`、Cargo 依赖、其它 design 文档。
> `02-spec.md` / `ADR-023-*.md` 工作区中原有的**未暂存改动为其它车道（spec 车道）所留**，本波未回退、未覆盖。

### 1.1 O1 纪律（entangled tangle）

**本波四份目标文档均不含 entangled 托管代码块**（`grep -E 'file=[^ }"]+'` 仅命中 `02-spec.md:253` 的**行内散文**示例 `{.sql file=migrations/00XX_*.sql}`，非代码块头）⇒ 本次回写**不触发** `entangled tangle` 生成物，不存在「文档→生成物」漂移。为满足判据，仍在改动前后各跑一次 `./scripts/check-tangle.sh`（见 §2），**未使用** `entangled tangle --force`（仓库内禁用），**未使用** `entangled reset`。

---

## 2. check-tangle 原始输出（判据：绿）

**改动前基线**（`00_check_tangle_baseline.txt`）：
```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

**改动后最终态**（`10_check_tangle_final.txt`）：
```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

**前端回归**（注释级改动，验证零破坏；`20_tsc.txt` / `21_vitest.txt`）：
```
$ cd web && npx tsc -b
（无输出）TSC_EXIT=0

$ cd web && npx vitest run
Test Files  100 passed (100)
     Tests  963 passed (963)
  Duration  7.64s
EXIT=0
```

---

## 3. `02-spec.md` 逐条对照表（文档内容 ↔ 实现，判据：一致）

> 口径：本表以 `02-spec.md` 章节为行，列出**实现落点**与**结论**（"一致" = 遵循已申报偏差，见 §4）。

| spec 节 | 契约要点 | 实现落点（代码） | 回写文档 | 结论 |
|---|---|---|---|---|
| §1.1 `FillFact`（L2 唯一事实源） | `code/rt_seq/bar_index/side/qty/price/trade_value/commission/stamp_duty/reason`；费用三件套撮合点写入、禁复算 | `crates/backtest/src/round_trip.rs`；引擎 `EngineEvent::Fill`；sim `SimTrade→FillFact` | 08-backtest §10.1；11-sim-live §12.1 | 一致 |
| §1.2 `RoundTrip`（= `TradeDetail` v2） | 全字段 + `Option` 语义 + `l2_count`/买卖笔数 | `crates/backtest/src/types.rs` | 08-backtest §10.1 | 一致 |
| §1.3 唯一聚合实现 | `assign_rt_seq` / `aggregate_round_trips` **唯一** | `crates/backtest/src/round_trip.rs`（`RtSeqAssigner` 单一体） | 08-backtest §10.2 | 一致 |
| §2 聚合口径 + I1/I2/I3/I4 | `invested`/`proceeds`/`pnl` 全回合现金流；字段级加总 | `round_trip.rs`；`p1b_ledger.rs`（U 段 9 用例） | 08-backtest §10.1 | 一致 |
| §3 `rt_seq` 契约 | 整数序号 per `(run\|session, code)`；禁窗口推断 | `assign_rt_seq`；引擎在线 `RtSeqAssigner` | 08-backtest §10.2 | 一致 |
| §4.1 `ResultKind::Position` 点形状 | `ts/qty/position_value/cash/nav/position_ratio`；可抽样 | `crates/strategy-core/src/engine.rs`；`crates/domain/src/ports.rs` | 08-backtest §10.3 | 一致 |
| §4.2 `/curve` 时间窗 + 持仓比率口径 | 窗口重采样 + `window_*` 回显；`position_ratio = position_value/nav` | `crates/application/src/workbench.rs`；`crates/web/src/workbench.rs` | 08-backtest §10.3；12-strategy §13.4 | 一致（+偏差 D1） |
| §5.1 `/result` trades v2 | 全回合口径（非端点口径），无旧兼容 | `workbench.rs::result_*` | 05-status §2.2 | 一致 |
| §5.2 `/round-trips`（L1 列表） | `total/recorded/has_more/next_offset` + 摘要 | `web/src/lib.rs` 路由 + `workbench.rs` | 05-status §2.2 | 一致 |
| §5.3 `/round-trips/{rt_seq}/fills`（L2 切片） | 归属只由 `rt_seq`；未知 ⇒ 404 | 同上 | 05-status §2.2 | 一致 |
| §5.4 `/fills` 增量 | 元素增 `code`/`rt_seq`/三件套 + `round_trip` 过滤；未知 ⇒ 404；形态错误 ⇒ 结构化 400 | `workbench.rs`（P3 + P4c L-1/L-2/L-3） | 11-sim-live §12.5；05-status §2.2 | 一致 |
| §5.5 `/audit` 增量 | `round_trips_closed/open` + `rt_reconcile{checked,mismatched,tolerance}` | `crates/application/src/audit.rs` | 05-status §2.2 | 一致 |
| §5.6 完整性契约 | 全列表自述完整性 | `workbench.rs`（C8）；前端 `useRunSeries.ts` 分页拉全 | 12-strategy §13.5.2 | 一致 |
| §6 MCP 契约 | `bt_get_run_round_trips`/`bt_get_run_round_trip_fills` 新增 + 4 增量；sim 运行中 L1/L2 | `crates/mcp/src/tools.rs`（tangle 回写） | 11-sim-live §12.5 | 一致 |
| §7 前端类型契约 | `RoundTrip`/`RoundTripFill`/窗口字段/`kind=position`/`onVisibleRangeChange` | `web/src/api/types.ts`、`KlineChart.tsx` | 12-strategy §13.5.2 | 一致（+偏差 D2；登记 D3） |
| §8 DB 契约 | `sim_trades` 拆列（0028）+ `strategy_run_bars.kind` 含 `position`（0029）；禁手改产物 | `migrations/0028,0029`（tangle 生成） | 11-sim-live §12.1；08-backtest §10.3 | 一致 |
| §9 前端交互契约 | 窗口状态机 / 回声抑制 / 跳转断言 / 懒加载 | `resultWindow.ts`/`useResultWindow.ts`/`klineWindowOps.ts` | 12-strategy §13.5.2 | 一致 |

**S 段跨侧向量**：`design/17-trade-detail-layering/contract-vectors.json`（7 组）与 `tester/design/296_adr027_s_contract_vectors_design.md` 在位；跨侧逐字段一致由 `crates/application/tests/adr027_contract_vectors_parity.rs` 锁定（tester 验收 §6 通过）。

---

## 4. spec 偏差项（数量：**2**）与非违约登记项（**2**）

### 4.1 偏差项（已实现，**待闸门 1 裁决/追认**；已写入 `02-spec.md` 顶部状态注）

| ID | 偏差 | 影响面 | 申报出处 |
|---|---|---|---|
| **D1** | `§4.2 /curve` 响应多一个 `recorded: bool`（spec §4.2 信封未列） | **纯加法**（既有键名/语义/顺序均未变） | `coder/evidence/20260920_adr027_p3_app_api/report.md` §5 |
| **D2** | `§7 KlineChartProps` 除 `onVisibleRangeChange` 外多两个**可选** prop（`windowCommand`/`onWindowApplied`） | 两者皆可选，不传时零行为（有回归用例） | `coder/evidence/20260920_adr027_p5b_frontend_window/report.md` §4.2 |

### 4.2 非违约登记项（形状不对称 / 退化边界，不影响验收）

| ID | 登记 | 说明 | 出处 |
|---|---|---|---|
| **D3** | 前端 `WorkbenchRunFill` 未含 `code` | 后端 `/fills` 元素已含 `code`（§5.4，读径注入）；前端类型保持 §7 最小增量集（多余键忽略）。本波以**注释**登记（未改类型形状）。 | `coder/evidence/20260920_adr027_p4c_consistency/report.md` §7.3 |
| **D4** | `aggregate_round_trips` 退化分组 `open_price = 0.0` | 仅 `rt_seq = 0` 孤儿卖出分组（无买入），**正常路径不可达**；改 `Option<f64>` 属 ABI 二次变更，未获授权。 | `coder/evidence/20260920_adr027_p1a_types_aggregation/report.md` §4-迁移点 4 |

> **闸门 2 的四项 findings 已闭环，不计入偏差**：M1（真渲染越界静默）由 P5c 真身 E2E + 读回校验修复；L-1/L-2/L-3（`/fills` 缺 `code` / 纯文本 400 / 未知回合 200 空页）由 P4c 修复（见 `05-status.md` §3）。证据：`coder/evidence/20260920_adr027_p4c_consistency/`、`.../p5c_e2e/`。

---

## 5. 证据与验证

| 命令 | 结果 | 原始输出 |
|---|---|---|
| `./scripts/check-tangle.sh`（改动前基线） | **绿** EXIT=0 | `coder/evidence/20260920_adr027_p9_docs/00_check_tangle_baseline.txt` |
| `./scripts/check-tangle.sh`（改动后最终态） | **绿** EXIT=0 | `coder/evidence/20260920_adr027_p9_docs/10_check_tangle_final.txt` |
| `cd web && npx tsc -b` | **绿** EXIT=0 | `coder/evidence/20260920_adr027_p9_docs/20_tsc.txt` |
| `cd web && npx vitest run` | **绿** 100 文件 / 963 用例 | `coder/evidence/20260920_adr027_p9_docs/21_vitest.txt` |
| `git diff --stat`（本波文档/类型） | +212 / −9（含 `02-spec` 车道既有未暂存改动） | `coder/evidence/20260920_adr027_p9_docs/30_diffstat.txt` |

**反向守卫**：`grep -rn "file=" design/08-backtest/01-engine-adr.md design/11-sim-live/01-adr.md design/12-strategy-system/01-adr.md design/17-trade-detail-layering/*.md` ⇒ 仅 `02-spec.md:253` 行内散文，无新增托管块头 ⇒ check-tangle 绿非假绿（无生成物被本次回写隐式改写）。

---

## 6. 残余风险 / 未做项（诚实留白）

1. **D1/D2 两项偏差仍待闸门 1 裁决/追认**（不阻断：均纯加法/可选，且已申报）。
2. **规范文档（07-app-plane/00-web-api.md、01-mcp.md）与 schema（04-storage/schema.md）**：属本批**其它车道**已交付/暂存，本波未触碰（避免跨车道写冲突）；其内容已在 `05-status.md` §2 索引指向。
3. **真库门禁测试覆盖**（storage/mcp 真库用例、`EESTOCK_TEST_DATABASE_URL`）仍受环境门禁；`web --test adr026_run_audit` 已由 P4b 跑通（4 passed）。
4. **`02-spec.md` 工作区含 spec 车道未暂存改动**：本波在其之上追加顶部状态注，未回退既有内容；如需以 HEAD 为基准评审，请先确认 spec 车道改动已归位。
5. 本波**未** `git add` / `commit`（改动留在工作区供父级评审；与本仓历波 coder 车道「noStagedFiles」惯例一致）。
