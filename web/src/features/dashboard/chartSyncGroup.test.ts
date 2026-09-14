/**
 * 红测试（P3-A）：**T3（G1 同步无漂移）/ T4（回到最新 + 尊重手动视口）/ T8bis（诚实降级）**
 * —— `ChartSyncGroup` 的行为/契约面（jsdom + 忠实桩 `src/test/syncChartStub.ts`）。
 *
 * 本文件位置：`web/src/features/dashboard/chartSyncGroup.test.ts`
 * 权威依据：
 *  - `design/15-multi-period/01-adr.md` §2.3（同步原语：无 `setVisibleRange`；重入抑制；仅卫星放宽上限）
 *  - `design/15-multi-period/02-spec.md` §3.1（API）、§3.2（对齐算法 + 卫星 ≥2 bar + 降级）、§3.3（重入抑制）、§3.6（实现要点）
 *  - `design/15-multi-period/03-test-plan.md` T3 / T4 / T8bis（G1 门禁）
 *  - 实测锚定（勿重新发现）：`tester/test/260_p03_barspace_anchor_execution.md`（P0.3）、
 *    `tester/evidence/250_multiperiod_route_probe/p7b2_result.json`（P7b：单次滚动 `reentrantCalls=1`）
 *  - 本文件的设计报告：`tester/design/272_p3_sync_red_design.md`（钉死 API 与 2 处口径澄清）
 *
 * 预期 red 理由：**`web/src/features/dashboard/chartSyncGroup.ts` 尚不存在**（P3 实现未开始）。
 *
 * 真实 klinecharts 的几何/事件（右缘对齐、越界静默、NaN 视口）由
 * `web/tester/p3-sync-harness/`（Playwright + 真身 UMD）取证；本文件的桩只复刻**调用面语义**。
 */

import { describe, expect, it } from 'vitest';
import { createSyncChartStub, makeSeries, type SyncChartStub } from '@/test/syncChartStub';

const SYNC_SPECIFIER: string = './chartSyncGroup';

interface SyncMemberLike {
  id: string;
  chart: SyncChartStub;
  period: string;
  isBase: boolean;
}

interface SyncStatsLike {
  applied: number;
  suppressed: number;
  echoEvents: number;
  lastSpanDiffMinutes: number | null;
  degraded: boolean;
  degradedPeriod: string | null;
}

interface SyncGroupLike {
  start(): void;
  stop(): void;
  scrollAllToLatest(): void;
  applySatelliteLimits(): void;
  readonly stats: SyncStatsLike;
  onChange(cb: (stats: SyncStatsLike) => void): () => void;
}

type SyncGroupCtor = new (
  members: SyncMemberLike[],
  options?: Record<string, unknown>,
) => SyncGroupLike;

async function loadGroup(): Promise<SyncGroupCtor> {
  const mod = (await import(/* @vite-ignore */ SYNC_SPECIFIER)) as { ChartSyncGroup: SyncGroupCtor };
  return mod.ChartSyncGroup;
}

// ─────────────────────────────────────────────────────────────────────────────
// 合成夹具：**按 P0.3 的实测密度比 D 校准**（base 间隔 = satBucket / D；两侧覆盖同一日历跨度）
// 说明：真实 A 股日历（休市缺口）不可在 jsdom 复现；此处用「等间隔 + D 校准」使
//       `round(baseBS × D)` 与「跨度 ≤1 根高周期 bar」两条口径**同时可在桩上判定**。
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};
/** 实测密度比（P0.3 锚定表；同周期 = 1）。 */
const DENSITY: Record<string, number> = {
  '1m:1m': 1,
  '1m:5m': 4.7,
  '1m:15m': 12.2,
  '1m:1h': 37.8,
  '1d:1w': 4.67,
};
const END_TS = Date.UTC(2026, 8, 14, 7, 0, 0);
const PANE_WIDTH = 520;
/** 卫星 barSpace 上限（P0.3 实测锚定 350）。 */
const SATELLITE_MAX = 350;

