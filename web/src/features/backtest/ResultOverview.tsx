import type { BacktestRunDto } from '@/api/types';
import { fmtAxis, fmtMoney, fmtPct } from './format';
import { areaBelow, evenTickIndices, extentOf, lineFrom, mapLine } from './chartUtils';

const W = 1000;
const H = 240;
const PAD = 10;

/**
 * 页面⑤概览区：净值曲线 + 回撤曲线（双 SVG，回撤区间着色，TradingView Overview 式）。
 * 数据 GET /api/backtest/runs/{id}（run.net_value 净值+回撤序列，未选中/未完成时占位）。
 */
export function ResultOverview({
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
  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-xs text-up">
        <span>结果加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="result-skeleton">
        <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
      </div>
    );
  }
  if (!run?.net_value || run.net_value.series.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-dim">
        选择已完成任务查看结果
      </div>
    );
  }

  const { series, drawdown } = run.net_value;
  const equities = series.map((s) => s[1]);
  const lastEquity = equities[equities.length - 1] ?? 0;
  const initial = equities[0] ?? 0;
  const retPct = initial > 0 ? (lastEquity - initial) / initial : 0;
  const { min, max } = extentOf(equities);
  const ddValues = drawdown.map((d) => d[1]);
  const ddMax = Math.max(...ddValues, 0) || 1;
  const eqPoints = mapLine(series, min, max, W, H, PAD);
  const depth = H * 0.35;

  // 时间 x 轴：取净值序列 ts 均匀分布刻度（约 5 个，去重后可能更少）；跨度 <31 天用日粒度，否则月度。
  const firstTs = series[0]?.[0] ?? 0;
  const lastTs = series[series.length - 1]?.[0] ?? 0;
  const spanDays = (lastTs - firstTs) / 86_400;
  const includeDay = Number.isFinite(spanDays) && spanDays > 0 && spanDays < 31;
  const axisTicks = evenTickIndices(series.length, 5).map((i) => ({
    x: eqPoints[i]!.x,
    label: fmtAxis(series[i]![0], includeDay),
  }));

  return (
    <div className="relative h-full w-full overflow-hidden p-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" data-testid="equity-drawdown-chart">
        <g opacity="0.2" stroke="#fff" strokeWidth="0.5">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" y1={H * f} x2={W} y2={H * f} />
          ))}
        </g>
        <polygon points={areaBelow(eqPoints, H - PAD)} fill="#38bdf8" opacity="0.08" />
        <polyline points={lineFrom(eqPoints)} fill="none" stroke="#38bdf8" strokeWidth="2" />
        {/* 回撤区（资金占比 1/4）：回撤 >0 处着色
            宽度按点间距推导，减去固定小间隙；对任意大 n 保证 width 恒正（负值会导致
            React dev console.error 及 rect 渲染异常）。n=1 时按整段 plot 宽计算，避免除零。 */}
        {drawdown.map((d, i) => {
          if (d[1] <= 0) return null;
          const x = eqPoints[i]!.x;
          const plotW = W - PAD * 2;
          const step = eqPoints.length > 1 ? plotW / (eqPoints.length - 1) : plotW;
          const rectW = Math.max(0.5, step - 1); // 最小可见宽 0.5，无负宽、无除零
          return <rect key={`dd-${i}`} x={x} y={H - depth} width={rectW} height={depth} fill="#ff5c6c" opacity={Math.min(0.2, d[1] / (ddMax || 1))} />;
        })}
      </svg>
      {/* 时间 x 轴：与 svg 同宽（inset-x-2 对齐 p-2），标签按其像素百分比定位，避免 preserveAspectRatio 拉伸 */}
      <div className="absolute inset-x-2 bottom-0" data-testid="chart-x-axis">
        {axisTicks.map(({ x, label }, i) => (
          <span
            key={i}
            className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[9px] leading-none text-dim"
            style={{ left: `${(x / W) * 100}%` }}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="absolute left-3 top-2">
        <div className="num text-sm text-acc1" data-testid="last-equity">
          净值 {lastEquity.toFixed(3)}
        </div>
        <div className={`num text-xs ${retPct >= 0 ? 'text-up' : 'text-down'}`} data-testid="net-return">
          {retPct >= 0 ? '+' : ''}
          {fmtPct(retPct)}（{fmtMoney(lastEquity)}）
        </div>
      </div>
      <div className="absolute bottom-6 left-3 text-[11px] text-dim">回撤（最大 −{fmtPct(ddMax)}，着色区间）</div>
    </div>
  );
}
