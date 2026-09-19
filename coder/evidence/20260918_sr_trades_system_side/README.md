# 判定「回测系统侧有没有问题」—— sr_1789738328788_000005 只读取证

- 本文件位置：`eestock-rs/coder/evidence/20260918_sr_trades_system_side/README.md`
- 取证时间：2026-09-18（本地 23:36–00:10 / UTC 15:36–16:10）
- 被测 run：`sr_1789738328788_000005`（518880 / D1 / 有效区间 2026-01-04T16:00Z → 2026-09-16T16:00:01Z，
  173 根 in-range bar + 250 根 warmup = 423 根 per_bar；`initial_capital=100000`；
  `fee={rate_pct:0.025, min_fee:5, slippage_bp:2, stamp_duty_pct:0}`；`stop=null`）
- 被测执行策略：`Dca{mode:Equal, tranches:100, interval:1}`，`buy_threshold=60 / sell_threshold=40`
- 被测插件：`sv_1789211089727_000010`（`dca_baseline`，`cadence=20, plan_bars=5`，sha256 `5d7f83df…a0b3`）
- 服务：`127.0.0.1:8081` Web / `127.0.0.1:8082` MCP（只读 GET 探测）；DB `127.0.0.1:5433/eestock`
- **只读纪律**：无 UPDATE/INSERT/DELETE/DDL；未改任何仓库代码；未 `git add`/`commit`
  （`git diff --cached` 为空；`git status` 内唯一被修改的 tracked 文件 `design/01-architecture/adr/ADR-023-…md`
  的 mtime 为 **2026-09-17 13:34**，早于本次取证 22 小时，非本次改动）。

---

## 0. 一句话结论

**回测系统侧没有算错：把「原始 K 线 + 43 笔成交流水 + 费用公式」在系统之外独立搭一遍现金流账，
8 项绩效逐字段复现到 ≤3.3e-16（8/8 完全一致），173 点净值序列逐点误差恰为 0，合成的 TradeDetail 逐字段相同。
问题是**口径**与**可观测性**：期末强平把「策略从未卖出的持仓」对外呈现为 1 个已实现回合；
DCA 的「计划执行度」全程不可观测；年化/回撤/夏普一律按 100,000 初始资金口径，
而本 run 实际只投出 41.61% 资金 ⇒ 对外读出的 -4.24% 年化把风险低估约 2.40 倍。**

判定总表（详见 Y1–Y6；严重度 = 对「使用者能不能正确理解这次回测」的影响）：

| 编号 | 疑点 | 判定 | 严重度 | 归属 |
|---|---|---|---|---|
| **Y1-a** | 8 项绩效「数值算错」 | **不属实**（8/8 逐字段一致，Δ≤3.3e-16） | — | 系统正确 |
| Y1-b | 绩效「定义如此但口径对外不成立」 | 部分属实（年化/回撤/夏普分母，见 Y6） | 中高 | 口径（ADR §6 明文，非实现错） |
| Y1-附 | `profit_factor=+∞` 落 JSON `null` | **属实**（138/377 run） | 低 | 序列化口径缺陷 |
| **Y2-①** | 强平是否计入 metrics（费/滑点/pnl/回合数） | 计入（且与旧 backtest 引擎**逐字同口径**） | — | 设计如此，无问题 |
| Y2-② | ADR 是否规定买入持有/定投该不该强平、该不该单列未实现 | **没有任何规定** | 中 | 治理/口径缺口 |
| Y2-③ | 「策略从未卖出却被记为 1 个已实现回合」的对外误导 | **属实**（TradeDetail 无 `reason`，UI 不区分） | 中高 | 口径缺陷 |
| **Y3** | 末 bar 挂单静默丢弃 | **必然**（引擎结构决定；旧引擎同口径）；无 dropped 计数，但 `per_bar.orders` 保留意图 | 低-中 | 沿继承口径 + 弱可观测性缺口 |
| Y3-附 | 全库 **126/374** run 存在「挂单被静默跳过」（最多单 run 997 条），无事件/无计数/无日志 | **属实** | 中 | 可观测性缺口 |
| **Y4** | DCA 计划执行度（plan_total / batches_done / 取消原因）不可观测 | **属实**（状态 pub(crate)、无 getter、不入结果） | 中 | 可观测性缺口 |
| **Y5-①** | 引擎在双向（有真实卖出信号、多回合）场景是否正常 | 正常（181 个多回合 run；全库三账恒等式 0 违反） | — | 反证：引擎可信 |
| Y5-② | 同参数重跑确定性 | 成立（25 组同参数重复 run：net_value/trades 逐字节唯一、metrics 逐字段相同）；目标 run 精确参数库内唯一，**无法做同参数对照（未完成项，禁写库）** | 低 | 部分未完成 |
| Y5-③ | 结果块与 metrics 不一致的其它 run | 全库 377 run 扫描：`net_profit`/`max_drawdown`/`trade_count` 矛盾 **0 例**；唯一系统性不一致 = `profit_factor=+∞`→`null` | — | 无问题 |
| **Y6** | D1 年化/回撤/夏普的分母口径（未满仓是否失真） | **口径缺陷**（按 100k 全资本；实际投入 41.61% ⇒ 风险低估 2.40x） | 中高 | 口径（ADR §6 明文） |

