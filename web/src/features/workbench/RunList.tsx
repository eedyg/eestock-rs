import { useState } from 'react';
import type { WorkbenchRunView } from '@/api/types';
import { fmtIso, periodLabel } from '@/features/backtest/format';
import { MAX_COMPARE } from './store';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  succeeded: '完成',
  failed: '失败',
  canceled: '已取消',
};

const STATUS_CLS: Record<string, string> = {
  queued: 'text-dim',
  running: 'text-acc1',
  succeeded: 'text-up',
  failed: 'text-down',
  canceled: 'text-dim',
};

/**
 * 运行管理（页面⑪ 左侧下区）：历史列表（状态/进度/时间，分页「加载更多」）+
 * 取消按钮（queued/running）+ compare 勾选（仅 succeeded，≤MAX_COMPARE）。
 * 进度 = WS progressMap 覆盖 REST 行进度（0..1 → %）。
 */
export function RunList({
  runs,
  loading,
  error,
  onRetry,
  selectedRunId,
  compareIds,
  progressMap,
  onSelectRun,
  onToggleCompare,
  onCancelRun,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  runs: WorkbenchRunView[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedRunId: string | null;
  compareIds: string[];
  progressMap: Record<string, { progress: number; barTs: string | null }>;
  onSelectRun: (id: string) => void;
  onToggleCompare: (id: string) => void;
  onCancelRun: (id: string) => Promise<void>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCancel = async (id: string) => {
    setActionError(null);
    try {
      await onCancelRun(id);
    } catch (e) {
      // 409 已终态 / 404 未知 → 友好提示（后端 error 文本已在 message 内）
      setActionError(`取消失败：${(e as Error).message}`);
    }
  };

  if (error) {
    return (
      <div className="flex items-center gap-3 p-3 text-xs text-up" data-testid="wb-run-list-error">
        <span>运行历史加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2 text-xs" data-testid="wb-run-list">
      <div className="flex items-center justify-between px-1 text-dim">
        <span>运行历史（勾选 {compareIds.length}/{MAX_COMPARE} 对比）</span>
        <button type="button" onClick={onRetry} className="rounded border border-line px-2 py-0.5 hover:text-txt" data-testid="wb-runs-refresh">
          刷新
        </button>
      </div>
      {actionError && (
        <div className="rounded-lg border border-up/40 bg-up/10 px-2 py-1 text-up" role="alert" data-testid="wb-action-error">
          {actionError}
        </div>
      )}
      {loading && !runs && <div className="h-3 w-32 animate-pulse rounded bg-white/10" data-testid="wb-runs-skeleton" />}
      {(runs ?? []).map((r) => {
        const pct = Math.round((progressMap[r.id]?.progress ?? r.progress) * 100);
        const terminal = r.status !== 'queued' && r.status !== 'running';
        const comparable = r.status === 'succeeded';
        const checked = compareIds.includes(r.id);
        return (
          <div
            key={r.id}
            className={`rounded-lg border p-2 ${selectedRunId === r.id ? 'border-acc1 bg-panel' : 'border-line bg-panel2'}`}
            data-testid={`wb-run-row-${r.id}`}
          >
            <div className="flex items-center gap-2">
              {comparable && (
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && compareIds.length >= MAX_COMPARE}
                  onChange={() => onToggleCompare(r.id)}
                  title="勾选对比（2-4 个已完成运行）"
                  data-testid={`wb-compare-${r.id}`}
                />
              )}
              <button
                type="button"
                className="min-w-0 flex-1 text-left hover:text-acc1"
                onClick={() => onSelectRun(r.id)}
                data-testid={`wb-run-select-${r.id}`}
              >
                <div className="truncate text-txt">{r.name || r.id}</div>
                <div className="text-[10px] text-dim">
                  {r.symbol} · {periodLabel(r.period)} · {fmtIso(r.created_at)}
                </div>
              </button>
              <span className={`shrink-0 ${STATUS_CLS[r.status] ?? ''}`}>
                {STATUS_LABEL[r.status] ?? r.status}
                {!terminal && ` ${pct}%`}
              </span>
              {!terminal && (
                <button
                  type="button"
                  className="shrink-0 rounded border border-line px-2 py-0.5 text-dim hover:text-up"
                  onClick={() => void handleCancel(r.id)}
                  data-testid={`wb-cancel-${r.id}`}
                >
                  取消
                </button>
              )}
            </div>
            {!terminal && (
              <div className="mt-1 h-1 rounded bg-white/10">
                <div className="h-1 rounded bg-acc1 transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
            {r.status === 'failed' && r.error && (
              <div className="mt-1 truncate text-[10px] text-down" title={r.error}>
                {r.error}
              </div>
            )}
          </div>
        );
      })}
      {runs && runs.length === 0 && !loading && <div className="p-2 text-dim">暂无运行记录</div>}
      {hasMore && (
        <button
          type="button"
          className="mt-1 rounded-lg border border-line px-3 py-1 text-dim hover:text-txt disabled:opacity-40"
          disabled={loadingMore}
          onClick={onLoadMore}
          data-testid="wb-runs-more"
        >
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  );
}
