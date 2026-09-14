# 272 — P3-A 红测试设计报告：T3（G1 同步无漂移）/ T4（回到最新 + 尊重手动视口）/ T8bis（诚实降级 + 角标）

- **本文件路径**：`tester/design/272_p3_sync_red_design.md`
- 角色：Tester（设计 + 落地红测试；**未改任何产品代码**）
- 时间：2026-09-14（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `ec32767`；P0/P1/P2 已入库；工作树干净）
- 权威依据：`design/15-multi-period/{01-adr.md §2.3, 02-spec.md §3, 03-test-plan.md T3/T4/T8bis, 04-implementation-plan.md P3}`
- 实测锚定（**本轮未重新发现**，直接引用）：
  - `tester/test/260_p03_barspace_anchor_execution.md`（P0.3：密度比表 1m→5m 4.7 / 1m→15m 12.2 / 1m→1h 37.8 / 1d→1w 4.67 / 1h→1w 24；卫星上限 350；越界静默；NaN；I3–I6）
  - `tester/evidence/250_multiperiod_route_probe/p7b2_result.json`（P7b：单次滚动 `reentrantCalls=1`）
- 配套执行报告：`tester/test/272_p3_sync_red_execution.md`；证据目录：`tester/evidence/272_p3_red/`
- 本轮**不含**：LIVE 虚线段（P4）、高度拖拽持久化（P5）、配置面 400 负例（P1 已覆盖）

---

## 1. 分层策略（本轮的「真实 klinecharts vs 桩」边界）

| 层 | 手段 | 承担 |
|---|---|---|
| L1 库事实/几何/事件 | **真身 klinecharts 10.0.3**（`web/tester/p3-sync-harness/`，`file://` + UMD，0 网络） | 右缘对齐事实、重入事实、密度比 vs 名义比判别力、越界静默、降级 barSpace 可读性、密度估计器失效面 |
| L2 行为/契约（**红**） | jsdom + 忠实桩 `src/test/syncChartStub.ts` | `ChartSyncGroup` 的 T3/T4/T8bis 全部判据 + 边界（NaN 降级、上限不足、不泄漏到基准） |
| L3 纯函数（**红**） | jsdom（无桩） | 密度表/估计器/降级取整/右偏移换算/组合护栏的精确数值 |
| L4 页面级 DOM（**红**） | `DashboardPage` + 同步桩 | T8bis-④/⑤「对齐受限」角标出现/消失 + 跨度差可读（端到端链路） |

> **G4 同类声明（沿用 03-test-plan §1）**：产品级**真实渲染**驱动（Vite + 产品组件）留待 P3-C 独立验收
> （参照 `tester/design/271_p2c_independent_harness_design.md`）。本轮的 Playwright harness 是**库事实**仪器，
> 与 P2-A 的 `p2-satellite-harness` 同一性质 ⇒ **当前为绿**；**产品级断言全部落在上面的红测试里**。

---

## 2. 钉死的接口契约（实现方须满足；除此不新增约束）

### 2.1 模块 `web/src/features/dashboard/chartSyncGroup.ts`

```ts
export interface SyncMember { id: string; chart: Chart; period: string; isBase: boolean }
export interface ChartSyncGroupOptions {
  satelliteMaxBarSpace?: number;   // 默认 350（P0.3 锚定）
  reentrySuppression?: boolean;    // 默认 true；false = **反向证据旋钮**（生产不得用）
  densityTable?: Record<string, number>;
}
export interface SyncStats {
  applied: number;                 // 成功对齐次数
  suppressed: number;              // 重入抑制（丢掉的跟随者回传事件）次数
  echoEvents: number;              // 跟随者回传**被处理**（镜像回来）的次数 ⇒ 正常必须 0
  lastSpanDiffMinutes: number | null;   // 最近一次对齐的两侧日历跨度差（分钟）
  degraded: boolean;               // T8bis「对齐受限」
  degradedPeriod: string | null;   // 退化的卫星周期（正常 null）
}
export class ChartSyncGroup {
  constructor(members: SyncMember[], options?: ChartSyncGroupOptions);
  start(): void; stop(): void;
  scrollAllToLatest(): void; applySatelliteLimits(): void;
  readonly stats: SyncStats;
  onChange(cb: (stats: SyncStats) => void): () => void;
}
export function densityRatio(base: string, sat: string): number | null;
export function estimateDensityRatio(i: { baseBarCount: number; satBarCount: number }): number | null;
export function resolveDensityRatio(base: string, sat: string, measured: number | null):
  { ratio: number | null; source: 'measured' | 'static' | 'none' };
export function alignSatelliteBarSpace(i: { baseBarSpace: number; density: number; paneWidthPx: number; maxBarSpace: number }):
  { idealBarSpace: number; barSpace: number; degraded: boolean; degradedReason: 'base-zoom' | 'limit' | null; visibleBars: number };
export function mirrorRightOffsetPx(baseOffsetRightPx: number, spaceRatio: number): number;
export function isSyncCombinationAllowed(base: string, sat: string): boolean;
```

