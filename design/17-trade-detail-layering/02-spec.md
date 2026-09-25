# 02-spec — 接口契约变更（ADR-027 + ADR-028，「结果载荷 v2」批次）

> 配套：`design/01-architecture/adr/ADR-027-trade-detail-two-level-round-trip-model.md`（L1/L2 与回合口径）、
> `ADR-028-result-visualization-position-ratio-and-window-sync.md`（持仓比率、时间窗联动、跳转）。
> **本文档是实现契约唯一出口**：任何实现与本文不一致 = 违约，须先改本文。
> 修订既有文档的责任见 `04-implementation-plan.md` §7。

> **实施状态：已落地（P0–P6，2026-09-20）。** 本批次已按 §1–§9 实现并验收；落地清单、逐阶段证据与验收结论索引见
> `design/17-trade-detail-layering/05-status.md`。验收（tester 闸门 3）结论：R/U/C/S/F 段通过，E 段（后端契约 + 恒等式 I1/I3/I4 + 持仓序列 + 前端 tsc/vitest）通过，
> E1–E4 真渲染（Playwright）由 P5c 补齐并通过（`web/e2e/adr028-window-sync.e2e.ts`，证据 `coder/evidence/20260920_adr027_p5c_e2e/`）。
>
> **与本文的偏差项（已实现，已单独登记，待闸门 1 裁决/追认）**：
> 1. **§4.2 `/curve` 响应多一个 `recorded: bool`**（本文 §4.2 信封未列）。理由：§4.1 的 `legacy_single` 路径无 `position` 列时须「读侧回空 + 正确 recorded」；
>    §5.6/D11 又要求全局自述完整性，而 §4.2 信封无字段可区分「零持仓」与「未记录该序列」。**纯加法**（既有键名/语义/顺序未变）。
>    申报见 `coder/evidence/20260920_adr027_p3_app_api/report.md` §5。
> 2. **§7 `KlineChartProps` 除 `onVisibleRangeChange` 外新增两个【可选】prop**：`windowCommand` / `onWindowApplied`。理由：ADR-028 D4 要求「程序化写窗 + 断言成功 + 失败显式报错」，而结果页 K 线实例无既有写窗通道；两者皆可选，不传时零行为。
>    申报见 `coder/evidence/20260920_adr027_p5b_frontend_window/report.md` §4.2。
>
> **非违约登记项（形状不对称/退化边界，不影响验收）**：
> - **§7 前端 `WorkbenchRunFill` 未含 `code`**：后端 `/fills` 元素已含 `code`（§5.4，读径注入 = run 的 symbol）；前端类型保持 §7 的最小增量集（多余键忽略）。`coder/evidence/20260920_adr027_p4c_consistency/report.md` §7.3 已登记。
> - **`aggregate_round_trips` 退化分组 `open_price = 0.0`**：仅可能来自 `rt_seq = 0` 的孤儿卖出分组（无买入），**正常路径不可达**；若要改 `Option<f64>` 属 ABI 二次变更（未获授权）。`coder/evidence/20260920_adr027_p1a_types_aggregation/report.md` §4 迁移点 4。

---

## 1. Domain 类型契约

### 1.1 成交事实（L2 的**唯一**事实源）

引擎在成交时刻产出，逐笔携带全部金额与归属：

```rust
/// 一笔成交（事实）。费用三件套必须由撮合点写入，禁止下游复算（ADR-027 D4）。
/// `code` 为必需字段：L1（TradeDetail.code）的取值来源，同时是聚合的分组键。
pub struct FillFact {
    pub code: String,         // 标的（回测=run 的 symbol；sim-live=会话内标的）
    pub rt_seq: u32,          // 回合序号（ADR-027 D6）：由 assign_rt_seq 统一分配，聚合函数只分组不重编
    pub bar_index: usize,     // **真实 bar 序号**（禁 ts/bar_sec 反算）
    pub ts: i64,
    pub side: OrderSide,      // Buy | Sell（**定义在 backtest crate**；strategy-core 以 pub use 再导出）
    pub qty: f64,
    pub price: f64,           // 成交有效价（含滑点）
    pub trade_value: f64,     // = qty × price
    pub commission: f64,      // 本笔佣金（含最低佣金）
    pub stamp_duty: f64,      // 本笔印花税（买入恒 0）
    pub reason: FillReason,   // Policy | StopTrigger | ForceClose | Manual
}
```

