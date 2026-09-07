# 11-sim-live / 01 — 模拟实盘交易系统 + MCP 架构/ADR（预实施）

> 状态：**待批复**。纸面交易（假钱、实时行情驱动、**永不触真实券商**）。
> 定位：独立模块「sim-live」，与 backtest(历史)/real-trading(⑥,真实券商) 分开。
> 参考：`backtest` 引擎(策略/指标/FeeModel) + `eestock` 实时行情数据链。

---

## 1. 目标与非目标
**做**：模拟实盘（实时行情→模拟账户成交→P&L）+ **多策略实时评估/评分**（3 策略 × ≤30 股票）+ **会话记录与回测对比** + **双通道（MCP `sim_*` 外部 + web 内）**。
**不做（边界）**：触真实券商；真实资金；完整交易所撮合（用简化成交模型）；风控引擎（如需另立项）。

## 2. 架构分层
```
┌─ 实时行情数据链 (WS quote/bar + 最近 kline, eestock 实时源)
│      │ 每新 bar(1m/配置周期) 驱动
├─ sim-live 核心 (crate simlive):
│   • RealtimeStrategyOrchestrator: 3 策略并行, 每策略实时评估其标的集 → 每 stock 评分为分
│     → 汇总出【聚合评分】(供交易决策) + 各策略独立评分(MCP/web 展示)
│   • SimAccount: 现金/持仓(数量/成本/最新/市值)/已实现+未实现 P&L/费用(FeeModel)
│   • FillEngine: 简化撮合(市价=最新价即时; 限价=价格达成时成交; 滑点可选)
│   • SessionManager: 会话 start/stop(手动 MCP/web/可选预设时长/交易日收盘); 会话事件流
│   • StrategySignal→OrderBridge: 聚合评分→(若该策略 trading on)→模拟单; 手动单同账户
│   • 交易决定用【聚合评分】(避免多策略冲突); 单标注 source: strategy|manual
├─ domain::ports / storage (会话/订单/持仓/策略状态落库, 持久化+幂等)
├─ web (应用面): TradingGrid 内嵌 模拟实盘面板(sim-live 区域, 与真实交易⑥区分)
└─ MCP (应用面, Streamable HTTP 新规范, 替代 SSE): sim_* 工具集
```

## 3. 会话 Session（记录 + 回测对比，Q8）
- `SimSession`：{id, name, cash_init, strategy_set(哪些策略/参数/trading on|off), stock_set, period, start_ts, end_ts, status(running/ended)}。
- 会话运行期：实时累计 `net_value_series` + `trades` + 事件流（信号/下单/成交）。
- **结束**（手动 stop / 预设时长 / 交易日收盘）→ 落库 `simsession`(元数据) + `simsession_result`(net_value/trades/metrics JSON，结构=backtest_run)。
- **回测一下**：会话结束后可触发「同周期+同策略集」`backtest` run，**对比展示**（sim-live vs backtest：净值叠加 + 指标并排）；历史会话列表回看（详情=净现值/交易/指标/事件流）。

## 4. 多策略实时评分（Q11/16/17/18/19）
- 3 个策略**并行**实例（每策略：选 1+ 股票、参数、**trading on/off**）。
- 每策略对**其标的集**在**每新 bar** 评估 → 每 stock **独立评分**（信号/0-100/级别）。
- **聚合评分** = 各策略评分按权重/平均合成（每 stock 一个聚合分）。
- **交易决定用聚合评分**（避免多策略冲突）；独立评分供 MCP/web 查看。
- 阈值/综合评分 → 若 ≥做多阈且对应策略 trading on → 下模拟单（同一账户）。

## 5. 账户模型（Q5）
`SimAccount`：cash（初始默认 1000_000 可配）+ positions{code,qty,avg_cost,latest,market_value,unrealized_pnl} + realized_pnl + fees（FeeModel）。

## 6. 撮合（Q2）
市价=按最新价即时成交；限价=价格触及成交（每 bar tick 检查）；滑点/手续费按 FeeModel。

## 7. 双通道（Q3/10/13）
- **MCP（外部）**：`sim_*` 工具（见 §8），操作同一账户/会话。
- **web（内部）**：TradingGrid 内 sim-live 面板（账户/持仓/订单/策略评分/会话），与 MCP 一致、互不冲突。

## 8. MCP 工具矩阵（`sim_*`，Streamable HTTP）
| 工具 | 说明 |
|---|---|
| `sim_get_account` / `sim_get_positions` / `sim_get_orders` | 账户/持仓/订单查询 |
| `sim_get_pnl` | 已实现/未实现 P&L |
| `sim_place_order` / `sim_cancel_order` | 下/撤**模拟**单 |
| `sim_start_session` / `sim_stop_session` | 会话开/停 |
| `sim_list_strategies` | 内置策略清单+schema |
| `sim_get_strategy_signal` | 单股票+策略→当前信号/指标/评分 |
| `sim_get_strategy_analysis` | 多股票评估概览（聚合+独立评分） |
| `sim_get_session` / `sim_list_sessions` / `sim_run_backtest_compare` | 会话/记录/回测对比 |
> 所有工具 description 注明「**模拟实盘，不触真实券商**」。

## 9. 存储（迁移 0018）
`simsession`(id,name,cash_init,strategy_set,stock_set,period,start_ts,end_ts,status,source) + `simsession_result`(session_id,net_value_json,trades_json,metrics_json) + `sim_trades`(session_id,code,side,qty,price,ts,fee,source) + `sim_positions`(session_id,code,qty,avg_cost)（会话内状态，可重建）。策略状态/评分事件可选 `sim_events`。

## 10. 数据流（每新 bar）
行情 bar → RealtimeStrategyOrchestrator(3策略×标的集) → 每 stock 独立评分 → **聚合评分** → (trading on 且达阈值)→ 模拟单 → FillEngine(最新价) → SimAccount → 会话 net_value/trades/事件流。MCP/web 实时查询同状态。

## 11. 阶段（实施）
- **L1 核心**：simlive crate(账户/撮合/会话) + 迁移0018 + 基础 MCP `sim_*`(get/place/cancel/start/stop)。
- **L2 策略**：RealtimeStrategyOrchestrator(3策略×30股票, 实时评分+聚合) + `sim_*` 策略工具 + 事件流。
- **L3 记录/对比**：session_result + 触发回测对比 + web 面板(账户/持仓/评分/会话回看)。
- **L4 加固**：幂等/竞态/持久化一致性 + 深度回归(仿本轮 TDD 方法)。

---
## 决策点（均已按你拍板）
3 策略×30 股票；聚合+独立评分、聚合用于交易决策；trading on/off；双通道；sim_ 前缀；Streamable HTTP；会话记录+回测对比；模拟独立/持久化/幂等。
**批复后**：先 L1（核心+基础 MCP）→ L2（策略）→ L3（记录/对比/web）→ L4。
