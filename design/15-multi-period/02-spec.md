# 多周期指标同显 — 规格与接口契约

> 依据：`01-adr.md`（ADR-022，路线② + 12 条口径）。测试：`03-test-plan.md`。派单：`04-implementation-plan.md`。
> 术语：**基准实例** = 显示 K 线的最小周期图表；**卫星实例** = 只显示指标 pane 的高周期图表。

---

## 1. 组件与职责

| 组件 | 职责 | 备注 |
|---|---|---|
| `MultiPeriodChartStack`（新） | 垂直堆叠基准 + 卫星实例；高度分配与拖拽；多周期开关 | 仅单图模式挂载 |
| `ChartSyncGroup`（新） | 注册 N 个 chart 实例；时间跨度对齐；重入抑制；回到最新 | 无 UI |
| `addOverlayIndicator(chart, spec)`（新） | **唯一**允许在 `candle_pane` 叠加指标的入口 | 见 §4.3（硬约束） |
| `MultiPeriodPeriodPicker`（新） | 两步选择（先 K 线周期，再指标周期）+ 规则校验提示 | 复用 Toolbar 既有样式 |
| `multiPeriodStore`（新） | 运行态（启用/周期集合/高度/同步统计） | 与既有 dashboard store 并列 |
| 既有 `KlineChart` / `KlineDataFeed` / `realtimePoll` / dcap 模板 | **复用，不重写** | 每实例一份 feed |

## 2. 配置契约（服务端）

落既有 `ConfigStore`/`app_config`，**key = `multi_period`**（无需迁移，先例：`kline`/`dcap`）。

```jsonc
{
  "enabled": false,              // 多周期开关（默认关 ⇒ 行为与现状完全一致）
  "periods": ["1m", "5m", "15m"],// 首个元素 = 基准（K 线）周期；其后 = 卫星指标周期
  "heights": { "1m": 420, "5m": 180, "15m": 180 }, // 每实例高度 px（含基准）
  "indicators": ["dcap"]         // 卫星继承的指标集合（首版：dcap；通用框架下逐项扩展）
}
```

- 端点：`GET/PUT /api/config/multi_period`（形状照 MA/dcap 三层：`dto` 校验 + `rest` 端点 + `ConfigStore`）。
- **校验（PUT 严格 400，GET 坏值回默认不 500）**：
  1. `periods[0]`（基准）∈ 全部周期 \ {`1mo`}；
  2. 卫星 `periods[i>0]` ∈ 全部周期 \ {`1mo`} 且 **≥ 基准**；
  3. **若 1w 出现，则基准必须 ≥ 1d**（口径 10）；
  4. **总周期数 ≤ 4**（口径 2）；
  5. `heights` 键必须与 `periods` 一致，每值 ∈ [80, 1200]；
  6. `indicators` ⊆ 受支持集合（首版仅 `dcap`），去重；
  7. 去重后周期不重复。
- 与 `GET /api/config/dcap` 的关系：多周期**不新增参数**，共用同一套 8 参数（口径 5）。

### 2.1 基准周期规则（架构裁决 2026-09-14，方案 A）

```
basePeriod = enabled && periods.length > 1 ? periods[0] : 工具栏/state.period
```

- **只有实际存在卫星（`periods.length > 1`）时，基准周期才由配置决定**（即 `periods[0]`，与用户口径 5「先选 K 线周期」一致）；
- **单周期配置（`length === 1`，即启用但未选卫星）不得改变任何现状行为** —— 不新增订阅/取数/实例、`init` 不递增（即 P1 已验证的等价性契约）；**不得静默改写用户工具栏选的 K 线周期**；
- 当基准周期**因配置而被覆盖**（`length > 1` 且 `periods[0] !== state.period`）时，必须**显式可观测**（如 `basePeriodOverridden: true` + 基准周期来源字段），**禁止静默不一致**；待 P5 两步选择器落地时，由选择器同时写 `periods[0]` 与 `state.period` 来消除该状态。