**类型归属（架构裁决）**：`OrderSide` 唯一定义在 `backtest`；`strategy-core` 以 `pub use backtest::OrderSide;` 再导出 ⇒ 消费方（application/simlive/web 层）路径零改动；
**硬约束**：迁移前后 serde 形状逐字节不变（外部标记 `"Buy"`/`"Sell"`），须有往返测试锁定。
`FillReason` 四值定义在 `backtest`；engine 侧 `OrderReason` 保留并加 `From<OrderReason> for FillReason`；sim-live 的 `source` 映射为 `Manual`/`Policy`。

**硬约束**：`commission`/`stamp_duty`/`trade_value` 必须来自引擎实算（`FeeModel::buy/sell` 的返回值），
**禁止**由 `(side, qty, price)` + fee 配置复算 —— `fee.rs:90-98` 最低佣金分支 `trade_value = budget − 5.0`
先减后除，复算不保证逐位相等（ADR-027 §1 F10）。

### 1.2 回合（L1）

```rust
pub struct RoundTrip {
    pub rt_seq: u32,
    pub code: String,             // 新增字段：sim-live 多标的必需；回测填 run 的 symbol
    pub status: RoundTripStatus,  // Open | Closed
    pub open_ts: i64, pub close_ts: Option<i64>,
    pub open_bar: usize, pub close_bar: Option<usize>,
    pub shares: f64,              // Σ 买入 qty（= Σ 卖出 qty，当 Closed）
    pub buy_count: usize, pub sell_count: usize,
    /// 加权有效买价（**不含费**）= Σ_buy trade_value / Σ_buy qty（Open 回合恒有值：开仓必有买入）
    pub open_price: f64,
    /// 加权有效卖价（**不含费**）= Σ_sell trade_value / Σ_sell qty；
    /// **无任何卖出 ⇒ None**（禁止造 0）；有部分卖出（Open 态）⇒ Some(该加权价)
    pub close_price: Option<f64>,
    pub gross_value: f64,         // Σ 卖出 trade_value
    pub commission: f64,          // Σ 买入佣金 + Σ 卖出佣金
    pub stamp_duty: f64,          // Σ 卖出印花税
    pub pnl: Option<f64>,         // Closed ⇒ Some(精确值)；Open ⇒ None（**禁止**造数）
    pub hold_bars: Option<usize>,
    pub reason: Option<String>,   // 清仓那一笔的来源（ForceClose/StopTrigger/Policy；Open ⇒ None）
    pub l2_count: usize,          // = 本回合成交笔数（供 D8 懒加载摘要）
}
```

### 1.3 唯一聚合实现（DRY 硬约束）

```rust
/// 回合序号分配：**全系统唯一实现**（ADR-027 D6）。
/// 规则：买入且当时无持仓 ⇒ 新序号；持仓中的任何成交 ⇒ 当前序号；卖出使持仓归零 ⇒ 终结当前序号。
/// 引擎在线分配与 sim-live 回放分配**都必须**调用本函数（禁止各自实现）。
pub fn assign_rt_seq(fills: &mut [FillFact]);

/// 逐笔成交事实 → 回合列表。**全系统唯一**的回合聚合实现（ADR-027 D7）。
/// 回测引擎、sim-live 结算与运行中读路径、审计端点必须**全部**调用本函数，禁止第二处实现。
/// **不重编号** rt_seq（只按 (code, rt_seq) 分组求和）；
pub fn aggregate_round_trips(fills: &[FillFact]) -> Vec<TradeDetail>;
```

**输出顺序**：按每个 `code` 内首个成交在输入中的位置升序；`code` 内部按 `rt_seq` 升序。
（原设计中的 `initial_capital` 入参已删除：本轮聚合不消费它，KISS，不留死参数。）

