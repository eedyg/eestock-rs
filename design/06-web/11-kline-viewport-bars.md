# ADR-020 — 看板默认 K 线视口：口径由「交易日数」改为「K 线根数」

- 日期：2026-09-13
- 状态：**已批准**（用户拍板 2026-09-13：默认 120 根 / 范围 30–600 / **不做旧值兼容** / 主图+宫格统一 / resize 重算）
- 关联：`design/99-decisions-log.md`（本 ADR 条目）、`design/06-web/01-dashboard.md`、`design/06-web/08-settings.md`、`design/07-app-plane/00-web-api.md`
- 取代：coder/report/101（viewport_days 立项）、102–106（部署/重试/可见性补丁）；旧口径遗留问题见 §1

---

## 1. 问题与证据（为什么必须改口径）

用户报告：**「默认 K 线视口只影响 15m，其他周期不响应」**。静态审查调用链
`GET /api/config/kline → DashboardPage.viewportDays → KlineDataFeed.pageSize → KlineChart.fitBarSpace → klinecharts`，
确认**不是读取/持久化问题**（该项已由 coder/report/103 修复），而是**单位语义 + barSpace 硬夹取**两层叠加。

### 1.1 证据链（可复核）

| # | 位置 | 事实 |
|---|---|---|
| E1 | `web/src/features/dashboard/feed.ts:8-25` | 配置单位是**交易日**：`defaultPageSizeForPeriod(period, days) = BARS_PER_TRADING_DAY[period] × days`（1m=241、5m=49、15m=17、1h=5、1d/1w/1mo=1）→ **同一配置值在不同周期等于完全不同的根数**（2 天 = 482/98/34/10/2/2/2 根） |
| E2 | `web/src/features/dashboard/KlineChart.tsx:247-255` | 初始可见根数由 barSpace 反推：`space = clamp(round(W/target), 1, 50)`，`target = 每日bar数×days` |
| E3 | `web/node_modules/klinecharts/dist/index.esm.js:13249` | `_layoutOptions.barSpaceLimit = {min: 1, max: 50}`（**引擎硬限**） |
| E4 | `web/node_modules/klinecharts/dist/index.esm.js:13667` | `setBarSpace` 越界**直接 return**（静默，无告警、无回调） |
| E5 | `web/node_modules/klinecharts/dist/index.esm.js:13534` | `visibleBarCount = _totalBarSpace / _barSpace` → 可见根数 = `W / space` |

由 E2–E5 得：**可达可见根数区间 = [W/50, W]**（W ≈ 主图 pane 宽度）。target 落在区间外的周期，
配置被静默夹死、随配置值**完全不动**。

### 1.2 量化复现（W ≈ 980px：`DashboardGrid.tsx:45` `min-w-[1280px]` − `symbol-list w-60`(240) − y 轴 ≈60）

| 周期 | days=2（旧默认） | days=8（用户配置） | 有效响应区间 | 现象 |
|---|---|---|---|---|
| 1m | space 2 → ~490 根 | space 1 → 980 根（饱和） | 仅 days 1–3 | ≥4 天完全不动；且 `241×days > 1000` 撞后端 `MAX_LIMIT` |
| 5m | space 10 → ~98 | space 3 → ~327 | days 1–16 | 响应，但 space 取整 → 台阶粗糙 |
| 15m | space 29 → 34 | space 7 → 140 | days 1–40（最宽） | **唯一全程有响应**（且是默认周期） |
| 1h | 夹死 50 → ~20 | ~122 | days ≥ 5 | 小值不动 |
| 1d/1w/1mo | 夹死 50 → 恒 ~20 根 | 恒 ~20 根 | days ≥ 20 才动 | **1–19 天完全无反应** |

→ 与用户观察「只影响 15m」一致。

### 1.3 同源缺陷（本次一并处置）