## 3. 同步契约（`ChartSyncGroup`）

### 3.1 API

```ts
interface SyncMember { id: string; chart: Chart; period: Period; isBase: boolean; }
class ChartSyncGroup {
  constructor(members: SyncMember[]);
  /** 任一成员发生 onScroll/onZoom/onVisibleRangeChange → 以时间跨度对齐其余成员 */
  start(): void; stop(): void;
  /** 全部成员右端对齐（"回到最新"） */
  scrollAllToLatest(): void;
  /** 应用卫星的 barSpaceLimit（仅卫星；基准不动） */
  applySatelliteLimits(): void;
}
```

### 3.2 对齐算法（以**时间跨度**为准，口径 8/9）

1. leader 可见窗 `[realFrom, realTo]`（时间戳）→ 目标跨度 `span = realTo - realFrom`；
2. follower：**barSpace 用「实测密度比 D」而非名义周期比**（P0.3 实测：非连续序列下名义比不成立 —— 1d↔1w 名义 7 而实测 D≈4.67）：
   `barSpace = clamp(baseBarSpace × D_effective, 1, followerMaxSpace)`；`scrollToTimestamp(center)`；
   **实测锚定表**（P0.3，pane 宽 520px，误差=两侧日历跨度差）：

| 组合 | 名义比 | 实测 D | @baseBS=8 误差 | 卫星可见 bar @baseBS=50 | 判定 |
|---|---|---|---|---|---|
| 1m→5m | 5 | 4.7 | +3 min | 3 | ✅ |
| 1m→15m | 15 | 12.2 | +28 min | 2 | ⚠️ baseBS>21 时退化 |
| 1m→1h | 60 | 37.8 | +58 min | 1 | ❌ baseBS>7 时退化 |
| **1d→1w** | 7 | **4.67** | **+4,320 min（+0.43 周 bar）** | 3 | ✅（必须用密度比） |
| 1h→1w | 168 | 24 | +1,980 min | 1 | ❌ baseBS>11 时退化 |
| 1m→1d / 1m→1w | 1440 / 10080 | 120.5 / 无重叠 | 失效 | 1 | ❌ 恒退化 |

3. **卫星 `barSpaceLimit.max` 必须放宽**（默认 50 会**静默吞掉**大倍率：实测 req 350 被忽略、零告警）：建议 **max = 350**（1d→1w 实测需 satBS≈42–45 px/bar，即 ≈5.0×baseBS）；**放宽仅作用于卫星，不得泄漏到基准**（实测：req 60/350/5000 在基准读回仍为 50）。
4. **新增硬约束（P0.3 发现）：卫星可见 bar ≥ 2**。口径 8 的"跨度差 ≤1 根高周期 bar"在退化状态（卫星仅 1 根 bar）会被**虚假满足**（实测 0.54–1.00 周 bar）⇒ 不得只看跨度判据。
5. **降级策略（用户裁决 2026-09-14，方案 1：诚实降级 + UI 标注）**：当推导出的 `satBS > paneWidth/2`（即无法容纳 ≥2 根 bar）时：
   - 卫星取「能容纳 **≥2 根** 的最大 `barSpace`」（而非推导值），**右端对齐**；
   - 该 pane 显示角标「**对齐受限**」（含当前跨度与目标跨度的差异提示），**hover/点击给出原因**（当前基准缩放过大 ⇒ 请缩小基准图或改选周期）；
   - **严禁静默虚假对齐**：不得因为"跨度判据恰好通过"就隐藏该状态；实测中该状态的可观测字段（如 `syncDegraded: true` + 跨度差）必须可从页面/日志读出。