function makePair(
  basePeriod: string,
  satPeriod: string,
  opts: { baseBarSpace?: number; satBarCount?: number; satMax?: number; offsetRightBars?: number } = {},
): {
  base: SyncChartStub;
  sat: SyncChartStub;
  baseBucket: number;
  satBucket: number;
  baseBarSpace: number;
  baseSpacing: number;
} {
  const density = densityOf(basePeriod, satPeriod);
  const baseBucket = bucketOf(basePeriod);
  const satBucket = bucketOf(satPeriod);
  const baseBarSpace = opts.baseBarSpace ?? 8;
  const satBarCount = opts.satBarCount ?? 120;
  const baseSpacing = basePeriod === satPeriod ? baseBucket : satBucket / density;
  const baseBarCount = Math.max(satBarCount, Math.round((satBarCount * satBucket) / baseSpacing));

  const base = createSyncChartStub({
    bars: makeSeries({ count: baseBarCount, spacingMs: baseSpacing, endTs: END_TS }),
    paneWidthPx: PANE_WIDTH,
    barSpace: baseBarSpace,
    limit: { min: 1, max: 50 }, // 基准：**保持默认 50**（ADR-020 严格，口径 9 不得泄漏）
  });
  const sat = createSyncChartStub({
    bars: makeSeries({ count: satBarCount, spacingMs: satBucket, endTs: END_TS }),
    paneWidthPx: PANE_WIDTH,
    barSpace: 10,
    limit: { min: 1, max: opts.satMax ?? SATELLITE_MAX },
    offsetRightBars: opts.offsetRightBars ?? 8,
  });
  return { base, sat, baseBucket, satBucket, baseBarSpace, baseSpacing };
}

/** 成员构造（基准排第一，`isBase:true` 唯一）。 */
function members(base: SyncChartStub, sat: SyncChartStub, basePeriod: string, satPeriod: string): SyncMemberLike[] {
  return [
    { id: 'base', chart: base, period: basePeriod, isBase: true },
    { id: satPeriod, chart: sat, period: satPeriod, isBase: false },
  ];
}

/** 周期桶宽 / 密度比的**显式取值**（本仓库 tsconfig 开启 `noUncheckedIndexedAccess`）。 */
function bucketOf(period: string): number {
  const b = BUCKET_MS[period];
  if (b === undefined) throw new Error(`夹具未定义周期桶宽：${period}`);
  return b;
}
function densityOf(basePeriod: string, satPeriod: string): number {
  const d = DENSITY[`${basePeriod}:${satPeriod}`];
  if (d === undefined) throw new Error(`夹具未定义密度比：${basePeriod}↔${satPeriod}`);
  return d;
}
function barAt(stub: SyncChartStub, index: number): number {
  const v = stub.__bars[index];
  if (v === undefined) throw new Error(`bar 索引越界：${index}`);
  return v;
}
function lastBar(stub: SyncChartStub): number {
  return barAt(stub, stub.__bars.length - 1);
}
function lastSnapshot(list: SyncStatsLike[]): SyncStatsLike {
  const v = list[list.length - 1];
  if (v === undefined) throw new Error('同步统计未广播任何快照（onChange 未接线）');
  return v;
}

/** 可见窗的 ts 摘要：`span` = 覆盖的日历宽（含首末 bar 的整根宽度）。 */
function windowTs(stub: SyncChartStub, bucket: number): { from: number; to: number; bars: number; span: number } {
  const r = stub.getVisibleRange();
  expect(Number.isNaN(r.from), '可见范围读数不得失效（NaN ⇒ 未显式降级，P0.3 §6-I3a）').toBe(false);
  return {
    from: barAt(stub, r.from),
    to: barAt(stub, r.to),
    bars: r.to - r.from + 1,
    span: barAt(stub, r.to) - barAt(stub, r.from) + bucket,
  };
}