**归因一句话**：本 run 的账**没有算错**；所有可复现的偏差都来自「口径未随『只投了 41.6%』这件事自适应」
与「系统没有任何层面对外暴露『计划没执行完 / 有挂单没成交 / 这个回合是强平合成的』」。

---

## 1. 复现方式（全部命令见 `commands.sh`）

```bash
cd eestock-rs
bash coder/evidence/20260918_sr_trades_system_side/commands.sh
```

关键产物：
`raw/10_d1_all_bars.txt`（原始 D1 K 线，与 `storage/src/backtest.rs:39-57 range_sql()` 同口径的 accurate∪兜底）、
`raw/04_fills_payload.json`（43 笔成交）、`raw/05_per_bar_payload.json`（423 根 per_bar）、
`raw/06_net_value_payload.json`（173 点净值）、`raw/20_recompute.py` + `raw/21_recompute_output.txt`（Y1 重算）、
`raw/33_all_runs_dump.psv.gz` / `raw/42_all_runs_fill_events.psv.gz`（全库 dump）、`raw/34/40/43/60_*.py`（Y5/Y6 扫描）。

---

## 2. Y1 —— 独立重算 8 项绩效（交付核心）

### 2.1 先读清系统定义（file:line）

| 口径 | 系统定义位置 | 原文要点 |
|---|---|---|
| 入口 | `crates/strategy-core/src/engine.rs:503-509` | `compute_drawdown(&self.nav)` + `compute_metrics(&self.nav, &self.trades, cfg.initial_capital, cfg.period)` |
| NetProfit | `crates/backtest/src/metrics.rs:43-44` | `final_equity − initial_capital`，`final_equity = equity.last()` |
| MaxDrawdown | `crates/backtest/src/metrics.rs:142-152`（+ `130-139` 逐点） | 净值峰谷 `(peak−e)/peak`，含未实现 |
| Sharpe | `crates/backtest/src/metrics.rs:48-72` | `(mean(period_returns) − 0) / std(period_returns, **ddof=1**) × sqrt(bars_per_year)`；`period_returns` = **逐 bar** 净值回报（`windows(2)`）；`rf=0` 硬编码（`:69`） |
| bars_per_year | `crates/backtest/src/types.rs:66-78` | `D1 => 252.0`（M1=252×240、M5=252×48、M15=252×16、M30=252×8、H1=252×4） |
| Annualized | `crates/backtest/src/metrics.rs:104-108` | `(final/initial)^(bars_per_year / n) − 1`，**n = nav 点数（173）**，非 returns 数（172） |
| WinRate | `crates/backtest/src/metrics.rs:74-85` | `盈利平仓笔数 / 平仓笔数`；`trades` 空 → 0.0 |
| ProfitFactor | `crates/backtest/src/metrics.rs:86-102` | `avg_win/avg_loss`；仅盈无亏 → `f64::INFINITY`；仅亏无盈 → 0.0 |
| TradeCount | `crates/backtest/src/metrics.rs:110` | `closed.len()` = **平仓次数**（ADR §6「买+卖对计一次完整交易」） |
| AvgHoldBars | `crates/backtest/src/metrics.rs:111-115` | `Σ hold_bars / 平仓笔数` |
| 平仓定义 | `crates/strategy-core/src/engine.rs:846-861` | `qty ≥ h.qty` 才合成 `TradeDetail`（部分卖出不进 trades，只按比例摊薄成本 `:864-871`） |
| 强平定义 | `crates/strategy-core/src/engine.rs:471-501` | 期末持仓 → `fee.sell(h.qty, bar.close)`，`nav.last = cash`，并合成 1 笔 TradeDetail |

**只有 1 笔时如何退化**：`win_rate = 0/1 = 0.0`（`:81-85`）；`profit_factor`：`wins` 空、`avg_loss>0`
⇒ `0.0/2933.648 = 0.0`（`:96-102`）；`avg_hold_bars = 161/1 = 161`（`:111-115`）。
本 run 这三项**不是退化默认值**，而是公式在该输入下的真实取值（见 2.3）。

### 2.2 独立实现（`raw/20_recompute.py`，不引用任何 Rust 代码路径）

用 4 条独立输入重建账：
1. `10_d1_all_bars.txt`（原库 OHLC）× `05_per_bar_payload.json` 的 423 个 ts；
2. 按 `bar_index` 把 43 笔 fill 挂到对应 bar（决策 bar i → 成交 bar i+1）；
3. 按 ADR §4 文字口径手写费用公式（`max(额×0.025%, 5)`、卖出 `×(1−2bp)`、买 `×(1+2bp)`）；
4. 逐 bar `equity = cash + qty×close`，期末按末 close 强平 → 得自己的 nav 与自己的 TradeDetail。

### 2.3 字段级差值表（**交付核心**）

`raw/21_recompute_output.txt` 原始输出节选 + 全表：

