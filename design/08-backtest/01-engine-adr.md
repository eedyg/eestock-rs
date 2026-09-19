# 08-backtest / 01 — 回测引擎设计 + ADR（Wave 3，预实施）

> 状态：**待批复**（有 n 个需用户拍板的决策点，见 §8）。
> 依据：`06-web/05-backtest.md`（Grill P5 定稿，UI/交互权威）；本文件定义**引擎/口径/存储/任务制**。
> 参考：TradingView Strategy Tester / Freqtrade UI（**不参考 histview**）。
> 语言：eestock-rs 全 Rust。引擎为独立 `backtest` crate（应用层可复用），不 tangle（逻辑手写）；REST/WS 接口归 web crate。

---

## 1. 目标与非目标

**目标**：对指定 code + 周期(kline 历史) 运行内置策略，产出：净值/回撤序列、8 项绩效指标、交易明细、月/周收益热力输入；支持参数网格→并发任务组；异步任务制（WS 进度）；多任务 compare。

**非目标**（本期不做）：智能寻优（不做调参器）；接入实时/信号推送；T+0 与 T+1 撮合的完整交易所规则（用简化的次日/当日成交假设，见 §4）；K线区间留买留卖之外的复杂仓位管理（仅支持全仓/按资金比例，见 §4）。

## 2. 架构分层

> ⚠️ **P4b 退役注记**（12-strategy-system D16 终章）：§7 服务链（`BacktestService` / 内置策略 /
> `/api/backtest` 端点）与本 § 分层图中的应用服务链已于 P4b 退役删除；**§1-§6 口径对保留件
> （fee/indicators/metrics/types）继续有效**。回测能力由 12-strategy-system ensemble 引擎 + 回测工作台全覆盖。

```
web crate (REST/WS)  →  application 层: BacktestService (任务队列/调度)
                              ↓ 端口(port)  ← backtest crate (纯逻辑引擎, 无 IO)
                              ↓ 端口(port)  → storage crate (kline 读取 + 结果持久化)
```

- **backtest crate（纯逻辑）**：策略 trait、7 款内置策略、组合/持仓/订单/费用/滑点模型、事件驱动 bar 循环、指标计算、净值/回撤序列。**无 IO、无 DB**——可单测锁定。
- **application 层 BacktestService**：任务队列（Tokio）、并发、进度上报（经 WS 事件端口）、调用 backtest 引擎、读写 storage。
- **domain::ports**：新增 `BacktestBarRead`(已读期K线；Wave 3 Phase 3a 定名，替代初拟 BarSourceRead)、`BacktestRunStore`(写 runs/results)、`BacktestProgressSink`(WS 进度)。

## 3. 数据源与周期口径

- **数据源**：统一读源（ADR-003/用户 2026-09-04）= `kline_accurate` 优先 + cagg 兜底（kline_merged 口径）。回测取 `code` + 目标周期在区间 `[from, to)` 的 bar 序列（升序）。
- **周期**：1m / 5m / 15m / 1h / 日（UI 提供）。M1 直读 accurate；高周期读 `kline_accurate_<P>` 优先 + cagg 兜底。
  > I-6/D3（2026-09-12 用户批准）：补 **H1**——数据层已有 `kline_accurate_1h` cagg + 15m rollup 兜底，
  > 引擎 `backtest::Period` 与试算/工作台 `parse_period` 同步纳入，消除「`get_kline` 支持 1h 但回测拒绝 H1」的双口径；
  > 区间上限档 H1 归日线档（≤5 年，小时线量级远低于分钟级）。
- **日期区间**：由 UI 传 `from,to`（或默认 = kline 全历史）；引擎按 bar 时间推进，交易日历不强制（回测用真实 kline 已采集数据，天然含缺口）。
- **价格**：用 close 作为占位/成交价（简化）；open/high/low 仅策略指标用（如突破用 high）。成交按 ⚠️ 见 §8 决策（滑点／是否用 open 成交）。

## 4. 组合/订单/费用/滑点模型（简化，非完整交易所撮合）

