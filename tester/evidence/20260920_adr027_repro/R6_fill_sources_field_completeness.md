# R6 证据 — `fills` 事实源 与 `per_bar.events` 事件源的字段完备性现状

- **文件位置**：`tester/evidence/20260920_adr027_repro/R6_fill_sources_field_completeness.md`
- **判词**：🔴 **红**（两源逐笔均缺 `rt_seq` + 金额三件套；3 笔 × 4 字段 = 12 项缺口全中）
- **批次**：20260920_adr027_repro ｜ **commit**：`0fdd83e` ｜ **时间（UTC）**：2026-09-19T14:45Z
- **被测代码（只读）**：
  - `crates/strategy-core/src/engine.rs:224-235`：`EngineEvent::Fill { bar_index, side, qty, price, reason }`（**无** `trade_value`/`commission`/`stamp_duty`/`rt_seq`）；
  - `crates/strategy-core/src/engine.rs:551-586`（买）/`:616-640`（卖）/`:665-690`（止损卖）/`:496-520`（期末强平）：
    四处调用点均从 `FeeModel::buy/sell` 拿到 `trade_value/commission/stamp_duty`，**只把 `qty/price/reason` 写入事件，费用事实被丢弃**（ADR-027 F9 的回测侧同型）；
  - 两源的唯一来源（读侧投影，`application` crate，私有函数、本测试不可调用）：
    `crates/application/src/workbench.rs:2118-2128`（`collect_fills` → `kind='fills'` 块的 JSON：`type/bar_index/ts/side/qty/price/reason`）
    与 `:2247-2253`（`per_bar` 事件的 JSON 投影：同 7 键）。⇒ **两源同事实、同缺口**。
- **契约事实源**：`02-spec.md` §1.1（`FillFact` 必含 `rt_seq`/`trade_value`/`commission`/`stamp_duty`）、§5.4（`/fills` 元素增字段）；
  判据出处：`03-test-plan.md` §1 R6；裁决：`ADR-027` §1.1 F9、§2.5 D4、§2.13

## 1. 可执行命令

```bash
cargo test -p strategy-core --test adr027_repro -- --exact \
  r6_fill_fact_source_lacks_rt_seq_and_fee_triple
```

原始输出全文：`tester/evidence/20260920_adr027_repro/raw/r6_fill_fact_source_lacks_rt_seq_and_fee_triple.txt`

## 2. 构造

与 R1/R2 同一 run（买 1 笔 + 部分卖 1 笔 + 清仓 1 笔，共 3 笔成交事实）：
`bar1 Buy 5000.0@10.002`、`bar5 Sell 417.60427083333343@11.9976`、`bar7 Sell 4582.395729166667@10.9978`。
对每笔成交事实断言 4 个必备字段存在（`rt_seq`/`trade_value`/`commission`/`stamp_duty`）。

## 3. 原始输出片段（逐字，节选）

