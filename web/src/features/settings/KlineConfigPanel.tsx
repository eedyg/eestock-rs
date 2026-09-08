import { useEffect, useState } from 'react';
import type { ApiClient } from '@/api/client';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';

/** K线默认视口（交易日数）取值范围（与后端 verify_kline_viewport_days 1-50 同构）。 */
const MIN = 1;
const MAX = 50;
const DEFAULT = 2;

/** kline-config（08-settings §L2）：行情看板 K线默认视口（交易日数）。
 *  GET /api/config/kline 读；PUT 保存（校验 1-50 整数）+ 乐观更新 + 回显。
 *  （数据区）看板主图/宫格共用；回测弹窗不受影响。 */
export function KlineConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getKlineConfig());
  const [text, setText] = useState(String(DEFAULT));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) setText(String(data.viewport_days));
  }, [data]);

  if (error) return <RegionError error={error} onRetry={reload} />;
  if (loading || data === null) {
    return <div className="h-16 animate-pulse rounded-xl bg-panel2" data-testid="kline-config-skeleton" />;
  }

  const value = Number(text);
  const invalid = !Number.isInteger(value) || value < MIN || value > MAX;

  /** 保存：乐观更新（先 setText 再 await 接口）→ 成功用后端回显，失败回滚。 */
  const save = async () => {
    if (invalid) return;
    const prev = data.viewport_days;
    setSaving(true);
    setSaveMsg(null);
    setSaveErr(null);
    setText(String(value)); // 乐观更新
    try {
      const resp = await api.saveKlineConfig(value);
      setText(String(resp.viewport_days)); // 成功用后端回显
      setSaveMsg('已保存');
    } catch (e) {
      setText(String(prev)); // 失败回滚
      setSaveErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="space-y-2 text-xs text-dim">
        <div>
          默认K线视口（交易日数）{' '}
          <input
            type="number"
            min={MIN}
            max={MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="默认K线视口(交易日)"
            className={`num w-16 rounded-md border bg-panel px-2 py-0.5 text-txt ${
              invalid ? 'border-[#ff5c6c]' : 'border-line'
            }`}
          />
          {' '}1–{MAX}，默认 {DEFAULT}。每周期实际 bar = 该周期每日 bar 数 × 视口（1m=241×N、1d=1×N）。
          {invalid && <span className="text-[#ff5c6c]">须为 1–{MAX} 整数</span>}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || invalid}
          data-testid="save-kline-config"
          className="rounded-lg border border-line px-4 py-1 text-xs text-txt disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {saveMsg && <span className="text-[#00e0a4]">{saveMsg}</span>}
        {saveErr && (
          <span className="text-[#ff5c6c]" data-testid="save-kline-config-err">
            {saveErr}
          </span>
        )}
      </div>
    </div>
  );
}
