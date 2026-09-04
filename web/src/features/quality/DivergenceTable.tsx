import type { QualityDivergenceResponse } from '@/api/types';
import { metaOf } from '@/features/sources/sourceMeta';
import { cn } from '@/lib/utils';
import { cstMdHm, devPct, price3, ratePct } from './format';
import type { AsyncSlice } from './store';

/** 区域错误条（三态共用样式：错误占位 + 重试） */
export function RegionError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 p-3 text-xs text-up">
      <span>加载失败：{error}</span>
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

/**
 * divergence-table（04-quality §2 主视图）：时刻/raw收盘/accurate收盘/偏差%/raw来源；
 * 后端已按 |偏差| 降序（rows 顺序透传）；汇总行=比对总数/一致率（≤0.5% 计一致）/最大偏差；
 * 三态=骨架行/「该范围无比对数据」（accurate 未同步常见）/错误条+重试；点行跳行情看板。
 */
export function DivergenceTable({
  slice,
  onJump,
  onRetry,
}: {
  slice: AsyncSlice<QualityDivergenceResponse>;
  onJump: (ts: string) => void;
  onRetry: () => void;
}) {
  if (slice.error) return <RegionError error={slice.error} onRetry={onRetry} />;
  if (slice.loading || slice.data === null) {
    return (
      <div className="space-y-2 p-3" data-testid="divergence-skeleton">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded-lg bg-panel2" />
        ))}
      </div>
    );
  }
  const { rows, summary, threshold_pct } = slice.data;
  if (rows.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-dim">
        该范围无比对数据（accurate 未同步时常见，可在下方 sync-panel 查看同步状态）
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {['时刻', 'raw 收盘', 'accurate 收盘', '偏差%', 'raw 来源'].map((h) => (
                <th
                  key={h}
                  className="border-b border-line px-3.5 py-2.5 text-left text-xs font-medium tracking-wide text-dim"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-testid="divergence-rows">
            {rows.map((r) => {
              const divergent = Math.abs(r.deviation_pct) > threshold_pct;
              return (
                <tr
                  key={r.ts}
                  onClick={() => onJump(r.ts)}
                  className="cursor-pointer hover:bg-white/[.03]"
                  title="点击跳行情看板对应时刻"
                >
                  <td className="num border-b border-line px-3.5 py-2">{cstMdHm(r.ts)}</td>
                  <td className="num border-b border-line px-3.5 py-2">{price3(r.raw_close)}</td>
                  <td className="num border-b border-line px-3.5 py-2">{price3(r.accurate_close)}</td>
                  <td
                    className={cn(
                      'num border-b border-line px-3.5 py-2',
                      divergent ? 'text-up' : 'text-down',
                    )}
                  >
                    {devPct(r.deviation_pct)}
                  </td>
                  <td className="border-b border-line px-3.5 py-2 text-dim">
                    {r.raw_source ? metaOf(r.raw_source).label : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* 汇总行 H=40（04-quality L1） */}
      <div data-testid="divergence-summary" className="flex h-10 items-center gap-6 border-t border-line bg-acc1/[.06] px-3.5 text-xs font-semibold">
        <span>
          汇总：比对 <span className="num">{summary.compared_bars}</span> bar
        </span>
        <span>
          一致率 <span className="num text-down">{ratePct(summary.consistency_rate)}</span>
          <span className="font-normal text-dim">（≤{threshold_pct}% 计一致）</span>
        </span>
        <span>
          最大偏差 <span className="num text-up">{devPct(summary.max_deviation_pct)}</span>
        </span>
      </div>
    </div>
  );
}
