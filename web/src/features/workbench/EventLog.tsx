import { useMemo } from 'react';
import type { WorkbenchBarRecord, WorkbenchEngineEvent } from '@/api/types';
import { fmtTs } from '@/features/backtest/format';

/** 事件日志单次渲染上限（防巨包渲染卡死；超出截尾提示——与试算截断口径同思路）。 */
export const EVENT_LOG_RENDER_CAP = 1000;

interface EventRow {
  ts: number;
  barIndex: number;
  typeLabel: string;
  cls: string;
  detail: string;
}

function describe(ev: WorkbenchEngineEvent): { typeLabel: string; cls: string; detail: string } {
  switch (ev.type) {
    case 'plugin_error':
      return { typeLabel: 'plugin_error', cls: 'text-up', detail: `slot${ev.slot_idx} ${ev.error}` };
    case 'circuit_breaker':
      return { typeLabel: 'circuit_breaker', cls: 'text-up', detail: `slot${ev.slot_idx} 熔断停用（sha256 ${ev.sha256.slice(0, 8)}…）` };
    case 'plugin_log':
      return { typeLabel: 'plugin_log', cls: 'text-dim', detail: `slot${ev.slot_idx} ${ev.message}` };
    case 'fill':
      return {
        typeLabel: 'fill',
        cls: ev.reason === 'StopTrigger' ? 'text-[#fb923c]' : 'text-txt',
        detail: `${ev.side} ${ev.qty}股 @${ev.price}（${ev.reason}）`,
      };
  }
}

/** 事件日志（ADR §13.5 Tab；ADR §10：插件错误/熔断/插件 log/成交全量入流，不静默吞错）。 */
export function EventLog({ perBar }: { perBar: WorkbenchBarRecord[] }) {
  const rows = useMemo(() => {
    const out: EventRow[] = [];
    for (const rec of perBar) {
      for (const ev of rec.events) {
        out.push({ ts: rec.ts, barIndex: ev.bar_index, ...describe(ev) });
      }
    }
    return out;
  }, [perBar]);

  const shown = rows.slice(0, EVENT_LOG_RENDER_CAP);
  return (
    <div className="overflow-auto text-xs" data-testid="wb-event-log">
      <div className="mb-1 text-[10px] text-dim">
        共 {rows.length} 条{rows.length > shown.length ? `（显示前 ${shown.length} 条）` : ''}
      </div>
      {shown.length === 0 && <div className="text-dim">无事件</div>}
      {shown.map((r, i) => (
        <div key={i} className="flex gap-2 border-b border-line/30 px-1 py-0.5" data-testid="wb-event-row">
          <span className="num shrink-0 text-dim">{fmtTs(r.ts)}</span>
          <span className={`shrink-0 ${r.cls}`}>{r.typeLabel}</span>
          <span className="min-w-0 break-all text-dim">{r.detail}</span>
        </div>
      ))}
    </div>
  );
}