**语义（判据口径）**

1. `stats.echoEvents`：**跟随者**（`isBase:false`）回传的 `onScroll/onZoom/onVisibleRangeChange` 被**处理**（即反向镜像）的次数。
   抑制开启时这类事件被丢弃并计入 `suppressed`（⇒ `echoEvents === 0`）；抑制关闭时被处理（⇒ `echoEvents > 0`）。
   **两侧判据都要成立**（关掉抑制却没有回声 = 抑制是空操作 ⇒ 红；开着抑制却仍有回声 = 未抑制 ⇒ 红）。
2. `alignSatelliteBarSpace`：`idealBarSpace = round(baseBarSpace × density)`；若 `ideal > floor(paneWidth/2)`
   （容不下 ≥2 根）⇒ `barSpace = floor(paneWidth/2)`、`degraded = true`、`degradedReason = 'base-zoom'`；
   若 `ideal > maxBarSpace`（卫星上限不足）⇒ 取 `maxBarSpace`、`degraded = true`、`degradedReason = 'limit'`；
   `visibleBars = floor(paneWidth / barSpace)`（退化时必须 ≥2；**不得**等于 `ideal`）。
3. `densityRatio` 为**静态锚定表**（上表 5 个值 + 同周期 1）；表外（`1m↔1w`、`1m↔1d`、含 `1mo`）返回 `null`，
   **禁止按名义周期比兜底**。`resolveDensityRatio` 在估计器失效时回退静态表并标注 `source`。
4. `isSyncCombinationAllowed`：拒绝 `1m↔1w`、`1m↔1d`、`1h↔1w`、卫星 < 基准、含 `1mo`（口径 10 + P0.3 量化）。
5. **右偏移补偿（本轮实测新增，必须）**：harness F1 实测 `scrollToTimestamp(ts)` 的右缘落点带**默认右偏移**
   （本次实测偏 2 根；P0.3 §6-I6 实测 px 随 barSpace 缩放）⇒ 跨周期右端对齐必须补偿右偏移
   （允许 `setOffsetRightDistance(0)` 或等效按 ts 逐边对齐），断言口径 = 「跟随者 `getOffsetRightDistance() ≤ 1 根自身 bar`」。
6. **pane 宽来源**：`chart.getSize().width`（真实 API；jsdom 由桩提供 520）。宽度 ≤0 ⇒ 不推导、不判降级（保持现状）。

### 2.2 页面级 DOM 契约（T8bis-④/⑤）

```
[data-mp-satellite="<period>"]            （P2 已有）
└── [data-mp-sync-degraded="<period>"]    （新增；仅退化时存在）
      textContent 含「对齐受限」
      title       同时含「缩小基准」与「改选周期」（hover/点击给原因）
      data-mp-span-diff-min = 数字（> 0）
```
非退化 / 用户缩小基准后 ⇒ 该元素**不存在**（不得残留）。

---

## 3. 用例清单（Given–When–Then）

### 3.1 `chartSyncDensity.test.ts`（纯函数，6 例，**红**）

