import { useMemo, useState } from 'react';
import { BACKTEST_DEFAULTS } from '@/layouts/BacktestGrid';
import type { BacktestRunDto } from '@/api/types';
import { deltaClass, fmtPct } from './format';

export type HeatmapGranularity = 'month' | 'week';

interface PeriodCell {
  key: string;
  label: string;
  year: string;
  returnPct: number; // 区间内收益（比例）
  count: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function cstOf(ts: number): Date {
  return new Date(ts * 1000 + 8 * 3_600_000);
}

function periodKeyOf(ts: number, g: HeatmapGranularity): { key: string; label: string; year: string } {
  const d = cstOf(ts);
  if (g === 'month') {
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    return { key, label: `${d.getUTCMonth() + 1}月`, year: String(d.getUTCFullYear()) };
  }
  // ISO 周（周一为起）：年-第N周
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + jan1.getUTCDay() + 1) / 7);
  const key = `${d.getUTCFullYear()}-W${pad(week)}`;
  return { key, label: `W${week}`, year: String(d.getUTCFullYear()) };
}

/** 净值序列 → 按 月/周 分组收益（客户端聚合，发现季节性）。 */
export function aggregateByPeriod(series: Array<[number, number]>, g: HeatmapGranularity): PeriodCell[] {
  const buckets = new Map<string, { first: number; last: number; count: number; label: string; year: string }>();
  for (const [ts, equity] of series) {
    const { key, label, year } = periodKeyOf(ts, g);
    const b = buckets.get(key);
    if (b) {
      b.last = equity;
      b.count += 1;
    } else {
      buckets.set(key, { first: equity, last: equity, count: 1, label, year });
    }
  }
  const cells: PeriodCell[] = [];
  for (const [key, b] of buckets) {
    const base = b.first > 0 ? b.first : 1;
    cells.push({ key, label: b.label, year: b.year, returnPct: (b.last - b.first) / base, count: b.count });
  }
  return cells.sort((a, b) => a.key.localeCompare(b.key));
}

function heatColor(ret: number): string {
  if (ret > 0) {
    const a = Math.min(0.7, 0.15 + ret * 1.4);
    return `rgba(0,224,164,${a.toFixed(2)})`; // 绿（跌? 收益为正用 down 绿? 见 deltaClass 约定：down=绿）
  }
  const a = Math.min(0.7, 0.15 + Math.abs(ret) * 1.4);
  return `rgba(255,92,108,${a.toFixed(2)})`; // 红
}

/**
 * 页面⑤周期分析：月/周收益热力（Freqtrade UI 式）；GET /api/backtest/runs/{id} 净值客户端聚合。
 * 数据不足一月 → 占位；随 result-overview 三态。
 */
export function PeriodHeatmap({
  run,
  loading,
  error,
  onRetry,
}: {
  run: BacktestRunDto | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [granularity, setGranularity] = useState<HeatmapGranularity>(BACKTEST_DEFAULTS.heatmapGranularity);
  const series = run?.net_value?.series ?? [];
  const cells = useMemo(() => aggregateByPeriod(series, granularity), [series, granularity]);

  if (error) {
    return (
      <div className="flex h-full items-center gap-3 p-3 text-xs text-up">
        <span>周期分析加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="heatmap-skeleton">
        <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
      </div>
    );
  }
  if (cells.length < 2) {
    return <div className="flex h-full items-center justify-center text-xs text-dim">数据不足一月</div>;
  }

  const years = [...new Set(cells.map((c) => c.year))].sort();
  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-dim">月/周收益热力</span>
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            className={`rounded px-2 py-0.5 ${granularity === 'month' ? 'bg-acc1/20 text-txt' : 'text-dim'}`}
            onClick={() => setGranularity('month')}
          >
            月
          </button>
          <button
            type="button"
            className={`rounded px-2 py-0.5 ${granularity === 'week' ? 'bg-acc1/20 text-txt' : 'text-dim'}`}
            onClick={() => setGranularity('week')}
          >
            周
          </button>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-auto">
        {years.map((year) => {
          const rowCells = cells.filter((c) => c.year === year);
          return (
            <div key={year} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-dim">{year}</span>
              <div className="flex flex-1 gap-1">
                {rowCells.map((c) => (
                  <div
                    key={c.key}
                    className="flex h-7 flex-1 items-center justify-center rounded-md text-[10px] text-txt"
                    style={{ background: heatColor(c.returnPct) }}
                    title={`${c.key} ${fmtPct(c.returnPct)}`}
                    data-testid={`heat-cell-${c.key}`}
                  >
                    <span className={deltaClass(c.returnPct)}>{fmtPct(c.returnPct)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