- **F2 上限/判空错配**：`feed.ts:120/124` `limit = 241×days` 且 `hasMore = bars.length >= pageSize`；1m 且 days≥5 时单页 1205+ 被后端 `MAX_LIMIT=1000`（`crates/web/src/rest.rs:43`）截断 → `1000 < pageSize` → `hasMore=false` → **深翻被封死**（同时忽略权威游标 `next_before`）。
- **F3 文档/代码不一致**：`DashboardPage.tsx:106`、`KlineConfigPanel.tsx:10`、`api/types.ts:368` 均声明「主图+宫格共用」，但 `GridCell.tsx:31` 硬编码 `pageSize: 120`，宫格根本不读配置。
- **F4 死参数 + 无 resize 重算**：`fitBarSpace(chart, extraPx = 0)` 无调用方传 `extraPx`；无 `ResizeObserver` → 容器宽度变化后 space 不重算（口径改为「根数」后必须重算）。
- **F5 部署级 e2e 口径陈旧**：`web/e2e/dashboard-periods-ma.e2e.ts:40` `INIT_PAGE = {1w:30, 1mo:24, 1d:2, 1m:482}` 与当前 `feed.ts`（1×days）已不一致（1w/1mo 仍是 101 之前的特化值、1d/1m 是 2 交易日值），断言口径必须随本 ADR 统一。

---

## 2. 决策（已批准）

1. **单位**：配置值 = **K 线根数**（与周期无关）。字段 `viewport_days` → **`viewport_bars`**。
2. **默认值**：**120 根**。**取值范围 30–600**（前后端同构）。
3. **不做旧值兼容**：`app_config` key `kline` 仅认 `{"viewport_bars": N}`；旧结构 `{"viewport_days": n}` 视为未配置 → 回默认 120（不写迁移、不折算、不双读）。
4. **统一作用域**：**主图 + 宫格**共用同一 `viewport_bars`（宫格不再硬编码 120）；回测区间弹窗 `ScopedKlineFeed` 不读配置，固定 `SCOPED_VIEWPORT_BARS = 120`。
5. **视口与周期解耦**：删除 `BARS_PER_TRADING_DAY` / `defaultPageSizeForPeriod` / `DEFAULT_KLINE_VIEWPORT_DAYS`；`KlineDataFeed.pageSize = viewportBars`（与 period 无关）。
6. **尺寸自适应**：容器宽度变化（`ResizeObserver`）重算 barSpace，保持「可见 ≈ N 根」；**用户手动缩放/平移后不再重算**（沿用库内既有约定「手动缩放 → 停止跟随最新」，`design/06-web/01-dashboard.md:322`）；`followLatest` 回到 true（「回到最新」）时恢复跟随并重算。
7. **夹取语义**：`barSpaceForViewport(width, bars) = clamp(round(width / bars), 1, 50)`（klinecharts `barSpaceLimit`）；30–600 在受支持布局（`min-w-[1280px]` → 主图 ≈980px、宫格 ≈470px）下恒可达（可达区间 [19, 980] ⊃ [30, 600]），夹取仅为**安全网**，触发时留痕（§5 观测性）。
8. **D7（附带处置，2026-09-13 架构裁决）分时 Tab 与视口解耦**：`TimeshareChart.tsx:32` 原以 `new KlineDataFeed({period:'1m'})` 取数（旧隐式 pageSize = `241×2 = 482` ≈ 全天）；口径改后沿用默认将变为 `120` 根 ≈ 半个交易日 → `computeTimeshare`（仅取当日 1m）会**丢半天分时线**。属**回归**（分时图无「视口」语义，改「默认K线根数」不应影响分时 Tab），故新增意图命名常量 **`TIMESHARE_1M_BARS = 500`**（必须 ≥ 241 = 一个交易日 1m bar 上限，留缓冲）并显式注入分时 feed；**不**接 `viewport_bars`。（否决：挪用 `PAGINATION_BATCH` —— 语义重载；跟随配置 —— 功能回归。若产品后续要求分时也随配置，改此一处即可。）
9. **E3（附带处置，2026-09-13 架构裁决）e2e 口径统一范围扩至 §1.3 F5 全量**：除 §4.3 E1 点名的 `dashboard-periods-ma.e2e.ts` 外，`kline-matrix.e2e.ts`、`dashboard-state-consistency.e2e.ts`、`embedded-charts.e2e.ts` 亦硬编码旧「2 交易日」口径（含分时 `limit=482`），同属 F5 缺陷类；留下必红 spec 会污染部署门禁并掩盖真回归 → 一并统一（**仅限断言口径**，断言值须从同一事实源推导并在注释声明来源）。