```
[CHK-A] per_bar ts 未在 kline_accurate_1d∪kline_1d 中找到的根数 = 0
[CHK-A] bar 序列首/末 = 1734883200 1789574400  原始表内该区间根数 = 423
[CHK-B1] 42 Buy: fill.price != bar.open*(1+2bp) count = 0
[CHK-B2] 1 ForceClose Sell: fill.price != bar.close*(1-2bp) count = 0 (bar422 open=8.860000 close=8.856000)
[LEDGER] Σ买入成交额 = 41397.972081  Σ买入佣金 = 210.000000  期末现金 = 97066.352086
[LEDGER] 重算期末权益 = 97066.352086028710  系统 net_value[-1] = 97066.352086028710  差 = 0.000e+00
[CHK-C] 173 点净值逐点最大绝对差 = 0.000e+00
```

| field | 独立重算 | system `metrics` | Δ | 判定 |
|---|---:|---:|---:|---|
| `net_profit` | -2933.647913971290 | -2933.647913971290 | **0.000e+00** | 一致 |
| `max_drawdown` | 0.052608136537 | 0.052608136537 | **0.000e+00** | 一致 |
| `sharpe` | -0.802916082394 | -0.802916082394 | **-3.331e-16** | 一致（浮点求和序） |
| `win_rate` | 0.000000000000 | 0.000000000000 | **0.000e+00** | 一致 |
| `profit_factor` | 0.000000000000 | 0.000000000000 | **0.000e+00** | 一致 |
| `annualized_return` | -0.042445133566 | -0.042445133566 | **0.000e+00** | 一致 |
| `trade_count` | 1.000000000000 | 1.000000000000 | **0.000e+00** | 一致 |
| `avg_hold_bars` | 161.000000000000 | 161.000000000000 | **0.000e+00** | 一致 |

支撑中间量（同一脚本输出）：

| 量 | 值 | 说明 |
|---|---|---|
| nav 点数 `n` | 173 | = in-range bar 数 |
| period_returns 数 | 172 | `windows(2)` |
| `mean_period_return` | -1.676335263748e-04 | |
| `std_period_return`(ddof=1) | 3.314293724412e-03 | |
| 零收益 bar 数 | 10 | nav[0..10]，首次成交在 bar 261（决策 260）前的现金空转 |
| Σ买入成交额 / 佣金 | 41,397.972081 / 210.000000 | 42 笔 × 5.0 最低佣金 = 210（最低佣金全额支配） |
| 我的 TradeDetail | open_bar 261→close_bar 422，`open_price`=9.47542039259697，`close_price`=8.8542288，`shares`=4368.985265614662，`commission`=219.67099879139525，`pnl`=-2933.647913971261，`hold_bars`=161 | **与系统 `trades` 逐字段相同** |
| 回撤序列 | `max |my_dd − reported_dd| = 0.0` | 173 点全量 |

### 2.4 Y1 结论

- **a) 数值算错（bug）**：**没有**。8/8 字段、173/173 净值点、1/1 TradeDetail、173/173 回撤点全部可独立复现。
  ⇒ 引擎的现金流/费用/绩效实现**自洽且可被外部独立验证**。
- **b) 定义如此但口径对外不成立（口径缺陷）**：**有 2 处**，都不影响上述数值的正确性：
  1. **分母口径**（Y6）：年化/回撤/夏普全按初始资金 100k，而实际只投 41.61%；
  2. **`annualized_return` 的 n**：用 nav 点数（173）而非 returns 数（172），差 2.414e-04（`-0.04244513` vs `-0.04268656`）。
     ADR §6 原文是「`(期末净值/初始)^(annualize/bar_count)`」，`bar_count` 取 NAV 点数亦属字面合规，属**边界未定义**，量级可忽略。
- **c) 附带发现（序列化口径）**：`profit_factor = f64::INFINITY`（仅盈无亏）经 `serde_json`
  （`crates/application/src/workbench.rs:1850 serde_json::to_value(res.metrics)`）落库为 **JSON `null`**。
  全库命中 **138/377** run（例 `sr_1789183624984_000000`：`win_rate=1.0, trade_count=1, profit_factor=null`）。
  前端 `fmtRatio`（`web/src/features/backtest/format.ts:115-118`）本可渲染 `∞`，但拿到 `null` 只能显示 `—`。
  **不涉本 run**（本 run 是 `0.0`）。严重度：低。

---

## 3. Y2 —— 期末强平（ForceClose）口径

### 3.1 新引擎实现（`crates/strategy-core/src/engine.rs:471-501`）

```rust
471  pub fn finish(mut self) -> EnsembleResult {
472      if let Some(h) = self.holding {
478          let exec = fee.sell(h.qty, bar.close);   // ← 最后 close，含滑点/佣金/印花
479          self.cash += exec.proceeds;
480          if let Some(last) = self.per_bar.last_mut() { last.events.push(EngineEvent::Fill{ … reason: OrderReason::ForceClose }); }
489          apply_sell(&mut self.holding, &mut self.trades, …);   // ← 合成 TradeDetail
498          if let Some(last) = self.nav.last_mut() { last.1 = self.cash; }  // ← 净值末点改为已实现
501      }
```

### 3.2 「沿用 backtest 引擎口径」是否属实 —— 用 git 历史对照（`raw/22_…txt`）

旧内建回测引擎在 P4b 已**物理删除**（`crates/backtest/src/lib.rs:4-8` 注明；退役提交
`b4f09a2 refactor(strategy-system): P4b 旧策略系统物理退役`）。取退役前版本对照：

