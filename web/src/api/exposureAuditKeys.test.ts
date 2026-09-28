import { describe, expect, it } from 'vitest';
import type { WorkbenchExposureAudit, WorkbenchRunAudit } from './types';

/**
 * ADR-029 Step 1.5（D15/E24）§3.1：`GET /api/workbench/runs/{id}/audit` **新增 `exposure` 键**
 * （追加在 `warnings` 之后；非 `Exposure` / 无观测 / `recorded=false` ⇒ `null`）。
 *
 * 本文件锁两件事：
 *  1. **编译期锁（双向）**：`WorkbenchExposureAudit` 的键集必须**逐一**等于契约样例 ——
 *     ① `Record<keyof WorkbenchExposureAudit, true>` 字面量：少一个键 ⇒ TS2741（缺属性）；
 *     ② 直接赋值对象字面量：多一个键 ⇒ TS2353（对象字面量只能指定已知属性）。
 *     （`tsc --noEmit` 在本仓空转，门禁命令是 `npx tsc -b`。）
 *  2. **运行时锁**：真实响应载荷（06-plan §3.1 样例形状，17 键）解析后键集/值域一致；
 *     `null` 与「零值段」可区分（不得把 `null` 读成 0）。
 *
 * **键数口径消歧（契约核对，2026-09-29）**：Rust `ExposureAudit` 结构体共 **18 个字段**，
 * 其中 `warnings` 带 `#[serde(skip_serializing)]`（读侧已把它并入顶层 `warnings[]`，同一事实只一个出口）
 * ⇒ **JSON 段 = 17 键**，与 `06-plan` §3.1 样例逐一对应。派工单里的「18 键」= 结构体字段数
 * （含不出 JSON 的 `warnings`）；本类型按**线上键集**声明（唯一事实源 = §3.1 样例）。
 */

/** 契约样例（`06-plan` §3.1；**逐字**的键集与形状，数值取所示样例值）。 */
const EXPOSURE_AUDIT_RAW =
  '{"bars":1810,"orders":58,"orders_per_bar":0.0319,"fees":297.8804660338809,' +
  '"fee_pct":0.0029788,"nominal_fee_rate":0.00025,"cost_amplification":32.0,' +
  '"max_target_gap":0.010216,"max_target_gap_bar":1599,"max_intent_gap":0.0031,' +
  '"max_intent_gap_bar":1234,"unmet_intent_bars":12,"clamped_bars":0,' +
  '"deadzone_blocked_bars":1760,"rate_limited_bars":6,"sell_transition_bars":0,' +
  '"affordability_capped_bars":0}';

/** 契约键集（顺序 = `06-plan` §3.1 样例顺序 = Rust 结构体声明顺序）。 */
const CONTRACT_KEYS = [
  'bars',
  'orders',
  'orders_per_bar',
  'fees',
  'fee_pct',
  'nominal_fee_rate',
  'cost_amplification',
  'max_target_gap',
  'max_target_gap_bar',
  'max_intent_gap',
  'max_intent_gap_bar',
  'unmet_intent_bars',
  'clamped_bars',
  'deadzone_blocked_bars',
  'rate_limited_bars',
  'sell_transition_bars',
  'affordability_capped_bars',
] as const;

const parseExposure = (raw: string): WorkbenchExposureAudit => JSON.parse(raw) as WorkbenchExposureAudit;

