import { useMemo } from 'react';
import { fmtPct } from '@/features/backtest/format';
import { areaBelow, downsample, extentOf, lineFrom, mapLine } from './chartUtils';

const W = 1000;
const H = 220;
const PAD = 10;

/**
 * 净值 + 回撤双曲线（ADR §13.5；与页面⑤ ResultOverview 同风格：净值面积线 + 回撤着色区）。
 * 序列经 downsample 抽样渲染（ADR §13.4）。
 */
export function EquityDrawdownChart({
  netValue,
  drawdown,
}: {
  netValue: Array<[number, number]>;
  drawdown: Array<[number, number]>;
}) {
  const series = useMemo(() => downsample(netValue), [netValue]);
  const dd = useMemo(() => downsample(drawdown), [drawdown]);

  if (series.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-line bg-panel2 text-xs text-dim" data-testid="wb-equity-chart">
        无净值数据
      </div>
    );
  }

  const equities = series.map((s) => s[1]);
  const lastEquity = equities[equities.length - 1] ?? 0;
  const initial = equities[0] ?? 0;
  const retPct = initial > 0 ? (lastEquity - initial) / initial : 0;
  const { min, max } = extentOf(equities);
  const ddMax = Math.max(...dd.map((d) => d[1]), 0);
  const eqPoints = mapLine(series, min, max, W, H, PAD);
  const depth = H * 0.35;

  return (
    <div className="relative rounded-lg border border-line bg-panel2 p-1" data-testid="wb-equity-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-52 w-full" role="img" aria-label="净值与回撤">
        <g opacity="0.2" stroke="#fff" strokeWidth="0.5">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} y1={H * f} x2={W} y2={H * f} />
          ))}
        </g>
        <polygon points={areaBelow(eqPoints, H - PAD)} fill="#38bdf8" opacity="0.08" />
        <polyline points={lineFrom(eqPoints)} fill="none" stroke="#38bdf8" strokeWidth="2" data-testid="equity-line" />
        {dd.map((d, i) => {
          if (d[1] <= 0) return null;
          const x = eqPoints[i]?.x ?? PAD;
          const plotW = W - PAD * 2;
          const step = eqPoints.length > 1 ? plotW / (eqPoints.length - 1) : plotW;
          const rectW = Math.max(0.5, step - 1);
          return <rect key={`dd-${i}`} x={x} y={H - depth} width={rectW} height={depth} fill="#ff5c6c" opacity={Math.min(0.25, d[1] / (ddMax || 1))} />;
        })}
      </svg>
      <div className="absolute left-3 top-2">
        <div className="num text-sm text-acc1" data-testid="wb-last-equity">
          净值 {lastEquity.toFixed(2)}
        </div>
        <div className={`num text-xs ${retPct >= 0 ? 'text-up' : 'text-down'}`} data-testid="wb-net-return">
          {retPct >= 0 ? '+' : ''}
          {fmtPct(retPct)}
        </div>
      </div>
      <div className="absolute bottom-2 left-3 text-[10px] text-dim">回撤（最大 −{fmtPct(ddMax)}，着色区间）</div>
    </div>
  );
}
