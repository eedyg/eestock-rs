# ADR-022 — 多周期指标同显框架（路线②：多实例 + 跨图同步）

- 状态：**已裁决（2026-09-14，用户逐项确认：路线② + 5 条口径）**
- 关联：ADR-020（K 线视口=根数）、ADR-021（dcap 镜像产物）、`design/06-web/01-dashboard.md`（实时更新口径）、`design/14-dcap-indicator/**`
- 证据基础（全部实测，非推断）：
  - `tester/test/191_..._feasibility_execution.md` + `tester/evidence/200_multiperiod_feasibility/`（P1–P4）
  - `tester/test/250_multiperiod_route_probe_execution.md`（P7a–P7e，含真渲染）
  - `tester/report/165_ma_candle_pane_root_cause.md`（`isStack` 语义坑根因）
  - `tester/test/068_realtime_4_live_acceptance_execution.md`（④ 实时链路口径）

## 1. 需求

同一页面同时显示**多个周期的指标**（例如 K 线 1m + 指标 1m/5m/15m），而 **K 线只显示所选周期中最小的那个**。
用户裁决的完整口径：

| # | 裁决 |
|---|---|
| 1 | 形态 = **多副图 pane**（A）；**x 轴时间范围与平移/缩放必须同步**；各 pane **独立 Y 轴刻度** |
| 2 | 上限 **4 个 pane**（K 线 1 + 指标最多 3）；指标周期集合 = 全部周期 ∩ {**≥ K 线周期**}（允许等于 K 线周期） |
| 3 | 周期选择：**先选 K 线周期**，再选指标周期；**1w 要、1mo 不要** |
| 4 | **仅单图模式可用**；与现有单周期视图**并存**（开关切换） |
| 5 | 所有周期**共享同一套 8 参数**（只换 period） |
| 6 | 进行中段用**独立 `*_LIVE` 虚线**表示 |
| 7 | 做成**通用框架**：支持将来的任何指标 |
| 8 | 跨图对齐**以时间跨度(ts)为准**（接受可见根数差异与 ≤1 根高周期 bar 误差） |
| 9 | ADR-020（`visible≈viewport_bars`、`barSpace∈[1,50]`）**只在基准图严格**；卫星图只镜像时间跨度，**仅卫星放宽 `barSpaceLimit`** |
| 10 | **1w 仅在基准 ≥ 1d 时开放** |
| 11 | 接受**请求/订阅 ×N**（4 周期 ≤ 每标的每分钟 4 次兜底 + 4 个 WS 订阅），以"仅单图 + ≤4 周期"作护栏 |
| 12 | 每实例布局（高度）**落服务端 config** |

## 2. 决策：**路线②（每周期一个 klinecharts 实例 + 跨图同步）**

### 2.1 两条候选路线（P7 实测对照）

| | 路线① 单实例多 pane + 外部序列注入 | **路线② 多实例 + 跨图同步（采纳）** |
|---|---|---|
| x 轴同步 | ✅ 天然（同实例） | ✅ 需自建原语（P7b 已证可行） |
| 隐藏 K 线 | 不需要 | 需 `state:'minimize'`（P7a 已证可行） |
| 支持"任何指标" | ❌ **每个指标都要前端重实现**并与宿主 Rust 口径对齐（`crates/backtest/src/indicators.rs` 327 行 / 7 个指标） | ✅ **内置与将来的指标全部白送**（P7c：27 个内置在 4 实例零注册可用；DCAP 模板零改动） |
| 值对齐复杂度 | 高：需 `extendData` 注入 + **+1 桶位移** + as-of 对齐 | **低**：每个实例用自己的周期 bar 原生计算 ⇒ **无跨周期值映射、无未来函数风险** |
| 代价 | 每个指标一份前端实现 + 永久的双口径维护 | 自建同步原语 + 跨周期量化误差（≤1 根高周期 bar）+ 1w 退化需限制 + 每实例布局持久化 + 请求/订阅 ×N |

**决策理由**：需求 7（通用框架）是决定性的 —— 只有路线②能让"将来的任何指标"零成本多周期化。且路线②**消掉了**下列全部复杂度：`extendData` 注入、**桶位移（+1 bucket）**、as-of 逐 bar 对齐、本地聚合禁令（本地聚合仅在"把高周期值叠加到低周期轴上"时才成为诱因）。
> 注：P3 的"后端 ts=桶开始 ⇒ 值需锚在桶结束"这条约束在路线②下**不再适用于值映射**（每实例的 bar 就是它自己的桶）；它仅在将来若要做"跨周期值叠加"时重新生效。

### 2.2 结构

