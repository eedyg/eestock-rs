# S2/S3 代码引用（逐条 file:line，原文摘录）

## 1. Equal 与 FixedAmount 的语义差（crates/strategy-core/src/policy.rs）

```
policy.rs:12-20
/// DCA 分批金额模式。
pub enum DcaMode {
    /// 等额分批：计划总额 / N。计划总额 = 买入信号重新出现时（新一轮建仓起点）的账户净值。
    Equal,
    /// 固定金额分批：每批 `amount` 元。
    FixedAmount,
}

policy.rs:29-41（Dca 变体文档）
/// 分批建仓（定投式）。Buy 信号**持续**期间每 `interval` bar 执行一批；
/// 信号中断 → 剩余批次取消；Buy 信号重新出现 → 重新开始计数（重新规划总额/批次）；
/// Sell 信号 → 一次性清仓（目标 0）。

policy.rs:174-186（Buy / 新一轮起点快照）
if self.dca.is_none() {
    self.dca = Some(DcaState {
        bars_in_run: 0, batches_done: 0, base_qty: current_qty,
        accumulated_qty: 0.0,
        plan_total: equity,            // ← 计划总额 = **本轮起点净值**
    });
}

policy.rs:188-196（批次触发与每批金额）
if st.bars_in_run % k == 0 && st.batches_done < *tranches {
    let batch_amount = match mode {
        DcaMode::Equal => st.plan_total / *tranches as f64,   // ← 净值比例，不是定额
        DcaMode::FixedAmount => amount.expect("validated"),    // ← 绝对值，才是「定额」
    };
    st.accumulated_qty += batch_amount / price;
```

⇒ **Equal = 每批 = 本轮起点净值/N（等比）**；**FixedAmount = 每批固定 amount（定额）**。
设计文档 §4.4 自称「无脑定期定额」，本 run 选的是 `Equal` ⇒ 名义口径与执行口径不一致。

对照平台自己的 ADR（design/12-strategy-system/01-adr.md:99）：
> `Dca{tranches: N, mode: equal|fixed_amount, amount?, interval?: k（默认 1）}`：buy 信号持续期间分 N 批建仓
> （每 k bar 一批；**Equal 计划总额 = 本轮 Buy 起点净值快照**；信号中断 → 剩余批次取消，Buy 重现重新计数）

⇒ 平台语义是**如实文档化**的（Equal 就是净值比例），没有「本应是定额却实现成等比」这种实现缺陷。

## 2. 本 run 每批金额实测（raw/34_batch_amount_exact.txt）

- `Equal` + `tranches=100` ⇒ batch = 窗起点净值/100。
- 第 1 窗（决策 bar 260，全现金）：挂单 qty 99.94003597841295 × 决策 close 10.0060 = **1000.000000 元**
  ⇒ plan_total = 100,000（初始资金）。
- 其余 8 个窗（每个 Buy run 重启都会**重新快照**净值）：959.96 / 969.79 / 981.66 / 985.22 / 985.74 / 994.27 / 1002.28 元
  ⇒ implied plan_total = **95,996 ~ 100,228 元**。
- ⇒ 每批**不是固定金额**，而是「该窗起点净值的 1%」；同一批计划内各批金额还会因 min_fee 补差而微调
  （首窗第 2..5 批 ≈1004.78 元 = 1000 + 上一批被 min_fee 少投的 5 元补差，见 raw/34_batch_amount_exact.txt）。

## 3. 最低佣金主宰小批次（费用侧连带发现）

```
crates/backtest/src/fee.rs:65-67
pub fn commission(&self, trade_value: f64) -> f64 {
    (trade_value * self.commission_fraction()).max(self.min_commission)   // max(额×0.025%, 5)
}
crates/backtest/src/fee.rs:71-95
pub fn buy(&self, budget, raw) -> ... {
    // 佣金触及最低时：value = budget − min_fee，shares = value/eff_price
}
crates/strategy-core/src/engine.rs:542-545
let need = qty * fee.buy_price(bar.open) * (1.0 + fee.commission_fraction());
let exec = fee.buy(need.min(self.cash), bar.open);
```
实测佐证（DB：strategy_run_result.trades[0].commission，raw/33_trades_pretty.json）：
`commission = 219.67099879139525` = 42 × 5（买入最低佣金）+ 9.671（卖出佣金）
⇒ 每笔 ~1000 元批次付 5 元佣金 = **0.5%/批**，是名义费率 0.025% 的 **20 倍**；
买入佣金合计 210 元，占投入 41,398 元的 0.507%（若 tranches=3，单批 3.3 万 → 佣金走 0.025% 档，约 8.3 元）。
