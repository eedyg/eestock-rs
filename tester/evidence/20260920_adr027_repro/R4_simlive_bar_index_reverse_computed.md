# R4 证据 — sim-live `bar_index` 由 `ts / bar_sec` 反算（非真实 bar 序号）

- **文件位置**：`tester/evidence/20260920_adr027_repro/R4_simlive_bar_index_reverse_computed.md`
- **判词**：🔴 **红**（4 项缺口全中：`open_bar`/`close_bar` 均为 `ts/60` 的绝对纪元商）
- **批次**：20260920_adr027_repro ｜ **commit**：`0fdd83e` ｜ **时间（UTC）**：2026-09-19T14:45Z
- **被测代码（只读）**：`crates/application/src/simlive.rs:1902-1903`
  ```rust
  let open_bar  = (lot.open_ts / bar_sec) as usize;
  let close_bar = (t.ts / bar_sec) as usize;
  ```
  （`bar_sec = bt_bar_seconds(period)`，`:1841-1858`）
- **契约事实源**：`02-spec.md` §1.1 `bar_index: usize // **真实 bar 序号**（禁 ts/bar_sec 反算）`；
  判据出处：`03-test-plan.md` §1 R4；裁决：`ADR-027` F6、§2.13（「**真实 `bar_index`（禁 ts/bar_sec 反算）**」）

## 1. 可执行命令

```bash
cargo test -p application --test adr027_repro_simlive -- --exact \
  r4_simlive_bar_index_is_not_reverse_computed_from_ts
```

原始输出全文：`tester/evidence/20260920_adr027_repro/raw/r4_simlive_bar_index_is_not_reverse_computed_from_ts.txt`

## 2. 构造（单元级，未启动服务、未接 DB）

同 R3 的手动会话（`period = "M1"` ⇒ `bar_sec = 60`），时钟推进 **1817s**（刻意取**非 bar 边界**：
`(base+1817) % 60 = 17`），买卖两笔成交 ts = `1788400817`，会话起点 ts = `1788400800`。

- 真实 bar 序号（会话内 0-based）= `(1788400817 − 1788400800) / 60 = 30`；
- 现实现产出 = `1788400817 / 60 = 29806680`。

## 3. 原始输出片段（逐字）

```text
running 1 test
test r4_simlive_bar_index_is_not_reverse_computed_from_ts ... FAILED

---- r4_simlive_bar_index_is_not_reverse_computed_from_ts stdout ----

thread 'r4_simlive_bar_index_is_not_reverse_computed_from_ts' (1607762) panicked at crates/application/tests/adr027_repro_simlive.rs:345:5:
R4：sim-live bar_index 必须为真实 bar 序号，实得 4 项不符:
  open_bar 必须 == 真实 bar 序号（会话内 0-based）= 30，实际 29806680
  close_bar 必须 == 真实 bar 序号（会话内 0-based）= 30，实际 29806680
  open_bar 必须**不是** ts/bar_sec 的反算商（02-spec §1.1「禁 ts/bar_sec 反算」），实际 29806680 == 1788400817/60
  close_bar 必须**不是** ts/bar_sec 的反算商，实际 29806680 == 1788400817/60

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s
```

**断言失败的具体行**：`crates/application/tests/adr027_repro_simlive.rs:345`（4 项缺口一次性汇总断言）。
绿侧前置断言（通过）：`open_ts % 60 = 17 ≠ 0`（成交 ts 非 bar 边界对齐）。

## 4. 该结果证明了什么

1. **反算成立（实测）**：`open_bar == close_bar == 1788400817 / 60 = 29806680`——即当 `bar_index` **就是** `ts/bar_sec` 的商
   （而非任何 bar 序号），02-spec §1.1「禁 ts/bar_sec 反算」的禁令被直接违反。
2. **值域失真**：产出值 `≈ 2.98e7`（1970 起的分钟序号），而真实 bar 序号是会话内小整数（本构造 = `30`）。
   ⇒ 任何消费方（L1/L2 展示、`hold_bars` 语义、跳转定位、K 线标记对齐）都无法用该值定位到 bar。
3. 该口径同时污染 `hold_bars`：`hold_bars = close_bar − open_bar`（`:1916`）在本构造中为 `0`（同 ts），
   而真实回合跨越了 `mark_to_market` 的 2000→3000 两个 bar（价格 10→12）；`hold_bars` 的口径不可信
   （本测试未单独断言 `hold_bars`，仅记录该观察，避免超出 R4 判据）。

## 5. 该结果**未**证明什么

- **未定义「真实 bar 序号」在 sim-live 的唯一权威定义**：本测试把契约实现为「会话内 0-based bar 序号
  = `(ts − session_start_ts)/bar_sec`」。若架构裁决采用别的定义（例如「feed 收到的 bar 计数」或
  「行情源 bar 序列索引」），届时**须调整本测试的期望值**（判据形态「== 真实序号」不变，但基准定义需先冻结）。
  这是本证据最大的不确定性，见 §6.1。
- 未证明 `open_bar`/`close_bar` 在**多标的**会话下的错配（本构造单标的）；
- 未证明 sim-live 侧零长回合/部分平仓下的 `bar_index` 行为（本构造单笔全平）；
- 未证明回测侧 `bar_index` 正确（回测侧为数组下标，见 R1/R2 场景中 `open_bar=1/close_bar=1` 的零长构造，与本文无关）。

## 6. 构造方式的不确定性

1. **「真实 bar 序号」基准未冻结**（最重要）：02-spec §1.1 只写「真实 bar 序号（禁 ts/bar_sec 反算）」，
   未定义 sim-live 侧序号的原点（会话起点？feed 首根？行情源 bar 数组下标？）。
   本测试选择「会话起点 0-based」作为**最自然的实现候选**，并把「不得等于 `ts/bar_sec` 商」也作为独立断言
   （该断言不依赖基准选择，只要能证明「就是反算商」即可判红）⇒ **即使基准定义改变，
   「反算」这一判据仍然成立**；只有「== 30」这一项可能需随基准调整。
2. 时钟推进量 1817s 是为让 ts **非 bar 边界**（否则 `ts/60` 与「会话内序号」在小数值域可能巧合接近，
   弱化判据可读性）；`1817 = 30×60 + 17`，真实序号仍是 30。
3. mock 端口同 R3（内存 11 方法）；被证逻辑只依赖内存 `state.trades` 的 ts 与 `period` ⇒ 与存储实现无关。
4. 结算产物经 `serde_json` 序列化后读回（`result.trades`），因此断言的是**落库形态**的 `bar_index`（`usize` → JSON number）。

## 7. 纪律声明

- 未修改任何生产代码；未尝试修复失败；未做永久性插桩。失败归因交父级。
