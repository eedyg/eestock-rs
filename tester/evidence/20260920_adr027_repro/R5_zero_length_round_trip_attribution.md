# R5 证据 — 零长回合（同 bar 买+卖）在当前数据模型下无法归属（无 `rt_seq`/`l2_count`）

- **文件位置**：`tester/evidence/20260920_adr027_repro/R5_zero_length_round_trip_attribution.md`
- **判词**：🔴 **红**（构造成功但归属契约缺字段：4 项缺口）
- **批次**：20260920_adr027_repro ｜ **commit**：`0fdd83e` ｜ **时间（UTC）**：2026-09-19T14:45Z
- **被测代码（只读）**：`crates/strategy-core/src/engine.rs`（步骤 1 `:507` 执行挂单 + 步骤 2 Intrabar 止损 `:637-666`）；
  `crates/backtest/src/types.rs:102-130`（`TradeDetail` 无 `rt_seq`/`l2_count`）；`engine.rs:224-235`（`EngineEvent::Fill` 无 `rt_seq`）
- **契约事实源**：`02-spec.md` §1.1（`FillFact.rt_seq`）、§1.2（`RoundTrip.rt_seq`/`l2_count`）、§3（`rt_seq` 归属，**禁止窗口推断**）；
  判据出处：`03-test-plan.md` §1 R5；裁决：`ADR-027` §1.1 F5、§2.7 D6、§4.3

## 1. 可执行命令

```bash
cargo test -p strategy-core --test adr027_repro -- --exact \
  r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq
```

原始输出全文：`tester/evidence/20260920_adr027_repro/raw/r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq.txt`

## 2. 构造

- 2 根 bar：`bar0 = {o=h=l=c=10.0}`（决策 Buy）；`bar1 = {open 10.0, high 10.0, low 9.4, close 9.5}`。
- 插件恒 80 分（Buy 区）；`LumpSum { position_pct: 1.0 }`；`initial_capital = 100_000`；`FeeModel::default()`；
  `StopConfig { FixedPct(0.05), Intrabar }`。
- 时序（`bar1` 内两笔成交，同一 bar）：
  1. 步骤 1：执行 `bar0` 挂单 → **买 9995.501524538882 股 @ 10.002**（`Policy`）；
  2. 步骤 2：`avg_cost = 100_000/9995.5015… = 10.0045…`，止损线 `= avg_cost×0.95 = 9.5043…`；`bar1.low = 9.4 < 线`
     → 当 bar **卖 9995.501524538882 股 @ 9.502374619904998**（`StopTrigger`）。
- 结果：`trades[0] = { open_bar: 1, close_bar: 1, hold_bars: 0, pnl: -5090.235750000022, reason: Some("StopTrigger") }`
  ⇒ **零长回合被成功构造**（ADR-027 F5 成立，`open_bar == close_bar`）。

## 3. 原始输出片段（逐字）

