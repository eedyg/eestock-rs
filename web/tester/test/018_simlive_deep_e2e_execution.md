# 018 · sim-live 深度回归（L4 兜底）e2e 执行报告

> 本报告位置（self-location）：`web/tester/test/018_simlive_deep_e2e_execution.md`
> 用例：`web/e2e/simlive-deep.e2e.ts`（新增，未 commit）
> 设计：`web/tester/design/018_simlive_deep_e2e_design.md`

## 1 运行信息

- 运行时间：2026-09-07 15:50–15:52 CST（`2026-09-07T07:50~07:52Z`）
- 运行对象：`eestock-app` 容器（docker 镜像 `6b7ed12ba07f`，healthy）；SPA `/sim-live`；`http://127.0.0.1:8081`
- MCP：`http://127.0.0.1:8082`（MCP JSON-RPC HTTP/SSE 直连，非代理）
- DB：`eestock-timescaledb` 127.0.0.1:5433
- 本地仓库：`eestock-rs` HEAD `805ddfa`（sim-live L1/L2/L3a/L3b 已含）；用例与设计为工作区未跟踪新文件
- 命令：`cd web && E2E_SHOTS=/tmp/simlive_deep npx playwright test e2e/simlive-deep.e2e.ts`
- 证据目录：`/tmp/simlive_deep/`（截图 9 张 + `evidence.json` 17 条）

## 2 套件结果

| 项 | 数 |
|---|---|
| 总用例 | 17 |
| PASS | 16 |
| FAIL | 1（C1 —— 刻意契约缺口固化，见 §4 F1） |
| 崩溃 / core dump | 无（全程 pageerror=0 / 应用 console.error=0 / 无意外 reload/跳转） |

单文件串行运行时长 **约 1.3 分钟**（控制时长达成）。

## 3 逐用例结果

### A MCP sim_* 契约（8082 SSE 直连，与 web 共享同一 SimLiveService 实例）
| 用例 | 结果 | 证据摘要 |
|---|---|---|
| A1 工具注册表 | PASS | tools/list=17；14 个 sim_* 名称精确命中、desc 全部含「模拟…不触真实券商」；非 sim 仅 3 只读工具；无真实交易工具 |
| A2 会话生命周期/账户 | PASS | MCP sim_start_session → running、`cash_init=777000` 透传；get_account.cash=equity=777000、positions 空、pnl 0；REST `/state?session_id` 同 id 一致 |
| A3 下单路径+双通道 | PASS | 市价成交（fee≥0、滑点>4）；限价 1.0 未触及 → pending；撤 pending=true→再撤 false、撤已成交 false；REST `/orders` 与 MCP id 集一致 |
| A4 intent 幂等 | PASS | 同 intent MCP×2+REST×1 三次调用仅记 1 单，MCP 两次响应字节一致；不同 intent 各记 1 |
| A5 策略工具 | PASS | sim_list_strategies 7 项（id/name/desc/params_schema）、strategy_id 过滤=1；signal/analysis/REST 三方一致 evaluation:null / evaluations:[] / strategies:[]（F2 证据落档） |
| A6 mcp-toggle 门禁 | PASS | 停用 → MCP sim_get_account/orders isError=true 且文案含「停用」，REST state 同步 false；启用 → 恢复数据帧 |
| A7 停止幂等+结果落库 | PASS | stop true→false 幂等；simsession_result{net_value.series/trades/metrics} 落库（trade_count=1）；list/get_session 与 REST 一致 |
| A8 回测对比 | PASS | run_ids=[1]（秒级返回），session_result 透出；REST 同端点一致（异步引擎不阻塞触发契约） |

### B web /sim-live 面板（chromium 真实浏览器）
| 用例 | 结果 | 证据摘要 |
|---|---|---|
| B1 布局/当前态=API | PASS | 区域 DOM 序 session-control < position-table < strategy-panel < stock-scoring < order-trade-list（持仓紧邻账户）；账户文本=fmt(API) 复算；开关/MCP 状态/按钮=API；running 时 start 禁用 |
| B2 自建会话 current=S | PASS | 面板 current=自建会话；账户 1M；策略卡/评分区空态=API（F2 截图证据）；开关默认 off |
| B3 下单 DOM 对账 | PASS | 订单 3 行字段（代码/方向/数量/状态）=API 逐行；持仓 2 行=API（code/数量/成本）；pending 撤单 → cancelled + 按钮消失 + API 同步 |
| B4 统一交易开关 | PASS | 开/关/快速交替 → REST trading_enabled 终态一致、UI=API；off 态手动单仍成交；sim_trades 来源仅 manual（无 aggregate 自动单） |
| B5 MCP 停用按钮联动 | PASS | 面板「停用」→ 已停用/按钮「启用」+ REST false + MCP isError（跨通道）；「启用」恢复 |
| B6 reload 一致性 | PASS | reload 后会话/账户/持仓/订单/开关/MCP 全保持（服务态持久）；loads=2（goto+reload 各 1）；pathname=/sim-live |
| B7 历史回顾完整流 | PASS | 面板 stop→ended；历史列表净收益列=API 复算；回看详情=API；「回测对比」面板文本=该次 POST run_ids；切回当前=基线（历史回看不影响当前会话） |
| B8 重入/幂等/竞态 | PASS | 快速 Tab×6+开关×4 无错乱（终态=最后一次）；重复 stop=false 不崩；重复 start 返回新 id（观察项）；pageerror=0/无跳转 |