输入要求：`fills` 按 `(code, 到达顺序)` 有序（回测天然有序；sim-live 按 `sim_trades.id` 升序）。

---

## 2. 聚合口径（数学定义 + 恒等式）

对 `Closed` 回合：

```
gross_value  = Σ_sell trade_value
commission   = Σ_buy commission + Σ_sell commission
stamp_duty   = Σ_sell stamp_duty
invested     = Σ_buy (trade_value + commission)      // 买入总成本（含佣金）
proceeds     = Σ_sell (trade_value − commission − stamp_duty)
pnl          = proceeds − invested                   // 精确值，**无成本分摊**（见下）
shares       = Σ_buy qty ;  hold_bars = close_bar − open_bar
```

**关键简化（消除原有歧义）**：全回合口径下 `pnl` 是**整回合的现金流差**，**不需要**对部分卖出做成本摊薄或 FIFO 归属
⇒ 原先「部分卖出只摊薄、已实现部分不进账本」的缺陷被口径本身消掉（ADR-027 D1）。

对 `Open` 回合（仅 sim-live 可能出现）：`pnl = None`；只披露 `gross_value`/`commission`/`stamp_duty`/`shares`
（**禁止**给出未定义语义的盈亏数）。未实现部分由持仓视图承担。

**恒等式（验收用）**：

- **I1**：`Σ_fills ∈ RT` 逐字段加总 == 该 RT 的 `gross_value/commission/stamp_duty`（字段级对账，逐回合）。
- **I2**：`Σ(L2 行 trade_value/commission/stamp_duty) == L1 同名字段`（UI 末行累计 == L1 行）。
- **I3**（跨侧一致）：`nav[-1] == initial_capital + Σ_closed(pnl) + Σ_open(gross_value − invested + position_value_at_last_bar)`，
  容差 `1e-6 × max(1, |nav|)`（浮点累加，容差必须在测试中显式声明）。
- **I4**：`Σ distinct(rt_seq) == round_trips.len()`；`ForceClose` 终结的回合数 == `audit.round_trips_force_closed`。
- **I5**（D12 新增；**L2 派生列**）：`status='Closed'` 且**全平**（卖出股数覆盖全部买入股数）的回合 ⇒ **末笔「累计已实现盈亏」== L1 `pnl`**（容差 = 既有 `rt_reconcile.tolerance` 相对口径 `tol × max(1,|l1|)`）。
  数学依据：`Σ sell_pnl = Σ 卖出净收入 − Σ 被消耗成本`；全平时被消耗成本总额 == 买入含费总成本 ⇒ 恰等于 `proceeds − invested` = L1 `pnl`。
- **I6**（D12 新增；**语义保护**；**2026-09-26 由独立复验更正字面口径**）：① **首笔卖出之前**的所有买入行 ⇒ `cum_realized_pnl === 0`（防「净投入」伪装成已实现盈亏，即原始缺陷的防线）；② **买入不改变** `cum_realized_pnl`（买入行的值恒等于其**前一笔卖出行**的值）⇒ **首笔卖出之后**的买入行显示**当前累计**已实现盈亏，**可正可负**。
  - ⚠️ 原文「买入行不得为负 / 恒 0」**已作废**：活库 465 回合 / 2108 条买入行中 `<0` 共 6 条、`>0` 共 94 条（反例：`sr_1790349931388_000024::1` idx8 = −1305.7911539369234）—— 买入行只是承载**回合累计值**，与「不造数」无矛盾。

### 2.1 L2 派生列口径（D12，移动加权平均成本；**display-only**）

> 权威裁定：ADR-027 §2.14（D12）。**修订** §2.10 **Q9b**（原「不引入成本对手方 / lot 归属列」的结论被用户诉求覆盖；其「不得造第二事实源」的担忧由本节口径消解）。

**递推（含费；L2 事实字段为准，禁复算费用）**：

