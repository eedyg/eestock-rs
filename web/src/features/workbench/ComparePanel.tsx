import { useMemo } from 'react';
import type { WorkbenchCompareItem, WorkbenchMetrics } from '@/api/types';
import { fmtHoldBars, fmtMoney, fmtPct, fmtRatio, periodLabel } from '@/features/backtest/format';
import { areaBelow, downsample, extentOf, lineFrom, mapLine } from './chartUtils';

const W = 1000;
const H = 220;
const PAD = 10;
const COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#34d399'];

const METRIC_ROWS: Array<{ key: keyof WorkbenchMetrics; label: string; deco: (m: WorkbenchMetrics) => string }> = [
  { key: 'net_profit', label: 'net_profit', deco: (m) => fmtMoney(m.net_profit) },
  { key: 'max_drawdown', label: 'max_drawdown', deco: (m) => fmtPct(m.max_drawdown) },
  { key: 'sharpe', label: 'sharpe', deco: (m) => fmtRatio(m.sharpe) },
  { key: 'win_rate', label: 'win_rate', deco: (m) => fmtPct(m.win_rate) },
  { key: 'profit_factor', label: 'profit_factor', deco: (m) => fmtRatio(m.profit_factor) },
  { key: 'annualized_return', label: 'annualized_return', deco: (m) => fmtPct(m.annualized_return) },
  { key: 'trade_count', label: 'trade_count', deco: (m) => String(m.trade_count) },
  { key: 'avg_hold_bars', label: 'avg_hold_bars', deco: (m) => fmtHoldBars(m.avg_hold_bars) },
];

/**
 * compare 模式（ADR §13.5：≤4 个已完成 run → 净值叠加图 + 绩效并排表）。
 * 数据源 POST /api/workbench/runs/compare（输入序；未知/未成功 run 后端已跳过）。
 */
export function ComparePanel({
  items,
  loading,
  error,
  onRetry,
  onExit,
}: {
  items: WorkbenchCompareItem[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onExit: () => void;
}) {
  const rows = items ?? [];
  const seriesOf = useMemo(() => {
    const sampled = rows.map((r) => downsample(r.net_value));
    const { min, max } = extentOf(sampled.flatMap((s) => s.map((p) => p[1])));
    return sampled.map((s) => mapLine(s, min, max, W, H, PAD));
  }, [rows]);

  if (error) {
    return (
      <div className="flex h-full items-center gap-3 p-4 text-xs text-up" data-testid="wb-compare-error">
        <span>对比加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading || !items) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="wb-compare-skeleton">
        <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3" data-testid="wb-compare-panel">
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim">对比视图（叠加 {rows.length} 次运行净值）</span>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg border border-line px-3 py-0.5 text-xs text-dim hover:text-txt"
          data-testid="wb-compare-exit"
        >
          返回单次
        </button>
      </div>
      <div className="flex flex-wrap gap-3 text-[11px]">
        {rows.map((r, i) => (
          <span key={r.run_id} className="num" style={{ color: COLORS[i % COLORS.length] }}>
            {r.name || r.run_id} · {r.symbol} {periodLabel(r.period)}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-56 w-full shrink-0 rounded-lg border border-line bg-panel2" data-testid="wb-compare-chart">
        <g opacity="0.2" stroke="#fff" strokeWidth="0.5">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} y1={H * f} x2={W} y2={H * f} />
          ))}
        </g>
        {seriesOf.map((pts, i) => (
          <g key={rows[i]!.run_id}>
            <polygon points={areaBelow(pts, H - PAD)} fill={COLORS[i % COLORS.length]} opacity="0.05" />
            <polyline points={lineFrom(pts)} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" />
          </g>
        ))}
      </svg>
      <table className="w-full border-collapse text-xs" data-testid="wb-compare-table">
        <thead>
          <tr>
            <th className="border-b border-line px-3 py-2 text-left text-[11px] font-medium text-dim">指标</th>
            {rows.map((r, i) => (
              <th key={r.run_id} className="border-b border-line px-3 py-2 text-left text-[11px] font-medium" style={{ color: COLORS[i % COLORS.length] }}>
                {r.name || r.run_id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((row) => (
            <tr key={row.key} className="border-b border-line/50">
              <td className="px-3 py-2 text-dim">{row.label}</td>
              {rows.map((r) => (
                <td key={r.run_id} className="num px-3 py-2">
                  {row.deco(r.metrics)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