```
DashboardPage（单图模式 + 多周期开关）
└── MultiPeriodChartStack                 ← 新增容器（垂直堆叠）
    ├── ChartInstance[base]   : period = 基准（K 线可见；ADR-020 严格成立）
    └── ChartInstance[satellite] ×1..3    : period = 指标周期
        ├── candle_pane: minimize(minHeight:0) + separator:0
        └── indicator pane(s): 复用基准图的指标勾选集合
```

- **每实例一个 `KlineDataFeed`**（既有实现，含 WS 订阅 / 每分钟兜底 / `realtimeStats`），键为 `(code, period)` ⇒ 请求与订阅数为 N×（接受，见口径 11）。
- **指标**：`registerIndicator` 是全局注册 ⇒ 每实例 `createIndicator({name, calcParams})` 即可；dcap 模板**零改动**（每实例用自己的周期 bar 计算）。
- **LIVE 段**：卫星自身的末根 bar 就是"进行中桶"⇒ 额外挂一个 `*_LIVE` 模板/图形，只画**最后一段**（末根与前一根两点）为虚线。

### 2.3 跨图同步原语（`ChartSyncGroup`）

- 公开 API 事实（P7b）：**无 `setVisibleRange`**；可用 `getVisibleRange / scrollToTimestamp / scrollToDataIndex / zoomAt* / setBarSpace / subscribeAction('onScroll'|'onZoom'|'onVisibleRangeChange')`。
- 算法（以时间跨度为准）：交互实例（leader）可见范围变化 → 取 `[realFrom, realTo]` 时间窗 → 对每个卫星：`setBarSpace(clamp(baseSpace × periodRatio, 1, satelliteMax))` + `scrollToTimestamp(centerTs)`；验收口径 = **时间跨度误差 ≤ 1 根高周期 bar**。
- **重入抑制（必须）**：单次滚动即出现 `reentrantCalls=1`（P7b）⇒ 需要 `applying` 标志 + 单向广播（leader→followers），并在应用后一段时间窗内忽略回传事件。
- **barSpaceLimit**：默认 `max=50` 会**静默吞掉**大倍率 ⇒ 卫星实例 `init({layout:{barSpaceLimit:{...}}})` 放宽（基准实例**不改**，ADR-020 不变）。
- **回到最新**：所有实例右端对齐（各自 `scrollToRealTime` 等价动作）。
- **无漂移**：P7b 20 次镜像无漂移，但必须在我们的实现上**重放同一实验**作为门禁（T3）。

### 2.4 框架级硬约束（来自根因取证）

1. **`isStack` 语义坑（P7 根因）**：`createIndicator(value, isStack)` 省略 `isStack` = `false` = **整 pane 替换**（`index.esm.js:14162-14165` 清空该 pane 后 push），但仍返回 `indicator.id`、**零告警**。触发条件 = 同一 pane 上后续再建一个 `isStack=false` 的指标。
   ⇒ **禁止任何代码在 `candle_pane` 上以 `isStack=false` 叠加指标**；框架层封装 `addOverlayIndicator(chart, spec)`：**先按 id `removeIndicator` → `createIndicator(spec, true)` → 断言 `getIndicators({name})` 非空**（失败即抛错，禁止静默）。现存 `KlineChart.tsx`（MA 用 `false`）与 `GridCell.tsx:86` 一并纳入（当前安全只因 candle_pane 上恰好只有 MA）。
2. **零高 pane 副作用**：存在 `minimize` 的 candle pane 时 `getConvertPictureUrl()` 抛 `InvalidStateError` ⇒ e2e/截图**不得使用图表导出**，改用页面截图。
3. **不得回归 ①②③④**：保存配置/切周期不得重置布局；非跟随态不得自动滚动；实时链路口径不变。

### 2.5 周期选择规则（交互）

```
步骤1：选 K 线周期 P0            （全部周期，1mo 不提供）
步骤2：选指标周期 {Pi}            （Pi ∈ 全部周期 ∩ {≥P0} \ {1mo}；若 1w 则要求 P0 ≥ 1d；最多 3 个）
```
- 1w 的附加条件：**P0 ≥ 1d**（避免 1m↔1w 退化：P7b 实测需 barSpace 80640）。
- 1mo：**不提供**（用户裁决）。

### 2.6 后果与代价（知情）

- **请求/订阅 ×N**：4 周期 × 1 标的 = ≤4 次/分钟兜底 + 4 个 WS 订阅；`realtimePoll` 按 `(code,period)` 合并、并发闸 3 ⇒ **跨周期无法合并**（接受）。
- **跨周期对齐是近似**：误差 ≤ 1 根高周期 bar（口径 8）。
- **布局持久化**：每实例高度独立（`setPaneOptions` 每实例、resize 后保持）⇒ 落服务端 config（口径 12）。
- **视觉密度**：每卫星继承基准的指标勾选集合 ⇒ pane 数 = 1 + Σ(卫星数 × 每卫星指标 pane 数)；**需二级护栏**（见 02-spec §7：总 pane 上限）。
