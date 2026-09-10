# 134 — T0做T策略挂豆粕模拟实盘（浸泡验证启动）

> 报告位置：`eestock-rs/coder/report/134_t0_doupo_simlive_soak_start.md`
> 性质：运行操作（开跑模拟会话），**零源码改动、零测试改动、无暂存文件**。纸面交易，不触真实券商。

## 任务
将已 published 策略「T0 做T·主张段捕获」（`st_1789041627252_000079`）挂到豆粕ETF 159985 的模拟实盘会话，M5 周期，开启自动下单（统一交易开关），作为浸泡（soak）验证起点。

## 执行步骤与结果

### 1. MCP 连接（SSE 协议）
- `GET http://127.0.0.1:8082/sse` → `event: endpoint` → `sessionId=774687abc5715d960cdb7ca73209c89f`
- `tools/list` 确认全部 sim_* / strategy_* / bt_* 工具在线（描述均含「模拟实盘，不触真实券商」）。

### 2. 策略目录核验
- `sim_list_strategies{strategy_id:"st_1789041627252_000079"}` → 在册，最新 published 版本，`approval_level=backtest_ok`，策略源码含 PARAMS_SCHEMA（entry_mode=1 多头回踩MA 等缺省参数）。Registry 切源（P4a）工作正常。

### 3. 启动会话
- `sim_start_session{name:"T0做T-豆粕浸泡", period:M5, source:mcp, strategies:[{strategy_id:"st_1789041627252_000079", stocks:["159985"], weight:1.0}]}`（params 缺省，阈值缺省 60/40，初始资金缺省 1,000,000）
- 返回：**session_id = `s_1789042836_0`**，status=running，start_ts=2026-09-10T12:20:36Z。

### 4. 会话验证
| 检查 | 结果 |
|---|---|
| `sim_get_session` | running，配置快照与请求一致 |
| `sim_get_strategy_analysis` | 非空：159985 聚合分 50.0 / hold，per-strategy 50.0 / hold，latest_price=2.304，ts=1789023600 |
| `sim_get_account` | cash=1,000,000，equity=1,000,000，pnl=0，fee=0（初始状态正常） |
| `sim_get_strategy_signal{159985}` | 与 analysis 一致（50.0 / hold） |

首个评分样本：score=50（hold，中立带内）。策略需 MA240（240 根 M5 bar）预热，且当前回踩入场条件未触发——中立 50 为正常表现，非异常。

### 5. 交易开关（浸泡核心目的）
- `GET /api/sim-live/state?session_id=...` → 初始 `trading_enabled=false`
- `POST /api/sim-live/trading {session_id, enabled:true}` → `{"trading_enabled":true}`
- 复查 state → `trading_enabled: true`，`active: true`，`mcp_enabled: true`
- 即：达聚合阈值（买≥60 / 卖≤40）将自动下模拟单。

### 6. Web 可见性
- `GET http://127.0.0.1:8081/sim-live` → **200**（页面存在）
- `GET /api/sim-live/sessions/s_1789042836_0` → 会话元数据正常返回
- `GET /api/sim-live/state` → 账户/持仓/pnl/session/trading_enabled 全量返回

### 7. 数据面确认（159985 实时行情）
- `get_kline{159985, 5m, limit:3}` → 最新 bar ts=2026-09-10T07:00Z（= 北京时间 15:00，今日收盘 bar），close=2.304，与策略 latest_price 一致。
- 当前为北京时间 20:21（盘后），bar 流今日已收齐；**下一根 M5 bar 将在下一交易日 09:35 推进**。行情源工作正常，无「无实时行情」限制。

## 配置快照
```json
{
  "session_id": "s_1789042836_0",
  "name": "T0做T-豆粕浸泡",
  "period": "M5",
  "cash_init": 1000000.0,
  "strategies": [{"strategy_id": "st_1789041627252_000079", "stocks": ["159985"], "weight": 1.0, "params": "默认"}],
  "thresholds": {"buy_long": 60, "sell": 40},
  "trading_enabled": true,
  "source": "mcp",
  "status": "running"
}
```

## 后续查看方式
- Web：`http://127.0.0.1:8081/sim-live`（页面 200，已确认）
- REST：`GET /api/sim-live/state?session_id=s_1789042836_0` / `/api/sim-live/sessions/s_1789042836_0` / positions / orders / pnl
- MCP（8082 SSE）：sim_get_account / sim_get_positions / sim_get_orders / sim_get_pnl / sim_get_strategy_analysis / sim_get_session
- 浸泡结束：`sim_stop_session{session_id}` 结算落库；`sim_run_backtest_compare` 可回测对比

## 残留风险 / 备注
- 盘后启动，自动下单最早触发于下一交易日 bar 推进；14:45 强平逻辑保证不留隔夜仓（策略内建）。
- 会话状态实时落盘 simsession_state，app 重启可 recover 续跑。
- 无源码改动，无需 git 暂存。
