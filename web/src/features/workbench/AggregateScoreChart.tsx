import { useMemo } from 'react';
import type { WorkbenchBarRecord } from '@/api/types';
import { downsample, lineFrom, mapLine } from './chartUtils';

const W = 1000;
const H = 160;
const PAD = 8;

/** 曲线抽样标注（后端 `/curve` 的 `downsampled`/`original_bars`；ADR-024 D10 禁止隐式有损）。 */
export interface CurveSampling {
  downsampled: boolean;
  originalBars: number;
}

/**
 * 总分曲线（ADR §13.5）：聚合分 0-100 折线 + buy/sell 阈值虚线 + 三区着色
 * （≥buy 买入区绿 tint / 中间持有区 / ≤sell 卖出区红 tint）。
 *
 * ADR-024 P6：数据来自 `/curve?kind=per_bar`（**显式抽样**）；渲染时标注抽样点数与原始根数
 * （沿用既有「抽样 N 点」文案模式 + `original_bars`），禁止隐式有损（D10）。
 */
export function AggregateScoreChart({
  perBar,
  buyThreshold,
  sellThreshold,
  sampling,
}: {
  perBar: WorkbenchBarRecord[];
  buyThreshold: number;
  sellThreshold: number;
  sampling?: CurveSampling;
}) {
  const pts = useMemo(
    () => downsample(perBar.map((r) => [r.ts, r.aggregate] as [number, number])),
    [perBar],
  );
  const y = (s: number) => PAD + (1 - s / 100) * (H - 2 * PAD);
  const line = useMemo(() => lineFrom(mapLine(pts, 0, 100, W, H, PAD)), [pts]);

  return (
    <div className="rounded-lg border border-line bg-panel2 p-1" data-testid="wb-aggregate-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="总分曲线">
        {/* 三区着色 */}
        <rect x={0} y={y(100)} width={W} height={y(buyThreshold) - y(100)} fill="#00e0a4" opacity="0.07" data-testid="zone-buy" />
        <rect x={0} y={y(buyThreshold)} width={W} height={y(sellThreshold) - y(buyThreshold)} fill="#8b93b0" opacity="0.04" data-testid="zone-hold" />
        <rect x={0} y={y(sellThreshold)} width={W} height={y(0) - y(sellThreshold)} fill="#ff5c6c" opacity="0.07" data-testid="zone-sell" />
        {/* 阈值虚线 */}
        <line x1={0} x2={W} y1={y(buyThreshold)} y2={y(buyThreshold)} stroke="#00e0a4" strokeDasharray="4 4" strokeWidth="0.8" data-testid="threshold-buy" />
        <line x1={0} x2={W} y1={y(sellThreshold)} y2={y(sellThreshold)} stroke="#ff5c6c" strokeDasharray="4 4" strokeWidth="0.8" data-testid="threshold-sell" />
        <polyline points={line} fill="none" stroke="#38bdf8" strokeWidth="1.4" />
      </svg>
      <div className="flex justify-between px-1 text-[10px] text-dim">
        <span>
          聚合总分 0-100（虚线 = 买入阈 {buyThreshold} / 卖出阈 {sellThreshold}；三区 = 买/持/卖）
        </span>
        <span data-testid="wb-aggregate-sampling">
          共 {sampling?.originalBars ?? perBar.length} bar
          {sampling?.downsampled
            ? `（服务端抽样 ${perBar.length} 点）`
            : pts.length < perBar.length
              ? `（抽样 ${pts.length} 点）`
              : ''}
        </span>
      </div>
    </div>
  );
}
