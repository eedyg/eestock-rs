import type { StrategyScorePoint, StrategySignalPoint } from '@/api/types';

/**
 * 试算评分曲线（轻量 SVG 折线；选型说明：仓库既有图表库 klinecharts 为 K 线专用，
 * 评分曲线为简单时序，未引入 ECharts——保持批准依赖清单不变）。
 * y 轴 0-100 分；叠加 60/40 阈值虚线（ADR §6 信号口径）；sim_position 模式叠加 buy/sell 信号标记。
 * score=null（插件熔断 bar）断线跳过。
 */
export function ScoreChart({
  scores,
  signals = [],
}: {
  scores: StrategyScorePoint[];
  signals?: StrategySignalPoint[];
}) {
  const W = 600;
  const H = 160;
  const PAD = 4;
  const y = (s: number) => PAD + (1 - s / 100) * (H - 2 * PAD);
  const x = (i: number) => (scores.length <= 1 ? W / 2 : (i / (scores.length - 1)) * W);

  // null 分断线：连续非 null 段各画一条 polyline
  const segs: string[] = [];
  let cur: string[] = [];
  scores.forEach((p, i) => {
    if (p.score === null) {
      if (cur.length > 0) segs.push(cur.join(' '));
      cur = [];
    } else {
      cur.push(`${x(i).toFixed(1)},${y(p.score).toFixed(1)}`);
    }
  });
  if (cur.length > 0) segs.push(cur.join(' '));

  // NIT-5：预建 ts→index Map，信号对齐 O(m+n)（消除 O(m×n) findIndex）
  const tsIndex = new Map(scores.map((p, i) => [p.ts, i]));
  const marks = signals
    .filter((s) => s.signal === 'buy' || s.signal === 'sell')
    .map((s) => {
      const idx = tsIndex.get(s.ts);
      return idx !== undefined ? { i: idx, signal: s.signal } : null;
    })
    .filter((m): m is { i: number; signal: string } => m !== null);

  return (
    <div className="rounded-lg border border-line bg-panel2 p-1" data-testid="score-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="评分曲线">
        {/* 60/40 阈值虚线（ADR §6 信号判定口径） */}
        <line x1="0" x2={W} y1={y(60)} y2={y(60)} stroke="var(--dim)" strokeDasharray="4 4" strokeWidth="0.5" />
        <line x1="0" x2={W} y1={y(40)} y2={y(40)} stroke="var(--dim)" strokeDasharray="4 4" strokeWidth="0.5" />
        {segs.map((pts, i) => (
          <polyline key={i} points={pts} fill="none" stroke="var(--acc1)" strokeWidth="1.2" />
        ))}
        {marks.map((m, i) => (
          <circle
            key={i}
            cx={x(m.i)}
            cy={m.signal === 'buy' ? y(96) : y(4)}
            r="3"
            fill={m.signal === 'buy' ? 'var(--up)' : 'var(--down)'}
            data-testid={`signal-${m.signal}`}
          />
        ))}
      </svg>
      <div className="flex justify-between px-1 text-[10px] text-dim">
        <span>评分 0-100（虚线 = 买入阈 60 / 卖出阈 40）</span>
        <span>{scores.length} bar</span>
      </div>
    </div>
  );
}