### 2.1 为什么 bar 数口径能同时消掉 F1/F2/F3
`space = clamp(round(W/N), 1, 50)` 与周期无关 → 1d/1w/1mo 不再恒夹 50、1m 不再恒夹 1；
`pageSize = N ≤ 600 < MAX_LIMIT(1000)` → F2 的截断路径不可达；宫格与主图同 N → 视野密度一致（F3）。

---

## 3. 接口契约（Interface Contract）

### 3.1 后端（`crates/web/src/settings.rs`）

```rust
pub const DEFAULT_KLINE_VIEWPORT_BARS: i32 = 120;
pub const MIN_KLINE_VIEWPORT_BARS: i32 = 30;
pub const MAX_KLINE_VIEWPORT_BARS: i32 = 600;

/// GET/PUT /api/config/kline 响应/请求体（app_config key "kline"）。
pub struct KlineConfigDto { pub viewport_bars: i32 }   // serde：缺字段/非整数 → 反序列化失败

/// 纯函数：整数 30..=600；失败返回描述性错误（handler err(400, e)）。
pub fn verify_kline_viewport_bars(viewport_bars: i32) -> Result<(), String>
```

- `GET /api/config/kline`：读 `app_config[kline]` + `serde_json::from_value::<KlineConfigDto>`
  - 命中 → `{"viewport_bars": n}`；**缺键 / 解析失败（含旧 `{"viewport_days":n}`）/ 值越界 → `{"viewport_bars":120}`**（`tracing::warn!` 留痕，同现有实现）。
  - **无旧值兼容逻辑**（不读 `viewport_days`、不折算）。
- `PUT /api/config/kline`：body `{"viewport_bars": n}`
  - `30 ≤ n ≤ 600` → 写库 → 200 回显；`n ∉ [30,600]` → 400（描述性 message）；缺字段/非整数 → 400（`kline 请求体非法：...`）。
- 路由、`K_KLINE` 键名、`app_config` 结构均不变（无迁移）。

### 3.2 前端

```ts
// web/src/features/dashboard/feed.ts
export const DEFAULT_KLINE_VIEWPORT_BARS = 120;
export const MIN_KLINE_VIEWPORT_BARS = 30;
export const MAX_KLINE_VIEWPORT_BARS = 600;
export interface KlineDataFeedDeps { /* ... */ viewportBars?: number; pageSize?: number /* 显式覆盖优先，保留给测试/特化 */ }
export class KlineDataFeed { get viewportBars(): number /* deps.viewportBars ?? DEFAULT */ }
// 删除：BARS_PER_TRADING_DAY、defaultPageSizeForPeriod、DEFAULT_KLINE_VIEWPORT_DAYS、deps.viewportDays
// 保留：PAGINATION_BATCH / paginationBatchForPeriod（深翻批量，与视口无关）

// web/src/features/dashboard/barSpaceFit.ts（新模块：主图/宫格共用，DRY）
export function barSpaceForViewport(width: number, viewportBars: number): number | null;   // 纯函数，可单测；width<=0 → null（不设置 barSpace）
export function fitBarSpaceToViewport(chart: Chart, el: HTMLElement | null, viewportBars: number):
  { space: number; clamped: boolean } | null;   // width<=0 → null（不设置）；夹取时 console.warn 留痕
export function useBarSpaceFit(opts: { elRef; getChart: () => Chart | null; viewportBars: number; enabled: () => boolean }): void; // ResizeObserver

// KlineChartFeedLike（KlineChart 最小面）：viewportDays → viewportBars
// KlineChartProps 不变（仍从 feed 读）；fitBarSpace 内部改为 barSpaceForViewport + useBarSpaceFit
// GridCellProps += viewportBars?: number（缺省 DEFAULT_KLINE_VIEWPORT_BARS）；feed 传 viewportBars（不再 pageSize:120）
// DashboardPage：readViewportBars(api)（沿用 3 次重试 + 500ms/1s 退避 + focus/visibility 重读），传给 KlineChart 与 GridCell
// TIMESHARE_1M_BARS = 500（D7：分时图当日 1m 全时段，必须 ≥ 241；与 viewport_bars 解耦）
// TimeshareChart.tsx：new KlineDataFeed({ ... period:'1m', pageSize: TIMESHARE_1M_BARS })，不传 viewportBars
// ScopedKlineFeed：readonly viewportBars = SCOPED_VIEWPORT_BARS(120)；pageSize 改用 paginationBatchForPeriod(period)

// web/src/api/types.ts   KlineConfigDto { viewport_bars: number }
// web/src/api/client.ts  saveKlineConfig(viewportBars: number)
// web/src/api/mock.ts    assertKlineViewportBars（30..600，非整/越界 → ApiError 400）；缺省 120
// web/src/features/settings/KlineConfigPanel.tsx  MIN 30 / MAX 600 / DEFAULT 120；标签「默认K线根数」
```

