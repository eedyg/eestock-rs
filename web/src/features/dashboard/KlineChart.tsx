import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  init,
  dispose,
  registerOverlay,
  type Chart,
  type KLineData,
  type OverlayCreateFiguresCallbackParams,
} from 'klinecharts';
import { DEFAULT_KLINE_VIEWPORT_BARS } from './feed';
import { fitBarSpaceToViewport, useBarSpaceFit, type BarSpaceFitResult } from './barSpaceFit';
import type { Bar, Period } from '@/api/types';
import type { IndicatorName } from './Toolbar';
// 指标名单**唯一来源** = `./IndicatorToggles`（看板 Toolbar 与结果页共用同一份，ADR-028 §2.4c 第 1 项）：
// 「勾选键 ↔ 图表指标」不再有两套名单可漂移。本文件只消费（`syncIndicators` 差分应用）。
import { INDICATOR_DEFS } from './IndicatorToggles';
import {
  DEFAULT_DCAP_PARAMS,
  dcapCalcParams,
  ensureDcapIndicatorRegistered,
  type DcapParams,
} from '@/features/indicators/dcapIndicator';
import { applyDarkTerminalStyles, PERIOD_MAP, toKcData } from './chartCommon';
import { loadBarsForKc, type KlineDataFeedLike } from './klineDataLoader';
import { addOverlayIndicator } from './overlayIndicator';
import { useChartSyncRegistry } from './chartSyncContext';
import {
  applyWindowOps,
  readVisibleRangeTs,
  type VisibleRangeTs,
  type WindowApplyResult,
  type WindowCommand,
} from './klineWindowOps';

/** KlineChart 承接所需的最小 feed 面（看板 KlineDataFeed 与弹窗 ScopedKlineFeed 均满足）。
 *  - bars/hasMore/loadInitial/loadBefore：DataLoader 取数（见 klineDataLoader.loadBarsForKc）。
 *  - onRealtime：订阅实时 bar（区间 feed 从不触发，看板 feed 走 WS）。
 *  - viewportBars：默认视口（K 线根数，GET /api/config/kline；缺省 120 兜底）。fitBarSpace 铺满目标据此
 *    计算（且与周期无关），使初始可见 K 线数随配置变化。看板 KlineDataFeed 返回配置值，
 *    区间 ScopedKlineFeed 固定 SCOPED_VIEWPORT_BARS=120（不读配置）。 */
export interface KlineChartFeedLike extends KlineDataFeedLike {
  viewportBars?: number;
  onRealtime(cb: (bar: Bar) => void): () => void;
  /** 取数 warmup 热更新（dcap 参数保存路径；**可选**：仅看板 `KlineDataFeed` 实现，
   *  区间/工作台 feed 不实现 ⇒ 无此能力时跳过，行为与修复前一致）。
   *  warmup 增大时向前补取差额更早的 bar（不重建 feed）；返回是否真的补取了数据。 */
  setWarmupBars?(warmup: number): Promise<boolean>;
}

/** overlay：满宽价位线（开/平仓标记） */
export interface KlinePriceLineOverlay {
  type: 'price-line';
  price: number;
  label?: string;
  color?: string;
}
/** overlay：开平仓区间高亮（klinecharts 自定义全高背景 rect） */
export interface KlineRangeOverlay {
  type: 'range';
  fromTs: number; // Unix 毫秒
  toTs: number; // Unix 毫秒
  price?: number; // 名义锚定价（全高背景只用 x，y 不敏感）
}
/** overlay：开/平仓 bar 标记（如同 TradingView 买/卖点）——按 ts 锚定当前周期 bar，渲染时先经
 *  snapTsToBars 吸附到「已加载 bar」并钳位（On-Screen），周期切换自动重定位。 */
export interface KlineMarkerOverlay {
  type: 'marker';
  /** 目标 ts（Unix 毫秒）：开仓/平仓 moment（run 周期桶 ts）；渲染前吸附/钳位到当前周期已加载 bar。 */
  ts: number;
  /** 标记文本：开仓 'B' / 平仓 'S' / 硬止损触发 '⊗'（P3b 工作台；string 宽化向后兼容）。 */
  text: string;
  /** 可选锚定价位（决定 pin 的 y 位置；缺省 0，简单注解以顶为锚）。 */
  price?: number;
  color?: string;
  /**
   * ADR-028 D4.1 **判别身份键**（`rt_seq:回合成交序号`；见 `KlineResultChart.makeFillKey`）。
   * 缺省 ⇒ 无身份（既有调用方不变）。「点击 → 目标标记」的一一对应靠它（**禁止**按 bar 粗定位）。
   */
  fillKey?: string;
  /** 价格×股数标签（如 `B 8.417×118`）；缺省 ⇒ 不画标签（退化回既有 simpleAnnotation 形态）。 */
  label?: string;
  /** 同 bar 多笔的**堆叠序**（0 起，像素纵向偏移 `stackIndex × FILL_DOT_DY_PX`）⇒ 同 bar 多笔可分辨。 */
  stackIndex?: number;
  /** 渲染形态：`'dot'` = 实心圆点 + 描边（ADR-028 D4.1 醒目化）；缺省/`'annotation'` = 既有 simpleAnnotation。 */
  shape?: 'dot' | 'annotation';
}
export type KlineOverlay = KlinePriceLineOverlay | KlineRangeOverlay | KlineMarkerOverlay;

export interface KlineChartProps {
  feed: KlineChartFeedLike;
  code: string;
  period: Period;
  followLatest: boolean;
  indicators: Record<IndicatorName, boolean>;
  onManualZoom(): void;
  /** 可选 overlay（开/平仓价位线 + 区间高亮 + 开/平仓 B/S 标记）；看板不传则默认无。 */
  overlays?: KlineOverlay[];
  /** MA 窗口（统一配置，主图+宫格共用；默认 [5,10,20]，从 GET /api/config/ma 读） */
  maWindows?: number[];
  /** dcap 显示参数（统一配置，主图+宫格共用；默认 8/26/60/1/1/1/1/3，从 GET /api/config/dcap 读）。
   *  仅在 `indicators.dcap` 为真时生效（独立副图 pane，见 02-spec §6）。 */
  dcapParams?: DcapParams;
  /** dcap 取数 warmup 根数（02-spec §6；看板传 `indicators.dcap ? dcapWarmupBars(dcapParams) : 0`）。
   *  **变化时不得重建图表**：热更新 feed 的 warmup（`feed.setWarmupBars`）并在真的补取了更早 bar 时
   *  原地重载数据（`chart.resetData()`）——pane 布局/用户拖拽高度/视口均保持（§6 图表契约）。
   *  缺省 0（不 warmup；区间/工作台等未传的调用方行为不变）。 */
  warmupBars?: number;
  /**
   * 卫星实例（多周期指标同显，`design/15-multi-period/02-spec.md` §3.4）：
   *  **隐藏 K 线**（只留指标 pane）。唯一可行手段是 `setPaneOptions({id:'candle_pane', state:'minimize',
   *  minHeight:0})` + `setStyles({separator:{size:0}})`；`height:0` 会被 klinecharts 静默忽略
   *  （`index.esm.js:15421` 守卫）。缺省 false ⇒ 既有调用方（看板基准图/宫格/工作台）行为不变。
   *  副作用：零高 pane 存在时 `getConvertPictureUrl()` 抛 `InvalidStateError` ⇒ 禁止图表导出截图。 */
  hideCandles?: boolean;
  /** 图表初始化失败回调（`init()` 返回空/抛错）。卫星用它做「失败可见」（不得静默降级为空白 pane）。 */
  onInitError?: () => void;
  /** 实例容器高度 px（多周期基准/卫星按配置 `heights[period]` 渲染，02-spec §6）；缺省 ⇒ `h-full`
   *  （单图/宫格/工作台现状等价）。拖拽改高与持久化属 P5，本轮只渲染不动手。 */
  heightPx?: number;
  /**
   * `init({layout:{barSpaceLimit}})`（**仅卫星**传；口径 9 + ADR-022 §2.3）。
   * klinecharts **无运行时 setBarSpaceLimit** ⇒ 放宽只能建图时给定；缺省（基准/宫格/工作台）⇒
   * `init(el)` 不传 options ⇒ 引擎默认 `{min:1,max:50}`（ADR-020 严格，**放宽不得泄漏到基准**）。
   */
  barSpaceLimit?: { min?: number; max?: number };
  /**
   * ADR-028 D2 / 02-spec §7：**可见时间范围变更**回调（索引→ts 由图内部经 `getDataList()` 转换）。
   *  **可选**：不传 ⇒ 本组件**不订阅** `onVisibleRangeChange`（既有调用方订阅面/渲染逐字节不变，F8）。
   *  程序化写窗（{@link KlineChartProps.windowCommand}）期间的回声由 `programmaticScroll` 抑制
   *  （与 `onZoom`/`onScroll` 同口径，ADR-022 §2.3）。
   */
  onVisibleRangeChange?: (r: VisibleRangeTs) => void;
  /**
   * ADR-028 D2/D4：**程序化写窗命令**（结果页 L1/L2 `[跳转]` / 全览 / 历史回退）。
   *  **可选**；不传/传 null ⇒ 本组件不执行任何窗口写操作（既有调用方零影响）。
   *  同一命令对象不会重放 ⇒ 调用方须以单调 `rev` 生成新对象。
   */
  windowCommand?: WindowCommand | null;
  /** 写窗回执（ADR-028 D4 断言口径；**失败必须显式报错**，禁止静默无反应）。可选。 */
  onWindowApplied?: (r: WindowApplyResult) => void;
  /**
   * ADR-028 D4.1：**跳转高亮的判别身份键**（`fillKey`，精确到笔）。
   * 非空 ⇒ 本图在该标记上叠加「放大 + 描边脉冲」高亮（**定时器驱动 overlay 重绘**，
   * **不重建整图**、不丢视口/指标状态），持续 {@link HIGHLIGHT_DURATION_MS} 后自动回常态。
   * 缺省 `null` ⇒ 无高亮（既有调用方零影响）。
   */
  highlightFillKey?: string | null;
  /** 高亮**重放键**：同 `fillKey` 上再次跳转须换新值（否则 effect 不重放 ⇒ 3s 窗口不重启）。 */
  highlightRev?: number;
  /** 高亮结束（3s 到点）回调（观测性；可选）。 */
  onHighlightEnd?: () => void;
  /**
   * ADR-028 §2.6 第 4 项「接口条款」（2026-09-23 架构侧授权新增，**唯一新增接口**）：
   * **pane 约束声明**（结果页 K 线卡用它实现「主图 ≥320/≥160、副图合计 ≤120、副图让位至 30px 下限」）。
   *
   *  - **可选、缺省关闭**：不传 ⇒ 本组件**既不设 pane 选项、也不订阅 onPaneDrag、也不落任何新 data-***
   *    ⇒ 看板/宫格/多周期/关闭态行为与现状**逐像素一致**（沿用 `barSpaceLimit`「仅结果页/卫星传」先例）；
   *  - **声明式**：只接受数值（主图下限 / 副图下限 / 副图规划高），**不暴露 chart 实例**；
   *  - 两条 drag 路径都受约束：①卡片拖高（容器高变化 ⇒ 调用方重算 `subPanePx` ⇒ 本组件重新应用）
   *    ②引擎 pane 分隔条拖拽（引擎按 pane `minHeight` 自行 clamp，事后再校验并修正）。
   */
  paneConstraints?: KlinePaneConstraints;
  /** pane 约束的**实测结果**回执（观测性；可选）。 */
  onPaneMetrics?: (m: KlinePaneMetrics) => void;
}

