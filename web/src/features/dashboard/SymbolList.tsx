import { useState, useRef } from 'react';
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
  /** 星标切换（收藏=true → unstar；非收藏 → star）。返回 Promise 以便乐观更新失败可提示。 */
  onToggleFavorite(code: string): Promise<void>;
  /** 收藏区拖拽重排（codes 顺序即新展示顺序）。 */
  onReorderFavorites(codes: string[]): Promise<void>;
}

function fmtPct(p: number): string {
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

/** 收藏优先分区：收藏（favoriteSort 升序）在前，非收藏稳定保持原序在后。 */
function partition(symbols: SymbolSnapshot[]): { favorites: SymbolSnapshot[]; rest: SymbolSnapshot[] } {
  const favorites = symbols
    .filter((s) => s.favorite === true)
    .sort((a, b) => (a.favoriteSort ?? 0) - (b.favoriteSort ?? 0));
  const rest = symbols.filter((s) => s.favorite !== true);
  return { favorites, rest };
}

/** symbol-list 区域：搜索过滤 + code/名称/最新价/涨跌幅；三态=骨架行/引导链/错误条+重试。
 *  看板收藏（Wave 3 页面①）：收藏区置顶（favoriteSort 升序）+ 星标切换 + 收藏区拖拽重排。
 *  拖拽与点击选股冲突：凭 drag handle（⠿，仅收藏行）作为拖拽起点，拖拽不触发行点击。 */
export function SymbolList({
  symbols,
  status,
  selected,
  search,
  onSearchChange,
  onSelect,
  onRetry,
  onToggleFavorite,
  onReorderFavorites,
}: SymbolListProps) {
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [overCode, setOverCode] = useState<string | null>(null);
  const dragCode = useRef<string | null>(null);

  const { favorites, rest } = partition(symbols);

  function handleToggle(code: string) {
    setFavoriteError(null);
    void onToggleFavorite(code).catch(() => setFavoriteError('收藏操作未生效，已回滚'));
  }

  function handleDragStart(e: React.DragEvent, code: string) {
    dragCode.current = code;
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', code);
    } catch {
      // jsdom/无 DataTransfer 环境容错（拖拽源以 dragCode ref 为主）
    }
  }

  function handleDragOver(e: React.DragEvent, code: string) {
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'move';
    } catch {
      // 忽略
    }
    setOverCode(code);
  }

  function handleDrop(e: React.DragEvent, targetCode: string) {
    e.preventDefault();
    const source = dragCode.current ?? (e.dataTransfer?.getData?.('text/plain') ?? '');
    dragCode.current = null;
    setOverCode(null);
    if (!source || source === targetCode) return;
    const favCodes = favorites.map((s) => s.code);
    const from = favCodes.indexOf(source);
    const to = favCodes.indexOf(targetCode);
    if (from < 0 || to < 0) return;
    const next = [...favCodes];
    next.splice(from, 1);
    next.splice(to, 0, source);
    setFavoriteError(null);
    void onReorderFavorites(next).catch(() => setFavoriteError('排序未能保存，已回滚'));
  }

  function handleDragEnd() {
    dragCode.current = null;
    setOverCode(null);
  }

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
        {status === 'ready' && symbols.length > 0 && (
          <>
            {favoriteError && (
              <p className="mb-1.5 rounded-[8px] border border-down/40 bg-down/10 p-2 text-xs text-down">
                {favoriteError}
              </p>
            )}
            {favorites.length > 0 && (
              <p className="mb-1 px-1 text-[11px] font-medium text-amber-400/80">★ 已收藏</p>
            )}
            {favorites.map((s) => (
              <button
                key={s.code}
                type="button"
                data-selected={s.code === selected}
                data-fav="true"
                onClick={() => onSelect(s.code)}
                onDragOver={(e) => handleDragOver(e, s.code)}
                onDrop={(e) => handleDrop(e, s.code)}
                className={cn(
                  'mb-1 flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left hover:bg-white/5',
                  s.code === selected && 'bg-acc1/10 outline outline-1 outline-acc1/40',
                  !s.enabled && 'opacity-50',
                  overCode === s.code && 'outline outline-1 outline-amber-400/60',
                )}
              >
                <span
                  data-handle={s.code}
                  draggable
                  onDragStart={(e) => handleDragStart(e, s.code)}
                  onDragEnd={handleDragEnd}
                  aria-hidden
                  className="cursor-grab select-none text-sm leading-none text-dim"
                >
                  ⠿
                </span>
                <span
                  role="button"
                  data-star={s.code}
                  aria-label={`取消收藏 ${s.code}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleToggle(s.code);
                  }}
                  className="cursor-pointer text-sm leading-none text-amber-400"
                >
                  ★
                </span>
                <span className="flex-1">
                  <b className="num block text-[13px] font-semibold">{s.code}</b>
                  <small className="block text-[11px] text-dim">{s.name}</small>
                </span>
                <RowPrice s={s} />
              </button>
            ))}
            {rest.map((s) => (
              <button
                key={s.code}
                type="button"
                data-selected={s.code === selected}
                onClick={() => onSelect(s.code)}
                className={cn(
                  'mb-1 flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left hover:bg-white/5',
                  s.code === selected && 'bg-acc1/10 outline outline-1 outline-acc1/40',
                  !s.enabled && 'opacity-50',
                )}
              >
                <span
                  role="button"
                  data-star={s.code}
                  aria-label={`收藏 ${s.code}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleToggle(s.code);
                  }}
                  className="cursor-pointer text-sm leading-none text-dim"
                >
                  ☆
                </span>
                <span className="flex-1">
                  <b className="num block text-[13px] font-semibold">{s.code}</b>
                  <small className="block text-[11px] text-dim">{s.name}</small>
                </span>
                <RowPrice s={s} />
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** 行右侧价格/涨跌幅（D2：停用/无数据不显示伪造 0.000） */
function RowPrice({ s }: { s: SymbolSnapshot }) {
  const inactive = !s.enabled;
  const hasData = s.enabled && s.last !== null;
  return (
    <span className="shrink-0 text-right text-xs">
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
  );
}
