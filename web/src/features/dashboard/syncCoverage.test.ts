/**
 * 287 — 「跨图同步在当前配置下静默失效」修复：**先红规格**（U1–U9）。
 *
 * 本文件位置：`web/src/features/dashboard/syncCoverage.test.ts`
 * 设计报告（契约钉死处）：`tester/design/287_sync_coverage_red_design.md`
 * 执行报告：`tester/test/287_sync_coverage_red.md`；证据：`tester/evidence/287_sync_red/`
 *
 * ── 缺陷事实（父级已核实；真实 console 原文 `tester/evidence/286_vol_acceptance/A6_zero_write.txt`）──
 * 用户配置 base=5m + 卫星 1h/1d；`ChartSyncGroup` 构造函数对每个卫星调用 `isSyncCombinationAllowed(base, sat)`，
 * 而该函数**只认实测密度表**（表内仅 `1m:5m / 1m:15m / 1m:1h / 1d:1w / 1h:1w`）⇒ `5m:1h` 不在表里 ⇒ 构造抛错：
 *   `[multi-period] ChartSyncGroup 未建立（周期组合不可用，禁止静默虚假对齐）
 *    Error: 多周期同步组合不可用：基准 5m ↔ 卫星 1h 恒退化/无重叠（禁止静默虚假对齐）`
 * ⇒ `chartSyncContext.ts` 的 try/catch 只 `console.warn` ⇒ **整组不建立 ⇒ 跨图同步完全失效**，
 * 且页面无任何可见提示（`syncDegraded` 仍 false）⇒「静默失效」。
 *
 * ── 修复口径（父级裁决，不得自行变更；本文件即其可执行判据）──
 *  A. 守门口径统一：`isSyncCombinationAllowed(base, sat)` 为 true 当且仅当「同周期 ∪ 实测表命中 ∪
 *     **同锚点合成可用**（`composeDensity(base, sat) !== null`）」；既有护栏全部不变（卫星 < 基准 ⇒ false；
 *     含 1mo/未知周期 ⇒ false；1w 需基准 ≥1d ⇒ false）。
 *  B. 组构建不再因单个卫星抛错：构造函数**不抛错**，把不可同步的卫星**从同步目标中排除**并记录周期与原因；
 *     仅「基准缺失」或「可同步成员 < 2」才不建立组，且该情形必须**显式上报**（不得只 console.warn）。
 *     硬约束不回退：基准永不作为 follower、重入抑制、有界闭环校正、诚实降级。
 *  C. 可观测（禁止静默）：被排除卫星周期列表 + 原因必须能从 `SyncStats` 读出（字段名见设计报告 §2）。
 *  D. 被排除的卫星在其它成员对齐时**完全不被写入**（不 setBarSpace、不 scroll、不 setOffsetRightDistance）。
 *
 * ── 本文件与既有测试的关系 ──
 * 既有 `chartSyncGroup.test.ts` / `chartSyncDensity.test.ts` **一字未改**（保持红基线干净）。
 * ⚠️ 已知冲突（本文件与既有断言的口径分歧，父级须裁决，详见执行报告「既有测试冲突」一节）：
 *  `chartSyncGroup.test.ts` 的 `T3-4`（`1m↔1w` 构造**必须抛错**）与修复口径 B（构造函数**不抛错**）
 *  在 `1m↔1w`（唯一卫星）这一输入上**不可同时成立**。本文件按父级裁决 B 钉死不抛错；该既有用例需在
 *  实现阶段由父级授权改写（本轮禁令：不得改既有测试）。
 *
 * 红原因分类（本阶段实测）：**断言失败**（U1/U4/U5/U6/U7/U9 红）；U2/U3/U8 为**绿侧防护**（不得回退）。
 */

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Chart } from 'klinecharts';
import * as syncGroupMod from './chartSyncGroup';
import { useChartSyncGroup } from './chartSyncContext';
import { createSyncChartStub, makeSeries, type SyncChartStub } from '@/test/syncChartStub';

// ─────────────────────────────────────────────────────────────────────────────
// 被测面（**局部接口**：红阶段实现尚未提供新导出/新字段；此处按设计报告 §2 的契约声明，
// 运行期为 undefined ⇒ 断言失败（**不是**模块缺失/语法/收集错误））
// ─────────────────────────────────────────────────────────────────────────────

interface SyncExclusionLike {
  period: string;
  reason: string;
}

interface FollowerDensityLike {
  ratio: number;
  source: 'measured' | 'static' | 'composed' | 'none';
}

interface CoverageStatsLike {
  applied: number;
  suppressed: number;
  echoEvents: number;
  degraded: boolean;
  degradedPeriod: string | null;
  lastSpanDiffMinutes: number | null;
  unalignedFollowers: number;
  lastUnalignedReason: string | null;
  /** 契约新增（C）：被排除的卫星周期 + 原因。 */
  excludedSatellites: SyncExclusionLike[];
  /** 契约新增：可同步的跟随者数（不含基准）。 */
  syncableFollowerCount: number;
  /** 契约新增：组是否建立（基准存在 且 基准+可同步跟随者 ≥ 2）。 */
  groupEstablished: boolean;
  /** 契约新增：未建立原因（建立 ⇒ null）。 */
  groupReason: 'missing-base' | 'no-syncable-follower' | null;
  /** 契约新增（U7）：最近一次对齐中各跟随者的有效密度比与来源（键 = 跟随者周期）。 */
  densityByFollower: Record<string, FollowerDensityLike>;
}

