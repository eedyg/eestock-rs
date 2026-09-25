/**
 * ADR-027 D9/§2.10 —— L2 累计派生与逐回合对账的**纯函数**判据（UI 之外的公式锁定）。
 * 与 `roundTripLayers.test.tsx`（渲染层 F1–F5）互补：此处直接断言数值口径与 Δ。
 */
import { describe, it, expect } from 'vitest';
import type { RoundTrip, RoundTripFill } from '@/api/types';
import { accumulateL2, fmtNum, fmtSellPnl, reconcileRoundTrip } from './roundTripAccum';

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
    // D12 命名消歧后：净现金流末行（对账锚点）**与**全平回合的累计已实现盈亏（I5）都 == L1 pnl
    expect(acc[2]!.cum_cashflow).toBeCloseTo(RT.pnl!, 10);
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

// ─────────────────────────────────────────────────────────────────────────────
// D12（2026-09-25 架构侧裁定；判据 SSOT = `design/17-trade-detail-layering/09-plan-result-axis-readout-and-l2-cost-attribution.md` §4
//      + ADR-027 §2.14）：L2 成本归属派生列 = **移动加权平均成本（含费）**。
//
// 手工向量（事实字段全部手给，禁复算费用）：
//   ① 买 100@10.00（费 5）   ② 买 200@10.50（费 5）   ③ 卖 100@11.00（费 5 / 印花 1.10）
//   ④ 买 100@10.20（费 5）   ⑤ 卖 300@11.50（费 5 / 印花 3.45）
//   cost_total（含费成本池）：1005 → 3110 → 2073.3333… → 3098.3333… → 0
//   qty：100 → 300 → 200 → 300 → 0
//   持仓成本 unit_cost：10.05 → 10.36666… → 10.36666…（**部分卖出后不变**）→ 10.32777… → null
//   本笔卖出盈亏：③ = 1093.90 − 1036.6666… = 57.2333…（+5.52%）；⑤ = 3441.55 − 3098.3333… = 343.2166…（+11.08%）
//   累计已实现盈亏：0 → 0 → 57.2333… → 57.2333… → 400.45（= L1 pnl，I5）
//   累计净现金流：−1005 → −3110 → −2016.10 → −3041.10 → +400.45（= L1 pnl）
// ─────────────────────────────────────────────────────────────────────────────

const F1 = f({ bar_index: 1, qty: 100, price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 });
const F2 = f({ bar_index: 2, ts: T0 + DAY, qty: 200, price: 10.5, trade_value: 2100, commission: 5, stamp_duty: 0 });
const F3 = f({ bar_index: 3, ts: T0 + 2 * DAY, side: 'Sell', qty: 100, price: 11, trade_value: 1100, commission: 5, stamp_duty: 1.1 });
const F4 = f({ bar_index: 4, ts: T0 + 3 * DAY, qty: 100, price: 10.2, trade_value: 1020, commission: 5, stamp_duty: 0 });
const F5 = f({ bar_index: 5, ts: T0 + 4 * DAY, side: 'Sell', qty: 300, price: 11.5, trade_value: 3450, commission: 5, stamp_duty: 3.45 });
const BATCH: RoundTripFill[] = [F1, F2, F3, F4, F5];

const COST_BUY1 = 1000 + 5; // 含费成本池（买 100@10）
const COST_BUY2 = COST_BUY1 + (2100 + 5); // + 买 200@10.5
const UNIT_BUY2 = COST_BUY2 / 300; // 卖出前的单位成本
const CONSUMED_SELL1 = 100 * UNIT_BUY2; // 被消耗成本
const NET_INCOME_SELL1 = 1100 - 5 - 1.1; // 卖出净收入 = 金额 − 佣金 − 印花税
const COST_AFTER_SELL1 = COST_BUY2 - CONSUMED_SELL1;
const COST_BUY3 = COST_AFTER_SELL1 + (1020 + 5); // + 买 100@10.2
const UNIT_BUY3 = COST_BUY3 / 300;
const CONSUMED_SELL2 = 300 * UNIT_BUY3;
const NET_INCOME_SELL2 = 3450 - 5 - 3.45;
const SELL_PNL_1 = NET_INCOME_SELL1 - CONSUMED_SELL1;
const SELL_PNL_2 = NET_INCOME_SELL2 - CONSUMED_SELL2;
/** 全平回合的 L1 pnl（手算事实：Σ卖出净收入 − Σ买入含费成本）—— I5 的对照值。 */
const BATCH_L1_PNL = NET_INCOME_SELL1 + NET_INCOME_SELL2 - (COST_BUY1 + (2100 + 5) + (1020 + 5));

