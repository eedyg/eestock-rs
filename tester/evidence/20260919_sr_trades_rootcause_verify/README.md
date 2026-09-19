# 独立核验（第二轮）：sr_1789738328788_000005「策略侧 vs 系统侧」根因复核

- **本文件位置**：`eestock-rs/tester/evidence/20260919_sr_trades_rootcause_verify/README.md`
  （同目录 `raw/` = 全部原始输出与探针源码，`commands.sh` = 本轮全部只读命令，可复跑）
- **核验人**：Tester Agent（独立于 `coder/evidence/20260918_sr_trades_strategy_side`、
  `coder/evidence/20260918_sr_trades_system_side`、以及同日 `tester/evidence/20260918_sr_trades_verify` 三个上游目录）
- **核验时间**：2026-09-19 00:03–00:35 CST（UTC 2026-09-18 16:03–16:35）
- **被测 run**：`sr_1789738328788_000005`
  （518880 / D1 / effective `[2026-01-04T16:00:00Z, 2026-09-16T16:00:01Z)` = 173 in-range bar + 250 warmup = 423 bar；
  `initial_capital=100000`；`fee={rate_pct:0.025, min_fee:5, slippage_bp:2, stamp_duty_pct:0}`；`stop=null`；
  policy `Dca{mode:Equal, tranches:100, interval:1}`；`buy_threshold=60 / sell_threshold=40`）
- **被测插件**：`sv_1789211089727_000010`（`dca_baseline`，`cadence=20, plan_bars=5`，
  sha256 `5d7f83df79f338e795b11560218d07971941088eca587116240ec14bf19ea0b3`）
- **服务**：`127.0.0.1:8081` Web / `127.0.0.1:8082` MCP（pgrep 实证：PID 2043164，
  `Started Fri Sep 18 18:04:44 2026` ⇒ 两条车道与本人**均未重启服务**）；DB `127.0.0.1:5433/eestock`
- **只读纪律（自检见 §6）**：无 `INSERT/UPDATE/DELETE/DDL`；无 `git add/commit`；未改任何仓库源码/迁移/web 资产；
  两条 Rust 探针工程建在 `/tmp/srprobe`、`/tmp/srprobe2`（**不在仓库内**，源码已存档 `raw/44_*`、`raw/46_*`、`raw/48_*`）。

---

## 0. 一句话裁决

**「策略写错了」不成立（插件实现与外部设计文档 §4.4 逐字一致、且值域穷举证明它没有任何卖出分支——
这是设计红线，不是 bug）；「回测系统算错了」也不成立（我用**真实插件 + 真实配置 + 真实 bar 在仓库引擎里重跑了一遍**，
fills/nav/metrics/trades 全部逐位相同，Δ 全为 0）。**

**真正成立的是三类「口径/披露/可观测性」缺陷（全部有实测数字支撑，均已量化）：**
① 8 项绩效共用「初始资金」分母，而本 run 只投出 **41.6080%** 资金 ⇒ 同一笔亏损 2,933.65 元读出「-2.93%/年化 -4.24%」，
   按实际投入资本读则是「-7.09%/年化 -10.10%」（**2.4156 倍**差），且**全平台没有任何字段/标签披露资金投入率**；
② 期末强平合成的回合在对外数据面**无法区分来源**：`TradeDetail` 无 `reason` 字段，
   全库 **174/359** 个「有已实现回合」的 run 全程**无任何真实卖出**，其中 **132 个**因这笔合成回合读出「胜率 100%」；
③ 末 bar 挂单**结构性丢弃**且无任何观测：全库 **41/377** 个 run 末 bar 仍有挂单；
   另有 **129/377** 个 run 存在**未执行的挂单**（合计 **39,539 条**），无计数、无事件、无日志。

---

## 1. 核验 1（PASS）：独立现金流重算 + 「口径缺陷 vs 实现 bug」的可执行判别

### 1.1 方法与输入（全部是 Tester 自己拉取的原始块）

| 输入 | 来源（Tester 自己的命令） | 文件 |
|---|---|---|
| 43 笔成交流水 | `strategy_run_bars(kind='fills')` 原始 payload | `raw/10_fills_raw.json` |
| 逐 bar 收盘（含 warmup 段） | D1 读源同口径 SQL（`kline_accurate_1d ∪ kline_1d` 反连接剔重），423 根 | `raw/20_d1_bars_union.psv` |
| 系统净值 / trades / metrics / config | 结果块与 `strategy_run` 原样 | `raw/12_..15_*`, `raw/31_target_config.json` |
| 费用契约 | `crates/backtest/src/fee.rs:63-95`（佣金 `max(额×rate, min_fee)`；买 `×(1+2bp)`、卖 `×(1−2bp)`） | 代码原文见 §3 |

重算脚本 `raw/40_independent_recompute.py`（自写，**未参考任何上游脚本**）只做四件事：
按 `fills.bar_index` 落账 → `cash/qtty/cost_basis/value_basis/buy_comm` 递推 → 逐 bar `equity = cash + qty×close` →
期末按末 `close` 强平并改写最后一点净值；`trade` 仅在「卖出量 ≥ 当前持仓」时合成（`engine.rs:846`）。

### 1.2 原始输出（`raw/41_independent_recompute_output.txt`）

