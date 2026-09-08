# 模拟实盘（sim-live）MCP —— 访问方式与能力

> 作用：给外部工具 / agent 用 MCP 操作 eestock 模拟实盘（纸面交易，**永不触真实券商**）的入口文档。
> 服务端口：`8082`（MCP）；`8081` = web/REST。内网免认证（ADR-010）。
> 工具统一 `sim_` 前缀 + 描述「模拟实盘，不触真实券商」。

---

## 一、访问方式（MCP over HTTP/SSE）

transport = **MCP SSE**（Streamable HTTP 未实现，见 ADR 09/11 残留项）。

**连接/调用三步（JSON-RPC 2.0）**：
1. `GET /sse` → `text/event-stream` 长连接，首帧 `event: endpoint`，`data=/messages?sessionId=<32hex>`。
2. 拿到 `sessionId` 后 `POST /messages`，body 为 JSON-RPC 请求：`{ "jsonrpc":"2.0", "id":1, "method":..., "params":... }`。
3. 常用 method：`tools/list`（枚举全部工具）、`tools/call`（调用工具，`{"name":"sim_start_session","arguments":{...}}`）。

> 语言侧对接 SDK：配 `url: http://127.0.0.1:8082/sse`（SSE transport）。

---

## 二、能力（sim_* 工具矩阵）

| 工具 | 能力 / arguments 要点 |
|---|---|
| `sim_start_session` | 开模拟会话：`name`、`period` 必填；`cash_init` 默认 1,000,000；可传 `strategies:[{id,params,stocks,weight,stock_weights?}]`（每策略参数/标的集/权重/股票级权重），或 `strategy_set×stock_set`（默认参数）。 |
| `sim_stop_session` | 停止并结算：`session_id` → 落库结束结果（净值/成交/指标，backtest 口径）。 |
| `sim_get_account` | 查账户：现金/净值/市值/已实现+未实现盈亏/费用。参数 `session_id?`。 |
| `sim_get_positions` | 查持仓：code/qty/avg_cost/latest/市值/盈亏。 |
| `sim_get_orders` | 查订单：pending/filled/cancelled；含 `source`(strategy/manual)。 |
| `sim_get_pnl` | 查已实现/未实现盈亏与费用。 |
| `sim_place_order` | 下模拟单：`code, side(buy/sell), priceType(limit/market), price?, qty`；市价=按最新价即时、限价=触及成交；滑点/费用按 FeeModel。 |
| `sim_cancel_order` | 撤未成交(pending)模拟单：`order_id`；已成交/未知返回 false。 |
| `sim_list_strategies` | 内置策略清单 + 参数 schema（id/name/description/params_schema）。 |
| `sim_get_strategy_signal` | 单标的当前策略信号：聚合分 + 各策略独立分 + 信号/最新价。 |
| `sim_get_strategy_analysis` | 多标的评估概览：每标的 聚合分 + 各策略独立分。 |
| `sim_list_sessions` | 历史会话列表（周期/策略集/标的数/净收益/回撤/夏普摘要）。 |
| `sim_get_session` | 会话详情回看（元数据 + 结束结果：净值/交易/指标）。 |
| `sim_run_backtest_compare` | 按会话（同周期+策略+标的+起止区间）触发一次回测 run（异步返回 run_id，调用方轮询 backtest 完成）。 |

> `mcp-toggle`（源自 MCP 状态）：停用 sim_* 工具 → 调用返回 isError「MCP 停用」；启用恢复。

---

## 三、典型用法

- **查询**：`sim_list_sessions` → `sim_get_session(id)`。
- **开跑**：`sim_start_session`（带 `strategies`：每策略 参数/标的/权重/`stock_weights`）→ 实时喂 bar → 聚合评分 → 达阈值 + 统一开关(开) → 自动模拟单；中途 `sim_place_order` 手动补单。
- **回看/对比**：`sim_stop_session` → `sim_run_backtest_compare`（模拟实盘 vs 回测对比）。

---

## 四、Pitfalls / 边界

- transport = MCP SSE；8082=MCP，8081=web/API；内网免认证。
- 所有 `sim_*` 标注「模拟，不触真实券商」；`mcp-toggle` 停用时 sim_* 返回 isError。
- 会话状态**实时落盘**（`simsession_state`）+ 内存；app 重启后 `recover_sessions` **恢复续跑**（有 state）或标 ended（无 state / 损坏）。
- 股票须为**已注册标的**（未注册 → 400）；每策略参数/标的/权重（含股票级）可细配；**聚合评分用于交易决定**。
- 高频写入：每次 `process_bar`/下单/撤销/配置变更都会 upsert 会话状态（写盘放大）。

---

## 五、验证（smoke）

1. `tools/list` 应含全部 `sim_*` 工具（见矩阵）。
2. `tools/call sim_get_account` 返回账户（cash/净值/已实现+未实现盈亏/费用）。
3. `sim_get_orders` 返回含 `source`（strategy/manual）。
4. `sim_start_session` 后 `sim_get_strategy_analysis` 非空。
5. `sim_place_order` 成交后 `sim_get_positions` latest 价 = 行情源（非 0.000）。

---

_参考：`design/11-sim-live/01-adr.md`（架构）、`preview/sim-live.html`（web 面板）、skill `simlive-mcp-access`。_
