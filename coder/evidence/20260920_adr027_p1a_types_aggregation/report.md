# 报告：`coder/evidence/20260920_adr027_p1a_types_aggregation/report.md`

**类型 完成 ｜ 聚合 完成 ｜ backtest 测试 绿 ｜ workspace 编译 通过 ｜ 待迁移点 8**

- 批次：ADR-027 / 02-spec「结果载荷 v2」P1a（仅【类型与纯聚合】，**未触碰 strategy-core 引擎内部逻辑**）
- 本文件位置：`coder/evidence/20260920_adr027_p1a_types_aggregation/report.md`（同目录另有 `10_red_backtest.txt`、`20_green_backtest_workspace.txt` 原始输出）
- 契约事实源：`design/17-trade-detail-layering/02-spec.md` §1–§4、`ADR-027-trade-detail-two-level-round-trip-model.md`、`03-test-plan.md` U 段
- 架构师追加裁决（本轮 supervisor 回复，已执行）：Q1=(B) `OrderSide` 迁 `backtest`；Q2=`FillFact.code: String`；Q3=`close_price: Option<f64>`；
  Q4=删 `initial_capital` 参数；补充冻结：`assign_rt_seq(fills: &mut [FillFact])` 为序号分配唯一实现，`aggregate_round_trips(fills: &[FillFact])` 只分组求和、不重编号。
- 变更规模：11 个文件，+1101 / −46（`git diff --cached --stat`，含证据文件）

---

## 1. 逐文件改动摘要

| 文件 | 改动 |
|---|---|
| `crates/backtest/src/round_trip.rs`（**新建**，862 行） | 新类型 `OrderSide`（自 strategy-core 迁入，唯一定义）、`FillReason`(Policy/StopTrigger/ForceClose/Manual)、`RoundTripStatus`(Open/Closed)、`FillFact`（含 `rt_seq`/`code`/`bar_index`/`ts`/`side`/`qty`/`price`/费用三件套/`reason`）；唯一聚合实现 `aggregate_round_trips(&[FillFact]) -> Vec<TradeDetail>`；唯一序号分配实现 `assign_rt_seq(&mut [FillFact])`；U1/U2/U3/U4/U6 + 顺序/空输入/字符串往返共 15 个单测 |
| `crates/backtest/src/types.rs` | `TradeDetail` **原地升级 v2**：增 `rt_seq: u32`/`code: String`/`status: RoundTripStatus`/`l2_count`/`buy_count`/`sell_count`；`close_ts`/`close_bar`/`close_price`/`pnl`/`hold_bars` 改 `Option<_>`；注释改为全回合口径（02-spec §2）。既有 `reason: Option<String>` 语义与 `#[serde(default)]` **保留不动** |
| `crates/backtest/src/lib.rs` | 新 `pub mod round_trip`；导出 `aggregate_round_trips`/`assign_rt_seq`/`FillFact`/`FillReason`/`OrderSide`/`RoundTripStatus` |
| `crates/backtest/src/metrics.rs` | 绩效口径收紧（ADR-027 D7）：仅 `status == Closed` 的回合进入 `win_rate`/`profit_factor`/`trade_count`/`avg_hold_bars`；`pnl`/`hold_bars` 经 `filter_map`/`unwrap_or(0)` 消费（**Open 不造 0 计入**）；测试夹具升级为 v2 + 新增「Open 回合不参与绩效」用例 |
| `crates/domain/src/ports.rs` | `ResultKind` 增 `Position` 变体 + 三处同步：`as_str` → `"position"`、`parse("position")`、`is_sampleable()`（`Position` 返回 true；`Fills` 仍 false，实现式 `!matches!(self, Fills)` 不变） |
| `crates/strategy-core/src/engine.rs` | ① 删除本地 `OrderSide` 定义，改 `pub use backtest::OrderSide;`（消费方路径与 serde 形状零改动）；② 新增 `impl From<OrderReason> for FillReason`（Policy/StopTrigger/ForceClose）；③ `apply_sell` 的 `TradeDetail` 字面量补 v2 字段（**仅补字段，不改分支语义**，占位值见 §4-迁移点 1） |
| `crates/application/src/simlive.rs` | 最小机械适配：`sim_trades_to_trade_details` 的 `TradeDetail` 字面量补 v2 字段（`code` 取真实成交代码；`rt_seq`/`l2_count`/笔数为占位值）；`close_*`/`pnl`/`hold_bars` 包 `Some` |
| `crates/application/src/workbench.rs` | `ResultKind::Position` 穷尽性适配 2 处：`bar_ts_secs` 归入「对象含 `ts` 字段」分支（与 02-spec §4.1 点形状一致）；`legacy_series` 返回空（`legacy_single` 无该列，旧 run 不回填） |
| `crates/application/src/audit.rs` | 新增迁移守卫测试 `order_side_relocation_keeps_type_identity_and_serde_shape`（类型恒等 + serde 逐字节 `"Buy"/"Sell"` + 双向往返 + 与 `parse_side` 口径一致） |
| `coder/evidence/.../10_red_backtest.txt`、`20_green_backtest_workspace.txt` | 红/绿原始输出落盘 |

