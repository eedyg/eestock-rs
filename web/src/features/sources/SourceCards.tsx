import type { SourceHealthItem, SourcesHealth } from '@/api/types';
import { metaOf, roleLabelOf } from './sourceMeta';
import { cn } from '@/lib/utils';

function statusDot(s: SourceHealthItem): string {
  if (s.circuit_state === 'open') return 'dot-down';
  if (s.status === 'degraded') return 'dot-warn';
  return 'dot-live';
}

function statusText(s: SourceHealthItem): string {
  if (s.circuit_state === 'open') return '熔断';
  if (s.status === 'degraded') return '降级';
  return '健康';
}

function rateText(s: SourceHealthItem): string {
  return s.success_rate == null ? '—' : `${(s.success_rate * 100).toFixed(1)}%`;
}

/**
 * 源健康卡片墙（02-sources §3）：每源一卡（状态灯+角色标签+近1h成功率+P50+最近错误），
 * 熔断卡附手动复位按钮（复位不触发展开，stopPropagation）；选中卡高亮描边；
 * flashes 序号变化触发卡片闪烁（WS 状态迁移）。
 */
export function SourceCards({
  health,
  selected,
  flashes,
  resetting,
  resetErrors,
  onSelect,
  onReset,
}: {
  health: SourcesHealth | null;
  selected: string | null;
  flashes: Record<string, number>;
  resetting: Record<string, boolean>;
  resetErrors: Record<string, string>;
  onSelect(id: string | null): void;
  onReset(id: string): void;
}) {
  if (!health) {
    return (
      <>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[140px] w-[280px] animate-pulse rounded-xl bg-panel2" />
        ))}
      </>
    );
  }
  if (health.sources.length === 0) {
    return <div className="p-4 text-xs text-dim">无数据源配置</div>;
  }
  return (
    <>
      {health.sources.map((s) => {
        const meta = metaOf(s.source);
        const isCircuit = s.circuit_state === 'open';
        return (
          <div
            key={`${s.source}:${flashes[s.source] ?? 0}`}
            data-source={s.source}
            role="button"
            tabIndex={0}
            aria-pressed={selected === s.source}
            onClick={() => onSelect(s.source)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(s.source)}
            className={cn(
              'h-[140px] w-[280px] cursor-pointer rounded-xl border border-line bg-panel2 p-3 text-xs text-dim transition-all',
              selected === s.source && 'border-acc1/50 shadow-[0_0_16px_rgba(56,189,248,0.2)]',
              (flashes[s.source] ?? 0) > 0 && 'animate-pulse',
            )}
          >
            <div className="mb-1 flex items-center justify-between">
              <b className="text-[13px] text-txt">{meta.label}</b>
              <span
                className={cn(
                  'rounded-full border px-2 py-px text-[11px]',
                  isCircuit
                    ? 'border-up/35 bg-up/10 text-up'
                    : 'border-acc1/30 bg-acc1/10 text-acc1',
                )}
              >
                {roleLabelOf(s)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={statusDot(s)} />
              <span>
                {statusText(s)} · 成功率{' '}
                <b className={cn('num', isCircuit || s.status === 'degraded' ? 'text-[#f5c451]' : 'text-down')}>
                  {rateText(s)}
                </b>
                （1h）· P50 <span className="num">{s.p50_ms == null ? '—' : `${Math.round(s.p50_ms)}ms`}</span>
              </span>
            </div>
            <div className="mt-1 truncate">
              {s.last_error ? (
                <span>
                  最近错误：<span className="num">{s.last_error.ts.slice(11, 16)}</span>{' '}
                  {s.last_error.err_kind ?? 'unknown'}
                </span>
              ) : (
                <span>最近错误：无</span>
              )}
            </div>
            {isCircuit && (
              <button
                type="button"
                disabled={resetting[s.source]}
                onClick={(e) => {
                  e.stopPropagation();
                  onReset(s.source);
                }}
                className="mt-1 rounded-lg border border-up/40 px-3 py-0.5 text-xs text-up hover:bg-up/10 disabled:opacity-50"
              >
                {resetting[s.source] ? '复位中…' : '手动复位'}
              </button>
            )}
            {resetErrors[s.source] && (
              <div className="mt-1 text-up">复位失败：{resetErrors[s.source]}</div>
            )}
          </div>
        );
      })}
    </>
  );
}
