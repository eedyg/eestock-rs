# 018 · sim-live 深度回归（L4 兜底）e2e 设计

> 本报告位置（self-location）：`web/tester/design/018_simlive_deep_e2e_design.md`
> 配套用例：`web/e2e/simlive-deep.e2e.ts`（本设计为 L4 TDD 兜底 + 深度回归，真实环境）

## 1 背景与运行对象

- 环境：`eestock-app`（docker 镜像 `6b7ed12ba07f`，healthy）/ SPA（含 simlive 面板）/ `http://127.0.0.1:8081`
- MCP JSON-RPC（HTTP/SSE）：`http://127.0.0.1:8082`（与 web 同进程，**共享同一 `SimLiveService` 实例**）
- DB：`eestock-timescaledb` 127.0.0.1:5433（eestock/eestock/eestock；清理用，项目 e2e 既有惯例：SQL 清理 + `sql-ledger.md` 台账）
- 基线态（2026-09-07 起测前复核）：`simsession` 仅 1 行 running `s_1788766064_0`（smoke-test）；`simsession_result/trades/positions` 0；`backtest_runs` 6。
- 覆盖周期：周一 2026-09-07 15:xx CST（收盘后，M1 数据至 15:00 存在；无实时喂价——见 §4 F2）。

## 2 测试策略（分层）

| 层 | 通道 | 用例组 |
|---|---|---|
| MCP 契约层 | MCP JSON-RPC（8082 SSE 直连） | A1–A7：工具注册表/会话生命周期/下单/幂等/策略工具/停用门禁/停止+结果/回测对比 |
| REST 双通道一致 | `/api/sim-live/*`（8081） | A 组内交叉对账（MCP 下单 → REST 查询可见；REST toggle → MCP isError） |
| web 面板层 | Playwright chromium `/sim-live` | B1–B7：渲染/布局/下单 DOM 对账/统一开关/MCP 按钮/reload/历史回顾/重入竞态 |
| 契约缺口专项 | 面板 + REST + DB | C1：订单「来源」列契约（预期 FAIL，最小复现交架构师） |

策略要点：
- **状态自愈**：每用例自建 `e2e-deep-*` 会话（显式 session_id），用例尾用产品 API stop（幂等）+ SQL 删测试行，恢复基线（smoke running 保留不扰动）。
- **相对断言**：面板「当前会话」依赖全局 current（最新 running）。用例先捕获基线（running 的 smoke 或 idle），只做「=基线 / =自建 S / 前后不变」的相对断言，避免锁死环境特定 id。
- **时长控制**：workers=1 串行 + retries=0（describe 级）+ 每用例 ≤90s + 轮询断言短超时；不等待回测引擎完成（只验 run 触发与 run_ids 透出）。
- **稳定口径**：所有数值/文本断言由同一次 API 响应复算（面板格式函数同构重算），不做跨轮猜测。
- 全程 pageerror=0 / 应用 console.error=0 / loads=每用例 1（reload 用例 2）/ pathname=/sim-live。

## 3 用例清单（Given-When-Then 摘要）

### A MCP sim_* 契约（JSON-RPC over SSE 8082；probe 已验证可用）
| 用例 | should | 关键断言 |
|---|---|---|
| A1 | 工具注册表=17 工具，其中 14 个 `sim_*` 前缀、description 均含「模拟实盘，不触真实券商」、无真实交易工具 | tools/list name 集等于 14 固定清单；sim 工具 desc 全含关键词 |
| A2 | 会话生命周期：sim_start_session（cash_init 定制 777_000）→ running；get_account.cash=777000/equity；positions 空；pnl 归零；REST `/state?session_id` 同 id（双通道一致） | payload 断言 + REST 交叉 |
| A3 | 下单路径：市价买即时成交（fee>0、cash 减少、position 出现）；限价不触→pending；cancel pending→true、再撤→false、撤已成交→false；get_orders 全状态；REST `/orders` 与 MCP 同列表 | MCP+REST 双通道订单对账 |
| A4 | intent 幂等：同 intent 两次响应逐字节一致、订单只 +1；不同 intent 各 +1；跨通道（MCP 下单 intent→REST 同 intent 重放）仍不重复 | 响应相等 + 订单计数 |
| A5 | 策略工具：sim_list_strategies 默认清单（≥7、id/name/desc/params_schema）、strategy_id 过滤=1；sim_get_strategy_signal/analysis 对 running 会话返回**稳定形状**（无喂价评估为空：evaluation:null / evaluations:[]，记录 finding F2 证据） | 形状断言 + 证据 |
| A6 | MCP 停用门禁：REST `/mcp-toggle false` → sim_get_account 返回 isError=true 且 text 含「停用」；REST state.mcp_enabled=false；`true` → 恢复成功帧 | isError 翻转 + 文案 |
| A7 | 停止幂等 + 结果落库：stop→true（ended）；sim_list_sessions 含该行（metrics 摘要）；sim_get_session result{net_value/trades/metrics}；重复 stop→false；REST `/sessions` 同步 | 结果结构与幂等 |
| A8 | sim_run_backtest_compare：ended 会话（M1 + stock_set[600000]×strategy_set[dual_ma]）→ run_ids 长度=1、session_result 非空；重复触发→新 run（观察） | run_ids 笛卡尔积 + 秒级返回 |