### 聚合口径实现（02-spec §2 逐条对应）

```
Closed:  gross_value = Σ_sell trade_value
         commission  = Σ_buy commission + Σ_sell commission
         stamp_duty  = Σ_sell stamp_duty
         invested    = Σ_buy (trade_value + commission)
         proceeds    = Σ_sell (trade_value − commission − stamp_duty)
         pnl         = Some(proceeds − invested)          // 整回合现金流差，无成本分摊/FIFO
         shares      = Σ_buy qty ; hold_bars = Some(close_bar − open_bar)
Open:    pnl = None ; hold_bars = None ; close_ts/close_bar/reason = None（禁止造数）
         close_price = None（完全无卖出）／Some(Σsell tv / Σsell qty)（有卖出含部分卖出）
         open_price  = Σ_buy trade_value / Σ_buy qty（无买入的退化分组 ⇒ 0.0，见迁移点 4）
判定:    closed = sell_qty > 1e-9 && |buy_qty − sell_qty| ≤ 1e-9
输出序:  按 code 首现升序；code 内按 rt_seq 升序（架构师冻结）
```

**硬约束遵守**：费用三件套只做事实值加总，全文件无任何 `commission_rate/stamp/pct/slippage` 参与复算（U4 用「与费率复算不同的费用事实值」反向守卫，证明透传）；聚合函数无 IO、无全局状态、无时钟（纯 `HashMap`/`Vec` 局部状态）。

---

## 2. 测试命令与原始输出

### 2.1 RED（实现前，`aggregate_rt_seq` 为 stub）
```
$ cargo test -p backtest
test result: FAILED. 32 passed; 14 failed; 0 ignored; ...
failures:
    metrics::tests::open_round_trips_are_excluded_from_metrics
    round_trip::tests::empty_fills_yield_empty_round_trips
    round_trip::tests::output_order_code_first_appearance_then_rt_seq
    round_trip::tests::u1_open_round_has_no_pnl
    round_trip::tests::u1_open_round_without_sell_has_null_close_price
    round_trip::tests::u1_table_driven_round_trip_fields
    round_trip::tests::u2_assign_rt_seq_is_per_code
    round_trip::tests::u2_assign_rt_seq_open_add_close_reopen
    round_trip::tests::u2_assign_rt_seq_orphan_sell_is_zero
    round_trip::tests::u2_assign_rt_seq_zero_length_round_same_bar
    round_trip::tests::u4_aggregate_passes_through_facts_without_recompute
    round_trip::tests::u4_fee_triple_is_bit_identical_to_fee_model_output
    round_trip::tests::u6_assign_then_aggregate_seq_consistent
    round_trip::tests::u6_distinct_rt_seq_equals_round_trip_count
```
（完整输出：`10_red_backtest.txt`）

### 2.2 GREEN
```
$ cargo test -p backtest
test result: ok. 46 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s

$ cargo build --workspace
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s     (exit=0；无 error/无 warning)

$ cargo test -p application --lib audit::tests::order_side_relocation
test audit::tests::order_side_relocation_keeps_type_identity_and_serde_shape ... ok
test result: ok. 1 passed; 0 failed

$ cargo test -p domain --lib
test result: ok. 10 passed; 0 failed
```
（完整输出：`20_green_backtest_workspace.txt`）

基线对照：改动前 `cargo test -p backtest` = 31 passed；现在 46 passed（**新增 15 个单测全绿**，既有 31 个未改判据、全绿）。