| 环节 | 旧 `crates/backtest/src/engine.rs`（`git show b4f09a2^`） | 新 `crates/strategy-core/src/engine.rs` | 同口径？ |
|---|---|---|---|
| 期末持仓处理 | `:156-158 if position > 0.0 { let s = fee.sell(position, bars[n-1].close); }` | `:472-478 if let Some(h) = self.holding { let exec = fee.sell(h.qty, bar.close); }` | ✅ 同为**末 bar close** |
| 成交价/费用 | `fee.sell(...)` 同一 `FeeModel` | 同一 `FeeModel`（`engine.rs:31` re-export） | ✅ |
| 合成 TradeDetail | `:162-175`（`close_bar = n−1`，`commission = buy_comm + s.commission`，`pnl = s.proceeds − open.cost`） | `:848-861`（`close_bar = bar_index`，`commission = h.buy_commission + exec.commission`，`pnl = exec.proceeds − h.cost_basis`） | ✅ 同型 |
| 净值末点修正 | `:176-178 if let Some(last) = nav.last_mut() { last.1 = cash; }` | `:498-500` 同 | ✅ |
| 挂单处理 | 期末块**不消费** `pending` | `finish()` **不消费** `self.pending` | ✅（见 Y3） |

⇒ 注释「沿用 backtest 引擎口径」**经历史代码验证成立**，且是**逐处同型**。

### 3.3 三项判定

**① 强平是否计入 metrics？—— 全部计入。**
- 期末权益：`raw/21` 显示强平前按末 close 市值 `97083.761431522551`，强平后 `97066.352086028710`，
  差 **17.409345**（可精确分解 = 滑点 `shares×(close−eff) = 4368.985265614662×0.0017712 = 7.738347`
  + 卖出佣金 `9.670999`；`tv = 4368.985265614662 × 8.8542288 = 38683.99516558099`，`stamp = 0`，`proceeds = 38674.3241667896`）；
  ⇒ `net_profit` **含强平费与滑点**。
- `trade_count=1`、`win_rate=0/1`、`profit_factor=0/2933.65`、`avg_hold_bars=161` **全部由这笔强平TradeDetail 产生**。
- 逐笔核对：全库 `TradeDetail.pnl ≡ gross_value − commission − stamp_duty − open_price×shares`
  恒等式在 **374 个 legacy run 的 4,338 笔 trade 上 0 违反**（`raw/41_ledger_invariants_output.txt` I1），
  故「commission 字段已含买入+卖出两侧佣金」在实现上成立。

**② ADR/design 有没有规定买入持有/定投类策略该不该强平、该不该单列「未实现」？—— 没有。**
- `design/08-backtest/01-engine-adr.md:73`：「**结标的**：回测期末**强制平仓**（最后可用 close）。」→ 强平本身有据。
- `design/12-strategy-system/01-adr.md:100`：「5. 期末强制平仓 + 绩效指标（复用 `backtest::metrics` 8 项）。」
- `design/08-backtest/01-engine-adr.md:110`：「总交易数｜平仓次数（买+卖对计一次完整交易）」→ 强平即「平仓次数 +1」。
- 全文 grep（`raw/51_design_forceclose_grep.txt`）：ADR/design **没有任何**关于
  「买入持有/定投类策略是否应强平」「是否应把未实现盈亏单列」「是否应标注回合来源」的规定；
  `MaxDrawdown` 定义明说「含未实现」（`:105`），说明设计者已知未实现口径的存在，但**未对强平回合的对外呈现提出要求**。
  ⇒ **治理/口径缺口**（严重度 中）。

**③ 是否存在「策略从未卖出却被记为 1 个已实现回合」的对外误导？—— 存在，且三重可复现。**
1. **数据模型缺字段**：`TradeDetail`（`crates/backtest/src/types.rs:102-122`）**没有 `reason` 字段**
   —— `trades` 落库内容为
   `{pnl, shares, open_ts, close_ts, open_bar, close_bar, hold_bars, commission, open_price, stamp_duty, close_price, gross_value}`，
   无法区分 Policy / StopTrigger / ForceClose（本 run 的 `trades` 原文见 `raw/08_trades_raw.json`）。
2. **接口面自相矛盾**：`GET /brief` → `metrics.trade_count = 1`；`GET /fills` → `total = 43`（`raw/50_api_surface.txt`）。
   同一页面上「交易明细」Tab 渲染 `result.trades`（1 行），而 K 线图渲染 `series.fills`（43 个标记）；
   `web/src/features/workbench/ResultView.tsx:65-92` 的列仅有 开仓/平仓/开价/平价/股数/盈亏/持仓，**无来源列**。
3. **全库量级**：374 个 legacy run 中，**171 个 run** 的 `trade_count>0` 但全程**没有任何 Sell 意图成交**
   （Sell Policy / Sell StopTrigger 皆 0），即这些「已实现回合」**100% 由期末强平合成**（`raw/44_reason_scan_output.txt`）；
   全库 TradeDetail 4,338 笔中 **215 笔（5.0%）** 是 `ForceClose` 合成。

