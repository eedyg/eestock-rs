# 276 — P5-A 红测试设计报告：T9（布局持久化）+ 纵向溢出修复（高度分配 / 拖拽 / 持久化 / ADR-020）

- **本文件路径**：`tester/design/276_p5_layout_persistence_red_design.md`
- 角色：Tester（设计 + 落地**红测试**；**未改任何产品代码**，未跑 tangle，未触碰线上）
- 时间：2026-09-15（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `78eb68d`；P0–P3 已入库；工作树干净）
- 权威依据：
  - `design/15-multi-period/04-implementation-plan.md` P5（布局持久化与稳定性）
  - `design/15-multi-period/03-test-plan.md` **T9**（布局持久化与 ②③ 契约）、T12（失败可见，本轮仅覆盖高度面）
  - `design/15-multi-period/02-spec.md` §6（布局契约：每实例高度 = `heights[period]`、拖拽持久化、**我方容器渲染分隔条**、与 ②③ 的交互）
  - `design/15-multi-period/01-adr.md` ADR-020（barSpace = (容器宽度, 根数) 唯一决定）、ADR-022 §3.2 第 7 条（基准永不被同步改写）
  - P2-C 实测锚定：`tester/test/271_p2c_independent_acceptance_execution.md` §9 —— `#main` clientHeight=600 / scrollHeight=**1140** ⇒ **540px 纵向溢出**
- 配套执行报告：`tester/test/276_p5_layout_persistence_red_execution.md`；证据目录：`tester/evidence/276_p5_red/`
- 本轮**不含**：P4（LIVE 虚线段）、配置面 400 负例（P1 已覆盖）、跨图同步（P3 已入库）

---

## 1. 分层策略（几何层的诚实分工）

| 层 | 手段 | 承担 | 本轮状态 |
|---|---|---|---|
| L1 纯函数（逻辑） | vitest/jsdom，无桩 | 高度分配算法：恰好填满 / 直用 / 按比例缩小 / 下限 / 退化可滚动 / 非法值回退 | **红**（模块不存在） |
| L2 组件 DOM（契约） | vitest/jsdom + klinecharts 忠实桩 | 栈与 pane 的 DOM 契约、我方分隔条、拖拽算术、防抖回调、②③ props 不变量、ADR-020 基准不被改写 | **红** |
| L3 页面级（写入路径） | vitest/jsdom + `DashboardPage` + RO 桩 | `PUT /api/config/multi_period`（防抖、单次、字段不被重置）、乐观更新 + 失败回滚、刷新/重进保持、②③（切标的/切周期） | **红** |
| L4 真实渲染几何 | Playwright + Vite 打包**真实产品组件**（`web/tester/p5-layout-harness/`） | **纵向溢出**（`scrollHeight ≤ clientHeight`）、pane 高度之和 == 可用高度、轨迹真实像素高度 | **红**（现状实测溢出） |

> jsdom **无布局引擎**（`clientHeight`/`scrollHeight` 恒 0）⇒ 任何「无溢出」判据在 jsdom 里都是假绿。
> 故本层把「溢出」判据交给 L4（真渲染几何），L1–L3 只判**分配数值/DOM 契约/写入路径**。
> L4 与 P2-C 的 `271` harness 同源（Vite + 真实组件 + 随机本地端口 + 合成数据 ⇒ 0 网络写请求）。

---

## 2. 钉死的接口契约（实现方须满足；除此不新增约束）

### 2.1 新模块 `web/src/features/dashboard/multiPeriodLayout.ts`（纯函数，无 React、无 DOM）