### 2.3 U 段覆盖对照
| ID | 落点 | 覆盖内容 |
|---|---|---|
| U1 | `u1_table_driven_round_trip_fields`（表驱动 6 例） | 单笔开平 / 多批加仓 / 部分卖出（2 笔卖）/ DCA 100 批 / 零长回合 / 期末强平；逐字段 `==` 手算期望（金额 1e-9 容差） |
| U2 | `u2_assign_rt_seq_*`（4 例，按裁决移到 `assign_rt_seq` 单测） | 开仓新序号 / 加仓同序号 / 部分卖出同序号 / 清仓终结 / 再开仓 +1；零长回合同 bar；per-code 独立计数；孤儿卖出 = 0 |
| U3 | `u1_open_round_has_no_pnl`、`u1_open_round_without_sell_has_null_close_price`、`metrics::tests::open_round_trips_are_excluded_from_metrics` | Open ⇒ `pnl/hold_bars/close_*/reason = None`；`trade_count`/`win_rate` 分母不含 Open |
| U4 | `u4_fee_triple_is_bit_identical_to_fee_model_output`、`u4_aggregate_passes_through_facts_without_recompute` | 三件套 `to_bits()` 逐位相等（含最低佣金分支 `trade_value = 995.0`）；聚合并置位 `==`（非容差）；异于费率复算的费用事实值原样透传 |
| U6 | `u6_distinct_rt_seq_equals_round_trip_count`、`u6_assign_then_aggregate_seq_consistent` | `distinct(rt_seq) == round_trips.len()`；`Σ l2_count == fills.len()`；ForceClose 终结回合 |
| 补充 | `output_order_code_first_appearance_then_rt_seq`、`empty_fills_yield_empty_round_trips`、`fill_reason_and_status_string_round_trip` | 输出序契约；空输入；`as_str/parse` 往返 |
| U5 | **未做**（见 §5） | 需引擎 `nav`/positions 联动，属 P1b |

---

## 3. TDD 过程披露（含一次测试侧纠错）

1. 先写 `round_trip.rs` 的类型 + 全部 U 段测试 + `unimplemented!()` stub ⇒ 红（14 failed，原始输出已落盘）。
2. 实现 `assign_rt_seq` + `aggregate_round_trips` ⇒ 44 passed / 2 failed：
   - `metrics::tests::open_round_trips_are_excluded_from_metrics`：**测试夹具 bug**（`open_trade()` 用结构体更新语法漏写 `status`，实际仍是 `Closed`）⇒ 修夹具（补 `status: Open`）；
   - `u2_assign_rt_seq_is_per_code`：**我的期望值错误**（末笔 A 买入时 A 仍持仓 ⇒ 按冻结规则「持仓中的成交归当前回合」应为 2，而非 3）⇒ 修期望值（规则未改、实现未改）。
3. 二者修正后 ⇒ 46 passed / 0 failed。**未删除、未放宽任何判据**。

---

## 4. 待迁移点清单（8 项，均已在代码处标 `待迁移点`/注释）

