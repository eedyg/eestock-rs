/**
 * P3-D-2 增补测试（实现方自测面；**在 P3-D-1 红测试之外**补「有界闭环校正 + 未对齐可观测」的可回归判据）。
 *
 * 本文件位置：`web/src/features/dashboard/chartSyncAlignClosedLoop.test.ts`
 * 权威依据：`design/15-multi-period/01-adr.md` §2.3、`02-spec.md` §3、`03-test-plan.md` T3/T8bis；
 * P3-C 独立验收（`tester/evidence/273_p3c_acceptance/p3c_harness.json`）与 P3-D-1 忠实桩红测试
 * （`tester/design/274_p3d1_faithful_stub_red_design.md`）。
 * 用户口径（方案 1）：诚实降级 + 「对齐受限」角标；**严禁静默虚假对齐**。
 *
 * 本文件**不改** P3-D-1 的任何断言，只新增：
 *  1. 有界闭环校正的**迭代上限**（≤ `MAX_ALIGN_CORRECTION_ITERATIONS`）与收敛统计；
 *  2. **未对齐跟随者必须可观测**（`unalignedFollowers` / `lastUnalignedReason`）——
 *     未布局（pane 宽 0）/ 无数据 / 容差不可达，均**不得静默跳过**；
 *  3. **base 作为 follower 的降级可观测**（`stats.degradedPeriod = 基准周期`；store 可读出）。

 *
 * ⚠️ 架构裁决（2026-09-14）后同步修订：**基准实例永不作为 follower**（ADR-020）——
 * 原「base 作为 follower」用例已改为「基准不被反向改写」硬约束断言（含反向变异敏感性）；
 * 另新增「分路径判据（降级路径记录实测可达下界）」与「fail-closed（降级 ≠ 跳过对齐）」用例。
 * **P3-D-1 红测试的断言一字未改**（未放宽任何阈值）。 */

import { describe, expect, it } from 'vitest';
import type { ApiClient } from '@/api/client';
import { createSyncChartStub, makeSeries, type SyncChartStub } from '@/test/syncChartStub';
import { ChartSyncGroup, MAX_ALIGN_CORRECTION_ITERATIONS } from './chartSyncGroup';
import { MultiPeriodStore } from './multiPeriodStore';

const END_TS = Date.UTC(2026, 8, 14, 7, 0, 0);
const PANE_WIDTH = 520;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

function member(chart: SyncChartStub, period: string, isBase: boolean) {
  return { id: isBase ? 'base' : `sat:${period}`, chart, period, isBase };
}

