**判词**：R1 转绿 ｜ R2 转绿 ｜ R5 转绿 ｜ R6 转绿 ｜ strategy-core 测试 绿（36 lib + 4 repro + 26 engine(1 ignored 性能冒烟) + 9 p1b + 7 session + 6 observer + 1 alloc + 3 templates）｜ workspace 测试目标 全部编译通过；除 tester 的 P2 车道复现文件 `adr027_repro_simlive.rs`（R3/R4）与需真库的 `mcp::real_db_*`（环境门禁）外全部通过 ｜ 测试适配处数 34 处（机械适配 31：strategy-core 25 + application 6；废弃 v1 兼容用例改写 1；新测试自纠 2）｜ 剩余待迁移点 4 项（P2×1 / P3×2 / 裁决×1）

**判词（阶段性）**：R1 转绿 ｜ R2 转绿 ｜ R5 转绿 ｜ R6 转绿 ｜ strategy-core 测试 绿（36 lib + 26 engine + 4 repro + 9 p1b + 7 session + 6 observer + 1 alloc + templates）｜ workspace 测试目标 进行中 ｜ 测试适配处数 见 §3（累计 20 处）｜ 剩余待迁移点 见 §4

> 本文件位置：`coder/evidence/20260920_adr027_p1b_engine/report.md`（同目录另有 `10_red_repro.txt`/`11_red_p1b_ledger.txt`/`20_green_repro.txt`/`21_green_p1b_ledger.txt`/`30_green_strategy_core.txt`）
> 契约事实源：`design/17-trade-detail-layering/02-spec.md` §1–§4、`ADR-027`；测试规格 `03-test-plan.md` R/U 段。
> 本轮架构裁决（supervisor 直接回复，逐条执行）：①废弃 v1 兼容测试删除/改写为 v2；②`rt_seq` 唯一实现 = `backtest::assign_rt_seq`；③`EngineEvent::Fill` 增四字段且取实算值；④逐笔账本 + 唯一聚合；⑤持仓序列；⑥期末强平终结回合；⑦Open 回合禁造数；**追加裁决 = 方案 (A)：`EnsembleConfig` 增 `pub symbol: String`**（`code` 唯一取值来源）。

---

## 1. 逐条红转绿证据（原始输出）

### R1（`adr027_repro::r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl`）

RED（改前，原始输出见 `10_red_repro.txt`）：

```
R1：TradeDetail.pnl 必须 == 该回合真实已实现盈亏（= nav[-1] − initial_capital；02-spec §2 全回合口径
Σ sell proceeds − Σ buy total_cost）: 期望 5338.715921666619，实际 4513.894182770709（Δ = -824.8217388959092，容差 0.000000001）
```

根因：旧引擎在**清仓那一笔**合成 `TradeDetail`，`pnl = exec.proceeds − h.cost_basis`（末笔现金流 − 摊薄后成本），
bar5 部分卖出的已实现部分既未计入也未留在成本里（`apply_sell` 部分卖出分支只做摊薄、丢弃记录）。

GREEN（改后，`20_green_repro.txt`）：`test result: ok. 4 passed; 0 failed`。

### R2（`adr027_repro::r2_l1_amount_fields_are_not_whole_round_trip_sums`）

RED：

```
R2：L1 金额字段必须 == 全回合加总（02-spec §2），实得 3 项不符:
  L1.gross_value: 全回合期望 55406.520749979165，实际 50396.27175022916（Δ = -5010.2489997500015）
  L1.commission: 全回合期望 30.101567937557288，实际 24.057348458338538（Δ = -6.04421947921875）
  L1.stamp_duty: 全回合期望 27.703260374989583，实际 25.19813587511458（Δ = -2.505124499875002）
```

GREEN：同 R1 输出（4 passed）。

### R5（`adr027_repro::r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq`）

RED：

```
R5：零长回合必须可归属（l2_count == 2 且两笔同 rt_seq），实得 3 项缺口:
  L1.l2_count != 2（该零长回合有 2 笔成交）；Debug: TradeDetail { rt_seq: 0, code: "", status: Closed, ..., l2_count: 1, ... }
  同 bar 第 0 笔成交事实缺 `rt_seq`；Debug: Fill { bar_index: 1, side: Buy, qty: 9995.501524538882, ... }
  同 bar 第 1 笔成交事实缺 `rt_seq`；Debug: Fill { bar_index: 1, side: Sell, ... }
```

