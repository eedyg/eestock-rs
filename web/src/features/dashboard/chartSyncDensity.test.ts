/**
 * 红测试（P3-A）：**跨图同步的纯函数面** —— 实测密度比表 / 估计器 / 降级取整 / 右偏移镜像 / 组合护栏。
 *
 * 本文件位置：`web/src/features/dashboard/chartSyncDensity.test.ts`
 * 权威依据：
 *  - `design/15-multi-period/01-adr.md` §2.3/§2.5（同步原语、barSpaceLimit 仅卫星放宽、1w 护栏）
 *  - `design/15-multi-period/02-spec.md` §3.2（对齐算法：**实测密度比 D**、卫星上限 350、新增硬约束「卫星可见 bar ≥2」）、
 *    §3.5（诚实降级：容不下 ≥2 根时取「能容纳 ≥2 根的最大 barSpace」）、§3.6（可信实现要点）
 *  - `design/15-multi-period/03-test-plan.md` T3 / T8bis
 *  - 实测锚定（**不得重新发现**）：`tester/test/260_p03_barspace_anchor_execution.md`（P0.3）+
 *    `tester/evidence/250_multiperiod_route_probe/p7b2_result.json`（P7b）
 *  - 本文件的设计报告：`tester/design/272_p3_sync_red_design.md`（钉死以下导出签名与判据）
 *
 * 预期 red 理由：**`web/src/features/dashboard/chartSyncGroup.ts` 尚不存在**（P3 实现未开始）。
 * 实现后本文件应转绿，且**不得改动断言的阈值**（阈值全部来自 P0.3 实测锚定）。
 */

import { describe, expect, it } from 'vitest';

/**
 * 模块说明符：红阶段模块不存在 ⇒ 用**变量 specifier** 动态 import（字面量会让收集期整体报错，
 * 拿不到逐用例 red 证据；变量同时避免 `tsc -b` 在红阶段被模块缺失阻塞）。
 */
const SYNC_SPECIFIER: string = './chartSyncGroup';

interface DensityResolver {
  ratio: number | null;
  source: 'measured' | 'static' | 'none';
}

interface AlignResult {
  idealBarSpace: number;
  barSpace: number;
  degraded: boolean;
  degradedReason: 'base-zoom' | 'limit' | null;
  visibleBars: number;
}

interface SyncPureApi {
  densityRatio(basePeriod: string, satellitePeriod: string): number | null;
  estimateDensityRatio(input: { baseBarCount: number; satBarCount: number }): number | null;
  resolveDensityRatio(
    basePeriod: string,
    satellitePeriod: string,
    measured: number | null,
  ): DensityResolver;
  alignSatelliteBarSpace(input: {
    baseBarSpace: number;
    density: number;
    paneWidthPx: number;
    maxBarSpace: number;
  }): AlignResult;
  mirrorRightOffsetPx(baseOffsetRightPx: number, spaceRatio: number): number;
  isSyncCombinationAllowed(basePeriod: string, satellitePeriod: string): boolean;
}

async function loadPure(): Promise<SyncPureApi> {
  return (await import(/* @vite-ignore */ SYNC_SPECIFIER)) as unknown as SyncPureApi;
}

/** 卫星 barSpace 上限（P0.3 §2.3 实测锚定：1d→1w 需 233–280，取 350 留余量）。 */
const SATELLITE_MAX_BAR_SPACE = 350;
/** 实测 pane 宽（P0.3 全部锚定均在 520px pane 下测得）。 */
const PANE_WIDTH = 520;

