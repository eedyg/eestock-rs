# 019 · sim-live「添加标的 + 添加策略」会话配置 UI —— 真机验收执行报告

> 本报告位置（self-location）：`eestock-rs/web/tester/test/019_simlive_session_config_ui_realdevice_verify.md`
> 用例（临时 spec，运行后已删除；副本留存）：`/tmp/simlive_config/simlive-config-verify.e2e.ts`
> 运行方式：临时副本 `web/e2e/_tmp_simlive_config_verify.e2e.ts`（跑后删除，未 commit）

## 1 运行信息

- 运行时间：2026-09-07 21:26–21:27 CST（`2026-09-07T13:26~13:27Z`）
- 运行对象：`eestock-app`（docker 镜像 **90d1b35d5**，healthy）；SPA **index-DCNiax_d.js**；`http://127.0.0.1:8081/sim-live`
- 验证对象：仓库 `eestock-rs` HEAD **3984e7d**（feat(web): sim-live「添加标的+添加策略」会话配置）
- MCP：`http://127.0.0.1:8082`（JSON-RPC over SSE，与 web 同进程共享 SimLiveService）
- DB：`eestock-timescaledb` 127.0.0.1:5433（user/pass/db=eestock）
- 测试栈：`cd web && E2E_SHOTS=/tmp/simlive_config npx playwright test _tmp_simlive_config_verify.e2e.ts`
- 结果：**1 test / 9 steps / 全 PASS**（chromium 1280×720 真机视图）；`retries=0`

## 2 验收逐项证据

### C1 会话配置面板（未运行态，`sim-session-config`）
- `/sim-live` 加载后 `sim-session-config` 可见；会话状态 pill=「未运行」；开始按钮「开始会话」可用、停止禁用。
- 输入区齐全：`sim-config-name`（默认「手动会话」）、`sim-config-period` options=[1m,5m,15m,日]、`sim-config-cash`（默认 1000000）。
- 标的 multi-select chips **44**（= `GET /api/symbols` 目录 44）；策略 multi-select chips **7**（= `GET /api/backtest/strategies`：dual_ma/ma_rsi/macd/boll/kdj/momentum/atr_channel）。
- 截图：`config_panel.png`。

### C2 校验（未选 → 阻断+提示，不 start）
- 空选集点「开始会话」→ `sim-config-error` 可见，文案「请选择至少一个标的」；800ms 窗口内 **0 次** `POST /api/sim-live/start-session`。
- 截图：`config_error.png`。

### C3 启动带所选 → body stock_set+strategy_set → running
- 点击选中标的 518880/161226/510880 + 策略 dual_ma/macd（chips `data-on=true`）；名称填 `cfgv-*-ui-session`、周期选 5m、初始资金 2500000。
- Playwright 抓包 `POST /api/sim-live/start-session` body：
  `{"name":"cfgv-mtr9yoko-ui-session","period":"M5","cash_init":2500000,"stock_set":["518880","161226","510880"],"strategy_set":["dual_ma","macd"]}`
- 状态 pill →「运行中 · s_1788787621_7」；配置面板随运行隐藏（count=0）。
- REST `/api/sim-live/state`：`session.stock_set/strategy_set` 与 body 一致、period=M5、status=running。
- 截图：`config_select.png`。

### C4 反映所选（策略面板 + stock-scoring + MCP）
- 启动后（feed 5s poll 已接线：app bin `SimLiveFeed`）`/api/sim-live/strategies` 派生自会话选集：
  - strategy-panel 文本：「双均线交叉 当前最强：161226 50 hold」「MACD 金叉/死叉 当前最强：161226 50 hold」；
  - stock-scoring 表格出现所选 3 标的评估行（`sim-score-code-161226/510880/518880`，含最新价/双均线/MACD/RSI/聚合分/信号）。
- MCP（同一 session）：
  - `sim_get_strategy_analysis{session_id}` → evaluations codes=[161226,510880,518880]（覆盖所选）；
  - `sim_get_strategy_signal{session_id, code:518880}` → code=518880 + evaluation 有数据。
- 截图：`config_started.png`、`scoring_selected.png`。

