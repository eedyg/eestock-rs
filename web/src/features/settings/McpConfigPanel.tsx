import type { ApiClient } from '@/api/client';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';
import { SaveDisabledNote } from './SourceConfigPanel';

/** 开关样式（只读展示）。 */
function Switcher({ on, off = false }: { on: boolean; off?: boolean }) {
  return (
    <span
      className={`inline-block h-4 w-8 rounded-full align-middle ${
        off
          ? 'bg-[rgba(255,255,255,.06)]'
          : on
            ? 'bg-[rgba(0,224,164,.25)]'
            : 'bg-[rgba(255,255,255,.06)]'
      }`}
    />
  );
}

/** mcp-config（08-settings §L2）：总开关/交易工具开关（默认关，开启需二次确认 ADR-009）/每日限额；只读。 */
export function McpConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getConfigMcp());
  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="h-16 animate-pulse rounded-xl bg-panel2" data-testid="mcp-config-skeleton" />;
  }
  return (
    <div>
      <div className="space-y-2 text-xs text-dim">
        <div>
          MCP 服务总开关 <Switcher on={data.enabled} />
        </div>
        <div>
          交易工具独立开关{' '}
          <Switcher on={data.trading_tools_enabled} off={!data.trading_tools_enabled} />
          <span className="text-[#fbbf24]">默认关；开启需页面二次确认（ADR-009）</span>
        </div>
        <div>
          每日下单限额：金额 <span className="num text-txt">{data.daily_limit_amount.toLocaleString()}</span>
          {' · '}笔数 <span className="num text-txt">{data.daily_limit_count}</span>
        </div>
      </div>
      <SaveDisabledNote />
    </div>
  );
}