```ts
/** 基准 pane 分配下限（px）。 */
export const BASE_MIN_HEIGHT = 200;
/** 卫星 pane 分配下限（px）。 */
export const SATELLITE_MIN_HEIGHT = 80;
/** 配置面 `heights` 取值域（与 P1 dto 一致）。 */
export const HEIGHT_MIN = 80;
export const HEIGHT_MAX = 1200;
/** 基准 pane 请求高度兜底（= 02-spec §6 默认 420）。 */
export const DEFAULT_BASE_HEIGHT = 420;
/** 拖拽 → 持久化的防抖窗（ms）。 */
export const DRAG_DEBOUNCE_MS = 300;

export interface StackPane { key: string; period: string; requested: number; isBase: boolean }
export type StackLayoutReason = 'fit' | 'shrunk' | 'min-overflow' | 'unavailable';
export interface StackLayout {
  panes: Array<{ key: string; period: string; height: number; isBase: boolean }>;
  /** Σ height（`fit`/`shrunk` ⇒ == available；`min-overflow` ⇒ == Σ min > available；`unavailable` ⇒ == Σ requested）。 */
  total: number;
  /** 需求 > 可用（发生过缩小），即使最终仍可完整放置。 */
  shrunk: boolean;
  /** 连最小高度都放不下 ⇒ 栈区域退化为可滚动（`overflow-y:auto`），本字段即可观测记录（不静默）。 */
  scrollable: boolean;
  reason: StackLayoutReason;
}

/** 单值净化：非有限值或 ≤0 ⇒ 兜底（基准 420 / 卫星 180）；否则 `round` 并夹取到 `[HEIGHT_MIN, HEIGHT_MAX]`。 */
export function sanitizeRequestedHeight(value: unknown, isBase: boolean): number;

/** 高度分配（**纯函数**，可单测；所有高度为**整数** px）。 */
export function distributeStackHeights(input: {
  panes: readonly StackPane[];
  /** `main-chart` 可用高度 px（`<=0` / 非有限 ⇒ `unavailable`）。 */
  available: number;
}): StackLayout;
```

**算法语义（判据口径）**

1. 先对每个 `requested` 走 `sanitizeRequestedHeight`；`requestedTotal = Σ`。
2. `!(available > 0)`（0/负/NaN/undefined）⇒ **`unavailable`**：各 pane 高度 = 净化后的**请求高度**（**不得**用 0/默认值覆盖 —— 保护既有 T2-2「卫星实例高度 = `heights[period]`」断言在 jsdom 下仍成立）、`total = requestedTotal`、`shrunk=false`、`scrollable=false`。
3. `requestedTotal <= available` ⇒ **`fit`**：各卫星高度 = 请求值；**基准吸收余量** = `available − Σ卫星`（≥ 请求值）；`total = available`。
4. `requestedTotal > available`：
   - `minTotal = (基准 ? BASE_MIN_HEIGHT : SATELLITE_MIN_HEIGHT) + Σ卫星 SATELLITE_MIN_HEIGHT`；
   - `minTotal > available` ⇒ **`min-overflow`**：各 pane 取各自下限（基准 200 / 卫星 80）、`total = minTotal (> available)`、`shrunk=true`、`scrollable=true`（**必须可观测，不得静默裁剪**）；
   - 否则 ⇒ **`shrunk`**（**统一因子 + 下限 + 残差修正**，保证 `Σ == available` 且各方 ≥ 下限）：
     1. `f = available / requestedTotal`；
     2. `h_i = floor(max(min_i, requested_i × f))`（`min_i` = 基准 200 / 卫星 80）；
     3. `residual = available − Σ h_i`（量级 ≤ pane 数）：`residual > 0` ⇒ 逐 px 加到「离请求值最近（可增空间最大）」的 pane（优先级：基准优先）；`residual < 0` ⇒ 逐 px 从「可减空间最大（`h_i − min_i` 最大）」的 pane 扣（基准处于下限时轮到卫星）；
     4. `total = available`。
5. 不变量（任一分支）：所有高度为整数；基准 ≥ 200（`fit` 下 ≥ 请求值）；卫星 ∈ [80, 请求值]；`fit`/`shrunk` 下 `Σ == available`；基准 ≥ 任一卫星（默认请求值下）。
   - 例（默认 420 + 3×180 @600）：`f = 0.625` ⇒ `262 / 112 / 112 / 112` ⇒ 残差 `+2` 给基准 ⇒ **`264 / 112 / 112 / 112`**。
   - 例（7 卫星 @600）：`minTotal = 200 + 560 = 760 > 600` ⇒ `min-overflow`（**可滚动**，`total = 760`）。

### 2.2 `MultiPeriodChartStack` 新增 props（`web/src/features/dashboard/MultiPeriodChartStack.tsx`）

```ts
/** 基准 pane 请求高度 px（配置 `heights[periods[0]]`；缺省 = DEFAULT_BASE_HEIGHT 420）。 */
baseHeight?: number;
/** 可用高度量测覆盖（测试/SSR 用）；缺省 = 量测自身根元素。 */
availableHeight?: number;
/** 拖拽结束（防抖后）回调：**全 pane 布局高度**（键 = `periods`，值 = 整数 px）。
 *  页面负责「乐观写 store + PUT + 失败回滚」（照既有 MA/dcap 写法）。 */
onHeightsChange?: (heights: Record<string, number>) => void;
```

**量测口径**：`availableHeight` 显式给出时优先；否则 `ResizeObserver` 回调以 `entry.contentRect.height` 为准（`>0` 时），回退 `el.clientHeight`；未挂载/不可得 ⇒ `0`（⇒ `unavailable` ⇒ 保持请求高度，**不得**猜一个默认值）。

