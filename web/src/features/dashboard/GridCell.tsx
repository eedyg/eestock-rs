import { useEffect, useMemo, useRef } from 'react';
import { dispose, init, type Chart } from 'klinecharts';
import type { ApiClient } from '@/api/client';
import type { Period, SymbolSnapshot } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { KlineDataFeed, DEFAULT_KLINE_VIEWPORT_BARS } from './feed';
import { fitBarSpaceToViewport, useBarSpaceFit } from './barSpaceFit';
import { applyDarkTerminalStyles, PERIOD_MAP, toKcData } from './chartCommon';
import { cn } from '@/lib/utils';

/** grid-view 单格 MA 默认窗口（与后端默认 [5,10,20] 同构；未传 maWindows 时兜底） */
const DEFAULT_MA_WINDOWS: number[] = [5, 10, 20];

export interface GridCellProps {
  symbol: SymbolSnapshot;
  period: Period;
  api: ApiClient;
  ws: WsClient;
  onPick(code: string): void;
  /** MA 窗口（统一配置，主图+宫格共用；默认 [5,10,20]，从 GET /api/config/ma 读） */
  maWindows?: number[];
  /** 配置视口（K 线根数，主图+宫格统一；缺省 DEFAULT_KLINE_VIEWPORT_BARS=120）。
   *  旧实现硬编码 pageSize:120 导致「主图+宫格共用」名不副实（ADR-020 §1.3 F3）。 */
  viewportBars?: number;
}

/** grid-view 单格：K线+MA 缩略（无副图），code/名称/涨跌幅表头；点格进单图聚焦 */
export function GridCell({
  symbol,
  period,
  api,
  ws,
  onPick,
  maWindows: maWindowsProp = DEFAULT_MA_WINDOWS,
  viewportBars = DEFAULT_KLINE_VIEWPORT_BARS,
}: GridCellProps) {
  // D2：与 SymbolList 同口径——停用/无数据标的不伪造 0.00%
  const inactive = !symbol.enabled;
  const hasData = symbol.enabled && symbol.last !== null;
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<Chart | null>(null);
  const feed = useMemo(
    () => new KlineDataFeed({ api, ws, code: symbol.code, period, viewportBars }),
    [api, ws, symbol.code, period, viewportBars],
  );

  // 与主图同口径的横向铺满（同模块 DRY）：按格宽 + 配置视口根数设 barSpace。
  useBarSpaceFit({
    elRef: chartRef,
    getChart: () => chartInstanceRef.current,
    viewportBars,
    enabled: () => true, // 宫格不做手动缩放跟踪，resize 始终重算
  });

  // 图表/数据流创建销毁。**不把 maWindowsProp 放 deps**：MA 窗口变更仅重刷 MA 指标（见下 effect），
  // 否则会 dispose 掉 memoized feed 后重建（disposed feed 不可复用，grid view 在 MA 保存后会失效）。
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = init(chartRef.current);
    if (!chart) return;
    chartInstanceRef.current = chart;
    chart.setDataLoader({
      getBars: async ({ callback }) => {
        await feed.loadInitial();
        // 初始铺满：按格宽 + 配置视口根数设 barSpace（与主图同一公式，仅宽度不同）。
        fitBarSpaceToViewport(chart, chartRef.current, viewportBars);
        callback(feed.bars.map(toKcData), false);
      },
    });
    chart.setSymbol({ ticker: symbol.code, pricePrecision: 3, volumePrecision: 0 });
    chart.setPeriod(PERIOD_MAP[period]);
    applyDarkTerminalStyles(chart);
    void feed.loadInitial(); // 幂等兜底
    return () => {
      dispose(chart);
      feed.dispose();
      chartInstanceRef.current = null;
    };
  }, [feed, symbol.code, period]);

  // MA 窗口热更新：chart/feed 重建之外，仅重刷 MA 指标 calcParams（统一配置，主图+宫格共用）。
  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart) return;
    chart.removeIndicator({ name: 'MA' });
    chart.createIndicator({ name: 'MA', calcParams: maWindowsProp, paneId: 'candle_pane' }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maWindowsProp, period, symbol.code]);

  return (
    <div
      data-grid-cell
      className="flex min-h-0 cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-panel2 hover:border-acc1/40"
      onClick={() => onPick(symbol.code)}
    >
      <div className="flex items-baseline gap-2 px-3 pt-2 text-xs">
        <b className="num text-[13px] font-semibold">{symbol.code}</b>
        <span className="text-dim">{symbol.name}</span>
        {hasData ? (
          <span className={cn('num ml-auto', symbol.changePct >= 0 ? 'text-up' : 'text-down')}>
            {symbol.changePct >= 0 ? '+' : ''}
            {symbol.changePct.toFixed(2)}%
          </span>
        ) : (
          <span className="ml-auto num text-dim">{inactive ? '已停用' : '无数据'}</span>
        )}
      </div>
      <div ref={chartRef} data-grid-chart className="min-h-0 flex-1" />
    </div>
  );
}
