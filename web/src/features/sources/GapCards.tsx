import { SOURCES_DEFAULTS } from '@/layouts/SourcesGrid';
import type { GapStat } from '@/api/types';
import { cn } from '@/lib/utils';

function levelOf(gapPct: number): 'ok' | 'warn' | 'crit' {
  if (gapPct > SOURCES_DEFAULTS.gapCritPct) return 'crit';
  if (gapPct > SOURCES_DEFAULTS.gapWarnPct) return 'warn';
  return 'ok';
}

/**
 * 采集质量区（02-sources §6）：每标的当日 1m 缺口率小卡
 * （应有/实有/缺口率；>5% 黄、>20% 红，SOURCES_DEFAULTS 口径）。只读。
 */
export function GapCards({
  gaps,
  loading,
  error,
}: {
  gaps: GapStat[] | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[88px] w-[200px] animate-pulse rounded-xl bg-panel2" />
        ))}
      </>
    );
  }
  if (error) {
    return <div className="p-3 text-xs text-up">缺口数据加载失败：{error}</div>;
  }
  if (!gaps || gaps.length === 0) {
    return <div className="p-3 text-xs text-dim">今日无缺口</div>;
  }
  return (
    <>
      {gaps.map((g) => {
        const level = levelOf(g.gapPct);
        return (
          <div
            key={g.code}
            data-gap={g.code}
            data-level={level}
            className={cn(
              'h-[88px] w-[200px] rounded-xl border border-line bg-panel2 p-3 text-xs text-dim',
              level === 'warn' && 'border-[#f5c451]/45 shadow-[inset_0_0_18px_rgba(251,191,36,0.08)]',
              level === 'crit' && 'border-up/50 shadow-[inset_0_0_18px_rgba(255,92,108,0.1)]',
            )}
          >
            <b className="num text-txt">{g.code}</b> {g.name ?? ''}
            <br />
            应有 <span className="num">{g.expected}</span> / 实有 <span className="num">{g.actual}</span>
            <br />
            缺口率{' '}
            <b
              className={cn(
                'num',
                level === 'crit' ? 'text-up' : level === 'warn' ? 'text-[#f5c451]' : 'text-down',
              )}
            >
              {g.gapPct.toFixed(1)}%
            </b>
          </div>
        );
      })}
    </>
  );
}