| # | 位置 | 内容 | 归属 |
|---|---|---|---|
| 1 | `crates/strategy-core/src/engine.rs:877`（`apply_sell`） | `TradeDetail` v2 字面量的**占位值**：`rt_seq = 0`、`code = String::new()`（引擎无 symbol）、`l2_count/buy_count/sell_count = 1`（`Holding` 无笔数）。语义分支**未改动**；`status = Closed`/`close_* = Some(..)`/`pnl = Some(exec.proceeds − h.cost_basis)` 为原值。P1b 应改为「成交时打 `rt_seq`（`assign_rt_seq`）+ 期末 `aggregate_round_trips` 物化」并删除占位值 | P1b（引擎） |
| 2 | `crates/application/src/simlive.rs:1904` | FIFO lot 配对仍产 L1（F6/D5 未统一）：`rt_seq = 0`、`l2_count/buy_count/sell_count = 1` 占位；`code` 已为真实值。P1b/F 段应改走 `aggregate_round_trips`（且 `stamp_duty: 0.0` 硬编码仍在，属 ADR-027 D4/F9 迁移项） | P1b（sim-live 结算） |
| 3 | `crates/application/src/audit.rs` 测试 `trade_detail_json_reads_legacy_without_reason_field` | **运行时红**（`cargo test -p application --lib` 46 passed / 1 failed：`missing field rt_seq`）。v2 新字段**未加 `#[serde(default)]`**（依 ADR-027 D3「不提供旧语义兼容」）。**需裁决**：(a) 按 D3 删除/改写该 obsolete 用例（推荐，`status` 无默认值可造）；(b) 若要兼容窗口则给 6 个新字段加 `serde(default)` 并给 `RoundTripStatus` 定默值（会引入 `rt_seq=0`/`code=""` 的静默默认，违反禁造数） | 架构裁决 |
| 4 | `crates/backtest/src/round_trip.rs` `aggregate_round_trips` | 退化分组（`buy_qty ≤ 1e-9`，仅可能来自 `rt_seq = 0` 的孤儿卖出）`open_price` 落 `0.0`（`open_price` 非 Option）。正常路径不可达；若不接受该退化值，需把 `open_price` 也改 Option | 架构裁决 |
| 5 | `crates/strategy-core/tests/engine.rs`（11 errors） | 既有测试按 v1 读 `trades[].pnl`（`f64`）等 ⇒ 需改 `Option` 断言（`assert_eq!(t.pnl, Some(..))`）。**非本波门禁**（`cargo build --workspace` 不含 test target） | Tester / P1b |
| 6 | `crates/strategy-core/tests/session.rs:249`（1 error） | 同上（v1 字段访问） | Tester / P1b |
| 7 | `crates/strategy-core/tests/adr027_repro.rs:185,284,285`（3 errors） | **R 段复现测试**（tester 所有）；其断言对象为 v1 `pnl: f64`，随 v2 类型改动编译失败。R1/R2/R5 的「先红后绿」裁判点需按 v2 形状重述（红=旧口径不成立，绿=全回合口径成立） | Tester（R 段） |
| 8 | `crates/application/src/workbench.rs` `parse_series_kind`（web/src/workbench.rs:219-223 同源） | `ResultKind::Position` **尚未** 接入 HTTP `kind` 白名单（`/curve?kind=position` 目前返回 400）；02-spec §4.2 要求 `position` 可抽样（须披露 `downsampled`/`original_bars`）。本波未接线（越界到 HTTP 契约） | P1c/P2（HTTP 契约） |

其它已知、**未列入**清单但同属后续批次：sim-live 运行中 L1/L2 读路由（F8）、`/audit` 增量、`FillFact` 落地（引擎 `EngineEvent::Fill` 三件套 + `sim_trades` 费用拆列）、前端 L1/L2 UI。

---

## 5. 未做项与原因

| 未做 | 原因 |
|---|---|
| strategy-core 引擎内部逻辑（`rt_seq` 落地、`apply_sell` 部分卖出进账本、期末 `aggregate_round_trips` 物化） | **本波范围明确排除**（下一波 P1b） |
| U5（I3 跨侧恒等式 `nav[-1] == initial + Σ_closed pnl + Σ_open(..)`） | 需要引擎产出 `positions`/`nav` 与真实 fills，属 P1b；本波无 `initial_capital` 入参（已按裁决删除） |
| U7（持仓序列）/U8（绩效差异基线） | 同属 P1b/P2 引擎与结果载荷范围 |
| HTTP/MCP 契约（C 段）、前端（F 段）、S 段共享向量文件 | 本波只做类型与纯聚合 |
| `git commit` | 按纪律**只 stage，不提交** |
| `FillFact` 的 serde 显式形状测试 | 新类型无「迁移前后」可比对象；`OrderSide` 迁移的 serde 守卫已在 `application/src/audit.rs` 落地并通过 |

## 6. 残余风险

1. 迁移点 3（`application` 1 个运行时红测试）会让 `cargo test --workspace` 变红——**这是本波唯一的红**，需架构裁决后由下一波消除。
2. 迁移点 1/2 的占位值在 P1b 之前会被写进新 run 的 `trades` JSON（D3 已清空历史、不提供兼容），**在 P1b 完成前不应发布该路径的对外结果**。
3. `strategy-core` test target 编译失败（迁移点 5/6/7）意味着 `cargo test -p strategy-core` 暂不可用；R 段复现裁判点在 P1b 恢复。