### 3.3 不改动（非目标）
- `getKline` 契约（`before`/`limit`/`next_before`）与 `MAX_LIMIT=1000`：`pageSize ≤ 600`、`PAGINATION_BATCH ≤ 500` → 截断路径不可达；不引入前端旁路缓存（localStorage 等）。
- 后端路由、`app_config` 结构、`design/04-storage` schema。
- 回测弹窗业务语义（仅初始铺满目标由「2 交易日」→ 固定 120 根；其 `loadBefore` 批量由 `defaultPageSizeForPeriod` → `paginationBatchForPeriod`，1m 482→500 / 15m 34→220 / 1d 2→250，深翻更快）。

---

## 4. TDD 规格（Red 清单，先红后绿）

> 纪律：每条先写失败测试（Red 证据 = 失败输出），再最小实现转绿，最后在测试保护下重构。
> **R1 是本次缺陷的复现测试**（旧实现必红）。

### 4.1 后端（`cargo test -p eestock-web`）
- **B1** `kline_viewport_bars_validation`：30/120/600 → Ok；29/601/0/-1 → Err（边界 30、600 必须含）。
- **B2** `kline_config_dto_roundtrip`：`{"viewport_bars":120}` 序列化/反序列化等价；`{"viewport_bars":120.5}` 反序列化 Err。
- **B3** **旧结构不兼容**：`app_config[kline] = {"viewport_days":8}` → GET 返回 `{"viewport_bars":120}`（非 136、非 8）。
- **B4** HTTP（`crates/web/tests/api_settings.rs`）：GET 无记录 → 120；PUT 200 → 回显 + 再 GET 一致；PUT 29 / 601 → 400；PUT `{"viewport_days":8}` → 400（缺 `viewport_bars`）。