⇒ **判定：属实（口径缺陷）**。数值无错、ADR 字面合规，但对外把「从未卖出」呈现为「1 次完整交易 /
胜率 0% / 盈亏比 0」是可复现的误导。严重度 **中高**。
值得记录的是代码自身已意识到 `trades` 不可当流水用：
`crates/application/src/workbench.rs:948-949`
「硬约束：**不得**用 `/curve`（抽样丢真实成交）或 `trades`（仅完全平仓时合成 ⇒ 部分买入/加仓与部分卖出不进 `trades`）代替本端点」
—— 即**后端知道这个坑，前端与指标面却没有对应防护**。

---

## 4. Y3 —— 末 bar 挂单静默丢弃

### 4.1 结构证明：`Pending` 只在「有下一 bar」时被消费

```rust
// crates/strategy-core/src/engine.rs —— 单 bar 管线
532  // 1) 执行上一 bar 挂单（本 bar open 成交）。
534  if !is_warmup {
535      if let Some(p) = self.pending.take() {      // ← 全仓唯一消费点
537          Pending::BuyDelta { qty, reason } => {
538              if qty > 0.0 && self.cash > 0.0 {
542                  let need = qty * fee.buy_price(bar.open) * (1.0 + fee.commission_fraction());
544                  let exec = fee.buy(need.min(self.cash), bar.open);
545                  if exec.shares > 0.0 { … Fill … }
583          Pending::SellQty { qty, reason } => { if let Some(h) = self.holding { … } }
```
而 `finish()`（`:471-501`，见 §3.1）**只处理 `self.holding`，从不读取 `self.pending`**
（`grep -n "pending" crates/strategy-core/src/engine.rs` → 出现处仅 `:362,:401,:535,:738,:772,:782`，`finish()` 区间内 0 处，见 `raw/23`）。
⇒ 最后一根 bar 产生的挂单**没有下一个 bar 去执行，结构上必然被丢弃**。旧引擎（`git show b4f09a2^`）结构相同
（`pending` 仅在 `for i in 0..n` 循环体内消费，期末块只处理 `position`）⇒ **继承口径，非本引擎新引入的 bug**。

### 4.2 本 run 量化：意图 43 vs 成交 42

`raw/64_intent_windows.txt`（由 `per_bar.orders` + `fills` 直接统计）：

```
意图 bar 总数 = 43      窗口数 = 9
  窗口 260..264 (5 根) → 成交于 [261,262,263,264,265]
  窗口 280..284 (5 根) → 成交于 [281,282,283,284,285]
  窗口 300..304 (5 根) → 成交于 [301,302,303,304,305]
  窗口 320..324 (5 根) → 成交于 [321,322,323,324,325]
  窗口 340..344 (5 根) → 成交于 [341,342,343,344,345]
  窗口 360..364 (5 根) → 成交于 [361,362,363,364,365]
  窗口 380..384 (5 根) → 成交于 [381,382,383,384,385]
  窗口 400..404 (5 根) → 成交于 [401,402,403,404,405]
  窗口 420..422 (3 根) → 成交于 [421,422]        ← 末 bar(422) 意图无下家
in-range 信号分布 = {'Hold': 130, 'Buy': 43}
```
另有第 43 个事件：bar 422 的 `ForceClose` Sell（`raw/63_api_last_bar_orders.txt`）——
即 bar 422 同时承载「bar 421 决策的 Buy 成交」与「期末强平」。

### 4.3 可观测性检查

| 检查 | 结果 |
|---|---|
| `grep -rniE "dropped|unfilled|unexecuted|discarded" crates/` | **0 命中**（`raw/23`） |
| engine.rs 内 `pending` 的 6 处出现是否有「丢弃」上报 | **无**（`finish()` 区间 0 处） |
| metrics 8 项是否含「未成交挂单数」 | **无**（`BacktestMetrics` 仅 8 字段，`crates/backtest/src/metrics.rs:22-33`） |
| 日志/tracing 是否有 dropped 事件 | 无（`EngineEvent` 仅 `PluginError/CircuitBreaker/PluginLog/Fill`，`engine.rs:193-223`） |
| 原始意图是否落库 | **是**：`per_bar.orders` 保留 —— `GET /bars?offset=420&limit=3` 可读到末 bar 的 `{side:Buy, qty:110.04391957839198, reason:Policy}` 且该 bar 只有 Buy/ForceClose 两个 fill（`raw/63`） |

⇒ **判定：丢弃本身是「必然/继承口径」（严重度 低）；可观测性为「弱缺口」（低-中）**：
系统不产出任何「有挂单未执行」的派生信号（计数/告警/字段），但**原始意图持久化了**，
客户端可以自行做 `Σorders − (Σfills − ΣForceClose)` 得到 1 —— 等价于「可推导但无提示」。

### 4.4 附带发现（比末 bar 丢弃更值得注意）：**静默跳过未成交挂单**

`engine.rs:538 / 545 / 585-586` 三个静默守卫（`cash ≤ 0`、`exec.shares == 0`、无持仓或 `q ≤ 0`）
会让一个已排定的挂单**无声消失**：不产生 `Fill` 事件、不写日志、不计任何计数。
全库扫描（`raw/48_silent_skip_scan.txt`，口径 `intents > policy_fills + last_bar_orders`）：