- **初始资金**：默认 100_000（可传，UI 暂固定）。
- **仓位**：单标的、单方向（多头）；支持 全仓 / 按资金比例（`position_pct` 参数，默认 100%）。
- **成交假设**：信号在 bar close 判定，**下一 bar open 成交**（或 close 成交——见 §8 决策）。滑点以 `slippage_bp` 计入成交价（买：价×(1+bp)；卖：价×(1−bp)）。
- **费用**：`commission_rate_pct`（万级），每笔**最低费用** `min_commission`（元）；卖出加**印花税**（A 股卖出 0.05%）。具体默认值见 §8（05-backtest 标注「与旧系统口径一致但数值待裁决」）。
  > **I-3/D6 印花税口径（2026-09-12 用户批准，v1.1 修订）**：旧缺省 `stamp_duty_pct=0.05` 是 **A 股股票口径兼容值**；
  > **ETF/LOF 印花税不征**——ADR-019（D11）后，**省略 fee 或 UI 三键 fee（无 stamp）均经档案字段级回退**得到 0（调用方无需知道该属性）；
  > 要显式复现旧股票口径须传 `stamp_duty_pct:0.05`。
  > 试算（`strategy_test_run`）与工作台（`bt_run_ensemble`）均回显**生效** fee（含 stamp_duty_pct 实际取值），
  > 使「缺省被多收」在结果里可见。标的类型元数据（symbols 表/Registry 增 type）另立 D11，不在本批。
  >
  > **D11 费率口径（ADR-019，2026-09-12 落地；本节为费率事实唯一出口）**：调用方**省略** `fee` 时按
  > 标的 `symbols.type` 查 `fee_profiles`（迁移 0025）解析（`source="profile"`）；**显式传 `fee` 对象按字段优先级**（ADR-019 **v1.1 修订 R-2**）：
  > **出现的字段**以其值（并校验）为准，**缺失字段逐字段回退档案**，档案缺失再回退旧默认；`source` 取本次解析
  > **最高优先级来源**（任一字段来自显式 → `"explicit"`；否则 profile → `"profile"`；否则 `"default"`，R-3——**不等于**"所有字段均来自该类"）。
  > 关键后果：UI 三键 fee（`rate_pct`/`min_fee`/`slippage_bp`，**无 stamp**）+ ETF 档案 → stamp 回退为 **0**
  > （v1.0 旧行为"对象存在=整体显式、缺 stamp 取 0.05"已于 v1.1 废止）；复现旧口径须显式传 `stamp_duty_pct:0.05`。
  > 费率事实：
  > - **ETF/LOF**（场内基金二级市场买卖）：印花税**不征**→0（《印花税法》第三条列举式定义仅含股票/存托凭证，
  >   属"不征"而非"免征"）；过户费**免收**→0（中国结算：ETF/LOF 二级市场买卖免收）；经手费事实值 0.04‰（双边，
  >   深交所 2026-01）与证管费（交易所收费表仅列 A股/B股/优先股）**按平台全佣口径已含于佣金 → 列 0，不得叠加**；
  > - **A股股票**（当前无此标的，为将来注册预留）：印花税卖出单边 0.5‰（2023-08-28 减半）、过户费 0.01‰ 双边、
  >   经手费 0.0341‰ 双边、证管费 0.02‰ 双边；佣金同 ETF（万2.5 双向、最低 5 元、全佣口径）；
  > - **引擎消费范围**：`FeeModel` 仍为 4 参数（佣金/最低/印花税/滑点；滑点非费率事实，取 ADR bt-1 默认 2bp）；
  >   档案中的经手费/证管费/过户费为**事实/口径列，本批未建模**（**D11-follow-up 债务**：注册个股或需规费精度时
  >   须扩展 FeeModel = 经手费/证管费/过户费双边 + 印花税仅卖出侧）。
  > 响应回显**显式两段**：`fee.effective`（引擎**实际应用**参数 commission_rate_pct/min_fee/stamp_duty_pct/slippage_bp + `source`=explicit|profile|default）与 `fee.profile`（解析到档案时的**全量事实**，含经手费/证管费/过户费 + `not_modeled` 显式清单）；`fee.symbol_type` 回显解析到的标的类型。**未参与撮合的档案字段不得出现在 effective 段**——`not_modeled` 由档案字段集与 `FeeModel` 消费字段集派生（非硬编码字符串），避免规费被误读为「已计入成本」（D11 验收 013 §11.3）。
  > **钉住 config 保持扁平（v1.1 R-1）**：两段结构（`effective`/`profile`）**仅用于试算/回测的响应回显**；
  > `strategy_run.config.fee` 与工作台预设仍为扁平 `fee_model_to_json` 形态（`{rate_pct,min_fee,slippage_bp,stamp_duty_pct}`，含 stamp 实际取值），以保前端读取与预设往返向后兼容。
