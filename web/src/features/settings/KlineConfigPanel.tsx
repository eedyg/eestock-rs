import { useEffect, useState } from 'react';
import type { ApiClient } from '@/api/client';
import { useApiSlice } from './useApiSlice';
import { RegionError } from '../quality/DivergenceTable';

/** K线默认视口（K 线根数）取值范围（与后端 MIN/MAX_KLINE_VIEWPORT_BARS 30/600 同构）。 */
const MIN = 30;
const MAX = 600;
const DEFAULT = 120;

/** kline-config（08-settings §L2）：行情看板 K线默认视口（K 线根数，与周期无关）。
 *  GET /api/config/kline 读；PUT 保存（校验 30-600 整数）+ 乐观更新 + 回显。
 *  （数据区）看板主图+宫格统一应用；回测弹窗固定 120 根、不读本配置。 */
export function KlineConfigPanel({ api }: { api: ApiClient }) {
  const { data, loading, error, reload } = useApiSlice(() => api.getKlineConfig());
  const [text, setText] = useState(String(DEFAULT));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) setText(String(data.viewport_bars));
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
    const prev = data.viewport_bars;
    setSaving(true);
    setSaveMsg(null);
    setSaveErr(null);
    setText(String(value)); // 乐观更新
    try {
      const resp = await api.saveKlineConfig(value);
      setText(String(resp.viewport_bars)); // 成功用后端回显
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
          默认K线根数（主图与宫格统一，所有周期一致）{' '}
          <input
            type="number"
            min={MIN}
            max={MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="默认K线根数"
            className={`num w-16 rounded-md border bg-panel px-2 py-0.5 text-txt ${
              invalid ? 'border-[#ff5c6c]' : 'border-line'
            }`}
          />
          {' '}
          {MIN}–{MAX}，默认 {DEFAULT}。初始可见约等于该根数（容器宽度自适应，不受周期影响）。
          {invalid && <span className="text-[#ff5c6c]">须为 {MIN}–{MAX} 整数</span>}
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
