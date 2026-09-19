# 02-spec — 接口契约变更（ADR-027 + ADR-028，「结果载荷 v2」批次）

> 配套：`design/01-architecture/adr/ADR-027-trade-detail-two-level-round-trip-model.md`（L1/L2 与回合口径）、
> `ADR-028-result-visualization-position-ratio-and-window-sync.md`（持仓比率、时间窗联动、跳转）。
> **本文档是实现契约唯一出口**：任何实现与本文不一致 = 违约，须先改本文。
> 修订既有文档的责任见 `04-implementation-plan.md` §7。

---

## 1. Domain 类型契约

### 1.1 成交事实（L2 的**唯一**事实源）

引擎在成交时刻产出，逐笔携带全部金额与归属：

```rust
/// 一笔成交（事实）。费用三件套必须由撮合点写入，禁止下游复算（ADR-027 D4）。
pub struct FillFact {
    pub rt_seq: u32,          // 回合序号（ADR-027 D6）：开仓成交 = 新 seq；加仓/减仓/清仓 = 当前 seq
    pub bar_index: usize,     // **真实 bar 序号**（禁 ts/bar_sec 反算）
    pub ts: i64,
    pub side: OrderSide,      // Buy | Sell
    pub qty: f64,
    pub price: f64,           // 成交有效价（含滑点）
    pub trade_value: f64,     // = qty × price
    pub commission: f64,      // 本笔佣金（含最低佣金）
    pub stamp_duty: f64,      // 本笔印花税（买入恒 0）
    pub reason: FillReason,   // Policy | StopTrigger | ForceClose | Manual
}
```

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
/// 逐笔成交事实 → 回合列表。**全系统唯一**的回合聚合实现（ADR-027 D7）。
/// 回测引擎、sim-live 结算与运行中读路径、审计端点必须**全部**调用本函数，禁止第二处实现。
pub fn aggregate_round_trips(fills: &[FillFact], initial_capital: f64) -> Vec<RoundTrip>;
```

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

- 元素增字段：`rt_seq`、`trade_value`、`commission`、`stamp_duty`。
- 增可选过滤 `round_trip=<rt_seq>`；既有 `offset/limit/recorded/has_more/next_offset` 不变。

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

- **`sim_trades`**：新增 `commission float8 NOT NULL`、`stamp_duty float8 NOT NULL`；
  保留 `fee` 列（语义 = `commission + stamp_duty`，冗余便于既有查询，列注释写明）。
  DDL 经 `design/04-storage/schema.md` 的 `{.sql file=migrations/00XX_*.sql}` 块 tangle 生成，**禁止手改 `migrations/` 产物**。
- **无需其它 DDL**：`strategy_run_result.trades`(jsonb)、`strategy_run_bars.payload`(jsonb) 形状自描述；
  新曲线 kind 复用 `strategy_run_bars.kind` 文本列。
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