/** ADR-028 §2.6 第 4 项：结果页 K 线 pane 约束（声明式；无 chart 实例）。 */
export interface KlinePaneConstraints {
  /** 蜡烛主图（candle pane）硬下限 px（结果页 = 160）。 */
  candleMinPx: number;
  /** 每个副图 pane 的有效下限 px（结果页 = 30；保持可见，不隐藏）。 */
  subPaneMinPx: number;
  /**
   * 副图 pane **规划高**（每个副图；由调用方按「容器高 − x轴 − 主图下限」算出）。
   * 缺省 ⇒ 只设下限、不改高度（默认分配由引擎给定）。
   */
  subPanePx?: number;
  /**
   * 副图**合计上限**（默认分配目标，结果页 = 120）。
   * **只对「默认分配」生效**：用户手动拖过引擎 pane 分隔条后不再强制（ADR §2.6 第 7 项
   * 「保留引擎 pane 分隔条」+ D4.2 既有契约「已拖过的 pane 高度在指标切换后保持」）——
   * 硬下限（主图 ≥ `candleMinPx`、每副图 ≥ `subPaneMinPx`）始终强制。
   */
  subPaneTotalMaxPx?: number;
}

/** pane 约束实测回执（真身 `getSize(paneId)` 读数）。 */
export interface KlinePaneMetrics {
  candlePx: number | null;
  /** 用户是否已手动拖过引擎 pane 分隔条（`true` ⇒ 之后尊重其比例，除非硬下限越界）。 */
  userDragged?: boolean;
  subPanes: Array<{ id: string; px: number | null }>;
  subPaneTotalPx: number | null;
  /** 是否触发了硬下限/让位 clamp（观测性；`true` 必须在 UI/报告中可回查）。 */
  clamped: boolean;
}

/** 主图 MA 默认窗口（GET /api/config/ma 缺省/未加载时兜底；与后端默认 [5,10,20] 同构） */
const DEFAULT_MA_WINDOWS: number[] = [5, 10, 20];


/** 已应用指标状态：`name → 已应用的 calcParams`。
 *  **必须是「本次建图」的组件级持有**（随建图重置）：
 *  - 不得用模块级 `WeakMap<Chart, …>`——测试里的 chart 桩跨用例共享同一对象，会被污染；
 *  - 不得用 `chart.getIndicators(...)` 判在场——既有测试桩未提供该 API（会大面积 TypeError）。 */
type AppliedIndicators = Map<string, number[]>;