describe('ChartSyncGroup 有界闭环校正 + 未对齐可观测（P3-D-2 增补）', () => {
  it('1m↔5m：索引定位后闭环在 ≤3 次迭代内收敛；未对齐计数为 0；迭代次数可观测', () => {
    const base = createSyncChartStub({
      bars: makeSeries({ count: 800, spacingMs: 300_000 / 4.7, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 8,
      limit: { min: 1, max: 50 },
    });
    const sat = createSyncChartStub({
      bars: makeSeries({ count: 120, spacingMs: 300_000, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: 350 },
    });
    const g = new ChartSyncGroup([member(base, '1m', true), member(sat, '5m', false)]);
    g.start();

    base.scrollToDataIndex(400);

    expect(g.stats.unalignedFollowers, '两侧均被对齐 ⇒ 未对齐计数必须为 0').toBe(0);
    expect(g.stats.lastUnalignedReason).toBeNull();
    expect(
      g.stats.lastCorrectionIterations,
      '闭环必须执行 ≥1 次定位且不超过迭代上限（禁止无界重试）',
    ).toBeGreaterThanOrEqual(1);
    expect(g.stats.lastCorrectionIterations).toBeLessThanOrEqual(MAX_ALIGN_CORRECTION_ITERATIONS);
    expect(MAX_ALIGN_CORRECTION_ITERATIONS).toBeLessThanOrEqual(3);
  });

  it('跟随者未布局（pane 宽 0）⇒ 跳过必须**可观测**（unalignedFollowers + 原因），不得静默', () => {
    const base = createSyncChartStub({
      bars: makeSeries({ count: 800, spacingMs: 300_000 / 4.7, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 8,
      limit: { min: 1, max: 50 },
    });
    const sat = createSyncChartStub({
      bars: makeSeries({ count: 120, spacingMs: 300_000, endTs: END_TS }),
      paneWidthPx: 0, // 未布局（jsdom/真身都可能出现）
      barSpace: 10,
      limit: { min: 1, max: 350 },
    });
    const before = sat.getVisibleRange();
    const g = new ChartSyncGroup([member(base, '1m', true), member(sat, '5m', false)]);
    g.start();

    base.scrollToDataIndex(300);

    expect(g.stats.unalignedFollowers, '被跳过的跟随者必须计数（禁止静默虚假对齐）').toBeGreaterThanOrEqual(1);
    expect(g.stats.lastUnalignedReason, '跳过原因必须可读').toContain('5m');
    expect(sat.getVisibleRange(), '未布局 ⇒ 不得被写入').toEqual(before);
  });

  it('跟随者无数据 ⇒ 无法索引定位 ⇒ 跳过必须可观测（不得静默）', () => {
    const base = createSyncChartStub({
      bars: makeSeries({ count: 800, spacingMs: 300_000 / 4.7, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 8,
      limit: { min: 1, max: 50 },
    });
    const sat = createSyncChartStub({
      bars: [], // 尚未装载该周期 bar
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: 350 },
    });
    const g = new ChartSyncGroup([member(base, '1m', true), member(sat, '5m', false)]);
    g.start();

    base.scrollToDataIndex(300);

    expect(g.stats.unalignedFollowers, '无数据 ⇒ 无法定位 ⇒ 必须计数').toBeGreaterThanOrEqual(1);
    expect(g.stats.lastUnalignedReason).toBeTruthy();
  });

  it('容差不可达（1h 跟随者只能显示 2 根，无法覆盖基准跨度）⇒ 有界停手 + 置 degraded（禁止无界重试）', () => {
    const base = createSyncChartStub({
      bars: makeSeries({ count: 8000, spacingMs: HOUR / 37.8, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 40, // 推导 satBS = round(40×37.8) = 1512 > 260 ⇒ 降级到 260（2 根）
      limit: { min: 1, max: 50 },
    });
    const sat = createSyncChartStub({
      bars: makeSeries({ count: 300, spacingMs: HOUR, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: 350 },
    });
    const g = new ChartSyncGroup([member(base, '1m', true), member(sat, '1h', false)]);
    g.start();

    base.scrollToDataIndex(4000);

    expect(sat.getBarSpace().bar, '降级到能容纳 ≥2 根的最大 barSpace').toBe(260);
    expect(g.stats.degraded, '容差不可达必须显式降级（禁止静默虚假对齐）').toBe(true);
    expect(g.stats.degradedPeriod).toBe('1h');
    expect(
      g.stats.lastCorrectionIterations,
      '不收敛时必须在迭代上限内停手（禁止无界重试）',
    ).toBeLessThanOrEqual(MAX_ALIGN_CORRECTION_ITERATIONS);
  });

  it('降级路径（容差不可达）：可见 ≥2 根 + 右端差 ≤1 根 + 实测可达下界记录 + 原因可读（fail-closed）', () => {
    // 卫星上限被人为压到 50（默认 50 会静默吞掉）⇒ 1h 卫星跨度远小于基准跨度 ⇒ 不可能收敛
    const base = createSyncChartStub({
      bars: makeSeries({ count: 8000, spacingMs: HOUR / 37.8, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 8,
      limit: { min: 1, max: 50 },
    });
    const sat = createSyncChartStub({
      bars: makeSeries({ count: 300, spacingMs: HOUR, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: 50 }, // 上限不足 ⇒ 显式降级（不被静默吞掉）
    });
    const g = new ChartSyncGroup([member(base, '1m', true), member(sat, '1h', false)]);
    g.start();

    base.scrollToDataIndex(4000);

    // ① fail-closed：降级态必须可读（不得宣称已对齐）
    expect(g.stats.degraded, '容差不可达必须显式降级').toBe(true);
    expect(g.stats.degradedPeriod).toBe('1h');
    expect(g.stats.unalignedFollowers, '未对齐的跟随者必须计数').toBeGreaterThanOrEqual(1);
    expect(g.stats.lastUnalignedReason, '未对齐原因必须可读').toMatch(/^1h:/);
    // ② 实测可达下界必须被记录（>1 根 ⇒ 不是「已对齐」）
    expect(
      g.stats.spanResidualBars,
      '降级路径必须记录实测可达下界（以自身 bar 为单位）',
    ).toBeGreaterThan(1);
    // ③ 降级路径的其余判据：可见 ≥2 根（口径 8 的虚假通过防线）
    const r = sat.getVisibleRange();
    expect(Number.isNaN(r.from)).toBe(false);
    expect(r.to - r.from + 1).toBeGreaterThanOrEqual(2);
    // ④ 有界：迭代次数不超过上限（禁止无界重试）
    expect(g.stats.lastCorrectionIterations).toBeLessThanOrEqual(MAX_ALIGN_CORRECTION_ITERATIONS);
  });

  it('可对齐的降级 barSpace（容量受限但跨度可达）⇒ 仍必须完成对齐（fail-closed：先尝试完整对齐）', () => {
    const base = createSyncChartStub({
      bars: makeSeries({ count: 8000, spacingMs: HOUR / 37.8, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 8, // 推导 satBS = round(8×37.8)=302 > 260 ⇒ 容量降级，但 jsdom 下跨度仍可达
      limit: { min: 1, max: 50 },
    });
    const sat = createSyncChartStub({
      bars: makeSeries({ count: 300, spacingMs: HOUR, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: 350 },
    });
    const g = new ChartSyncGroup([member(base, '1m', true), member(sat, '1h', false)]);
    g.start();

    base.scrollToDataIndex(4000);

    expect(sat.getBarSpace().bar, '容量降级：取能容纳 ≥2 根的最大 barSpace').toBe(260);
    expect(g.stats.degraded, '容量降级 ⇒ 角标').toBe(true);
    expect(g.stats.degradedPeriod).toBe('1h');
    expect(
      g.stats.unalignedFollowers,
      '降级 ≠ 跳过：barSpace 虽降级，跨度可达时仍必须完成对齐（fail-closed）',
    ).toBe(0);
    expect(g.stats.spanResidualBars).toBeLessThanOrEqual(1);
    expect(g.stats.edgeResidualBars).toBeLessThanOrEqual(1);
    // store 可读（降级周期可从 store 读出；角标仍只渲染在卫星 pane）
    const store = new MultiPeriodStore({ api: {} as unknown as ApiClient });
    store.applySyncStats(g.stats);
    expect(store.getSnapshot().syncDegraded).toBe(true);
    expect(store.getSnapshot().syncDegradedPeriod).toBe('1h');
  });

  it('【硬约束】基准永不作为 follower：卫星做 leader ⇒ 基准 barSpace/可见范围**逐字段不变**（反向变异必红）', () => {
    // 若实现错误地把基准当 follower：推导 baseBS = round(300 / 4.67) = 64 > 基准上限 50 ⇒ 会把基准
    // 从 8 改写成 50（甚至被闭环继续微调）⇒ 本用例必须红。
    const base = createSyncChartStub({
      bars: makeSeries({ count: 600, spacingMs: WEEK / 4.67, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 8,
      limit: { min: 1, max: 50 }, // ADR-020：基准不放宽
    });
    const sat = createSyncChartStub({
      bars: makeSeries({ count: 120, spacingMs: WEEK, endTs: END_TS }),
      paneWidthPx: PANE_WIDTH,
      barSpace: 10,
      limit: { min: 1, max: 350 },
    });
    const g = new ChartSyncGroup([member(base, '1d', true), member(sat, '1w', false)]);
    g.start();

    const baseBarSpaceBefore = base.getBarSpace().bar;
    const baseRangeBefore = base.getVisibleRange();
    const baseOffsetBefore = base.getOffsetRightDistance();

    // 用户在**卫星**上缩放 + 平移（卫星 = leader）
    sat.setBarSpace(300);
    sat.scrollToDataIndex(60);

    expect(base.getBarSpace().bar, '基准 barSpace 不得被卫星同步反向改写（ADR-020）').toBe(baseBarSpaceBefore);
    expect(base.getBarSpace().bar, '基准不得被写成密度推导值/上限 50').not.toBe(50);
    expect(base.getVisibleRange(), '基准可见范围（视口）必须逐字段不变').toEqual(baseRangeBefore);
    expect(base.getOffsetRightDistance(), '基准右偏移也不得被写入（保持原值）').toBe(baseOffsetBefore);
    // 卫星仍然被对齐（以该卫星为 leader ⇒ 无其它卫星 ⇒ 不写任何 barSpace）：
    expect(g.stats.echoEvents, '不得出现回声').toBe(0);
  });
});