describe('ChartSyncGroup（P3-A 红：模块尚不存在）', () => {
  it('G1/T3-1 同周期（1m↔1m）：≥20 轮镜像后**相对偏移 ≤1 根**、无回声（真渲染口径）', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat } = makePair('1m', '1m', { satBarCount: 600 });
    const g = new ChartSyncGroup(members(base, sat, '1m', '1m'));
    g.start();

    // 首轮：基准交互（用户滚动）
    base.scrollToDataIndex(300);

    // ── 判据（G1 · 真渲染口径）：≥20 轮镜像后**相对偏移 ≤1 根** ──
    // 真身事实（P3-C 独立验收 `tester/evidence/273_p3c_acceptance/p3c_harness.json` → `scenarios.PROBE` / `S1_g1_nodrift`）：
    //   · `setOffsetRightDistance(0)` 读回 0，但 `scrollToTimestamp(ts)` 落点**恒距右缘 2 根**
    //     （同 `scrollToDataIndex` ⇒ `[241,302]==[241,302]` 精确；`scrollToTimestamp(list[302].ts)` ⇒ `[243,304]` = +2 根）；
    //   · 1m↔1m 20 轮相对偏移 **恒 2 根**（`maxDrift=2`、`suppressed=64`、`echo=0`）。
    // ⇒ 忠实桩（`REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS`）复现同一落点 ⇒ 本判据在 jsdom 层**必红**。
    // **不得**为绿而回退桩，也**不得**把判据改回"逐字段相等以外的理想口径"。
    const rows: Array<{ round: number; baseTo: number; satTo: number; drift: number }> = [];
    for (let round = 0; round < 20; round++) {
      base.scrollToDataIndex(300 + round * 5);
      const b = base.getVisibleRange();
      const s = sat.getVisibleRange();
      expect(Number.isNaN(b.to) || Number.isNaN(s.to), `第 ${round + 1} 轮：视口读数不得失效`).toBe(false);
      rows.push({ round: round + 1, baseTo: b.to, satTo: s.to, drift: Math.abs(s.to - b.to) });
    }

    // 抑制计数 > 0（卫星被程序化写入回传的事件必须被抑制）+ 无回声循环
    expect(g.stats.applied, '至少每轮 1 次对齐').toBeGreaterThanOrEqual(20);
    expect(g.stats.suppressed, 'syncSuppressed > 0（P7b：单次滚动即出现重入）').toBeGreaterThan(0);
    expect(g.stats.echoEvents, '不得出现回声循环').toBe(0);

    const maxDrift = rows.reduce((m, r) => Math.max(m, r.drift), 0);
    const last = rows[rows.length - 1];
    expect(
      maxDrift,
      `≥20 轮镜像后相对偏移必须 ≤1 根（G1 真渲染口径；真身实测恒 2 根）；实测 drift 序列=[${rows
        .map((r) => r.drift)
        .join(',')}]；末轮 base.to=${last?.baseTo} sat.to=${last?.satTo}`,
    ).toBeLessThanOrEqual(1);
  });

  // ── T3-2 跨周期：**逐组合独立用例**（真渲染口径：跨度差 ≤1 根高周期 bar **且** 右端差 ≤1 根高周期 bar） ──
  // P3-C 实测（`p3c_harness.json` → `S2_cross_period`）：1m↔5m 差距 9.1min>5、1m↔15m 29min>15、1d↔1w 13.56d>7d
  // （跨度差与右端差**同时**超容差）⇒ 忠实桩下右端差必红（2 根落点缺口不可补偿）。
  const CROSS_COMBOS: Array<{ base: string; sat: string; midIndex: number; satBarCount: number }> = [
    { base: '1m', sat: '5m', midIndex: 400, satBarCount: 120 },
    { base: '1m', sat: '15m', midIndex: 400, satBarCount: 120 },
    { base: '1d', sat: '1w', midIndex: 200, satBarCount: 120 }, // 密度比 4.67（名义 7 必红：见下一条）
  ];

  for (const c of CROSS_COMBOS) {
    it(`T3-2 跨周期 ${c.base}↔${c.sat}：跨度差 ≤1 根高周期 bar **且** 右端差 ≤1 根高周期 bar、可见 ≥2 根、无回声`, async () => {
      const ChartSyncGroup = await loadGroup();
      const { base, sat, satBucket } = makePair(c.base, c.sat, { satBarCount: c.satBarCount });
      const g = new ChartSyncGroup(members(base, sat, c.base, c.sat));
      g.start();

      base.scrollToDataIndex(c.midIndex);
      const b = windowTs(base, bucketOf(c.base));
      const s = windowTs(sat, bucketOf(c.sat));
      const label = `${c.base}↔${c.sat}`;
      const spanDiff = Math.abs(s.span - b.span);
      const edgeDiff = Math.abs(s.to - b.to);

      expect(s.bars, `${label}：卫星可见 bar ≥2（口径 8 的虚假通过防线）`).toBeGreaterThanOrEqual(2);
      expect(g.stats.suppressed, `${label}：重入必须被抑制`).toBeGreaterThan(0);
      expect(g.stats.echoEvents, `${label}：不得出现回声循环`).toBe(0);
      expect(g.stats.degraded, `${label}：非退化组合不得被标为降级`).toBe(false);
      // 真实渲染事实（P3-C PROBE + harness F1）：`scrollToTimestamp` 落点距右缘**固定 2 根**，
      // 且 `setOffsetRightDistance(0)` **无法消除** ⇒ 跨周期右端对齐必须按 ts 逐边补偿；
      // 仅归零右偏移不够 ⇒ 跟随者右偏移 ≤1 根自身 bar 这条也**不充分**（桩内为 0，仍偏 2 根）。
      expect(
        sat.getOffsetRightDistance(),
        `${label}：跟随者右偏移必须被补偿（≤1 根自身 bar）`,
      ).toBeLessThanOrEqual(sat.getBarSpace().bar);

      // ① 跨度差（注意：桩的可见根数模型 `floor(paneWidth/barSpace)` 与真身不完全一致 —— 真身含部分 bar，
      //    见 `syncChartStub.ts` 顶部「已知的剩余不忠实面」；本判据的**真渲染**证据由 P3-C `S2_cross_period` 承担）
      expect(
        spanDiff,
        `${label}：跨度差 ≤1 根高周期 bar（实测 ${spanDiff}ms > ? ${satBucket}ms；b.span=${b.span} s.span=${s.span}）`,
      ).toBeLessThanOrEqual(satBucket);
      // ② 右端差（**与真身同口径的红**：2 根落点缺口不可补偿）
      expect(
        edgeDiff,
        `${label}：右端差 ≤1 根高周期 bar（实测 ${edgeDiff}ms；b.to=${b.to} s.to=${s.to}）`,
      ).toBeLessThanOrEqual(satBucket);
    });
  }

  it('T3-2 反向（变异必红）：1d↔1w 若用**名义比 7** ⇒ 跨度差必超 1 根周 bar（密度比 4.67 才达标）', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat, satBucket } = makePair('1d', '1w', { satBarCount: 60 });
    const g = new ChartSyncGroup(members(base, sat, '1d', '1w'));
    g.start();
    base.scrollToDataIndex(200);

    const b = windowTs(base, bucketOf('1d'));
    // 密度比实现：达标
    const s = windowTs(sat, bucketOf('1w'));
    expect(Math.abs(s.span - b.span)).toBeLessThanOrEqual(satBucket);

    // 反向对照：同一基准窗按**名义比 7** 推导 ⇒ 误差必须超容差（证明该组合确实能判别名义比实现）
    const nominal = createSyncChartStub({
      bars: sat.__bars,
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: SATELLITE_MAX },
    });
    nominal.setBarSpace(Math.round(8 * 7));
    nominal.scrollToTimestamp(b.to);
    const n = windowTs(nominal, bucketOf('1w'));
    expect(
      Math.abs(n.span - b.span),
      '名义比 7 的跨度差必须 >1 根周 bar（否则本用例无判别力）',
    ).toBeGreaterThan(satBucket);
  });

  it('T3-3 重入抑制的反向证据：禁用抑制 ⇒ 出现回声（`echoEvents>0`）；开启 ⇒ 回声 0 且 suppressed>0', async () => {
    const ChartSyncGroup = await loadGroup();

    // 关闭抑制（测试用反向旋钮；生产默认必须为 true）
    const off = makePair('1m', '15m', { satBarCount: 120 });
    const gOff = new ChartSyncGroup(members(off.base, off.sat, '1m', '15m'), { reentrySuppression: false });
    gOff.start();
    off.base.scrollToDataIndex(300);
    expect(gOff.stats.echoEvents, '禁用抑制必须观测到回声（跟随者回传被处理）').toBeGreaterThan(0);

    // 开启（默认）：同一次滚动 ⇒ 回声 0、抑制 >0
    const on = makePair('1m', '15m', { satBarCount: 120 });
    const gOn = new ChartSyncGroup(members(on.base, on.sat, '1m', '15m'));
    gOn.start();
    on.base.scrollToDataIndex(300);
    expect(gOn.stats.echoEvents, '启用抑制后不得有回声').toBe(0);
    expect(gOn.stats.suppressed, '被抑制的回传事件必须计数（可观测）').toBeGreaterThan(0);
    expect(gOn.stats.echoEvents).toBeLessThan(gOff.stats.echoEvents);
  });

  it('T3-4 护栏：1m↔1w（恒退化）必须**拒绝**该组合（构造/启动即抛错，禁止静默虚假对齐）', async () => {
    const ChartSyncGroup = await loadGroup();
    const base = createSyncChartStub({
      bars: makeSeries({ count: 600, spacingMs: 60_000, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 1,
    });
    const sat = createSyncChartStub({
      bars: makeSeries({ count: 60, spacingMs: bucketOf('1w'), endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: SATELLITE_MAX },
    });

    expect(() => {
      const g = new ChartSyncGroup(members(base, sat, '1m', '1w'));
      g.start();
    }, '1m↔1w 是不可用组合（口径 10 + P0.3 量化：任何基准缩放下卫星仅 1 根）').toThrow(/1m|1w|不可用|退化|reject|unsupported/i);
  });

  it('T4-1 回到最新：`scrollAllToLatest()` ⇒ 各实例右端对齐（误差 ≤1 根高周期 bar）', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat, satBucket } = makePair('1m', '5m', { satBarCount: 120 });
    const g = new ChartSyncGroup(members(base, sat, '1m', '5m'));
    g.start();

    // 先手动甩开（基准与卫星都不在最新）
    base.scrollToDataIndex(200);
    sat.scrollToDataIndex(5);

    g.scrollAllToLatest();

    const b = windowTs(base, bucketOf('1m'));
    const s = windowTs(sat, bucketOf('5m'));
    expect(b.to, '基准右端 = 其末根 bar').toBe(lastBar(base));
    expect(s.to, '卫星右端 = 其末根 bar').toBe(lastBar(sat));
    expect(Math.abs(s.to - b.to), '两侧右端时间戳差 ≤1 根高周期 bar').toBeLessThanOrEqual(satBucket);
    expect(
      sat.getOffsetRightDistance(),
      '回到最新后卫星右偏移必须被补偿（≤1 根自身 bar；否则跨周期右端必错位）',
    ).toBeLessThanOrEqual(sat.getBarSpace().bar);
    expect(
      base.getOffsetRightDistance(),
      '基准同样不得残留未补偿的右偏移',
    ).toBeLessThanOrEqual(base.getBarSpace().bar);
  });

  it('T4-2 尊重手动视口：手动缩放/平移后**新 bar 到达不得自动回滚**（非跟随态不滚动）', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat, satBucket, baseSpacing } = makePair('1m', '15m', { satBarCount: 60 });
    const g = new ChartSyncGroup(members(base, sat, '1m', '15m'));
    g.start();

    // 手动平移 + 手动缩放（用户手势）⇒ 视口稳定在对齐后的位置
    base.scrollToDataIndex(300);
    base.setBarSpace(6);
    const b = base.getVisibleRange();
    const s = sat.getVisibleRange();
    const applied = g.stats.applied;

    // 新 bar 到达（两侧各自追加；**不是用户交互**）
    base.__appendBar(lastBar(base) + baseSpacing);
    sat.__appendBar(lastBar(sat) + satBucket);

    expect(base.getVisibleRange(), '非跟随态：基准视口不得被新 bar 拉回').toEqual(b);
    expect(sat.getVisibleRange(), '非跟随态：卫星视口不得被新 bar 拉回').toEqual(s);
    expect(g.stats.applied, '新 bar 到达不得触发自动对齐/滚动').toBe(applied);
    expect(g.stats.echoEvents).toBe(0);
  });

  it('T8bis 诚实降级 + 角标可观测字段：退化 ⇒ barSpace=能容纳≥2 根的最大值、右端对齐、syncDegraded 可读；缩小基准 ⇒ 恢复正常', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat, satBucket } = makePair('1m', '1h', { baseBarSpace: 8, satBarCount: 20 });
    const g = new ChartSyncGroup(members(base, sat, '1m', '1h'));
    const snapshots: SyncStatsLike[] = [];
    g.onChange((st) => snapshots.push(st));
    g.start();

    base.scrollToDataIndex(400);

    // ① 卫星 barSpace = 「能容纳 ≥2 根的最大 barSpace」= floor(520/2) = 260（**不得**是推导值 302）
    expect(sat.getBarSpace().bar, '退化时必须取能容纳 ≥2 根的最大 barSpace').toBe(260);
    expect(sat.getBarSpace().bar).not.toBe(302);

    const degradedB = windowTs(base, bucketOf('1m'));
    const degradedS = windowTs(sat, bucketOf('1h'));
    // ② 卫星可见 bar ≥2（口径 8 的虚假通过防线）
    expect(degradedS.bars).toBeGreaterThanOrEqual(2);
    // ③ 右端对齐（真渲染实测 `S4_t8bis`：右端差 1.74h > 1h 容差 ⇒ 红；根因同 G1 的 2 根落点缺口）
    expect(
      Math.abs(degradedS.to - degradedB.to),
      `退化路径右端差 ≤1 根高周期 bar（实测 ${Math.abs(degradedS.to - degradedB.to)}ms）`,
    ).toBeLessThanOrEqual(satBucket);
    // ③b 跨度差同样 ≤1 根高周期 bar
    expect(
      Math.abs(degradedS.span - degradedB.span),
      `退化路径跨度差 ≤1 根高周期 bar（实测 ${Math.abs(degradedS.span - degradedB.span)}ms）`,
    ).toBeLessThanOrEqual(satBucket);
    // ④ syncDegraded / 跨度差可观测（不得静默虚假对齐）
    expect(g.stats.degraded).toBe(true);
    expect(g.stats.degradedPeriod).toBe('1h');
    expect(g.stats.lastSpanDiffMinutes, '跨度差必须可读出（分钟）').toBeGreaterThan(0);
    expect(
      g.stats.lastSpanDiffMinutes as number,
      '跨度差量级必须以分钟计（≤1 根高周期 bar 的退化量级；不得是秒/毫秒或被伪造为 0）',
    ).toBeLessThanOrEqual(60);
    expect(snapshots.length, 'onChange 必须把同步统计广播出去（UI 角标的数据源）').toBeGreaterThan(0);
    expect(lastSnapshot(snapshots).degraded).toBe(true);

    // ⑤ 用户缩小基准图 ⇒ 角标消失、回到正常对齐（推导值 151 ≤ 260 ⇒ 不再降级）
    base.setBarSpace(4);
    expect(sat.getBarSpace().bar).toBe(151);
    expect(g.stats.degraded).toBe(false);
    expect(g.stats.degradedPeriod).toBeNull();
    const normalB = windowTs(base, bucketOf('1m'));
    const normalS = windowTs(sat, bucketOf('1h'));
    expect(normalS.bars).toBeGreaterThanOrEqual(2);
    expect(Math.abs(normalS.to - normalB.to)).toBeLessThanOrEqual(satBucket);
    expect(Math.abs(normalS.span - normalB.span)).toBeLessThanOrEqual(satBucket);
    expect(lastSnapshot(snapshots).degraded).toBe(false);
  });

  it('边界-NaN 降级路径：`satBS ≫ pane 宽` 会让 `getVisibleRange()` 失效 ⇒ 必须显式降级为可读视口', async () => {
    const ChartSyncGroup = await loadGroup();
    // ⚠️ 本用例**必须**显式抬高卫星 `barSpaceLimit.max`（`satMax`），否则下面「仪器证明」一行不成立：
    //    忠实桩/真身都按 `index.esm.js:13666` 的「越界**静默 return**」处理 `setBarSpace` —— 上限仍是
    //    默认 350 时 `setBarSpace(1512)` 会被吞掉、视口不可能 NaN（NaN 需 `barSpace > 2×pane 宽`）。
    //    抬高上限只让「把推导值硬塞进去」这个**前置条件**可满足，判据强度不变（不得删 `satMax`）。
    const { base, sat } = makePair('1m', '1h', { baseBarSpace: 40, satBarCount: 20, satMax: 5000 });
    const g = new ChartSyncGroup(members(base, sat, '1m', '1h'));
    g.start();

    base.scrollToDataIndex(300);
    // 推导值 round(40×37.8)=1512 ≫ 520px ⇒ 若照用则视口失效；必须降级到 floor(520/2)=260
    expect(sat.getBarSpace().bar).toBe(260);
    expect(Number.isNaN(sat.getVisibleRange().from), '降级后视口必须可读（非 NaN）').toBe(false);
    expect(g.stats.degraded).toBe(true);

    // 仪器证明（P0.3 §6-I3a）：把推导值硬塞进去 ⇒ 视口确实失效（NaN）
    sat.setBarSpace(1512);
    expect(Number.isNaN(sat.getVisibleRange().from)).toBe(true);

    // 再次交互 ⇒ 组把它拉回可读的降级视口
    base.scrollToDataIndex(301);
    expect(Number.isNaN(sat.getVisibleRange().from)).toBe(false);
    expect(sat.getBarSpace().bar).toBe(260);
  });

  it('边界-上限不足：卫星 barSpaceLimit 太小时必须**显式降级**（不得让 setBarSpace 静默吞掉）', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat } = makePair('1m', '1h', { baseBarSpace: 3, satBarCount: 20, satMax: 50 });
    const g = new ChartSyncGroup(members(base, sat, '1m', '1h'));
    g.applySatelliteLimits();
    g.start();

    base.scrollToDataIndex(300);
    // 推导 113（≤260 ⇒ 非 pane 退化），但卫星上限只有 50 ⇒ 必须显式降级（默认 50 静默吞掉是 P0.3 §2.3 的坑）
    expect(sat.getBarSpace().bar, '必须按已知上限取 50（若盲目写 113 会被静默吞掉、留在旧值）').toBe(50);
    expect(g.stats.degraded).toBe(true);
    expect(g.stats.degradedPeriod).toBe('1h');
  });

  it('边界-放宽不泄漏到基准：基准实例始终被 `barSpaceLimit{1,50}` 夹紧（ADR-020 严格）', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat } = makePair('1d', '1w', { baseBarSpace: 8, satBarCount: 60 });
    const g = new ChartSyncGroup(members(base, sat, '1d', '1w'));
    g.applySatelliteLimits();
    g.start();
    base.scrollToDataIndex(200);

    // 基准先到上限 50，再请求 350/5000 ⇒ 读回仍 50（P0.3 §4 隔离性实测：越界被静默吞掉 = 值不变）
    base.setBarSpace(50);
    expect(base.getBarSpace().bar).toBe(50);
    base.setBarSpace(350);
    expect(base.getBarSpace().bar, '基准不得被放宽（放宽仅作用于卫星）').toBe(50);
    base.setBarSpace(5000);
    expect(base.getBarSpace().bar).toBe(50);

    // 卫星同一请求在放宽后生效（max=350）
    sat.setBarSpace(350);
    expect(sat.getBarSpace().bar, '卫星必须接受 ≤350 的 barSpace（默认 50 会静默吞掉）').toBe(350);

    // 组不得对基准做任何 barSpace 放宽（调用面证据：基准实例上不得出现越界以外的写入）
    expect(base.__limit().max).toBe(50);
  });

  it('T4-2 补充：`stop()` 后不得再镜像（解除订阅/停止广播，零残留）', async () => {
    const ChartSyncGroup = await loadGroup();
    const { base, sat } = makePair('1m', '5m', { satBarCount: 120 });
    const g = new ChartSyncGroup(members(base, sat, '1m', '5m'));
    g.start();
    base.scrollToDataIndex(300);
    const appliedBeforeStop = g.stats.applied;

    g.stop();
    const satAfterStop = sat.getVisibleRange();
    base.scrollToDataIndex(320);
    expect(sat.getVisibleRange(), 'stop() 后不再镜像').toEqual(satAfterStop);
    expect(g.stats.applied).toBe(appliedBeforeStop);
  });
});