```
CHK0  bars(重算取数)=423；per_bar=423；ts 序列完全一致=True
      in-range 下标=[250..422] 共 173 根；warmup=250
      fills.ts == bars[bar_index].ts 违例数 = 0
CHK1  Σ买入成交额 = 41397.972081   Σ买入佣金 = 210.000000
      Σ卖出成交额 = 38683.995166   Σ卖出佣金 = 9.670999   Σ印花税 = 0.000000
      期末现金（重算）= 97066.352086028710   系统 nav[-1] = 97066.352086028710   差 = 0.000e+00
      强平前按末 close 市值 = 97083.761431522551 ⇒ 强平代价 = 17.409345493841
        （分解：滑点 7.738346702 + 卖出佣金 9.670998791 + 印花税 0）
CHK1a 173/173 点，ts 全等=True，逐点最大绝对差 = 0.000e+00（非零点数 0）
CHK1b TradeDetail 12/12 字段 Δ = 0.000e+00
      （open_ts 1768838400 / close_ts 1789574400 / open_bar 261 / close_bar 422 /
        open_price 9.47542039259697 / close_price 8.8542288 / shares 4368.985265614662 /
        gross_value 38683.99516558099 / commission 219.67099879139525 / stamp_duty 0 /
        pnl -2933.647913971261 / hold_bars 161）
```

8 项指标逐字段对比（我按 `metrics.rs` 文档口径实现，**不是**读它的代码）：

| field | Tester 重算 | 库内 metrics | Δ |
|---|---:|---:|---:|
| `net_profit` | -2933.64791397129 | -2933.64791397129 | **0.000e+00** |
| `max_drawdown` | 0.0526081365373775 | 0.0526081365373775 | **0.000e+00** |
| `sharpe` | -0.802916082393964 | -0.802916082393964 | 3.331e-16 |
| `win_rate` | 0 | 0 | **0.000e+00** |
| `profit_factor` | 0 | 0 | **0.000e+00** |
| `annualized_return` | -0.0424451335658026 | -0.0424451335658026 | **0.000e+00** |
| `trade_count` | 1 | 1 | **0.000e+00** |
| `avg_hold_bars` | 161 | 161 | **0.000e+00** |

中间量：`n=173`、`returns=172`、零收益 bar=10、`mean=-1.676335263748258e-04`、
`std(ddof=1)=3.314293724411591e-03`、峰值 nav `100691.3494825`（idx 18）、谷值 `95394.165220791`（idx 116）。

### 1.3 判别判据：这是「口径缺陷」还是「实现 bug」？（三要件全部实测）

**(a) 实现是否等于它自己声明的口径？—— 是（用已知正确的手算案例锁定）**
- 文档口径原文（唯一权威）：`design/08-backtest/01-engine-adr.md:104-109`
  「Net Profit｜期末净值 − 初始资金」「Max Drawdown｜…`(peak−trough)/peak`」「Sharpe｜`(period_returns - rf) / std(period_returns) × sqrt(annualize)`；rf=0」
  「年化收益｜`(期末净值/初始)^(annualize/bar_count) − 1`」「总交易数｜平仓次数」；
  `crates/backtest/src/metrics.rs:1-20` 的 doc-comment 与之逐条同义。
- 我要一个**手算可验**的对照算例，且必须**直接打在实现上**（不是打在测试文件的字面量上）：
  `/tmp/srprobe` 以 path 依赖调用仓库真实函数 `backtest::compute_metrics(nav, trades, initial, D1)`：

```
nav=[100,110,99,108.9]  trades=[+100(hold 3), -50(hold 2)]  initial=100  D1
实现输出：net_profit=8.9  max_drawdown=0.1  sharpe=4.582575694955842
          annualized_return=214.157467903757833  win_rate=0.5  profit_factor=2.0
          trade_count=2  avg_hold_bars=2.5
手算(ADR §6)：net=8.9；maxDD=(110−99)/110=0.1；年化=(108.9/100)^(252/4)−1=214.157467903758
⇒ 实现 == 文档口径的手算值：true                            （raw/45_crate_metrics_probe_out.txt）
```
- 同探针把**库内 nav + 库内 trades 原样喂进实现**（target run 与双向 run 各一次）：
  8 项**全部 Δ = 0.000e0**（含 `sharpe`、`annualized_return`）。
  ⇒ **DB 里的 metrics 就是这个纯函数在同一 nav/trades 上的取值**，不存在"另有一套算法"。

**(b) 独立重算是否复现？—— 是（1.2 全部 Δ≈0；另见 §5-E1 的双向 run 1209 点/40 笔）**

**(c) 同一实现换一种口径，数字会不会变？—— 会（证明我的判据有区分度，不是自证）**
`raw/41_...` CHK3：

| 口径变体 | net_profit | annualized | sharpe | max_dd | trade_count |
|---|---:|---:|---:|---:|---:|
| V0 文档/实现口径（分母 initial、n=nav 点数、ddof=1、平仓计数） | -2933.647914 | **-0.042445134** | -0.802916082 | 0.052608137 | 1 |
| V1 分母换成实际投入资本 41,607.97（收益率=净利/投入再年化） | -2933.647914 | **-0.101028577** | -0.802916082 | 0.052608137 | 1 |
| V2 年化用 returns 数（n−1） | -2933.647914 | **-0.042686564** | — | — | — |
| V3 夏普 ddof=0 | — | — | **-0.805260368** | — | — |
| V4 trade_count=成交笔数 | — | — | — | — | **43** |

**结论（判据化）**：
- 「实现 bug」**不成立**：判据 = 「按 §1.3(a) 的文档口径手算一个已知案例、并把库内 nav/trades 喂进实现」，
  实测 8/8 与 12 字段全 Δ=0，且 crate 自己的黄金样本（`metrics.rs:178-192`）也与手算一致；
  若实现偏离文档口径，这条**立刻变红**（突变实验：trades 少一笔 → `trade_count=1, win_rate=1, pf=+∞`；
  仅盈无亏 → `pf=+∞`；仅亏无盈 → `0`；`nav=[0]` → `net=-100, 年化=-1`，见 `raw/45_*` §4）。
