import { useEffect, useState } from 'react';
import type { ApiClient } from '@/api/client';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';

/** collector-config（08-settings §L2）：全局默认抓取间隔（≥60）+ 交易时段（写死只读）。
 *  S2：启用保存（PATCH /api/config/collector）+ 乐观更新 + 值域提示（≥60）。 */
export function CollectorConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getConfigCollector());
  const [interval, setInterval] = useState<number>(60);
  const [text, setText] = useState('60');
  const [lastSaved, setLastSaved] = useState<number>(60);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) { setInterval(data.default_interval_sec); setText(String(data.default_interval_sec)); setLastSaved(data.default_interval_sec); }
  }, [data]);

  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="h-12 animate-pulse rounded-xl bg-panel2" data-testid="collector-config-skeleton" />;
  }

  const invalid = Number.isNaN(Number(text)) || Number(text) < 60;

  const save = async () => {
    if (invalid) return;
    const v = Number(text);
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    setLastSaved(interval);           // 乐观基线
    setInterval(v);                   // 乐观更新
    try {
      const resp = await api.saveConfigCollector({ default_interval_sec: v });
      setInterval(resp.default_interval_sec); setText(String(resp.default_interval_sec)); setLastSaved(resp.default_interval_sec);
      setSaveMsg('已保存（新注册标的默认值）');
    } catch (e) {
      setInterval(lastSaved); setText(String(lastSaved)); // 失败回滚
      setSaveErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="text-xs text-dim">
        全局默认抓取间隔（新注册标的默认值）{' '}
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !invalid) { save(); } }}
          aria-label="默认抓取间隔（秒）"
          className={`num w-20 rounded-md border bg-panel px-2 py-0.5 text-txt ${invalid ? 'border-[#ff5c6c]' : 'border-line'}`}
        />{' '}
        s{invalid && <span className="text-[#ff5c6c]">须≥60</span>}
        {` · 交易时段 `}<span className="num text-txt">{data.trading_hours}</span>{' '}
        <span className="text-dim">写死不开放（只读展示）</span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || invalid}
          data-testid="save-collector"
          className="rounded-lg border border-line px-4 py-1 text-xs text-txt disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {saveMsg && <span className="text-[#00e0a4]">{saveMsg}</span>}
        {saveErr && <span className="text-[#ff5c6c]" data-testid="save-collector-err">{saveErr}</span>}
      </div>
    </div>
  );
}
