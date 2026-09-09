import { useEffect, useRef, useState } from 'react';
import {
  init,
  dispose,
  registerOverlay,
  type Chart,
  type KLineData,
  type OverlayCreateFiguresCallbackParams,
} from 'klinecharts';
import { defaultPageSizeForPeriod, DEFAULT_KLINE_VIEWPORT_DAYS } from './feed';
import type { Bar, Period } from '@/api/types';
import type { IndicatorName } from './Toolbar';
import { applyDarkTerminalStyles, PERIOD_MAP, toKcData } from './chartCommon';
import { loadBarsForKc, type KlineDataFeedLike } from './klineDataLoader';

/** KlineChart 承接所需的最小 feed 面（看板 KlineDataFeed 与弹窗 ScopedKlineFeed 均满足）。
 *  - bars/hasMore/loadInitial/loadBefore：DataLoader 取数（见 klineDataLoader.loadBarsForKc）。
 *  - onRealtime：订阅实时 bar（区间 feed 从不触发，看板 feed 走 WS）。
 *  - viewportDays：默认视口（交易日数，GET /api/config/kline；缺省 2 兜底）。fitBarSpace 铺满目标据此
 *    计算（而非恒用默认 2 视口），使初始可见 K 线数随配置变化。看板 KlineDataFeed 返回配置值，
 *    区间 ScopedKlineFeed 无配置 → 缺省 2（保持弹窗旧行为）。 */
export interface KlineChartFeedLike extends KlineDataFeedLike {
  viewportDays?: number;
  onRealtime(cb: (bar: Bar) => void): () => void;
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
  /** 标记文本：开仓 'B' / 平仓 'S'。 */
  text: 'B' | 'S';
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
}

/** 主图 MA 默认窗口（GET /api/config/ma 缺省/未加载时兜底；与后端默认 [5,10,20] 同构） */
const DEFAULT_MA_WINDOWS: number[] = [5, 10, 20];

const INDICATOR_DEFS: Array<{ key: IndicatorName | 'vol'; name: string; calcParams?: number[] }> = [
  { key: 'ma', name: 'MA' }, // 定稿 1b：主图 MA 默认开；calcParams 取 maWindows（统一配置）
  { key: 'vol', name: 'VOL' }, // 副图1 成交量默认开（无开关）
  { key: 'macd', name: 'MACD' },
  { key: 'kdj', name: 'KDJ' },
  { key: 'boll', name: 'BOLL' },
];

