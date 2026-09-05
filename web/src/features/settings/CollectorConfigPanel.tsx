import type { ApiClient } from '@/api/client';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';
import { SaveDisabledNote } from './SourceConfigPanel';

/** collector-config（08-settings §L2）：全局默认抓取间隔 + 交易时段（写死只读）。 */
export function CollectorConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getConfigCollector());
  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="h-12 animate-pulse rounded-xl bg-panel2" data-testid="collector-config-skeleton" />;
  }
  return (
    <div>
      <div className="text-xs text-dim">
        全局默认抓取间隔（新注册标的默认值）{' '}
        <span className="num text-txt">{data.default_interval_sec}s</span>
        {` · `}交易时段{' '}
        <span className="num text-txt">{data.trading_hours}</span>{' '}
        <span className="text-dim">写死不开放（只读展示）</span>
      </div>
      <SaveDisabledNote />
    </div>
  );
}