```
买入：qty += q ; cost_total += trade_value + commission ; unit_cost = cost_total / qty
卖出：consumed = q × unit_cost（unit_cost 不因部分卖出而改变）
      sell_pnl = (trade_value − commission − stamp_duty) − consumed
      sell_pnl_pct = sell_pnl / consumed        // consumed == 0 ⇒ null
      qty −= q ; cost_total −= consumed
派生：position_cost_incl_fee = qty > 0 ? cost_total / qty : null   // “该笔成交后”口径
越卖（q > qty）：sell_pnl = null、sell_pnl_pct = null、**累计不累加**、qty/cost_total 夹到 0（**不造数**）
```

**列集**：`持仓成本`（`position_cost_incl_fee`）、`本笔卖出盈亏`（`sell_pnl` + `sell_pnl_pct`）、`累计已实现盈亏`（`cum_realized_pnl`，**D12 重定义**）、`累计净现金流`（`cum_cashflow`，= D12 之前的 `cum_realized_pnl` 算法**一字不改**）。

**硬约束**：① 实现为**单一纯函数**（`web/src/features/workbench/roundTripAccum.ts`），前后端 L2 表共用；② **display-only**：不得回灌绩效 / 对账 / 审计，I2 的输入仍是**事实字段**（对账 `pnl` 字段的 L2 侧取 `cum_cashflow` 末值）；③ 不引入 FIFO / lot 重算（不造第二事实源）；④ UI 列名必须带限定词，裸用「累计盈亏」视为违约。

---

## 3. `rt_seq` 契约

1. `rt_seq` 为**整数序号**，per `(run_id 或 session_id, code)` 单调递增，从 1 开始。
2. 语义：买入且当前无持仓 ⇒ **新回合**（`rt_seq+1`）；持仓中的任何买入/卖出 ⇒ **当前回合**；卖出使持仓归零 ⇒ **终结当前回合**。
3. `round-trip` 与 `fill` 之间的归属**只能**由 `rt_seq` 决定：**禁止** `[open_bar, close_bar]` 窗口推断
   （ADR-027 D6；零长回合 `open_bar == close_bar` 是合法且必须正确归属的形态）。
4. 回测期末强平（`ForceClose`）终结最后一个回合 ⇒ 回测侧所有 `rt_seq` 均为 `Closed`。

---

## 4. 结果序列契约

### 4.1 新增可抽样曲线 kind

```
ResultKind::Position   // 点形状：{"ts": i64, "qty": f64, "position_value": f64, "cash": f64,
                       //           "nav": f64, "position_ratio": f64}
```

- 由引擎在**净值压入点**同步写入（`engine.rs:819-824` 处已同时持有 `cash` 与 `qty × close`）。
- **可抽样**（与 `net_value` 同级），但必须披露 `downsampled`/`original_bars`；不得混入 `fills` 的「禁止抽样」白名单。
- sim-live 侧在 `simlive.rs:807` 的序列生成点同步产出；多标的聚合：`position_value = Σ_code(qty × latest)`、`cash` = 会话现金、`nav = cash + position_value`。

### 4.2 `/curve` 时间窗（ADR-028 D3）

```
GET /api/workbench/runs/{id}/curve?kind=<per_bar|net_value|drawdown|position>&k=<n>&from_ts=<i64>&to_ts=<i64>
200 { kind, points, downsampled, original_bars, k,
      window_from_ts: i64|null,   // 回显（缺省 = 全区间 ⇒ null）
      window_to_ts:   i64|null,
      window_bars:    i64 }       // 窗口内原始根数（抽样前）—— 采样的分母
```

- 缺省无窗口 ⇒ **完全向后兼容**（全区间，行为与今日一致）。
- 窗口内**重新采样**（`k` 作用于窗口内点集），保证放大后仍有细节（禁止前端裁剪已取点）。
- `fills` 依旧**不可**进入本端点（`is_sampleable()` 白名单不变）。

**持仓比率口径（冻结，禁裸用「持仓比率」）**：

| 量 | 定义 | 分母 |
|---|---|---|
| `position_value` | 持仓**市值**（bar close / latest 计价） | 时点值 |
| `position_ratio` | `position_value / nav`（`nav ≤ 0` ⇒ `0`） | **时点市值 / 时点净值** |
| `cash_ratio` | `1 − position_ratio`（UI 并列披露） | 同上 |

