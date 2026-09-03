import { useEffect, useRef } from 'react';
import { init, dispose, type Chart, type KLineData } from 'klinecharts';
import type { KlineDataFeed } from './feed';
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
 * 容器 h-[125%] 跨 main-chart 与 sub-chart 两个骨架锚点（骨架禁止手改，
 * 而 klinecharts 副图只能在单容器内分 pane，见 09-frontend.md §3 附注）。
 * 数据装载走 DataLoader：init/update → feed.loadInitial；forward（向前滚动）→ feed.loadBefore。
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

    chart.setDataLoader({
      getBars: async ({ type, callback }) => {
        try {
          if (type === 'forward') await feed.loadBefore();
          else await feed.loadInitial();
        } finally {
          callback(feed.bars.map(toKcData), { forward: feed.hasMore, backward: false });
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
      rtCallback?.(toKcData(bar));
      if (followRef.current) scrollLatest();
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

  return <div ref={ref} data-testid="kline-chart" className="h-[125%] w-full" />;
}