| # | 用例 | 判据（阈值来自实测锚定） |
|---|---|---|
| D1 | 密度表 = 实测 D | `4.7 / 12.2 / 37.8 / 4.67 / 24` 逐一相等；同周期 = 1；`1d↔1w ≠ 7`、`1h↔1w ≠ 168`、`1m↔1w === null ≠ 10080` |
| D2 | 估计器 | `564/120 → 4.7`、`65/14 → 4.642`；卫星 ≤1 根 / 任一侧 0 ⇒ `null` |
| D3 | 静态回退 | 有实测 ⇒ `source:'measured'`；失效 ⇒ 回退静态表 `source:'static'`；表外 ⇒ `ratio:null, source:'none'`；0/NaN 视同失效 |
| D4 | 降级取整 | `8×4.67 → 37`（正常，≥2 根）；`8×37.8=302 > 260` ⇒ `barSpace=260`、`≠302`、`reason='base-zoom'`；上限 100 < 151 ⇒ `reason='limit'`；**反向**：`floor(520/302)=1`（照用推导值必可见 1 根 ⇒ 被「≥2」判据拒绝） |
| D5 | 右偏移按倍率换算 | `(8, 4.67) → 37 ≠ 8`；`(8,1) → 8`；`(64,5) → 320`；`(0,·) → 0` |
| D6 | 组合护栏 | 允许 `1m↔5m / 1m↔15m / 1d↔1w / 同周期`；拒绝 `1m↔1w / 1m↔1d / 1h↔1w / 卫星<基准 / 含 1mo` |

### 3.2 `chartSyncGroup.test.ts`（行为，12 例，**红**）

| # | 用例 | 判据 |
|---|---|---|
| G1 | **T3-1 同周期 20 轮** | 每轮 `sat.getVisibleRange()` 与基准**逐字段相等**、相对偏移 0；`applied ≥ 20`；`suppressed > 0`；`echoEvents === 0` |
| G2 | **T3-2 跨周期**（1m↔5m / 1m↔15m / 1d↔1w） | 跨度差 ≤1 根高周期 bar **且** 卫星可见 bar ≥2；右端差 ≤1 根；`suppressed > 0`；`echoEvents === 0`；非退化组合 `degraded === false`；**右偏移已补偿** |
| G3 | **T3-2 反向（变异必红）** | 同一基准窗用**名义比 7** 推导 ⇒ 跨度差必 >1 根周 bar（密度比 4.67 才达标） |
| G4 | **T3-3 重入抑制双向** | `reentrySuppression:false` ⇒ `echoEvents > 0`；默认 ⇒ `echoEvents === 0` 且 `suppressed > 0` 且严格小于关闭时 |
| G5 | **T3-4 护栏** | `1m↔1w` 组合在构造/`start()` 阶段**抛错**（禁止静默虚假对齐） |
| G6 | **T4-1 回到最新** | 两侧右端 = 各自末根 bar；右端 ts 差 ≤1 根高周期 bar；右偏移已补偿 |
| G7 | **T4-2 尊重手动视口** | 手动平移/缩放后追加新 bar（两侧）⇒ 两侧视口**逐字段不变**、`applied` 不增、无回声 |
| G8 | **T8bis ①–⑤** | 退化：`barSpace=260 ≠ 302`、可见 ≥2、右端对齐、`degraded/degradedPeriod` 可读、`lastSpanDiffMinutes ∈ (0, 60]`、`onChange` 广播；缩小基准 ⇒ `barSpace=151`、`degraded=false`、跨度差 ≤1 根 |
| G9 | 边界 NaN 降级 | 推导 1512 ≫ pane：组必须给 `260` 且视口非 NaN；**仪器证明**：硬塞 1512 时桩返回 NaN ⇒ 再次交互被拉回可读视口 |
| G10 | 边界 上限不足 | 卫星上限 50、推导 113 ⇒ 必须取 50 并**显式降级**（默认 50 静默吞掉是 P0.3 §2.3 的坑） |
| G11 | 边界 不泄漏到基准 | 基准始终被 `barSpaceLimit{1,50}` 夹紧（req 350/5000 读回仍 50）；卫星 req 350 生效（仅卫星） |
| G12 | `stop()` 零残留 | 停止后基准滚动不再镜像，`applied` 不增 |

### 3.3 `multiPeriodSyncBadge.test.tsx`（页面级 DOM，2 例，**红**）

| # | 用例 | 判据 |
|---|---|---|
| B1 | 退化 → 角标 → 缩小 → 消失 | 基准 `setBarSpace(8)` ⇒ 卫星桩 `barSpace === 260`、可见 ≥2；`[data-mp-satellite="1h"] [data-mp-sync-degraded="1h"]` 出现、文案含「对齐受限」、`title` 含「缩小基准」「改选周期」、`data-mp-span-diff-min > 0`；`setBarSpace(4)` ⇒ 卫星 `151`、角标**消失** |
| B2 | 反向（锁「不得静默」） | 退化状态必须能从页面读出（角标 + 跨度差），无角标即红 |