### 2.3 DOM 契约（唯一新增的可观测面）

```
[data-mp-stack]                        仅「激活态」（enabled && 有卫星 && 有 code）存在；关闭态 DOM 逐字节等价不变
   data-mp-stack-scrollable="true|false"
   data-mp-stack-layout='{"reason":"shrunk","total":600,"scrollable":false,"heights":{"15m":264,"1h":112,…}}'
   flex column + height:100% + min-height:0（scrollable=true ⇒ overflow-y:auto）
   ├── [data-mp-pane="15m"][data-mp-pane-role="base"][data-mp-pane-height="264"]   inline style.height = 264px
   ├── [data-mp-separator="15m|1h"][data-mp-sep-upper="15m"][data-mp-sep-lower="1h"] role="separator"
   ├── [data-mp-satellite="1h"]                                                    inline style.height = 112px（P2 契约保留）
   ├── [data-mp-separator="1h|5m"] …
   └── …
```

- **基准 pane** 由本组件渲染（`data-mp-pane-role="base"`）：`DashboardPage` 不再给基准 `KlineChart` 传 `heightPx`（激活态高度由本 pane 决定；非激活态仍 `h-full` ⇒ 现状等价），改把请求高度经 `baseHeight` 传入。
- **卫星 pane** = 既有 `[data-mp-satellite]` 根元素（允许被同高包装层包裹），其 inline `height` 必须 = **分配高度**（jsdom 量测不可得时 = 请求高度 ⇒ P2 的 T2-2 断言不变）。
- **分隔条**：`[data-mp-separator="<上>|<下>"]`，`role="separator"`；**净布局高度为 0**（不得侵占 pane 空间 ⇒ `Σ pane == available`），命中带可 ≥4px（`absolute`/负 margin 均可，实现自选）。
- **拖拽**：以**鼠标事件**（`mousedown` 于分隔条 → `mousemove`/`mouseup` 于 window）驱动（jsdom 无 `PointerEvent`；本层不断言 pointer/touch 路径）。相邻两 pane 互补变化、两者之和不变；下界 基准 200 / 卫星 80，上界 `available − Σ 其它下限`。
- **持久化**：最后一次拖拽更新后 **300ms（`DRAG_DEBOUNCE_MS`）** 只调一次 `onHeightsChange(全表)`；拖拽期间/防抖窗内 DOM 用本地拖拽高度（乐观），父层回写后不得跳变（回写值 == 拖拽结果 ⇒ 分配不变）。
- 拖拽只重分配**相邻两者**，其它 pane 高度不变。

### 2.4 页面写入路径（`DashboardPage`）

- `onHeightsChange(heights)` ⇒ **乐观**：先写 `mpStore`（新增 `MultiPeriodStore.setHeights(heights)`）→ `PUT /api/config/multi_period`（body = 当前 `enabled`/`periods`/`indicators` **原样** + 新 `heights`）→ 成功用服务端回显；失败**回滚**到拖拽前高度（DOM 随 store 回滚），且不抛穿。
- 持久化后刷新/重进（重新 `GET`）⇒ 高度保持（同窗口尺寸下逐 px 相等）。

---

## 3. 用例清单（Given–When–Then）

### 3.1 `web/src/features/dashboard/multiPeriodLayout.test.ts`（L1 纯函数，15 例，**红**）