interface CoverageGroupLike {
  start(): void;
  stop(): void;
  scrollAllToLatest(): void;
  applySatelliteLimits(): void;
  readonly stats: CoverageStatsLike;
  onChange(cb: (stats: CoverageStatsLike) => void): () => void;
}

interface MemberLike {
  id: string;
  chart: SyncChartStub;
  period: string;
  isBase: boolean;
}

type CoverageGroupCtor = new (
  members: MemberLike[],
  options?: Record<string, unknown>,
) => CoverageGroupLike;

const ChartSyncGroup = syncGroupMod.ChartSyncGroup as unknown as CoverageGroupCtor;
const isSyncCombinationAllowed = syncGroupMod.isSyncCombinationAllowed;

type ComposeFn = (basePeriod: string, satellitePeriod: string) => number | null;

/** 契约（A）：`composeDensity` 必须可被测试**直接调用**（导出或等价可测入口）。 */
function requireComposeDensity(): ComposeFn {
  const fn = (syncGroupMod as unknown as { composeDensity?: ComposeFn }).composeDensity;
  expect(
    typeof fn,
    '契约（A）：`composeDensity(base, sat)` 必须导出/可测（同锚点密度合成；无公共锚点 ⇒ null）',
  ).toBe('function');
  return fn as ComposeFn;
}

// ─────────────────────────────────────────────────────────────────────────────
// 实测/合成密度锚定（不得重新发现：P0.3 `tester/test/260_p03_barspace_anchor_execution.md`）
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};
/** 实测密度表（P0.3 锚定；同周期 = 1）。 */
const MEASURED: Record<string, number> = {
  '1m:5m': 4.7,
  '1m:15m': 12.2,
  '1m:1h': 37.8,
  '1d:1w': 4.67,
  '1h:1w': 24,
};
/** 同锚点合成：D(5m→1h) = D(1m→1h)/D(1m→5m) = 37.8/4.7 ≈ 8.0426（契约 U7 的容差 = ±0.1）。 */
const COMPOSED_5M_1H = MEASURED['1m:1h']! / MEASURED['1m:5m']!;
const COMPOSED_5M_15M = MEASURED['1m:15m']! / MEASURED['1m:5m']!;
const COMPOSED_15M_1H = MEASURED['1m:1h']! / MEASURED['1m:15m']!;
const DENSITY_TOLERANCE = 0.1;

const END_TS = Date.UTC(2026, 8, 14, 7, 0, 0);
const PANE_WIDTH = 520;
const SATELLITE_MAX = 350;
/** 基准 barSpace 上限（ADR-020 严格；放宽只作用于卫星）。 */
const BASE_MAX = 50;

function bucketOf(period: string): number {
  const b = BUCKET_MS[period];
  if (b === undefined) throw new Error(`夹具未定义周期桶宽：${period}`);
  return b;
}

/** 基准实例桩（`barSpaceLimit{1,50}`，**不放宽**）；`spacingMs` 按实测/合成密度校准。 */
function baseChart(opts: {
  count: number;
  spacingMs: number;
  barSpace?: number;
}): SyncChartStub {
  return createSyncChartStub({
    bars: makeSeries({ count: opts.count, spacingMs: opts.spacingMs, endTs: END_TS }),
    paneWidthPx: PANE_WIDTH,
    barSpace: opts.barSpace ?? 8,
    limit: { min: 1, max: BASE_MAX },
  });
}

/** 卫星实例桩（等间隔 = 该周期桶宽；`barSpaceLimit` 放宽到 350；右偏移默认 8 根）。 */
function satChart(opts: {
  period: string;
  count?: number;
  barSpace?: number;
  offsetRightBars?: number;
}): SyncChartStub {
  return createSyncChartStub({
    bars: makeSeries({ count: opts.count ?? 120, spacingMs: bucketOf(opts.period), endTs: END_TS }),
    paneWidthPx: PANE_WIDTH,
    barSpace: opts.barSpace ?? 10,
    limit: { min: 1, max: SATELLITE_MAX },
    offsetRightBars: opts.offsetRightBars ?? 8,
  });
}

function member(chart: SyncChartStub, period: string, isBase: boolean): MemberLike {
  return { id: isBase ? `base:${period}` : `sat:${period}`, chart, period, isBase };
}

/** 构造组：**把「构造函数抛错」转成断言失败**（红原因必须是断言，而不是运行时异常）。 */
function buildGroup(members: MemberLike[], options?: Record<string, unknown>): CoverageGroupLike {
  let group: CoverageGroupLike | null = null;
  let error: unknown = null;
  try {
    group = new ChartSyncGroup(members, options);
  } catch (e) {
    error = e;
  }
  expect(
    error,
    '契约（B）：`ChartSyncGroup` 构造函数**不得抛错**（不可同步卫星应被排除并记录，而非整组失败 ⇒ 静默失效）',
  ).toBeNull();
  expect(group, '契约（B）：构造必须返回可用的组对象').not.toBeNull();
  return group as CoverageGroupLike;
}

function startGroup(g: CoverageGroupLike): void {
  let error: unknown = null;
  try {
    g.start();
  } catch (e) {
    error = e;
  }
  expect(error, '契约（B）：`start()` 不得抛错').toBeNull();
}