function sameParams(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** x 轴 pane id（klinecharts 固定值；不参与 pane 约束）。 */
const X_AXIS_PANE_ID = 'x_axis_pane';

/** 读 pane 真实尺寸（`getSize(paneId)`；失败/不可用 ⇒ null，**不得**返回 0 冒充）。 */
function paneSizeOf(chart: Chart, id: string): number | null {
  try {
    const s = chart.getSize?.(id);
    return typeof s?.height === 'number' && Number.isFinite(s.height) ? Math.round(s.height) : null;
  } catch {
    return null;
  }
}

/** 当前 pane 列表（candle / 副图 / x 轴）。 */
function paneIdsOf(chart: Chart): string[] {
  try {
    const raw = chart.getPaneOptions?.();
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map((p) => String(p.id));
  } catch {
    return [];
  }
}

/** pane 约束实测：主图高 / 各副图高 / 是否越界。 */
export function measurePaneMetrics(chart: Chart, pc: KlinePaneConstraints): KlinePaneMetrics {
  const candlePx = paneSizeOf(chart, 'candle_pane');
  const subPanes = paneIdsOf(chart)
    .filter((id) => id !== 'candle_pane' && id !== X_AXIS_PANE_ID)
    .map((id) => ({ id, px: paneSizeOf(chart, id) }));
  const subKnown = subPanes.map((s) => s.px).filter((v): v is number => v != null);
  const subPaneTotalPx = subKnown.length === subPanes.length && subPanes.length > 0 ? subKnown.reduce((a, b) => a + b, 0) : null;
  const clamped =
    (candlePx != null && candlePx < pc.candleMinPx) ||
    subPanes.some((s) => s.px != null && s.px < pc.subPaneMinPx);
  return { candlePx, subPanes, subPaneTotalPx, clamped };
}

/**
 * 应用 pane 约束（ADR-028 §2.6 第 4 项；**仅结果页传 `paneConstraints` 时调用**）：
 *  - candle pane ⇒ `minHeight = candleMinPx`（引擎拖分隔条时按 reduced pane 的 minHeight 自行 clamp
 *    ⇒ 这是「拖分隔条越界」路径的**唯一**生效点，实测 `separatorWidget._pressedTouchMouseMoveEvent`）；
 *  - 副图 pane ⇒ `minHeight = subPaneMinPx`（保持可见）+ `height = subPanePx`（让位/上限分配）；
 *  - **不重建 pane**（`setPaneOptions` 原地改选项；指标/视口/用户拖拽高度语义不变）。
 */
export function applyPaneFloors(chart: Chart, pc: KlinePaneConstraints): void {
  for (const id of paneIdsOf(chart)) {
    if (id === 'candle_pane') {
      // 主图硬下限：**唯一**能在「引擎拖分隔条」路径生效的机制（引擎按 reduced pane 的 minHeight 夹紧）
      chart.setPaneOptions({ id, minHeight: pc.candleMinPx });
    } else if (id !== X_AXIS_PANE_ID) {
      chart.setPaneOptions({ id, minHeight: pc.subPaneMinPx });
    }
  }
}

/**
 * 按 `subPanePx` 写副图高（默认分配）。
 *
 * `mode`：
 *  - `'full'`（默认）：全部副图 = 规划高（容器高变化 / 主图触底 ⇒ 必须重排）；
 *  - `'preserve'`：**保留**已达下限的副图高（= 用户手动拖过的比例，ADR §2.6 第 7 项），
 *    只为「新建/过小」的副图补规划高。用于「用户拖过分隔条后新增副图指标」的场景
 *    （既有契约 D4.2/2026-09-20：已拖过的 pane 高度在指标切换后保持）。
 */
export function applyPaneAllocation(
  chart: Chart,
  pc: KlinePaneConstraints,
  mode: 'full' | 'preserve' = 'full',
): KlinePaneMetrics {
  applyPaneFloors(chart, pc);
  const target = pc.subPanePx;
  if (target != null && target > 0) {
    for (const id of paneIdsOf(chart)) {
      if (id === 'candle_pane' || id === X_AXIS_PANE_ID) continue;
      const current = paneSizeOf(chart, id);
      const keep = mode === 'preserve' && current != null && current >= pc.subPaneMinPx;
      chart.setPaneOptions({
        id,
        minHeight: pc.subPaneMinPx,
        height: keep ? (current as number) : Math.max(pc.subPaneMinPx, Math.round(target)),
      });
    }
  }
  return measurePaneMetrics(chart, pc);
}

/**
 * 是否需要**重新分配**（否则尊重当前布局 = 用户拖拽结果）：
 *  - 主图 / 副图触到硬下限 ⇒ 必须重分配（不得静默接受越界）；
 *  - 副图合计超上限 ⇒ 仅在**用户尚未拖过**时重分配（默认分配目标；用户拖拽按 §2.6 第 7 项尊重）。
 */
export function paneAllocationNeeded(
  m: KlinePaneMetrics,
  pc: KlinePaneConstraints,
  userDragged: boolean,
): boolean {
  if (m.candlePx != null && m.candlePx < pc.candleMinPx) return true;
  if (m.subPanes.some((s) => s.px != null && s.px < pc.subPaneMinPx)) return true;
  if (!userDragged) {
    if (pc.subPaneTotalMaxPx != null && m.subPaneTotalPx != null && m.subPaneTotalPx > pc.subPaneTotalMaxPx) {
      return true;
    }
    // 目标分配未达成（容器高变化后引擎保留旧高度 ⇒ 主图吃掉差额）⇒ 与规划值重新对齐。
    // 例：首帧容器尚未布局 ⇒ 规划 30px；容器落定后必须回到 100px（否则默认态副图被压成 30px）。
    const target = pc.subPanePx;
    if (
      target != null &&
      target > 0 &&
      m.subPanes.some((s) => s.px != null && Math.abs(s.px - target) > 4)
    ) {
      return true;
    }
  }
  return false;
}

/** 一次性应用（下限 + 分配）；供冒烟/测试使用。 */
export function applyPaneConstraints(chart: Chart, pc: KlinePaneConstraints): KlinePaneMetrics {
  return applyPaneAllocation(chart, pc);
}

/** `createIndicator` 参数：目标 calcParams 为空（内置模板指标 VOL/MACD/KDJ/BOLL）时**必须省略该字段**
 *  —— 传 `calcParams: []` 会覆盖模板默认参数（真渲染实测：VOL 的 calcParams 变 `[]`）。 */
function createIndicatorValue(name: string, calcParams: number[]): { name: string; calcParams?: number[] } {
  return calcParams.length > 0 ? { name, calcParams } : { name };
}

/** 各指标目标 calcParams（MA 取统一配置窗口；DCAP 取 8 参显示参数；其余用内置默认）。 */function desiredCalcParams(
  def: { key: IndicatorName; calcParams?: number[] },
  maWindows: number[],
  dcapParams: DcapParams,
): number[] {
  if (def.key === 'ma') return maWindows;
  if (def.key === 'dcap') return dcapCalcParams(dcapParams);
  return def.calcParams ?? [];
}

/**
 * 指标同步：**状态差分**（02-spec §6 图表契约）。
 * - **仅「启用状态翻转」才 `createIndicator` / `removeIndicator`**（关态不残留空 pane）；
 * - **参数变化一律走 `overrideIndicator({name, calcParams})`**：原地改 calcParams 并重算，
 *   **不销毁 pane**（销毁会让 pane 以布局默认高度重建 ⇒ 用户拖拽过的副图高度被重置）；
 * - 参数无变化 ⇒ 什么都不做（幂等：保存时乐观更新 + 服务端回显两次 commit 均安全）；
 * - 不依赖 `overrideIndicator` 返回值判成败（库事实：仅 calc 变化时其返回 `false`，但确实生效）。
 */
function syncIndicators(
  chart: Chart,
  indicators: Record<IndicatorName, boolean>,
  maWindows: number[],
  dcapParams: DcapParams,
  applied: AppliedIndicators,
) {
  for (const def of INDICATOR_DEFS) {
    const enabled = indicators[def.key];
    const desired = desiredCalcParams(def, maWindows, dcapParams);
    const prev = applied.get(def.name);
    if (!enabled) {
      if (prev) {
        chart.removeIndicator({ name: def.name });
        applied.delete(def.name);
      }
      continue;
    }
    if (!prev) {
      if (def.key === 'ma') {
        // P0.1（ADR-022 §4.3）：MA 叠加在 candle_pane 上**必须**走入口 ⇒ 显式 isStack=true + 非空断言。
        // 旧实现传 `false`（整 pane 替换语义）：当前恰好只有 MA 才「看起来正常」，一旦再有叠加指标
        // 就会静默顶掉 MA（index.esm.js:14162-14165，零告警）。
        addOverlayIndicator(
          chart,
          { ...createIndicatorValue(def.name, desired), paneId: 'candle_pane' },
          def.name,
        );
      } else {
        // ADR-021 §6：DCAP **独立副图 pane**（不可叠 candle_pane：dcap 与价格无量纲关系）；
        // isStack=true ⇒ 新建独立 pane + 独立 Y 轴自动标度；模板显式 precision=5（dcapIndicator.ts）。
        if (def.key === 'dcap') ensureDcapIndicatorRegistered();
        chart.createIndicator(createIndicatorValue(def.name, desired), true);
      }
      applied.set(def.name, desired);
      continue;
    }
    if (!sameParams(prev, desired)) {
      chart.overrideIndicator({ name: def.name, calcParams: desired });
      applied.set(def.name, desired);
    }
  }
}

/** klinecharts 无内置「开平仓区间全高背景」overlay：注册一个自定义 `tradeRange` 模板（全高 rect）。
 *  注册为全局一次性；测试环境 klinecharts 被打桩（无 registerOverlay），跳过注册，交由 createOverlay 桩验证。 */
let tradeRangeRegistered = false;
function ensureTradeRangeOverlayRegistered() {
  if (tradeRangeRegistered || getRegisterOverlay() == null) return;
  registerOverlay({
    name: 'tradeRange',
    totalStep: 0,
    createPointFigures: (p: OverlayCreateFiguresCallbackParams<unknown>) => {
      const [a, b] = p.coordinates;
      if (!a || !b) return [];
      const x = Math.min(a.x, b.x);
      const width = Math.abs(b.x - a.x);
      return {
        type: 'rect',
        attrs: { x, y: 0, width, height: p.bounding.height },
        ignoreEvent: true,
      };
    },
    styles: {
      rect: {
        style: 'stroke_fill',
        color: 'rgba(56,189,248,0.10)',
        borderColor: 'rgba(56,189,248,0.30)',
        borderSize: 1,
        borderStyle: 'dashed',
        borderRadius: 4,
      },
    },
  });
  tradeRangeRegistered = true;
}

/** ADR-028 D4.1 高亮时长（ms）：放大 + 描边脉冲，3 秒后回常态（**不得**留永久选中态）。 */
export const HIGHLIGHT_DURATION_MS = 3000;
/** 脉冲节拍（ms）：定时器驱动的 overlay 重绘周期（canvas 内无法用 CSS 动画）。 */
export const HIGHLIGHT_PULSE_MS = 150;
/** 同 bar 多笔堆叠的纵向间距（px；**不得相互遮盖**）。 */
export const FILL_DOT_DY_PX = 12;
/** 常态圆点半径（px；小尺寸 + 半透明 ⇒ 不遮蜡烛主体）。 */
export const FILL_DOT_R_PX = 3.2;
/** 高亮圆点半径（px；放大）。 */
export const FILL_DOT_HIGHLIGHT_R_PX = 6.5;
/** R1（2026-09-20）：标签与圆点之间的水平间距（px）。 */
export const FILL_LABEL_GAP_PX = 3;
/** R1：9px 文本近似字宽（px/字符；实测 16 字符标签宽 76px ⇒ 4.4×16+5）。 */
export const FILL_LABEL_CW_PX = 4.4;
/** R1：标签左右 padding + 余量（px；模板 styles 里 paddingLeft/Right 各 2）。 */
export const FILL_LABEL_PAD_PX = 5;

/**
 * R1（2026-09-20）**标签边缘收敛**（纯函数）：给定圆点位置与面板宽度，返回标签锚点与对齐。
 *
 * 旧实现恒为 `x = 圆点x + r + 3, align='left'` ⇒ 当圆点落在 candle pane **右缘**（如 run 末根 bar 的成交）时，
 * 「价格×股数」文本被面板裁掉（实测末根 bar 标签几乎不可读）。
 *
 * 规则（**不改变有空间时的既有位置**）：
 *  1. 右侧放得下 ⇒ 保持右侧左对齐（与旧行为逐像素一致）；
 *  2. 右侧放不下但左侧放得下 ⇒ **翻转到圆点左侧**（右对齐）；
 *  3. 两侧都放不下（面板极窄）⇒ 向内偏移并夹紧在面板内（**不得越界**）。
 */
export function placeFillLabel(args: {
  x: number;
  r: number;
  text: string;
  paneWidth: number;
}): { x: number; align: CanvasTextAlign } {
  const textW = args.text.length * FILL_LABEL_CW_PX + FILL_LABEL_PAD_PX;
  const rightX = args.x + args.r + FILL_LABEL_GAP_PX;
  const leftX = args.x - args.r - FILL_LABEL_GAP_PX;
  const paneW = args.paneWidth > 0 ? args.paneWidth : Number.POSITIVE_INFINITY;
  if (rightX + textW <= paneW - 1) return { x: rightX, align: 'left' };
  if (leftX - textW >= 1) return { x: leftX, align: 'right' };
  return { x: Math.max(1, Math.min(paneW - textW - 1, leftX - textW)), align: 'left' };
}

/** `fillDot` overlay 的 extendData（判别身份 + 形态参数）。 */
export interface FillDotData {
  text?: string;
  label?: string;
  color?: string;
  stackIndex?: number;
  fillKey?: string;
  highlight?: boolean;
  /** 脉冲相位（整数；奇偶交替 ⇒ 半径/描边脉冲）。 */
  pulse?: number;
}

function getRegisterOverlay(): ((overlay: unknown) => void) | null {
  try {
    const f = registerOverlay as unknown;
    return typeof f === 'function' ? (f as (overlay: unknown) => void) : null;
  } catch {
    return null;
  }
}

/** klinecharts 无内置「实心圆点 + 描边 + 价格×股数标签」overlay：注册自定义 `fillDot` 模板。
 *  注册为全局一次性；测试环境 klinecharts 被打桩（无 registerOverlay）⇒ 跳过注册，
 *  由 createOverlay 桩验证「调用面」。（与 {@link ensureTradeRangeOverlayRegistered} 同模式。） */
let fillDotRegistered = false;
function ensureFillDotOverlayRegistered() {
  // **取用本身要 try/catch**：测试环境 klinecharts 被 `vi.mock` 打桩且**无该导出**，
  // 直接 `typeof registerOverlay !== 'function'` 的**属性访问**会抛
  // （vitest mocker proxy：No "registerOverlay" export is defined）⇒ 打桩环境必须能安全跳过。
  const register = getRegisterOverlay();
  if (fillDotRegistered || register == null) return;
  const template = {
    totalStep: 0,
    createPointFigures: (p: OverlayCreateFiguresCallbackParams<unknown>) => {
      const c = p.coordinates[0];
      if (!c) return [];
      const d = (p.overlay.extendData ?? {}) as FillDotData;
      const dy = (d.stackIndex ?? 0) * FILL_DOT_DY_PX;
      const pulse = d.highlight ? ((d.pulse ?? 0) % 2 === 0 ? 0 : 2.2) : 0;
      const r = d.highlight ? FILL_DOT_HIGHLIGHT_R_PX + pulse : FILL_DOT_R_PX;
      const figures: Array<{ type: string; attrs: unknown; styles?: unknown; ignoreEvent: boolean }> = [
        {
          type: 'circle',
          attrs: { x: c.x, y: c.y + dy, r },
          styles: {
            style: 'stroke_fill',
            color: d.color ?? '#8b93b0',
            borderColor: d.highlight ? '#ffffff' : '#0b0f1a',
            borderSize: d.highlight ? 2.5 + pulse / 2 : 1,
          },
          ignoreEvent: true,
        },
      ];
      if (d.label) {
        // R1：标签边缘收敛（右缘翻转/夹紧）——末根 bar 的成交标签必须完整落在面板内。
        const pos = placeFillLabel({ x: c.x, r, text: d.label, paneWidth: p.bounding.width });
        figures.push({
          type: 'text',
          attrs: { x: pos.x, y: c.y + dy, text: d.label, align: pos.align, baseline: 'middle' },
          styles: {
            color: d.color ?? '#8b93b0',
            size: 9,
            backgroundColor: 'rgba(9,13,24,0.72)',
            paddingLeft: 2,
            paddingRight: 2,
          },
          ignoreEvent: true,
        });
      }
      return figures;
    },
  };
  // **两个名字，同一模板**：`fillDot` = 常态买卖标记；`fillDotHighlight` = 跳转高亮（放大 + 描边脉冲）。
  // 名字必须各自**注册过**，否则 `createOverlay` 会因 `getOverlayInnerClass(name) === null`
  // **静默返回 null**（真渲染实测：高亮 overlay 被丢弃 ⇒ 像素零变化）。分开命名是为了能按名单独清除高亮，
  // 而不误清常态标记（`removeOverlay({name})` 按名过滤）。
  register({ ...template, name: 'fillDot' });
  register({ ...template, name: 'fillDotHighlight' });
  fillDotRegistered = true;
}

/** B/S 标记「吸附 + 钳位」纯函数：在已加载 bar 集合里吸附到距目标 ts 最近的 bar，并钳位到 [0, len-1]
 *  （On-Screen 保证）。
 *  语义：
 *   - 目标 ts 有同类 bar（等于/粗于 run 周期）→ 精确命中，吸附不偏移。
 *   - 目标 ts 无同类 bar（如 D1 run 桶 ts=16:00Z 切 1m）→ 吸附到最近 bar；
 *     若 ts 在区间外（早/晚于首/末根）→ 钳位到边缘根——标记始终落在已加载范围内，不会因 klinecharts
 *     按周期步长外推到屏外。
 *  注：返回 ts 恒为已加载某根 bar 的真实时间戳（毫秒），index 恒在 [0, bars.length-1]。
 *  bars 为空返回 null（无可吸附 bar）。 */
export interface SnapToBarsResult {
  index: number;
  ts: number;
}
export function snapTsToBars(
  bars: ReadonlyArray<{ ts: string }>,
  targetTs: number,
): SnapToBarsResult | null {
  if (bars.length === 0) return null;
  let bestIndex = 0;
  let bestTs = Date.parse(bars[0]!.ts);
  let bestDiff = Math.abs(bestTs - targetTs);
  for (let i = 1; i < bars.length; i++) {
    const t = Date.parse(bars[i]!.ts);
    const diff = Math.abs(t - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
      bestTs = t;
    }
  }
  return { index: bestIndex, ts: bestTs };
}

/** 创建基础 overlay（开/平仓满宽价位线 + 开平仓区间高亮背景）。
 *  B/S bar 标记（simpleAnnotation）不在此创建：其 ts 需先依「已加载 bar」吸附/钳位以保证跨周期 On-Screen，
 *  由 createMarkerOverlays 在 feed 加载完成后创建。 */
function createChartOverlays(chart: Chart, overlays: KlineOverlay[]) {
  for (const ov of overlays) {
    if (ov.type === 'price-line') {
      chart.createOverlay({
        name: 'simpleTag',
        paneId: 'candle_pane',
        lock: true,
        points: [{ value: ov.price }],
        extendData: ov.label ?? '',
        styles: {
          line: {
            style: 'dashed',
            color: ov.color ?? '#8b93b0',
            size: 1,
          },
        },
      });
    } else if (ov.type === 'range') {
      ensureTradeRangeOverlayRegistered();
      const price = ov.price ?? 0;
      chart.createOverlay({
        name: 'tradeRange',
        paneId: 'candle_pane',
        lock: true,
        points: [
          { timestamp: ov.fromTs, value: price },
          { timestamp: ov.toTs, value: price },
        ],
      });
    }
  }
}

/** 创建开/平仓 B/S bar 标记 overlay（klinecharts 内置 simpleAnnotation：竖线 + 箭头 + 文本 B/S）。
 *  marker ts 先经 snapTsToBars 吸附/钳位到「已加载 bar」再锚定，保证跨周期 On-Screen；
 *  数据面变化（切周期/切标的 ⇒ feed 身份变化）后由 Effect W 先清旧 overlay 再重建，回到当前周期
 *  已加载 bar 重新吸附（同一 chart 实例，`resetData` 不清 overlay）。
 *  无已加载 bar（bars 空）则跳过（无可吸附对象，避免锚定到屏外）。 */
export function createMarkerOverlays(
  chart: Chart,
  overlays: ReadonlyArray<KlineOverlay>,
  bars: ReadonlyArray<{ ts: string }>,
  /** 覆盖层父级：`extra` 用于高亮脉冲重绘（同一模板 `fillDot`，判别键相同）。 */
  highlight?: { fillKey: string; pulse: number } | null,
): number {
  let created = 0;
  for (const ov of overlays) {
    if (ov.type !== 'marker') continue;
    const snapped = snapTsToBars(bars, ov.ts);
    if (!snapped) continue;
    // ADR-028 D4.1 醒目化：实心圆点 + 描边 + 价格×股数标签（`shape:'dot'`/带 `label`）。
    if (ov.shape === 'dot' || ov.label != null) {
      ensureFillDotOverlayRegistered();
      const hl = highlight && ov.fillKey === highlight.fillKey ? highlight : null;
      chart.createOverlay({
        name: 'fillDot',
        paneId: 'candle_pane',
        lock: true,
        zLevel: hl ? 30 : 10,
        points: [{ timestamp: snapped.ts, value: ov.price ?? 0 }],
        extendData: {
          text: ov.text,
          label: ov.label,
          color: ov.color,
          stackIndex: ov.stackIndex ?? 0,
          fillKey: ov.fillKey,
          highlight: hl != null,
          pulse: hl?.pulse ?? 0,
        } satisfies FillDotData,
      });
      created += 1;
      continue;
    }
    chart.createOverlay({
      name: 'simpleAnnotation',
      paneId: 'candle_pane',
      lock: true,
      points: [{ timestamp: snapped.ts, value: ov.price ?? 0 }],
      extendData: ov.text,
      styles: {
        line: {
          style: 'dashed',
          color: ov.color ?? '#8b93b0',
          size: 1,
        },
      },
    });
    created += 1;
  }
  return created;
}

/** overlay **内容签名**（纯函数）：标记重建的依赖面，**不用对象身份**作依赖。
 *  理由（幂等/防重建风暴）：父级每次渲染都可能重建 `overlays` 数组（同一内容、不同身份）；
 *  若以身份为依赖，「重建 ⇒ setState ⇒ 渲染 ⇒ 身份又变 ⇒ 再重建」会形成无界重建回路。
 *  签名覆盖**全部影响绘制的字段**（marker 的 ts/text/price/color/fillKey/label/stackIndex/shape；
 *  价位线/区间的价格与 ts 端点）⇒ 内容不变 ⇒ 不触发重建。 */
export function overlaySignature(overlays: ReadonlyArray<KlineOverlay> | undefined): string {
  if (!overlays || overlays.length === 0) return '';
  const parts: string[] = [];
  for (const ov of overlays) {
    if (ov.type === 'marker') {
      parts.push(
        `m|${ov.ts}|${ov.text}|${ov.price ?? ''}|${ov.color ?? ''}|${ov.fillKey ?? ''}|${ov.label ?? ''}|${
          ov.stackIndex ?? 0
        }|${ov.shape ?? ''}`,
      );
    } else if (ov.type === 'price-line') {
      parts.push(`p|${ov.price}|${ov.label ?? ''}|${ov.color ?? ''}`);
    } else {
      parts.push(`r|${ov.fromTs}|${ov.toTs}|${ov.price ?? ''}`);
    }
  }
  return parts.join(';');
}

/** 纯函数：按 `fillKey` 精确找到目标标记（ADR-028 D4.1：**禁止**按 bar 粗定位）。
 *  找不到 ⇒ `null`（调用方须**显式**披露「标记不可得」，禁静默无反应）。 */
export function findMarkerByFillKey(
  overlays: ReadonlyArray<KlineOverlay> | undefined,
  fillKey: string | null | undefined,
): KlineMarkerOverlay | null {
  if (!fillKey) return null;
  for (const ov of overlays ?? []) {
    if (ov.type === 'marker' && ov.fillKey === fillKey) return ov;
  }
  return null;
}

/** 实时 bar 像素 x 是否落在视口（容器宽度）之外 —— R2「非跟随态有新数据看不见」判据。
 *  两种宽度读取方式都兼容（`clientWidth` / `getBoundingClientRect().width`）；宽度不可测（≤0，如未布局）
 *  或像素不可得（`null`）一律判为「不算视口外」，避免误报。（诊断 §3.5 实测：跟随态 rtX∈绘图区；
 *  非跟随态 rtX 跑到绘图区右侧 914px 外。） */
export function isOffViewport(el: HTMLElement | null, x: number | null): boolean {
  if (x == null || !el) return false;
  const width = el.clientWidth || el.getBoundingClientRect().width || 0;
  return width > 0 && (x < 0 || x > width);
}

/**
 * main-chart/sub-chart 承接组件：klinecharts 单实例（candle pane + VOL 副图 pane）。
 * 容器 h-full 填满 main-chart 区域（骨架已改 relative min-h-0 flex-1，见 01-dashboard.md §1 L3），
 * sub-chart 作为 region 锚点绝对定位占位；数据装载走 DataLoader：init/update → feed.loadInitial；
 * forward（向前滚动）→ feed.loadBefore。
 * 修复记录：旧实现 h-[125%] 跨两个骨架锚点，在 flex-1 父级下解析为 ~2^25 px 高，导致
 * K 线巨比例/只显左上、canvas 33M、滚动爆炸、卡崩溃（coder/report/014 §7.1）。
 */
export function KlineChart(props: KlineChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const programmaticScroll = useRef(false);
  /** 跨图同步注册表（P3）：无 provider（单图/宫格/工作台/关闭态）⇒ no-op，零副作用。 */
  const syncRegistry = useChartSyncRegistry();
  const syncRegistryRef = useRef(syncRegistry);
  syncRegistryRef.current = syncRegistry;
  const barSpaceLimitRef = useRef(props.barSpaceLimit);
  barSpaceLimitRef.current = props.barSpaceLimit;
  /** 用户手动缩放/平移过（非程序化）→ resize 不再重算（ADR-020 §2.6：「回到最新」恢复）。 */
  const manualAdjusted = useRef(false);
  /** 本次建图已应用的指标状态（启用/calcParams）——「状态差分」的基线；随建图重置（见 Effect L）。 */
  const appliedRef = useRef<AppliedIndicators | null>(null);
  const followRef = useRef(props.followLatest);
  followRef.current = props.followLatest;
  const onManualZoomRef = useRef(props.onManualZoom);
  onManualZoomRef.current = props.onManualZoom;
  const onInitErrorRef = useRef(props.onInitError);
  onInitErrorRef.current = props.onInitError;
  const onVisibleRangeChangeRef = useRef(props.onVisibleRangeChange);
  onVisibleRangeChangeRef.current = props.onVisibleRangeChange;
  const hasVisibleRangeCb = props.onVisibleRangeChange != null;
  const onWindowAppliedRef = useRef(props.onWindowApplied);
  onWindowAppliedRef.current = props.onWindowApplied;
  const onHighlightEndRef = useRef(props.onHighlightEnd);
  onHighlightEndRef.current = props.onHighlightEnd;
  const onPaneMetricsRef = useRef(props.onPaneMetrics);
  onPaneMetricsRef.current = props.onPaneMetrics;
  /** 用户是否手动拖过引擎 pane 分隔条（拖过 ⇒ 之后尊重其比例，除非硬下限越界；§2.6 第 7 项）。 */
  const userPaneDragRef = useRef(false);
  const hideCandles = props.hideCandles ?? false;
  const feed = props.feed;
  /** **最新** overlay props（ADR-028 D4.1 竞态修复）：标记重建**一律**读本 ref，
   *  **禁止**读挂载/某次渲染的快照 —— `/fills` 先于图表 K 线数据提交时，旧实现读的是挂载那次
   *  渲染的空数组 ⇒ 全部 B/S 标记永久丢失（tester 取证 §3.5）。 */
  const overlaysRef = useRef(props.overlays);
  overlaysRef.current = props.overlays;
  /** K 线数据**代际**：bar 数据可用/重载（初始取数、`resetData`、换 run/周期、warmup 补取、向前分页）
   *  ⇒ 递增 ⇒ 触发标记重建（次序无关的**事件/依赖驱动**信号；**不是**定时轮询）。 */
  const [barsGen, setBarsGen] = useState(0);
  const bumpBarsGen = useCallback(() => setBarsGen((g) => g + 1), []);
  /** overlay **内容**签名（marker 重建的依赖面；身份无关 ⇒ 幂等、无重建风暴）。 */
  const overlaysSig = useMemo(() => overlaySignature(props.overlays), [props.overlays]);
  /** 指标/pane 布局签名（指标勾选 + MA 窗口 + dcap 参数 + 隐藏 K 线 ⇒ pane 布局变化）。 */
  const paneLayoutSig = useMemo(
    () =>
      `${INDICATOR_DEFS.map((d) => (props.indicators[d.key] ? '1' : '0')).join('')}|${(
        props.maWindows ?? DEFAULT_MA_WINDOWS
      ).join(',')}|${props.dcapParams ? JSON.stringify(props.dcapParams) : ''}|${hideCandles ? '1' : '0'}`,
    [props.indicators, props.maWindows, props.dcapParams, hideCandles],
  );
  /** 配置视口（K 线根数；feed 未暴露 → 默认 120）。 */
  const viewportBars = feed.viewportBars ?? DEFAULT_KLINE_VIEWPORT_BARS;
  const fitRef = useRef<(chart: Chart) => BarSpaceFitResult | null>(() => null);
  // 「回到最新」的执行入口（Effect W 内定义；供非跟随态「有新数据」提示点击时复用）
  const scrollLatestRef = useRef<() => void>(() => {});
  // 实时 bar 标记：虚线 + 跳动闪烁（补定稿：与已收盘实体直条区分）
  const [rt, setRt] = useState<{ x: number | null; price: number; ts: string } | null>(null);
  /** R2：非跟随态下落在视口外的新 bar 计数（「有新数据」提示；**不改变视口**，点击后才跳最新）。 */
  const [pendingNew, setPendingNew] = useState(0);
  /** ADR-028 D4.1 观测性：已创建的买卖标记（`fillDot`）overlay 数。 */
  const [markerCount, setMarkerCount] = useState(0);
  /** overlay 重建世代（marker 数据/feed 变化 ⇒ 递增 ⇒ 高亮重新套用，防「重建后丢失」）。 */
  const [overlayEpoch, setOverlayEpoch] = useState(0);
  /** 高亮脉冲相位（0 = 无高亮；>0 = 高亮中；定时器递增驱动 overlay 重绘）。 */
  const [pulse, setPulse] = useState(0);

  /** ADR-028 D4.1 **唯一的 overlay 重建路径**（次序无关 + 幂等）：
   *  - 一律读**最新**值：`overlaysRef.current`（最新 props）+ `feed.bars`（最新数据），**不读任何渲染快照**；
   *  - 先按名清旧再建（`removeOverlay({name})` 幂等）⇒ 重复触发不会累积重复标记；
   *  - 只触碰 overlay 层：不动 dataList / 视口 / barSpace / 指标 pane（用户拖拽高度保持）；
   *  - 触发面（Effect M 依赖）：①`overlays` 内容变化 ②`barsGen`（bar 数据可用/代际变化）
   *    ③指标或 pane 布局变化。——**没有任何**定时器/固定等待。
   *  - 高亮 overlay（`fillDotHighlight`）不在清理名单里：由 Effect G 按 `overlayEpoch` 重放（精确到笔）。 */
  const rebuildOverlays = useCallback(
    (chart: Chart) => {
      // 测试环境 klinecharts 打桩（无 removeOverlay/createOverlay）时与修复前行为一致（零副作用）。
      if (typeof chart.removeOverlay !== 'function' || typeof chart.createOverlay !== 'function') return;
      chart.removeOverlay({ name: 'fillDot' });
      chart.removeOverlay({ name: 'simpleAnnotation' });
      chart.removeOverlay({ name: 'simpleTag' });
      chart.removeOverlay({ name: 'tradeRange' });
      const ovs = overlaysRef.current ?? [];
      if (ovs.length > 0) createChartOverlays(chart, ovs);
      setMarkerCount(createMarkerOverlays(chart, ovs, feed.bars));
      setOverlayEpoch((e) => e + 1);
    },
    [feed],
  );

  /** 横向铺满：按容器实际宽度 + 配置视口根数设 barSpace（`clamp(round(W/bars),1,50)`，与周期无关），
   *  并在容器上写 `data-viewport-fit`（§5 观测性）；宽度 ≤ 0（未布局）→ 不设置。 */
  const fitBarSpace = (chart: Chart): BarSpaceFitResult | null =>
    fitBarSpaceToViewport(chart, ref.current, viewportBars);
  fitRef.current = fitBarSpace;

  // 容器宽度变化（ResizeObserver）按当前视口重算；用户手动缩放/平移后不重算（enabled=false）。
  useBarSpaceFit({
    elRef: ref,
    getChart: () => chartRef.current,
    viewportBars,
    enabled: () => !manualAdjusted.current,
  });

  // Effect L —— 图表生命周期（**仅 mount 一次**）：容器不变 ⇒ chart 实例不重建。
  // 切 period / 切 stock / 改视口配置都是「数据面变化」，由下面的 Effect W 在同一实例上接线
  // ⇒ 指标视图布局天然保持：用户拖拽过的副图高度是 pane 的唯一记忆，`dispose`+`init` 会让全部 pane
  // 回布局默认高 `100`（02-spec §6「不得重建 pane」）。
  useEffect(() => {
    if (!ref.current) return;
    let chart: Chart | null = null;
    // 口径 9：卫星的 `barSpaceLimit` 只能在建图时给定（无运行时 setter）；未传 ⇒ 引擎默认 {1,50}。
    const limit = barSpaceLimitRef.current;
    try {
      chart = limit
        ? init(ref.current, {
            layout: { barSpaceLimit: { min: limit.min ?? 1, max: limit.max ?? 50 } },
          })
        : init(ref.current);
    } catch {
      chart = null;
    }
    if (!chart) {
      // 初始化失败必须**可见报错**（卫星实例走 onInitError ⇒ 页面横幅），不得静默留白。
      onInitErrorRef.current?.();
      return;
    }
    chartRef.current = chart;
    applyDarkTerminalStyles(chart);
    appliedRef.current = new Map(); // 新图 ⇒ 差分基线重置（不得跨建图复用）
    // 手动缩放/平移判定只依赖 ref，与数据面无关 ⇒ 生命周期内订阅一次即可（避免每次换 feed 重复订阅）。
    const manual = () => {
      if (programmaticScroll.current) return; // 程序化滚动（实时跟随 scrollLatest）不算用户操作
      manualAdjusted.current = true; // 用户手动缩放/平移 → 尊重手动视口，resize 不再重算（ADR-020 §2.6）
      onManualZoomRef.current();
    };
    chart.subscribeAction('onZoom', manual);
    chart.subscribeAction('onScroll', manual);
    return () => {
      dispose(chart);
      chartRef.current = null;
      setRt(null);
    };
  }, []);

  // Effect S —— 跨图同步成员注册（P3，02-spec §3.1）。仅多周期栈内挂 provider 时生效：
  // 基准实例（`hideCandles=false`）与卫星实例（`hideCandles=true`）各自注册；切周期 ⇒ 注销后重注册
  // （同一 chart 实例在原地换周期，见 Effect W）；卸载 ⇒ 注销 ⇒ 组内零残留。
  // 无 provider ⇒ no-op 注册表 ⇒ 单图/宫格/工作台/关闭态**不建组、不订阅、零副作用**。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    return syncRegistry.register({ chart, period: props.period, isBase: !hideCandles });
  }, [syncRegistry, props.period, hideCandles]);

  // Effect V —— 可见范围回调（ADR-028 D2 / 02-spec §7）。**仅当调用方传了回调**时才订阅
  // `onVisibleRangeChange` ⇒ 不传的既有调用方（看板/宫格/多周期/关闭态）订阅面与渲染**逐字节不变**（F8）。
  //
  // **程序化写窗期间仍然派发**（2026-09-20 修正）：负载里的 `bar_ts` / `bar_space` / `x_from_px` 是
  // K 线**实际绘制的 bar 序列与绘图区几何**（事实），曲线 x 映射与共用几何**必须**跟随（D2.1/D2.3-4）——
  // 「程序化写窗不回写窗口」由**消费方**按 `programmaticScroll`/回声抑制窗决定（见 useResultWindow），
  // 若在此直接吞掉事件，则 barSpace 被重构（如「全览」压到下限 1）后曲线会拿着**过期**的 bar 序列渲染。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !hasVisibleRangeCb) return;
    if (typeof chart.subscribeAction !== 'function' || typeof chart.getVisibleRange !== 'function') return;
    const onVisibleRange = () => {
      const r = readVisibleRangeTs(chart);
      if (r) onVisibleRangeChangeRef.current?.(r);
    };
    chart.subscribeAction('onVisibleRangeChange', onVisibleRange);
    return () => {
      if (typeof chart.unsubscribeAction === 'function') chart.unsubscribeAction('onVisibleRangeChange', onVisibleRange);
    };
  }, [hasVisibleRangeCb]);

  // Effect K —— 程序化写窗（ADR-028 D2/D4）：结果页 `[跳转]` / 全览 / 历史回退。
  // `windowCommand` 为**可选** prop（不传 ⇒ 本 effect 一条写语句都不执行）。
  // 写窗期间置 `programmaticScroll`（复用实时跟随/跨图同步同款回声抑制），并**读回断言**：
  // `setBarSpace` 越界会静默 return（F18 零容忍）⇒ 失败/未生效必须经 `onWindowApplied` 显式上报。
  useEffect(() => {
    const chart = chartRef.current;
    const cmd = props.windowCommand;
    if (!chart || !cmd) return;
    let result: WindowApplyResult | null = null;
    programmaticScroll.current = true;
    syncRegistryRef.current.beginProgrammatic();
    try {
      result = applyWindowOps(chart, cmd, barSpaceLimitRef.current);
    } catch (e) {
      result = {
        rev: cmd.rev,
        ok: false,
        error: `窗口命令异常：${(e as Error).message}`,
        requested_bar_space: null,
        observed: null,
      };
    } finally {
      syncRegistryRef.current.endProgrammatic();
      programmaticScroll.current = false;
    }
    if (result) onWindowAppliedRef.current?.(result);
  }, [props.windowCommand]);

  // Effect H —— 卫星实例隐藏 K 线（P2，02-spec §3.4 唯一可行手段）。
  // 必须在 Effect L 之后（此时 chart 已 init）：`state:'minimize' + minHeight:0` 折叠 candle pane，
  // 并用 `separator:{size:0}` 消除零高 pane 的残留分隔条；**不得**依赖 `height:0`（被库静默忽略）。
  // 只作用于本实例（基准实例 hideCandles=false ⇒ 一条调用都不发，T2-1 ⑥）。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !hideCandles) return;
    chart.setPaneOptions({ id: 'candle_pane', state: 'minimize', minHeight: 0 });
    chart.setStyles({ separator: { size: 0 } });
  }, [hideCandles]);

  // Effect W —— 数据接线（`feed` 身份变化 = 数据面变化：切 period / 切 stock / 视口配置变化）。
  // **同一 chart 实例上原地切换**（换 DataLoader + `setSymbol` + `setPeriod`；数据重载由引擎在这三步
  // 内部的 `store.resetData()` 完成）：
  //  - pane id / pane 顺序 / 用户拖拽高度全部保持（不 dispose、不 init ⇒ 指标不重建、差分基线不重置）；
  //  - **数据确实重置**：DataLoader 换成新 feed，init 回调整体替换 dataList（旧标的/旧周期的 bar 不残留）；
  //  - `manualAdjusted` 显式清 false ⇒ 保留 ADR-020 口径「切周期后可见根数仍 ≈ viewport_bars」
  //    （init 回调里的 `fitBarSpace` 只在非手动缩放态生效）。
  // 顺序要点：**先把新 loader 装上去**再 `setSymbol`/`setPeriod` —— 三者各自内部都会 `resetData()` 触发
  // 一次 init 取数，loader 在前可保证每一次取数都走新 feed（否则先触发的取数可能用旧 loader 回灌旧数据）。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    manualAdjusted.current = false; // 数据面变化（周期/标的切换）→ 回到自动视口归一
    let cancelled = false;
    let rtCallback: ((d: KLineData) => void) | null = null;
    /** 启动竞态缓冲（诊断 §3.3 / T-R4）：引擎尚未 `subscribeBar` 时到达的实时 bar 不得静默丢弃。
     *  上限保护：引擎短时间内不注册也不会无界增长（注册时按序冲刷）。 */
    let rtBuffer: KLineData[] = [];
    const RT_BUFFER_MAX = 300;
    setPendingNew(0); // 数据面变化：旧数据的「有新数据」提示失效

    const scrollLatest = () => {
      // `scrollToRealTime` 会**同步**派发 `onScroll`（klinecharts `ChartImp.scrollToRealTime` →
      // `StoreImp.scroll` → `executeAction('onScroll')`）——故程序化标记只在本调用期间为真：
      // 既不让程序化滚动被当成「用户手动调整」，也不会在调用之后留下长窗（否则紧随其后的真手势被误吞）。
      // 跨图同步同理：程序化滚动**不是用户交互**，不得作为 leader 驱动其它 pane（否则跨周期实时
      // 跟随会互相拉扯 = 违反 ④ 非跟随态不滚动契约）。
      programmaticScroll.current = true;
      syncRegistryRef.current.beginProgrammatic();
      try {
        chart.scrollToRealTime();
      } finally {
        syncRegistryRef.current.endProgrammatic();
        programmaticScroll.current = false;
      }
    };
    scrollLatestRef.current = scrollLatest;

    // 实时 bar 标记：更新最近一根 bar 的像素 x 以定位虚线/闪烁；返回像素 x（供可见性判定）
    const markRealtime = (kc: KLineData, price: number, ts: string): number | null => {
      let x: number | null = null;
      try {
        const px = chart.convertToPixel({ timestamp: kc.timestamp }, { paneId: 'candle_pane' }) as
          | { x: number; y: number }
          | undefined;
        x = px ? px.x + 2 : null;
      } catch {
        x = null;
      }
      setRt({ x, price, ts });
      return x;
    };

    chart.setDataLoader({
      getBars: async ({ type, callback }) => {
        // 修复「循环/重复 bar」：forward 只回调比已渲染最左 ts 更早的增量（loadBarsForKc 内部处理），
        // 不再把整段 feed.bars 回传；否则 klinecharts 引擎 data.concat(_dataList) 不查重会平方级叠加重复。
        try {
          const { bars, forward } = await loadBarsForKc(
            feed,
            type === 'forward' ? 'forward' : 'init',
            // 初始铺满：仅在用户未手动缩放/平移时执行（ADR-020 §2.6）——默认只读之外的原地重载
            // （warmup 热更新 ⇒ resetData 重跑 init）不得把用户的手动视口重置回配置视口。
            type === 'forward' ? null : () => {
              if (!manualAdjusted.current) fitBarSpace(chart);
            },
          );
          callback(bars, { forward, backward: false });
          // **数据代际信号**：引擎实际取到数据（init = 初始/重载；forward = 向前分页）⇒ 通知 overlay
          // 重建（只递增计数，**不在此处读 props 快照**）。真身由 `resetData`/`setSymbol`/`setPeriod`
          // 内部调用本回调 ⇒「换 run/换周期/加 warmup/向前翻页」全部自动落入标记重建面。
          if (bars.length > 0) bumpBarsGen();
        } catch {
          // 兜底：即使加载异常也保证 callback（避免 klinecharts _loading 卡死）；回空数组不会叠加重复。
          callback([], { forward: feed.hasMore, backward: false });
        }
      },
      subscribeBar: ({ callback }) => {
        rtCallback = callback;
        // 冲刷启动竞态缓冲：`subscribeBar` 注册前到达的 bar 按序补投（诊断 §3.3 / T-R4）
        if (rtBuffer.length > 0) {
          const buffered = rtBuffer;
          rtBuffer = [];
          for (const kc of buffered) callback(kc);
        }
      },
      unsubscribeBar: () => {
        rtCallback = null;
      },
    });
    chart.setSymbol({ ticker: props.code, pricePrecision: 3, volumePrecision: 0 });
    chart.setPeriod(PERIOD_MAP[props.period]);
    // **数据重置由引擎在上述三步内部完成**（库事实：`setDataLoader`/`setSymbol`(对象身份永不等 ⇒ 必走)
    // /`setPeriod` 各自调用 `store.resetData()` ⇒ `_processDataLoad('init')`，`index.esm.js:13518-13524 /
    // 13410-13434`）：三次 init 取数共用同一 feed `loadInitial` 的 loadPromise ⇒ **只发一次 HTTP**，
    // 最后一次回调整体替换 dataList（`_clearData` + `_dataList = data`）。
    // 这里不再额外 `chart.resetData()`：它只会多一次幂等的`_addData('init')` 重绘，不带来额外价值；
    // 且保持既有测试桩（未提供该 API 的工作台图）无需补齐。

    // overlay（开/平仓价位线 + 区间高亮）：同一 chart 实例跨 feed ⇒ 上一份数据面的 overlay 必须清掉
    // （`resetData` 只清/换数据、**不清 overlay**；实测：原地切换后 `getOverlays().length` 不变）。
    // **重建**统一交给 Effect M 的唯一路径（读最新 overlays + 最新 bars），此处只做「换数据面」清场；
    // 新数据面到位时 `bumpBarsGen()` 会再次触发重建（`/fills` 与 K 线数据的次序因此无关）。
    // `typeof` 能力检查：测试环境 klinecharts 打桩（无 removeOverlay）时行为与修复前一致。
    if (typeof chart.removeOverlay === 'function') chart.removeOverlay();

    // WS 实时：appendBar/updateBar → DataLoader subscribeBar 回调；
    // 滚动门控 = `followLatest && !manualAdjusted`（口径①：非跟随态/用户手动缩放后**绝不**拉回最右）；
    // 非跟随态且新 bar 落在视口之外 ⇒ 只计数并出「有新数据」提示（点击才跳最新，诊断 R2）。
    const offRt = feed.onRealtime((bar) => {
      const kc = toKcData(bar);
      if (rtCallback) rtCallback(kc);
      else {
        rtBuffer.push(kc);
        if (rtBuffer.length > RT_BUFFER_MAX) rtBuffer.shift();
      }
      // 先定视口（跟随态则滚到最右），再测像素 x（与修复前同序：标记位置不受旧视口影响）
      if (followRef.current && !manualAdjusted.current) scrollLatest();
      const x = markRealtime(kc, bar.close, bar.ts);
      if (!followRef.current && isOffViewport(ref.current, x)) setPendingNew((n) => n + 1);
    });
    // 幂等兜底（DataLoader 路径之外保证加载）；加载完成 = bar 数据可用 ⇒ 递增代际，由 Effect M
    // 按**最新** `overlays`/`feed.bars` 重建标记（跨周期 On-Screen 吸附/钳位）。
    // 仅在本 chart 仍存活**且本次接线未被换掉**时递增（防旧 feed 的迟到回调把上一份状态打在已换数据的新图上）。
    void feed.loadInitial().then(() => {
      if (!cancelled && chartRef.current === chart) bumpBarsGen();
    });

    return () => {
      cancelled = true;
      offRt();
      setRt(null); // 旧实时标记随旧 feed 失效（数据面已换）
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

  // Effect M —— overlay/标记**重建**（ADR-028 D4.1：**唯一**重建路径，次序无关 + 幂等）。
  // 触发面（全部为**事件/依赖驱动**，无定时器、无固定 sleep）：
  //   ① `overlays` 内容变化（`overlaysSig`；/fills、换 run、标记内容变化）；
  //   ② `barsGen` — K 线数据变为可用或**代际变化**（初始取数、`resetData`/warmup、换 run/周期、向前分页）；
  //   ③ `paneLayoutSig` — 指标或 pane 布局变化（指标勾选/MA 窗口/dcap 参数/隐藏 K 线）。
  // 目的：`/fills` 与 K 线数据的**提交次序**不再影响结果 —— 任一侧后到都会触发一次真正的重建。
  // 只重算 overlay 层：`removeOverlay({name})` 按名过滤，**不动** dataList / 视口 / barSpace / 指标 pane。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    rebuildOverlays(chart);
  }, [rebuildOverlays, overlaysSig, barsGen, paneLayoutSig]);

  // Effect P —— 高亮脉冲定时器（ADR-028 D4.1）：canvas 内无法用 CSS 动画 ⇒ **定时器驱动 overlay 重绘**。
  // 3 秒到点 ⇒ `setPulse(0)` 回常态，**不留永久选中态**。
  useEffect(() => {
    const key = props.highlightFillKey;
    if (!key) {
      setPulse(0);
      return;
    }
    setPulse(1);
    const interval = setInterval(() => setPulse((p) => p + 1), HIGHLIGHT_PULSE_MS);
    const timer = setTimeout(() => {
      clearInterval(interval);
      setPulse(0);
      onHighlightEndRef.current?.();
    }, HIGHLIGHT_DURATION_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [props.highlightFillKey, props.highlightRev]);

  // Effect G —— 把高亮落到**被点击的那一笔**（按 `fillKey` 判别；没找到 ⇒ 不画，由页面显式提示）。
  useEffect(() => {
    const chart = chartRef.current;
    const key = props.highlightFillKey;
    if (!chart || typeof chart.createOverlay !== 'function') return;
    if (typeof chart.removeOverlay === 'function') chart.removeOverlay({ name: 'fillDotHighlight' });
    if (!key || pulse === 0) return;
    const target = findMarkerByFillKey(props.overlays, key);
    if (!target) return;
    const snapped = snapTsToBars(feed.bars, target.ts);
    if (!snapped) return;
    ensureFillDotOverlayRegistered();
    chart.createOverlay({
      name: 'fillDotHighlight',
      paneId: 'candle_pane',
      lock: true,
      zLevel: 40,
      points: [{ timestamp: snapped.ts, value: target.price ?? 0 }],
      extendData: {
        text: target.text,
        label: target.label,
        color: target.color,
        stackIndex: target.stackIndex ?? 0,
        fillKey: key,
        highlight: true,
        pulse,
      } satisfies FillDotData,
    });
  }, [pulse, props.highlightFillKey, props.overlays, feed, overlayEpoch]);

  // 指标勾选/MA 窗口/dcap 参数热切换（状态差分：仅启用状态翻转才 create/remove；参数变化走 overrideIndicator）
  useEffect(() => {
    if (chartRef.current)
      syncIndicators(
        chartRef.current,
        props.indicators,
        props.maWindows ?? DEFAULT_MA_WINDOWS,
        props.dcapParams ?? DEFAULT_DCAP_PARAMS,
        (appliedRef.current ??= new Map()),
      );
  }, [props.indicators, props.maWindows, props.dcapParams]);

  // dcap 取数 warmup 热更新（02-spec §6 图表契约：**配置保存不得重建 pane**）。  // n_l/m（或 DCAP 开关）变化 ⇒ 让 feed 向前补取差额更早 bar，再原地重载数据（resetData 只重跑
  // DataLoader init：不 dispose/不 init 图表 ⇒ pane 高度/顺序/视口均保持，路径 B 不成立）。
  useEffect(() => {
    const chart = chartRef.current;
    const sync = feed.setWarmupBars;
    if (!chart || typeof sync !== 'function') return;
    let cancelled = false;
    void sync
      .call(feed, props.warmupBars ?? 0)
      .then((changed) => {
        if (changed && !cancelled && chartRef.current === chart) {
          chart.resetData();
          // 数据代际已变（向前补取了更早 bar ⇒ 目标 ts 的吸附点可能改到更近的 bar）：
          // 显式递增代际，（在引擎未接 DataLoader 的桩环境里也）保证标记按新 bar 序列重建。
          bumpBarsGen();
        }
      })
      .catch(() => {
        // 补取失败：保持既有数据（最左 warmup 段可能断线，向左翻页会自然补齐），不得打断渲染
      });
    return () => {
      cancelled = true;
    };
  }, [feed, props.warmupBars]);

  // 「回到最新」：followLatest 置 true 时主动滚到最右；false→true 时解除「手动缩放」抑制并重算 barSpace
  // （恢复「可见 ≈ N 根」口径，ADR-020 §2.6）。
  const prevFollowRef = useRef(props.followLatest);
  useEffect(() => {
    const chart = chartRef.current;
    const wasFollowing = prevFollowRef.current;
    prevFollowRef.current = props.followLatest;
    if (!props.followLatest || !chart) return;
    if (!wasFollowing) {
      manualAdjusted.current = false;
      fitRef.current(chart);
    }
    setPendingNew(0); // 回到跟随态：提示失效（视口已锚最右）
    programmaticScroll.current = true;
    syncRegistryRef.current.beginProgrammatic();
    try {
      chart.scrollToRealTime();
    } finally {
      syncRegistryRef.current.endProgrammatic();
      programmaticScroll.current = false;
    }
  }, [props.followLatest]);

  /** ADR-028 D4.1：高亮目标（判别键 ⇒ 精确到笔；`null`/找不到 ⇒ 无高亮）。 */
  const highlightTarget = findMarkerByFillKey(props.overlays, props.highlightFillKey);
  const highlightActive = pulse > 0 && highlightTarget != null;

  // Effect P —— ADR-028 §2.6 第 4 项 **pane 约束**（`paneConstraints` 缺省 ⇒ 本 effect 一条语句都不执行）。
  //
  // 为什么必须在引擎侧做：真身实测 `candle = 容器高 − x轴(26) − 分隔 − Σ副图(options.height)`，其中 candle 是
  // **唯一 flexible pane** ⇒ 不做干预时副图恒 100px、主图被吃到 67px（用户报告「看不出变化」的根因）。
  // 约束生效点：①指标 pane 布局变化（`paneLayoutSig`）②容器高变化（调用方重算 `subPanePx`）
  // ③引擎拖分隔条（引擎按 pane `minHeight` 自行 clamp，事后校验 + 必要时修正）。
  useEffect(() => {
    const chart = chartRef.current;
    const pc = props.paneConstraints;
    if (!chart || !pc) return;
    if (typeof chart.setPaneOptions !== 'function' || typeof chart.getPaneOptions !== 'function') return;
    const report = (metrics: KlinePaneMetrics) => {
      onPaneMetricsRef.current?.(metrics);
      try {
        ref.current?.setAttribute('data-pane-metrics', JSON.stringify(metrics));
        ref.current?.setAttribute('data-pane-clamped', String(metrics.clamped));
      } catch {
        /* ignore */
      }
    };
    const run = () => {
      applyPaneFloors(chart, pc); // 下限**恒**应用（只写 minHeight，不触发布局 ⇒ 视觉零变化）
      const m = measurePaneMetrics(chart, pc);
      const dragged = userPaneDragRef.current;
      // 主图触底 ⇒ 必须 'full' 重排（硬下限优先于用户比例）；否则用户拖过的比例用 'preserve' 保留
      const candleBottomedOut = m.candlePx != null && m.candlePx < pc.candleMinPx;
      const final = paneAllocationNeeded(m, pc, dragged)
        ? applyPaneAllocation(chart, pc, dragged && !candleBottomedOut ? 'preserve' : 'full')
        : m;
      final.userDragged = dragged;
      report(final);
    };
    run();
    // 布局沉降后回读一次（真身 `getSize` 读数）：否则 data-* 会停在中间态、事后回查失真。
    if (typeof requestAnimationFrame === 'function') {
      const h = requestAnimationFrame(() => {
        if (paneIdsOf(chart).length <= 1) run();
        else report(measurePaneMetrics(chart, pc));
      });
      return () => cancelAnimationFrame(h);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.paneConstraints?.candleMinPx,
    props.paneConstraints?.subPaneMinPx,
    props.paneConstraints?.subPanePx,
    props.paneConstraints?.subPaneTotalMaxPx,
    paneLayoutSig,
  ]);

  // Effect Q —— 引擎 pane 分隔条拖拽后的校验（同 §2.6 第 4 项：越界必须 clamp，不得静默接受）。
  // 引擎已在拖拽过程中按 reduced pane 的 `minHeight` 自行夹紧 ⇒ 此处只**回读校验**；若仍越界（引擎行为变更/
  // 极端容器高）⇒ 就地重应用约束（修正）并如实回执 `clamped=true`。
  useEffect(() => {
    const chart = chartRef.current;
    const pc = props.paneConstraints;
    if (!chart || !pc) return;
    if (typeof chart.subscribeAction !== 'function' || typeof chart.getPaneOptions !== 'function') return;
    const onPaneDrag = () => {
      // 用户拖过引擎分隔条 ⇒ 之后**尊重其比例**（ADR §2.6 第 7 项 + D4.2「已拖过的 pane 高度在指标切换后保持」）；
      // 只在硬下限越界时才纠正（默认分配目标不再强制）。
      userPaneDragRef.current = true;
      applyPaneFloors(chart, pc);
      const checked = measurePaneMetrics(chart, pc);
      const candleBottomedOut = checked.candlePx != null && checked.candlePx < pc.candleMinPx;
      const final = paneAllocationNeeded(checked, pc, true)
        ? applyPaneAllocation(chart, pc, candleBottomedOut ? 'full' : 'preserve')
        : checked;
      final.userDragged = true;
      onPaneMetricsRef.current?.(final);
      try {
        ref.current?.setAttribute('data-pane-metrics', JSON.stringify(final));
        ref.current?.setAttribute('data-pane-clamped', String(final.clamped));
      } catch {
        /* ignore */
      }
    };
    chart.subscribeAction('onPaneDrag', onPaneDrag);
    return () => {
      if (typeof chart.unsubscribeAction === 'function') chart.unsubscribeAction('onPaneDrag', onPaneDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.paneConstraints?.candleMinPx,
    props.paneConstraints?.subPaneMinPx,
    props.paneConstraints?.subPanePx,
    props.paneConstraints?.subPaneTotalMaxPx,
  ]);

  return (
    <div
      ref={ref}
      data-testid="kline-chart"
      data-highlight-key={props.highlightFillKey ?? ''}
      data-highlight-active={highlightActive ? 'true' : 'false'}
      data-highlight-pulse={pulse}
      data-marker-overlays={markerCount}
      style={props.heightPx != null ? { height: `${props.heightPx}px` } : undefined}
      className="relative h-full w-full"
    >
      {/* R2：非跟随态下新 bar 落在视口之外 ⇒ 「有新数据」提示（轻量、非侵入）。
          **不改变视口**；点击才 `scrollToRealTime()` 跳最新（诊断 §6(a)2）。 */}
      {pendingNew > 0 && (
        <button
          type="button"
          data-testid="kline-new-data-hint"
          onClick={() => {
            setPendingNew(0);
            scrollLatestRef.current();
          }}
          className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded border border-acc1/40 bg-panel/95 px-2 py-0.5 text-[10px] text-sky-300 shadow-lg hover:border-acc1/70 hover:text-sky-200"
        >
          <span>有新数据</span>
          {pendingNew > 1 && <span className="num opacity-80">{pendingNew}</span>}
        </button>
      )}
      {/* 实时 bar 标记（补定稿）：虚线竖线 + 跳动闪烁；定位到最近一根（进行中）bar 的像素 x */}
      {rt && rt.x != null && (
        <div data-realtime-marker className="pointer-events-none absolute inset-y-0 z-10" style={{ left: rt.x }}>
          <div className="h-full w-px border-l border-dashed border-sky-400/80" />
          <div className="absolute left-1/2 top-1 -translate-x-1/2 animate-pulse rounded-full bg-sky-400 shadow-[0_0_10px_2px_rgba(56,189,248,0.8)]" style={{ width: 8, height: 8 }} />
          <span className="num absolute left-1 top-3 -translate-x-1/2 whitespace-nowrap rounded bg-panel px-1 text-[10px] text-sky-300">
            {rt.price.toFixed(3)}
          </span>
        </div>
      )}
    </div>
  );
}
