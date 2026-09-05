import { Link } from 'react-router-dom';
import type { SymbolSnapshot } from '@/api/types';
import type { SymbolsStatus } from './store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SymbolListProps {
  symbols: SymbolSnapshot[];
  status: SymbolsStatus;
  selected: string | null;
  search: string;
  onSearchChange(q: string): void;
  onSelect(code: string): void;
  onRetry(): void;
}

function fmtPct(p: number): string {
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

/** symbol-list 区域：搜索过滤 + code/名称/最新价/涨跌幅；三态=骨架行/引导链/错误条+重试 */
export function SymbolList({
  symbols,
  status,
  selected,
  search,
  onSearchChange,
  onSelect,
  onRetry,
}: SymbolListProps) {
  return (
    <div className="flex h-full flex-col p-3">
      <input
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="⌕ 搜索 code / 名称…"
        className="mb-2.5 h-8 shrink-0 rounded-[10px] border border-line bg-panel2 px-3 text-xs text-txt outline-none placeholder:text-dim focus:border-acc1/50"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === 'loading' && (
          <div data-testid="symbol-list-skeleton" className="space-y-1.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-[10px] bg-white/5" />
            ))}
          </div>
        )}
        {status === 'error' && (
          <div className="rounded-[10px] border border-up/40 bg-up/10 p-3 text-xs">
            <p className="mb-2 text-up">标的列表加载失败</p>
            <Button onClick={onRetry}>重试</Button>
          </div>
        )}
        {status === 'ready' && symbols.length === 0 && (
          <p className="p-3 text-xs text-dim">
            {search ? (
              '无匹配标的'
            ) : (
              <>
                未注册标的，
                <Link to="/symbols" className="text-acc1 underline">
                  去标的管理
                </Link>
              </>
            )}
          </p>
        )}
        {status === 'ready' &&
          symbols.map((s) => {
            // D2：停用/无数据标的不显示伪造的 0.000
            const inactive = !s.enabled;
            const hasData = s.enabled && s.last !== null;
            return (
              <button
                key={s.code}
                type="button"
                data-selected={s.code === selected}
                onClick={() => onSelect(s.code)}
                className={cn(
                  'mb-1 flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left hover:bg-white/5',
                  s.code === selected && 'bg-acc1/10 outline outline-1 outline-acc1/40',
                  inactive && 'opacity-50',
                )}
              >
                <span>
                  <b className="num block text-[13px] font-semibold">{s.code}</b>
                  <small className="block text-[11px] text-dim">{s.name}</small>
                </span>
                <span className="text-right text-xs">
                  {hasData ? (
                    <>
                      <span className={cn('num block', s.changePct >= 0 ? 'text-up' : 'text-down')}>
                        {s.last!.toFixed(3)}
                      </span>
                      <span className={cn('num block', s.changePct >= 0 ? 'text-up' : 'text-down')}>
                        {fmtPct(s.changePct)}
                      </span>
                    </>
                  ) : (
                    <span className="block text-dim">{inactive ? '已停用' : '无数据'}</span>
                  )}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
