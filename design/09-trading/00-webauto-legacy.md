# 09-trading / 00 — 旧 webauto 实现路径整理（Route A 继承参考）

> 目的：在新 Rust 交易面板（Route A 东财 CDP）动工前，梳理旧 `golang/webauto` 的实现路径与关键教训。
> 来源：`golang/pkg/webauto/*`、`golang/cmd/webauto/*`、`golang/pkg/realtime/*`、`golang/docs/webauto_retry_architecture.md`、scout/reviewer 报告。
> 旧系统是 **Golang**（已被 Rust eestock-rs 取代）；Route A 会**继承其思路**，但浏览器自动化库由 go-rod 换为 **Rust chromiumoxide**，并**必须继承其安全纪律**。

---

## 1. 技术栈与分层
- **浏览器自动化**：`github.com/go-rod/rod`（CDP）+ `rod/lib/launcher`（启动 chrome）+ `rod/lib/proto`（协议）。`core.Browser` / `core.Page` 封装。
- **BrowserConfig**：Headless / SlowMotion / Timeout / UserDataDir / WindowWidth/Height / UserAgent / BrowserPath / **RemoteURL**(如 `ws://127.0.0.1:9222` 远程连接已有浏览器，登录态持久)。
- 目录：`pkg/webauto/core`（浏览器核心）+ `broker/eastmoney`（交易：client/auth/query/trade/order_ops/selectors/session_guard）+ `broker/xueqiu`（行情）+ `captcha` + `cmd/webauto/*`（CLI 入口）。

## 2. CLI 登录路径（cmd/webauto/login.go）
`runLogin` → `loadConfig`(账号/密码/RemoteURL) → `applyBrowserConfig` → `eastmoney.NewClient` → `client.Start()`（连接远程 9222 或启动新浏览器）→ `HandleTimeoutDialog()`（清超时弹框）→ `ReloadPage()` → 再次 `HandleTimeoutDialog()` → `client.Login(account, password)` → 成功截图/设 keepOpen。

## 3. Realtime 双路径（pkg/realtime）
- **读**：`processTick → RealtimeDataCollector.CollectAccountInfo/CollectPositionPrices → SessionGuard.Do → GetBalance/GetPositions`。
- **写**：`RealTradeManager → BrokerTradeExecutor.ExecuteBuy/ExecuteSell → SessionGuard.Do → executeWithRetry → BuyWithOffset/SellWithOffset → poll order / cancel / chase`。
- `position_sync.go`（SyncPositionsToWatchStocks）、`realtime_stock_manager.go`（createAndLoginEastmoneyClient）。

## 4. SessionGuard（**最大教训点**）
`SessionGuard.Do(ctx, op, fn)`：每次 `fn()` → 出错则 `maxRetries` 次重试（**reset tab + re-login + 重跑闭包**），最后失败发 CRITICAL 邮件。**致命缺陷**：把整个**带副作用的交易流程**包在 SessionGuard 里盲重试——若错误发生在「broker 提交/确认点击之后、可靠提取 order id 之前」，重放闭包会**产生重复订单**。

## 5. 重试架构文档（目标架构 —— Route A 必须继承）
**Non-negotiable 原则**：
1. 副作用后**不做透明重放**（无订单/成交对账不得重放交易闭包）。
2. 会话恢复 ≠ 业务重试。
3. 错误必须分类（按 error class + commit state + replay safety 决定重试）。
4. 每笔真实交易需要**持久 OrderIntent**（可恢复/对账/幂等）。
5. **UnknownCommitState 一等公民**（无法证明是否已下单 → 只读对账或人工干预）。
6. 只读操作可比写操作更激进重试。
7. 可观测性 = 正确性（结构化日志/trace/审计链）。

**目标分层**：CLI/Realtime → `TradeIntentService`(持久幂等意图) → `TradeOrchestrator`(交易生命周期状态机+RetryPolicy+ErrorClassifier，唯一允许决定重试) → `BrokerGateway`(语义接口) → `EastmoneyPageAdapter`(页面/选择器/表单/解析，返回 typed 错误) → `BrowserSessionManager`(会话恢复阶梯，不重放副作用交易) → `Rod/Core Browser`。

**BrokerGateway 接口**（关键安全边界）：
```
GetAccount/GetPositions/GetTodayOrders/GetTodayDeals
PrepareOrder(ctx, intent) (*PreparedOrder, error)   // 安全可重放
SubmitPreparedOrder(ctx, order) (*SubmitResult, error) // 越过 commit 边界，不可透明重放
GetOrderStatus/CancelOrder
```

**错误模型**：`ErrorClass` = transient_cdp / session_expired / login_required / captcha_required / selector_changed / validation_failed / market_closed / order_rejected / insufficient_funds / unknown_commit_state / unsafe_to_retry；`BrokerError` 携带 class/operation/message/cause/retryable/safe_to_replay/requires_session_recovery。

## 6. 映射到 Rust Route A（新交易面板）
- **可继承**：登录流程（HandleTimeoutDialog→ReloadPage→Login）、DOM selectors（`selectors.go`）、query/trade/order_ops 的业务逻辑、会话守卫思路。浏览器库换 **chromiumoxide**。
- **必须继承的安全纪律**：`PrepareOrder`(可重放) 与 `SubmitPreparedOrder`(commit 边界，不可透明重放) 分离；持久 `OrderIntent`；`UnknownCommitState` 只读对账；错误分类（ErrorClass）；会话恢复与业务重试分离；结构化日志/审计。**绝不能沿用旧 SessionGuard 整流程盲重试**（重复下单根因）。
- **spike 验证点**（Route A）：chromiumoxide 登录态保持/持仓查询/下单三关——正是旧 go-rod 已验证、需在 Rust 重验的。