| # | 用例 | 判据 |
|---|---|---|
| A1 | 默认配置恰好填满（600 vs 960） | 4 pane（基准 420 + 3×180）、`available=600` ⇒ `Σ == 600`、`reason='shrunk'`、`shrunk=true`、`scrollable=false`、基准 ≥200、各卫星 ∈[80,180] 且落在比例带 ±3px |
| A2 | 需求 ≤ 可用 ⇒ 直用 + 基准吸收余量 | `available=1200`、420+3×180 ⇒ 卫星**恰 180**、基准 **660**、`Σ=1200`、`reason='fit'`、`shrunk=false` |
| A3 | 单基准（无卫星）退化输入 | `available=600`、基准 420 ⇒ 基准 600、`Σ=600`、`fit` |
| A4 | 需求 == 可用 | `available=960`、420+3×180 ⇒ 逐 pane == 请求值、`Σ=960`、`fit` |
| A5 | 连下限都放不下 ⇒ 可滚动（不静默） | `available=300`、420+3×180 ⇒ 基准 **200**、卫星 **80**、`Σ=440`、`shrunk=true`、`scrollable=true`、`reason='min-overflow'` |
| A6 | 边界：恰好等于下限和 | `available=440`、420+3×180 ⇒ `Σ=440`、`reason='shrunk'`（下界精确可达 ⇒ 不判可滚动） |
| A7 | 量测不可用 ⇒ 保持请求高度、不伪造默认 | `available=0 / NaN / -1 / undefined` ⇒ `reason='unavailable'`、逐 pane == 请求值、`scrollable=false`、不抛 |
| A8 | 非法请求值 ⇒ 兜底（不崩） | `sanitize` 逐值：`NaN/±Infinity/-5/0/'180'/null/undefined` ⇒ 基准 420、卫星 180；整链路（量测不可用分支）坏值 ⇒ 不崩且回退默认 |
| A9 | 越界请求值 ⇒ 夹取 | `20 ⇒ 80`、`5000 ⇒ 1200`、`1200 ⇒ 1200`、`80 ⇒ 80`、`180.6 ⇒ 181` |
| A10 | 空 pane 列表 | `[]` ⇒ `total=0`、不抛、`scrollable=false` |
| A11 | 顺序与稳定性 | 输出 `panes` 与输入**同序**、`key/period/isBase` 原样回传 |
| A12 | 卫星越多越挤（单调性） | 同一 `available` 下卫星 1/3/5 个 ⇒ 每个卫星高度单调不增、基准单调不增（≥200） |
| A13 | 卫星 ≤ 基准（可视化不变量） | 所有分支下基准高度 ≥ 任一卫星高度（默认请求值下） |
| A14 | 整数性 | 所有返回高度为整数（`Number.isInteger`） |
| A15 | 卫星过多 ⇒ 退化可滚动（不静默裁剪） | `available=600`、基准 420 + 7×180 ⇒ `minTotal = 200+560 = 760 > 600` ⇒ `reason='min-overflow'`、`scrollable=true`、基准 200、卫星各 80、`Σ == 760` |

### 3.2 `web/src/features/dashboard/multiPeriodLayoutDom.test.tsx`（L2 组件 DOM，12 例，**红**）

| # | 用例 | 判据 |
|---|---|---|
| B1 | 栈根元素契约 | 激活态存在 `[data-mp-stack]`；`data-mp-stack-scrollable="false"`；`data-mp-stack-layout` JSON 的 `heights` 与各 pane inline px 逐项相等，`total == available` |
| B2 | 恰好填满（DOM 实读） | `availableHeight=600`、420+3×180 ⇒ Σ(pane inline px) == **600**；基准 pane == 264±3、（缩后）卫星 ∈[80,180] 且 >0 |
| B3 | 每 pane 一个 chart 宿主 | 基准 pane 子树内含 `[data-testid="kline-chart"]`；卫星 pane 子树内含其 chart 宿主 |
| B4 | 我方分隔条（**不得**依赖 region 锚点 border） | 相邻 pane 之间**恰有 1 个** `[data-mp-separator="上|下"]`、`role="separator"`、`data-mp-sep-upper/lower` 正确；分隔条**不在** `[data-region]` 锚点元素内（`closest('[data-mp-stack]')` 成立）；分隔条净布局高度 0（`data-mp-sep-height` 缺省或 0；不含 pane 空间 ⇒ Σ pane 仍 == available） |
| B5 | 拖拽改变相邻两者、总和不变 | 基准\|1h 分隔条 `mousedown(y=0)→mousemove(+20)→mouseup` ⇒ 基准 +20、1h −20、其它 pane 不变 |
| B6 | 拖拽下限 | 反向拖 200px ⇒ 卫星停在 **80**、基准最多 `available − Σ其它下限`；再拖不越界 |
| B7 | 防抖持久化回调（一次） | `onHeightsChange` 在 `mouseup` 后 **<300ms 不调用**，≥300ms 后**恰 1 次**，参数 = 全 pane 布局高度（键 == periods） |
| B8 | 连续拖拽合并 | 3 次拖拽（间隔 >0 但 <300ms）⇒ 仍**只 1 次**回调、参数 = 末次结果 |
| B9 | ②③ 不变量（dcap / code / 重渲染） | 拖到 H′ 后：新 `dcapParams` 对象、新 `code`、父层强制重渲染 ⇒ 各 pane 高度 == H′（±1px） |
| B10 | 非法 heights ⇒ 不崩、回退默认 | `baseHeight=NaN`、卫星 `height=NaN/-1/0` ⇒ 渲染不抛、基准 pane == 420、卫星 == 180（`unavailable` 分支） |
| B11 | ADR-020：基准视口仍由宽度/根数决定 | 基准图 `clientWidth=980` + 触发 RO ⇒ `setBarSpace(round(980/120)=8)`；拖拽改高后**仍是 8**（高度变化不得改写基准 barSpace/范围） |
| B12 | 关闭态零残留 | `enabled=false` ⇒ 无 `[data-mp-stack]`/`[data-mp-separator]`/`[data-mp-pane]`（DOM 逐字节等价面不新增节点） |