**消歧强制**：`position_ratio`（时点/时点）与 ADR-026 的 `deployed_pct`（**区间累计**敞口/初始资金）、
`cash_consumed_pct`（区间累计资金占用/初始资金）是**三个不同物**：字段名、UI 标签、文档三处都必须带分母说明。

---

## 5. HTTP 契约

### 5.1 `/result`（`trades` 元素形状 v2）

字段见 §1.2。**语义变更（非新增）**：`gross_value`/`commission`/`stamp_duty`/`pnl` 由「端点口径」改为「全回合口径」。
因 ADR-027 D3 清空历史，**不提供旧语义兼容**；无历史 run 可读。

### 5.2 新增 L1 列表（懒加载首屏）

```
GET /api/workbench/runs/{id}/round-trips?offset=&limit=
200 { run_id, total, recorded, has_more, next_offset,
      round_trips: [ RoundTrip, ... ] }        // 含 l2_count / buy_count / sell_count
```

### 5.3 新增 L2 切片

```
GET /api/workbench/runs/{id}/round-trips/{rt_seq}/fills?offset=&limit=
200 { run_id, rt_seq, total, has_more, next_offset, fills: [ FillFact, ... ] }
404 当 rt_seq 不属于该 run（禁止空数组冒充「无成交」）
```

### 5.4 `/fills` 增量

- 元素增字段：`code`、`rt_seq`、`trade_value`、`commission`、`stamp_duty`。
- 增可选过滤 `round_trip=<rt_seq>`；既有 `offset/limit/recorded/has_more/next_offset` 不变。
- **过滤语义（冻结，消除「200 空 vs 404」歧义）**：`round_trip` 指向**不存在的 rt_seq** ⇒ **404**（与 §5.3 对称）；存在但无成交不可能发生（回合必有至少一笔），故 200 空数组不出现。
- **校验失败必须返回结构化错误信封（JSON）**，禁止纯文本 400（含非数字 `rt_seq` 等参数形态错误）。
- 注：特此补上 `code`（闸门 2 发现 L-1：L2 切片带 `code` 而 `/fills` 元素不带 ⇒ 同一事实源两种形状）。

### 5.5 `/audit` 增量（逐回合自洽）

```
+ round_trips_closed: usize
+ round_trips_open:   usize             // 回测恒 0
+ rt_reconcile: { checked: usize, mismatched: [rt_seq, ...], tolerance: f64 }
```

`mismatched` 非空 ⇒ UI **必须**显式告警（ADR-027 D10），不得静默按 L1 渲染。

### 5.6 完整性契约（ADR-027 D11，**全局**）

任何列表型响应必须自述完整性：`total` +（涉及事实源时）`recorded` + `has_more`/`next_offset`，
或显式 `truncated` 标记。**UI 不得静默展示不完整数据**。K 线标记的 5000 首页缺口（`useRunSeries.ts:176`）在本批次一并整改为「分页拉全 + 显式披露」。

---

## 6. MCP 契约

| 工具 | 变更 |
|---|---|
| `bt_get_run_result` | `trades` 元素 = v2 形状（同 §5.1） |
| **`bt_get_run_round_trips`** | 新增：L1 列表（分页，同 §5.2） |
| **`bt_get_run_round_trip_fills`** | 新增：L2 切片（同 §5.3） |
| `bt_get_run_curve` | 增 `from_ts`/`to_ts`，响应含 `window_*` 回显 |
| `bt_get_run_fills` | 元素增 `rt_seq`/费用三件套；增 `round_trip` 过滤 |
| `bt_get_run_audit` | 增 §5.5 字段 |
| **sim-live** | 新增「运行中 L1/L2」读能力（同 §5.2/5.3 形状，键为 `session_id`+`code`） |

---

## 7. 前端类型契约（`web/src/api/types.ts`）