describe('chartSyncGroup 纯函数面（P3-A 红：模块尚不存在）', () => {
  it('T3-密度表：D 取**实测密度比**（P0.3 锚定值逐一相等；1d→1w 必须 ≠ 名义比 7）', async () => {
    const { densityRatio } = await loadPure();

    // 锚定表（勿改）：1m→5m 4.7 / 1m→15m 12.2 / 1m→1h 37.8 / 1d→1w 4.67 / 1h→1w 24
    expect(densityRatio('1m', '5m')).toBe(4.7);
    expect(densityRatio('1m', '15m')).toBe(12.2);
    expect(densityRatio('1m', '1h')).toBe(37.8);
    expect(densityRatio('1d', '1w')).toBe(4.67);
    expect(densityRatio('1h', '1w')).toBe(24);
    // 同周期：D = 1（同周期两实例逐字段镜像的前提）
    expect(densityRatio('1m', '1m')).toBe(1);
    expect(densityRatio('5m', '5m')).toBe(1);

    // ⚠️ 反向证据（口径 8 的核心）：**名义周期比不成立**
    expect(densityRatio('1d', '1w'), 'D 不得等于名义比 7（P0.3：名义 @bs8 误差 −2.57 周 bar）').not.toBe(7);
    expect(densityRatio('1h', '1w'), 'D 不得等于名义比 168（P0.3：名义恒退化）').not.toBe(168);
    expect(densityRatio('1m', '5m')).not.toBe(5);
    expect(densityRatio('1m', '15m')).not.toBe(15);
    expect(densityRatio('1m', '1h')).not.toBe(60);

    // 无重叠/不存在的组合 ⇒ **null（显式不可用）**，不得按名义兜底
    expect(densityRatio('1m', '1w')).toBeNull();
    expect(densityRatio('1m', '1w')).not.toBe(10080);
    expect(densityRatio('1m', '1d')).toBeNull();
    expect(densityRatio('1m', '1mo')).toBeNull();
  });

  it('T3/边界-密度估计器：卫星 ≤1 根 / 无重叠 ⇒ 失效（null），不得静默按 0 或名义兜底', async () => {
    const { estimateDensityRatio } = await loadPure();

    // 运行时估计器（观测：同一时间窗内 base bar 数 / sat bar 数）
    expect(estimateDensityRatio({ baseBarCount: 564, satBarCount: 120 })).toBeCloseTo(4.7, 5);
    expect(estimateDensityRatio({ baseBarCount: 65, satBarCount: 14 })).toBeCloseTo(4.642, 2);

    // 失效路径（P0.3 §6-I5）：卫星可见 ≤1 根 或 无重叠（任一侧 0）⇒ null
    expect(estimateDensityRatio({ baseBarCount: 100, satBarCount: 1 })).toBeNull();
    expect(estimateDensityRatio({ baseBarCount: 100, satBarCount: 0 })).toBeNull();
    expect(estimateDensityRatio({ baseBarCount: 0, satBarCount: 20 })).toBeNull();
    expect(estimateDensityRatio({ baseBarCount: 0, satBarCount: 0 })).toBeNull();
  });

  it('T3/边界-静态回退：估计器失效时用锚定静态表，且来源必须可观测（不得静默）', async () => {
    const { resolveDensityRatio } = await loadPure();

    // 估计器有效 ⇒ 用实测值
    expect(resolveDensityRatio('1d', '1w', 5.2)).toEqual({ ratio: 5.2, source: 'measured' });
    // 估计器失效（null）⇒ 回退静态锚定表，并**显式标注来源**
    expect(resolveDensityRatio('1d', '1w', null)).toEqual({ ratio: 4.67, source: 'static' });
    expect(resolveDensityRatio('1m', '5m', null)).toEqual({ ratio: 4.7, source: 'static' });
    // 静态表也没有（1m↔1w 无重叠）⇒ 显式 none（禁止按名义比兜底）
    expect(resolveDensityRatio('1m', '1w', null)).toEqual({ ratio: null, source: 'none' });
    // 非法实测值（0/负/NaN）视同失效 ⇒ 回退静态表
    expect(resolveDensityRatio('1d', '1w', 0).source).toBe('static');
    expect(resolveDensityRatio('1d', '1w', Number.NaN).source).toBe('static');
  });

  it('T8bis-①/② 诚实降级：容不下 ≥2 根时取「能容纳 ≥2 根的最大 barSpace」，不得等于推导值', async () => {
    const { alignSatelliteBarSpace } = await loadPure();

    // 正常路径：1d→1w @baseBS=8 ⇒ 推导 8×4.67=37.36 ⇒ round 37（≤ pane 宽/2=260）
    const normal = alignSatelliteBarSpace({
      baseBarSpace: 8,
      density: 4.67,
      paneWidthPx: PANE_WIDTH,
      maxBarSpace: SATELLITE_MAX_BAR_SPACE,
    });
    expect(normal.idealBarSpace).toBe(37);
    expect(normal.barSpace).toBe(37);
    expect(normal.degraded).toBe(false);
    expect(normal.degradedReason).toBeNull();
    expect(normal.visibleBars).toBeGreaterThanOrEqual(2);

    // 退化路径：1m→1h @baseBS=8 ⇒ 推导 round(8×37.8)=302 > 260 ⇒ 取 floor(520/2)=260（恰好 2 根）
    const degraded = alignSatelliteBarSpace({
      baseBarSpace: 8,
      density: 37.8,
      paneWidthPx: PANE_WIDTH,
      maxBarSpace: SATELLITE_MAX_BAR_SPACE,
    });
    expect(degraded.idealBarSpace).toBe(302);
    expect(degraded.barSpace, '退化时必须取「能容纳 ≥2 根的最大 barSpace」').toBe(260);
    expect(degraded.barSpace, '**严禁**照用推导值（可见 1 根 = 静默虚假对齐）').not.toBe(degraded.idealBarSpace);
    expect(degraded.degraded).toBe(true);
    expect(degraded.degradedReason).toBe('base-zoom');
    expect(degraded.visibleBars).toBeGreaterThanOrEqual(2);

    // ⚠️ 反向（变异必红）证据：若实现照用推导值 302 ⇒ 可见 `floor(520/302) = 1` 根 ⇒
    //    上面「可见 bar ≥2」与「barSpace ≠ 推导值」两条判据同时命中（锁死虚假对齐）。
    expect(Math.floor(PANE_WIDTH / degraded.idealBarSpace)).toBe(1);

    // 卫星上限被低估（max=100）⇒ 也必须显式降级（默认 50 会**静默吞掉**，口径 9）
    const limited = alignSatelliteBarSpace({
      baseBarSpace: 4,
      density: 37.8,
      paneWidthPx: PANE_WIDTH,
      maxBarSpace: 100,
    });
    expect(limited.idealBarSpace).toBe(151);
    expect(limited.degraded).toBe(true);
    expect(limited.degradedReason).toBe('limit');
    expect(limited.barSpace).toBe(100);
    expect(limited.visibleBars).toBeGreaterThanOrEqual(2);
  });

  it('T3/边界-右偏移按倍率换算（P0.3 §6-I6）：px 不得直接透传', async () => {
    const { mirrorRightOffsetPx } = await loadPure();

    // 实测：1m↔5m @bs1 无镜像误差 446 bar → px 镜像 225 → 倍率镜像 −2.0 bar
    expect(mirrorRightOffsetPx(8, 4.67), 'baseOffsetPx × 倍率（取整）').toBe(37);
    expect(mirrorRightOffsetPx(8, 4.67)).not.toBe(8);
    expect(mirrorRightOffsetPx(8, 1)).toBe(8); // 同周期 ⇒ 不变
    expect(mirrorRightOffsetPx(64, 5)).toBe(320); // 1d→1w @bs8：64px(8 bar) ⇒ 320px
    expect(mirrorRightOffsetPx(0, 4.67)).toBe(0);
  });

  it('T3-护栏：恒退化组合（1m↔1w / 1m↔1d / 卫星<基准 / 1mo）必须被拒绝（口径 10 + P0.3 量化）', async () => {
    const { isSyncCombinationAllowed } = await loadPure();

    // ✅ 允许
    expect(isSyncCombinationAllowed('1m', '5m')).toBe(true);
    expect(isSyncCombinationAllowed('1m', '15m')).toBe(true);
    expect(isSyncCombinationAllowed('1d', '1w')).toBe(true);
    expect(isSyncCombinationAllowed('1m', '1m')).toBe(true); // 口径 2：允许等于基准
    expect(isSyncCombinationAllowed('1h', '1h')).toBe(true);

    // ❌ 拒绝
    expect(isSyncCombinationAllowed('1m', '1w'), '1m↔1w 恒退化（P0.3：任何基准缩放下卫星仅 1 根）').toBe(false);
    expect(isSyncCombinationAllowed('1m', '1d')).toBe(false);
    expect(isSyncCombinationAllowed('1h', '1w'), '1w 仅基准 ≥1d 开放（口径 10）').toBe(false);
    expect(isSyncCombinationAllowed('5m', '1m'), '卫星周期必须 ≥ 基准').toBe(false);
    expect(isSyncCombinationAllowed('1m', '1mo'), '1mo 不提供（用户裁决）').toBe(false);
    expect(isSyncCombinationAllowed('1d', '1mo')).toBe(false);
    expect(isSyncCombinationAllowed('1mo', '1w')).toBe(false);
  });
});
