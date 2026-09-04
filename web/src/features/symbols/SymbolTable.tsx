import type { SymbolRow } from '@/api/types';
import { cn } from '@/lib/utils';

/** UTC ts → 北京时间 HH:MM:SS（Asia/Shanghai 固定 +8，与 domain::tz 同口径） */
export function cstTimeHHMMSS(ts: string): string {
  return new Date(Date.parse(ts) + 8 * 3600_000).toISOString().slice(11, 19);
}

/**
 * 标的表格（03-symbols §2）：code/名称/抓取间隔/启用/今日已采 bar/最新 bar 时刻/操作。
 * 停用行置灰；操作列 编辑 + 停用/启用（仅停用，无物理删除入口，§4）。
 */
export function SymbolTable({
  rows,
  loading,
  toggling,
  onOpenEdit,
  onToggleEnabled,
  onOpenRegister,
}: {
  rows: SymbolRow[] | null;
  loading: boolean;
  toggling: Record<string, boolean>;
  onOpenEdit(code: string): void;
  onToggleEnabled(code: string, enabled: boolean): void;
  onOpenRegister(): void;
}) {
  if (loading) {
    return (
      <div className="p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="mb-2 h-11 animate-pulse rounded bg-panel2" />
        ))}
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-dim">
        <span>未注册标的</span>
        <button
          type="button"
          onClick={onOpenRegister}
          className="rounded-lg bg-gradient-to-br from-acc1 to-acc2 px-3 py-1 text-white"
        >
          + 注册标的
        </button>
      </div>
    );
  }
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-left text-xs text-dim">
          <th className="border-b border-line px-3.5 py-2.5 font-medium">code</th>
          <th className="border-b border-line px-3.5 py-2.5 font-medium">名称</th>
          <th className="border-b border-line px-3.5 py-2.5 font-medium">抓取间隔</th>
          <th className="border-b border-line px-3.5 py-2.5 font-medium">启用</th>
          <th className="border-b border-line px-3.5 py-2.5 font-medium">今日已采 bar</th>
          <th className="border-b border-line px-3.5 py-2.5 font-medium">最新 bar 时刻</th>
          <th className="border-b border-line px-3.5 py-2.5 font-medium">操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code} className={cn('hover:bg-white/5', !r.enabled && 'opacity-45')}>
            <td className="num border-b border-line px-3.5 py-2.5">{r.code}</td>
            <td className="border-b border-line px-3.5 py-2.5">{r.name ?? '—'}</td>
            <td className="num border-b border-line px-3.5 py-2.5">{r.interval_secs}s</td>
            <td className="border-b border-line px-3.5 py-2.5">
              <span
                role="switch"
                aria-checked={r.enabled}
                aria-label={`${r.code} 启用状态`}
                className={cn(
                  'relative inline-block h-[18px] w-8 rounded-full border align-middle',
                  r.enabled ? 'border-down/50 bg-down/25' : 'border-line bg-white/5',
                )}
              >
                <span
                  className={cn(
                    'absolute top-[2px] h-3 w-3 rounded-full',
                    r.enabled ? 'right-[2px] bg-down' : 'left-[2px] bg-dim',
                  )}
                />
              </span>
            </td>
            <td className="num border-b border-line px-3.5 py-2.5">
              {r.today_bars ? r.today_bars : '—'}
            </td>
            <td className="num border-b border-line px-3.5 py-2.5">
              {r.latest ? cstTimeHHMMSS(r.latest.ts) : '—'}
            </td>
            <td className="border-b border-line px-3.5 py-2.5">
              <button
                type="button"
                onClick={() => onOpenEdit(r.code)}
                className="mr-2 rounded-lg border border-line px-3 py-0.5 text-xs text-dim hover:text-txt"
              >
                编辑
              </button>
              {r.enabled ? (
                <button
                  type="button"
                  disabled={toggling[r.code]}
                  onClick={() => onToggleEnabled(r.code, false)}
                  className="rounded-lg border border-up/40 px-3 py-0.5 text-xs text-up hover:bg-up/10 disabled:opacity-50"
                >
                  停用
                </button>
              ) : (
                <button
                  type="button"
                  disabled={toggling[r.code]}
                  onClick={() => onToggleEnabled(r.code, true)}
                  className="rounded-lg border border-line px-3 py-0.5 text-xs text-dim hover:text-txt disabled:opacity-50"
                >
                  启用
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
