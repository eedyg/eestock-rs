import type { SourceAccuracyResponse } from '@/api/types';
import { metaOf } from '@/features/sources/sourceMeta';
import { cn } from '@/lib/utils';
import { devPct, ratePct } from './format';
import { RegionError } from './DivergenceTable';
import type { AsyncSlice } from './store';

/**
 * accuracy-cards H=120（04-quality §3）：源一致率排行卡（一致率/平均偏差/样本数；只读——
 * 源权重/轮转序调整的数据依据）。三态=骨架卡/「该窗口无比对样本」/错误占位+重试。
 */
export function AccuracyCards({
  slice,
  onRetry,
}: {
  slice: AsyncSlice<SourceAccuracyResponse>;
  onRetry: () => void;
}) {
  if (slice.error) return <RegionError error={slice.error} onRetry={onRetry} />;
  if (slice.loading || slice.data === null) {
    return (
      <>
        {[0, 1].map((i) => (
          <div key={i} className="flex-1 animate-pulse rounded-xl bg-panel2" />
        ))}
      </>
    );
  }
  if (slice.data.sources.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-xs text-dim">该窗口无比对样本</div>;
  }
  return (
    <>
      {slice.data.sources.map((s) => (
        <div
          key={s.source}
          className="flex-1 rounded-xl border border-line bg-panel2 px-3.5 py-2 text-xs text-dim"
        >
          <b className="text-[13px] text-txt">{metaOf(s.source).label}</b>
          <div className="mt-1">
            一致率{' '}
            <b
              className={cn(
                'num',
                (s.consistency_rate ?? 0) >= 0.99 ? 'text-down' : 'text-[#fbbf24]',
              )}
            >
              {ratePct(s.consistency_rate)}
            </b>{' '}
            · 平均偏差 <span className="num">{devPct(s.avg_deviation_pct)}</span>
          </div>
          <div>
            样本 <span className="num">{s.samples}</span> bar · 最大偏差{' '}
            <span className="num">{devPct(s.max_deviation_pct)}</span>
          </div>
        </div>
      ))}
    </>
  );
}