describe('ADR-029 Step 1.5 §3.1：审计 `exposure` 段键集（编译期锁 + 运行时锁）', () => {
  it('编译期锁（① 不漏）：键集字面量必须**穷尽** `keyof WorkbenchExposureAudit`（少一即 TS2741）', () => {
    // 少键 ⇒ 「类型 ... 中缺少属性」；多键 ⇒ 多属性报错。两侧同时钉住。
    const exhaustive: Record<keyof WorkbenchExposureAudit, true> = {
      bars: true,
      orders: true,
      orders_per_bar: true,
      fees: true,
      fee_pct: true,
      nominal_fee_rate: true,
      cost_amplification: true,
      max_target_gap: true,
      max_target_gap_bar: true,
      max_intent_gap: true,
      max_intent_gap_bar: true,
      unmet_intent_bars: true,
      clamped_bars: true,
      deadzone_blocked_bars: true,
      rate_limited_bars: true,
      sell_transition_bars: true,
      affordability_capped_bars: true,
    };
    expect(Object.keys(exhaustive).length).toBe(CONTRACT_KEYS.length);
  });

  it('运行时锁：契约样例载荷的键集 = 17 键（顺序即契约；`warnings` **不在**段内 — 读侧并入顶层 `warnings[]`）', () => {
    const seg = parseExposure(EXPOSURE_AUDIT_RAW);
    expect(Object.keys(seg)).toEqual([...CONTRACT_KEYS]);
    expect(Object.keys(seg), '`warnings` 不得出现在结构化段内（serde skip_serializing）').not.toContain('warnings');
  });

  it('值域：计数为整数、比例为 `number|null`；`unmet_intent_bars` / `max_intent_gap` 无数据 ⇒ `null`（≠ 0）', () => {
    const seg = parseExposure(EXPOSURE_AUDIT_RAW);
    for (const k of ['bars', 'orders', 'clamped_bars', 'deadzone_blocked_bars', 'rate_limited_bars', 'sell_transition_bars', 'affordability_capped_bars'] as const) {
      expect(Number.isInteger(seg[k]), `${k} 须为整数计数`).toBe(true);
    }
    expect(seg.max_target_gap).toBeCloseTo(0.010216, 9);
    expect(seg.max_target_gap_bar).toBe(1599);
    expect(seg.cost_amplification).toBe(32.0);
    expect(seg.nominal_fee_rate).toBe(0.00025);
    // 无成交额 / 名义费率 0 ⇒ `null`（不得造数）；无意图数据（旧 run）⇒ `null`
    const nullish: WorkbenchExposureAudit = {
      ...seg,
      nominal_fee_rate: null,
      cost_amplification: null,
      max_intent_gap: null,
      max_intent_gap_bar: null,
      unmet_intent_bars: null,
    };
    expect([nullish.nominal_fee_rate, nullish.cost_amplification, nullish.max_intent_gap, nullish.unmet_intent_bars]).toEqual([
      null, null, null, null,
    ]);
    // `null` 与 0 是两个事实：不得把「无数据」读成「0 成本放大 / 0 未达成 bar」
    expect(nullish.cost_amplification).not.toBe(0);
    expect(nullish.unmet_intent_bars).not.toBe(0);
  });

  it('顶层容差：`exposure` 键可缺（mock / Step 1.5 之前的后端），亦可为 `null`（非 Exposure / 无观测）', () => {
    const base: WorkbenchRunAudit = {
      run_id: 'sr_x',
      recorded: true,
      capital_basis: 100000,
      deployed_notional: 0,
      deployed_pct: 0,
      cash_consumed: 0,
      cash_consumed_pct: 0,
      planned_tranches: null,
      reachable_batches: 0,
      batches_done: 0,
      unexecuted_orders: 0,
      last_bar_unfilled: false,
      round_trips_total: 0,
      round_trips_force_closed: 0,
      round_trips_closed: 0,
      round_trips_open: 0,
      rt_reconcile: { checked: 0, mismatched: [], tolerance: 1e-6 },
      warnings: [],
    };
    // ① 缺键（旧后端）② 显式 null（非 Exposure）③ 段（Exposure）
    expect((base as { exposure?: unknown }).exposure).toBeUndefined();
    const nulled: WorkbenchRunAudit = { ...base, exposure: null };
    expect(nulled.exposure).toBeNull();
    const withSeg: WorkbenchRunAudit = { ...base, exposure: parseExposure(EXPOSURE_AUDIT_RAW) };
    expect(withSeg.exposure?.bars).toBe(1810);
  });
});
