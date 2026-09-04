import type { GapClass, QualityGapsResponse } from '@/api/types';
import { cn } from '@/lib/utils';
import { RegionError } from './DivergenceTable';
import type { AsyncSlice } from './store';

/** 缺口分类标签（D5 三级口径） */
const CLASS_LABEL: Record<GapClass, string> = {
  source_fault: '源故障',
  upstream_no_data: '上游无数据',
  system_gap: '系统缺口',
};

const CLASS_COLOR: Record<GapClass, string> = {
  source_fault: 'text-up',
  upstream_no_data: 'text-[#fbbf24]',
  system_gap: 'text-acc2',
};

/**
 * gap-report（04-quality §5）：历史缺口日期列表（哪天、缺哪些分钟段：起止时刻、缺 bar 数、分类）；
 * 只读复盘视角（与页面②今日缺口率互补）。三态=骨架行/「该范围无缺口」/错误占位+重试。
 */
export function GapReportList({
  slice,
  onRetry,
}: {
  slice: AsyncSlice<QualityGapsResponse>;
  onRetry: () => void;
}) {
  if (slice.error) return <RegionError error={slice.error} onRetry={onRetry} />;
  if (slice.loading || slice.data === null) {
    return (
      <div className="space-y-2" data-testid="gap-skeleton">
        {[0, 1].map((i) => (
          <div key={i} className="h-7 animate-pulse rounded-lg bg-panel2" />
        ))}
      </div>
    );
  }
  if (slice.data.days.length === 0) {
    return <div className="py-4 text-center text-xs text-dim">该范围无缺口</div>;
  }
  return (
    <div className="text-xs text-dim">
      {slice.data.days.map((d) => (
        <div key={d.date} className="border-b border-line py-1.5 last:border-none">
          <span className="num text-txt">{d.date.slice(5)}</span>
          <span className="mx-1.5">
            缺 <span className="num">{d.missing_bars}</span> bar / 应到{' '}
            <span className="num">{d.expected_bars}</span>
          </span>
          {d.segments.map((s, i) => (
            <span key={i} className="mr-2 inline-block">
              <span className="num">
                缺 {s.start}-{s.end}（{s.count} bar）
              </span>{' '}
              <span className={cn(CLASS_COLOR[s.class])}>{CLASS_LABEL[s.class]}</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
