import { useMemo, useState } from 'react';
import type { QualityDivergenceResponse, QualityDivergenceRow } from '@/api/types';
import { cstMdHm, devPct } from './format';
import { RegionError } from './DivergenceTable';
import type { AsyncSlice } from './store';

const W = 900;
const H = 260;
const PAD = 24;

/** 窗口化（缩放）：zoom=1 全程；>1 时以最大偏差点为中心取 1/zoom 宽度（纯函数） */
export function windowRows(rows: QualityDivergenceRow[], zoom: number): QualityDivergenceRow[] {
  if (zoom <= 1 || rows.length <= 2) return rows;
  const size = Math.max(2, Math.ceil(rows.length / zoom));
  const pivot = rows.reduce(
    (best, r, i) => (Math.abs(r.deviation_pct) > Math.abs(rows[best]!.deviation_pct) ? i : best),
    0,
  );
  const start = Math.max(0, Math.min(rows.length - size, pivot - Math.floor(size / 2)));
  return rows.slice(start, start + size);
}

/** 双线共用 y 轴（raw/accurate 同尺度才可肉眼分辨偏差） */
function polyline(
  rows: QualityDivergenceRow[],
  pick: (r: QualityDivergenceRow) => number,
  min: number,
  span: number,
): string {
  const xStep = rows.length > 1 ? (W - PAD * 2) / (rows.length - 1) : 0;
  return rows
    .map((r, i) => {
      const x = PAD + i * xStep;
      const y = H - PAD - ((pick(r) - min) / span) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * overlay-chart（04-quality L2 次要视图）：raw vs accurate 收盘双线叠加（客户端渲染，三态随分歧表）；
 * 缩放以最大偏差点为中心窗口化（偏小区间肉眼分辨用）。
 */
export function OverlayChart({
  slice,
  onRetry,
}: {
  slice: AsyncSlice<QualityDivergenceResponse>;
  onRetry: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  // rows 后端按 |偏差| 降序；叠加图需时刻升序
  const rows = useMemo(
    () => [...(slice.data?.rows ?? [])].sort((a, b) => a.ts.localeCompare(b.ts)),
    [slice.data],
  );

  if (slice.error) return <RegionError error={slice.error} onRetry={onRetry} />;
  if (slice.loading || slice.data === null) {
    return <div className="m-3 h-64 animate-pulse rounded-lg bg-panel2" />;
  }
  if (rows.length === 0) {
    return <div className="p-8 text-center text-xs text-dim">该范围无比对数据</div>;
  }
  const win = windowRows(rows, zoom);
  const allVals = win.flatMap((r) => [r.raw_close, r.accurate_close]);
  const min = Math.min(...allVals);
  const span = Math.max(...allVals) - min || 1e-9;
  const maxRow = rows.reduce(
    (best, r) => (Math.abs(r.deviation_pct) > Math.abs(best.deviation_pct) ? r : best),
    rows[0]!,
  );
  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-dim">
        <span className="text-acc1">raw 收盘</span>
        <span className="text-acc2">accurate 收盘</span>
        <span className="num">
          最大偏差 {cstMdHm(maxRow.ts)} {devPct(maxRow.deviation_pct)}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="放大"
          onClick={() => setZoom((z) => Math.min(8, z * 2))}
          className="rounded-lg border border-line px-2 py-0.5 hover:text-txt"
        >
          放大
        </button>
        <button
          type="button"
          aria-label="重置缩放"
          disabled={zoom === 1}
          onClick={() => setZoom(1)}
          className="rounded-lg border border-line px-2 py-0.5 hover:text-txt disabled:opacity-40"
        >
          重置
        </button>
        {zoom > 1 && <span className="num">×{zoom}</span>}
      </div>
      <svg
        data-testid="overlay-chart-svg"
        className="min-h-0 flex-1"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="raw vs accurate 收盘双线叠加图"
      >
        <g opacity={0.2} stroke="#fff" strokeWidth={0.5}>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} y1={H * f} x2={W} y2={H * f} />
          ))}
        </g>
        <polyline
          data-testid="line-raw"
          points={polyline(win, (r) => r.raw_close, min, span)}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={2}
        />
        <polyline
          data-testid="line-accurate"
          points={polyline(win, (r) => r.accurate_close, min, span)}
          fill="none"
          stroke="#a78bfa"
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      </svg>
    </div>
  );
}