describe('roundTripAccum D12（L2 成本归属 = 移动加权平均含费）', () => {
  it('逐笔：持仓成本 / 本笔卖出盈亏（绝对值 + %）/ 累计已实现盈亏（多批不同价 + 部分卖出 + 再买入）', () => {
    const acc = accumulateL2(BATCH);
    expect(acc).toHaveLength(5);

    // 持仓成本（该笔成交**后**的含费移动加权单位成本；买行亦须有值）
    expect(acc[0]!.position_cost_incl_fee).toBeCloseTo(COST_BUY1 / 100, 10);
    expect(acc[1]!.position_cost_incl_fee).toBeCloseTo(UNIT_BUY2, 10);
    expect(acc[3]!.position_cost_incl_fee).toBeCloseTo(UNIT_BUY3, 10);

    // 本笔卖出盈亏：仅卖出行有值（买行恒 null）
    expect(acc[0]!.sell_pnl).toBeNull();
    expect(acc[1]!.sell_pnl).toBeNull();
    expect(acc[3]!.sell_pnl).toBeNull();
    expect(acc[2]!.sell_pnl).toBeCloseTo(SELL_PNL_1, 10);
    expect(acc[4]!.sell_pnl).toBeCloseTo(SELL_PNL_2, 10);
    // 百分比分母 = 被消耗成本（比例小数，不是百分数）
    expect(acc[2]!.sell_pnl_pct).toBeCloseTo(SELL_PNL_1 / CONSUMED_SELL1, 10);
    expect(acc[4]!.sell_pnl_pct).toBeCloseTo(SELL_PNL_2 / CONSUMED_SELL2, 10);
    expect(acc[2]!.sell_pnl_pct).toBeCloseTo(0.0552090032, 8); // 手算：57.2333…/1036.6666… = +5.52%
    expect(acc[4]!.sell_pnl_pct).toBeCloseTo(0.11077461, 8); // 手算：343.2166…/3098.3333… = +11.08%

    // 累计已实现盈亏：买入行保持不变（首笔卖出前恒 0），卖出行累加本笔盈亏
    expect(acc[0]!.cum_realized_pnl).toBe(0);
    expect(acc[1]!.cum_realized_pnl).toBe(0);
    expect(acc[2]!.cum_realized_pnl).toBeCloseTo(SELL_PNL_1, 10);
    expect(acc[3]!.cum_realized_pnl).toBeCloseTo(SELL_PNL_1, 10);
    expect(acc[4]!.cum_realized_pnl).toBeCloseTo(SELL_PNL_1 + SELL_PNL_2, 10);
  });

  it('口径鉴别：部分卖出后「持仓成本」**浮点末位内不变**（相对容差 ≤1e-9；FIFO 会跳到较晚批次 ⇒ 仍具鉴别力）', () => {
    const acc = accumulateL2(BATCH);
    const before = acc[1]!.position_cost_incl_fee!;
    const after = acc[2]!.position_cost_incl_fee!;
    // 不变性口径（2026-09-26 裁定）：部分卖出后持仓成本为「**浮点末位内不变**」——独立复验实测 101 样本中
    // 27 个有漂移、最大 2.021e-14（正常浮点重算：cost_total/qty 的分子分母各自变过）⇒ 用**相对容差 ≤1e-9**，
    // 不作逐位（`===`）断言。
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(before)));
    expect(after).toBeCloseTo(UNIT_BUY2, 10);
    // 鉴别力量级断言**保留**（不得放宽）：FIFO 归属下此处会跳到较晚批次成本 10.50 ⇒ 相对差 1.3%（独立复验在真实
    // 87 run 上实测相对差 8.65% 量级），比容差（1e-9）高出十几个数量级 ⇒ 换 FIFO 必红。
    expect(Math.abs(after - 10.5) / Math.abs(after)).toBeGreaterThan(1e-3);
    expect(after).not.toBeCloseTo(10.5, 3);
    // 部分卖出只消耗成本池、不改变单位成本
    expect(COST_AFTER_SELL1).toBeLessThan(COST_BUY2);
    expect(COST_AFTER_SELL1 / 200).toBeCloseTo(UNIT_BUY2, 10);
  });

  it('I5：全平回合末笔「累计已实现盈亏」== L1 pnl（容差 = 既有对账口径 tol × max(1,|l1|)，不放宽）', () => {
    const acc = accumulateL2(BATCH);
    const l1 = BATCH_L1_PNL;
    const tol = 1e-6 * Math.max(1, Math.abs(l1)); // = `/audit.rt_reconcile.tolerance` 相对口径
    const last = acc[acc.length - 1]!;
    expect(Math.abs(last.cum_realized_pnl - l1)).toBeLessThanOrEqual(tol);
    expect(last.cum_realized_pnl).toBeCloseTo(400.45, 10);
    // 全平 ⇒ 已实现盈亏与净现金流必然相同（全部成本已被卖出消耗完）
    expect(last.cum_realized_pnl).toBeCloseTo(last.cum_cashflow, 10);
  });

  it('I6：① 首笔卖出前买入行恒 0（防「净投入伪装」）；② 买入**不改变**累计（买入行 == 其前一笔的值）', () => {
    const acc = accumulateL2(BATCH);
    const buyIdx = BATCH.map((x, i) => (x.side === 'Buy' ? i : -1)).filter((i) => i >= 0);
    expect(buyIdx).toEqual([0, 1, 3]);
    // ① 首笔卖出（idx2）**之前**的买入行恒 `0` —— 语义保护：不得把「净投入」伪装成已实现盈亏
    expect(acc[0]!.cum_realized_pnl).toBe(0);
    expect(acc[1]!.cum_realized_pnl).toBe(0);
    // ② 买入不改变累计：结构式（买入行值 == 其前一笔值；前一笔可以是卖出行）
    for (const i of buyIdx.filter((i) => i > 0)) {
      expect(acc[i]!.cum_realized_pnl).toBe(acc[i - 1]!.cum_realized_pnl);
    }
    // 注意：首笔卖出**之后**的买入行可正可负（承载的是「回合累计已实现盈亏」，非「净投入」）
    // ⇒ 不得再断言「买入行恒 ≥ 0」（旧字面判据已被活库推翻，见上一条用例）。
  });

  // ── I6（2026-09-26 独立复验更正：**契约错、代码对**）──
  //
  // 买入行承载的是「**回合累计已实现盈亏**」⇒ 首笔卖出**之后**可正可负（买入本身不改变累计）。
  // 原字面判据「买入行不得为负」错（活库 2108 条买入行中 6 条 < 0 / 94 条 > 0）；
  // 更正后：① 首笔卖出**之前**的买入行恒 `0`（防「净投入伪装」）；② 买入**不改变**累计（== 其前一笔的值）。
  // 向量：买 → 卖（**亏损**）→ 买 → 卖（盈利）→ 买（刻意跨象限）
  const LOSS_FILLS: RoundTripFill[] = [
    f({ bar_index: 1, qty: 100, price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 }),
    // 亏损卖出：净收入 354.64 < 被消耗成本 402 ⇒ sell_pnl = −47.36
    f({ bar_index: 2, ts: T0 + DAY, side: 'Sell', qty: 40, price: 9, trade_value: 360, commission: 5, stamp_duty: 0.36 }),
    f({ bar_index: 3, ts: T0 + 2 * DAY, qty: 100, price: 8, trade_value: 800, commission: 5, stamp_duty: 0 }),
    // 盈利卖出：净收入 654.34 − 被消耗成本 528 ⇒ sell_pnl = +126.34
    f({ bar_index: 4, ts: T0 + 3 * DAY, side: 'Sell', qty: 60, price: 11, trade_value: 660, commission: 5, stamp_duty: 0.66 }),
    f({ bar_index: 5, ts: T0 + 4 * DAY, qty: 50, price: 9, trade_value: 450, commission: 5, stamp_duty: 0 }),
  ];

  it('I6 跨象限向量：亏损卖出⇒其后买入行为**负**；盈利卖出⇒其后买入行为**正**（均 == 前一笔卖出的累计值）', () => {
    const acc = accumulateL2(LOSS_FILLS);
    const buyIdx = LOSS_FILLS.map((x, i) => (x.side === 'Buy' ? i : -1)).filter((i) => i >= 0);
    expect(buyIdx).toEqual([0, 2, 4]);
    // ① 首笔卖出（idx1）之前：买入行恒 0
    expect(acc[0]!.cum_realized_pnl).toBe(0);
    // ② 买入不改变累计（结构式：买入行值 == 其前一笔值）
    for (const i of buyIdx.filter((i) => i > 0)) {
      expect(acc[i]!.cum_realized_pnl).toBe(acc[i - 1]!.cum_realized_pnl);
    }
    // 亏损卖出（净收入 354.64 − 被消耗成本 402 = −47.36）⇒ 其后买入行(idx2)为**负值**
    expect(acc[1]!.sell_pnl).toBeCloseTo(-47.36, 10);
    expect(acc[2]!.cum_realized_pnl).toBeLessThan(0);
    expect(acc[2]!.cum_realized_pnl).toBeCloseTo(-47.36, 10); // **等于**该卖出后的累计值
    expect(acc[2]!.cum_realized_pnl).not.toBe(0); // 不是 0
    // 也不是「净投入」（cum_cashflow 才是净投入口径）
    expect(acc[2]!.cum_realized_pnl).not.toBeCloseTo(acc[2]!.cum_cashflow, 6);
    // 随后盈利卖出（净收入 654.34 − 被消耗成本 528 = +126.34）⇒ 其后买入行(idx4)为**正值**
    expect(acc[3]!.sell_pnl).toBeCloseTo(126.34, 10);
    expect(acc[4]!.cum_realized_pnl).toBeGreaterThan(0);
    expect(acc[4]!.cum_realized_pnl).toBeCloseTo(-47.36 + 126.34, 10); // = 78.98
    expect(acc[4]!.cum_realized_pnl).toBe(acc[3]!.cum_realized_pnl);
  });

  it('cum_cashflow 与原「cum_realized_pnl（净现金流差）」旧算法逐位一致（改名不改算法）', () => {
    // 独立复现旧算法（**不改顺序**：左折叠、同操作数顺序 ⇒ 浮点逐位相等）
    const refCashflow = (fills: RoundTripFill[]): number[] => {
      let s = 0;
      return fills.map((x) => {
        s = x.side === 'Buy' ? s - (x.trade_value + x.commission) : s + (x.trade_value - x.commission - x.stamp_duty);
        return s;
      });
    };
    for (const fills of [FILLS, BATCH]) {
      const acc = accumulateL2(fills);
      const ref = refCashflow(fills);
      expect(acc.map((a) => a.cum_cashflow)).toEqual(ref);
      ref.forEach((v, i) => expect(acc[i]!.cum_cashflow).toBe(v)); // 逐位（===，非近似）
    }
    // 末笔 == L1 pnl 的既有对账可见性不变
    expect(accumulateL2(FILLS).at(-1)!.cum_cashflow).toBeCloseTo(RT.pnl!, 10);
    expect(reconcileRoundTrip(RT, FILLS, { tolerance: 1e-6 }).fields.find((x) => x.key === 'pnl')!.l2).toBe(
      accumulateL2(FILLS).at(-1)!.cum_cashflow,
    );
  });

  it('边界：全平后持仓成本 ⇒ null；空输入 ⇒ 空输出；无持仓卖出不得造数（NaN/Infinity 归零）', () => {
    const acc = accumulateL2(BATCH);
    expect(acc[4]!.position_cost_incl_fee).toBeNull(); // ⑤ 全平 ⇒ 无持仓 ⇒ null（UI 显示 —）
    expect(acc[0]!.position_cost_incl_fee).not.toBeNull();
    expect(accumulateL2([])).toEqual([]);
    // 防御性边界（非良构回合：**无持仓即卖出** = 越卖极端）：无成本基准 ⇒ **不造数**
    // （架构侧 2026-09-26 裁定 1：sell_pnl / sell_pnl_pct 均 null、不计入 cum_realized_pnl）
    const naked = accumulateL2([f({ side: 'Sell', qty: 100, trade_value: 1000, commission: 5, stamp_duty: 1 })]);
    expect(naked[0]!.position_cost_incl_fee).toBeNull();
    expect(naked[0]!.sell_pnl).toBeNull();
    expect(naked[0]!.sell_pnl_pct).toBeNull();
    expect(naked[0]!.cum_realized_pnl).toBe(0); // 无基准收入**不得**计入累计已实现盈亏
    // 全部数值列不得出现 NaN/Infinity
    expect(Object.values(naked[0]!).every((v) => v == null || Number.isFinite(v))).toBe(true);
  });

  // ── 越卖防御（架构侧 2026-09-26 裁定 1，「不造数」纪律）──
  //
  // 旧行为（已废弃）：无持仓时把成本基准记 0 ⇒ `sell_pnl = 净收入全额` 且 `cumRealizedPnl += 净收入`
  // ⇒ 把一笔**无成本基准**的卖出收入记成「已实现盈利」（虚增，且可污染 I5）。
  // 现行为：越卖（`f.qty > positionQty`，含 `positionQty == 0`）⇒ sell_pnl/_pct = null、**不累加**累计、
  //         持仓置 0（不留负残值）。严格全平（`f.qty == positionQty`）**不受影响**（I5 仍成立）。

  /** 越卖向量：买 100@10（费 5）→ 卖 **150**@12（费 5 / 印花 1.8）—— 卖出股数超出持仓。 */
  const OVER_FILLS: RoundTripFill[] = [
    f({ bar_index: 1, qty: 100, price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 }),
    f({ bar_index: 2, ts: T0 + DAY, side: 'Sell', qty: 150, price: 12, trade_value: 1800, commission: 5, stamp_duty: 1.8 }),
  ];

  it('越卖防御 ①：卖出行 sell_pnl/sell_pnl_pct === null，且 cum_realized_pnl == 买入后的值（0），**不等于**净收入', () => {
    const acc = accumulateL2(OVER_FILLS);
    expect(acc[0]!.position_cost_incl_fee).toBeCloseTo(1005 / 100, 10); // 买后 10.05
    expect(acc[0]!.cum_realized_pnl).toBe(0);
    const sell = acc[1]!;
    expect(sell.sell_pnl).toBeNull();
    expect(sell.sell_pnl_pct).toBeNull();
    expect(sell.cum_realized_pnl).toBe(0); // == 买入后的值（未累加）
    const netIncome = 1800 - 5 - 1.8; // = 1793.20
    expect(sell.cum_realized_pnl).not.toBeCloseTo(netIncome, 6); // ≠ 净收入（旧缺陷：造数）
    expect(sell.position_cost_incl_fee).toBeNull(); // 持仓归零 ⇒ null
    // 净现金流（事实字段逐笔累加）不受整改影响
    expect(sell.cum_cashflow).toBeCloseTo(-1005 + netIncome, 10);
    // 无负残值：后续笔从 0 起算（见下一条用例）
    expect(Object.values(sell).every((v) => v == null || Number.isFinite(v))).toBe(true);
  });

  it('越卖防御 ②：越卖后 positionQty/positionCost 从 0 起算（无负残值污染后续笔）', () => {
    const acc = accumulateL2([
      ...OVER_FILLS,
      f({ bar_index: 3, ts: T0 + 2 * DAY, qty: 100, price: 8, trade_value: 800, commission: 5, stamp_duty: 0 }),
      f({ bar_index: 4, ts: T0 + 3 * DAY, side: 'Sell', qty: 100, price: 9, trade_value: 900, commission: 5, stamp_duty: 0 }),
    ]);
    // 越卖后重新建仓：成本池 = 805（不含上一回合的任何残留）⇒ 单位成本 8.05
    expect(acc[2]!.position_cost_incl_fee).toBeCloseTo(805 / 100, 12);
    expect(acc[2]!.cum_realized_pnl).toBe(0); // 越卖未累加
    // 严格全平的第二笔卖出：正常计算，累计已实现盈亏**只含合法卖出**
    expect(acc[3]!.sell_pnl).toBeCloseTo(895 - 805, 10); // 90
    expect(acc[3]!.sell_pnl_pct).toBeCloseTo(90 / 805, 10);
    expect(acc[3]!.cum_realized_pnl).toBeCloseTo(90, 10);
    expect(acc[3]!.position_cost_incl_fee).toBeNull();
  });

  it('越卖防御 ③：严格全平（f.qty == positionQty）不受影响 —— I5 向量仍成立', () => {
    // 严格全平向量（BATCH ⑤）：consumed == positionCost、sell_pnl 有值、末笔 == L1 pnl
    const acc = accumulateL2(BATCH);
    expect(acc[4]!.sell_pnl).not.toBeNull();
    expect(acc[4]!.sell_pnl_pct).not.toBeNull();
    expect(acc[4]!.sell_pnl).toBeCloseTo(SELL_PNL_2, 10);
    expect(acc[4]!.cum_realized_pnl).toBeCloseTo(BATCH_L1_PNL, 6); // I5
    // 另：单笔买 + 严格全平（FILLS 同构）亦不受影响
    const two = accumulateL2([
      f({ bar_index: 1, qty: 100, price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 }),
      f({ bar_index: 2, ts: T0 + DAY, side: 'Sell', qty: 100, price: 12, trade_value: 1200, commission: 5, stamp_duty: 1.2 }),
    ]);
    expect(two[1]!.sell_pnl).toBeCloseTo(1200 - 5 - 1.2 - 1005, 10);
    expect(two[1]!.sell_pnl_pct).toBeCloseTo((1200 - 5 - 1.2 - 1005) / 1005, 10);
    expect(two[1]!.cum_realized_pnl).toBeCloseTo(1200 - 5 - 1.2 - 1005, 10);
  });

  // ── 全平/越卖的**相对容差**（架构侧 2026-09-26 追加裁定 1）──
  //
  // 无容差时：「本应全平、`f.qty` 比 `positionQty` 大 1e-13」的浮点噪声会被判成**越卖** ⇒ 该笔 `—` 且不计入累计
  // ⇒ 直接**打断 I5**（末笔累计 ≠ L1 pnl）——“噪声变判据失败”不可接受。
  // 容差口径与 `rt_reconcile.tolerance` 相对口径同源：`qtyTol = 1e-9 × max(1, positionQty)`（写死，不放宽任一既有断言）。

  it('全平容差 ①（噪声全平）：f.qty = positionQty + 1e-13 ⇒ **不得**判越卖；末笔累计 == L1 pnl（I5 成立）', () => {
    const qty = 100;
    const noiseQty = qty + 1e-13; // 略超持仓（浮点噪声级）
    const px = 12;
    const noiseFills: RoundTripFill[] = [
      f({ bar_index: 1, qty, price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 }),
      f({
        bar_index: 2, ts: T0 + DAY, side: 'Sell', qty: noiseQty, price: px,
        trade_value: noiseQty * px, commission: 5, stamp_duty: 1.2,
      }),
    ];
    const acc = accumulateL2(noiseFills);
    expect(noiseQty > qty).toBe(true); // 构造确为「略超」而非相等
    const sell = acc[1]!;
    expect(sell.sell_pnl).not.toBeNull(); // **关键**：不得被判越卖
    expect(sell.sell_pnl_pct).not.toBeNull();
    expect(sell.position_cost_incl_fee).toBeNull(); // 全平 ⇒ 无持仓
    // 被消耗成本取成本池**总额** ⇒ 已实现盈亏与净现金流末值同源
    expect(sell.sell_pnl).toBeCloseTo(noiseQty * px - 5 - 1.2 - 1005, 10);
    expect(sell.cum_realized_pnl).toBeCloseTo(sell.cum_cashflow, 10);
    // I5：末笔累计已实现盈亏 == L1 pnl（容差 = 既有对账相对口径，不放宽）
    const l1 = sell.cum_cashflow; // 全平回合：末笔净现金流 == L1 pnl
    const tol = 1e-6 * Math.max(1, Math.abs(l1));
    expect(Math.abs(sell.cum_realized_pnl - l1)).toBeLessThanOrEqual(tol);
  });

  it('全平容差 ②（真越卖）：f.qty = positionQty + 1 ⇒ 仍判越卖（null + 不累加 + 夹零）', () => {
    const acc = accumulateL2([
      f({ bar_index: 1, qty: 100, price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 }),
      f({ bar_index: 2, ts: T0 + DAY, side: 'Sell', qty: 101, price: 12, trade_value: 1212, commission: 5, stamp_duty: 1.21 }),
    ]);
    expect(acc[1]!.sell_pnl).toBeNull();
    expect(acc[1]!.sell_pnl_pct).toBeNull();
    expect(acc[1]!.cum_realized_pnl).toBe(0); // 不累加（== 买入后的值）
    expect(acc[1]!.position_cost_incl_fee).toBeNull();
  });

  it('全平容差 ③：部分卖出（远未全平）仍走原递推 —— unit_cost 取卖出前均价、持仓成本不变', () => {
    const acc = accumulateL2(BATCH);
    expect(acc[2]!.sell_pnl).toBeCloseTo(SELL_PNL_1, 10);
    expect(acc[2]!.position_cost_incl_fee).toBeCloseTo(UNIT_BUY2, 12);
    expect(acc[3]!.position_cost_incl_fee).toBeCloseTo(UNIT_BUY3, 12);
  });

  // ── 0 股卖出（有持仓）= 费用事件（架构侧 2026-09-26 追加裁定 2：**保持现状** + 注释 + 固定断言）──

  it('0 股卖出：sell_pnl = −（佣金+印花税）（纯费用事实，非造数）、pct = null、持仓成本不变', () => {
    const acc = accumulateL2([
      f({ bar_index: 1, qty: 100, price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 }),
      f({ bar_index: 2, ts: T0 + DAY, side: 'Sell', qty: 0, price: 10, trade_value: 0, commission: 5, stamp_duty: 0 }),
    ]);
    expect(acc[1]!.sell_pnl).toBeCloseTo(-5, 12); // = 0 − 5 − 0（仅费用）
    expect(acc[1]!.sell_pnl_pct).toBeNull(); // 0 分母 ⇒ 不成比例
    expect(acc[1]!.cum_realized_pnl).toBeCloseTo(-5, 12);
    expect(acc[1]!.position_cost_incl_fee).toBeCloseTo(10.05, 12); // 持仓未变
    expect(acc[1]!.cum_cashflow).toBeCloseTo(-1005 - 5, 12); // 净现金流仍按事实字段累加
  });

  it('展示：本笔卖出盈亏单元格格式 `+123.45 (+2.31%)`（复用 fmtNum；买行/未知 ⇒ —）', () => {
    expect(fmtSellPnl(63.7, 63.7 / 2030)).toBe('+63.70 (+3.14%)');
    expect(fmtSellPnl(-12.3, -0.02)).toBe('-12.30 (-2.00%)');
    expect(fmtSellPnl(0, 0)).toBe('+0.00 (+0.00%)');
    expect(fmtSellPnl(null, null)).toBe('—');
    expect(fmtSellPnl(null, 0.05)).toBe('—');
    expect(fmtSellPnl(12.3, null)).toBe('+12.30');
  });
});