### 4.2 前端纯函数（`vitest run`）
- **R1（缺陷复现）** `barSpaceFit.test.ts`：W=980 时 `barSpaceForViewport(980, 120)` 对 **1m/5m/15m/1h/1d/1w/1mo 得同一 space**（周期无关）；旧实现下 1d/1w/1mo 恒为 50、1m 恒为 1 → 本条在旧代码必红。
- **R2** 取值边界：`(980, 30) → 33`、`(980, 600) → 2`、`(470, 120) → 4`（宫格）；越界安全网 `(980, 10000) → 1`、`(980, 1) → 50`；`width ≤ 0 → null`（不设置 barSpace）。
- **R3** feed 解耦：`KlineDataFeed({period, viewportBars:200})` → `loadInitial` 请求 `limit=200`，**1m/15m/1d 全 200**；`viewportBars` getter 缺省 120；显式 `pageSize` 仍优先。
- **R4** 配置读取：`readViewportBars` 首次失败 → 退避 → 重试成功（沿用既有 3 次/500ms/1s 语义）；耗尽 → 调用方兜底 120。
- **R5** 面板/契约：`KlineConfigPanel` 标签「默认K线根数」；29/601/非整 → 保存禁用；PUT 用 `viewport_bars`；`mock` 越界 → 400。
- **R6** 组件接线：`DashboardPage` mount 读 `{viewport_bars:200}` → 主图 feed `limit=200` **且 GridCell 收到 `viewportBars=200`**；`KlineChart` 用 `feed.viewportBars` 驱动 `setBarSpace`。
- **R7** resize 语义：容器宽度变化（触发 `ResizeObserver` 回调）→ 重新 `setBarSpace`（新宽度）；**用户手动缩放后 resize 不再重算**；`followLatest` 回到 true → 重算并 `scrollToRealTime`。

### 4.3 部署级 e2e（更新口径，`web/e2e`）
- **E1** `dashboard-periods-ma.e2e.ts`：`INIT_PAGE` 全周期 = `viewport_bars`（默认 120）；1w/1mo/1d/1m 首请求 `limit=120`；`BATCH` 维持 `PAGINATION_BATCH`（1w 150 / 1mo 80 / 1d 250 / 1m 500）。
- **E2** 视口回归：1d 与 1m 在**同一配置值**下初始可见根数同阶（读 DOM `data-viewport-fit` 属性，见 §5），证伪「只有 15m 有反应」。
- **E3（D7/E3 附带处置新增）** 口径统一范围（断言值必须从同一事实源推导 + 注释声明来源）：
  - `dashboard-periods-ma.e2e.ts` `INIT_PAGE` 全周期 = `DEFAULT_KLINE_VIEWPORT_BARS`(120)；`BATCH` 维持 `PAGINATION_BATCH`。
  - `kline-matrix.e2e.ts`（:260 初始 limit → 120；:362 分时 `limit` → `TIMESHARE_1M_BARS`）。
  - `dashboard-state-consistency.e2e.ts:50`（各周期初始 limit → 120）。
  - `embedded-charts.e2e.ts:677`（分时 `limit` → `TIMESHARE_1M_BARS`；「DB 当日报文对账」分母须同步或改稳健断言并注明理由）。
  - 分时专项：`TimeshareChart.test.tsx` 必须断言「分时取数 limit ≥ 241」且「不随 `viewport_bars` 变化」（解耦回归，能捕获 482→120 退化）。

---

## 5. 可观测性（每模块 ≥2 项）

- **Logs**：`fitBarSpaceToViewport` 发生夹取（raw space ∉ [1,50]）→ 一次结构化 `console.warn({width, viewportBars, space, clamped})`（按 chart 实例去重，不刷屏）；后端 GET 回退默认 → `tracing::warn!(error)`（已有）。
- **Traces/Artifacts**：图表根节点暴露 `data-viewport-fit='{"bars":120,"space":8,"visible":122,"clamped":false}'`（单图与宫格同构）→ e2e 与人工排查可直接断言，替代像素猜测。
- **Metrics**：不在本次范围（前端无指标通道）。

---

## 6. 风险与取舍

- 默认 120 根 ≠ 旧默认（15m 34 根）：初始更密（@980px 约 8px/根）。**用户已拍板**。
- 1m 视口 120 根 ≈ 半个交易日（旧 482 = 2 天）：初始加载量下降（更省），深翻靠 `PAGINATION_BATCH(1m=500)`。
- 删除 `BARS_PER_TRADING_DAY` 使「视口 = N 天」的心智彻底消失；面板文案同步改为「根数」，不提供「按周期折算天数」提示（避免重新引入歧义）。
- 手动缩放后 resize 不重算：与库内既有「手动缩放→停止跟随」一致；如需强制归一，用户可点「回到最新」。