### 3.3 `web/src/features/dashboard/multiPeriodHeightsPageContract.test.tsx`（L3 页面，7 例，**红**）

前置：`DashboardPage` + `RO` 桩（`contentRect.height=600`）+ MP 配置 `enabled/periods=[15m,1h,5m,1h]…`、`heights={15m:420,1h:180,5m:180,1h:180}`（4 pane，总需求 960 > 600 ⇒ 首屏即缩小）。

| # | 用例 | 判据 |
|---|---|---|
| C1 | 拖拽 ⇒ `PUT /api/config/multi_period` 一次 | 拖基准\|1h +20 ⇒ 防抖后 `saveMultiPeriodConfig` **恰 1 次**；body `periods`/`indicators`/`enabled` **逐字段原样**（不得被重置），`heights` = 拖后全表（Σ == 600） |
| C2 | 乐观更新 | PUT 未 resolve 时（挂起的 promise）DOM 已是拖后高度（= 乐观） |
| C3 | 失败回滚 | PUT reject ⇒ 各 pane 回到拖前高度（±1px）、store 高度回滚、无 unhandled rejection |
| C4 | 刷新/重进保持 | 拖拽成功（服务端回显新 `heights`）⇒ `unmount()` + 重新渲染（`GET` 返回新配置）⇒ 各 pane 高度 == 拖后值（±1px） |
| C5 | ②③ 切标的 | 拖后切到另一标的 ⇒ 各 pane 高度不变（±1px）、无 PUT（切标的不得写多周期配置） |
| C6 | ②③ 切周期 | 拖后切工具栏周期（15m→1h）⇒ 各 pane 高度不变（±1px）、无 PUT |
| C7 | ②③ 保存 dcap 参数 | 拖后保存 dcap（走 `PUT /api/config/dcap` 路径）⇒ 各 pane 高度不变（±1px）、且**不产生** `multi_period` 写请求 |

### 3.4 `web/tester/p5-layout-harness/`（L4 真渲染几何，Playwright）

交付：`index.html` + `entry.tsx`（真实组件入口 + `window.__p5.measure()`）+ `vite.config.mjs` + `postcss.config.js` + `run.mjs`（构建 → 本地随机端口 → 取证 → 证据 JSON/PNG）。

- 用 Vite 打包**真实** `MultiPeriodChartStack` + `KlineChart`(基准) + `MultiPeriodSatellite`×3 + **真实 Tailwind**（harness 内 `postcss.config.js`，不手搓工具类子集），`main-chart` 固定 `600px`（等价复刻 P2-C `271` 的主图区口径），合成数据、假 api/ws（0 出网）。
- 判据（**当前红**）：`Σ pane 高 == 600`；`#main`/栈 `scrollHeight <= clientHeight`（现状 **1140 vs 600 = 540px 溢出**）；轨迹真实像素高度（`getBoundingClientRect`）与分配一致；分隔条可命中且净高 0。
- 反向证据：把栈替换为「现状流式追加」（= 现在实现）⇒ 溢出判据必红。

---

## 4. 覆盖目标与边界

- **正面**：填满 / 直用 / 比例缩小 / 下限 / 退化可滚动 (L1)；DOM 契约 + 拖拽 + 防抖 + ②③ + ADR-020 (L2/L3)；真渲染几何 (L4)。
- **反向**：① 越界/非法 heights；② 连下限都放不下；③ 量测不可用；④ 拖拽下限；⑤ 关闭态零残留；⑥ harness 的「现状必溢出」。
- **不做**：pointer/touch 拖拽、键盘无障碍拖拽、多窗口尺寸矩阵（仅 600 一档 + L1 的纯数值档）、P4 LIVE 段。
- **既有测试保护**：jsdom 量测不可用 ⇒ 走 `unavailable`（保持请求高度）⇒ P2 的 `T2-2`（卫星 inline height == `heights[period]`）与 `multiPeriodClosedEquivalence`（关闭态零残留）**不得被本轮改红**。

---

**本文件路径**：`tester/design/276_p5_layout_persistence_red_design.md`
