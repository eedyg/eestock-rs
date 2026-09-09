import { useMemo, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { StrategyDiffResp, StrategyVersionRowDto } from '@/api/types';
import { diffLines } from './diff';

/**
 * 版本 diff 视图：选两版本 → GET /api/strategies/versions/diff → 行级 LCS diff 渲染（自实现，
 * 未引入 @codemirror/merge——保持批准依赖清单不变；选择理由见 coder 报告）。
 * 行口径：del（红/up，前缀 −）/ add（绿/down，前缀 +）/ same（dim）。
 */
export function DiffView({
  api,
  versions,
}: {
  api: ApiClient;
  versions: StrategyVersionRowDto[];
}) {
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [result, setResult] = useState<StrategyDiffResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 默认选择：from = 次新版本，to = 最新版本（≥2 版本时）
  const sorted = useMemo(() => [...versions].sort((a, b) => a.version - b.version), [versions]);
  const effFrom = fromId || (sorted.length >= 2 ? sorted[sorted.length - 2]!.id : sorted[0]?.id || '');
  const effTo = toId || (sorted.length >= 1 ? sorted[sorted.length - 1]!.id : '');

  const lines = useMemo(
    () => (result ? diffLines(result.from.code, result.to.code) : null),
    [result],
  );

  const handleRun = async () => {
    if (!effFrom || !effTo) return;
    setError(null);
    setLoading(true);
    try {
      setResult(await api.diffStrategyVersions(effFrom, effTo));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'diff 加载失败');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 overflow-auto p-3 text-xs" data-testid="diff-view">
      <div className="flex items-end gap-2">
        <label className="block text-dim">
          从版本
          <select
            className="mt-0.5 h-7 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={effFrom}
            onChange={(e) => setFromId(e.target.value)}
            data-testid="diff-from"
          >
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version}（{v.status}）
              </option>
            ))}
          </select>
        </label>
        <label className="block text-dim">
          到版本
          <select
            className="mt-0.5 h-7 rounded-lg border border-line bg-panel2 px-2 text-txt"
            value={effTo}
            onChange={(e) => setToId(e.target.value)}
            data-testid="diff-to"
          >
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version}（{v.status}）
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={loading || !effFrom || !effTo}
          className="h-7 rounded-lg bg-gradient-to-r from-acc1 to-acc2 px-3 font-medium text-white disabled:opacity-50"
          onClick={() => void handleRun()}
          data-testid="diff-run"
        >
          {loading ? '对比中…' : '对比'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-2 text-up" data-testid="diff-error">
          {error}
        </div>
      )}

      {lines && (
        <div className="overflow-auto rounded-lg border border-line bg-panel2" data-testid="diff-result">
          <div className="border-b border-line px-2 py-1 text-dim">
            v{result!.from.version} → v{result!.to.version}
          </div>
          <pre className="p-2 font-mono text-[11px] leading-5">
            {lines.map((l, i) => (
              <div
                key={i}
                data-testid={`diff-line-${l.type}`}
                className={
                  l.type === 'add'
                    ? 'bg-down/10 text-down'
                    : l.type === 'del'
                      ? 'bg-up/10 text-up line-through'
                      : 'text-dim'
                }
              >
                <span className="mr-2 inline-block w-14 select-none text-right opacity-60">
                  {l.fromNo ?? ''}
                  {' | '}
                  {l.toNo ?? ''}
                </span>
                {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}
                {l.text}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