function syncIndicators(chart: Chart, indicators: Record<IndicatorName, boolean>, maWindows: number[]) {
  for (const def of INDICATOR_DEFS) {
    const enabled = def.key === 'vol' ? true : indicators[def.key];
    chart.removeIndicator({ name: def.name });
    if (enabled) {
      if (def.key === 'ma') {
        chart.createIndicator({ name: def.name, calcParams: maWindows, paneId: 'candle_pane' }, false);
      } else {
        chart.createIndicator({ name: def.name, calcParams: def.calcParams }, true);
      }
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
 *  周期切换（feed 变 → 整图重建）后重新 createOverlay，回到当前周期已加载 bar 重新吸附。
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
  const followRef = useRef(props.followLatest);
  followRef.current = props.followLatest;
  const onManualZoomRef = useRef(props.onManualZoom);
  onManualZoomRef.current = props.onManualZoom;
  const feed = props.feed;
  // 实时 bar 标记：虚线 + 跳动闪烁（补定稿：与已收盘实体直条区分）
  const [rt, setRt] = useState<{ x: number | null; price: number; ts: string } | null>(null);

  /** 横向铺满修复：按容器实际宽度 + 默认视口（2 交易日）设置 barSpace，
   *  使蜡烛横向铺满图表区、无左右死区（同根因族：原 h-[125%]+flex 导致尺寸/比例错乱）。 */
  const fitBarSpace = (chart: Chart, extraPx = 0) => {
    const el = ref.current;
    const width = el ? el.clientWidth : 0;
    if (width <= 0) return;
    // 铺满目标 = 配置视口（viewportDays×每日bar）而非恒 2 视口：feed 按 viewportDays 加载了
    // BARS_PER_TRADING_DAY×viewportDays 根，barSpace 用同一个 target 才能让初始可见 K 线数随配置变。
    const target = defaultPageSizeForPeriod(props.period, props.feed.viewportDays ?? DEFAULT_KLINE_VIEWPORT_DAYS);
    const space = Math.max(1, Math.min(50, Math.round((width - extraPx) / target)));
    chart.setBarSpace(space);
  };

  // 建/销 chart 实例 + 数据接线（feed 随 code/period 变化而更换，整图重建）
  useEffect(() => {
    if (!ref.current) return;
    const chart = init(ref.current);
    if (!chart) return;
    chartRef.current = chart;
    let rtCallback: ((d: KLineData) => void) | null = null;

    const scrollLatest = () => {
      programmaticScroll.current = true;
      chart.scrollToRealTime();
      setTimeout(() => {
        programmaticScroll.current = false;
      }, 0);
    };

    // 实时 bar 标记：更新最近一根 bar 的像素 x 以定位虚线/闪烁
    const markRealtime = (kc: KLineData, price: number, ts: string) => {
      try {
        const px = chart.convertToPixel({ timestamp: kc.timestamp }, { paneId: 'candle_pane' }) as
          | { x: number; y: number }
          | undefined;
        setRt({ x: px ? px.x + 2 : null, price, ts });
      } catch {
        setRt({ x: null, price, ts });
      }
    };

    chart.setDataLoader({
      getBars: async ({ type, callback }) => {
        // 修复「循环/重复 bar」：forward 只回调比已渲染最左 ts 更早的增量（loadBarsForKc 内部处理），
        // 不再把整段 feed.bars 回传；否则 klinecharts 引擎 data.concat(_dataList) 不查重会平方级叠加重复。
        try {
          const { bars, forward } = await loadBarsForKc(
            feed,
            type === 'forward' ? 'forward' : 'init',
            type === 'forward' ? null : () => fitBarSpace(chart),
          );
          callback(bars, { forward, backward: false });
        } catch {
          // 兜底：即使加载异常也保证 callback（避免 klinecharts _loading 卡死）；回空数组不会叠加重复。
          callback([], { forward: feed.hasMore, backward: false });
        }
      },
      subscribeBar: ({ callback }) => {
        rtCallback = callback;
      },
      unsubscribeBar: () => {
        rtCallback = null;
      },
    });
    chart.setSymbol({ ticker: props.code, pricePrecision: 3, volumePrecision: 0 });
    chart.setPeriod(PERIOD_MAP[props.period]);
    applyDarkTerminalStyles(chart);
    syncIndicators(chart, props.indicators, props.maWindows ?? DEFAULT_MA_WINDOWS);

    // overlay（开/平仓价位线 + 区间高亮）：看板不传则跳过，保持默认行为不变
    if (props.overlays && props.overlays.length > 0) {
      createChartOverlays(chart, props.overlays);
    }

    // WS 实时：appendBar/updateBar → DataLoader subscribeBar 回调；跟随最新则锁定视口最右
    const offRt = feed.onRealtime((bar) => {
      const kc = toKcData(bar);
      rtCallback?.(kc);
      if (followRef.current) scrollLatest();
      markRealtime(kc, bar.close, bar.ts);
    });
    const manual = () => {
      if (!programmaticScroll.current) onManualZoomRef.current();
    };
    chart.subscribeAction('onZoom', manual);
    chart.subscribeAction('onScroll', manual);
    // 幂等兜底（DataLoader 路径之外保证加载）；加载完成后依「已加载 bar」吸附/钳位创建 B/S 标记
    // （跨周期 On-Screen）。仅在本 chart 仍存活时创建（防周期切换/卸载后仍回打点）。
    void feed.loadInitial().then(() => {
      if (chartRef.current === chart) {
        createMarkerOverlays(chart, props.overlays ?? [], feed.bars);
      }
    });

    return () => {
      offRt();
      dispose(chart);
      chartRef.current = null;
      setRt(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

  // 指标勾选/MA 窗口热切换
  useEffect(() => {
    if (chartRef.current) syncIndicators(chartRef.current, props.indicators, props.maWindows ?? DEFAULT_MA_WINDOWS);
  }, [props.indicators, props.maWindows]);

  // 「回到最新」：followLatest 置 true 时主动滚到最右
  useEffect(() => {
    const chart = chartRef.current;
    if (props.followLatest && chart) {
      programmaticScroll.current = true;
      chart.scrollToRealTime();
      setTimeout(() => {
        programmaticScroll.current = false;
      }, 0);
    }
  }, [props.followLatest]);

  return (
    <div ref={ref} data-testid="kline-chart" className="relative h-full w-full">
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