- **持仓**：bar 循环中维护 `position`（数量/成本/开仓bar）；无持仓时只算净值=现金；有持仓时净值=现金+持仓×close。
- **结标的**：回测期末**强制平仓**（最后可用 close）。
- **禁止**：保证金/做空/杠杆；分红/除权不复权（用不复权 K 线，回测区间内除权导致跳空——接受为简化，见 §8 决策）。

## 5. 策略框架（事件驱动）

```rust
pub trait Strategy: Send + Sync {
    fn id(&self) -> &str;
    fn params_schema(&self) -> Vec<ParamDef>;           // 驱动 UI 参数表单（schema）
    fn on_bar(&mut self, ctx: &mut Ctx, bar: &Bar, indicators: &Indicators) -> Signal;
}
```
- `Indicators`：每 bar 计算常用指标（MA/EMA/RSI/MACD/KDJ/BOLL/ATR），按需。
- `Signal`：`Hold | Buy(fraction) | Sell`。单 bar 一信号。
- 每 bar：先算指标 → `on_bar` → 按信号挂单 → bar 内成交判定（见 §4）→ 更新组合/净值。

**首批 7 款经典策略**（编译期注册，非页面配置；`builtinStrategyCount: 7`）：
1. 双均线交叉（MA fast/slow）。
2. 均线+RSI 过滤（MA + RSI 超买超卖）。
3. MACD 金叉/死叉。
4. BOLL 带突破（上轨买/下轨卖或均值回归，二选一）。
5. KDJ 金叉/死叉。
6. 动量突破（N 日新高突破 high）。
7. ATR 通道突破（Donchian/ATR 止损）。

> 每个策略的参数以 schema 暴露（如 fast/slow/period/threshold），网格「起:止:步长」即对这些数值参数展开。

## 6. 指标口径（**单测锁定**，定义于本 ADR）

| 指标 | 口径 |
|---|---|
| Net Profit | 期末净值 − 初始资金（元；+绝对） |
| Max Drawdown | 净值曲线峰谷最大回撤百分比（`(peak−trough)/peak`，含未实现） |
| Sharpe | `(period_returns - rf) / std(period_returns) × sqrt(annualize)`；rf=0（见 §8），period = 回测 bar 周期，annualize = 按周期折算年化（如 1m/日线不同，见 §8） |
| 胜率 | 盈利平仓笔数 / 总平仓笔数 |
| 盈亏比 | 平均盈利 / 平均亏损（绝对额） |
| 年化收益 | `(期末净值/初始)^(annualize/bar_count) − 1` |
| 总交易数 | 平仓次数（买+卖对计一次完整交易） |
| 平均持仓周期 | 平均开仓到平仓的 bar 数（×周期换算为天/时） |

> 全部用**精确小数/整数**计算并在单元测试锁死（黄金样本：手工小序列）。

## 7. 异步任务制 + REST/WS 契约

> ⚠️ **P4b 退役注记**（12-strategy-system D16 终章）：本节服务链（`BacktestService` / 内置策略 /
> `/api/backtest` 端点）已于 P4b 退役删除，保留仅为历史记录；§1-§6 口径对保留件
> （fee/indicators/metrics/types）继续有效。

