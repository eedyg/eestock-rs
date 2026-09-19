# R3 证据 — sim-live 结算 `stamp_duty` 恒 0（费已含印花税）

- **文件位置**：`tester/evidence/20260920_adr027_repro/R3_simlive_stamp_duty_zero.md`
- **判词**：🔴 **红**（3 项缺口全中：`stamp_duty == 0` 且印花税被整笔并进 `commission`）
- **批次**：20260920_adr027_repro ｜ **commit**：`0fdd83e` ｜ **时间（UTC）**：2026-09-19T14:45Z
- **被测代码（只读）**：`crates/application/src/simlive.rs:1860-1925` `sim_trades_to_trade_details`
  - `:1905` `commission: buy_fee_share + sell_fee_share`（**卖腿合并 fee 整笔计入 commission**）；
  - `:1914` `stamp_duty: 0.0`（硬编码）。
  上游事实：`crates/simlive/src/fill.rs:94-108`（`commission` 与 `stamp_duty` 都算出后被合并为单列 `fee`，ADR-027 F9）。
- **契约事实源**：`02-spec.md` §1.1（`FillFact.stamp_duty` 必须来自 `FeeModel::sell` 返回值）、§1.2/§2（`stamp_duty = Σ_sell stamp_duty`）、§8（`sim_trades` 拆列）；
  判据出处：`03-test-plan.md` §1 R3；裁决：`ADR-027` §2.5 D4（`simlive.rs:1914` 的硬编码必须修）、§2.13

## 1. 可执行命令

```bash
cargo test -p application --test adr027_repro_simlive -- --exact \
  r3_simlive_settlement_stamp_duty_is_not_zero
```

测试文件：`crates/application/tests/adr027_repro_simlive.rs`（本批次新增）。
原始输出全文：`tester/evidence/20260920_adr027_repro/raw/r3_simlive_settlement_stamp_duty_is_not_zero.txt`

## 2. 构造（单元级，**未启动服务、未接 DB**）

- `SimLiveService::new(mock SimSessionStore, TestClock, FeeModel::default())`；会话 `period = "M1"`、`source = "manual"`、
  `strategy_set = []`（⇒ 纯手动会话：不 spawn 编排器 worker、不触 Registry/行情 provider）。
- 步骤：`start_session` → 时钟推进 → 市价买 1000 @10 → `mark_to_market(12.0)` → 市价卖 1000 @12 → `stop_session`（结算落库）。
- mock `SimSessionStore`（本文件内 11 个方法的内存实现）记录 `NewSimTrade` 与结束结果，供断言读回。

## 3. 原始输出片段（逐字）

```text
running 1 test
test r3_simlive_settlement_stamp_duty_is_not_zero ... FAILED

---- r3_simlive_settlement_stamp_duty_is_not_zero stdout ----

thread 'r3_simlive_settlement_stamp_duty_is_not_zero' (1607507) panicked at crates/application/tests/adr027_repro_simlive.rs:277:5:
R3：sim-live 结算费用三件套必须与撮合点事实一致，实得 3 项不符:
  stamp_duty 必须 > 0（本笔卖出含印花税 5.9988），实际 0（simlive.rs:1914 硬编码 0.0）
  stamp_duty 必须 == Σ_sell 印花税 = 5.9988，实际 0（Δ = -5.9988）
  commission 必须 == Σ_buy + Σ_sell 佣金 = 10，实际 15.9988（Δ = 5.998799999999999；现口径把卖腿「佣金+印花税」合并值整笔计入 commission）

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s
```

**断言失败的具体行**：`crates/application/tests/adr027_repro_simlive.rs:277`（3 项缺口一次性汇总断言）。
绿侧前置断言（通过）：落库的 `sim_trades.fee == commission + stamp = 10.9988`（卖腿）——**证明拆分事实在上游存在、只是在结算合成时被丢弃**。

## 4. 该结果证明了什么

1. **`stamp_duty` 恒 0 成立**（ADR-027 F6/§2.5 D4 取证）：卖腿事实印花税 `11997.6 × 0.05% = 5.9988`，
   结算产物 `stamp_duty = 0`，Δ = −5.9988。
2. **费用被错列**：`commission` 实际 `15.9988`（= 买腿 5 + 卖腿「佣金 5 + 印花税 5.9988」），
   而全回合佣金应为 `10`（Δ = +5.9988）⇒ 印花税被**整笔并进佣金**，同时 `stamp_duty` 归零；两个字段同时失真。
3. 上游 `sim_trades.fee = 10.9988` 的落库值证明**拆分事实本来存在**（`fee.commission` 与 `fee.stamp_duty` 都算过），
   ⇒ 修复路径是 D4 的「拆回两列」（`sim_trades.commission`/`stamp_duty` + 结算读取），**不是**重算。

## 5. 该结果**未**证明什么

- 未证明运行中读路径（`sim_list_*`/`sim_get_session` 的 trade 形状）——本测试只做 `stop_session` 结算；
- 未证明 HTTP/MCP 端点层的字段形状（C 段契约测试范围）；
- 未证明「多 lot FIFO 配对 + 部分平仓」下的费用归属正确性（本构造为单笔全平；属 `03-test-plan` U/S 段）；
- 未证明 `pnl` 口径是否正确（本用例只判费用三件套）——注意 `pnl` 在本口径下用合并 fee 计算，其偏差未在本报告取证。

## 6. 构造方式的不确定性

1. **「真实 bar 序号」的语义边界**：R3 不涉及；见 R4 的说明。
2. mock 端口为本文件内的最小实现（11 方法全实现，`update_positions` 为 no-op）；与真实 Pg 存储的差异仅在持久化，
   **不影响**被证事实（合成逻辑 `sim_trades_to_trade_details` 只吃内存 `state.trades`）。
3. 会话为**纯手动**（`strategy_set = []`）：若改走「策略驱动下单」，成交还需经过编排器 worker（QuickJS 线程），
   本测试刻意避开以确保确定性且不启动服务；两种路径共用同一 `FillEngine`/`apply` 与同一结算函数，故结论可迁移（但**未**实测迁移）。
4. 时钟推进量（+1817s）非 bar 边界，仅为同时服务 R4 的前置；R3 的判决与该值无关（费用与 ts 无关）。

## 7. 纪律声明

- 未修改任何生产代码（`crates/**/src/**` 零改动）；未尝试修复失败；未做永久性插桩。失败归因交父级。
