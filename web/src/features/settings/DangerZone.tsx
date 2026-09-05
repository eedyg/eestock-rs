import { useState } from 'react';
import type { ApiClient } from '@/api/client';

/**
 * danger-zone（08-settings §L2）：红色危险区 + 二次确认。confirm 缺失/不匹配 → 服务端拒绝（400）；
 * 前端在 confirm 输入未匹配目标词前禁用按钮（UI 层「缺失被拒」不触发请求）。
 * purge-raw 需 'PURGE'；reset-circuits 需 'RESET'。
 */
export function DangerZone({ api }: { api: ApiClient }) {
  const [confirm, setConfirm] = useState('');
  const [running, setRunning] = useState<null | 'purge' | 'reset'>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(kind: 'purge' | 'reset') {
    setRunning(kind);
    setMessage(null);
    try {
      if (kind === 'purge') {
        const r = await api.purgeRaw(confirm);
        setMessage({ ok: true, text: `已清空 kline_raw（${r.rows_deleted} 行）` });
      } else {
        const r = await api.resetCircuits(confirm);
        setMessage({ ok: true, text: `已写入全部源熔断复位请求（${r.requests} 条）` });
      }
    } catch (e) {
      setMessage({ ok: false, text: `操作失败：${(e as Error).message}` });
    } finally {
      setRunning(null);
    }
  }

  const purgeEnabled = confirm === 'PURGE' && running === null;
  const resetEnabled = confirm === 'RESET' && running === null;

  return (
    <div className="rounded-xl border border-[rgba(255,92,108,.4)] bg-[rgba(255,92,108,.05)] p-3">
      <h4 className="mb-2 text-sm text-up">⚠ 危险操作（红色 + 二次确认）</h4>
      <div className="flex flex-wrap items-center gap-3 text-xs text-dim">
        <button
          type="button"
          disabled={!purgeEnabled}
          onClick={() => void run('purge')}
          className="rounded-lg border border-[rgba(255,92,108,.45)] px-4 py-1 text-up disabled:cursor-not-allowed disabled:opacity-40"
        >
          清空 kline_raw
        </button>
        <span>raw 层数据，accurate 不动</span>
        <button
          type="button"
          disabled={!resetEnabled}
          onClick={() => void run('reset')}
          className="ml-2 rounded-lg border border-[rgba(255,92,108,.45)] px-4 py-1 text-up disabled:cursor-not-allowed disabled:opacity-40"
        >
          全部源熔断重置
        </button>
        <span className="ml-2 text-[#fbbf24]">PURGE / RESET 二次确认，缺失服务端拒绝</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="输入 PURGE 或 RESET 确认"
          data-testid="danger-confirm-input"
          className="w-56 rounded-lg border border-line bg-panel px-3 py-1 text-xs text-txt placeholder:text-dim"
        />
        {message && (
          <span className={`text-xs ${message.ok ? 'text-down' : 'text-up'}`} data-testid="danger-message">
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