- **提交** `POST /api/backtest/runs`：body = `{code, period, from, to, strategy_id, params:{...} 或 params_grid:{k:"起:止:步长"}, fee:{rate_pct,min_fee,slippage_bp}}`。若为网格 → 展开为 N 个子任务。返回 `run_id`（或任务组 `group_id`）。
- **进度** `GET /api/backtest/runs`（列表：状态 pending/running/done/failed、进度%、当前回测日期）；`GET /api/backtest/runs/{id}`（净值+指标+交易）；`GET /api/backtest/compare?ids=`；`GET /api/backtest/strategies`（策略清单+schema）。
- **WS `{type:"backtest_progress", run_id, pct, bar_ts}`**：复用现有 WS 通道分发。
- **存储**：`backtest_runs`(id, code, period, strategy_id, params_json, fee_json, status, progress, created_at, finished_at, error) + `backtest_results`(run_id, net_value_json, trades_json, metrics_json)。迁移 `0011`。
- **并发**：任务组内子任务并发（`tokio` + `JoinSet`，上限 `max_concurrent_backtests`，默认 4，防 DB/资源过载）；单 run 中间结果不落库（完成才写），但进度实时经 WS。

## 8. ⚠️ 待用户拍板的决策点（不批准不实施）

| # | 决策 | 我的推荐 | 备选 |
|---|---|---|---|
| D-bt-1 | **手续费/滑点默认值**（05-backtest 「与旧系统口径一致但数值待裁决」） | 佣金 0.025%（万2.5）最低 5 元；卖印花税 0.05%；滑点 2bp | 佣金 0.01% 最低 5 元；0 滑点 |
| D-bt-1（D11 修订） | **缺省费率改为按标的类型推断**（ADR-019；v1.1 字段级） | 省略 fee → 查 `fee_profiles`（etf/lof 印花税 0+过户费 0；stock 0.05）；显式对象**按字段优先级**（出现字段优先，缺失字段逐字段回退档案→旧默认）；`type` 未知 → 上表旧默认 | 保持全局固定默认（已否决：对 100% ETF 标的系统性多收印花税） |
| D-bt-2 | **成交时点** | bar close 判信号 → **下一 bar open 成交**（避免前视） | close 成交 |
| D-bt-3 | **年化因子 / Sharpe 基准** | Sharpe rf=0，年化因子按周期：日线 √252、1m √(252×240) 等；年化收益用 bar 数换算 | 统一 √252 |
| D-bt-4 | **复权** | 用不复权 K 线，接受除权跳空 | 前复权 |
| D-bt-5 | **7 款策略名单** | 见 §5（双均线/均线RSI/MACD/BOLL/KDJ/动量/ATR） | 你指定 |
| D-bt-6 | **引擎落位** | 独立 `backtest` crate（纯逻辑、单测） | 并入 domain |

---

## 9. 测试纪律（用户强调：必须可复现）

回测/量化相关测试必须**完全可复现/确定性**：
- 测试数据用**手工构造的固定 bar 序列**（明确 open/high/low/close/ts 值），**不查实时 DB、不依赖当前市场数据、不依赖环境变量/时间**；
- 策略参数**显式固定**；无 RNG（若策略本身用随机，则固定种子）；无日期衰减（除非策略用时间则固定输入）；
- 黄金样本**逐点断言精确值**（净值序列/8 指标/trade 明细/费用/滑点）；
- `cargo test -p backtest` **任意次运行结果完全一致**；
- 每个测试注明数据来源=固定构造序列、无随机/无时间依赖。

**批复后**：先落引擎 crate + 指标单测（黄金样本）→ 策略 → storage 迁移 0011 + domain 端口 → web 端点 + WS → 前端页面组件(RegionPortal 挂入 BacktestGrid) → E2E。全程 TDD、ADR-007 设计源同步、测试可复现。

---

## 10. 结果载荷 v2 引擎口径注（ADR-027 批次，2026-09-20 落地）