```text
running 1 test
test r6_fill_fact_source_lacks_rt_seq_and_fee_triple ... FAILED

---- r6_fill_fact_source_lacks_rt_seq_and_fee_triple stdout ----

thread 'r6_fill_fact_source_lacks_rt_seq_and_fee_triple' (1604696) panicked at crates/strategy-core/tests/adr027_repro.rs:371:5:
R6：两源（fills 事实源 / per_bar.events）逐笔必须携带 rt_seq + 金额三件套（02-spec §1.1），实得 12 项缺口:
  第 0 笔（bar1 Buy）缺 `rt_seq`；Debug: Fill { bar_index: 1, side: Buy, qty: 5000.0, price: 10.001999999999999, reason: Policy }
  第 0 笔（bar1 Buy）缺 `trade_value`；Debug: Fill { bar_index: 1, side: Buy, qty: 5000.0, price: 10.001999999999999, reason: Policy }
  第 0 笔（bar1 Buy）缺 `commission`；Debug: Fill { bar_index: 1, side: Buy, qty: 5000.0, price: 10.001999999999999, reason: Policy }
  第 0 笔（bar1 Buy）缺 `stamp_duty`；Debug: Fill { bar_index: 1, side: Buy, qty: 5000.0, price: 10.001999999999999, reason: Policy }
  第 1 笔（bar5 Sell）缺 `rt_seq`；Debug: Fill { bar_index: 5, side: Sell, qty: 417.60427083333343, price: 11.9976, reason: Policy }
  第 1 笔（bar5 Sell）缺 `trade_value`；...
  第 1 笔（bar5 Sell）缺 `commission`；...
  第 1 笔（bar5 Sell）缺 `stamp_duty`；...
  第 2 笔（bar7 Sell）缺 `rt_seq`；Debug: Fill { bar_index: 7, side: Sell, qty: 4582.395729166667, price: 10.9978, reason: Policy }
  第 2 笔（bar7 Sell）缺 `trade_value`；...
  第 2 笔（bar7 Sell）缺 `commission`；...
  第 2 笔（bar7 Sell）缺 `stamp_duty`；...

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

**断言失败的具体行**：`crates/strategy-core/tests/adr027_repro.rs:371`（12 项缺口一次性汇总断言）。
绿侧前置断言（通过）：两源逐笔 tuple `(bar_index, side, qty, price, reason)` 完全一致（`assert_eq!(events_side, f)`），
即 **两源同事实**（同一 `EngineEvent` 列表的两个投影）。

## 4. 该结果证明了什么

1. **单一事实源、单一缺口**：`fills` 块与 `per_bar.events` 是**同一** `EngineEvent::Fill` 列表的两个投影
   （本测试实测两源逐笔 tuple 相等）⇒ 字段缺口不是「两源不一致」，而是**共同缺字段**：
   `rt_seq`/`trade_value`/`commission`/`stamp_duty` 四者**全部不在引擎事件载荷内**（3 笔 × 4 = 12 项全缺）。
2. **事实在引擎内被丢弃**（代码级事实，与上面实测互补）：买/卖/止损/强平四处调用点都持有 `fee.buy/sell` 返回的
   `trade_value/commission/stamp_duty`，写入事件的只有 `qty/price`；⇒ 02-spec §1.1 的 `FillFact` 无法由现有事实源满足，
   `/fills` 元素增字段（§5.4）无数据可依。
3. 因此 R6 的绿判据需要**引擎事件载荷扩字段**（而非仅在读侧拼接），且该扩展同时修复两源（DRY 受益）。

## 5. 该结果**未**证明什么

- **未观测端点产物**：`/fills`、`/result`、MCP `bt_get_run_fills` 的实际 JSON 未被执行（需 DB/HTTP 或会话），
  本红取的是**策略层事实源**；`workbench.rs:2118/2247` 的投影形状是**代码阅读**（作为「两源同事实」的补充说明），
  **不作为本测试的判据**。⇒ 端点侧形状缺口属 C 段契约测试（本批次未做）。
- 未证明 sim-live `sim_trades` 的费用拆列现状（§8 DB 契约；R3 另有取证）。
- 未证明「按 `(side, qty, price)` + FeeModel 复算」是否在**所有**分支都不可逆（F10）：
  本构造的 3 笔恰好都在可逆分支（比例 / 最低佣金）。**未**构造出「复算与原值逐位不等」的正例；
  ⇒ 本报告不能以实测支撑 D4「禁止下游复算」的**强度**，只能支撑「事实源缺字段」这一事实（D4 的规范依据见 F10 代码事实）。
- 未证明 `recorded`/`has_more`/`next_offset` 的完整性契约（§5.6 D11；属 C 段）。

## 6. 构造方式的不确定性

1. 字段存在性用**运行时 `Debug` 呈现**断言（同 R5 §6.1 的理由：无 `serde_json` 依赖 + 编译期引用不构成可判红断言）；
   残余风险同 R5：手写 `Debug` 可伪造。
2. 「两源」的一致性断言用的是**同一列表的两次取值**（`f` 与 `events_side = f.clone()`），
   严格说只能证明「事件列表内部一致」，不能证明 `application` 侧两个投影逐字相等（私有函数不可达）。
   ⇒ 这一弱点已如实标注：本测试的「两源」判据**等价于**「引擎事件载荷缺字段」，其证据力不依赖于 `application` 投影。
3. 若实现方选择在 4 处调用点分别补齐事件字段（而非统一构造函数），本测试仍会转绿——本测试**不**锁定实现方式，
   只锁定「事件载荷含四字段」这一契约结果。

## 7. 纪律声明

- 未修改任何生产代码；未尝试修复失败；未做永久性插桩。失败归因交父级。
