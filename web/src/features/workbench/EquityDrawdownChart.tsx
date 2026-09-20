import { useMemo } from 'react';
import { fmtPct } from '@/features/backtest/format';
import {
  areaBelow,
  curveDomainAttr,
  downsample,
  extentOf,
  lineFrom,
  mapLineByDomain,
  resolveCurveX,
  vlineX,
  type CurveXDomain,
} from './chartUtils';

const W = 1000;
const H = 220;
const PAD = 10;

/**
 * 净值 + 回撤双曲线（ADR §13.5；与页面⑤ ResultOverview 同风格：净值面积线 + 回撤着色区）。
 * ADR-024 P6：数据来自 `/curve?kind=net_value|drawdown`（**显式抽样**）；`downsampled`/`original_bars`
 * 在右下角显式标注（禁止静默有损，D10）。
 */
export function EquityDrawdownChart({
  netValue,
  drawdown,
  sampling,
  domain,
  xDomain,
  plot,
  markerTs,
}: {
  netValue: Array<[number, number]>;
  drawdown: Array<[number, number]>;
  /** 后端抽样标注（`/curve` 的 `downsampled`/`original_bars`；ADR-024 D10）。 */
  sampling?: { netValue: { downsampled: boolean; originalBars: number }; drawdown: { downsampled: boolean; originalBars: number } };
  /** ADR-028 D2.1：共享窗口（Unix 秒）——`data-x-domain` 标注与**降级**路径用（页面一律传 xDomain）。 */
  domain?: { from_ts: number; to_ts: number } | null;
  /** ADR-028 D2.1（**主路**）：x 定义域 = bar 索引空间；`undefined` ⇒ 按 `domain` 降级 ts 线性。 */
  xDomain?: CurveXDomain | null;
  /** ADR-028 D2.3-4：与 K 线共用的绘图区几何（`viewBox` x 起点/宽度）。 */
  plot?: { x0: number; w: number } | null;
  /** ADR-028 D4.1 ④：竖线标记时点（Unix 秒）。 */
  markerTs?: number | null;
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
  const xd = resolveCurveX({ xDomain, domain });
  const eq = mapLineByDomain(series, xd, min, max, W, H, PAD);
  const eqPoints = eq.points;
  const viewX0 = plot ? plot.x0 : 0;
  const viewW = plot ? plot.w : W;
  const markX = vlineX(markerTs, xd, W, PAD);
  const depth = H * 0.35;

  return (
    <div
      className="relative rounded-lg border border-line bg-panel2 py-1"
      data-testid="wb-equity-chart"
      // ADR-028 D2.1：x 轴**数据窗口**实测标注（E2E 冻结口径）
      data-x-domain={curveDomainAttr({ xDomain: xd, domain })}
      data-x-mode={xd ? xd.mode : 'none'}
    >
      <svg
        viewBox={`${viewX0.toFixed(2)} 0 ${viewW.toFixed(2)} ${H}`}
        preserveAspectRatio="none"
        className="h-52 w-full"
        role="img"
        aria-label="净值与回撤"
      >
        <g opacity="0.2" stroke="#fff" strokeWidth="0.5">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={viewX0} y1={H * f} x2={viewX0 + viewW} y2={H * f} />
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
        {/* ADR-028 D4.1 ④：竖线标记（与曲线同定义域 ⇒ 各视图同一时点同位） */}
        {markX != null && (
          <line
            data-testid="wb-vline"
            data-view="equity"
            data-vline-ts={String(markerTs)}
            x1={markX}
            y1={0}
            x2={markX}
            y2={H}
            stroke="#facc15"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity="0.9"
          />
        )}
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
      <div className="absolute bottom-2 left-3 text-[10px] text-dim">
        回撤（最大 −{fmtPct(ddMax)}，着色区间）
      </div>
      <div className="absolute bottom-2 right-3 text-[10px] text-dim" data-testid="wb-equity-sampling">
        净值 共 {sampling?.netValue.originalBars ?? netValue.length} bar
        {eq.unmatched > 0 ? ` · ${eq.unmatched} 点不在 K 线 bar 序列上（已剔除）` : ''}
        {sampling?.netValue.downsampled ? `（服务端抽样 ${series.length} 点）` : ''}
        {' · '}回撤 共 {sampling?.drawdown.originalBars ?? drawdown.length} bar
        {sampling?.drawdown.downsampled ? `（服务端抽样 ${dd.length} 点）` : ''}
      </div>
    </div>
  );
}