> 本节为 ADR-027「交易明细分层显示（L1 回合 / L2 逐笔）」在**引擎侧**的口径事实源回写；
> 契约权威以 `design/17-trade-detail-layering/02-spec.md` 与 `design/01-architecture/adr/ADR-027-*.md` 为准，
> 本节只固化**已落地**的口径。落地清单与验收索引见 `design/17-trade-detail-layering/05-status.md`；
> 实现证据 `coder/evidence/20260920_adr027_p1a_types_aggregation/`、`.../p1b_engine/`，独立验收 `tester/evidence/20260920_adr027_accept*/`。
>
> **本节的 §1–§9 仍有历史价值**：§1–§6 的口径（fee/indicators/metrics/types）对保留件继续有效；§7 服务链与 §5 内建 7 策略已于 P4b 退役（见 §2/§7 退役注记）。

### 10.1 `TradeDetail` = 回合（Round Trip）v2：**全回合口径**（ADR-027 D1/D2/D5）

`backtest::TradeDetail` **原地升级为 v2**（`crates/backtest/src/types.rs`）。它不再表示「清仓那一笔」，而是
**一个持仓回合**（持仓 `0→>0` 起、`→0` 止的连续成交区间）。字段与口径：

| 字段 | 口径 |
|---|---|
| `rt_seq: u32` | 回合序号（per `(run\|session, code)` 从 1 单调递增）——L1/L2 归属键 |
| `code: String` | 标的（回测 = run 的 symbol；sim-live = 会话内标的），同时是聚合的分组键 |
| `status` | `Closed` \| `Open` |
| `open_ts` / `close_ts?` | 回合首笔买入 ts / 终结（清仓）ts；`Open` ⇒ `None` |
| `open_bar` / `close_bar?` | **真实 bar 序号**（**禁** `ts / bar_sec` 反算）；`Open` ⇒ `None` |
| `shares` | Σ 买入 qty（`Closed` 时 == Σ 卖出 qty） |
| `buy_count` / `sell_count` / `l2_count` | 买/卖笔数、本回合成交总笔数（D8 懒加载摘要） |
| `open_price` | 加权**有效买价（不含费）** = Σ_buy `trade_value` / Σ_buy qty |
| `close_price?` | 加权**有效卖价（不含费）**；**无任何卖出 ⇒ `None`（禁止造 0）**；部分卖出（`Open` 态）⇒ `Some(该加权价)` |
| `gross_value` | Σ 卖出 `trade_value` |
| `commission` | Σ 买入佣金 + Σ 卖出佣金 |
| `stamp_duty` | Σ 卖出印花税（买入恒 0） |
| `pnl?` | `Closed` ⇒ `Some(proceeds − invested)`；`Open` ⇒ `None`（**禁止造数**） |
| `hold_bars?` | `close_bar − open_bar`；`Open` ⇒ `None` |
| `reason?` | 清仓那一笔的来源（`ForceClose`/`StopTrigger`/`Policy`）；`Open` ⇒ `None` |

**全回合现金流口径（唯一，02-spec §2）**：

```
invested = Σ_buy (trade_value + commission)               // 买入总成本（含佣金）
proceeds = Σ_sell (trade_value − commission − stamp_duty)  // 卖出净得
pnl      = proceeds − invested                             // 整回合现金流差
```

- `pnl` 是**整回合现金流差**（**含**部分卖出的已实现部分），**不需要**对部分卖出做成本摊薄或 FIFO 归属；
  原「部分卖出分支只摊薄、已实现部分不进账本」（F1/F2）的缺陷被口径本身消掉。
- **`Open` 回合禁止造数**：`pnl`/`hold_bars`/`close_*`/`reason` 恒 `None`，不给出未定义语义的盈亏；未实现部分由持仓视图承担。
- **费用三件套 = 撮合点事实**：`commission`/`stamp_duty`/`trade_value` 必须来自引擎实算（`FeeModel::buy/sell` 返回值），
  **禁止**由 `(side, qty, price)` + fee 配置复算（最低佣金分支 `trade_value = budget − 5.0` 先减后除，复算不保证逐位相等，ADR-027 F10/D4）。
