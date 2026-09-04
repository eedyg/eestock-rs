import { useEffect, useRef, useState } from 'react';
import { init, dispose, type Chart, type KLineData } from 'klinecharts';
import { defaultPageSizeForPeriod, type KlineDataFeed } from './feed';
import type { Period } from '@/api/types';
import type { IndicatorName } from './Toolbar';
import { applyDarkTerminalStyles, PERIOD_MAP, toKcData } from './chartCommon';

export interface KlineChartProps {
  feed: KlineDataFeed;
  code: string;
  period: Period;
  followLatest: boolean;
  indicators: Record<IndicatorName, boolean>;
  onManualZoom(): void;
}

const INDICATOR_DEFS: Array<{ key: IndicatorName | 'vol'; name: string; calcParams?: number[] }> = [
  { key: 'ma', name: 'MA', calcParams: [5, 10, 20] }, // 定稿 1b：主图 MA(5/10/20) 默认开
  { key: 'vol', name: 'VOL' }, // 副图1 成交量默认开（无开关）
  { key: 'macd', name: 'MACD' },
  { key: 'kdj', name: 'KDJ' },
  { key: 'boll', name: 'BOLL' },
];

function syncIndicators(chart: Chart, indicators: Record<IndicatorName, boolean>) {
  for (const def of INDICATOR_DEFS) {
    const enabled = def.key === 'vol' ? true : indicators[def.key];
    chart.removeIndicator({ name: def.name });
    if (enabled) {
      if (def.key === 'ma') {
        chart.createIndicator({ name: def.name, calcParams: def.calcParams, paneId: 'candle_pane' }, false);
      } else {
        chart.createIndicator({ name: def.name, calcParams: def.calcParams }, true);
      }
    }
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
    const target = defaultPageSizeForPeriod(props.period);
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
        try {
          if (type === 'forward') await feed.loadBefore();
          else await feed.loadInitial();
        } finally {
          callback(feed.bars.map(toKcData), { forward: feed.hasMore, backward: false });
          // 横向铺满：仅在初始 load 后固定 barSpace（向前分页不再变窄，窗口保持 ~2 交易日）
          if (type !== 'forward') fitBarSpace(chart);
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
    syncIndicators(chart, props.indicators);

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
    void feed.loadInitial(); // 幂等兜底（DataLoader 路径之外保证加载）

    return () => {
      offRt();
      dispose(chart);
      chartRef.current = null;
      setRt(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

  // 指标勾选热切换
  useEffect(() => {
    if (chartRef.current) syncIndicators(chartRef.current, props.indicators);
  }, [props.indicators]);

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
