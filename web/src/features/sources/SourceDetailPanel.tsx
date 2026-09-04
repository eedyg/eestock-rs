import { SOURCES_DEFAULTS } from '@/layouts/SourcesGrid';
import type { DetailRange } from '@/api/types';
import type { DetailState } from './store';
import { cn } from '@/lib/utils';

const RANGES: Array<{ value: DetailRange; label: string }> = [
  { value: '1h', label: '1h' },
  { value: 'today', label: '今日' },
  { value: '3d', label: '3日' },
];

/** 成功率时序轻量 SVG（09-frontend 依赖基线无 echarts，不引新依赖；与分时图同折衷） */
function MetricsSparkline({ points }: { points: Array<{ ts: string; successRate: number | null }> }) {
  const W = 500;
  const H = 140;
  const valid = points.filter((p) => p.successRate != null);
  if (valid.length < 2) {
    return <div className="flex h-full items-center justify-center text-xs text-dim">该范围无数据</div>;
  }
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - (((p.successRate ?? 0) - 80) / 20) * H; // 80-100% 映射满幅
      return `${x.toFixed(1)},${Math.max(0, Math.min(H, y)).toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" y1={H * f} x2={W} y2={H * f} stroke="#fff" strokeWidth="0.5" opacity="0.15" />
      ))}
      <polyline points={path} fill="none" stroke="#38bdf8" strokeWidth="2" />
      <text x="8" y="14" fontSize="11" fill="#38bdf8">
        成功率%（80-100 映射）
      </text>
    </svg>
  );
}

const KIND_LABEL: Record<string, { text: string; cls: string }> = {
  success: { text: '成功', cls: 'text-down' },
  failure: { text: '失败', cls: 'text-up' },
  rate_limited: { text: '限流', cls: 'text-[#f5c451]' },
  circuit: { text: '熔断', cls: 'text-up' },
};

/**
 * 详情区 H=320（02-sources §4）：成功率/延迟时序（范围 1h/今日/3日）+ 分歧率统计行 +
 * 限流计数器组（403/429/连接重置）+ 事件流水最近 50 条（Trace ID 点击复制）。
 */
export function SourceDetailPanel({
  detail,
  range,
  onRangeChange,
}: {
  detail: DetailState;
  range: DetailRange;
  onRangeChange(r: DetailRange): void;
}) {
  const { metrics, events, divergence, rateLimits } = detail;
  return (
    <>
      {/* 左：时序 + 统计行（flex-1） */}
      <div className="flex min-w-0 flex-1 flex-col border-r border-line">
        <div className="relative min-h-0 flex-1 p-2">
          <div className="absolute left-2 top-2 z-10 flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                aria-pressed={range === r.value}
                onClick={() => onRangeChange(r.value)}
                className={cn(
                  'rounded-lg px-3 py-0.5 text-xs',
                  range === r.value
                    ? 'bg-gradient-to-br from-acc1 to-acc2 text-white'
                    : 'border border-line text-dim',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          {metrics.loading && <div className="h-full animate-pulse rounded bg-panel2" />}
          {!metrics.loading && metrics.error && (
            <div className="flex h-full items-center justify-center text-xs text-up">
              时序加载失败：{metrics.error}
            </div>
          )}
          {!metrics.loading && !metrics.error && metrics.data && (
            <MetricsSparkline points={metrics.data} />
          )}
        </div>
        <div className="flex h-12 items-center gap-4 border-t border-line px-3 text-xs text-dim">
          <span>分歧率统计</span>
          {divergence.loading ? (
            <span className="h-4 w-24 animate-pulse rounded bg-white/5" />
          ) : divergence.error ? (
            <span className="text-up">加载失败</span>
          ) : divergence.data ? (
            <span>
              与腾讯锚分歧：DIVERGE{' '}
              <b className="num text-[#f5c451]">{divergence.data.divergeBars}</b> bar（&gt;
              {SOURCES_DEFAULTS.divergenceThresholdPct}% 口径）
            </span>
          ) : null}
        </div>
        <div className="flex h-12 items-center gap-4 border-t border-line px-3 text-xs text-dim">
          <span>限流计数器组</span>
          {rateLimits.loading ? (
            <span className="h-4 w-24 animate-pulse rounded bg-white/5" />
          ) : rateLimits.error ? (
            <span className="text-up">加载失败</span>
          ) : rateLimits.data ? (
            <span>
              403 ×<span className="num">{rateLimits.data.http403}</span> · 429 ×
              <span className={cn('num', rateLimits.data.http429 > 0 && 'text-[#f5c451]')}>
                {rateLimits.data.http429}
              </span>{' '}
              · 连接重置 ×
              <span className={cn('num', rateLimits.data.connReset > 0 && 'text-up')}>
                {rateLimits.data.connReset}
              </span>
              （封禁观测点）
            </span>
          ) : null}
        </div>
      </div>
      {/* 右：事件流水 W=40% */}
      <div className="w-[40%] shrink-0 overflow-y-auto p-3 text-xs text-dim">
        <div className="mb-1 text-[11px] opacity-85">事件流水 · 最近 50 条 · Trace ID 点击可复制</div>
        {events.loading && <div className="h-24 animate-pulse rounded bg-panel2" />}
        {!events.loading && events.error && (
          <div className="text-up">事件流水加载失败：{events.error}</div>
        )}
        {!events.loading && !events.error && events.data && events.data.length === 0 && (
          <div>该范围无事件</div>
        )}
        {!events.loading &&
          !events.error &&
          events.data?.map((e, i) => {
            const kind = KIND_LABEL[e.kind] ?? { text: e.kind, cls: '' };
            return (
              <div key={`${e.ts}:${i}`} className="flex items-center gap-2 border-b border-line py-1">
                <span className="num">{e.ts.slice(11, 19)}</span>
                <span className={kind.cls}>{kind.text}</span>
                <span className="min-w-0 flex-1 truncate">{e.detail}</span>
                {e.traceId && (
                  <button
                    type="button"
                    title="点击复制 Trace ID"
                    onClick={() => void navigator.clipboard?.writeText(e.traceId!)}
                    className="num text-dim hover:text-txt"
                  >
                    trace:{e.traceId}
                  </button>
                )}
              </div>
            );
          })}
      </div>
    </>
  );
}
