import { useMemo, useState } from 'react';
import type { BacktestRunDto } from '@/api/types';
import { gridGroups } from './store';
import { fmtPct, fmtRatio, periodLabel } from './format';

type RankSort = 'net' | 'sharpe';

function fmtParamValue(v: unknown): string {
  if (typeof v === 'number') {
    const r = Math.round(v * 100) / 100;
    return String(r);
  }
  return String(v ?? '');
}

function fmtParams(p: Record<string, unknown>): string {
  const entries = Object.entries(p).filter(([, v]) => v !== undefined && v !== null);
  return entries.map(([k, v]) => `${k}=${fmtParamValue(v)}`).join(' ');
}

/**
 * 页面⑤网格排行：参数组合/总收益/夏普（按总收益或夏普排序，点行进单次详情）。
 * 数据 GET /api/backtest/runs（网格任务组共享 group_id）。三态：骨架行/「无网格任务组」/错误条+重试。
 */
export function GridRank({
  runs,
  loading,
  error,
  onRetry,
  onSelectRun,
}: {
  runs: BacktestRunDto[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelectRun: (id: number) => void;
}) {
  const [sort, setSort] = useState<RankSort>('net');

  const groups = useMemo(() => gridGroups(runs ?? []), [runs]);

  // 排行行：每个 grid 子任务一行（参数组合 + 指标），按总收益/夏普排序
  const rows = useMemo(() => {
    const flat = groups.flatMap((g) =>
      g.runs.map((r) => ({
        run: r,
        groupId: g.groupId,
        paramsText: fmtParams(r.params as Record<string, unknown>),
      })),
    );
    return flat.sort((a, b) => {
      const av = a.run.metrics?.[sort === 'net' ? 'net_profit' : 'sharpe'] ?? -Infinity;
      const bv = b.run.metrics?.[sort === 'net' ? 'net_profit' : 'sharpe'] ?? -Infinity;
      return bv - av;
    });
  }, [groups, sort]);

  if (error) {
    return (
      <div className="flex h-full items-center gap-3 p-3 text-xs text-up">
        <span>网格排行加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading || !runs) {
    return (
      <div className="flex h-full flex-col gap-2 p-3" data-testid="gridrank-skeleton">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-6 animate-pulse rounded bg-white/10" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-dim">无网格任务组</div>;
  }

  const sortBtn = (k: RankSort, label: string) => (
    <button
      type="button"
      className={`rounded px-2 py-0.5 ${sort === k ? 'bg-acc1/20 text-txt' : 'text-dim'}`}
      onClick={() => setSort(k)}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-dim">
        <span>网格任务组排行（{groups.length} 组）</span>
        {sortBtn('net', '按总收益')}
        {sortBtn('sharpe', '按夏普')}
      </div>
      <table className="w-full border-collapse text-xs" data-testid="grid-rank-table">
        <thead>
          <tr>
            <th className="px-3 py-2 text-left text-[11px] font-medium text-dim">#</th>
            <th className="px-3 py-2 text-left text-[11px] font-medium text-dim">参数组合</th>
            <th className="px-3 py-2 text-right text-[11px] font-medium text-dim">总收益</th>
            <th className="px-3 py-2 text-right text-[11px] font-medium text-dim">夏普</th>
            <th className="px-3 py-2 text-right text-[11px] font-medium text-dim">最大回撤</th>
            <th className="px-3 py-2 text-right text-[11px] font-medium text-dim">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const m = row.run.metrics;
            return (
              <tr
                key={row.run.id}
                className="cursor-pointer border-b border-line hover:bg-white/5"
                onClick={() => onSelectRun(row.run.id)}
                data-testid={`gridrank-row-${row.run.id}`}
              >
                <td className="num px-3 py-2 text-dim">{idx + 1}</td>
                <td className="num px-3 py-2">{row.paramsText}</td>
                <td className={`num px-3 py-2 text-right ${m && m.net_profit >= 0 ? 'text-up' : 'text-down'}`}>
                  {m ? fmtPct(m.net_profit / 100000) : '—'}
                </td>
                <td className="num px-3 py-2 text-right">{m ? fmtRatio(m.sharpe) : '—'}</td>
                <td className="num px-3 py-2 text-right text-down">{m ? fmtPct(m.max_drawdown) : '—'}</td>
                <td className="px-3 py-2 text-right text-dim">{periodLabel(row.run.period)} · {row.run.status}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