```
runs_with_silent_skips = 126 / 374
Top: sr_1789212319758_000045 | 518880 | D1 | intents=999 pfills=1 last_bar=1 → 静默跳过 997 条
     sr_1789211510077_000023 | 518880 | D1 | intents=999 pfills=1 last_bar=1 → 997
```
单 run 最多 **997 条意图被静默跳过**。样例 `sr_1789211239591_000017`（`raw/46/47`）：
现金在前 3 批用尽后，DCA 目标仍每 bar 增长，`orders` 每 bar 产生一条（`{Buy, qty≈8831/69.8}`），
而实际成交仅 3 笔 + 强平 1 笔（`intents=242, fills=4, distinct_intent_qty=6`）。
成因：`engine.rs:573-579` 的「买入被现金上限截断 → 冻结目标下调」补丁**只作用于 LumpSum 的 `lump_frozen`**
（`policy_state.clamp_lump_frozen` → `policy.rs:123-129`），**DCA 分支没有对应钳制**
（`policy.rs:185-198` 只累加 `accumulated_qty`）⇒ 不可达的残差目标被每 bar 重挂。
⇒ **判定：属实（可观测性缺口 + 潜在幽灵挂单），严重度 中。本 run 不受影响**（本 run `43 = 42 + 1`，仅末 bar 丢弃）。

---

## 5. Y4 —— 「计划未执行完」不可观测

| 问题 | 证据（file:line） | 答案 |
|---|---|---|
| `plan_total` / `batches_done` 是否存在 | `crates/strategy-core/src/policy.rs:93-105` `pub(crate) struct DcaState { bars_in_run, batches_done, base_qty, accumulated_qty, plan_total }` | 存在，但**字段全 `pub(crate)`**，结构体本身 `pub(crate)` |
| 是否入结果结构 | `EnsembleResult`（`engine.rs:243-251`）= `{per_bar, trades, net_value, drawdown, metrics}` —— **无 policy 状态**；`BarRecord`（`engine.rs:226-240`）= `{ts, warmup, scores, aggregate, signal, orders, events}` —— **无** | **不入结果** |
| 是否有 getter / 是否可被外部 crate 读 | `PolicyState` 是 `EnsembleSession` 的私有字段（`engine.rs:363`），`Session` 公开方法只有 `new/set_total_hint/bars_seen/records/drain_records/push/push_batch/finish`（`engine.rs:374-518`）；`crates/strategy-core/src/lib.rs:73` 虽 `pub use … PolicyState`，但字段 `pub(crate)` ⇒ 外部 crate **连字段都读不到** | **不可读** |
| 是否入日志 | `EngineEvent` 无 policy 变体（`engine.rs:193-223`）；`grep -rn "policy_state\|PolicyState"` 在 `strategy-core` 之外**0 命中**（`raw/25`） | **不入日志** |
| design 是否有观测要求 | `grep -rn "批次\|tranches\|plan_total\|batches\|执行率\|未成交\|挂单" design/12-strategy-system/ design/08-backtest/` → 仅命中契约描述（`01-adr.md:99,156`、`02-plugin-abi.md:112`），**0 条观测要求**（`raw/65`） | **无要求** |

**本 run 的实际蕴含**（可推但不可见）：`tranches=100`，`interval=1`，每窗 Buy 段 5 根 bar
⇒ 每窗只推进 `batches_done = 1..5`（**5% 的 plan_total**），9 窗累计 43 批（占 100 批的 43%），
每窗开始按当时 `equity` 重新快照 `plan_total`（`policy.rs:176-184`）。
`plan_total` 从未对外出现，`batches_done` 从未对外出现，**「剩余 57 批被 Hold 取消」这件事无任何字段/日志可查**。

⇒ **判定：属实（可观测性缺口），严重度 中。** 使用者只能看 `fills/orders` 反推；
「计划总额 / 已执行批次 / 取消原因」三者对结果页完全不可见。

---

## 6. Y5 —— 对照实验（系统整体是否可信）

### ① 双向场景自洽性 —— 通过

- **多回合样本规模**：374 个 legacy run 中 **181 个** `trade_count > 1`（`raw/35_global_recompute_output.txt`）。
- **三账恒等式全库扫描**（`raw/40_ledger_invariants.py` → `raw/41_…txt`）：

| 恒等式 | 含义 | 违反数 |
|---|---|---|
| **I1** | `TradeDetail.pnl ≡ gross_value − commission − stamp_duty − open_price×shares` | **0 / 4,338 笔** |
| **I2** | `末权益 − 初始资金 ≡ Σ trades.pnl`（引擎每 run 都强平归零，故必须成立） | **0 / 374 run** |
| I3 | `trade_count>0 但 per_bar 无 Sell 意图` | 171 run（**这不是错，是 §3.3③ 的强平合成现象**） |

I2 极强：它把「成交流水账」与「净值账」锁在同一本账上 —— 全库 374 个 run 无一例外。
- **逐字段独立重算**（`raw/34` → `raw/35`，全库 377 run 中 374 个 legacy）：

