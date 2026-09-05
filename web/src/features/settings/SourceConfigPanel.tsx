import type { ApiClient } from '@/api/client';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';

/** 只读配置区「保存」禁用标注（S2 参数配置化占位）。 */
export function SaveDisabledNote() {
  return (
    <div className="mt-3 flex items-center gap-2">
      <button
        type="button"
        disabled
        title="参数配置化将在下一阶段上线（S2）"
        className="cursor-not-allowed rounded-lg border border-line px-4 py-1 text-xs text-dim opacity-50"
      >
        保存
      </button>
      <span className="text-xs text-dim">参数配置化将在下一阶段上线（S2）</span>
    </div>
  );
}

/** source-config（08-settings §L2）：只读展示内置源清单 + 每源默认参数；不做拖拽排序 PATCH 持久化（S2）。 */
export function SourceConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getConfigSources());
  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="space-y-2" data-testid="source-config-skeleton">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded-lg bg-panel2" />
      ))}
    </div>;
  }
  return (
    <div>
      {data.sources.map((s) => (
        <div key={s.id} className="flex items-center gap-3 border-b border-line py-2 text-xs">
          <span className="w-4 text-dim">{s.rotation_locked ? '🔒' : '⠿'}</span>
          <b className="w-40 text-txt">{s.label}</b>
          <span className="text-dim">
            速率 <span className="num text-txt">{s.rate_per_sec} req/s</span>
            {s.jitter_ms > 0 && (
              <>
                {' · '}抖动 <span className="num text-txt">±{s.jitter_ms}ms</span>
              </>
            )}
            {' · '}熔断连续失败 <span className="num text-txt">{s.circuit_fail_count}</span>
            {' · '}退避 <span className="num text-txt">{s.backoff_steps.join('→')}s</span>
          </span>
          {s.rotation_locked && (
            <span className="text-[#fbbf24]">锁定末位不可上移（ADR-006）</span>
          )}
          <span className={`ml-auto inline-block h-4 w-8 rounded-full ${s.enabled ? 'bg-[rgba(0,224,164,.25)]' : 'bg-[rgba(255,255,255,.06)]'}`} />
        </div>
      ))}
      <SaveDisabledNote />
    </div>
  );
}
