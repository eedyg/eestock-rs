import { useEffect, useMemo, useState } from 'react';
import type { WorkbenchBarRecord } from '@/api/types';
import { fmtTs } from '@/features/backtest/format';
import type { RunBarsState } from './useRunSeries';

/** 逐bar评分表**页内**分页大小（ADR §13.4：全量数据 UI 分页渲染，不一次渲染几十万行 DOM）。 */
export const PERBAR_PAGE_SIZE = 100;

const SIGNAL_CLS: Record<string, string> = {
  Buy: 'text-up',
  Sell: 'text-down',
  Hold: 'text-dim',
};

/** `datetime-local` 值（`YYYY-MM-DDTHH:mm`）→ RFC3339（后端 `/bars` `from`/`to` 口径）。 */
function toRfc3339(local: string): string | null {
  if (!local) return null;
  const ms = Date.parse(local);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * 逐 bar 评分表（ADR §13.5 Tab）：ts / 各 slot 分（错误 bar 标 ⚠）/ 聚合分 / 信号 / 订单数。
 *
 * ADR-024 P6 / D9：数据来自 `GET …/bars?kind=per_bar&offset&limit`（**分页加载**）；
 * `has_more`/`next_offset` **必须被消费** —— 表头恒显「已加载 N / 共 M」并提供「加载更多」，
 * **禁止静默只显首页**。区间跳读复用 `/bars` 的 `from&to`（服务端在块内按 ts 精确过滤）。
 * 表为明细查证面：**不抽样**（抽样只作用于图表曲线）。
 */
export function PerBarTable({
  bars,
  slotCount,
  onLoadMore,
  onJumpRange,
  onResetRange,
}: {
  bars: RunBarsState;
  slotCount: number;
  onLoadMore: () => void;
  onJumpRange: (fromIso: string, toIso: string) => void;
  onResetRange: () => void;
}) {
  const perBar: WorkbenchBarRecord[] = bars.rows;
  const [page, setPage] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const pageCount = Math.max(1, Math.ceil(perBar.length / PERBAR_PAGE_SIZE));
  const cur = Math.min(page, pageCount - 1);
  const rows = useMemo(
    () => perBar.slice(cur * PERBAR_PAGE_SIZE, (cur + 1) * PERBAR_PAGE_SIZE),
    [perBar, cur],
  );
  // 加载更多/区间跳读后行数变化 ⇒ 页码复位到首页（避免落在门外页）。
  useEffect(() => setPage(0), [bars.range, perBar.length]);

  const unloaded = Math.max(0, bars.total - perBar.length);
  const jump = () => {
    const f = toRfc3339(from);
    const t = toRfc3339(to);
    if (!f || !t) return;
    onJumpRange(f, t);
  };

  return (
    <div data-testid="wb-perbar-table">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-dim">
        <span data-testid="wb-perbar-coverage">
          共 {bars.total} bar · 已加载 <span data-testid="wb-perbar-loaded">{perBar.length}</span> 根 · 第{' '}
          <span data-testid="wb-perbar-page-info">{cur + 1} / {pageCount}</span> 页
        </span>
        <span className="flex items-center gap-1">
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

      {/* 未加载余量**显式**提示 + 加载入口（D9：禁止静默截断） */}
      {bars.hasMore && (
        <div className="mb-1 flex items-center gap-2 text-[10px]" data-testid="wb-perbar-more-note">
          <span className="text-acc1">
            还有更多：已加载 {perBar.length} / 共 {bars.total} 根（未加载 {unloaded} 根）
          </span>
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 text-dim hover:text-txt disabled:opacity-40"
            disabled={bars.loadingMore}
            onClick={onLoadMore}
            data-testid="wb-perbar-load-more"
          >
            {bars.loadingMore ? '加载中…' : `加载更多（+${Math.min(unloaded, 5000)} 根）`}
          </button>
        </div>
      )}

      {/* 区间跳读（复用 /bars 的 from&to；服务端在块内按 ts 过滤） */}
      <div className="mb-1 flex flex-wrap items-center gap-1 text-[10px] text-dim" data-testid="wb-perbar-range-jump">
        <span>区间跳读</span>
        <input
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded border border-line bg-panel px-1 py-0.5"
          data-testid="wb-perbar-range-from"
        />
        <span>~</span>
        <input
          type="datetime-local"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded border border-line bg-panel px-1 py-0.5"
          data-testid="wb-perbar-range-to"
        />
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-dim hover:text-txt disabled:opacity-40"
          disabled={!from || !to || bars.loading}
          onClick={jump}
          data-testid="wb-perbar-range-go"
        >
          跳转
        </button>
        {bars.range && (
          <span data-testid="wb-perbar-range-info">
            区间 {bars.range.from} ~ {bars.range.to} 内 {bars.range.count} 根
            <button
              type="button"
              className="ml-2 rounded border border-line px-2 py-0.5 text-dim hover:text-txt"
              onClick={onResetRange}
              data-testid="wb-perbar-range-reset"
            >
              复位（回到分页）
            </button>
          </span>
        )}
      </div>

      {bars.error && (
        <div className="mb-1 text-[10px] text-up" data-testid="wb-perbar-error">
          逐bar明细加载失败：{bars.error}
        </div>
      )}
      {bars.loading && <div className="mb-1 text-[10px] text-dim" data-testid="wb-perbar-loading">加载中…</div>}

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