- 「口径缺陷」**成立但仅限"披露/语义"层面**：ADR §6 **明文**规定分母是「初始资金」「bar_count」，
  实现与之一致 ⇒ 不构成"违反规格"；可证伪的部分是**是否披露**：实测
  `/brief` 字段清单（20 个字段）与 `/result`、`ResultView.tsx` 的 8 项表**没有任何** 资金投入率 / 分母口径说明，
  全仓 `grep -rniE "deployed|资金投入率|投入比例|仓位占比|capital_usage|exposure"` = **0 命中**
  （`raw/87_deployment_disclosure.txt`）。若哪天界面或接口补上「投入 41.6% / 分母=初始资金」，
  本条判定即被推翻 —— 这就是它"可证伪"的形式。

---

## 2. 核验 2（PASS，但**推翻上游前提**）：「Equal=按比例 vs FixedAmount=定额」与「对照组名不副实」

### 2.1 设计文档 §4.4 原文（我自己读的外部原件，非上游副本）

> sha256 自核：`9650b020af3639a15bb54f383d7fad55ec070c55c38d81c375742e593b0ba53f`
> （`/home/eestock/workspace/scrylink/eestock/eestock/design/01-dca-strategy-family.md`，
> 与上游副本 `coder/evidence/.../raw/50_design_01_copy.md` **逐字节相同**；见 `raw/57_doc_copy_sha_audit.txt`）

```
### 4.4 `dca_baseline` — 无脑定期定额（对照组，非策略）

barsSinceTrigger = index - floor(index/cadence)*cadence
barsSinceTrigger < plan_bars → 75
其他                          → 50

参数：`cadence=20, plan_bars=5`
作用：**这是判断三个策略是否真有价值的唯一标尺**。没有它，任何收益数字都无法解释。
```
同一文档的 §2.1 与 §5.3（**关键**）：
```
§2.1  DCA Policy 每批金额固定，插件无法改变单批金额。因此「不定额」只能通过两条通道近似表达…
§5.3  - 执行：DCA Policy `{tranches:3, mode:"Equal", interval:5}`。
```
⇒ **文档自己的实验规格就是 `mode:"Equal"`**；全文没有出现 `FixedAmount` 作为要求
（`grep -n "FixedAmount|定额|固定金额|每批金额" 01-*.md 03-*.md` 共命中 **9 处**：
其中 5 处是**名称/标题**（§4.3「定期不定额」、§4.4「无脑定期定额」、§5.4 R1 等）、1 处是契约表里列举枚举
（§1 表 20 行）、1 处是「单批金额不可变」（§7 已知边界）、1 处是作者修订文档的自认（03:61），
**没有一处要求使用 FixedAmount**；唯一的机制声明是 §2.1 那句笼统的「每批金额固定」。见 `raw/56_external_doc_equal_vs_fixed.txt`）。

### 2.2 三方对照（文档原文 vs 代码 vs 实跑）

| 维度 | 文档原文 | 代码（`policy.rs:186-196` 原文） | 本 run 实测 |
|---|---|---|---|
| Equal 语义 | 未定义（只命名 Equal/FixedAmount 枚举，§1 表 20 行） | `DcaMode::Equal => st.plan_total / *tranches as f64`（`plan_total` = 本轮 Buy 起点 equity，`policy.rs:176-184`） | 9 个窗的批额 = **1000.000000 / 1002.277540 / 985.741643 / 994.272243 / 985.224451 / 961.419644 / 959.961477 / 981.657741 / 969.794516** ⇒ 跨窗漂移，**不是定额** |
| FixedAmount 语义 | 同上 | `DcaMode::FixedAmount => amount.expect("validated")`（常数） | 本 run 未使用（`amount:null`） |
| 实验口径 | §5.3 `{tranches:3, mode:"Equal", interval:5}` | 与模式无关 | 本 run `{tranches:100, mode:Equal, interval:1}` ⇒ **偏离作者规格**（不是文档要求定额） |
| 名称 | §4.4 标题「无脑定期定额」/ §5.4 R1「无择时定期定额（主标尺）」 | — | 既非「定期」也非「定额」：见 2.3 |

### 2.3 「对照组名不副实」——成立（有可执行判据支撑）

| 判据（会变红的形式） | 实测 | 结果 |
|---|---|---|
| 若每批金额**跨窗恒定** ⇒ 是 FixedAmount（"定额"名实相符） | 实测跨窗 959.961477 ~ 1002.277540 元（极差 **42.32 元**，相对 1000 元为 **+0.23% / −4.00%**） | 未变红 ⇒ **不是定额** |
| 若平台存在**周期性注资**通道 ⇒ "定期定额"成立 | `grep -rniE "注资|入金|追加资金|cash_injection|deposit|contribution"` 全仓命中仅 3 条**插件参数描述**，无任何资金注入通道 | 未变红 ⇒ **不是定期注资型定投** |
| 若批次节奏是「每 cadence 根投 1 期」 ⇒ "定期"名实相符 | `interval=1` 下每个 20-bar 周期内的买入窗**连续 5 根各投 1 批**（`raw/63_intent_windows.txt`：决策窗 260..264、280..284、…、400..404 各 5 批） | 未变红 ⇒ **节奏也不是"每月一次"** |
| 若计划（`tranches=100`）能投满 ⇒ "对照组"可作标尺 | 173 根 in-range bar 上 Buy 决策 bar 仅 **43** 个 ⇒ 结构上最多推进 **43/100 = 43%**；实际投入 `Σ(成交额+佣金)=41607.972081` = **41.6080%** 初始资金 | 未变红 ⇒ **标尺只覆盖 4 成资金** |