```
field                max |delta|              worst run
net_profit           0.000e+00
max_drawdown         0.000e+00
sharpe               9.459e-14               sr_1789040967030_000038   （纯浮点求和序）
win_rate             0.000e+00
profit_factor        (仅 inf→null 序列化差异，138 run)
annualized_return    0.000e+00
trade_count          0.000e+00
avg_hold_bars        0.000e+00
```
- **3 个 chunked_v1 run**（含本 run）同样全字段一致（`raw/66_chunked_runs_recompute.txt`）：
  `sr_1789731376244_000003`（64 bar，pf=inf→null）、`sr_1789738272901_000004`（同窗口满仓 LumpSum，净利 -11,563.88620）、
  `sr_1789738328788_000005`（本 run）Δ 全为 0 或 ≤7.8e-16。

⇒ **引擎在双向、多回合、日内(M5/M15)/日线(D1) 场景下账本自洽；「单边只买」不是引擎缺陷，是策略/配置形态。**

### ② 同参数重跑确定性 —— 成立（目标 run 例外，见未完成项）

- 库内 **25 组**（symbol, period, from_ts, to_ts, config 全同）重复 run，逐组核对（`raw/37`、`raw/38_dupcheck_out.txt`）：
  - `count(distinct net_value::text) = 1`、`count(distinct trades::text) = 1`（**逐字节唯一**）；
  - 全部 8 项 metrics **逐字段相同**（脚本打印 `ALL METRICS IDENTICAL: True`，如 8-run 组
    `sr_1789219357879_000001…sr_1789220521987_000001` 的 `net_profit=2245.0116533417313`、`sharpe=2.934011521074989` 全等）。
- **本 run 的精确参数在库内唯一**（`raw/39_same_params_as_target.txt`：`symbol='518880' AND period='D1' AND
  policy={Dca,Equal,interval:1,tranches:100}` → 只回本 run 1 行）。
  ⇒ 按任务书「本轮禁写库」的约束，**无法对目标 run 做同参数重跑对照**，列为未完成项（见 §8）。
  已用「同插件 + 同 DCA 策略族的 4~5 组重复 run」作替代确定性证据。

### ③ 结果块与 metrics 一致性 —— 全库通过（1 处序列化例外）

`raw/32_global_consistency_scan.txt`（SQL 侧）与 `raw/35`（Python 侧）双口径：

| 不变量 | 违反数 |
|---|---|
| `metrics.net_profit == net_value[-1][1] − initial_capital` | **0 / 377** |
| `metrics.max_drawdown == max(drawdown[][1])` | **0 / 377** |
| `metrics.trade_count == len(trades)` | **0 / 377** |
| `metrics` 与「用结果块独立重算」逐字段一致 | 除 `profit_factor=inf→null`(138 run) 与 `sharpe`(≤9.5e-14) 外 **0** |

⇒ **不存在「同一 run 结果块与 metrics 冲突」的其它 run。** 唯一系统性问题是 §2.4-c 的 `∞ → null`。

---

## 7. Y6 —— D1 年化的分母口径（未满仓是否失真）

系统口径（ADR §6 原文 + 实现）：
- `design/08-backtest/01-engine-adr.md:109`：「年化收益 `(期末净值/初始)^(annualize/bar_count) − 1`」
- `crates/backtest/src/metrics.rs:104-108`：`(final_equity / initial_capital)^(bars_per_year/n) − 1`
- `crates/backtest/src/metrics.rs:142-152`：回撤以**全组合净值**为分母
- `crates/backtest/src/metrics.rs:52-72`：夏普用**全组合净值的逐 bar 回报**（空闲现金 ⇒ 0 收益 bar）

实际数字（`raw/61_capital_caliber_output.txt`）：

```
initial_capital                        = 100000.00
Σ买入成交额（不含佣金）                 = 41397.972081  (41.3980% of initial)
Σ买入总成本（含佣金，= 实际动用现金）    = 41607.972081  (41.6080% of initial)
未投入现金                             = 58.3920%

收益率分母对比（同一绝对亏损 -2933.647914）
  分母 = initial 100000（系统口径）: -2.933648%
  分母 = 实际投入 41607.97          : -7.050687%     ← 2.403x
  年化(系统, 分母 initial) = -4.244513%   ← metrics.annualized_return（重算 Δ=0.000e+00）
  年化(分母 实际投入)      = -10.102858%  （差 -5.858344 个百分点）

最大回撤
  峰值净值 = 100691.349482 (nav[18])  谷值净值 = 95394.165221 (nav[116])
  绝对回撤额 = 5297.184262 元
  max_drawdown = 0.052608136537   ← 与 metrics 一致
  分母 = 全组合净值峰值（含 58% 从未投资的现金）⇒ 若以已投入资本为分母 ≈ 12.73%

夏普
  nav 点数 n = 173，returns = 172，零收益 bar = 10（建仓前现金空转）
  rf = 0（metrics.rs:69），ddof = 1（metrics.rs:63）
  夏普(全 172 个收益, 系统)              = -0.802916
  夏普(剔除建仓前 10 个 bar, 162 个收益) = -0.827243

满仓化对照（42 笔买入预算放大 2.4034x 到用满 100k）
  期末净值 = 93257.4822（净利 -6742.5178, -6.7425%）；max_drawdown = 0.123213（系统 0.052608）
  sharpe = -0.722209（系统 -0.802916）

同区间买入持有基准（首 bar open 9.4210 全额买入，末 bar close 8.8560 卖出；标的自身 -6.00%）
  买入持有：净利 -6081.8046（-6.0818%）
  定投 run：净利 -2933.6479（-2.9336%）
  ⇒ 定投少亏 3148.1567 元（3.1482% of initial），主要来自只投了 41.61% 的资金
```