GREEN：同 R1 输出。改后该回合 `rt_seq: 1`、`l2_count: 2`、`buy_count: 1`、`sell_count: 1`（`aggregate_round_trips` 分组物化）。

### R6（`adr027_repro::r6_fill_fact_source_lacks_rt_seq_and_fee_triple`）

RED：12 项缺口（3 笔 × 4 字段），逐笔 Debug 均只有 5 字段：

```
第 0 笔（bar1 Buy）缺 `rt_seq`；Debug: Fill { bar_index: 1, side: Buy, qty: 5000.0, price: 10.001999999999999, reason: Policy }
... （trade_value / commission / stamp_duty 同）
```

GREEN：同 R1 输出。改后逐笔形如
`Fill { bar_index: 5, side: Sell, qty: 417.60427083333343, price: 11.9976, trade_value: 5010.2489997500015, commission: 5.0, stamp_duty: 2.505124499875001, rt_seq: 1, reason: Policy }`
（bar5 部分卖出笔 `trade_value ≈ 5010.25` 走**最低佣金**分支 ⇒ `commission = 5.0` 为实算事实值）。

### 新增 P1b 判据（U5/U6/U7/I1/I3/I4，`crates/strategy-core/tests/p1b_ledger.rs`）

RED（`11_red_p1b_ledger.txt`）：`error[E0026] variant Fill does not have fields named trade_value, commission, stamp_duty, rt_seq`、`E0560 struct EnsembleConfig has no field named symbol`、`6 × E0609 no field positions on type EnsembleResult`（6 处）+ 2 × `no field symbol`。
GREEN（`21_green_p1b_ledger.txt`）：`test result: ok. 9 passed; 0 failed`。

---

## 2. 实现改动（引擎侧）

| 文件 | 改动 |
|---|---|
| `crates/backtest/src/round_trip.rs` | 新增 `pub struct RtSeqAssigner`（D6 规则的**单一体**：per code 持仓量 + 序号状态 + `assign(&mut FillFact)`）；`assign_rt_seq` 改为「遍历 + 委托同一 `RtSeqAssigner`」⇒ 在线分配与批式分配**同一份规则代码**（DRY）。新增单测 `u2_incremental_assign_matches_batch_assign`（逐笔 vs 批式逐笔同值） |
| `crates/backtest/src/lib.rs` | 导出 `RtSeqAssigner` |
| `crates/strategy-core/src/engine.rs` | ① `EnsembleConfig` 增 `pub symbol: String`（+ `validate()` 空串 fail loud）；② `EngineEvent::Fill` 增 `trade_value/commission/stamp_duty/rt_seq`（**全部取自 `BuyExecution`/`SellExecution` 实算字段**，买入 `stamp_duty = 0.0`）；③ `EnsembleResult` 增 `pub positions: Vec<PositionPoint>`；④ 新 `pub struct PositionPoint`；⑤ 会话内新增 L2 账本 `ledger: Vec<FillFact>` + 在线 `rt_assigner` + `positions`，新 `record_fill()`（**事实与事件同点产成**：入账本 → 分配 `rt_seq` → 返回事件）；⑥ `finish()` 强平后 `assign_rt_seq(&mut ledger)` + `aggregate_round_trips(&ledger)` 物化 L1（**删除 `apply_sell` 内的 `TradeDetail` 字面量与全部占位值**）；⑦ `apply_sell` 退化为纯持仓簿记（部分卖出摊薄 / 清仓重置 Trailing），`Holding` 删去因此变为死状态的 `value_basis`/`buy_commission`；⑧ 净值压入点同步压入 `PositionPoint`（含 `position_ratio` 口径与 nav≤0 ⇒ 0）；强平后同点修正为空仓 |
| `crates/strategy-core/src/lib.rs` | 导出 `PositionPoint` |