function stopGroup(g: CoverageGroupLike): void {
  let error: unknown = null;
  try {
    g.stop();
  } catch (e) {
    error = e;
  }
  expect(error, '契约（B）：`stop()` 不得抛错（组未建立时同样不得抛错）').toBeNull();
}

/** 断言「被排除的卫星」快照形状可读（形状不合 ⇒ 断言失败，而不是后续 TypeError）。 */
function readExcluded(stats: CoverageStatsLike): SyncExclusionLike[] {
  const value = stats.excludedSatellites;
  expect(Array.isArray(value), '契约（C）：`stats.excludedSatellites` 必须可读出（数组）').toBe(true);
  for (const e of value as SyncExclusionLike[]) {
    expect(typeof e.period, '契约（C）：被排除项必须带周期').toBe('string');
    expect(typeof e.reason, '契约（C）：被排除项必须带原因（原因可读）').toBe('string');
  }
  return value as SyncExclusionLike[];
}

/** 写入调用面（D）：被排除的卫星在这四个方法上必须**一次都没有被调用**。 */
const WRITE_METHODS = [
  'setBarSpace',
  'scrollToDataIndex',
  'scrollToTimestamp',
  'setOffsetRightDistance',
] as const;

function writeCalls(stub: SyncChartStub): string[] {
  return stub.__log
    .filter((c) => (WRITE_METHODS as readonly string[]).includes(c.method))
    .map((c) => c.method);
}