**判定**：上游「S2-③ 文档要求定额而 seed 用 Equal ⇒ 对照基准名不副实」这一条的**前提错误**（其 §5.3 自证用 Equal），
但**结论方向成立**，只是归因应改为：**文档表述（§2.1「每批金额固定」）+ 命名（"定期定额"）+ 本 run 的参数用法
（`tranches=100/interval=1`，偏离作者自己的 §5.3）**，与引擎实现无关。作者的后续修订文档也自认这一点：
`03-dca-policy-semantics-correction.md:61`「`dca_baseline` = 无脑定期定额｜**实际是无择时的梯次建仓**」，
同文档 `:98` 还把「增加周期性注资配置」列为**给平台的建议**（即自认平台没有该能力）。

---

## 3. 核验 3（PASS）：期末强平「沿用 backtest 引擎口径」属实；「合成回合 + 胜率」的误导性有界成立

### 3.1 注释是否属实 —— 用退役前的旧引擎逐处对照（我自己取的 `git show b4f09a2^`）

`git log --diff-filter=D -- crates/backtest/src/engine.rs` → 唯一删除提交 `b4f09a2`（P4b 物理退役）。
旧文件 `crates/backtest/src/engine.rs:157-179`（退役前）原文：

```rust
// 期末强制平仓（用最后 close）
if position > 0.0 {
    let bar = &bars[n - 1];
    let s = fee.sell(position, bar.close);
    let open = open_trade.expect(...);
    let pnl = s.proceeds - open.cost;
    trades.push(TradeDetail { open_ts: open.ts, close_ts: bar.ts, open_bar: open.bar_index,
        close_bar: n - 1, open_price: open.effective_price, close_price: s.effective_price,
        shares: position, gross_value: s.trade_value,
        commission: open.buy_commission + s.commission, stamp_duty: s.stamp_duty,
        pnl, hold_bars: n - 1 - open.bar_index });
    cash += s.proceeds;
    if let Some(last) = nav.last_mut() { last.1 = cash; }      // 净值最后一点修正为已实现净值
}
```

| 环节 | 旧 `backtest::engine`（`b4f09a2^`） | 新 `strategy-core::engine`（`:471-501`） | 同口径？ |
|---|---|---|---|
| 触发条件 | `position > 0.0` | `if let Some(h) = self.holding` | ✅ |
| 成交价/费用 | 末 bar `close` 经同一 `FeeModel` | 末 bar `close` 经同一 `FeeModel` | ✅ |
| TradeDetail 合成 | `close_bar = n−1`、`commission=buy_comm+sell_comm`、`pnl=proceeds−open.cost` | `close_bar = bar_index(=n−1)`、同型 | ✅（新增「多笔加仓 ⇒ 加权有效买价 `value_basis/qty`」的推广） |
| 净值末点改写 | `nav.last_mut().1 = cash` | `if let Some(last) = self.nav.last_mut() { last.1 = self.cash }` | ✅ |
| 期末是否消费 pending | **不消费**（`pending` 仅在循环体内被 `take()`） | **不消费**（`finish()` 区间内 `pending` 0 处出现；`grep -n pending` 仅 `:362,:401,:535,:738,:772,:782`） | ✅ |

⇒ 注释「沿用 backtest 引擎口径」**逐处属实**（不是叙述、是可对照的代码）。
另：口径本身也有据可查 —— `design/08-backtest/01-engine-adr.md:73`「**结标的**：回测期末**强制平仓**（最后可用 close）」、
`design/12-strategy-system/01-adr.md:100`「5. 期末强制平仓 + 绩效指标（复用 backtest::metrics 8 项）」；
**但 design 全文（含两份 ADR）没有任何一条要求"标注强平回合/单列未实现盈亏"**（`raw/86_forceclose_contract_refs.txt`）。

### 3.2 「策略从未卖出却记 1 个已实现回合」是否对外误导 —— 给判据，不给观点

| 判据（可执行；任一为真则判定被推翻） | 实测 | 结论 |
|---|---|---|
| C1：若 `TradeDetail` 含「平仓来源」字段 ⇒ 客户端可自辨 | `crates/backtest/src/types.rs` 的 `TradeDetail` **12 字段全部无 reason/source**；探针 P3 打印 `trades[0]` JSON：`{"open_ts":…,"hold_bars":3}` —— `含 reason 字段 = false` | 判定成立 |
| C2：若 UI「交易明细」表有来源列/口径注 ⇒ 读者不会误读 | `web/src/features/workbench/ResultView.tsx:57-92` 列 = 开仓/平仓/开价/平价/股数/盈亏/持仓，**无来源列**；同文件 8 项表标签为 `net_profit（净盈亏）…trade_count（交易数）`，**无口径注** | 判定成立 |
| C3：若同屏两个口径被显式区分 ⇒ 不构成误导 | `/brief` → `metrics.trade_count=1`；`/fills` → `total=43`；UI 同屏：Tab「交易明细」1 行 + K 线脚注「成交 43 笔（精确源 /fills）」（`KlineResultChart.tsx:80-92`）。两数字**本身不矛盾**（不同口径），但**没有一个字说明前者是"回合口径"** | 判定成立（强度受限，见下） |
| C4：全库量级 | 我独立扫描（`raw/73_global_scan_v2.out` U3/U3b）：**359** 个 run 有已实现回合，其中 **174** 个 run **全程无任何非 ForceClose 的卖出成交**（回合 100% 由强平合成）；这 174 个里 **132 个**读出 `trade_count=1, win_rate=1.0, profit_factor=null`、**42 个**读出 `trade_count=1, win_rate=0, profit_factor=0` | 判定成立 |
| **反判据（限定强度）**：若成交事件流本身带 reason ⇒「系统没有任何途径知道这是强平」为**假** | `web/src/api/types.ts:1033,1041,1123` 明确 `reason: 'Policy'\|'StopTrigger'\|'ForceClose'`；`/fills` 与 `per_bar.events` 均带 `reason`；本 run 末 bar 事件原文 `{"side":"Sell","reason":"ForceClose","bar_index":422}`（`raw/73` U2b） | ⇒ 上游「接口面自相矛盾」的措辞**过强**；准确表述是：**reason 只在成交事件流里，`trades`/8 项绩效/默认 Tab 这条读径上不可见** |

