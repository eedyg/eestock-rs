import { useEffect, useMemo, useRef } from 'react';
import { dispose, init } from 'klinecharts';
import type { ApiClient } from '@/api/client';
import type { Period, SymbolSnapshot } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { KlineDataFeed } from './feed';
import { applyDarkTerminalStyles, PERIOD_MAP, toKcData } from './chartCommon';
import { cn } from '@/lib/utils';

export interface GridCellProps {
  symbol: SymbolSnapshot;
  period: Period;
  api: ApiClient;
  ws: WsClient;
  onPick(code: string): void;
}

/** grid-view 单格：K线+MA 缩略（无副图），code/名称/涨跌幅表头；点格进单图聚焦 */
export function GridCell({ symbol, period, api, ws, onPick }: GridCellProps) {
  // D2：与 SymbolList 同口径——停用/无数据标的不伪造 0.00%
  const inactive = !symbol.enabled;
  const hasData = symbol.enabled && symbol.last !== null;
  const chartRef = useRef<HTMLDivElement>(null);
  const feed = useMemo(
    () => new KlineDataFeed({ api, ws, code: symbol.code, period, pageSize: 120 }),
    [api, ws, symbol.code, period],
  );

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = init(chartRef.current);
    if (!chart) return;
    chart.setDataLoader({
      getBars: async ({ callback }) => {
        await feed.loadInitial();
        callback(feed.bars.map(toKcData), false);
      },
    });
    chart.setSymbol({ ticker: symbol.code, pricePrecision: 3, volumePrecision: 0 });
    chart.setPeriod(PERIOD_MAP[period]);
    applyDarkTerminalStyles(chart);
    chart.createIndicator({ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false);
    void feed.loadInitial(); // 幂等兜底
    return () => {
      dispose(chart);
      feed.dispose();
    };
  }, [feed, symbol.code, period]);

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
      <div ref={chartRef} className="min-h-0 flex-1" />
    </div>
  );
}