**硬约束遵守**：
- 引擎内**零**第二处分组/聚合/序号规则：`rt_seq` 来自 `RtSeqAssigner`（= `assign_rt_seq` 的规则体），L1 来自 `aggregate_round_trips`；引擎仅传入逐笔事实。
- 费用三件套**不复算**：全部直接取 `exec.trade_value/commission/stamp_duty`（R2 的最低佣金笔 `commission = 5.0` 可反证）。
- 部分卖出进账本：`Pending::SellQty` 分支对每笔卖出（含部分卖出）调用 `record_fill`，`apply_sell` 只做摊薄。
- Open 回合禁造数：回测侧期末强平 ⇒ 全部 `Closed`（`p1b_i3_*` 断言 `status == Closed`）；`pnl = None` 语义由 `aggregate_round_trips` 承担（P1a 已有 U3 单测）。

---

## 3. 测试适配清单（逐条：文件 + 行 + 原因；**未放宽/删除任何断言**）

| # | 文件:行 | 改动 | 原因 |
|---|---|---|---|
| 1 | `strategy-core/tests/adr027_repro.rs:100-108` | `EngineEvent::Fill` 模式补 `..` | v2 增 4 字段（机械适配；新字段存在性由 R5/R6 自身 Debug 判据覆盖） |
| 2 | `strategy-core/tests/adr027_repro.rs:189` | `t.pnl` → `t.pnl.expect("Closed 回合必须携带 pnl（02-spec §2）")` | v2 `pnl: Option<f64>`；`None` 即违约，须 fail loud |
| 3 | `strategy-core/tests/adr027_repro.rs:287-289` | `t.close_bar` → `Some(1)`；`t.hold_bars` → `Some(0)` | v2 Option 形状（阈值/语义未变） |
| 4 | `strategy-core/tests/adr027_repro.rs:45` | `EnsembleConfig` 补 `symbol: "TEST.SYMBOL"` | 裁决 (A)：`symbol` 为新增必填字段（`code` 唯一取值来源） |
| 5 | `strategy-core/tests/engine.rs:79-88` | `EngineEvent::Fill` 模式补 `..` | 同 #1 |
| 6 | `strategy-core/tests/engine.rs:218` | `(1, 2)` → `(1, Some(2))` | v2 `close_bar: Option<usize>` |
| 7 | `strategy-core/tests/engine.rs:340/348/388/476/546/972/1020/1094/1237`（9 处） | `close_bar` 期望值包 `Some(..)` | 同上（判据数值未变） |
| 8 | `strategy-core/tests/engine.rs:341-344, 478-481`（2 处） | `close_price` 经 `.expect("Closed 回合必有 close_price（02-spec §2）")` | v2 Option 形状 |
| 9 | `strategy-core/tests/engine.rs:56`、`session.rs:64`、`observer.rs:36`、`templates.rs:51/135`、`session_alloc.rs:91`（6 处） | `EnsembleConfig` 补 `symbol: "TEST.SYMBOL"` | 同 #4 |
| 10 | `strategy-core/tests/session.rs:249` | `t.close_bar < bars.len()` → `t.close_bar.expect("Closed 回合必有 close_bar") < bars.len()` | v2 Option 形状 |
| 11 | `backtest/src/round_trip.rs`（新增单测） | `u2_incremental_assign_matches_batch_assign` 期望向量修正 1 项 | **我的期望值错误**（清仓后的卖出仍归当前回合，`rt_seq = 0` 仅适用于该 code 从未开仓的卖出）；规则与实现未改（以 `assign_rt_seq` 为准） |
| 12 | `strategy-core/tests/p1b_ledger.rs`（新文件自纠 2 处） | `shares` 期望改为仅 Σ_buy qty + 增加「Σsell qty == Σbuy qty」前置 | **我的期望值错误**（初版误把全部成交 qty 求和）；判据未放宽，反而补了闭合前置 |

---

## 4. 剩余待迁移点（P1a §4 清单对账）