---

## 4. 核验 4（PASS）：末 bar 挂单丢弃 + 「系统无任何观测」，附**可执行反证**

### 4.1 代码路径（我自己 grep + 读）

- 全仓唯一消费挂单的点：`engine.rs:535`（`if let Some(p) = self.pending.take()`）位于**每 bar 管线内**；
  `finish()`（`:471-501`）只处理 `self.holding`，**从不读 `self.pending`**。
- ⇒ 最后一根 bar 生成的挂单**结构上必然被丢弃**（没有"下一根 bar"去执行它）。
- 观测面：`BacktestMetrics` 只有 8 字段（`metrics.rs:22-33`）；`EngineEvent` 只有
  `PluginError/CircuitBreaker/PluginLog/Fill`（`engine.rs:193-223`）——**没有 dropped/unfilled 变体**。

### 4.2 可执行反证 1：最小示例探针（`/tmp/srprobe2`，mock 运行时，纯确定性）

```
P1 末 bar 挂单被静默丢弃：  bars=5 全 Buy(75)，Dca{tranches:10, Equal, interval:1}
    per_bar.orders 意图总数 = 5（逐 bar 都是 Buy）
    fills = [bar1 Buy, bar2 Buy, bar3 Buy, bar4 Buy, bar4 Sell(ForceClose)]
    非强平成交 = 4 ；意图 − 非强平成交 = 1（= 最后一根的挂单）
    metrics JSON 里有没有 dropped/pending/unfilled = false
P2 挂单被静默跳过（exec.shares==0 分支）：bars=10 全 Buy，initial=100 元，tranches=1000
    意图总数 = 10 ；fills = [] ；事件总数 = 0 ；nav 末点 = 100.000000000
    ⇒ 10 条挂单全部静默消失（无 Fill / 无事件 / 无计数 / 无日志）
P3 双向最小示例：分数=[75,75,75,20,20,50]
    fills = [bar1 Buy, bar2 Buy, bar3 Buy, bar4 Sell(Policy)] ；trades=1 ；ForceClose 笔数=0
    trades[0] JSON 无 reason 字段 ；Σpnl == nav[-1]−initial（Δ=0.000e0）
```

### 4.3 可执行反证 2：**真插件 + 真 bar 在仓库引擎里重跑**（`/tmp/srprobe2 --bin p5_real`）

```
bars 输入 = 423 ; per_bar = 423 (warmup 250)
fills = 43 (Buy 42 / Sell 1) ；意图 orders 总数 = 43 ；意图 − 非强平成交 = 1
末 bar(index 422) 的 orders = [("Buy", 110.04391957839198, "Policy")]
末 bar 的 events = ["Fill Buy qty=108.906439 Policy", "Fill Sell qty=4368.985266 ForceClose"]
nav 点数 = 173 ; nav 末点 = 97066.352086028710 ; trades 笔数 = 1
vs 库内 net_value：173/173，逐点最大绝对差 = 0.000e0
vs 库内 fills：43/43，逐笔 qty 最大绝对差 = 0.000e0
vs 库内 metrics：net_profit Δ=0  max_drawdown Δ=0  sharpe Δ=0  annualized Δ=0  trade_count Δ=0
vs 库内 trades：1/1；pnl Δ=0；shares Δ=0；commission Δ=0
```
**这是本轮最强的一条证据**：用库内插件字节 + run 配置 + 原始 D1 bar，在仓库引擎里**不写库**重跑，
得到与库内**逐位相同**的结果；同时**亲眼看到**末 bar 的 `Buy 110.0439` 挂单无对应成交（该 bar 的 Buy 成交
`108.906439` 是**上一根 bar（421）决策**的产物，`qty` 与 `110.0439` 不同 ⇒ 不能按 bar 配对来"证明它成交了"）。

### 4.4 全库量级（我自己的 SQL 口径，第二版修正后）

| 指标 | 我的实测 | 说明 |
|---|---:|---|
| run 总数 | 377 | `strategy_run` 全部 `succeeded` |
| 完全执行（意图=Policy 成交） | **248** | |
| 有未执行挂单 | **129** | 累计未执行 **39,539** 条 |
| 负差（意图 < Policy 成交） | **0** | 修正口径后无假阳性（v1 用"全部 fill"配对时出现 90 个假阳性，已废弃，见 `raw/71_global_scan.out`） |
| 末 bar 仍有挂单 | **41** | 其中 Policy Buy **41**、Sell 0 |
| 目标 run | 意图 43 / Policy 成交 42 / 未执行 **1**（= 末 bar） | |

> 口径陷阱（我自己踩过并修正）：`orders` 只能与 `reason='Policy'` 的 Fill 配对 ——
> `ForceClose`（finish）与 Intrabar 止损的成交**不经过 orders**；用"全部 fill"配对会得到 90 个"负差"假阳性。
> 这一条也解释了为什么"按 bar 有无同侧成交"来判断末 bar 丢弃会**漏掉目标 run**（其末 bar 恰有一笔上一根决策的 Buy 成交）。

---

## 5. 反证实验总表（硬要求：每条主要判定 → 会让它变红的判据 → 实测）

