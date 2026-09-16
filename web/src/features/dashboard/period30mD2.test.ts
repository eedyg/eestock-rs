/**
 * ADR-023 **D2 红测试（手写）**：让 30m 进入多周期（前端半边）—— 同时打开三处中的
 * `MULTI_PERIOD_PICKER_PERIODS` 与 `MEASURED_DENSITY_TABLE`（第三处 `MULTI_PERIOD_ALLOWED` 见
 * `crates/web/tests/period30m_d2_multiperiod_red.rs`）。
 *
 * 本文件位置：`web/src/features/dashboard/period30mD2.test.ts`
 * 设计报告：`tester/design/289_adr023_d2_density_and_red_design.md`
 * 执行报告：`tester/test/289_adr023_d2_density_and_red_execution.md`
 * 证据：`/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md`
 *
 * 权威依据：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §2.5 / §5.3（D2 交付范围）。
 *
 * ## `1m:30m` 密度值的来源（**实测，非名义比**）
 * 口径 P0.3：pane 宽 **520px**、真渲染（klinecharts 10.0.3，两个实例）、
 * `D = 同窗基准 bar 数 / 卫星 bar 数`；数据取自**只读** `GET /api/kline`（code=518880, limit=1000）。
 * 本次实测（`/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md`）：
 *  - 真渲染同窗取样（15 组 × 3 次重复，重复逐位一致）：day 尺度（nSat ∈ 9…19）D ∈ **[24.0, 25.3]**，
 *    中位 ≈ 24.25；窗宽 ≥ 5 根 30m bar 的样本 D ∈ [20.2, 26.7]。
 *  - K=8 等时窗中位数（**既有 5 条表值的同一估计器**）= **24.1**；逐整日口径 = 241/10 = **24.1**（4 个整日全同）。
 *  - 自洽校验：`D(15m→30m)` 真渲染实测 = **1.798…1.80**，`D(1m→30m)/D(1m→15m)` = 1.80（K8）⇒ 一致。
 *  ⇒ **建议写入表的值 = 24.1**（与实测一致；**不得**取整成名义比 30）。
 *
 * ## D2 第二阶段追加（父级裁决，2026-09-16）
 * 1. `MEASURED_DENSITY_TABLE` 必须含 30m 的**四条直接条目**（`1m:30m / 5m:30m / 15m:30m / 30m:1h`），
 *    四条全部来自**同一 P0.3 口径真渲染实测**（见下「四条目实测值」）；
 * 2. **不变量**（把「静默错对齐」变成响亮失败）：`ChartSyncGroup` 的 `effectiveDensity` 解析顺序是
 *    `static → composed → measured → none` ⇒ 若 30m 配对缺直接条目，就会**静默**采用
 *    `composeDensity`（例：`24.1/12.2 = 1.9754` vs 直接实测 `1.800`，+9.7% 错对齐）且优先级高于运行时实测。
 *    ⇒ 对 30m 与 `{1m,5m,15m,1h}` 的每一对，`densityByFollower['30m'].source` 必须是 **`'static'`**，
 *    且比值必须等于**直接实测值**（不是合成值）。
 *
 * ## 四条目实测值（本轮真渲染实测，均 K=8/K=16 等时窗中位数 = 既有 5 条表值同一估计器）
 * | 条目 | 建议值 | 真渲染同窗包络（day 尺度） | K8/K16 中位 | 名义比（禁） |
 * |---|---|---|---|---|
 * | `1m:30m` | **24.1** | [24.0, 25.3] | 24.1 / 24.1 | 30 |
 * | `5m:30m` | **5.0** | [4.84, 5.08] | 5.0 / 5.0 | 6 |
 * | `15m:30m` | **1.8** | [1.78, 1.81] | 1.8 / 1.8 | 2 |
 * | `30m:1h` | **1.67** | [1.63, 1.69] | 1.6667 / 1.6667 | 2 |
 * 逐整日硬底：1m=241/日、5m=50/日、15m=18/日、30m=10/日、1h=6/日 ⇒ 24.1 / 5.0 / 1.8 / 1.667。
 *
 * ## 红因分类（本阶段实测）
 *  - `d2_*`：**断言失败**（表内无 `1m:30m`、选择器无 `30m`、`periodOrder` 无 `30m`）。
 *  - `d2_guard_*`：**绿侧护栏**（既有语义；**既有 5 条密度值逐字不得改写**、既有拒绝不得放宽）。
 */