| P1a # | 状态 | 说明 |
|---|---|---|
| 1（引擎占位值） | **已清除** | `apply_sell` 内 `rt_seq: 0`/`code: ""`/`l2_count: 1` 等占位值随字面量一并删除；`code` 取 `EnsembleConfig.symbol` |
| 2（sim-live FIFO lot 仍产 L1） | 待 P2 | 本轮未触碰 sim-live 结算口径（属 P2 车道）；仅做编译级机械适配 |
| 3（`application/src/audit.rs` 废弃 v1 兼容测试） | **本轮处置**（见下 §5） | 按裁决 ① 删除/改写为 v2 |
| 4（`open_price` 退化 0.0） | 未动 | 需架构裁决（`open_price` 是否改 Option）；正常路径不可达（仅孤儿卖出分组） |
| 5/6/7（strategy-core 旧测试 v1 形状） | **已消解** | 见 §3 适配清单；`cargo test -p strategy-core` 全绿 |
| 8（`ResultKind::Position` HTTP 白名单） | 待 P3 |

---

## 5. 未做项与原因（本阶段）

| 未做 | 原因 |
|---|---|
| sim-live 侧 `stamp_duty` 真值 / `bar_index` / L1 读路径统一（P1a #2） | P2 车道，本波范围外（任务书：先 R1/R2 → R5/R6 → 持仓序列 → 收尾待迁移点） |
| `open_price` 退化值（P1a #4） | 架构裁决项（改 `Option<f64>` 会二次改 ABI），未获本轮授权 |
| HTTP/MCP/前端 | P3/P4/P5 |


---

## 6. 最终验收状态（本轮收尾）

### 6.1 `cargo test -p strategy-core --test adr027_repro`（R1/R2/R5/R6，本波门禁）