| 侧 | 判定 | 「变红」判据（可执行） | 实测 | 结果 |
|---|---|---|---|---|
| 策略 | P-a 插件实现 == 设计文档 §4.4 | 库内 code sha256 ≠ run config 里声明的 slot sha256，或 per_bar 逐根 aggregate/signal 与公式不符 | sha256 `5d7f83df…` **三方一致**（库内 code / run config / 作者工作区源文件）；423/423 根 aggregate 与 signal 全等；`(i%20<5) ≡ (aggregate==75)` 423/423 成立 | **未变红（判定成立）** |
| 策略 | P-b 结构性单边（无卖出分支） | 参数全域穷举出现任一 ≤40 的返回 | `cadence×plan_bars = 30000 组合 × idx 0..1000 = 30,030,000 样本` → 值域 **`[50,75]`**；非有限 0；越界 0 | **未变红（成立）** |
| 策略 | P-c 文档**要求**定额（上游前提） | 文档出现 `FixedAmount`/`amount` 明文要求 | §5.3 明文 `mode:"Equal"`；全文无 FixedAmount 要求；作者修订文档 :61 自认"实际是梯次建仓" | **变红 ⇒ 上游该前提不成立** |
| 策略 | P-d Equal=按比例 / FixedAmount=定额 | 若 FixedAmount(1000) 重演更贴近实测 ⇒ 红 | Equal 重演 9 窗批额预测 Δ ≤ **1.592e-12**；FixedAmount 预测 |qty−1000/close| ≤ **4.728**；FixedAmount 重演净利 **-2929.144771** ≠ 实测 **-2933.647914** | **未变红（成立）** |
| 系统 | Y-a 8 项数值无算错 | 独立重算任一字段/任一点不符 | 目标 run 8/8 字段 Δ=0、173/173 净值 Δ=0、12/12 TradeDetail 字段 Δ=0；双向 run 1209/1209 Δ=0、40/40 笔 12 字段 Δ=0 | **未变红（成立）** |
| 系统 | Y-b metrics 定义 == 实现 | 文档口径手算的已知案例与实现不符 | 手算 vs `compute_metrics`：net 8.9 / maxDD 0.1 / 年化 214.157467903758 / sharpe 4.582575694956 / pf 2.0 / holds 2.5 **全部一致**；口径变异 V2/V3 立刻改变数值 | **未变红（成立）** |
| 系统 | Y-c 双向 run 三方自洽（trades⇄fills⇄metrics） | 任一账不符 | `sr_1789044295239_000111`（40 Buy + 40 Sell 全 Policy）：nav 1209/1209 Δ=0；trades 40 笔逐字段 Δ=0；metrics 8/8 Δ=0；`Σtrades.pnl == nav[-1]−initial`（Δ=0）；回撤 1209 点 Δ=0；Rule C（每笔成交=一条）→ **RED** 证明判据有区分度 | **未变红（成立）** |
| 系统 | Y-d 期末强平沿用旧引擎口径 | 旧块与新 `finish()` 在成交价/费用/TradeDetail/nav 末点/pending 任一环节不同 | `git show b4f09a2^` 原文逐处同型（§3.1 表） | **未变红（成立）** |
| 系统 | Y-e 末 bar 挂单必然丢弃 | 最小示例中末 bar 挂单被执行 | P1：意图 5 − 非强平成交 4 = 1；P5 真插件重跑：意图 43 − 42 = 1；全库 41 个 run 末 bar 有挂单 | **未变红（成立）** |
| 系统 | Y-f 丢弃/跳过无任何观测 | 结果结构或事件流里有 dropped 计数/告警 | metrics 8 字段无；`EngineEvent` 无该变体；P1 打印 `有无 dropped 字段 = false`；P2 显示 10 条挂单静默消失（events 空） | **未变红（成立）** |
| 系统 | Y-g 唯一系统性不一致是 `pf=+∞→JSON null` | 其他字段也存在"结果块 ⇄ metrics"冲突 | 全库 377 run 四类不变量（净利/回撤/回合数/Σpnl）**违反 0**；`profit_factor` 落 `null` **138** run | **未变红（成立）** |
| 系统 | Y-h 未满仓 ⇒ 年化/回撤分母口径失真且未披露 | 接口/界面暴露资金投入率或口径注 | `/brief` 20 字段、`/result`、8 项表**均无**；全仓 grep `deployed/资金投入率/...` 0 命中；实际投入 41.6080% | **未变红（成立）** |
| 系统 | Y-i 合成回合对外不可辨（误导） | `TradeDetail` 或 UI 有来源标识 | 12 字段无 reason；TradesTable 7 列无来源；全库 174/359 个"全合成回合"run，132 个读出胜率 100% | **未变红（成立）** |
| 系统 | Y-j 「系统没有任何途径知道这是强平」 | 成交事件流带 reason | `types.ts:1033` + `/fills` + `per_bar.events` **都带** `reason='ForceClose'` | **变红 ⇒ 上游措辞过强，须限定为"trades/绩效/默认 Tab 读径不可见"** |

---

## 6. 越界审计（两条车道 + 本人）