**桩/仪器要点**：`src/test/syncChartStub.ts` 复刻 `getBarSpace().bar` / `setBarSpace` 越界**静默** / `scrollToTimestamp` = 右缘 /
索引空间 `getVisibleRange` / `getOffsetRightDistance = 8×barSpace` / `satBS ≫ pane ⇒ NaN`；
数据追加**不触发事件**（新 bar 到达不是用户交互）。页面级用例同时把 `clientWidth` 打桩为 520（两种宽度读法都须可判定）。

### 3.4 `web/tester/p3-sync-harness/`（真身 klinecharts，14 检查，**绿 = 库事实**）

F1 右缘对齐事实（实测偏 2 根）· F2 处理器内写 API ⇒ 嵌套事件（重入）· F3 密度比 20/20 轮达标注 + 无漂移 +
可见 ≥2 + **名义比 20/20 轮全不达标**（最小 15 天 > 7 天）· F4 越界静默 + 仅卫星放宽 · F5 降级 barSpace 可读且 ≥2
（附：本配置未复现 NaN，P0.3 §6-I3a 在 1m↔1d/1w 复现 ⇒ 如实记录，不作门禁）· F6 密度估计器（正常可算 / 无重叠失效 / 窗内 ≤1 根失效）。

---

## 4. 与 `02-spec.md` 的两点口径澄清（**需架构师确认，非阻塞**）

1. **§3.2 步骤 2 的 `scrollToTimestamp(center)` 与库事实不符**：真身 `scrollToTimestamp(ts) = scrollToDataIndex(binarySearchNearest(ts))`
   （`index.esm.js:15639-15641`）⇒ 落点是**右缘**而非居中；且实测带默认右偏移。本轮测试按 **P0.3 §6-I3「按 ts 窗对齐边缘」**
   落地（右缘基准 + 右偏移补偿），即 §3.2 的 `center` 表述按实测修正为**边缘对齐**。
2. **卫星 `barSpaceLimit` 无运行时设置 API**（`index.d.ts` 只有 `layout.barSpaceLimit`，无 `setBarSpaceLimit`）⇒ 放宽必须在
   **卫星 `init({layout:{barSpaceLimit:{max:350}}})`** 完成（`applySatelliteLimits()` 的语义 = **校验并在不足时显式降级**，
   不得静默）。本轮测试据此：桩按 init 选项建模；上限不足 ⇒ 必须 `degraded:true`（G10 / 页面级用例）。

---

## 5. 覆盖目标与反向证据

- **T3**：同周期逐字段相等（20 轮）+ 跨周期 3 组 ×（跨度差/可见根数/右端/抑制/无回声）+ 名义比反向 + 护栏。
- **T4**：回到最新（右端 + 右偏移）+ 手动视口不被新 bar 拉回 + `stop()` 零残留。
- **T8bis**：①–⑤ 全部有断言（含页面级角标）；反向 = 「照用推导值」在纯函数层被 `floor(520/302)=1` 直接否定、
  在行为层被「barSpace ≠ 推导值 + 可见 ≥2」两条同时否定。
- **反向证据（不得缺）**：G3（名义比）、G4（抑制关闭/开启双向）、D4/G9（照用推导值 / NaN）、G10（静默吞掉）、B2（无角标即静默）。
- **不做**：不改产品代码；不做调参凑绿；不测 P4/P5 范围；不重复 P1 的配置面负例。

---

## 6. 产物清单

| 文件 | 类型 | 当前状态 |
|---|---|---|
| `web/src/test/syncChartStub.ts` | 新增测试基建（忠实同步桩） | 已落地 |
| `web/src/features/dashboard/chartSyncDensity.test.ts` | 新增红测试（6 例） | **6 failed** |
| `web/src/features/dashboard/chartSyncGroup.test.ts` | 新增红测试（12 例） | **12 failed** |
| `web/src/features/dashboard/multiPeriodSyncBadge.test.tsx` | 新增红测试（2 例） | **2 failed** |
| `web/tester/p3-sync-harness/{harness.html,run.mjs}` | 新增真身 klinecharts 库事实仪器（14 检查） | 14 PASS / 0 网络 |
| `tester/evidence/272_p3_red/` | 证据（红输出、全量回归、harness JSON/PNG、tsc） | 已产出 |

**未做**：未改任何产品代码/接口/架构；未 `git add/commit/stash`；未跑 tangle；未重启线上（PID 3112540）；0 写请求。
