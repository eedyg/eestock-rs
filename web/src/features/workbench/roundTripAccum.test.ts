/**
 * ADR-027 D9/§2.10 —— L2 累计派生与逐回合对账的**纯函数**判据（UI 之外的公式锁定）。
 * 与 `roundTripLayers.test.tsx`（渲染层 F1–F5）互补：此处直接断言数值口径与 Δ。
 */
import { describe, it, expect } from 'vitest';
import type { RoundTrip, RoundTripFill } from '@/api/types';
import { accumulateL2, fmtNum, reconcileRoundTrip } from './roundTripAccum';

const DAY = 86_400;
const T0 = 1_767_225_600;
const f = (o: Partial<RoundTripFill>): RoundTripFill => ({
  rt_seq: 1, code: '518880', bar_index: 1, ts: T0, side: 'Buy', qty: 100, price: 10,
  trade_value: 1000, commission: 5, stamp_duty: 0, reason: 'Policy', ...o,
});
/** 买 100@10（费 5）→ 买 100@10.2（费 5）→ 卖 200@10.5（费 5.25 / 印花 1.05）。 */
const FILLS: RoundTripFill[] = [
  f({ bar_index: 1 }),
  f({ bar_index: 2, ts: T0 + DAY, price: 10.2, trade_value: 1020 }),
  f({ bar_index: 3, ts: T0 + 2 * DAY, side: 'Sell', qty: 200, price: 10.5, trade_value: 2100, commission: 5.25, stamp_duty: 1.05 }),
];
const RT: RoundTrip = {
  rt_seq: 1, code: '518880', status: 'Closed', open_ts: T0, close_ts: T0 + 2 * DAY, open_bar: 1, close_bar: 3,
  shares: 200, buy_count: 2, sell_count: 1, open_price: 10.1, close_price: 10.5,
  gross_value: 2100, commission: 15.25, stamp_duty: 1.05, pnl: 63.7, hold_bars: 2, reason: 'Policy', l2_count: 3,
};

describe('roundTripAccum（ADR-027 D9 双口径 + cum_ 累计）', () => {
  it('逐笔累计：不含费均价按侧累计、含费均价按侧净额、cum_ 与 L1 同序同值', () => {
    const acc = accumulateL2(FILLS);
    expect(acc).toHaveLength(3);
    // 第 1 笔（买 100@10）：10.000 / (1000+5)/100 = 10.050
    expect(acc[0]!.avg_price_excl_fee).toBeCloseTo(10, 10);
    expect(acc[0]!.avg_cost_incl_fee).toBeCloseTo(10.05, 10);
    // 第 2 笔（买 100@10.2）：2020/200 = 10.100 / (2020+10)/200 = 10.150
    expect(acc[1]!.avg_price_excl_fee).toBeCloseTo(10.1, 10);
    expect(acc[1]!.avg_cost_incl_fee).toBeCloseTo(10.15, 10);
    // 第 3 笔（卖 200@10.5）：卖均价 10.500 / 卖出净额 (2100−5.25−1.05)/200
    expect(acc[2]!.avg_price_excl_fee).toBeCloseTo(10.5, 10);
    expect(acc[2]!.avg_cost_incl_fee).toBeCloseTo((2100 - 5.25 - 1.05) / 200, 10);
    // cum_ 末行 == L1（本用例的 L1 为手写常量 ⇒ 用 1e-10 容差；真实链路两侧同序累加 ⇒ 浮点逐位相等，
    // 由 `roundTripLayers.test.tsx` F5 的**字符串相等**断言锁定）
    expect(acc[2]!.cum_commission).toBe(RT.commission);
    expect(acc[2]!.cum_stamp_duty).toBe(RT.stamp_duty);
    expect(acc[2]!.cum_realized_pnl).toBeCloseTo(RT.pnl!, 10);
  });

  it('对账：一致 ⇒ ok；注入 L1 偏差 ⇒ 逐字段 Δ 与 mismatched 判定（容差相对口径）', () => {
    expect(reconcileRoundTrip(RT, FILLS, { tolerance: 1e-6 }).ok).toBe(true);
    const bad = reconcileRoundTrip({ ...RT, commission: 99 }, FILLS, { tolerance: 1e-6 });
    expect(bad.ok).toBe(false);
    const comm = bad.fields.find((x) => x.key === 'commission')!;
    expect(comm.l1).toBe(99);
    expect(comm.l2).toBe(15.25);
    expect(comm.delta).toBeCloseTo(15.25 - 99, 10);
    expect(comm.mismatched).toBe(true);
    // 未超容差的字段不得误报
    expect(bad.fields.find((x) => x.key === 'stamp_duty')!.mismatched).toBe(false);
  });

  it('对账：显式拉取不全（行数 < l2_count）⇒ l2_count 字段告警，不静默按 L1 渲染', () => {
    const partial = reconcileRoundTrip(RT, FILLS.slice(0, 2), { tolerance: 1e-6 });
    expect(partial.ok).toBe(false);
    expect(partial.fields.find((x) => x.key === 'l2_count')!.mismatched).toBe(true);
  });

  it('对账：后端 audit mismatched 命中该 rt_seq ⇒ 即使本页相加一致也必须告警（D10）', () => {
    const r = reconcileRoundTrip(RT, FILLS, { tolerance: 1e-6, auditMismatch: true });
    expect(r.ok).toBe(false);
    expect(r.auditMismatch).toBe(true);
    expect(r.fields.every((x) => !x.mismatched)).toBe(true); // 两侧数值一致，但结论仍为「不一致」
  });

  it('展示口径：money/int/price 三种精度（L1 与 L2 共用 ⇒ 字符串可比）', () => {
    expect(fmtNum(15.25)).toBe('15.25');
    expect(fmtNum(10.469)).toBe('10.47');
    expect(fmtNum(10.469, 'price')).toBe('10.469');
    expect(fmtNum(3, 'int')).toBe('3');
    expect(fmtNum(null)).toBe('—');
  });
});
