import { useMemo, useState } from 'react';
import type { WorkbenchBarRecord } from '@/api/types';
import { fmtTs } from '@/features/backtest/format';

/** 逐bar评分表分页大小（ADR §13.4：全量数据 UI 分页渲染，不一次渲染几十万行 DOM）。 */
export const PERBAR_PAGE_SIZE = 100;

const SIGNAL_CLS: Record<string, string> = {
  Buy: 'text-up',
  Sell: 'text-down',
  Hold: 'text-dim',
};

/**
 * 逐 bar 评分表（ADR §13.5 Tab）：ts / 各 slot 分（错误 bar 标 ⚠）/ 聚合分 / 信号 / 订单数。
 * 分页渲染（pageSize=100），全量数据不抽样（表为明细查证面；抽样只作用于图表）。
 */
export function PerBarTable({ perBar, slotCount }: { perBar: WorkbenchBarRecord[]; slotCount: number }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(perBar.length / PERBAR_PAGE_SIZE));
  const cur = Math.min(page, pageCount - 1);
  const rows = useMemo(
    () => perBar.slice(cur * PERBAR_PAGE_SIZE, (cur + 1) * PERBAR_PAGE_SIZE),
    [perBar, cur],
  );

  return (
    <div data-testid="wb-perbar-table">
      <div className="mb-1 flex items-center justify-between text-[10px] text-dim">
        <span>
          共 {perBar.length} bar · 第 <span data-testid="wb-perbar-page-info">{cur + 1} / {pageCount}</span> 页
        </span>
        <span className="flex gap-1">
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 disabled:opacity-40"
            disabled={cur <= 0}
            onClick={() => setPage(cur - 1)}
            data-testid="wb-perbar-prev"
          >
            上一页
          </button>
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 disabled:opacity-40"
            disabled={cur >= pageCount - 1}
            onClick={() => setPage(cur + 1)}
            data-testid="wb-perbar-next"
          >
            下一页
          </button>
        </span>
      </div>
      <div className="overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-dim">
              <th className="px-2 py-1 font-normal">时刻</th>
              {Array.from({ length: slotCount }, (_, i) => (
                <th key={i} className="px-2 py-1 font-normal">策略{i + 1}</th>
              ))}
              <th className="px-2 py-1 font-normal">聚合</th>
              <th className="px-2 py-1 font-normal">信号</th>
              <th className="px-2 py-1 font-normal">订单</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.ts} className="border-b border-line/40" data-testid={`wb-perbar-row-${cur * PERBAR_PAGE_SIZE + i}`}>
                <td className="num px-2 py-1 text-dim">{fmtTs(r.ts)}</td>
                {Array.from({ length: slotCount }, (_, slotIdx) => {
                  const sc = r.scores.find((s) => s.slot_idx === slotIdx);
                  return (
                    <td key={slotIdx} className="num px-2 py-1" title={sc?.error ?? undefined}>
                      {sc ? `${sc.score}${sc.error ? ' ⚠' : ''}` : '—'}
                    </td>
                  );
                })}
                <td className="num px-2 py-1">{r.aggregate}</td>
                <td className={`px-2 py-1 ${SIGNAL_CLS[r.signal] ?? ''}`}>{r.signal}</td>
                <td className="num px-2 py-1 text-dim">{r.orders.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