```text
running 1 test
test r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq ... FAILED

---- r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq stdout ----

thread 'r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq' (1604695) panicked at crates/strategy-core/tests/adr027_repro.rs:320:5:
R5：零长回合必须可归属（l2_count == 2 且两笔同 rt_seq），实得 4 项缺口:
  L1 缺 `l2_count` 摘要字段（02-spec §1.2）⇒ 无法表达「该回合 = 2 笔成交」；Debug: TradeDetail { open_ts: 1700086400, close_ts: 1700086400, open_bar: 1, close_bar: 1, open_price: 10.001999999999999, close_price: 9.502374619904998, shares: 9995.501524538882, gross_value: 94980.99999999999, commission: 48.739001562109465, stamp_duty: 47.49049999999999, pnl: -5090.235750000022, hold_bars: 0, reason: Some("StopTrigger") }
  L1 缺 `rt_seq` 字段（02-spec §1.2/§3 D6 归属键）；Debug: TradeDetail { ... 同上 ... }
  同 bar 第 0 笔成交事实缺 `rt_seq`（02-spec §1.1 FillFact）⇒ 归属只能退化到 [open_bar, close_bar] 窗口推断（D6 明确否掉）；Debug: Fill { bar_index: 1, side: Buy, qty: 9995.501524538882, price: 10.001999999999999, reason: Policy }
  同 bar 第 1 笔成交事实缺 `rt_seq`（02-spec §1.1 FillFact）⇒ ...；Debug: Fill { bar_index: 1, side: Sell, qty: 9995.501524538882, price: 9.502374619904998, reason: StopTrigger }

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

**断言失败的具体行**：`crates/strategy-core/tests/adr027_repro.rs:320`（4 项缺口一次性汇总断言）。
构造守卫（绿，先于红断言执行并通过）：`trades.len() == 1`、`open_bar == close_bar == 1`、`hold_bars == 0`、
`bar1` 内恰 2 笔成交且先 `Buy`(Policy) 后 `Sell`(StopTrigger)。

## 4. 该结果证明了什么

1. **零长回合可达**（F5 取证）：步骤 1 买入 + 步骤 2 当 bar 止损 ⇒ `open_bar == close_bar == 1`、`l2_count` 应为 2。
2. **归属契约缺口（4 项）**：
   - L1 无 `l2_count` ⇒ 无法表达「该回合 = 2 笔成交」，D8 懒加载首屏摘要缺失；
   - L1 无 `rt_seq` ⇒ L1 ↔ L2 无归属键；
   - 两笔成交事实均无 `rt_seq` ⇒ 归属只能退化为 `[open_bar, close_bar]` 窗口推断 —— 而零长回合正是该推断的退化形态
     （窗口单点），D6 已明确否掉窗口推断（依赖未文档化、未测试锁定的不变式）。
3. 该 run 的两笔成交**同 bar 同 qty 反向**，只能靠 `side` 区分；任何按窗口/按 bar 的归属都无法区分「哪笔属哪个回合」——
   这正是 D6 要求「谁在事件发生时知道语义，谁就把语义写进数据」的直接动因。

## 5. 该结果**未**证明什么

- **未证明窗口推断在今日引擎上会算错**：现引擎单 bar 最多 2 笔（步骤 1 + 步骤 2），且同 bar 两笔必属同一回合，
  故本用例下窗口推断恰好也能得到正确结果。本红取的是**字段缺失**（契约不可表达、D6 禁止的手段成为唯一手段），
  **不是**「窗口推断已产生错误数据」——后者属假设性风险，本测试不能举证。
- 未证明 sim-live 侧零长回合归属（sim-live 无 intrabar 止损路径，且其当前用 FIFO lot 配对，属 R3/R4 范围）。
- 未证明 `l2_count` 在**非**零长回合下的取值（`03-test-plan` U1/U2 段）。

## 6. 构造方式的不确定性

1. 字段存在性断言采用**运行时 `Debug` 呈现**（`format!("{:?}", t)` / `format!("{:?}", ev)`）：
   `strategy-core` 无 `serde_json` 依赖（`crates/strategy-core/Cargo.toml` 无 dev-dependencies），
   且**编译期引用不存在的字段是编译错误、不是可判红的断言**（无法给出「断言失败行」）。
   ⇒ 残余风险：若实现方手写 `Debug` 打印假字段而结构体无该字段，本断言会被骗过（概率极低，但如实披露）。
   同理，`l2_count: 2` 的值断言依赖 `Debug` 的 `字段: 值` 形态。
2. 零长回合的构造依赖 `Intrabar` 止损路径与 `avg_cost` 的具体数值（`avg_cost×0.95 = 9.5043 > 9.4`），
   该前置由测试内守卫断言 `trades.len()==1 && open_bar==close_bar==1` 兜住；若未来引擎改为「买入当 bar 不检查止损」，
   本用例会先在**构造守卫**处失败（绿→红形态变化），届时需连同 ADR-027 F5 一起复评。
3. 本用例仅 2 根 bar，`bar1` 之后 `Policy` 仍会挂买单（信号恒 Buy），因 `finish()` 时无持仓故无期末强平；
   这是刻意的（避免二次回合污染「该回合 = 2 笔成交」的判据），但不代表真实运行中零长回合后不会立刻重建仓。

## 7. 纪律声明

- 未修改任何生产代码；未尝试修复失败；未做永久性插桩。失败归因交父级。
