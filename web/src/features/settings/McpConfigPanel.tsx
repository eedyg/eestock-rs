import { useEffect, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { McpConfigSnapshot } from '@/api/types';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';

/** 开关样式（可点击翻转）。 */
function Switcher({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={on}
      className={`inline-block h-4 w-8 rounded-full align-middle transition ${
        on ? 'bg-[rgba(0,224,164,.35)]' : 'bg-[rgba(255,255,255,.06)]'
      }`}
    >
      <span className={`block h-3 w-3 rounded-full bg-white/90 transition ${on ? 'ml-4' : 'ml-0.5'}`} />
    </button>
  );
}

/** mcp-config（08-settings §L2）：总开关/交易工具开关（默认关，开启需二次确认 ADR-009）/每日限额。
 *  S2：启用保存（PATCH /api/config/mcp）+ 乐观更新 + 值域提示（≥0）+ 交易工具开启二次确认。 */
export function McpConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getConfigMcp());
  const [cfg, setCfg] = useState<McpConfigSnapshot>({ enabled: true, trading_tools_enabled: false, daily_limit_amount: 50000, daily_limit_count: 20 });
  const [lastSaved, setLastSaved] = useState<McpConfigSnapshot>(cfg);
  const [amountText, setAmountText] = useState('50000');
  const [countText, setCountText] = useState('20');
  const [pendingTools, setPendingTools] = useState(false); // 交易工具开启待二次确认
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setCfg(data); setLastSaved(data);
      setAmountText(String(data.daily_limit_amount)); setCountText(String(data.daily_limit_count));
    }
  }, [data]);

  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="h-16 animate-pulse rounded-xl bg-panel2" data-testid="mcp-config-skeleton" />;
  }

  const amount = Number(amountText);
  const count = Number(countText);
  const invalid = Number.isNaN(amount) || Number.isNaN(count) || amount < 0 || count < 0;

  const toggleTools = () => {
    if (cfg.trading_tools_enabled) { setCfg((c) => ({ ...c, trading_tools_enabled: false })); setPendingTools(false); }
    else setPendingTools(true); // 开启需二次确认（ADR-009）
  };
  const confirmTools = () => { setCfg((c) => ({ ...c, trading_tools_enabled: true })); setPendingTools(false); setSaveMsg(null); };

  const save = async () => {
    if (invalid) return;
    const next = { ...cfg, daily_limit_amount: amount, daily_limit_count: count };
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    setLastSaved(cfg);   // 乐观基线
    setCfg(next);        // 乐观更新
    try {
      const resp = await api.saveConfigMcp({ enabled: next.enabled, trading_tools_enabled: next.trading_tools_enabled, daily_limit_amount: next.daily_limit_amount, daily_limit_count: next.daily_limit_count });
      setCfg(resp); setLastSaved(resp); setAmountText(String(resp.daily_limit_amount)); setCountText(String(resp.daily_limit_count));
      setSaveMsg('已保存');
    } catch (e) {
      setCfg(lastSaved); setAmountText(String(lastSaved.daily_limit_amount)); setCountText(String(lastSaved.daily_limit_count)); // 失败回滚
      setSaveErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="space-y-2 text-xs text-dim">
        <div>
          MCP 服务总开关 <Switcher on={cfg.enabled} label="MCP 总开关" onToggle={() => setCfg((c) => ({ ...c, enabled: !c.enabled }))} />
        </div>
        <div>
          交易工具独立开关 <Switcher on={cfg.trading_tools_enabled} label="交易工具开关" onToggle={toggleTools} />
          <span className="text-[#fbbf24]">默认关；开启需页面二次确认（ADR-009）</span>
          {pendingTools && (
            <span className="ml-2 inline-flex items-center gap-2">
              <span className="text-[#fbbf24]">确认开启交易工具？</span>
              <button type="button" onClick={confirmTools} data-testid="mcp-confirm-tools" className="rounded border border-[#fbbf24] px-2 py-0.5 text-[#fbbf24]">确认</button>
              <button type="button" onClick={() => setPendingTools(false)} className="rounded border border-line px-2 py-0.5 text-dim">取消</button>
            </span>
          )}
        </div>
        <div>
          每日下单限额：金额{' '}
          <input type="text" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="每日下单金额"
            className={`num w-24 rounded-md border bg-panel px-2 py-0.5 text-txt ${Number.isNaN(amount) || amount < 0 ? 'border-[#ff5c6c]' : 'border-line'}`} />
          {' · '}笔数{' '}
          <input type="text" value={countText} onChange={(e) => setCountText(e.target.value)} aria-label="每日下单笔数"
            className={`num w-16 rounded-md border bg-panel px-2 py-0.5 text-txt ${Number.isNaN(count) || count < 0 ? 'border-[#ff5c6c]' : 'border-line'}`} />
          {invalid && <span className="text-[#ff5c6c]">限额须≥0</span>}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || invalid}
          data-testid="save-mcp"
          className="rounded-lg border border-line px-4 py-1 text-xs text-txt disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {saveMsg && <span className="text-[#00e0a4]">{saveMsg}</span>}
        {saveErr && <span className="text-[#ff5c6c]" data-testid="save-mcp-err">{saveErr}</span>}
      </div>
    </div>
  );
}