6. **可信实现要点（P0.3 遗留）**：① 索引窗按 ts 窗二分求解（名义比不成立）；② `satBS ≫ pane 宽` 时 `getVisibleRange()` 会返回 **NaN**，需显式降级；③ 高倍率缩入误差被整段休市缺口支配（1m↔5m @bs1 实测 1095 min）⇒ 按 ts 窗对齐边缘而非按根数；④ 右偏移镜像须按倍率换算；⑤ 密度表需静态回退（无重叠或卫星 ≤1 bar 时估计器失效）。
7. **验收口径**：对齐后两侧时间跨度差 **≤ 1 根高周期 bar**（例：基准 1m、卫星 15m ⇒ ≤15 分钟）**且卫星可见 bar ≥ 2**（两条必须同时成立，P0.3 实测单看跨度会被退化状态虚假满足）；若因基准缩放过大而无法同时满足 ⇒ 走第 5 条降级策略并标注；
8. 基准实例**始终**满足 ADR-020（`visible ≈ viewport_bars`，`barSpace ∈ [1,50]`）；卫星 `barSpaceLimit.max` 取第 3 条的实测锚定值（**350**），不得用名义比启发式。

### 3.3 重入抑制（必须，P7b 实测 `reentrantCalls=1`）

- `applying` 标志 + **单向广播**：仅"用户交互源"实例作为 leader，其余为 follower；
- 应用同步后**忽略**短窗（实现取 ≥1 帧/16ms）内自 followers 回传的可见范围事件；
- 门禁：T3 必须证明"20 次镜像后无漂移、且无回声循环"（可观测计数 `syncApplied`/`syncSuppressed`）。

### 3.4 隐藏 K 线（卫星，P7a 唯一可行手段）

```
chart.setPaneOptions({ id: 'candle_pane', state: 'minimize', minHeight: 0 });
chart.setStyles({ separator: { size: 0 } });
```
- `height:0` 会被静默忽略（`index.esm.js:15421` 守卫）⇒ **必须用 `state:'minimize'`**；
- 副作用：零高 pane 存在时 `getConvertPictureUrl()` 抛 `InvalidStateError` ⇒ **禁止在 e2e/截图里用图表导出**，改页面截图（口径 §8「不做」）。

## 4. 指标契约

### 4.1 每实例复用基准的指标勾选集合

- 基准图勾选 `{MA, MACD, KDJ, BOLL, DCAP}` ⇒ **每个卫星都渲染同样的集合**（各自独立 pane），这就是"通用框架"：**注册表新增任何指标，多周期自动支持**（P7c：27 个内置在 4 实例零注册可用）。
- dcap 模板**零改动**（每实例用自己的周期 bar 计算）⇒ **路由② 下不存在跨周期值映射、无未来函数风险**（ADR-022 §2.1）。

### 4.2 LIVE 段（进行中桶）

- 卫星的末根 bar **就是**进行中桶 ⇒ 额外一个 `*_LIVE` 模板/图形，只画**最后一段**（末根与前一根两点）为虚线；已收盘段为实线。
- 一般规则（口径 4 的延伸）：**数据源不提供进行中桶的周期（实测 `1d`）不画 LIVE 段**。
- ⚠️ 未证实项（定时探针 `multiperiod-forming-bucket-live-probe` 明天 09:35 给结论）：**进行中桶是否随分钟更新** ⇒ 直接决定 LIVE 段的实时体感；若"只在桶边界跳"，必须在 UI 上如实标注。

### 4.3 框架级硬约束：`addOverlayIndicator`（P7 根因）

```ts
/** 唯一允许在 candle_pane（或任何已有指标 pane）叠加指标的入口。 */
function addOverlayIndicator(chart: Chart, spec: IndicatorCreate, expectName: string): void {
  chart.removeIndicator({ name: expectName });        // 显式移除旧实例
  chart.createIndicator(spec, true);                  // 必须 isStack=true（追加语义）
  const ok = chart.getIndicators({ name: expectName }).length > 0;  // 断言非空
  if (!ok) throw new Error(`指标 ${expectName} 未生效（isStack 语义坑）`);
}
```
- **禁止**任何代码在已有指标的 pane 上以 `isStack=false`/省略 `isStack` 创建指标（`index.esm.js:14162-14165` 会**静默清空该 pane**，且 `createIndicator` 仍返回 id、零告警）；
- 现存违规点一并整改：`KlineChart.tsx`（MA 走 `false`）、`GridCell.tsx:86`；
- 回归测试必须覆盖"静默消失"（T7）。

