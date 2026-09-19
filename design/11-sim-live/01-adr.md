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

---

## 12. 结果载荷 v2 口径注（ADR-027 批次，2026-09-20 落地）

> 本节为 ADR-027「交易明细分层（L1/L2）+ 回合口径统一」在 **sim-live 侧**的口径事实源回写；
> 契约权威以 `design/17-trade-detail-layering/02-spec.md` 与 `design/01-architecture/adr/ADR-027-*.md` 为准。
> 落地清单/验收索引见 `design/17-trade-detail-layering/05-status.md`；实现证据 `coder/evidence/20260920_adr027_p2_simlive/`，独立验收 `tester/evidence/20260920_adr027_accept*/`。

### 12.1 费用拆列（ADR-027 D4）：`commission` + `stamp_duty`，`fee` 为**派生合计**

- `simlive::Fill` 与 `simlive::SimTrade` 的合并 `fee` 字段**拆为** `commission` + `stamp_duty` 两列
  （撮合点 `FeeModel::buy/sell` 本就算出两者，原实现相加后丢弃 —— F9）。
- `Fill::fee()` / `SimTrade::fee()` 为**派生读**（= `commission + stamp_duty`），**非第二事实源**；账户账务/订单读模型沿用合计口径。
- `sim_trades` 表新增 `commission float8 NOT NULL DEFAULT 0`、`stamp_duty float8 NOT NULL DEFAULT 0`
  （迁移 `0028_sim_trades_fee_split.sql`，经 `design/04-storage/schema.md` §4.3.19 tangle 生成，**禁手改产物**）；
  保留 `fee` 列（语义 = `commission + stamp_duty`，列注释写明）。
- `SimOrder` 增 `commission`/`stamp_duty`（`#[serde(default)]`）⇒ 重启恢复路径能用**真实事实**重建 `Fill`，而不是把印花税补成 0（造数）。
- **禁止下游复算**：`FillFact.commission`/`stamp_duty` 必须取撮合点事实（最低佣金分支不可逆，复算不保证逐位相等）。

### 12.2 真实 bar 序号（**禁** `ts / bar_sec` 反算，ADR-027 §2.13）

- `session_bar_index(session_start_ts, ts, bar_sec) = (ts − session.start_ts).max(0) / bar_sec`
  —— **会话内 0-based bar 网格序号**（`stop_session` 传 `session.start_ts`；运行中读路径传 `view.start_ts`，同一函数同一口径）。
- **禁**绝对纪元商 `ts / bar_sec`（旧实现得到 `29206680` 量级的伪序号，R4 复现测试）。

### 12.3 Open 回合语义 + **不引入期末强平**（ADR-027 D7/F8）

- 会话**不引入期末强平**：`stop_session` **不补造任何平仓成交**（否则即为「伪造成交」，违反 ledger 事实源纪律）。
- 未平仓回合以 `status = Open` 与 `Closed` **出现在同一列表**；`pnl`/`hold_bars`/`close_ts`/`close_bar`/`close_price`/`reason` 恒 `None`（**禁止造数**）。
- 8 项绩效只吃 `Closed`（`backtest::compute_metrics` 内已按 `status == Closed` 过滤）；`Open` 的未实现部分由持仓视图（账户持仓/`PositionPoint`）承担，UI 必须**单列披露**。
- `sim_trades.source` → `FillReason` 映射：`strategy`/`aggregate_strategy` → `Policy`；其余（`manual`）→ `Manual`。
  **不产出** `ForceClose`/`StopTrigger`（sim-live 无期末强平/无引擎硬止损强平）。

### 12.4 结算与运行中读共用**唯一聚合实现**（ADR-027 D7）

- 旧 FIFO lot 配对（一条 lot = 一条 L1、`stamp_duty` 硬编码 0、`rt_seq`/笔数占位、`bar_index` 由 ts 反算）**已删除**；
  改为：`SimTrade` → `FillFact` 账本 → `assign_rt_seq` → `aggregate_round_trips`（**唯一聚合实现**，禁第二份配对/分摊）。
- 输入顺序 = `sim_trades` 到达顺序（`id` 升序）；多标的按 `(code, rt_seq)` 分组（`assign_rt_seq` per-code 从 1 起）。

### 12.5 运行中 L1/L2 读能力（ADR-027 D8/§6，F8 缺口补齐）

- `SimLiveService` 新增运行中读函数（会话进行中即可取，与结算**同口径**）：
  - `round_trips(session_id) -> Vec<TradeDetail>`（L1 列表，同 02-spec §5.2 形状，含 `l2_count`/买卖笔数）；
  - `round_trip_fills(session_id, code, rt_seq) -> Option<Vec<FillFact>>`（L2 切片，同 §5.3 形状；
    **未知回合 → `None`**，映射 404，**禁止**空数组冒充「无成交」）。
- 外部通道（MCP `sim_*`，02-spec §6「键为 `session_id` + `code`」）：
  `sim_get_round_trips(session_id, code?, offset?, limit?)` 与 `sim_get_round_trip_fills(session_id, code, rt_seq, offset?, limit?)`
  （权威 schema 见 `design/07-app-plane/01-mcp.md`）。
- 完整性契约（D11）：列表响应自述 `total`/`recorded`/`has_more`/`next_offset`，UI**不得**静默展示不完整数据。
