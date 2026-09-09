# 020 · simlive-recovery e2e 设计（实时落盘 + 真机重启恢复续跑）

- 本文件位置（self-location）：`web/tester/design/020_simlive_recovery_e2e_design.md`
- 对应产物：`web/e2e/simlive-recovery.e2e.ts`（本设计配套的可提交 e2e 回归 spec）
- 执行报告：`web/tester/test/020_simlive_recovery_e2e_execution.md`
- 运行对象：eestock-app（镜像 4326afb96060，healthy）/ SPA / http://127.0.0.1:8081
- 数据库：eestock-timescaledb 127.0.0.1:5433（应用面 simsession 系自有表）
- 本 spec 只测不改、不 commit；发现问题只上报（最小复现 + 证据）交架构师。

## 0. 背景与目标

L4 已实现「会话状态实时落盘 + 从落盘重建续跑」（commit a826c4b；migration 0019
`simsession_state`；`SimLiveService::recover_sessions`）。单元 TDD 已覆盖
（crates/application/tests/simlive.rs §重启恢复 4 例），缺**真机容器重启**级的深度回归：

1. **实时落盘**：start-session（带 strategies：params/stocks/weights）+ place-order 后，
   DB `simsession_state` 有完整运行态（cash/positions/net_value_series/strategy_configs/orders/
   trading_enabled/latest_prices）；feed（process_bar）后再落盘 updated_at 前进。
2. **重启恢复（核心·真机）**：快照 A → `docker restart eestock-app`（同实例有 state）→
   healthy → 会话仍 running、账户/持仓/PnL/策略配置与 A 一致；/state、/strategies、
   /sessions/{id} 不 500；feed 续跑（评分非空、state 继续落盘、可再下单）。
3. **无 state → ended**：预置 running 会话但清空其 simsession_state → 重启 → ended + 降级注解，不崩。
4. **幂等**：二次重启已恢复会话不重复（无订单/成交/持仓重复、无双重扣款）；已 ended 会话不再收敛。
5. 全程 pageerror=0 / console.error=0（重启窗口不挂页面，网络断开不产生页面错误）。

## 1. 测试策略与分层覆盖

| 层 | 覆盖点 | 手段 |
|---|---|---|
| 应用/存储（真机进程内） | recover_sessions 收敛、restore_live_session 重建 | 真机 docker restart + REST 断言 + docker 日志 recovered/degraded |
| 存储落盘 | upsert_state 幂等（单行）、字段齐全、updated_at 前进 | SQL 直读 simsession_state/sim_positions/sim_trades |
| 表现（SPA） | /sim-live 面板在恢复后展示恢复会话（pill/账户/持仓），无 pageerror/cerr | chromium 页面 + REST 对账 |
| 契约 | /state、/strategies、/positions、/orders、/pnl、/sessions/{id} 非 500；restart 后会话非「会话不存在」 | REST 断言 |

约束：单运行会话（O1）→ 正例（恢复）与反例（无 state→ended）必须分两轮、各自独立的重启窗口，
串行执行；真机重启放在文件后段（本 spec 单独运行，不影响其它功能测试）。

## 2. 用例清单

### R0 基线（无重启）
- 前置：docker 可用、eestock-app healthy；清理同名残留；DB 无 running 会话、无 state 行；
  记录基线 ended 行数；探针 docker `docker inspect` 权限。

### T1 实时落盘（真机，无重启）
- start-session：`strategies=[dual_ma{fast5/slow20/position_pct1, stocks[510880], weight2,
  stock_weights{510880:1.5}}, macd{fast12/slow26/signal9, stocks[510050], weight0.5,
  stock_weights{510050:0.8}}]` → 200 running、派生 strategy_set/stock_set 正确。
- start 后立即读 `simsession_state`：行存在、含初始运行态（cash=1e6、net_value_series 初始点、
  strategy_configs 2 条）。
- 等 /strategies 非空（feed process_bar 首轮）→ DB updated_at 前进（process_bar 后 state 更新）。
- place-order 买 510880 ×3000（price=DB M1 最新 close）→ filled；/state 账户 cash 减少、
  持仓 1 条、orders 1 条。
- DB state_json 断言：cash/positions{qty,avg_cost}/orders/net_value_series/strategy_configs
  （含 params/stocks/weight/stock_weights）/trading_enabled=false/latest_prices。
- 快照 A（REST /state + /orders + /strategies + DB state_json + sim_trades/sim_positions 行数）。
- SPA：/sim-live 面板 pill=运行中·sid、账户=API、持仓 1 行、无 pageerror/cerr。截图。

