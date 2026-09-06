# 09-trading / 01 — 交易面板设计 + ADR（Wave 4，pre-implementation，rev-2）

> 状态：**待批复**。真金白银功能，**SPIKE 为强制前置门槛**。
> 依据：`06-web/06-trading.md`(Grill P6 定稿，双路线+Wave4 仅手工交易) + `00-webauto-legacy.md`(旧 webauto 路径整理)。
> **rev-2 吸收了自审发现**：BrokerGateway commit 边界 + 全套安全纪律必须进 ADR（非仅 legacy 文档）。
> 安全：不设交易口令（与全站免认证一致；真金风险已明示，「其他按推荐」视为接受，可随时加会话口令）。

---

## 1. 范围与非目标（Wave 4）
- **做**：手工交易面板——account-card / position-table(现价=本系统行情源，数量成本查券商) / order-form(limit/市价五档) / confirm-dialog(免认证唯一防误触闸，未确认不出单) / order-list(可撤) / trade-list；BrokerGateway 双路线；运行时二选一配置切换；诊断面板接入券商通道健康（各路线探活）。
- **不做（边界，06-trading 定稿 6d-A）**：策略自动下单（信号/风控/熔断另开 Grill+波次）；完整券商撮合（用券商成交回报）；风控引擎。

## 2. 券商双路线（Domain `BrokerGateway`）
| 路线 | 通道 | 技术形态 | 风险 |
|---|---|---|---|
| **A** | 东方财富 CDP | Rust **chromiumoxide** 驱动浏览器（继承旧 webauto 思路） | chromiumoxide 成熟度弱于 go-rod → **spike 必验**（登录态/持仓/下单三关） |
| **B** | 银河证券 QMT/xtquant | **Python sidecar**（IPC HTTP/gRPC） | sidecar 编排；QMT 需**常驻 Windows** 部署约束 |

- 运行时二选一：主用券商由配置决定；诊断面板两路线各自探活。
- feasibility 回退（ADR-012）：A 失败→B 升主；B 环境不可得→A 独撑；双失败→回用户重决策。

### 2.1 BrokerGateway trait（⚠️ **含 commit 边界**，red-line）
```rust
pub trait BrokerGateway: Send + Sync {
  // 只读（每次实时查券商；可激进重试）
  async fn account(&self) -> Result<AccountInfo>;
  async fn positions(&self) -> Result<Vec<Position>>;
  async fn orders_today(&self) -> Result<Vec<Order>>;
  async fn trades_today(&self) -> Result<Vec<Deal>>;
  async fn order_status(&self, order_id) -> Result<OrderStatus>;

  // 写（严格 commit 边界；不透明重放）
  async fn prepare_order(&self, intent: &OrderIntent)   // 安全可重放（校验/组装，无副作用）
      -> Result<PreparedOrder>;
  async fn submit_prepared_order(&self, order: PreparedOrder)  // **越过 commit 边界，不可透明重放**
      -> Result<SubmitResult>;
  async fn cancel_order(&self, order_id) -> Result<CancelResult>;
}
```
> **red-line**：任何重试/恢复逻辑只能发生在 `prepare_order`（安全）；`submit_prepared_order` 之后**禁止透明重放**，未知状态进入 `UnknownCommitState` 走只读对账。**严禁**旧 `SessionGuard` 整流程盲重试。

### 2.2 安全纪律（Non-negotiable，继承旧 webauto 重试架构）
1. 副作用后**不透明重放**；2. 会话恢复≠业务重试；3. 错误**分类**（`ErrorClass`：transient_cdp/session_expired/login_required/captcha_required/selector_changed/validation_failed/market_closed/order_rejected/insufficient_funds/unknown_commit_state/unsafe_to_retry）；4. **持久 OrderIntent**（trading_day+signal/code+side+qty+price_band 幂等键）；5. **UnknownCommitState 一等公民**（无法证明是否已下单 → 只读对账/人工干预）；6. 只读比写更激进重试；7. 可观测性=正确性（结构化日志/trace/审计链）。

### 2.3 订单类型
`OrderDraft{code, side:buy/sell, priceType:limit|market5, price:number|null, qty, estAmount}`（骨架 `TradingGrid` 已定义；`market5` 价格=null）。

## 3. API（web 层）
`GET /api/broker/account`、`GET /api/broker/positions`、`POST /api/broker/orders`(body=OrderDraft，提交=`submit_prepared_order`；`prepare_order` 在 application 层先行)、`GET /api/broker/orders?today=1`、`POST /api/broker/orders/{id}/cancel`、`GET /api/broker/trades?today=1`。
- **position-table 现价**：`GET /api/symbols` latest / WS `{type:"quote"}`（本系统行情快照）与券商 positions 按 `code` 关联；成本/数量查券商。**补入 §7 依赖**（06-trading 待裁决：行情快照端点归入本 ADR §3，作为 position-table 数据源）。
- 前端不自动轮询：进页一次+手动刷新；委托状态 5s×N 轮询至终态即停（`pollIntervalMs=5000`）。

## 4. 前端区域（骨架 `TradingGrid` 已存在可复用）
`account-card` / `position-table` / `order-form` / `confirm-dialog`(未确认不出单) / `order-list` / `trade-list`；深色终端风。`manualOnly=true`、`noTradePassword=true`。

## 5. ⚠️ 强制前置门槛：SPIKE（T0，未过不建面板）
真金白银 + 双路线技术风险 → 先 spike 证明可行，产出报告：
1. A（chromiumoxide）：登录态保持 / 持仓查询 / 下单（**模拟盘/最小额**）三关证据。
2. B（QMT/xtquant sidecar）：QMT 当前环境可否常驻 + IPC 三关。
3. 结论：A/B 谁主用；按 ADR-012 回退；报告入 `coder/report/`。
> 未过 spike ⇒ 不进入 T1+；回用户重决策。

## 6. 阶段（spike 通过后）
- **T1**：`domain::BrokerGateway` trait（含 commit 边界）+ 主用路线实现 + 契约双实现一致性测试（mock 锁死）+ `OrderIntent`/`ErrorClass`/`UnknownCommitState` 模型。
- **T2**：application `BrokerService`(prepare+submit 分离、OrderIntent 持久、对账、错误分类) + web /api/broker/* + 券商通道健康 + app DI。
- **T3**：前端 `TradingPage`(RegionPortal→TradingGrid) + 6 区组件 + 路由 /trading + 导航启用。
- **T4**：E2E（真环境，**模拟/最小额**）+ 部署 + 真实截图。全程 TDD、ADR-007、**测试可复现**（券商走 mock，不真下单除非明确最小额实盘验证）。

## 7. 待用户拍板
| # | 决策 | 推荐 |
|---|---|---|
| T-d-1 | 先 SPIKE(T0) 再建面板 | 是（真金，强制 de-risk） |
| T-d-2 | 主用路线 | 待 spike 结论；先证 A，备 B |
| T-d-3 | 交易口令 | **加会话级口令**（真金更稳，成本低）；或维持不设 |
| T-d-4 | spike 用模拟盘/最小额 | 是（避免实盘误下单；除非明确最小额实盘验证） |
