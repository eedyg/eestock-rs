import { useEffect, useRef, useState } from 'react';
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
import {
  DEFAULT_DCAP_PARAMS,
  DCAP_INDICATOR_NAME,
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
}

/** 主图 MA 默认窗口（GET /api/config/ma 缺省/未加载时兜底；与后端默认 [5,10,20] 同构） */
const DEFAULT_MA_WINDOWS: number[] = [5, 10, 20];

const INDICATOR_DEFS: Array<{ key: IndicatorName; name: string; calcParams?: number[] }> = [
  { key: 'ma', name: 'MA' }, // 定稿 1b：主图 MA 默认开；calcParams 取 maWindows（统一配置）
  { key: 'vol', name: 'VOL' }, // 副图1 成交量：与其它指标并列的开关（默认开，见 DASHBOARD_DEFAULTS.indicators）
  { key: 'macd', name: 'MACD' },
  { key: 'kdj', name: 'KDJ' },
  { key: 'boll', name: 'BOLL' },
  { key: 'dcap', name: DCAP_INDICATOR_NAME }, // ADR-021：dcap 三线（独立副图 pane，precision 5）
];

/** 已应用指标状态：`name → 已应用的 calcParams`。
 *  **必须是「本次建图」的组件级持有**（随建图重置）：
 *  - 不得用模块级 `WeakMap<Chart, …>`——测试里的 chart 桩跨用例共享同一对象，会被污染；
 *  - 不得用 `chart.getIndicators(...)` 判在场——既有测试桩未提供该 API（会大面积 TypeError）。 */
type AppliedIndicators = Map<string, number[]>;

function sameParams(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `createIndicator` 参数：目标 calcParams 为空（内置模板指标 VOL/MACD/KDJ/BOLL）时**必须省略该字段**
 *  —— 传 `calcParams: []` 会覆盖模板默认参数（真渲染实测：VOL 的 calcParams 变 `[]`）。 */
function createIndicatorValue(name: string, calcParams: number[]): { name: string; calcParams?: number[] } {
  return calcParams.length > 0 ? { name, calcParams } : { name };
}

/** 各指标目标 calcParams（MA 取统一配置窗口；DCAP 取 8 参显示参数；其余用内置默认）。 */
function desiredCalcParams(
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
  if (tradeRangeRegistered || typeof registerOverlay !== 'function') return;
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
function createMarkerOverlays(
  chart: Chart,
  overlays: ReadonlyArray<KlineOverlay>,
  bars: ReadonlyArray<{ ts: string }>,
) {
  for (const ov of overlays) {
    if (ov.type !== 'marker') continue;
    const snapped = snapTsToBars(bars, ov.ts);
    if (!snapped) continue;
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
  }
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
  const hideCandles = props.hideCandles ?? false;
  const feed = props.feed;
  /** 配置视口（K 线根数；feed 未暴露 → 默认 120）。 */
  const viewportBars = feed.viewportBars ?? DEFAULT_KLINE_VIEWPORT_BARS;
  const fitRef = useRef<(chart: Chart) => BarSpaceFitResult | null>(() => null);
  // 「回到最新」的执行入口（Effect W 内定义；供非跟随态「有新数据」提示点击时复用）
  const scrollLatestRef = useRef<() => void>(() => {});
  // 实时 bar 标记：虚线 + 跳动闪烁（补定稿：与已收盘实体直条区分）
  const [rt, setRt] = useState<{ x: number | null; price: number; ts: string } | null>(null);
  /** R2：非跟随态下落在视口外的新 bar 计数（「有新数据」提示；**不改变视口**，点击后才跳最新）。 */
  const [pendingNew, setPendingNew] = useState(0);

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
  // 程序化写窗期间（Effect K）的回声由 `programmaticScroll` 抑制（同 onZoom/onScroll 口径）。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !hasVisibleRangeCb) return;
    if (typeof chart.subscribeAction !== 'function' || typeof chart.getVisibleRange !== 'function') return;
    const onVisibleRange = () => {
      if (programmaticScroll.current) return; // 程序化写窗 ⇒ 不回写（防回声 + 防乱序）
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

    // overlay（开/平仓价位线 + 区间高亮）：同一 chart 实例跨 feed ⇒ 必须先清旧再按新数据重建。
    // `resetData` 只清/换数据、**不清 overlay**（实测：原地切换后 `getOverlays().length` 不变），
    // 否则切标的/周期后残留上一份 overlay（工作台 B/S 标记/价位线）。
    // `typeof` 能力检查：测试环境 klinecharts 打桩（无 removeOverlay）时行为与修复前一致。
    if (typeof chart.removeOverlay === 'function') chart.removeOverlay();
    if (props.overlays && props.overlays.length > 0) {
      createChartOverlays(chart, props.overlays);
    }

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
    // 幂等兜底（DataLoader 路径之外保证加载）；加载完成后依「已加载 bar」吸附/钳位创建 B/S 标记
    // （跨周期 On-Screen）。仅在本 chart 仍存活**且本次接线未被换掉**时创建（防旧 feed 的迟到回调
    // 把上一份标记打在已换数据的新图上）。
    void feed.loadInitial().then(() => {
      if (!cancelled && chartRef.current === chart) {
        createMarkerOverlays(chart, props.overlays ?? [], feed.bars);
      }
    });

    return () => {
      cancelled = true;
      offRt();
      setRt(null); // 旧实时标记随旧 feed 失效（数据面已换）
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

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

  // dcap 取数 warmup 热更新（02-spec §6 图表契约：**配置保存不得重建 pane**）。
  // n_l/m（或 DCAP 开关）变化 ⇒ 让 feed 向前补取差额更早 bar，再原地重载数据（resetData 只重跑
  // DataLoader init：不 dispose/不 init 图表 ⇒ pane 高度/顺序/视口均保持，路径 B 不成立）。
  useEffect(() => {
    const chart = chartRef.current;
    const sync = feed.setWarmupBars;
    if (!chart || typeof sync !== 'function') return;
    let cancelled = false;
    void sync
      .call(feed, props.warmupBars ?? 0)
      .then((changed) => {
        if (changed && !cancelled && chartRef.current === chart) chart.resetData();
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

  return (
    <div
      ref={ref}
      data-testid="kline-chart"
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