### B web 面板 `/sim-live`
| 用例 | should | 关键断言 |
|---|---|---|
| B1 | 布局/当前态=API：区域 DOM 序 session-control < position-table < strategy-panel < stock-scoring < order-trade-list；当前会话 pill=基线或「未运行」；equity/cash/realized/unrealized=API 复算；trading checkbox=API；MCP 状态/按钮=API；start 按钮 running 时禁用 | DOM 序 + 文本复算 |
| B2 | 自建会话 S（REST 带 stock/strategy set）→ 面板 current=S；账户=API；策略面板/评分空态与 `/strategies` API 一致（空 → 记录 F2 证据）；positions 紧邻账户 | 面板=S id + API 对账 |
| B3 | 下单 DOM 对账 + 撤单：对 S 下市价买 + 限价不触 → 订单行数=API orders、行字段（方向/价格/数量/状态）=API；持仓表行=API positions；pending 行撤单按钮 → API cancelled + 行状态翻 cancelled | DOM=API 行级对账 |
| B4 | 统一交易开关：面板切换 off/on → REST trading_enabled 同值；快速连点 → 终态=最后点击、pageerror=0；off 态手动单仍成交（不受限），orders 无 aggregate_strategy 来源（无自动单） | UI↔REST 一致 + 无聚合自动单 |
| B5 | MCP 停用按钮联动：面板「停用」→ 状态「已停用」/按钮「启用」+ REST mcp_enabled=false + **MCP sim_get_account isError**（跨通道）；「启用」→ 全恢复 | 三通道一致 |
| B6 | reload 一致性：S running + 持仓/订单/开关态 → reload → S 不变（pill=同 id、账户/持仓/订单=API、开关态保持、MCP 状态保持）；loads=2 | reload 前后快照相等 |
| B7 | 历史回顾完整流：面板 stop S → REST S=ended；history Tab 列表含 S 行（净收益%=API 复算）；回看详情=API detail；「回测对比」点击 → 面板 text=该次 POST 响应 run_ids；切回 current → 当前会话=基线（历史回看不影响） | 面板=API + 切回不变 |
| B8 | 重入/幂等/竞态：面板 start 禁用（running）；面板 stop 后 REST 重复 stop→stopped:false 不崩；REST 重复 start（观察：新会话 id，不崩不 5xx）；快速 Tab 切换×6+开关连点 → 终态一致、pageerror=0、无跳转 | 幂等不崩 + 终态一致 |

### C 契约缺口专项
| 用例 | should | 预期 |
|---|---|---|
| C1 | **订单「来源」列**：REST/MCP 以 source=manual 下单 → 面板订单行「来源」列应显示 manual（SimOrder.source 契约：strategy\|manual\|aggregate_strategy）；另查 DB sim_trades.source=manual 佐证数据存在 | **预期 FAIL**（F1：API OrderView 未透传 source → 列空白）最小复现交架构师 |

## 4 已知环境事实（起测前探针，2026-09-07）

- F1（契约偏差，C1 将 FAIL）：`GET /api/sim-live/orders` 响应对象**无 source 字段**（`crates/application/src/simlive.rs OrderView` 未含 source；前端 `SimOrder.source` 必填声明；DB `sim_trades.source` 落库 manual）。→ 订单表「来源」恒空白。
- F2（无喂价管线，A5/B2 记录证据，非 FAIL）：部署版无任何对外路径调用 `configure_strategies`/`process_bar`（仅单元测试调用）；`/strategies` 恒 `{strategies:[],stocks:[]}`、signal evaluation:null；策略面板「未启动会话」/评分「未评估」为常态。L2 聚合评分/达阈值自动单（source=aggregate_strategy）**无法在真实环境正向验证**。→ 上报架构师裁决（feed 接线阶段）。
- 面板无下单 UI（无输入区）；手动单仅 REST/MCP 可发；store 内置 placeOrder 无入口。
- 历史列表含 running 会话（metrics=—，与设计一致）；stop 后 current 回落基线。
- MCP 与 web 共享实例验证通过（REST mcp-toggle 立即影响 MCP 工具）。
- 无会话删除类产品 API；清理口径 = 产品 API stop + SQL 删 `simsession`（级联 result/trades/positions）+ 删对比产生的 `backtest_runs` 行，台账留痕。

## 5 Mock/stub 与夹具

- 无前端 stub：全部真实服务。MCP 客户端为用例内 Node fetch SSE 实现（`E2E_MCP_URL`，默认 127.0.0.1:8082）。
- 夹具 = 通过产品 API 自建 `e2e-deep-<tag>` 会话与订单；清理 = stop + SQL（`name LIKE 'e2e-deep%'`），均写 `web/e2e/sql-ledger.md`。
- 截图证据目录 `E2E_SHOTS`（默认 `/tmp/simlive_deep`），用例尾 `evidence.json`。

## 6 边界与例外

- 未运行（无 running 会话）分支：面板「未运行」/按钮可用 —— 相对基线断言兼容（当前环境有 smoke running，保留不扰动）。
- 数值断言全部「API 响应复算」而非固定值；fee/滑点只断言 >0 方向。
- 重入：请求中按钮禁用（store guard）；REST 层重复 stop/重复 start 均有观察断言（不崩、不 5xx）。
- 回测对比只验 run 触发（秒级返回 run_ids），不等待引擎完成（异步，避免拖时长）。
- 用例失败策略：retries=0；每用例后置清理，afterAll 兜底清理 + mcp 恢复 true。

## 7 覆盖率目标

- MCP sim_*：14 工具全部可调（A1 注册表 + A2–A8 覆盖 start/stop/account/positions/orders/pnl/place/cancel/list_strategies/signal/analysis/list_sessions/get_session/run_backtest_compare）。
- REST /api/sim-live：state/positions/orders/pnl/strategies/sessions/{id}/backtest-compare/place-order/cancel-order/start/stop/trading/mcp-toggle 全覆盖。
- 面板：6 region + Tab + 5s 轮询 + reload + 重入 + 竞态 + 全程健康（pageerror/console/loads）。
- 缺口：F1（FAIL 固化）、F2（证据收集）。
