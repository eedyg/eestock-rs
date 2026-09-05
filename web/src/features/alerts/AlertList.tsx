import type { AlertEventItem, AlertLevelName } from '@/api/types';
import type { AsyncSlice } from './store';

const LEVEL_PILL: Record<AlertLevelName, string> = {
  critical: 'border border-up/40 bg-up/15 text-up',
  warning: 'border border-[#fbbf24]/35 bg-[#fbbf24]/12 text-[#fbbf24]',
  info: 'border border-acc1/30 bg-acc1/12 text-acc1',
};

/** HH:MM（Asia/Shanghai，与事件口径一致） */
function hhmm(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * alert-list（07-alerts L2）：级别/来源/内容/时刻/状态 + [确认]；
 * 聚合条目=触发计数+最近触发时刻；未确认高亮；三态=骨架行/暂无告警/错误条+重试。
 */
export function AlertList({
  list,
  acking,
  onAck,
  onRetry,
}: {
  list: AsyncSlice<AlertEventItem[]>;
  acking: Record<number, boolean>;
  onAck: (id: number) => void;
  onRetry: () => void;
}) {
  if (list.error) {
    return (
      <div className="flex items-center gap-3 p-3 text-xs text-up">
        <span>加载失败：{list.error}</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt"
        >
          重试
        </button>
      </div>
    );
  }
  if (list.loading || list.data === null) {
    return (
      <div className="space-y-2 p-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-lg bg-panel2" />
        ))}
      </div>
    );
  }
  if (list.data.length === 0) {
    return <div className="p-6 text-center text-xs text-dim">暂无告警</div>;
  }
  return (
    <div className="h-[680px] overflow-y-auto p-3 text-xs">
      {list.data.map((a) => {
        const unacked = a.status === 'triggered';
        return (
          <div
            key={a.id}
            className={[
              'mb-1.5 flex items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2',
              unacked ? 'border-l-[3px] border-l-acc1' : '',
              a.status === 'acked' ? 'opacity-60' : '',
              a.status === 'resolved' ? 'opacity-45' : '',
            ].join(' ')}
          >
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${LEVEL_PILL[a.level]}`}>
              {a.level}
            </span>
            <span className="num text-dim">{hhmm(a.last_fired_at)}</span>
            <span className="num text-dim">{a.source}</span>
            <span className="flex-1">{a.message}</span>
            {a.fire_count > 1 && (
              <span className="num rounded-full bg-acc2/15 px-2 text-[11px] text-acc2">
                ×{a.fire_count}
              </span>
            )}
            {unacked && (
              <button
                type="button"
                disabled={!!acking[a.id]}
                onClick={() => onAck(a.id)}
                className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt disabled:opacity-40"
              >
                确认
              </button>
            )}
            {a.status === 'acked' && (
              <span className="text-dim">已确认 {a.acked_at ? hhmm(a.acked_at) : ''}</span>
            )}
            {a.status === 'resolved' && (
              <span className="text-dim">已恢复 {a.resolved_at ? hhmm(a.resolved_at) : ''}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