import { describe, expect, it } from 'vitest';
import {
  MEASURED_DENSITY_TABLE,
  PERIOD_BUCKET_MS,
  composeDensity,
  isSyncCombinationAllowed,
  periodBucketMs,
  syncExclusionReason,
} from './chartSyncGroup';
import { MULTI_PERIOD_PICKER_PERIODS } from './multiPeriodPicker';
import { ChartSyncGroup } from './chartSyncGroup';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';

/**
 * 30m 的**四条直接条目**实测值（本轮真渲染；证据 `/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md`）。
 * 每条 = `[建议值, 真渲染同窗包络低, 包络高, 名义周期比（禁）]`。
 */
/** `ChartSyncGroup` 构造器：成员的 `chart` 用忠实桩（`web/src/test/syncChartStub.ts`）。 */
const ChartSyncGroupCtor = ChartSyncGroup as unknown as GroupCtor;

const D30_DIRECT_ENTRIES: ReadonlyArray<[string, number, number, number, number]> = [
  ['1m:30m', 24.1, 24.0, 25.3, 30],
  ['5m:30m', 5.0, 4.84, 5.08, 6],
  ['15m:30m', 1.8, 1.78, 1.81, 2],
  ['30m:1h', 1.67, 1.63, 1.69, 2],
];
/** 建议值容差（允许实现方在第三位小数上按同一估计器取整：如 1.67 ↔ 1.6667）。 */
const DIRECT_VALUE_TOLERANCE = 0.01;
/** D2 后完整选择器清单（ADR-023 §3.2：15m → **30m** → 1h）。 */
const EXPECTED_PICKER = ['1m', '5m', '15m', '30m', '1h', '1d', '1w'];
/** 既有 5 条实测值（**逐字不得改写**；P0.3 锚定）。 */
const EXISTING_DENSITY_ENTRIES: ReadonlyArray<[string, number]> = [
  ['1m:5m', 4.7],
  ['1m:15m', 12.2],
  ['1m:1h', 37.8],
  ['1d:1w', 4.67],
  ['1h:1w', 24],
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. 选择器清单：含 30m 且顺序正确（15m → 30m → 1h）
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 · 选择器清单（MULTI_PERIOD_PICKER_PERIODS）', () => {
  it("含 '30m' 且完整顺序 = 1m/5m/15m/30m/1h/1d/1w", () => {
    expect(
      MULTI_PERIOD_PICKER_PERIODS,
      `ADR-023 §3.2：D2 必须把 '30m' 加入 MULTI_PERIOD_PICKER_PERIODS；实际 = ${JSON.stringify(MULTI_PERIOD_PICKER_PERIODS)}`,
    ).toEqual(EXPECTED_PICKER);
  });

  it('30m 严格位于 15m 与 1h 之间（不得落到其它位置）', () => {
    const i15 = MULTI_PERIOD_PICKER_PERIODS.indexOf('15m' as never);
    const i30 = MULTI_PERIOD_PICKER_PERIODS.indexOf('30m' as never);
    const i1h = MULTI_PERIOD_PICKER_PERIODS.indexOf('1h' as never);
    expect(
      i30,
      `ADR-023 §2.5/§3.2：索引必须满足 15m < 30m < 1h；实际 = ${i15}/${i30}/${i1h}`,
    ).toBeGreaterThan(i15);
    expect(i30).toBeLessThan(i1h);
  });

  it("periodBucketMs('30m') == 1800000（既有 D1 交付，不得回退）", () => {
    expect(periodBucketMs('30m'), "periodBucketMs('30m') 必须 = 1_800_000").toBe(1_800_000);
    expect(PERIOD_BUCKET_MS['30m'], "PERIOD_BUCKET_MS['30m'] 必须 = 1_800_000").toBe(1_800_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 实测密度表：新增 `1m:30m` 且值 == 真渲染实测值
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 · 实测密度表：30m 的**四条直接条目**', () => {
  for (const [key, want, lo, hi, nominal] of D30_DIRECT_ENTRIES) {
    it(`MEASURED_DENSITY_TABLE['${key}'] == ${want}（真渲染实测，非名义比 ${nominal}）`, () => {
      const v = MEASURED_DENSITY_TABLE[key];
      expect(v, `表内必须新增实测直接条目 '${key}'；实际 = ${String(v)}`).not.toBeUndefined();
      expect(
        Math.abs((v as number) - want) <= DIRECT_VALUE_TOLERANCE,
        `'${key}' 必须 == ${want}（±${DIRECT_VALUE_TOLERANCE}；同估计器取整容差）；实际 = ${String(v)}`,
      ).toBe(true);
      expect(
        (v as number) >= lo && (v as number) <= hi,
        `'${key}' 必须落在真渲染同窗取样包络 [${lo}, ${hi}] 内；实际 = ${String(v)}`,
      ).toBe(true);
      expect(v, `ADR-022/287 口径：'${key}' 禁止按名义周期比兜底（${nominal}）`).not.toBe(nominal);
    });
  }

  it('四条**齐备**（缺任一条 ⇒ 会静默落回 composeDensity 造成错对齐）', () => {
    const missing = D30_DIRECT_ENTRIES.map(([k]) => k).filter((k) => MEASURED_DENSITY_TABLE[k] === undefined);
    expect(missing, `30m 的四条直接条目必须齐备；缺 = ${JSON.stringify(missing)}`).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 合成：30m 同族组合必须可合成（非 null）
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 · composeDensity 对 30m 同族组合', () => {
  it('15m↔30m / 5m↔30m / 30m↔1h 均必须返回非 null 正值', () => {
    for (const [b, s] of [['15m', '30m'], ['5m', '30m'], ['30m', '1h']] as const) {
      const d = composeDensity(b, s);
      expect(d, `composeDensity('${b}','${s}') 必须非 null（同 1m 锚点）；实际 = ${String(d)}`).not.toBeNull();
      expect(typeof d === 'number' && d > 0, `合成值必须为正数；实际 = ${String(d)}`).toBe(true);
    }
  });

  it('⚠️ 合成值**不得**被 30m 配对采用（漂移已实测：15m→30m 合成 1.9754 vs 实测 1.800 = +9.7%）', () => {
    // 本用例只**记录**合成值与实测值的落差（合成值本身允许存在：`static` 直接条目优先于 `composed`，
    // 见下方 `effectiveDensity` 不变量）。此处断言：合成值与直接实测值**确实不同** ⇒ 若实现顺序把
    // `composed` 放在 `static` 之前，落差会真实生效（下一条不变量用例负责把它变成响亮失败）。
    const composed = composeDensity('15m', '30m') as number;
    expect(composed, "15m→30m 的合成值（1m 锚点）必须可算（非 null）").not.toBeNull();
    expect(
      Math.abs(composed - 1.8) / 1.8,
      `合成值 ${composed} 与真渲染实测 1.8 的落差（应 ≈ +9.7%，即「必须走 direct 条目」的量化理由）`,
    ).toBeGreaterThan(0.05);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. **不变量（防回归，可执行）**：30m 的每一对必须由 `static` 直接条目解析
//     （`effectiveDensity` 解析序 = static → composed → measured → none ⇒ 缺条目会静默走 compose）
// ─────────────────────────────────────────────────────────────────────────────

/** 周期桶宽（与 `PERIOD_BUCKET_MS` 无关：本处只用于造桩序列，30m 由被测实现提供）。 */
const STUB_BUCKET_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000,
};
const STUB_END_TS = Date.parse('2026-09-16T07:00:00Z');

interface GroupStatsLike {
  densityByFollower?: Record<string, { ratio: number; source: 'measured' | 'static' | 'composed' | 'none' }>;
}
type GroupLike = { start(): void; stop(): void; readonly stats: GroupStatsLike };
type GroupCtor = new (members: Array<{ id: string; chart: unknown; period: string; isBase: boolean }>) => GroupLike;

/** 跑一轮真实对齐全过程，读回该跟随者的**有效密度比及其来源**（`SyncStats.densityByFollower`）。 */
function densityReadingFor(basePeriod: string, satPeriod: string): { ratio: number; source: string } | undefined {
  const base = createSyncChartStub({
    bars: makeSeries({ count: 900, spacingMs: STUB_BUCKET_MS[basePeriod] as number, endTs: STUB_END_TS }),
    limit: { min: 1, max: 50 },
  });
  const sat = createSyncChartStub({
    bars: makeSeries({ count: 400, spacingMs: STUB_BUCKET_MS[satPeriod] as number, endTs: STUB_END_TS }),
    limit: { min: 1, max: 200_000 },
  });
  const Ctor = ChartSyncGroupCtor;
  const g = new Ctor([
    { id: `base:${basePeriod}`, chart: base, period: basePeriod, isBase: true },
    { id: `sat:${satPeriod}`, chart: sat, period: satPeriod, isBase: false },
  ]);
  g.start();
  base.scrollToDataIndex(600);
  const reading = g.stats.densityByFollower?.[satPeriod];
  g.stop();
  return reading;
}

describe('D2 · 不变量：30m 配对**永不**使用 composed（防静默错对齐）', () => {
  for (const [key, want] of D30_DIRECT_ENTRIES) {
    const [basePeriod, satPeriod] = key.split(':') as [string, string];
    it(`${key}：effectiveDensity 必须解析为 source='static' 且 == 直接实测 ${want}`, () => {
      const reading = densityReadingFor(basePeriod, satPeriod);
      expect(
        reading,
        `无法读到 ${key} 的密度读数（卫星被排除/组未建立/未对齐）⇒ 30m 未真正进入多周期`,
      ).toBeDefined();
      expect(
        reading?.source,
        `${key} 必须由**直接实测条目**解析（source='static'）；实际 = ${String(reading?.source)}` +
          `（'composed' ⇒ 静默采用合成值，实测落差最大 +9.7% ⇒ 真实错对齐）`,
      ).toBe('static');
      expect(reading?.source, `${key} 不得为 composed/measured/none`).not.toBe('composed');
      expect(
        Math.abs((reading?.ratio ?? Number.NaN) - want) <= DIRECT_VALUE_TOLERANCE,
        `${key} 的解析比值必须 == 直接实测 ${want}（±${DIRECT_VALUE_TOLERANCE}）；实际 = ${String(reading?.ratio)}`,
      ).toBe(true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 诚实降级：30m↔1d / 30m↔1w 仍必须拒绝，且**给出原因码**（禁静默）
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 · 30m 跨族护栏（诚实降级 + 原因码）', () => {
  it('isSyncCombinationAllowed 拒绝 30m↔1d 与 30m↔1w', () => {
    expect(
      isSyncCombinationAllowed('30m', '1d'),
      'ADR-023 §2.5：30m↔1d 跨族不同步（1m 锚点与 1d 锚点不相通）⇒ 必须拒绝',
    ).toBe(false);
    expect(
      isSyncCombinationAllowed('30m', '1w'),
      'ADR-023 §2.5 / P0.3 口径 10：1w 需基准 ≥1d ⇒ 30m↔1w 必须拒绝',
    ).toBe(false);
  });

  it('拒绝必须给出**原因码**（不得静默：既不是 null 也不是 unsupported-period）', () => {
    const r1d = syncExclusionReason('30m', '1d');
    expect(r1d, `30m↔1d 必须给出原因码；实际 = ${String(r1d)}`).not.toBeNull();
    expect(
      r1d,
      `30m 已进入周期集 ⇒ 原因不得是 'unsupported-period'（那说明 periodOrder 未纳入 30m）；实际 = ${String(r1d)}`,
    ).not.toBe('unsupported-period');
    expect(r1d, `30m↔1d 的真实原因应为无公共锚点；实际 = ${String(r1d)}`).toBe('no-shared-anchor');

    expect(
      syncExclusionReason('30m', '1w'),
      "30m↔1w 的原因必须是 'week-requires-day-or-above'（真实原因，非泛化拒绝）",
    ).toBe('week-requires-day-or-above');
  });

  it('卫星 < 基准 的既有语义对 30m 同样成立（1h↔30m / 1d↔30m 拒绝）', () => {
    expect(syncExclusionReason('1h', '30m'), "卫星 30m < 基准 1h").toBe('satellite-lower-than-base');
    expect(syncExclusionReason('1d', '30m'), "卫星 30m < 基准 1d").toBe('satellite-lower-than-base');
    expect(isSyncCombinationAllowed('15m', '30m'), '15m→30m 必须放行').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 反向护栏：既有拒绝语义**未被放宽** + 既有 5 条密度值逐字不变
// ─────────────────────────────────────────────────────────────────────────────

describe('D2 · 反向护栏（既有语义不得放宽）', () => {
  it('既有 5 条实测密度值逐字不变（D2 只许**新增** 30m 的 4 条）', () => {
    for (const [key, val] of EXISTING_DENSITY_ENTRIES) {
      expect(
        MEASURED_DENSITY_TABLE[key],
        `既有实测条目 '${key}' 不得被改写；期望 ${val}`,
      ).toBe(val);
    }
    expect(
      Object.keys(MEASURED_DENSITY_TABLE).length,
      `D2 只许新增 30m 的 4 条（既有 5 条 + 4 = 9）；实际键 = ${JSON.stringify(Object.keys(MEASURED_DENSITY_TABLE))}`,
    ).toBe(9);
  });

  it('1m↔1d / 1m↔1w / 含 1mo 的既有拒绝**仍成立**', () => {
    expect(isSyncCombinationAllowed('1m', '1d'), '1m↔1d 恒退化，必须拒绝').toBe(false);
    expect(isSyncCombinationAllowed('1m', '1w'), '1m↔1w 恒退化，必须拒绝').toBe(false);
    expect(isSyncCombinationAllowed('15m', '1w'), '1w 需基准 ≥1d，必须拒绝').toBe(false);
    expect(syncExclusionReason('1m', '1w'), "1m↔1w 原因码必须保持 'week-requires-day-or-above'")
      .toBe('week-requires-day-or-above');
    expect(isSyncCombinationAllowed('1m', '1mo'), '1mo 不提供，必须拒绝').toBe(false);
    expect(syncExclusionReason('1m', '1mo'), "含 1mo 的原因码必须保持 'unsupported-period'")
      .toBe('unsupported-period');
    expect(syncExclusionReason('1m', '30x'), "未知周期原因码必须保持 'unsupported-period'")
      .toBe('unsupported-period');
  });

  it("既有口径 10 不得放宽：1h↔1w 仍拒绝（原因码 'week-requires-day-or-above'）", () => {
    expect(isSyncCombinationAllowed('1h', '1w'), '1w 需基准 ≥1d ⇒ 1h↔1w 必须拒绝').toBe(false);
    expect(syncExclusionReason('1h', '1w')).toBe('week-requires-day-or-above');
  });

  it('既有可用组合仍可用（D2 不得把守门收得更紧）', () => {
    // 注意：`1h↔1w` **不在**放行集合内 —— 既有口径 10「1w 需基准 ≥1d」（P0.3：1h 基准在 barSpace>11 即退化）
    for (const [b, s] of [['1m', '5m'], ['1m', '15m'], ['1m', '1h'], ['5m', '1h'], ['15m', '1h'], ['1d', '1w'], ['1m', '1m']] as const) {
      expect(isSyncCombinationAllowed(b, s), `既有放行组合 ${b}→${s} 不得被收窄`).toBe(true);
    }
  });
});