- **绩效口径收紧（ADR-027 D7）**：`backtest::compute_metrics` 只吃 `status == Closed` 的回合进入 `win_rate`/`profit_factor`/`trade_count`/`avg_hold_bars`；
  `Open` **不造 0 计入**。`net_profit`/`max_drawdown`/`sharpe` 仍源自 nav，不受本批口径变更影响。
- **无旧语义兼容**：ADR-027 D3 已清空历史，v2 新字段**不提供** `serde(default)` 兼容（v1 形状必须被拒，`application::audit` 有锁定测试）。

### 10.2 `rt_seq` 归属键 = `backtest::assign_rt_seq`（**唯一实现**，ADR-027 D6）

- **归属只由 `rt_seq` 决定**：**禁止**用 `[open_bar, close_bar]` 窗口推断（零长回合 `open_bar == close_bar` 是合法且必须正确归属的形态）。
- **唯一序号实现**：`pub fn assign_rt_seq(fills: &mut [FillFact])`（`crates/backtest/src/round_trip.rs`），规则 = 买入且当时无持仓 ⇒ 新序号；持仓中的任何成交 ⇒ 当前序号；卖出使持仓归零 ⇒ 终结当前序号。
  引擎**在线**分配（逐笔 `RtSeqAssigner`）与 sim-live **回放**分配**必须**调用本函数/同一规则体（禁止各自实现）。
- **唯一聚合实现**：`pub fn aggregate_round_trips(fills: &[FillFact]) -> Vec<TradeDetail>`（只按 `(code, rt_seq)` 分组求和，**不重编号**）。
  回测引擎、审计端点、sim-live 结算与运行中读**全部**调用本函数 ⇒ 全系统无第二处回合聚合（DRY 硬约束，02-spec §1.3）。
- **类型归属（架构裁决）**：`OrderSide`/`FillReason` 唯一定义在 `backtest`；`strategy-core` 以 `pub use backtest::OrderSide;` 再导出（消费方路径零改动，serde 形状 `"Buy"/"Sell"` 逐字节不变）。
- 回测期末强平（`ForceClose`）终结最后一个回合 ⇒ **回测侧所有 `rt_seq` 均为 `Closed`**（`round_trips_open` 恒 0）。

### 10.3 持仓序列 `PositionPoint` + `ResultKind::Position`（ADR-027 D9 / ADR-028 D1）

- 引擎在**净值压入点**（`crates/strategy-core/src/engine.rs`）**同点**写入 `PositionPoint`（`EnsembleResult.positions`），
  与 `net_value` **逐点一一对应**（同 `ts`、同 `nav`）：

```
PositionPoint { ts, qty, position_value, cash, nav, position_ratio }
position_value = qty × close            // bar close 计价
nav            = cash + position_value
position_ratio = position_value / nav    // nav ≤ 0 ⇒ 0
```

- `ResultKind`（`crates/domain/src/ports.rs`）新增 `Position` 变体（`as_str` → `"position"`、`parse("position")`、`is_sampleable()` 三处同步；`Fills` 仍**不可抽样**）。
- `strategy_run_bars.kind` 的 CHECK 约束由迁移 **0029** 扩为五值 `('per_bar','net_value','drawdown','fills','position')`
  （经 `design/04-storage/schema.md` §4.3.20 tangle 生成，禁手改产物；漏改该约束会使**所有**新 run 因 CHECK 违规 `status=failed` —— 既有功能回归级缺陷，tester 闸门 E 段实测命中）。
- **期末强平仍保留**：回测侧 `finish()` 期末强制平仓（最后可用 close）**不取消**；强平后同点修正为空仓（持仓序列末点 `qty = 0`、`position_value = 0`）。
- **口径消歧（强制，ADR-028 D1）**：`position_ratio`（**时点**市值 / **时点**净值）与 ADR-026 的 `deployed_pct`（**区间累计**敞口 / 初始资金）、
  `cash_consumed_pct`（**区间累计**资金占用 / 初始资金）是**三个不同物**——字段名、UI 标签、文档三处都必须带分母说明，**不得互相解释**（详见 `design/12-strategy-system/01-adr.md` §13.4 口径注）。