```
test r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq ... ok
test r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl ... ok
test r2_l1_amount_fields_are_not_whole_round_trip_sums ... ok
test r6_fill_fact_source_lacks_rt_seq_and_fee_triple ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### 6.2 `cargo test -p strategy-core -p backtest`（`30_green_strategy_core.txt`）

```
backtest:        47 passed / 0 failed        （P1a 46 + 新增 1 个在线-批式一致性单测）
strategy-core:   36 lib + 4 repro + 26 engine(1 ignored) + 6 observer + 9 p1b + 7 session + 1 alloc + 3 templates —— 全 0 failed
```

### 6.3 `cargo test --workspace`

- `cargo test --workspace --no-run`：**全部测试目标编译通过**（含 application/simlive/mcp/web）。
- `cargo test --workspace`：两处**与本波无关的**既定红（原始输出见 `40_workspace_test.txt` / `41_workspace_test_minus_p2_lane.txt`）：
  1. `-p application --test adr027_repro_simlive` R3/R4（**P2 车道**：sim-live 结算 `stamp_duty` 硬编码 0.0、`bar_index` 由 `ts/bar_sec` 反算）。**取证**：两处缺陷在 `HEAD`（P1a 之前）即已存在——`git show HEAD:crates/application/src/simlive.rs` 第 1902/1903 行 `(lot.open_ts / bar_sec)`/`(t.ts / bar_sec)`、第 1914 行 `stamp_duty: 0.0`；P1b diff **未触碰** simlive 结算口径（lane 纪律：P1/P2 串行）。属 04-implementation-plan P2 范围。
     原始输出：
     ```
     R3：sim-live 结算费用三件套必须与撮合点事实一致，实得 3 项不符:
       stamp_duty 必须 > 0（本笔卖出含印花税 5.9988），实际 0（simlive.rs:1914 硬编码 0.0）
     R4：sim-live bar_index 必须为真实 bar 序号，实得 4 项不符:
       open_bar 必须 == 真实 bar 序号（会话内 0-based）= 30，实际 29806680
     ```
  2. `-p mcp --test d11_fee_profile_e2e::real_db_etf_default_fee_is_stamp_free_and_explicit_still_wins`：**环境门禁**（`crates/test-support/src/lib.rs:32` 刻意响亮失败：`EESTOCK_TEST_DATABASE_URL` 未设置，禁回退活库）。本机 `env | grep -c EESTOCK_TEST_DATABASE_URL` = 0 ⇒ 该用例在任何改动下都不可运行（与代码无关）。
- 除上述两项：`47+2+6+3+3+... ` 全绿（`41_workspace_test_minus_p2_lane.txt` 全 `0 failed`）。

### 6.4 `cargo build --workspace`

0 warning（`cargo build --workspace 2>&1 | grep -c "^warning"` = 0）。

### 6.5 本轮 staged 清单（`git add`，**未提交**）

```
crates/backtest/src/lib.rs, crates/backtest/src/round_trip.rs
crates/strategy-core/src/engine.rs, crates/strategy-core/src/lib.rs
crates/strategy-core/tests/{adr027_repro.rs,engine.rs,observer.rs,session.rs,session_alloc.rs,templates.rs,p1b_ledger.rs(新)}
crates/application/src/{audit.rs,strategy.rs,workbench.rs}
crates/application/tests/tester_p2b_tryrun_indep.rs
coder/evidence/20260920_adr027_p1b_engine/**（本报告 + 原始输出）
```

（注：`design/01-architecture/adr/ADR-023-*.md` 与 `design/17-trade-detail-layering/02-spec.md` 的工作区改动为**本波之前既有**、非本次产物 ⇒ **未 staging**。）

### 6.6 剩余待迁移点（4 项，均带归属）

| # | 项 | 归属 | 说明 |
|---|---|---|---|
| 1 | sim-live 结算：`stamp_duty` 真值 + 真实 `bar_index` + 复用 `aggregate_round_trips`（P1a #2） | **P2** | 本轮未做（lane 纪律）；R3/R4 即其复现测试（已先红） |
| 2 | `/fills` 与 per_bar 落库事件的 v2 字段增量（§5.4） | **P3** | `application/src/workbench.rs:2124`（`collect_fills`）、`:2250`（per_bar 事件序列化）本轮仅 `..` 机械适配，未改端点/落库形状 |
| 3 | `ResultKind::Position` 接入 HTTP `kind` 白名单 + 抽样披露（§4.1/§4.2） | **P3** | 引擎侧序列已产出（本波），HTTP 契约未接线 |
| 4 | `aggregate_round_trips` 退化分组 `open_price = 0.0`（P1a #4） | **架构裁决** | 正常路径不可达（仅孤儿卖出分组）；改 `Option<f64>` 属 ABI 二次变更，未获授权 |

### 6.7 未做项与原因（最终）

| 未做 | 原因 |
|---|---|
| R3/R4（sim-live 结算） | P2 车道（04-implementation-plan 明确 P1/P2 串行）；本波范围 = 引擎接线，未越界 |
| HTTP/MCP/前端（C/F 段） | P3/P4/P5 |
| `git commit` | 按纪律只 stage，不提交 |
| `gitnexus_impact` / `gitnexus_detect_changes` | 本 worker 会话未挂载 GitNexus MCP 工具（工具集仅读写/搜索/编辑）；改动面已用 `git diff --stat` + 编译/测试全绿 + 反向 grep（无第二处聚合/序号/费率复算）替代取证，**建议 reviewer 复核时跑一次 detect_changes** |

## 7. 反向守卫（防「假绿」自查）

| 守卫 | 命令 | 结果 |
|---|---|---|
| 引擎内无第二处 L1 聚合 / 序号逻辑 | `grep -rn "TradeDetail {\|HashMap<String, u32>\|fn assign_rt_seq" crates/strategy-core/src/` | 空 |
| 引擎内无 P1a 遗留占位值 | `grep -rn "待迁移点\|String::new()\|rt_seq: 0," crates/strategy-core/src/engine.rs` | 仅 1 处 `rt_seq: 0,` 为 `FillFact` 字面量初始化（下一行即由 `RtSeqAssigner` 就地覆写），非落库占位 |
| 费用三件套来源 = 实算（非复算） | R2 最低佣金笔 `commission = 5.0`（比例分支复算为 1.2525…）+ `p1b_fill_events_carry_exec_fee_values` 位级比对 | 通过 |
| 部分卖出确实进账本 | `p1b_i1_l1_amounts_equal_per_fill_sums`（bar5 部分卖出额 5010.25 计入 `gross_value`/`stamp_duty`） | 通过 |
| 持仓序列与净值同点 | `p1b_u7_position_series_is_synchronous_with_nav_and_self_consistent`（点数/ts/nav 逐点一致 + 末点空仓） | 通过 |
| 废弃 v1 兼容层未回流 | `application::audit::trade_detail_json_v2_shape_is_locked_and_v1_shape_is_rejected`（v1 形状必须被拒） | 通过 |
