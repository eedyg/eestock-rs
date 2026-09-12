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
  > **I-3/D6 印花税口径（2026-09-12 用户批准）**：缺省 `stamp_duty_pct=0.05` 是 **A 股股票口径兼容值**；
  > **ETF/LOF 无印花税，须显式传 `stamp_duty_pct:0`**（平台注册标的多为 ETF/LOF）。
  > 试算（`strategy_test_run`）与工作台（`bt_run_ensemble`）均回显**生效** fee（含 stamp_duty_pct 实际取值），
  > 使「缺省被多收」在结果里可见。标的类型元数据（symbols 表/Registry 增 type）另立 D11，不在本批。
  >
  > **D11 费率口径（ADR-019，2026-09-12 落地；本节为费率事实唯一出口）**：调用方**省略** `fee` 时按
  > 标的 `symbols.type` 查 `fee_profiles`（迁移 0025）解析（`source="profile"`）；**显式传 `fee` 对象整体优先**
  > （缺 `stamp_duty_pct` 仍 0.05 → 旧行为完全可复现，`source="explicit"`）；`type` 未设/无档案 → 旧默认
  > （`source="default"`）。费率事实：
  > - **ETF/LOF**（场内基金二级市场买卖）：印花税**不征**→0（《印花税法》第三条列举式定义仅含股票/存托凭证，
  >   属"不征"而非"免征"）；过户费**免收**→0（中国结算：ETF/LOF 二级市场买卖免收）；经手费事实值 0.04‰（双边，
  >   深交所 2026-01）与证管费（交易所收费表仅列 A股/B股/优先股）**按平台全佣口径已含于佣金 → 列 0，不得叠加**；
  > - **A股股票**（当前无此标的，为将来注册预留）：印花税卖出单边 0.5‰（2023-08-28 减半）、过户费 0.01‰ 双边、
  >   经手费 0.0341‰ 双边、证管费 0.02‰ 双边；佣金同 ETF（万2.5 双向、最低 5 元、全佣口径）；
  > - **引擎消费范围**：`FeeModel` 仍为 4 参数（佣金/最低/印花税/滑点；滑点非费率事实，取 ADR bt-1 默认 2bp）；
  >   档案中的经手费/证管费/过户费为**事实/口径列，本批未建模**（**D11-follow-up 债务**：注册个股或需规费精度时
  >   须扩展 FeeModel = 经手费/证管费/过户费双边 + 印花税仅卖出侧）。
  > 响应回显**显式两段**：`fee.effective`（引擎**实际应用**参数 commission_rate_pct/min_fee/stamp_duty_pct/slippage_bp + `source`=explicit|profile|default）与 `fee.profile`（解析到档案时的**全量事实**，含经手费/证管费/过户费 + `not_modeled` 显式清单）；`fee.symbol_type` 回显解析到的标的类型。**未参与撮合的档案字段不得出现在 effective 段**——`not_modeled` 由档案字段集与 `FeeModel` 消费字段集派生（非硬编码字符串），避免规费被误读为「已计入成本」（D11 验收 013 §11.3）。
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
| D-bt-1（D11 修订） | **缺省费率改为按标的类型推断**（ADR-019） | 省略 fee → 查 `fee_profiles`（etf/lof 印花税 0+过户费 0；stock 0.05）；显式传参优先；`type` 未知 → 上表旧默认 | 保持全局固定默认（已否决：对 100% ETF 标的系统性多收印花税） |
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