**判定：口径缺陷（b 类），严重度 中高。**
- 数值实现与 ADR §6 字面一致（Δ=0），**不是算错**；
- 但对「未满仓/分批建仓」策略，`net_profit/initial`、`annualized_return`、`max_drawdown`、`sharpe`
  四项**共用初始资金口径**，把 58.39% 从未动用的现金当成风险资产一起平均：
  - 同一亏损 -2,933.65 元，系统读作 **-2.93%（年化 -4.24%）**，投入资本视角是 **-7.05%（年化 -10.10%）**；
  - 回撤 5.26% 在投入资本视角 ≈ **12.73%**，满仓化对照实测 12.32%；
  - ⇒ 对外读出的「年化 -4.24% / 回撤 5.26%」把本策略风险低估约 **2.40 倍**；
- 系统**没有任何字段**暴露「资金投入率 / 平均仓位占比 / deployed capital」
  （`raw/25`、`raw/50_api_surface.txt`：`brief`/`result` 只有 8 项 metrics + net_value/drawdown/trades/per_bar），
  ⇒ 使用者无法自行修正这个口径。

---

## 8. 未完成项与残留风险

| 项 | 状态 | 原因 |
|---|---|---|
| Y5-② 目标 run 的**同参数重跑**（字节级确定性对照） | **未完成** | 库内该精确参数组合唯一（`raw/39`）；任务书禁写库，故未用 `POST /api/workbench/runs` / MCP `bt_run_*` 产生新 run。已用 25 组同参数重复 run（含同插件同 DCA 策略族 4~5 组）作替代证据，且目标 run 的账已由 Y1 逐字段复现（若实现含不确定性，逐位复现概率极低）。 |
| `profit_factor=+∞` 在 API 层的确切表现是否已在 TS 类型上区分 | 未深挖 | 只确认 DB 落 `null` 与 `fmtRatio(null)='—'`；未追 UI 截图。 |
| M30 之外的其它周期年化因子是否与本 run 无关 | 不适用 | 本 run 为 D1。 |
| 4.4 的「幽灵挂单」是否会在**实盘/live** 链路复现 | 未验证 | 本轮只读回测侧；`simlive` 用同一 `strategy-core` 引擎（`crates/application/src/simlive.rs:806` 调 `compute_metrics`），存在同类风险，需另案。 |

---

## 9. 原始产物清单（`raw/`）

| 文件 | 内容 |
|---|---|
| `01_run_meta.txt` … `10_d1_all_bars.txt` | run 元数据 / metrics / bars 分块 / fills / per_bar / net_value / drawdown / trades / 原始 D1 K 线 |
| `20_recompute.py`、`21_recompute_output.txt` | **Y1 独立重算脚本与全量输出（字段级差值表 + 净值/回撤/TradeDetail 对比 + 口径变体 V1–V5）** |
| `22_old_backtest_engine_forceclose.txt` | 退役前旧回测引擎期末强平实现（`git show b4f09a2^`） |
| `23_dropped_pending_grep.txt`、`24_dcastate_observability.txt`、`25_planstate_exposure.txt` | Y3/Y4 grep 证据 |
| `30_…`–`39_…` | 全库清单 / metrics 扁平表 / 一致性扫描 / 全库 dump / 全库重算 / inf→null / 重复 run / 目标参数唯一性 |
| `33_all_runs_dump.psv.gz` / `42_all_runs_fill_events.psv.gz` | 全库 dump（psql `-F$'\x01'` 导出后 gzip；Python 脚本带 `.gz` 透明读取回退） |
| `40_ledger_invariants.py`、`41_…txt` | 三账恒等式 I1/I2/I3 全库扫描（并含 `516380/D1` 33 回合样本逐笔 TradeDetail 与 `Σpnl == 末权益−初始` 校验） |
| `42_all_runs_fill_events.psv.gz`、`43_reason_scan.py`、`44_…txt` | 全库 reason 分类（强平占比 5.0%、171 个「无卖出却有回合」run） |
| `45_last_bar_order_drop_scan.txt`、`46/47_*`、`48_silent_skip_scan.txt` | 末 bar 挂单丢弃 40 例 / 幽灵挂单样本 / 静默跳过 126 run |
| `50_api_surface.txt`、`63_api_last_bar_orders.txt` | 只读 API 面（brief/fills/result/bars） |
| `51/52/53/54/62/65_*` | ADR §6 口径原文、design grep、前端标签与 TradesTable 列、inf 序列化 |
| `60_capital_caliber.py`、`61_capital_caliber_output.txt` | **Y6 资本效率口径量化** |
| `64_intent_windows.txt` | 意图窗口 9 个 / 43 意图 / 42 成交 / 信号分布 |
| `66_chunked_runs_recompute.txt` | 3 个 chunked_v1 run 的全字段重算 |
