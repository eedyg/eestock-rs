import type { SymbolSnapshot } from '@/api/types';
import type { QualityView } from '@/layouts/QualityGrid';
import type { AsyncSlice, QualityRange } from './store';
import { cn } from '@/lib/utils';

const sel = 'h-[30px] rounded-lg border border-line bg-panel2 px-2 text-xs text-dim outline-none';

/**
 * filter-bar H=48（04-quality L2：标的 + 日期范围 + 视图切换；静态控件无三态；变更即重查）。
 */
export function QualityFilterBar({
  symbols,
  code,
  range,
  view,
  onFilterChange,
  onViewChange,
}: {
  symbols: AsyncSlice<SymbolSnapshot[]>;
  code: string | null;
  range: QualityRange;
  view: QualityView;
  onFilterChange: (code: string | null, range: QualityRange) => void;
  onViewChange: (v: QualityView) => void;
}) {
  const list = symbols.data ?? [];
  return (
    <>
      <select
        aria-label="标的"
        className={cn(sel, 'num')}
        value={code ?? ''}
        onChange={(e) => onFilterChange(e.target.value || null, range)}
      >
        {list.length === 0 && <option value="">标的：加载中…</option>}
        {list.map((s) => (
          <option key={s.code} value={s.code}>
            {s.code} {s.name}
          </option>
        ))}
      </select>
      <input
        aria-label="开始日期"
        type="date"
        className={cn(sel, 'num')}
        value={range.from}
        onChange={(e) => e.target.value && onFilterChange(code, { ...range, from: e.target.value })}
      />
      <span className="text-xs text-dim">~</span>
      <input
        aria-label="结束日期"
        type="date"
        className={cn(sel, 'num')}
        value={range.to}
        onChange={(e) => e.target.value && onFilterChange(code, { ...range, to: e.target.value })}
      />
      <span className="flex-1" />
      {(['table', 'overlay'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onViewChange(v)}
          className={cn(
            'rounded-lg px-3 py-1 text-xs',
            view === v
              ? 'bg-gradient-to-br from-acc1 to-acc2 text-white shadow-[0_2px_10px_rgba(56,189,248,.35)]'
              : 'border border-line text-dim hover:text-txt',
          )}
        >
          {v === 'table' ? '分歧表' : '叠加图'}
        </button>
      ))}
    </>
  );
}