- `Trade` → 拆为 `RoundTrip`（§1.2）与 `RoundTripFill`（§1.1）；`status: 'Open'|'Closed'`。
- `WorkbenchRunFill` 增 `rt_seq`/`trade_value`/`commission`/`stamp_duty`。
- `CurveResponse` 增 `window_from_ts`/`window_to_ts`/`window_bars`；`kind` 增 `'position'`。
- **`KlineChartProps` 增可选回调**（ADR-028 G1）：

```ts
/** 可见时间范围变更（索引→ts 由图内部经 dataList 转换）。可选 ⇒ 既有调用方零影响。 */
onVisibleRangeChange?(r: { from_ts: number; to_ts: number; from_idx: number; to_idx: number }): void;
```

- 结果页建图时**必须**传 `barSpaceLimit`（放宽，供宽窗口跳转）；**该放宽不得泄漏到看板基准图/宫格**（ADR-020 严格）。

---

## 8. DB 契约

- **`sim_trades`**：新增 `commission float8 NOT NULL DEFAULT 0`、`stamp_duty float8 NOT NULL DEFAULT 0`；
  保留 `fee` 列（语义 = `commission + stamp_duty`，冗余便于既有查询，列注释写明）。
- **`strategy_run_bars.kind` 的 CHECK 约束必须允许 `position`**（新增 `ResultKind::Position` 后，任何分块 run 都会写该 kind 的块）。
  **若漏改该约束，则所有新回测 run 均会因 check 约束违规而 `status=failed`** —— 这是**既有功能回归级**缺陷（tester 闸门 E 段实测命中），必须与新 kind 同批发布。
- DDL 经 `design/04-storage/schema.md` 的 `{.sql file=migrations/00XX_*.sql}` 块 tangle 生成，**禁止手改 `migrations/` 产物**；
  迁移清单：`0028_sim_trades_fee_split.sql`、`0029_strategy_run_bars_kind_position.sql`。
- **其它**：`strategy_run_result.trades`(jsonb)、`strategy_run_bars.payload`(jsonb) 形状自描述，无需 DDL；新曲线 kind 复用 `strategy_run_bars.kind` 文本列。
- **历史数据**：按 ADR-027 D3 清空（归档 → `TRUNCATE`，保表结构与迁移链；禁 DROP）。

---

## 9. 前端交互契约（ADR-028 D2/D2.1/D4）

1. **唯一窗口事实源**：`ResultWindowState { from_ts, to_ts, span_bars, source, rev }`，页面级持有（**不放** `ChartSyncGroup` 私有态）。
2. **写入者**：`kline`（图内 `getVisibleRange()` → 经 dataList 转 ts）/ `jump`（L1/L2 按钮）/ `reset`（全览、历史回退）。
3. **回声抑制**：程序化写窗后 K 线派发的 `onZoom`/`onScroll` 必须抑制（复用 `programmaticScroll` 模式 + `applying` 标志）；`rev` 单调，响应 `rev` 落后即丢弃。
4. **消费者**：K 线（`setBarSpace` + `scrollToTimestamp`，或 `scrollToDataIndex`；**断言跳转成功** —— `setBarSpace` 越界会静默 return）；SVG 曲线视图（窗口取数 + `mapLineByTs`）。**`mapLine` 语义不变**（3 个既有调用点），新增 `mapLineByTs(pts, domainFrom, domainTo, …)`，x 定义域 = 共享窗口（禁止数据自身 min/max）。
5. **按钮（方案②）**：L1 行 `[明细]`（展开 L2）/`[跳转]`（回合区间）；L2 行 `[明细]`（该笔完整字段）/`[跳转]`（bar 居中 120 根，可配）。**取消隐式整行点击**。
6. **窗口生命周期**（G3）：换 run 重置为全区间；切 Tab 保留；「全览」恢复全区间；历史栈上限 20 步。
7. **节流**（G2）：共享 ~200ms 节流，窗口变化对 3–4 个 kind 并发请求既有 per-kind 端点；**不新增**批量端点。
8. **加载态**：窗口内加载中必须显式标注；失败 ⇒ 显式错误 + 标注「显示的是上一窗口数据」，**禁止**旧数据冒充当前窗口。
