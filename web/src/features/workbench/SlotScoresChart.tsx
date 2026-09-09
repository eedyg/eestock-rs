import { useMemo, useState } from 'react';
import type { StrategyCatalogEntry, WorkbenchBarRecord, WorkbenchPinnedSlot } from '@/api/types';
import { downsample } from './chartUtils';

const W = 1000;
const H = 160;
const PAD = 8;
const COLORS = ['#a78bfa', '#fbbf24', '#34d399', '#fb923c', '#f472b6', '#818cf8', '#22d3ee', '#e879f9', '#4ade80', '#f87171'];

/** 图例默认可见条数（ADR §13.5：图例开关，默认前 3）。 */
export const DEFAULT_VISIBLE_SLOTS = 3;

/** slot 显示名：catalog 命中 → 「策略名 vN」；缺失（版本后被归档等）→ id 兜底。 */
function slotLabel(slot: WorkbenchPinnedSlot, catalog: StrategyCatalogEntry[] | null): string {
  const hit = (catalog ?? []).find((e) => e.strategy.id === slot.strategy_id);
  return `${hit?.strategy.name ?? slot.strategy_id} v${slot.version}`;
}

/** slots 身份键（version_id 序列）：run 切换时 reconcile visible 状态。 */
function slotsKeyOf(slots: WorkbenchPinnedSlot[]): string {
  return slots.map((s) => s.version_id).join('|');
}

function defaultVisible(slots: WorkbenchPinnedSlot[]): Record<number, boolean> {
  return Object.fromEntries(slots.map((_, i) => [i, i < DEFAULT_VISIBLE_SLOTS]));
}

/**
 * 各策略评分曲线（ADR §13.5）：每 slot 一条 0-100 折线（同色板循环），图例 checkbox 开关，
 * 默认前 3 条可见。熔断 slot 的 bar 无评分（scores 缺失）→ 断线跳过（与试算 ScoreChart 同口径）。
 * MINOR-1：slots 变化（切 run）时渲染期 reconcile visible（React「render 期间调整 state」模式），
 * 「默认前 3」按新 run 重新生效，勾选态不跨 run 泄漏。
 */
export function SlotScoresChart({
  perBar,
  slots,
  catalog,
}: {
  perBar: WorkbenchBarRecord[];
  slots: WorkbenchPinnedSlot[];
  catalog: StrategyCatalogEntry[] | null;
}) {
  const [visible, setVisible] = useState<Record<number, boolean>>(() => defaultVisible(slots));
  const [slotsKey, setSlotsKey] = useState(() => slotsKeyOf(slots));
  const nextKey = slotsKeyOf(slots);
  if (nextKey !== slotsKey) {
    // 渲染期 reconcile（https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes）
    setSlotsKey(nextKey);
    setVisible(defaultVisible(slots));
  }
  const pts = useMemo(() => downsample(perBar), [perBar]);
  const y = (s: number) => PAD + (1 - s / 100) * (H - 2 * PAD);
  const x = (i: number) => (pts.length <= 1 ? W / 2 : (i / (pts.length - 1)) * (W - 2 * PAD) + PAD);

  // 每 slot 折线分段（null 断线：该 bar 无此 slot 评分）
  const series = useMemo(
    () =>
      slots.map((_, slotIdx) => {
        const segs: string[] = [];
        let cur: string[] = [];
        pts.forEach((rec, i) => {
          const sc = rec.scores.find((s) => s.slot_idx === slotIdx);
          if (!sc) {
            if (cur.length > 0) segs.push(cur.join(' '));
            cur = [];
          } else {
            cur.push(`${x(i).toFixed(1)},${y(sc.score).toFixed(1)}`);
          }
        });
        if (cur.length > 0) segs.push(cur.join(' '));
        return segs;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pts, slots],
  );

  return (
    <div className="rounded-lg border border-line bg-panel2 p-1" data-testid="wb-slot-chart">
      <div className="flex flex-wrap gap-2 px-1 pb-1">
        {slots.map((slot, i) => (
          <label key={i} className="flex items-center gap-1 text-[10px]" style={{ color: COLORS[i % COLORS.length] }}>
            <input
              type="checkbox"
              checked={visible[i] ?? false}
              onChange={() => setVisible((v) => ({ ...v, [i]: !(v[i] ?? false) }))}
              data-testid={`legend-slot-${i}`}
            />
            {slotLabel(slot, catalog)}（权重 {slot.weight}）
          </label>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" preserveAspectRatio="none" role="img" aria-label="各策略评分曲线">
        {series.map((segs, i) =>
          (visible[i] ?? false)
            ? segs.map((points, j) => (
                <polyline key={`${i}-${j}`} points={points} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="1" />
              ))
            : null,
        )}
      </svg>
      <div className="px-1 text-[10px] text-dim">各策略评分 0-100（图例开关，默认前 {DEFAULT_VISIBLE_SLOTS} 条）</div>
    </div>
  );
}
