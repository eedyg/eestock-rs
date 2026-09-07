import { useState } from 'react';
import type { BacktestRunDto, BacktestStrategyDto } from '@/api/types';
import { fmtIso, periodLabel, statusLabel } from './format';

interface ProgressInfo {
  pct: number;
  currentTs: string | null;
}

/**
 * 页面⑤任务列表：GET /api/backtest/runs（**轻量分页**：首屏 limit=100，加载更多 offset 递增）+ WS backtest_progress 实时进度（运行中）。
 * 状态（排队/运行中/完成/失败）+ 进度% + 当前回测日期；点已完成载入结果（仅此时 GET /{id} 拉结果）；勾选 2-N 进对比；多任务并行。
 */
export function TaskList({
  runs,
  strategies,
  loading,
  error,
  onRetry,
  selectedRunId,
  compareIds,
  progressMap,
  onSelectRun,
  onToggleCompare,
  onDeleteRun,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  runs: BacktestRunDto[] | null;
  strategies: BacktestStrategyDto[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedRunId: number | null;
  compareIds: number[];
  progressMap: Record<number, ProgressInfo>;
  onSelectRun: (id: number) => void;
  onToggleCompare: (id: number) => void;
  /** 删除 run（DELETE /api/backtest/runs/{id}）；reject 时显示错误。 */
  onDeleteRun: (id: number) => Promise<void>;
  /** 分页：还有更多（条数==limit）。 */
  hasMore?: boolean;
  /** 分页：加载更多进行中。 */
  loadingMore?: boolean;
  /** 分页：加载更多（滚动/按钮触发）。 */
  onLoadMore?: () => void;
}) {
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 删除入口：done/failed（终态）可删；running/pending 不提供（任务执行中）。
  const isDeletable = (s: BacktestRunDto['status']) => s === 'done' || s === 'failed';
  const handleConfirmDelete = async (id: number) => {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await onDeleteRun(id);
      setConfirmId(null);
    } catch (e) {
      setDeleteError((e as Error).message);
      setConfirmId(null);
    } finally {
      setDeletingId(null);
    }
  };

  if (error) {
    return (
      <div className="flex h-full items-center gap-3 px-3 text-xs text-up">
        <span>任务加载失败：{error}</span>
        <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }
  if (loading || !runs) {
    return (
      <div className="flex h-full flex-col justify-center gap-2 px-3" data-testid="task-skeleton">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-6 animate-pulse rounded bg-white/10" />
        ))}
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-dim" data-testid="task-empty">
        暂无回测任务，从左侧提交
      </div>
    );
  }

  const nameOf = (id: string) => strategies?.find((s) => s.id === id)?.name ?? id;
  const statusColor: Record<string, string> = {
    pending: 'text-dim',
    running: 'text-acc1',
    done: 'text-down',
    failed: 'text-up',
  };
  const statusDot: Record<string, string> = {
    pending: '○',
    running: '●',
    done: '●',
    failed: '●',
  };

  return (
    <div className="flex h-full flex-col overflow-auto px-3" data-testid="task-list">
      {deleteError && (
        <div className="py-1 text-xs text-up" data-testid="task-delete-error">
          删除失败：{deleteError}
        </div>
      )}
      {runs.map((r) => {
        const prog = progressMap[r.id] ?? { pct: r.progress, currentTs: r.current_ts };
        const checked = compareIds.includes(r.id);
        const isDone = r.status === 'done';
        return (
          <div
            key={r.id}
            className={`flex items-center gap-3 border-b border-line py-1.5 text-xs ${selectedRunId === r.id ? 'bg-white/5' : ''}`}
            data-testid={`task-row-${r.id}`}
          >
            {isDone && (
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleCompare(r.id)}
                className="accent-acc1"
                aria-label={`对比 ${nameOf(r.strategy_id)}`}
                data-testid={`task-check-${r.id}`}
              />
            )}
            <span className={`w-12 shrink-0 ${statusColor[r.status] ?? 'text-dim'}`}>
              {statusDot[r.status] ?? '○'} {statusLabel(r.status)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {nameOf(r.strategy_id)} · {r.code} {periodLabel(r.period)}
            </span>
            <span className="num text-dim">
              {isDone ? (
                <button type="button" className="text-acc1 hover:underline" onClick={() => onSelectRun(r.id)}>
                  查看
                </button>
              ) : r.status === 'failed' ? (
                <span className="text-up" title={r.error ?? ''}>失败</span>
              ) : (
                <>
                  <span className="num">{prog.pct}%</span>
                  <span className="ml-2 text-dim">回测至 {fmtIso(prog.currentTs)}</span>
                </>
              )}
            </span>
            {isDeletable(r.status) &&
              (confirmId === r.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={deletingId === r.id}
                    onClick={() => handleConfirmDelete(r.id)}
                    className="rounded border border-up/40 px-1.5 py-0.5 text-up hover:bg-up/10 disabled:opacity-50"
                    data-testid={`task-delete-confirm-${r.id}`}
                  >
                    确认
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="rounded border border-line px-1.5 py-0.5 text-dim hover:text-txt"
                    data-testid={`task-delete-cancel-${r.id}`}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(r.id)}
                  className="shrink-0 rounded border border-line px-1.5 py-0.5 text-dim hover:text-up"
                  data-testid={`task-delete-${r.id}`}
                >
                  删除
                </button>
              ))}
          </div>
        );
      })}
      {hasMore && (
        <div className="flex justify-center py-2">
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="rounded-lg border border-line px-3 py-1 text-xs text-dim hover:text-txt disabled:opacity-50"
            data-testid="task-load-more"
          >
            {loadingMore ? '加载中…' : '加载更多任务'}
          </button>
        </div>
      )}
    </div>
  );
}
