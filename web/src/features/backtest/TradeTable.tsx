import { useMemo, useState } from 'react';
import type { BacktestRunDto, Trade } from '@/api/types';
import { deltaClass, fmtPct, fmtPnl, fmtTs } from './format';

type SortKey = 'open' | 'pnl' | 'hold';
type Dir = 'asc' | 'desc';

/**
 * 页面⑤交易明细表（Trades analysis 式）：每笔开平仓时刻/价/量/盈亏/持仓时长，排序筛选。
 * 数据 GET /api/backtest/runs/{id}（run.trades，open/close_ts 为 Unix 秒）。
 */
export function TradeTable({
  run,
  loading,
  error,
  onRetry,
  onShowTrade,
}: {
  run: BacktestRunDto | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onShowTrade: (trade: Trade) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('open');
  const [dir, setDir] = useState<Dir>('asc');
  const [only, setOnly] = useState<'all' | 'profit' | 'loss'>('all');

  const trades = run?.trades ?? [];

  const rows = useMemo(() => {
    const filtered = trades.filter((t) =>
      only === 'all' ? true : only === 'profit' ? t.pnl > 0 : t.pnl < 0,
    );
    const sorted = [...filtered].sort((a, b) => {
      const cmp = sortKey === 'open' ? a.open_ts - b.open_ts : sortKey === 'pnl' ? a.pnl - b.pnl : a.hold_bars - b.hold_bars;
      return dir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [trades, sortKey, dir, only]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setDir('asc');
    }
  };

  if (error) {
    return (
      <div className="flex h-full items-center gap-3 p-3 text-xs text-up">
        <span>交易明细加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="trade-skeleton">
        <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-dim">本次回测无交易</div>;
  }

  const headerCell = (label: string, k: SortKey) => (
    <th
      className="cursor-pointer select-none px-3 py-2 text-left text-[11px] font-medium text-dim"
      onClick={() => toggleSort(k)}
      data-testid={`sort-${k}`}
    >
      {label}
      {sortKey === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[11px] text-dim">
        <span>交易明细</span>
        <button
          type="button"
          className={`rounded px-2 py-0.5 ${only === 'all' ? 'bg-acc1/20 text-txt' : 'text-dim'}`}
          onClick={() => setOnly('all')}
        >
          全部
        </button>
        <button
          type="button"
          className={`rounded px-2 py-0.5 ${only === 'profit' ? 'bg-acc2/20 text-txt' : 'text-dim'}`}
          onClick={() => setOnly('profit')}
        >
          盈利
        </button>
        <button
          type="button"
          className={`rounded px-2 py-0.5 ${only === 'loss' ? 'bg-acc2/20 text-txt' : 'text-dim'}`}
          onClick={() => setOnly('loss')}
        >
          亏损
        </button>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {headerCell('开仓时刻', 'open')}
            <th className="px-3 py-2 text-left text-[11px] font-medium text-dim">开/平仓价</th>
            <th className="px-3 py-2 text-left text-[11px] font-medium text-dim">数量</th>
            {headerCell('盈亏', 'pnl')}
            {headerCell('持仓时长', 'hold')}
          </tr>
        </thead>
        <tbody>
          {rows.map((t: Trade) => (
            <tr
              key={`${t.open_ts}-${t.close_ts}`}
              className="cursor-pointer border-b border-line hover:bg-white/5"
              onClick={() => onShowTrade(t)}
              data-testid={`trade-row-${t.open_ts}`}
            >
              <td className="num px-3 py-2">{fmtTs(t.open_ts)}</td>
              <td className="num px-3 py-2">{t.open_price.toFixed(3)} → {t.close_price.toFixed(3)}</td>
              <td className="num px-3 py-2">{t.shares.toLocaleString('zh-CN')}</td>
              <td className={`num px-3 py-2 ${deltaClass(t.pnl)}`}>
                {fmtPnl(t.pnl)}（{fmtPct(t.pnl / (t.gross_value - t.pnl) || 0)}）
              </td>
              <td className="num px-3 py-2">{t.hold_bars}bar</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