| 检查 | 方法（本轮新增） | 结果 |
|---|---|---|
| 改过仓库？ | `git status --porcelain` / `git diff --stat` / `git diff --cached` | tracked 修改**只有** `design/01-architecture/adr/ADR-023-…md`，mtime **2026-09-17 13:34:38**（比两条车道开始早 ~34h）；无 staged；两车道目录均为 `??` 新目录 ⇒ **未见越界改动**（`raw/99_overreach_git.txt`） |
| 改过库？ | **用 `xmin` 事务号**：`strategy_run/_result/_bars/strategy_version` 四表 `max(xmin::text::bigint)` | 四表最大值分别 = **16042826 / 16042826 / 16042825 / 1712088**，而 16042822–16042826 正是**目标 run 自己那条 INSERT**（`created_at 13:32:08.788Z`）⇒ 该时刻之后**这四张表没有任何行被写入**（`raw/99_overreach_db2.txt`） |
| 建过新 run？ | `select count(*) from strategy_run where created_at > 2026-09-18 13:30Z` | **2**，分别是 `…000004`（13:31:12Z）与目标 run（13:32:08Z）——**都在两条车道开工（23:35 CST = 15:35Z）之前** |
| 重启过服务？ | `ps -eo pid,lstart,etime,cmd` + 应用日志 mtime | app PID 2043164 `Started Fri Sep 18 18:04:44 2026`（连续运行 6h06m）；Postgres `pg_postmaster_start_time = 2026-09-18 04:16:21Z`；应用日志 `logs/app_dev_8081_redeploy_20260918_180445.log` 末条 = 13:32:08.809Z（目标 run 的 `p4b.run_summary`），**mtime 21:32 CST** ⇒ 车道窗口内没有新 run、没有重启 |
| 凭「文档历史叙述」当实测？ | 逐条看两车道的判据类型 + 我对文档原文的独立复核 | ① 两车道引用的设计文档**不在本仓库**（`git ls-files | grep dca-strategy-family` = 0）；其只读副本 sha256 = 外部原件 sha256（**副本可信**）。② 它们的多数结论有实测（sha 复核、30M 样本穷举、逐 bar 相位、纸面引擎、全库扫描）——属实测。③ **但 strategy_side 的 S2-③ 把外部文档 §2.1 的措辞当成"文档要求定额"，是纯叙述推断且推断错误**（§5.3 自证用 Equal）—— 本条已由我 red 掉（§2.2/§5 P-c）。④ system_side 的 Y2 末尾"接口面自相矛盾"亦属**未加限定的叙述**（reason 在成交事件流里存在，见 §5 Y-j） |

---

## 7. 残留不确定性（诚实清单）

1. **未做同参数新 run**（禁写库）：无法做"目标 run 的字节级确定性重跑"。
   替代证据是本轮 **P5**：用同一插件字节/配置/bar 在仓库引擎里重跑，fills/nav/metrics/trades **逐位相同**（Δ=0），
   等价覆盖"计算确定性"，但**未覆盖** web 提交路径、分块落库路径与并发。
2. **上游 174 vs 171 的口径差**：我按「非 ForceClose 的 Sell 成交 = 0」，上游按「Sell 意图 = 0」。
   两者方向一致、数值不同（我的更保守），引用时须注明口径。
3. **我未逐 run 归因"未执行挂单"的成因**（`cash≤0` / `exec.shares==0` / 末 bar 三种），
   只给了两端的探针（P1 末 bar、P2 shares==0）与全库总量（129 run / 39,539 条）。
4. **`serde_json` 默认 float 解析的 1-ULP 陷阱（我自己踩到）**：以默认 feature 解析库内 JSON 后做逐位比对，
   会看到 `net_profit` 约 **1.455e-11** 的"假不一致"；改用 `features=["float_roundtrip"]` 后 Δ 全为 0。
   任何"逐位复核"脚本都必须注意这一点，否则会误判为 bug。
5. **外部文档不在仓库**：`design/01-dca-strategy-family.md` 只存在于 `/home/eestock/workspace/scrylink/…`（root 所有）。
   我的 §2 判定绑定其 sha256 `9650b020…`；若作者后续修改文档，结论需按新 sha 复核。
6. **未覆盖 simlive/实盘链路**：本轮只读回测侧；"策略从不卖出 + 期末强平"在 sim-live 的对外呈现未验。
7. **`to_ts` 的 1 秒语义已独立核实**：D1 可得区间上界 `max(ts)=2026-09-16T16:00:00Z`，
   `to_ts = max(ts)+1s`（`crates/storage/src/backtest.rs:152-163`，半开区间约定）⇒ 173 根是**当时的全部可用 bar**，
   末 bar 丢弃不是"数据被截"造成（`raw/21_d1_available_range.txt`）。

---

## 8. 最终裁决建议（对用户的两个方向）

### 方向一：「策略写错了」—— **不成立**（作为代码/契约错误）

- **最小可证伪依据**：库内 `code` 的 sha256 = run config 声明的 sha256 = 作者源文件 sha256
  （`5d7f83df79f338e795b11560218d07971941088eca587116240ec14bf19ea0b3`）；
  30,030,000 样本穷举值域 = `{50,75}`，**不含任何 ≤ sell_threshold(40) 的取值**；
  423/423 根 per_bar 与公式逐根一致。→ 只要上述任一条不成立，本文判定即被推翻。
- **策略侧成立的次级问题（性质是命名/文档/配置，不是实现 bug）**：
  「对照组名不副实」（跨窗批额漂移 959.96~1002.28 元、无周期注资通道、节奏是"每 20 根里连续 5 根各投 1 批"、
  计划在 173 根上只能完成 43/100 批、只投出 41.6080% 资金）；
  且本 run 的 `{tranches:100, interval:1}` **偏离作者自己 §5.3 的 `{tranches:3, interval:5}`**。
  → 可执行的固定方式：把这套 run 的参数改到作者规格（或把区间拉长到能让 `tranches` 投满），
   并把插件/DCA 族的命名从"定期定额"改为"无择时梯次建仓"。**无需改任何引擎代码。**

### 方向二：「回测系统有问题」—— **分两层，结论相反**

- **数值层：不成立（系统没算错）**。
  最小可证伪依据：同一插件字节 + 同一配置 + 同一 423 根 bar，在仓库引擎里重跑 ⇒
  `fills 43/43 qty Δ=0`、`net_value 173/173 Δ=0`、`metrics 8/8 Δ=0`、`TradeDetail 12/12 Δ=0`；
  另有 1209 点的双向 run 同样 Δ=0，且 `Σtrades.pnl == nav[-1]−initial`。
  → 只要任一次重跑出现非零 Δ，本文该判定即被推翻。
