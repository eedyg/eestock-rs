# R1 证据 — 部分卖出下 `TradeDetail.pnl` ≠ 该回合真实已实现盈亏

- **文件位置**：`tester/evidence/20260920_adr027_repro/R1_partial_sell_pnl.md`
- **判词**：🔴 **红**（复现成立 → ADR-027 §1.2「未取证项」取证结论：推断成立）
- **批次**：20260920_adr027_repro
- **commit**：`0fdd83e`（工作区含本批次新增测试文件，未提交）
- **时间（UTC）**：2026-09-19T14:45Z
- **被测代码（只读，未修改）**：`crates/strategy-core/src/engine.rs`
  - `apply_sell` 部分卖出分支（` :896-901`）：只按比例摊薄 `cost_basis/value_basis/buy_commission`，**不产任何台账记录**；
  - 清仓分支（`:877-892`）：`pnl = exec.proceeds − h.cost_basis`（只含末笔卖出的净得 − 摊薄后剩余成本）。
- **契约事实源**：`design/17-trade-detail-layering/02-spec.md` §1.2/§2（`pnl = proceeds − invested`，全回合口径）；
  判据出处：`03-test-plan.md` §1 R1；裁决：`ADR-027` §1.1 F1/F2/F4、§2.2 D1。

## 1. 可执行命令

```bash
cargo test -p strategy-core --test adr027_repro -- --exact \
  r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl
```

测试文件：`crates/strategy-core/tests/adr027_repro.rs`（本批次新增，测试用例名 = 函数名）。
原始输出全文：`tester/evidence/20260920_adr027_repro/raw/r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl.txt`

## 2. 构造（可复现的确定性场景）

- 引擎：`run_ensemble`（纯逻辑，无 IO/DB/时钟），1 个 inline JS 插件（按 `ctx.index` 脚本化评分）：
  `index 0` 与 `4..=5` → 80（Buy 区）；`>=6` → 20（Sell 区）；其余 50（Hold）。
- 价序（open=high=low=close）：`10, 10, 10, 10, 12, 12, 11, 11`；`initial_capital = 100_000`；
  `ExecutionPolicy::LumpSum { position_pct: 0.5 }`；`FeeModel::default()`（0.025% / 最低 5 / 印花 0.05% / 滑点 2bp）；`Period::D1`；`warmup_bars: 0`。
- 成交序列（由引擎实际产出，测试内断言锁定，见原始输出前的构造守卫）：
  1. `bar1` open 买 **5000.0 股** @ 10.002（`trade_value=50010`、`commission=12.5025`、`total_cost=50022.5025`）；
  2. `bar5` open **部分卖 417.60427083333343 股** @ 11.9976（持有 5000 → 4582.395729166667）；
  3. `bar7` open **清仓 4582.395729166667 股** @ 10.9978。
  期末空仓（无期末强平）⇒ `nav[-1] = 现金 = 初始资金 + 真实已实现盈亏`。

## 3. 原始输出片段（逐字）

```text
running 1 test
test r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl ... FAILED

---- r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl stdout ----

thread 'r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl' (1604693) panicked at crates/strategy-core/tests/adr027_repro.rs:184:5:
R1：TradeDetail.pnl 必须 == 该回合真实已实现盈亏（= nav[-1] − initial_capital；02-spec §2 全回合口径 Σ sell proceeds − Σ buy total_cost）: 期望 5338.715921666619，实际 4513.894182770709（Δ = -824.8217388959092，容差 0.000000001）

failures:
    r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

**断言失败的具体行**：`crates/strategy-core/tests/adr027_repro.rs:184`（`assert_close` 带 `#[track_caller]`，行号指向调用点）。

## 4. 该结果证明了什么

1. **红成立且非空洞**：同一用例内的构造守卫全部通过后才到达红断言——
   `fills.len() == 3`（买 1 / 卖 2）、`0 < 部分卖 417.604… < 买 5000.0`、`Σ卖 == Σ买`（回合闭合）、`trades.len() == 1`。
2. **现口径 `pnl` 少算 824.82 元**：真实已实现盈亏 `5338.715921666619`（= `nav[-1] − 100_000`），
   `TradeDetail.pnl = 4513.894182770709`，**Δ = −824.8217388959092**，远超 1e-9 容差。
3. 该 Δ 与 `apply_sell` 的代码路径一致：`Γ = proceeds(部分卖) − ratio × buy_total_cost`
   （`= 5002.744 − (417.604…/5000) × 50022.5025 ≈ 824.82`）——即**部分卖出那一段的已实现盈亏完全不在任何 trade 内**
   （ADR-027 §1.1 F1 的代码路径推断被实测证实）。
4. 因此 ADR-027 §1.2 的「未取证项」由本测试取证：**F1+F2+F4 组合下 `TradeDetail.pnl` 不等于该回合真实已实现盈亏**。

## 5. 该结果**未**证明什么

- 未证明绩效指标（`win_rate`/`profit_factor`/`avg_hold_bars`/`trade_count`）的具体偏移量——本用例只取证 `pnl` 字段本身；
- 未证明 sim-live 侧同类缺陷（R3/R4 另有取证）；
- 未证明真实运行（HTTP/MCP/DB 落库后）的 `/result` 数值——策略层单测不触存储与端点；
- 未覆盖「多批 DCA 加仓 + 多次部分卖出」形态（属 `03-test-plan` U 段，本批次不做）。

## 6. 构造方式的不确定性（重要）

1. **字面构造 `买 100 股@10 / 部分卖 50 股@12 / 清仓 50 股@11` 经公开引擎 API 不可达**——
   这是实测得出的约束，不是取舍偏好：
   - `FeeModel::buy(budget, price)` 的入参是**预算**而非股数（`crates/backtest/src/fee.rs:70`），
     默认 `min_commission = 5.0` 时代理分支 `value = budget − 5.0`（F10，`:90-98`）；
   - 引擎的买入预算 = `target_qty × buy_price(open) × (1+佣金率)`（`engine.rs:551-556`），
     且**只有** `pct ≈ 1` 时预算才会被现金上限截断；
   - 而 `pct = 1` 时 LumpSum 重快照目标 = `(cash + qty×close)/close = qty + cash/close ≥ qty`，
     **永不产生 `delta < 0`** ⇒ 无部分卖出。⇒「精确 100 股买入」与「部分卖出」在本政策类下互斥。
   - 部分卖出的**唯一**可达路径（ADR-027 F4）是「Buy → Hold（解冻）→ Buy（重快照，快照价更高）→ 目标 < 持仓」。
2. 故本批次采用**同形态、量级不同**的构造（买 5000 / 部分卖 417.6 / 清 4582.4），
   血证的是「L1 只覆盖末笔卖出」这一**口径事实**，与具体股数无关；
   判决量（Δ 的符号与数量级）由 `assert_close` 直接给出，不依赖字面股数。
3. 红断言的**真值**取 `nav[-1] − initial_capital`（期末空仓 ⇒ 现金即已实现口径），
   与 02-spec §2 的 `Σ sell proceeds − Σ buy total_cost` 等价，**未**在测试内复算引擎内部费用；
   ⇒ 该真值不依赖测试对引擎内部实现的复刻（避免 oracle 与实现同构）。
4. 测试文件对本用例的**唯一**非公开接口依赖是 inline JS 插件源码字符串（ABI 合法输入），无新增 fixture 文件、无生产代码改动。

## 7. 纪律声明

- 未修改任何生产代码（`crates/**/src/**` 零改动）；未尝试修复失败；未做永久性插桩。
- 本报告由 tester 产出，失败分析/归因结论交父级（Architecture Lead）处理。