### C5 MCP 带 stock_set/strategy_set 开会话（若可）
- `sim_start_session{name:cfgv-*-mcp-session, period:M5, cash_init:1500000, stock_set:[161226,510880], strategy_set:[dual_ma,ma_rsi], source:mcp}` → session `s_1788787630_8`。
- REST `/state`：stock_set/strategy_set 与请求一致、source=mcp、running。
- 等 feed → `sim_get_strategy_analysis` evaluations 覆盖 [161226,510880]；`sim_get_strategy_signal` code=161226 有数据。
- `sim_stop_session` → `{stopped:true}`（REST 幂等 stop 兜底 200）。

### C6 pageerror / console.error
- `pageerror=0`；导航仅 `/sim-live`（2 次同址，无意外跳转）。
- console 消息（type=error）共 **3 条**，全部为浏览器网络层提示「Failed to load resource: the server responded with a status of 404」、时间戳同刻（页面启动瞬间），对应未运行态 REST 契约 404（`/api/sim-live/state`、`/strategies`、`/orders` 在无运行中会话时返回 404「无运行中会话」——这正是验收 C1「未运行态显示配置面板」的前置状态）。
- **app JS console.error = 0**（`client.ts` 不打日志、store 捕获、React 无报错；运行中会话阶段 0 条 404 提示）。
- 注：验收前提「未运行会话」与「idle REST 404 提示」互斥地共存，故 3 条网络层提示为环境/契约常态，非本特性引入；已在证据中如实分类（`consoleNet404=3, consoleAppErrors=0`）。

## 3 套件结果

| 项 | 值 |
|---|---|
| 用例 | 1（9 steps，~50 断言，全 PASS） |
| FAIL | 0 |
| 崩溃 / core dump | 无 |
| pageerror | 0 |
| app console.error | 0（网络层 idle-404 提示 3 条，见 C6） |

## 4 截图（`/tmp/simlive_config/`，均带 env+time caption 覆盖层）

| 文件 | 内容 |
|---|---|
| `config_panel.png` | 未运行态会话配置面板（chips 列表 + 名称/周期/初始资金输入） |
| `config_select.png` | 已选 3 标的 + 2 策略 chips 高亮 |
| `config_started.png` | 启动后运行中状态 + 策略/评分区反映所选 |
| `config_error.png` | 未选阻断提示「请选择至少一个标的」 |
| `scoring_selected.png`（补充） | stock-scoring 所选 3 标评估行特写 |

caption 格式：`eestock-app 90d1b35d5 · SPA index-DCNiax_d.js · commit 3984e7d · /sim-live · http://127.0.0.1:8081` + 上海时间。

## 5 清理复核（恢复初始 = 运行前基线）

- 清理方式：产品 API stop（spec 内幂等 stop + 兜底）→ SQL `DELETE FROM simsession WHERE name LIKE 'cfgv-%'`（级联 result/trades/positions）→ 临时 spec 与 playwright 产物删除；**未 commit、未 stage**。
- 复核结果（= 运行前基线，逐项一致）：

| 表 | 基线 | 复核 |
|---|---|---|
| simsession | 5（ended 3 + running 2 环境自带 stale） | 5（ended 3 + running 2） |
| simsession_result | 3 | 3 |
| sim_trades | 1 | 1 |
| sim_positions | 1 | 1 |
| backtest_runs | 6 | 6 |
| 自建 cfgv-* 残留 | 0 | 0 |
| /api/sim-live/state（无会话） | 404 | 404 |
| MCP /sse | 200 | 200（mcp_enabled=true） |

- 仓库：tracked 文件无改动、无 staged 文件；临时 spec `web/e2e/_tmp_simlive_config_verify.e2e.ts` 与 `e2e/artifacts/test-results`（本次 playwright 产物）已删除。

## 6 结论与残余风险

- **PASS**：配置面板存在 / chips 多选（标的 44、策略 7）/ 校验阻断不 start / start-session body 含 stock_set+strategy_set（UI 与 MCP 双通道）/ 运行后策略面板 + stock-scoring 反映所选 / MCP signal+analysis 返回所选数据 / pageerror=0。
- 残余风险（观察项，非本特性缺陷）：
  1. 部署版评分来自 feed 首根 bar 单次评估（最新 bar ts 不变则后续 tick 跳过），当前盘后环境策略分为默认 hold(50)；评分非空且覆盖所选即可证明「反映所选」，真实数值需盘中新 bar 驱动。
  2. 3 条网络层 idle-404 console 提示（见 C6 注）。
  3. 环境 DB 存在 2 条 stale running 会话（app 重启前遗留，非本测试创建），未触碰。