- **口径/披露/可观测性层：成立（3 条，均已量化）**。
  1. **未满仓时绩效分母不披露**：投入 41.6080% ⇒ 年化 -4.24% vs 按投入口径 -10.10%（**2.4156×**）；
     `/brief`、`/result`、8 项表、全仓代码均无 `deployed/资金投入率` 字段。
     *最小可证伪*：给结果页/接口加一个"资金投入率/口径说明"字段，本条即被推翻（因为届时至少不是"未披露"）。
  2. **强平合成回合不可辨**：`TradeDetail` 无 `reason`；全库 174/359 个 run 的回合 100% 来自强平，132 个读出"胜率 100%"。
     *最小可证伪*：给 `TradeDetail` 加来源字段（或给"交易明细"列加来源/给 8 项表加口径注），本条即被推翻。
     *注意*：成交事件流（`/fills`、`per_bar.events`）**已带** `reason='ForceClose'`，所以正确措辞是
     "trades/绩效/默认 Tab 读径不可见"，**不是**"系统没有任何途径知道"。
  3. **末 bar 挂单丢弃 + 未执行挂单无观测**：41/377 run 末 bar 有挂单；129/377 run 有未执行挂单（39,539 条），
     无计数/无事件/无字段/无日志。
     *最小可证伪*：结果里出现「未执行挂单数」或事件流出现相应事件，本条即被推翻。

### 如果只允许改一处（系统侧）

给 `EnsembleResult`/结果页补一个**执行完整度**派生块（不改引擎语义、不改策略、不改数据）：
`policy_capacity = {planned_tranches, reachable_batches(=ΣBuy 决策 bar), batches_done, unexecuted_orders,
last_bar_unfilled, deployed_capital, deployed_pct}`，并在 `deployed_pct < 1` 或 `unexecuted_orders > 0` 时给
**非阻断警告**。它一次性覆盖上面 3 条缺口里的 ①③，并把 ② 的"误导"降到"读者可自查"。

---

## 9. 证据文件清单（本目录）

| 文件 | 内容 |
|---|---|
| `commands.sh` | 本轮全部只读命令（可复跑；含探针复建说明） |
| `raw/01–07_*` | 表结构 / 目标 run 行 / 结果形状 / 分块形状（psql 原始输出） |
| `raw/10–15_*` | 目标 run 原始块：fills(43) / per_bar(423) / net_value(173) / drawdown(173) / trades(1) / metrics |
| `raw/20_d1_bars_union.psv`、`raw/21_d1_available_range.txt` | D1 原始 OHLC（423 根，读源同口径 SQL）与可得区间 |
| `raw/31_target_config.json` | run config（fee/initial/policy/thresholds/warmup/clamped） |
| `raw/40_*.py`、`raw/41_*.txt` | **独立现金流重算 + 8 项指标逐字段对比 + 口径变异 V0–V4** |
| `raw/44_*.rs.txt`、`raw/45_*.txt` | **Rust 探针**：直接调用 `backtest::compute_metrics`（手算对照算例 / 库内 nav+trades / 输入突变） |
| `raw/46_*.rs.txt`、`raw/47_*.txt` | **引擎最小示例探针**：末 bar 丢弃 / 静默跳过 / 双向 + `TradeDetail` 无 reason |
| `raw/48_*.rs.txt`、`raw/49_*.txt` | **真插件 + 真 bar 全链路重跑**（P5，结果与库内逐位相同） |
| `raw/50_sv_code.exact.txt`、`raw/51_*.js`、`raw/52_*.txt` | 库内插件原始字节（sha256 自核）与 30,030,000 样本值域穷举 |
| `raw/55–57_*` | Equal/FixedAmount 代码原文、外部文档原文摘录、外部副本 sha256 审计 |
| `raw/60_*.py`、`raw/61_*.txt`、`raw/63_*.txt` | **全链路重演**（插件→信号→Dca→订单→费用→净值→强平→metrics）+ Equal/FixedAmount 判别 + 意图窗 |
| `raw/70/72_*.sql`、`raw/71/73_*.out` | 全库扫描（v1 与修正版 v2：意图×成交、末 bar、合成回合、metrics 不变量） |
| `raw/80–87_*` | API 面（brief/fills/curve/result 原始响应）、design 强平要求、口径披露 grep |
| `raw/90_*`、`raw/95–98_*` | 双向 run 候选与 **三方自洽核验**（nav/trades/metrics/恒等式/定义突变） |
| `raw/99_overreach_*` | 越界审计（git / DB `xmin` / 进程启动 / 应用日志） |

---

## 10. 角色报告（Tester 交付字段）

- **本文件位置**：`eestock-rs/tester/evidence/20260919_sr_trades_rootcause_verify/README.md`
- **What changed**：**零代码改动、零库写**。仅**新增**本证据目录（`README.md` + `commands.sh` + `raw/` 61 个文件）。
  两条 Rust 探针工程在 `/tmp`（仓库外），源码已存档。
- **Architecture alignment**：不适用（只读核验任务）；证据落点沿用 `tester/evidence/<date>_<topic>/` 约定。
- **Test coverage**：不新增/不修改仓库测试；未跑仓库测试套件（避免构建写入）；改为仓库外探针直调库函数与引擎 API。
- **Verification（本轮自证）**：
  - 目标 run：fills 43/43 qty Δ=0、nav 173/173 Δ=0、metrics 8/8 Δ=0、TradeDetail 12/12 Δ=0（Python 与 Rust 两套独立实现）；
  - 双向 run：nav 1209/1209 Δ=0、trades 40/40 逐字段 Δ=0、metrics 8/8 Δ=0；
  - 全库：377 run ×（净利/回撤/回合数/Σpnl）四类不变量 **0 违反**；
  - 判据可失败性：Rule C / FixedAmount / 输入突变 / 口径变异全部**实测变红**，证明不是自证；
  - 只读纪律：`git diff --cached` 空、四表 `max(xmin)` = 目标 run 的 INSERT 事务号、服务进程未重启。
- **未完成项**：见 §7（同参数新 run 未做、未逐 run 归因未执行挂单成因、simlive 未验）。