/** 被排除卫星的基线切片（用于「原样不动」的反向断言）。 */
function slice(stub: SyncChartStub): { barSpace: number; range: unknown; offset: number } {
  return {
    barSpace: stub.getBarSpace().bar,
    range: stub.getVisibleRange(),
    offset: stub.getOffsetRightDistance(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// U1–U3：守门口径（纯函数面）
// ═════════════════════════════════════════════════════════════════════════════

describe('287 跨图同步覆盖（红：当前配置 5m+1h/1d 静默失效）', () => {
  it('U1 合成可用即放行：isSyncCombinationAllowed(5m,15m)/(5m,1h)/(15m,1h) === true（当前均 false ⇒ 必红）', () => {
    // 现状：三对均不在实测表内 ⇒ false ⇒ 用户配置（base=5m + 1h）构造即抛错 ⇒ 整组静默失效。
    expect(
      isSyncCombinationAllowed('5m', '15m'),
      '同锚点合成 D(1m→15m)/D(1m→5m) ≈ 2.596 可用 ⇒ 必须放行',
    ).toBe(true);
    expect(
      isSyncCombinationAllowed('5m', '1h'),
      '同锚点合成 D(1m→1h)/D(1m→5m) ≈ 8.043 可用 ⇒ 必须放行（**本缺陷的直接判据**）',
    ).toBe(true);
    expect(
      isSyncCombinationAllowed('15m', '1h'),
      '同锚点合成 D(1m→1h)/D(1m→15m) ≈ 3.098 可用 ⇒ 必须放行',
    ).toBe(true);
  });

  it('U1-2 契约（A）：composeDensity 可直接调用，返回值 = 同锚点合成比（无公共锚点 ⇒ null）', () => {
    const composeDensity = requireComposeDensity();

    const pairs: Array<{ base: string; sat: string; expected: number }> = [
      { base: '5m', sat: '15m', expected: COMPOSED_5M_15M },
      { base: '5m', sat: '1h', expected: COMPOSED_5M_1H },
      { base: '15m', sat: '1h', expected: COMPOSED_15M_1H },
      { base: '1d', sat: '1w', expected: MEASURED['1d:1w']! }, // 表内组合也可由同锚点（1d）还原
      { base: '1m', sat: '1m', expected: 1 },
    ];
    for (const p of pairs) {
      const got = composeDensity(p.base, p.sat);
      expect(typeof got, `composeDensity(${p.base},${p.sat}) 必须返回数值（可用）`).toBe('number');
      expect(
        Math.abs((got ?? Number.NaN) - p.expected) <= DENSITY_TOLERANCE,
        `composeDensity(${p.base},${p.sat}) ≈ ${p.expected}（容差 ±${DENSITY_TOLERANCE}）；实测 ${String(got)}`,
      ).toBe(true);
    }

    for (const pair of [
      ['5m', '1d'],
      ['15m', '1d'],
      ['1m', '1d'],
      ['1h', '1d'],
      ['5m', '1w'],
      ['1m', '1w'],
    ] as const) {
      expect(
        composeDensity(pair[0], pair[1]),
        `composeDensity(${pair[0]},${pair[1]}) 无公共锚点 ⇒ 必须 null（真无重叠，不得合成）`,
      ).toBeNull();
    }
  });

  it('U2 无公共锚点仍拒绝：(5m,1d)/(15m,1d)/(1m,1d)/(1h,1d) 均为 false（绿侧防护，不得回退）', () => {
    for (const pair of [
      ['5m', '1d'],
      ['15m', '1d'],
      ['1m', '1d'],
      ['1h', '1d'],
    ] as const) {
      expect(
        isSyncCombinationAllowed(pair[0], pair[1]),
        `${pair[0]}↔${pair[1]} 真无重叠（无同锚点合成）⇒ 必须继续拒绝`,
      ).toBe(false);
    }
  });

  it('U3 既有护栏不回退（绿侧防护）：卫星<基准 / 含 1mo / 1w 需基准≥1d / 同周期 / 表内组合', () => {
    // 卫星周期 < 基准 ⇒ false
    expect(isSyncCombinationAllowed('5m', '1m')).toBe(false);
    expect(isSyncCombinationAllowed('1h', '15m')).toBe(false);
    expect(isSyncCombinationAllowed('1d', '1h')).toBe(false);
    // 含 1mo / 未知周期 ⇒ false
    expect(isSyncCombinationAllowed('1m', '1mo')).toBe(false);
    expect(isSyncCombinationAllowed('1d', '1mo')).toBe(false);
    expect(isSyncCombinationAllowed('1mo', '1w')).toBe(false);
    expect(isSyncCombinationAllowed('1m', '2h')).toBe(false);
    // 1w ⇒ 基准必须 ≥1d（不得因「同锚点合成」而放宽）
    expect(isSyncCombinationAllowed('1m', '1w')).toBe(false);
    expect(isSyncCombinationAllowed('5m', '1w')).toBe(false);
    expect(isSyncCombinationAllowed('15m', '1w')).toBe(false);
    expect(isSyncCombinationAllowed('1h', '1w')).toBe(false);
    // 同周期 ⇒ true
    for (const p of ['1m', '5m', '15m', '1h', '1d', '1w']) {
      expect(isSyncCombinationAllowed(p, p), `${p}↔${p} 同周期必须放行`).toBe(true);
    }
    // 实测表内组合 ⇒ true（含 1h↔1w：表内，且基准 1h < 1d ⇒ 被 1w 护栏拒绝）
    expect(isSyncCombinationAllowed('1m', '5m')).toBe(true);
    expect(isSyncCombinationAllowed('1m', '15m')).toBe(true);
    expect(isSyncCombinationAllowed('1m', '1h')).toBe(true);
    expect(isSyncCombinationAllowed('1d', '1w')).toBe(true);
    expect(isSyncCombinationAllowed('1h', '1w'), '1w 需基准 ≥1d（口径 10 不得因合成放宽）').toBe(false);
  });

  it('U3-2 （补充）构造期排除原因码可读且优先级固定：卫星<基准 / 1w 需基准≥1d', () => {
    // 契约（C）原因码优先级：unsupported-period > satellite-lower-than-base > week-requires-day-or-above > no-shared-anchor
    const lower = buildGroup([member(satChart({ period: '5m' }), '5m', true), member(satChart({ period: '1m' }), '1m', false)]);
    expect(readExcluded(lower.stats)).toEqual([{ period: '1m', reason: 'satellite-lower-than-base' }]);
    stopGroup(lower);

    const week = buildGroup([member(satChart({ period: '1m' }), '1m', true), member(satChart({ period: '1w' }), '1w', false)]);
    expect(readExcluded(week.stats)).toEqual([{ period: '1w', reason: 'week-requires-day-or-above' }]);
    stopGroup(week);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // U4–U8：组构建 / 可观测 / 零写入 / 密度来源 / 基准护栏（行为面）
  // ═══════════════════════════════════════════════════════════════════════════

  it('U4 构造不抛错：base=5m + [1h,1d] ⇒ 构造/start/stop 成功；排除列表含 1d、不含 1h；原因可读', () => {
    // 用户真实配置形态（286 证据：periods ["5m","1h","1d"]）。
    const base = baseChart({ count: 400, spacingMs: bucketOf('1h') / COMPOSED_5M_1H });
    const sat1h = satChart({ period: '1h' });
    const sat1d = satChart({ period: '1d' });

    const g = buildGroup([member(base, '5m', true), member(sat1h, '1h', false), member(sat1d, '1d', false)]);
    startGroup(g);

    const excluded = readExcluded(g.stats);
    expect(excluded.map((e) => e.period)).toEqual(['1d']);
    expect(excluded.some((e) => e.period === '1h'), '1h 与 5m 同锚点（合成可用）⇒ **不得**被排除').toBe(false);
    expect(
      excluded.find((e) => e.period === '1d')?.reason,
      '5m↔1d 无公共锚点（真无重叠）⇒ 原因码必须可读',
    ).toBe('no-shared-anchor');
    expect(g.stats.syncableFollowerCount, '可同步跟随者 = 1（1h）').toBe(1);
    expect(g.stats.groupEstablished, '基准 5m + 1h 可同步 ⇒ 组必须建立').toBe(true);
    expect(g.stats.groupReason, '已建立 ⇒ groupReason 必须 null').toBeNull();

    stopGroup(g);
    expect(readExcluded(g.stats), 'stop() 后统计仍可读（组对象未销毁前不抛错）').toEqual(excluded);
  });

  it('U5 无可同步跟随者：base=5m + 仅卫星 1d ⇒ 不抛错，且「无可同步跟随者」作为可观测状态可读', () => {
    const base = baseChart({ count: 400, spacingMs: bucketOf('1h') / COMPOSED_5M_1H });
    const sat1d = satChart({ period: '1d' });

    const g = buildGroup([member(base, '5m', true), member(sat1d, '1d', false)]);
    startGroup(g);

    expect(readExcluded(g.stats)).toEqual([{ period: '1d', reason: 'no-shared-anchor' }]);
    expect(g.stats.syncableFollowerCount, '无可同步跟随者').toBe(0);
    expect(g.stats.groupEstablished, '可同步成员 < 2 ⇒ 不得建立组').toBe(false);
    expect(
      g.stats.groupReason,
      '「整组未建立」必须**显式上报**（不得只 console.warn）：no-syncable-follower',
    ).toBe('no-syncable-follower');
    stopGroup(g);
  });

  it('U5-2 （补充）基准缺失：无 isBase 成员 ⇒ 不抛错，且 groupReason === "missing-base"', () => {
    const sat5m = satChart({ period: '5m' });
    const g = buildGroup([member(sat5m, '5m', false)]);
    startGroup(g);

    expect(g.stats.groupEstablished, '无基准 ⇒ 不得建立组').toBe(false);
    expect(g.stats.groupReason, '基准缺失必须显式上报').toBe('missing-base');
    expect(g.stats.syncableFollowerCount).toBe(0);
    stopGroup(g);
  });

  it('U6 被排除成员零写入：对齐发生时 excluded 卫星的写方法一次都没被调用，而同组可同步卫星被调用', () => {
    const base = baseChart({ count: 400, spacingMs: bucketOf('1h') / COMPOSED_5M_1H });
    const sat1h = satChart({ period: '1h' });
    const sat1d = satChart({ period: '1d', count: 200 });
    const excludedBefore = slice(sat1d);

    const g = buildGroup([member(base, '5m', true), member(sat1h, '1h', false), member(sat1d, '1d', false)]);
    startGroup(g);

    // 用户在**基准**上左右移动 ⇒ 组对齐其余可同步成员
    base.scrollToDataIndex(380);

    expect(
      writeCalls(sat1d),
      '契约（D）：被排除的卫星不得被写入（setBarSpace/scrollToDataIndex/scrollToTimestamp/setOffsetRightDistance 必须全为 0 次）',
    ).toEqual([]);
    expect(slice(sat1d), '被排除卫星的 barSpace/可见范围/右偏移必须原样不动').toEqual(excludedBefore);

    const syncWrites = writeCalls(sat1h);
    expect(syncWrites.includes('setBarSpace'), '可同步卫星必须被写入 barSpace').toBe(true);
    expect(
      syncWrites.some((m) => m === 'scrollToDataIndex' || m === 'scrollToTimestamp'),
      '可同步卫星必须被定位（scrollToDataIndex/scrollToTimestamp）',
    ).toBe(true);

    // 在**被排除**的卫星上发生交互 ⇒ 它自身仍不得被写入
    sat1d.__fireAction('onScroll');
    expect(writeCalls(sat1d), '被排除卫星的交互不得导致其自身被写入').toEqual([]);
    stopGroup(g);
  });

  it('U7 密度来源可观测：base=5m + 卫星 1h 的对齐使用**合成**密度（≈8.04），且 barSpace 由它推导', () => {
    const base = baseChart({ count: 400, spacingMs: bucketOf('1h') / COMPOSED_5M_1H });
    const sat1h = satChart({ period: '1h' });

    const g = buildGroup([member(base, '5m', true), member(sat1h, '1h', false)]);
    startGroup(g);
    base.scrollToDataIndex(380);

    const readings = g.stats.densityByFollower;
    expect(
      readings && typeof readings === 'object',
      '契约（U7）：`stats.densityByFollower` 必须可读出（键 = 跟随者周期）',
    ).toBe(true);
    const reading = (readings as Record<string, FollowerDensityLike> | undefined)?.['1h'];
    expect(reading, 'base=5m + 跟随者 1h 的密度读数必须可读').toBeDefined();
    expect(
      reading?.source,
      '来源必须可区分：`5m↔1h` 只能来自**同锚点合成**（实测表内无此组合）',
    ).toBe('composed');
    expect(
      Math.abs((reading?.ratio ?? Number.NaN) - COMPOSED_5M_1H) <= DENSITY_TOLERANCE,
      `合成密度必须 ≈ ${COMPOSED_5M_1H}（容差 ±${DENSITY_TOLERANCE}）；实测 ${String(reading?.ratio)}`,
    ).toBe(true);
    // 推导量证据：satBS = round(baseBS × 密度) = round(8 × 8.0426) = 64（**不得**是名义比 12 的 96）
    expect(base.getBarSpace().bar).toBe(8);
    expect(
      sat1h.getBarSpace().bar,
      'satBS 必须由合成密度推导（round(8×8.0426)=64）；若按名义比 12 ⇒ 96、若按实测表缺失 ⇒ 不建组',
    ).toBe(64);
    stopGroup(g);
  });

  it('U7-2 来源可区分（static vs composed）：表内组合 1m→5m 的读数来源必须是 static', () => {
    const base = baseChart({ count: 900, spacingMs: bucketOf('5m') / MEASURED['1m:5m']! });
    const sat5m = satChart({ period: '5m' });

    const g = buildGroup([member(base, '1m', true), member(sat5m, '5m', false)]);
    startGroup(g);
    base.scrollToDataIndex(830);

    const readings = g.stats.densityByFollower as Record<string, FollowerDensityLike> | undefined;
    const reading = readings?.['5m'];
    expect(reading, '表内组合的密度读数必须可读').toBeDefined();
    expect(reading?.source, '实测表命中 ⇒ source 必须是 static（与 composed 可区分）').toBe('static');
    expect(reading?.source, '不得把表内命中误标为 composed/measured').not.toBe('composed');
    expect(Math.abs((reading?.ratio ?? Number.NaN) - 4.7) <= DENSITY_TOLERANCE).toBe(true);
    expect(sat5m.getBarSpace().bar, 'satBS = round(8 × 4.7) = 38').toBe(38);
    stopGroup(g);
  });

  it('U8 基准永不作为 follower（绿侧防护）：卫星做 leader ⇒ 基准 barSpace/视口/右偏移逐字段不变', () => {
    const base = baseChart({ count: 900, spacingMs: bucketOf('5m') / MEASURED['1m:5m']! });
    const sat5m = satChart({ period: '5m' });
    const sat15m = satChart({ period: '15m' });
    const baseBefore = slice(base);

    const g = buildGroup([
      member(base, '1m', true),
      member(sat5m, '5m', false),
      member(sat15m, '15m', false),
    ]);
    startGroup(g);

    // 用户在**卫星**上移动 ⇒ 该卫星为 leader，仅对齐其它卫星；基准保持不动（ADR-020）
    sat5m.scrollToDataIndex(60);

    expect(slice(base), '基准的 barSpace/可见范围/右偏移必须逐字段不变（不得被卫星同步反向改写）').toEqual(
      baseBefore,
    );
    expect(
      writeCalls(base).includes('setBarSpace'),
      '基准不得被写入 barSpace（尤其不得被写成密度推导值或上限 50）',
    ).toBe(false);
    expect(
      writeCalls(sat15m).some((m) => m === 'setBarSpace' || m === 'scrollToDataIndex' || m === 'scrollToTimestamp'),
      '其它可同步卫星必须照常被对齐',
    ).toBe(true);
    expect(g.stats.echoEvents, '不得出现回声（重入抑制硬约束）').toBe(0);
    expect(g.stats.suppressed, '重入必须被抑制并计数（重入抑制硬约束）').toBeGreaterThan(0);
    stopGroup(g);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U9（接线补充）：`useChartSyncGroup` 必须**显式上报**不可同步配置（禁止只 console.warn）
// ═════════════════════════════════════════════════════════════════════════════

describe('287 接线层：不可同步配置必须显式上报（chartSyncContext）', () => {
  it('U9 base=5m + [1h,1d] ⇒ onStats 必须广播（含 excludedSatellites / groupEstablished），且先于任何交互', () => {
    const base = baseChart({ count: 400, spacingMs: bucketOf('1h') / COMPOSED_5M_1H });
    const sat1h = satChart({ period: '1h' });
    const sat1d = satChart({ period: '1d' });

    const snapshots: CoverageStatsLike[] = [];
    const { result } = renderHook(() =>
      useChartSyncGroup({ onStats: (stats) => snapshots.push(stats as CoverageStatsLike) }),
    );

    act(() => {
      result.current.register({ chart: base as unknown as Chart, period: '5m', isBase: true });
    });
    act(() => {
      result.current.register({ chart: sat1h as unknown as Chart, period: '1h', isBase: false });
    });
    act(() => {
      result.current.register({ chart: sat1d as unknown as Chart, period: '1d', isBase: false });
    });

    const last = snapshots[snapshots.length - 1];
    expect(
      last,
      '契约（C）：组（重）建后必须**至少广播一次**统计快照（否则页面无法在交互前显示「未同步/未建立」）',
    ).toBeDefined();
    expect(readExcluded(last as CoverageStatsLike)).toEqual([{ period: '1d', reason: 'no-shared-anchor' }]);
    expect((last as CoverageStatsLike).groupEstablished, '1h 可同步 ⇒ 组建立').toBe(true);
    expect((last as CoverageStatsLike).syncableFollowerCount).toBe(1);
  });

  it('U9-2 base=5m + 仅卫星 1d ⇒ onStats 必须上报「整组未建立」原因（禁止静默）', () => {
    const base = baseChart({ count: 400, spacingMs: bucketOf('1h') / COMPOSED_5M_1H });
    const sat1d = satChart({ period: '1d' });

    const snapshots: CoverageStatsLike[] = [];
    const { result } = renderHook(() =>
      useChartSyncGroup({ onStats: (stats) => snapshots.push(stats as CoverageStatsLike) }),
    );

    act(() => {
      result.current.register({ chart: base as unknown as Chart, period: '5m', isBase: true });
    });
    act(() => {
      result.current.register({ chart: sat1d as unknown as Chart, period: '1d', isBase: false });
    });

    const last = snapshots[snapshots.length - 1];
    expect(last, '组未建立同样必须广播（不得只 console.warn）').toBeDefined();
    expect((last as CoverageStatsLike).groupEstablished).toBe(false);
    expect((last as CoverageStatsLike).groupReason).toBe('no-syncable-follower');
    expect(readExcluded(last as CoverageStatsLike)).toEqual([{ period: '1d', reason: 'no-shared-anchor' }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U10（页面级 DOM 契约，补充）：被排除卫星 / 「整组未建立」必须有**页面可见状态**（口径 C）
//   · U10-H 是**夹具自检**（绿侧）：允许的组合（1m + 5m/15m）走同一条链路 ⇒ 卫星确实被写入，
//     证明「基准 registrar → stack provider → 卫星 KlineChart → 真 ChartSyncGroup → 写入」整链可用；
//   · U10 / U10-2 是**红侧**：排除态必须在页面上可见（禁止静默）。
// ═════════════════════════════════════════════════════════════════════════════

const KH = vi.hoisted(() => ({ stubs: [] as any[], initArgs: [] as any[] }));

vi.mock('klinecharts', async () => {
  const { createSyncChartStub } = await import('@/test/syncChartStub');
  const { createChartStoreStub } = await import('@/test/chartStoreStub');
  return {
    init: vi.fn((el: unknown, options?: any) => {
      // 卫星 `barSpaceLimit` 在 init 放宽（口径 9）；未放宽 ⇒ 大 barSpace 被静默吞掉。
      const max = options?.layout?.barSpaceLimit?.max;
      const sync: any = createSyncChartStub({
        bars: [],
        paneWidthPx: PANE_WIDTH,
        barSpace: 10,
        limit: { min: 1, max: typeof max === 'number' ? max : BASE_MAX },
      });
      const runInit = () => {
        const loader: any = sync.__loader;
        if (!loader?.getBars) return;
        void loader.getBars({
          type: 'init',
          callback: (list: Array<{ timestamp?: number; ts?: string }> = []) => {
            const ts = list
              .map((b) => (typeof b.timestamp === 'number' ? b.timestamp : Date.parse(String(b.ts))))
              .filter((n) => Number.isFinite(n))
              .sort((a, b) => a - b);
            sync.__bars.length = 0;
            sync.__bars.push(...ts);
            sync.__setRightIndex(ts.length - 1);
          },
        });
      };
      const merged: any = {
        ...createChartStoreStub(),
        overrideIndicator: vi.fn(),
        resetData: vi.fn(),
        setStyles: vi.fn(),
        resize: vi.fn(),
        setPaneOptions: vi.fn(),
        convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
        createOverlay: vi.fn(),
        removeOverlay: vi.fn(),
        ...sync, // 同步面（barSpace / 索引窗 / 事件）以忠实桩为准
        setDataLoader: vi.fn((l: unknown) => {
          sync.__loader = l;
          runInit();
        }),
        setSymbol: vi.fn(() => runInit()),
        setPeriod: vi.fn(() => runInit()),
      };
      KH.stubs.push(merged);
      KH.initArgs.push(el);
      return merged;
    }),
    dispose: vi.fn(),
    registerIndicator: vi.fn(),
  };
});

import { createElement, useEffect } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { Period } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { resetRealtimePollGateForTest } from './realtimePoll';
import { MultiPeriodChartStack } from './MultiPeriodChartStack';
import { useChartSyncRegistry } from './chartSyncContext';

/** 基准 pane 的**注册代理**（页面里由 `KlineChart` 承担；此处只注入一个忠实同步桩）。 */
function BaseRegistrar(props: { chart: SyncChartStub; period: string }): null {
  const registry = useChartSyncRegistry();
  useEffect(
    () => registry.register({ chart: props.chart as unknown as Chart, period: props.period, isBase: true }),
    [registry, props.chart, props.period],
  );
  return null;
}

function toApiBars(tsList: number[]) {
  return tsList.map((ts, i) => ({
    ts: new Date(ts).toISOString(),
    open: 1 + i * 0.001,
    high: 1.1 + i * 0.001,
    low: 0.9 + i * 0.001,
    close: 1.05 + i * 0.001,
    volume: 100,
    amount: 105,
  }));
}

function fakeCoverageApi(): ApiClient {
  const byPeriod: Record<string, number[]> = {
    '1h': makeSeries({ count: 120, spacingMs: bucketOf('1h'), endTs: END_TS }),
    '1d': makeSeries({ count: 120, spacingMs: bucketOf('1d'), endTs: END_TS }),
    '5m': makeSeries({ count: 300, spacingMs: bucketOf('5m'), endTs: END_TS }),
    '15m': makeSeries({ count: 200, spacingMs: bucketOf('15m'), endTs: END_TS }),
  };
  const getKline = vi.fn(async (q: { period?: string }) => toApiBars(byPeriod[q.period ?? ''] ?? []));
  return {
    ...stubApi({
      getKline: getKline as unknown as ApiClient['getKline'],
      getKlineConfig: vi.fn(async () => ({ viewport_bars: 120 })) as unknown as ApiClient['getKlineConfig'],
    }),
  } as ApiClient;
}

function fakeCoverageWs(): WsClient {
  const handlers = new Map<string, Set<(m: unknown) => void>>();
  return {
    subscribe: vi.fn((topic: string, h: (m: unknown) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
  } as unknown as WsClient;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/**
 * 越过重入/程序化**抑制窗**（`SUPPRESSION_WINDOW_MS = 16`）：挂载期卫星自身的 init 事件会先触发一次
 * 对齐并打开抑制窗；紧随其后的用户手势会被吞（`handleEvent` 的 suppressUntil 分支）⇒ 夹具必须在
 * 手势前等待 > 16ms，否则「基准手势 → 卫星被写入」这条判据不成立（**实测发现，P3 既有语义，非缺陷**）。
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

const COVERAGE_INDICATORS = {
  ma: false,
  vol: false,
  macd: false,
  kdj: false,
  boll: false,
  dcap: false,
} as unknown as Record<'ma' | 'vol' | 'macd' | 'kdj' | 'boll' | 'dcap', boolean>;

function renderStack(opts: {
  basePeriod: string;
  baseSpacingMs: number;
  baseCount: number;
  satellitePeriods: Array<{ period: Period; height: number }>;
}): { container: HTMLElement; base: SyncChartStub; unmount: () => void } {
  const base = baseChart({ count: opts.baseCount, spacingMs: opts.baseSpacingMs });
  const view = render(
    createElement(
      MemoryRouter,
      null,
      createElement(
        MultiPeriodChartStack,
        {
          enabled: true,
          satellites: opts.satellitePeriods,
          api: fakeCoverageApi(),
          ws: fakeCoverageWs(),
          code: '518880',
          indicators: COVERAGE_INDICATORS,
          basePeriod: opts.basePeriod,
          basePeriodSource: 'config',
          baseHeight: 420,
          followLatest: false,
        } as never,
        createElement(BaseRegistrar, { chart: base, period: opts.basePeriod }),
      ),
    ),
  );
  return { container: view.container, base, unmount: () => view.unmount() };
}

describe('287 页面级可见状态（口径 C：禁止静默）', () => {
  beforeEach(() => {
    KH.stubs.length = 0;
    KH.initArgs.length = 0;
    resetRealtimePollGateForTest();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => PANE_WIDTH,
    });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  it('U10-H （夹具自检，绿侧）允许组合 1m + 5m/15m：页面链路把两卫星都写入（证明夹具可用）', async () => {
    const { container, base, unmount } = renderStack({
      basePeriod: '1m',
      baseCount: 900,
      baseSpacingMs: bucketOf('5m') / MEASURED['1m:5m']!,
      satellitePeriods: [
        { period: '5m', height: 180 },
        { period: '15m', height: 180 },
      ],
    });
    await flush();

    // 夹具前置：2 个卫星 pane 渲染、卫星取数/init 正常（否则后续断言无意义）
    expect(container.querySelectorAll('[data-mp-satellite]').length, '夹具前置：2 个卫星 pane').toBe(2);
    expect(container.querySelector('[data-mp-satellite-error]'), '夹具前置：卫星 init/取数正常').toBeNull();
    expect(KH.stubs.length, '夹具前置：2 个卫星 chart 已 init').toBe(2);

    const sats = KH.stubs.map((s) => s as SyncChartStub);
    await settle(); // 越过挂载期对齐打开的抑制窗（否则紧接的手势被吞，判据不成立）
    const before = sats.map((s) => writeCalls(s).length);

    // 用户在基准上移动 ⇒ 两个卫星都必须被写入（整链：registrar → provider → group → 写入）
    await act(async () => {
      base.scrollToDataIndex(830);
    });
    await flush(2);

    for (let i = 0; i < sats.length; i++) {
      expect(
        writeCalls(sats[i] as SyncChartStub).length,
        `夹具自检：卫星 #${i} 必须被同步写入（否则页面级夹具不成立）`,
      ).toBeGreaterThan(before[i] ?? 0);
    }
    unmount();
  });

  it('U10 base=5m + [1h,1d]：被排除卫星（1d）必须有可见角标（含周期与原因），1h 不得有', async () => {
    const { container, unmount } = renderStack({
      basePeriod: '5m',
      baseCount: 400,
      baseSpacingMs: bucketOf('1h') / COMPOSED_5M_1H,
      satellitePeriods: [
        { period: '1h', height: 180 },
        { period: '1d', height: 180 },
      ],
    });
    await flush(8);

    expect(container.querySelectorAll('[data-mp-satellite]').length, '夹具前置：2 个卫星 pane').toBe(2);
    expect(container.querySelector('[data-mp-satellite-error]')).toBeNull();

    const badge = container.querySelector<HTMLElement>('[data-mp-sync-excluded="1d"]');
    expect(
      badge,
      '口径 C：被排除的卫星必须渲染**可见角标**（`[data-mp-sync-excluded="<period>"]`，不得静默）',
    ).not.toBeNull();
    expect(
      badge?.getAttribute('data-mp-sync-excluded-reason'),
      '口径 C：角标必须带可读原因（原因码）',
    ).toBe('no-shared-anchor');
    expect(badge?.textContent ?? '', '口径 C：角标文案必须表明该周期未参与跨图同步').toMatch(/未同步/);
    expect(
      badge?.getAttribute('title') ?? '',
      '口径 C：hover 原因必须可行动（提示改选周期）',
    ).toMatch(/周期/);
    expect(
      container.querySelector('[data-mp-sync-excluded="1h"]'),
      '1h 与 5m 同锚点合成可用 ⇒ 不得出现「未同步」角标',
    ).toBeNull();
    expect(
      container.querySelector('[data-mp-sync-group-unestablished]'),
      '组已建立（5m+1h 可同步）⇒ 不得出现「整组未建立」状态',
    ).toBeNull();
    unmount();
  });

  it('U10-2 base=5m + 仅卫星 1d：整组未建立也必须有页面可见状态（含原因）', async () => {
    const { container, unmount } = renderStack({
      basePeriod: '5m',
      baseCount: 400,
      baseSpacingMs: bucketOf('1h') / COMPOSED_5M_1H,
      satellitePeriods: [{ period: '1d', height: 180 }],
    });
    await flush(8);

    expect(container.querySelectorAll('[data-mp-satellite]').length, '夹具前置：1 个卫星 pane').toBe(1);
    const state = container.querySelector<HTMLElement>('[data-mp-sync-group-unestablished]');
    expect(
      state,
      '口径 C：「整组未建立」必须有页面可见状态（`[data-mp-sync-group-unestablished]`，不得静默）',
    ).not.toBeNull();
    expect(
      state?.getAttribute('data-mp-sync-group-reason'),
      '口径 C：未建立原因必须可读',
    ).toBe('no-syncable-follower');
    expect(
      container.querySelector('[data-mp-sync-excluded="1d"]'),
      '被排除的卫星同样必须可见（含周期）',
    ).not.toBeNull();
    unmount();
  });
});
