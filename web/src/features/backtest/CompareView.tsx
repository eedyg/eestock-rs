import { useMemo } from 'react';
import type { BacktestRunDto, Metrics } from '@/api/types';
import { areaBelow, extentOf, lineFrom, mapLine } from './chartUtils';
import { fmtHoldBars, fmtMoney, fmtPct, fmtRatio, periodLabel } from './format';

const W = 1000;
const H = 220;
const PAD = 10;
const COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#34d399', '#fb923c', '#f472b6', '#818cf8', '#22d3ee'];

function metricRows(): Array<{ key: keyof Metrics; label: string; deco: (m: Metrics) => string }> {
  return [
    { key: 'net_profit', label: 'Net Profit', deco: (m) => fmtMoney(m.net_profit) },
    { key: 'max_drawdown', label: 'Max Drawdown', deco: (m) => fmtPct(m.max_drawdown) },
    { key: 'sharpe', label: 'Sharpe', deco: (m) => fmtRatio(m.sharpe) },
    { key: 'win_rate', label: '胜率', deco: (m) => fmtPct(m.win_rate) },
    { key: 'profit_factor', label: '盈亏比', deco: (m) => fmtRatio(m.profit_factor) },
    { key: 'annualized_return', label: '年化', deco: (m) => fmtPct(m.annualized_return) },
    { key: 'trade_count', label: '总交易数', deco: (m) => String(m.trade_count) },
    { key: 'avg_hold_bars', label: '平均持仓', deco: (m) => fmtHoldBars(m.avg_hold_bars) },
  ];
}

/**
 * 页面⑤对比视图：2-N 次回测叠加净值曲线 + 指标并排表（GET /api/backtest/compare?ids=）。
 * 三态：骨架图 / 「至少勾选 2 次已完成回测」 / 错误占位+重试。
 */
export function CompareView({
  runs,
  loading,
  error,
  onRetry,
  onExit,
}: {
  runs: BacktestRunDto[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onExit: () => void;
}) {
  const rows = metricRows();
  const done = useMemo(() => (runs ?? []).filter((r) => r.status === 'done'), [runs]);

  if (error) {
    return (
      <div className="flex h-full items-center gap-3 p-4 text-xs text-up">
        <span>对比加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="compare-skeleton">
        <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
      </div>
    );
  }
  if (done.length < 2) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-dim">
        <span>至少勾选 2 次已完成回测</span>
        <button type="button" onClick={onExit} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          返回单次视图
        </button>
      </div>
    );
  }

  const allEquities = done.flatMap((r) => r.net_value?.series.map((s) => s[1]) ?? []);
  const { min, max } = extentOf(allEquities);
  const seriesOf = done.map((r) => mapLine(r.net_value?.series ?? [], min, max, W, H, PAD));

  return (
    <div className="flex h-full flex-col overflow-auto p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-dim">对比视图（叠加 {done.length} 次）</span>
        <div className="text-xs flex gap-3">
          {done.map((r, i) => (
            <span key={r.id} className="num text-[11px]" style={{ color: COLORS[i % COLORS.length] }}>
              {r.id}·{r.code} {periodLabel(r.period)}
            </span>
          ))}
        </div>
        <button type="button" onClick={onExit} className="rounded-lg border border-line px-3 py-0.5 text-xs text-dim hover:text-txt">
          返回单次
        </button>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-56 w-full shrink-0" data-testid="compare-chart">
        <g opacity="0.2" stroke="#fff" strokeWidth="0.5">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" y1={H * f} x2={W} y2={H * f} />
          ))}
        </g>
        {seriesOf.map((pts, i) => (
          <g key={`series-${i}`}>
            <polygon points={areaBelow(pts, H - PAD)} fill={COLORS[i % COLORS.length]} opacity="0.05" />
            <polyline points={lineFrom(pts)} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" />
          </g>
        ))}
      </svg>
      <table className="mt-3 w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="border-b border-line px-3 py-2 text-left text-[11px] font-medium text-dim">指标</th>
            {done.map((r, i) => (
              <th key={r.id} className="border-b border-line px-3 py-2 text-left text-[11px] font-medium text-dim" style={{ color: COLORS[i % COLORS.length] }}>
                {r.id} · {r.code}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-line">
              <td className="px-3 py-2 text-dim">{row.label}</td>
              {done.map((r) => (
                <td key={r.id} className="num px-3 py-2">
                  {r.metrics ? row.deco(r.metrics) : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
