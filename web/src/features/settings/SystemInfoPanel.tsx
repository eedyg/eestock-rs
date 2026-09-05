import type { ApiClient } from '@/api/client';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';

/** system-info（08-settings §L2）：应用/crate 版本、DB 状态、运行时长；只读。 */
function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  if (d > 0) return `${d}天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${h}时 ${m}分`;
}

export function SystemInfoPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getSystemInfo());
  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="h-24 animate-pulse rounded-xl bg-panel2" data-testid="system-info-skeleton" />;
  }
  const db = data.db_ok ? (
    <span className="text-down">已连接</span>
  ) : (
    <span className="text-up">已断开</span>
  );
  return (
    <div className="space-y-1.5 text-xs text-dim">
      <div>
        应用 <span className="num text-txt">v{data.app_version}</span>
        <span className="mx-2 text-line">·</span>
        crates：
        <span className="num text-txt">collector {data.crate_versions.collector}</span>
        <span className="mx-1 text-line">/</span>
        <span className="num text-txt">storage {data.crate_versions.storage}</span>
        <span className="mx-1 text-line">/</span>
        <span className="num text-txt">diagnose {data.crate_versions.diagnose}</span>
      </div>
      <div>
        DB <span className="text-txt">{db}</span>
        <span className="mx-2 text-line">·</span>
        运行 <span className="num text-txt">{fmtUptime(data.uptime_secs)}</span>
      </div>
    </div>
  );
}