### C 契约缺口专项
| 用例 | 结果 | 证据摘要 |
|---|---|---|
| C1 订单「来源」列 | **FAIL（预期）** | 面板来源列空白 `["",""]`；`GET /api/sim-live/orders` 响应对象无 source 字段；DB `sim_trades.source=manual`（数据层已落）→ 展示层丢失。见 §4 F1 |

## 4 发现（上报架构师，本 spec 未改码）

### F1（C1 FAIL，可复现缺陷）：订单「来源」列契约缺失
- 现象：以 `source=manual` 经 REST/MCP 下单后，`GET /api/sim-live/orders` 每个订单对象**没有 source 字段**（`crates/application/src/simlive.rs` 的 `OrderView` 未含 source），面板 order-trade-list「来源」列空白。
- 契约依据：`web/src/api/types.ts SimOrder.source`（必填，strategy|manual|aggregate_strategy）；`design/06-web/10-simlive.md` order-trade-list 注明 `source: strategy|manual`；订单行应显示来源。
- 佐证：DB `sim_trades.source` 已正确落 `manual`（数据层 OK，仅读模型/API 透传缺失）。
- 最小复现：见 C1 用例（截图 `08_C1_order_source_column.png`，evidence.json repro 字段）。修复面：`OrderView` 补 source（web 读模型 + REST DTO，存储源已有）。

### F2（证据收集，非 FAIL，需架构师裁决）：无喂价管线 → 真实环境无法产生策略评分
- 现象：running 会话即使声明 strategy_set(3)+stock_set(2)，`/api/sim-live/strategies` 仍 `{strategies:[],stocks:[]}`；`sim_get_strategy_signal` → evaluation:null；面板策略卡「未启动会话」/评分区「未评估」为常态。
- 根因方向：部署版无任何对外路径调用 `configure_strategies`/`process_bar`（仅 crate 单测可见）；实时 bar→评估→聚合→阈值自动单（source=aggregate_strategy）链路未接线到生产数据源。
- 影响：统一交易开关「on→达聚合阈值自动模拟单 / off→仅评分不单」的正向行为无法在真实环境端到端验证（本次以「off 态手动单仍成交 + sim_trades 无 aggregate_strategy 来源」做了可达侧验证）。
- 建议：架构师裁决 L2 实时评分 feed 接入阶段/方式；修复后本套件 B2/A5 可无缝升级为正向评分断言。

### 观察项（无失败，行为记录）
- O1：REST/MCP 在已有 running 会话时再次 start-session 会直接创建第二个 running 会话（返回新 id，不崩不 5xx）；面板 start 按钮 running 时 disabled 已挡 UI 层重复。若产品语义应为「全局单运行会话」，需后端加约束（现无）。
- O2：受控 checkbox（统一交易开关）在点击瞬间会因 async 请求先回弹再置位；Playwright `locator.check()` 会撞该回弹竞态（工具问题，产品行为正常——已用 click+轮询规避并在用例内注释）。

## 5 清理复核（恢复初始）

- 清理方式：产品 API `stop-session`（幂等）→ SQL 删自建 `simsession`（级联 result/trades/positions）→ 删回测对比 `backtest_runs` → `mcp-toggle` 恢复 true；全程台账入 `web/e2e/sql-ledger.md`（见尾部 sim-cleanup/bt-cleanup 记录）。
- 复核结果（=运行前基线）：`simsession` 仅 `s_1788766064_0|running`（环境自带 smoke-test）；`simsession_result/sim_trades/sim_positions` 0 行；`backtest_runs` 6；`mcp_enabled=true`。
- 无 crash/core dump；未 commit；`git diff --cached` 为空（无 staged）；新增文件仅用例与设计两份（均为 untracked）。

## 6 证据文件

- `/tmp/simlive_deep/evidence.json`（17 条 case/pass/note/cleanup）
- 截图：`00_B1_current_session.png`…`08_C1_order_source_column.png`（B1/B2/B3/B4/B5/B6/B7×2/C1）
- playwright 失败证据：`web/e2e/artifacts/test-results/…C1…/test-failed-1.png` + error-context.md

## 7 覆盖总结 / 缺口

覆盖：MCP 14/14 工具可用性（注册表+调用）；REST 14 端点全触达；面板 6 region + Tab + reload + 重入/竞态 + 全程健康（pageerror=0/console.error=0/loads 精确）；双通道一致性（MCP↔REST↔面板）全覆盖；幂等（intent/stop）；边界（限价 pending/撤单/空态/多会话并存）。

缺口（交付后待办）：F1 需产品补 OrderView.source 后 C1 转绿；F2 需评分 feed 接线后补正向评分/自动单断言；O1 需架构师定单运行会话语义。
