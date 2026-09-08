import { useEffect, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { SourceConfigItem } from '@/api/types';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';

/** 编辑行控件封装（数值输入，值域校验 onBlur/changed 提示）。 */
function NumInput({ value, min, onCommit, label }: {
  value: number; min: number; onCommit: (v: number) => void; label: string;
}) {
  const [text, setText] = useState(String(value));
  const invalid = Number.isNaN(Number(text)) || Number(text) < min;
  useEffect(() => setText(String(value)), [value]);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (!Number.isNaN(Number(text))) onCommit(Number(text)); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !Number.isNaN(Number(text))) { onCommit(Number(text)); (e.target as HTMLInputElement).blur(); }
        }}
        aria-label={label}
        className={`num w-16 rounded-md border bg-panel px-2 py-0.5 text-txt ${invalid ? 'border-[#ff5c6c]' : 'border-line'}`}
      />
      {invalid && <span className="text-[#ff5c6c]">须≥{min}</span>}
    </span>
  );
}

/** 启停开关（可点击翻转）。 */
function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
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

/** source-config（08-settings §L2）：内置源清单 + 每源可编辑参数 + 轮转序。
 *  S2：启用保存（PATCH /api/config/sources）+ 乐观更新 + 值域前端提示（东财末位 ADR-006）。 */
export function SourceConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getConfigSources());
  const [sources, setSources] = useState<SourceConfigItem[]>([]);
  const [lastSaved, setLastSaved] = useState<SourceConfigItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) { setSources(data.sources.map((s) => ({ ...s }))); setLastSaved(data.sources.map((s) => ({ ...s }))); }
  }, [data]);

  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="space-y-2" data-testid="source-config-skeleton">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded-lg bg-panel2" />
      ))}
    </div>;
  }
  if (sources.length === 0) return null;

  const setItem = (i: number, patch: Partial<SourceConfigItem>) =>
    setSources((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const invalid = sources.some((s) =>
    s.rate_per_sec < 0 || s.jitter_ms < 0 || s.circuit_fail_count < 0 || s.backoff_steps.length === 0);
  const eastMoneyNotLast = sources[sources.length - 1]?.id !== 'push2delay';

  const move = (i: number, dir: -1 | 1) => {
    setSources((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      // 东财末位锁定：push2delay 不可上移（ADR-006）
      if (prev[j]!.rotation_locked && dir === -1) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };

  const save = async () => {
    if (invalid || eastMoneyNotLast) return;
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    setLastSaved(sources.map((s) => ({ ...s }))); // 乐观基线
    try {
      const resp = await api.saveConfigSources(sources.map((s) => ({ ...s })));
      const snap = resp.sources.map((s) => ({ ...s }));
      setSources(snap); setLastSaved(snap);
      setSaveMsg('已保存（下周期生效）');
    } catch (e) {
      setSources(lastSaved.map((s) => ({ ...s }))); // 失败回滚
      setSaveErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-2 text-xs text-dim"><b className="text-txt">数据源参数</b> · 轮转序（东财系末位不可上移）</div>
      {sources.map((s, i) => (
        <div key={s.id} data-testid={`src-row-${s.id}`} className="flex items-center gap-3 border-b border-line py-2 text-xs">
          <span className="w-8 text-dim">
            <button type="button" onClick={() => move(i, -1)} disabled={s.rotation_locked || i === 0}
              aria-label={`${s.id} 上移`} className="disabled:opacity-30">▲</button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === sources.length - 1}
              aria-label={`${s.id} 下移`} className="ml-1 disabled:opacity-30">▼</button>
          </span>
          <b className="w-36 text-txt">{s.label}</b>
          <span className="flex items-center gap-3 text-dim">
            <label className="inline-flex items-center gap-1">速率 <NumInput value={s.rate_per_sec} min={0} label={`${s.id} 速率`} onCommit={(v) => setItem(i, { rate_per_sec: v })} /></label>
            <label className="inline-flex items-center gap-1">抖动 <NumInput value={s.jitter_ms} min={0} label={`${s.id} 抖动`} onCommit={(v) => setItem(i, { jitter_ms: v })} /></label>
            <label className="inline-flex items-center gap-1">熔断 <NumInput value={s.circuit_fail_count} min={0} label={`${s.id} 熔断次数`} onCommit={(v) => setItem(i, { circuit_fail_count: v })} /></label>
          </span>
          {s.rotation_locked && <span className="text-[#fbbf24]">锁定末位（ADR-006）</span>}
          <span className="ml-auto">
            <Toggle on={s.enabled} label={`${s.id} 启停`} onToggle={() => setItem(i, { enabled: !s.enabled })} />
          </span>
        </div>
      ))}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || invalid || eastMoneyNotLast}
          data-testid="save-sources"
          className="rounded-lg border border-line px-4 py-1 text-xs text-txt disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {invalid && <span className="text-[#ff5c6c]">参数值域非法（≥0 且退避非空）</span>}
        {eastMoneyNotLast && !invalid && <span className="text-[#fbbf24]">东财必须末位</span>}
        {saveMsg && <span className="text-[#00e0a4]">{saveMsg}</span>}
        {saveErr && <span className="text-[#ff5c6c]" data-testid="save-sources-err">{saveErr}</span>}
      </div>
    </div>
  );
}