### T2 重启恢复（核心·真机）
- `docker restart eestock-app` → 等 healthy（≤150s）→ docker 日志 `sim-live 启动恢复完成`
  recovered≥1 且 degraded=0。
- GET /sessions/{idA} 200 running（非 404/500）；/state、/strategies、/positions、/orders、/pnl 全 200。
- 一致性（对照快照 A）：
  - 硬断言：session.id/status；account.cash/equity/market_value/realized_pnl/total_fee；
    positions（code/qty/avg_cost/latest/market_value/unrealized，latest 按 DB 最新 close 复算）；
    orders 逐字段；/strategies config（deep-canon 相等）；DB state_json 核心字段
    （cash/realized/total_fee/positions/net_value_series/strategy_configs/orders/trading_enabled/latest_prices）；
    state 行仍 1（upsert 幂等）。
  - 软断言（观察项，不一致即 FAIL 上报）：account.unrealized_pnl 与 pnl.net_profit 跨重启相等。
- feed 续跑：/strategies 非空、DB updated_at 再前进；再下 1 单（买 510050 ×2000）→ filled，
  orders 2、sim_trades 2、sim_positions 2（恢复后仍可交易/续跑落盘）。
- SPA：恢复后面板 pill/账户/持仓 2 行、pageerror/cerr=0。截图。存快照 B（供幂等对比）。

### T3 幂等（recovered 会话二次重启）
- 二次 `docker restart` → healthy；日志 degraded=0。
- 与快照 B 全量一致性（含 unrealized，此时两侧同源于恢复，应相等）；
  无重复：orders 2 / sim_trades 2 / sim_positions 2 / state 行 1 / cash 未双重扣款。
- 端点非 500 三连（/state、/strategies、/sessions/{id}）。截图。

### T4 无 state → ended（降级）+ ended 幂等
- 停/删 T2/T3 会话 A（产品 stop 幂等 + SQL 删行）→ 复核 0 running。
- 建 B（cash 500k，dual_ma/510880）→ 下单 1000 → 确认 state 行存在 → SQL 清空其
  simsession_state（模拟遗留/无运行态）。
- 三次重启 → 日志 degraded=1 recovered=0；GET /sessions/{idB} 200 ended + result 非空 +
  net_value.note 含「恢复降级」+ metrics.note 含「中断」；/state 缺省 404（非 500，idle）；
  /strategies 缺省 404（非 500）；列表含 B(ended)。截图（历史回看/未运行面板）。
- 四次重启（ended 幂等）→ 日志 recovered=0 degraded=0；B 仍 ended 且注解不变、无 500、不再收敛。

### afterAll 兜底清理
- 停残留 running（产品 API）+ SQL 删 name LIKE `e2e-rec%`（级联 result/trades/positions/state）；
- 复核基线：running=0、simsession_state=0、ended 行数与 R0 一致；
- 证据落 /tmp/simlive_recovery/evidence.json + docker 日志摘录 + 截图；台账追加 sql-ledger.md。

## 3. Mock/桩依赖
- 无 mock：真实 docker 容器重启、真实 DB、真实行情库 kline_accurate（M1 最新 close 作 price）。
- 代码内仅复算辅助：deep-canon、数值近似比较（1e-6）、DB updated_at 时序比较。

## 4. 边界与异常用例
- 会话不存在：/sessions/{id} 404（删除后）与运行中恢复（200 running）边界。
- 无 state 降级（T4）→ ended + 注解，不打崩；/state idle 404。
- 幂等（T3/T4）重复重启不重复收敛/不重复扣款/不重复记单。
- feed 无新 bar（休市）→ 断言评分仍被首轮 tick 驱动非空，净值以状态一致兜底（任务书口径）。

## 5. 覆盖目标
- 验收 1~4 全部用例化；页面前置基线断言；重启窗口页面关闭（网络断开不产生页面 console 错误）；
- 每用例 pageerror/cerr=0（UI 段）；重启相关用例附 docker 日志与 healthy 耗时证据。

## 6. 预期风险（只报告，不改）
- 观察项：账户级 unrealized_pnl/net_profit 跨重启是否一致（restore 用落盘 latest_prices 反推
  未实现盈亏，落盘 latest 若为 0 将出现大额负未实现）——预检已见 0 → -10172.034 的翻转迹象，
  以软断言记录精确 Δ，交架构师裁决；不影响其余用例收敛（该状态两侧同源于恢复则自洽）。
- docker restart 需 ~15–60s healthy（healthcheck start_period 15s、interval 30s），等待预算 150s。
