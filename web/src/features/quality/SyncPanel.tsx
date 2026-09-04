import type { TushareStatusResponse } from '@/api/types';
import { cstMdHm } from './format';
import { RegionError } from './DivergenceTable';
import type { AsyncSlice } from './store';

/**
 * sync-panel（04-quality §4）：tushare 最近同步状态（时刻/覆盖标的/最近事件/剩余积分）。
 * 剩余积分 quota_remaining 恒 null（积分余额未入库，07-app-plane §1.1）→ 渲染 —。
 * 手动同步按钮置灰（wave-2.md 边界：POST /api/tushare/sync 留后续 Phase 单开工单，tooltip「下阶段开放」）。
 */
export function SyncPanel({
  slice,
  onRetry,
}: {
  slice: AsyncSlice<TushareStatusResponse>;
  onRetry: () => void;
}) {
  if (slice.error) return <RegionError error={slice.error} onRetry={onRetry} />;
  if (slice.loading || slice.data === null) {
    return <div className="h-24 animate-pulse rounded-xl bg-panel2" />;
  }
  const s = slice.data;
  const neverSynced = s.checkpoints.length === 0 && s.last_updated_at == null;
  return (
    <div className="text-xs text-dim">
      {neverSynced ? (
        <div className="py-4 text-center">从未同步（等待数据面三时点轮自动同步）</div>
      ) : (
        <div className="border-b border-line py-1">
          最近同步 <span className="num text-txt">{s.last_updated_at ? cstMdHm(s.last_updated_at) : '—'}</span>
          {' · '}覆盖 <span className="num text-txt">{s.covered_codes}</span> 只
          {' · '}最近事件{' '}
          {s.last_event ? (
            s.last_event.ok ? (
              <span className="text-down">成功 {cstMdHm(s.last_event.ts)}</span>
            ) : (
              <span className="text-up">失败 {cstMdHm(s.last_event.ts)}（{s.last_event.err_kind ?? 'unknown'}）</span>
            )
          ) : (
            <span>—</span>
          )}
        </div>
      )}
      <div className="mt-2">
        剩余积分{' '}
        <span className="num inline-block rounded-[10px] border border-[#fbbf24]/40 bg-[#fbbf24]/10 px-3.5 py-1 text-[13px] text-[#fbbf24]">
          {s.quota_remaining ?? '—'}
        </span>
        <span className="ml-2">（quota 硬约束；积分余额未入库）</span>
      </div>
      <div className="mt-2.5">
        {/* Wave 2 边界：POST /api/tushare/sync 暂缓（父级裁决 2026-09-04），按钮置灰 */}
        <button
          type="button"
          disabled
          title="下阶段开放"
          className="rounded-lg border border-line px-3 py-1 text-dim opacity-50 cursor-not-allowed"
        >
          手动同步
        </button>
        <span className="ml-2">手动补拉 accurate 下阶段开放（wave-2.md 边界）</span>
      </div>
    </div>
  );
}