## 5. 数据契约

- 每实例一个 `KlineDataFeed({api, ws, code, period, viewportBars})`（既有实现）；
- 取数：每周期 `GET /api/kline?period=P&limit=viewport_bars + warmup(P)`（warmup 仅当该实例显示 dcap：`n_l+m−1`）；
- 实时：每实例订阅 `bar:{code}:{period}`（P7c/④ 既有链路，零改动）；
- 每分钟兜底：`realtimePoll` 按 `(code,period)` 合并、并发闸 3 ⇒ **N 个周期 = N 个 key，不跨周期合并**（口径 11 已接受）；
- **预算护栏**：多周期模式仅单图 + 总周期 ≤4 ⇒ 每标的每分钟 ≤4 次兜底、≤4 个 WS 订阅；
- **禁止本地聚合**（口径：P4 实测本地 1m 聚合与后端高周期仅 50/208 桶一致）——每周期必须直接取后端 bar。

## 6. 布局契约

- 每实例高度 = 容器高度（`heights[period]`，默认基准 420 / 卫星 180）；拖拽分隔条调整并**持久化到 config**（口径 12，防抖写）；
- 复用既有 `[data-region="sub-chart"]` 的教训：**叠加分隔条由我们自己的容器渲染，不再由锚点 border 提供**（① 修复契约）；
- 与 ②③ 的交互：**保存 dcap 参数 / 切周期 / 切标的均不得重置任何实例高度**（T9）。

## 7. 护栏（必须实现为硬校验）

1. 多周期仅在**单图模式**可用（宫格模式隐藏开关并强制关闭）；
2. 总周期 ≤ **4**；
3. 卫星周期 **≥ 基准**，且不含 `1mo`；含 `1w` 时基准须 ≥ `1d`；
4. **总 pane 数上限 ≤ 12**（= 基准 1 + Σ卫星的指标 pane 数）：**计数必须基于「归一化（去重）后」的 `indicators` 集合**（P1-C D1 实测：按原始数组长度计数会把语义等价的 `["dcap"]×11` 误判为 23 pane）；超限时**明确报错并拒绝保存**（不静默截断），且错误信息**必须包含被拒维度名**（`indicators`/`pane`）；
   - 注：v1 受支持指标仅 `dcap` 且去重后 ⇒ 总 pane ≤ 4，**HTTP 层在 v1 无法构造 >12**（P1-C 已反证：未去重时的 400 是假象）；故该护栏先以 `web::dto` 纯函数测试守护，**P2 起受支持指标集合扩张后必须补 HTTP 级负例**。
5. 关闭多周期开关 ⇒ **完全回到现状**（单实例、单周期），不得有残留实例/订阅/请求。

## 8. 明确不做（本轮范围外）

- `1mo` 周期（用户裁决）；
- **宫格内的多周期**（口径 4）；
- **跨周期值叠加**（把高周期指标值画到低周期轴上）—— 路线② 不需要它；若将来需要，ADR-022 §2.1 注记的"桶位移/as-of"约束将重新生效；
- 本地聚合替代高周期 bar；
- 图表导出截图（`getConvertPictureUrl` 在零高 pane 下抛错）。

## 9. 可观测性

- 每实例 `KlineDataFeed.realtimeStats`（既有）+ 聚合面板：每周期 `lastSource/lastWriteAt/lastPollOkAt/pollFailures`；
- 同步统计：`syncApplied` / `syncSuppressed`（重入抑制次数）/ 最近一次对齐误差（分钟）；
- 失败可见：任一卫星初始化失败必须**可见报错**（不得静默降级为单图）。
