import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { Bar, Period } from '@/api/types';

/**
 * ADR-028 §7 / 02-spec §9 冻结条：结果页建图**必须**放宽 `barSpaceLimit`（供宽窗口跳转），
 * **该放宽不得泄漏到看板基准图/宫格**（ADR-020 严格：`init(el)` 不传 options ⇒ 引擎默认 `{min:1,max:50}`）。
 *
 * 本文件是「不泄漏」的**配置断言**（真渲染 E2E 只覆盖结果页；看板默认态在此钉死）：
 *  1. **不传** `barSpaceLimit`（看板基准/宫格/多周期关闭态口径）⇒ `init` **不得**带 `layout.barSpaceLimit`
 *     （⇒ 引擎默认 max=50，大 barSpace 仍被静默吞掉 —— ADR-020 语义不变）；
 *  2. `barSpaceLimit = RESULT_BAR_SPACE_LIMIT`（结果页 K 线实例所传）⇒ `init` options 放宽到 max=400。
 *
 * 位置：`web/src/features/workbench/resultBarSpaceLimit.test.tsx`
 */

const H = vi.hoisted(() => ({ initArgs: [] as unknown[][] }));

vi.mock('klinecharts', async () => {
  const { createSyncChartStub, makeSeries } = await import('@/test/syncChartStub');
  const bars = makeSeries({ count: 600, spacingMs: 86_400_000, endTs: Date.UTC(2026, 8, 14) });
  const sync = createSyncChartStub({ bars, paneWidthPx: 520, limit: { min: 1, max: 400 } });
  const chartStub = Object.assign(sync, {
    setSymbol: vi.fn(),
    setPeriod: vi.fn(),
    setDataLoader: vi.fn(),
    setStyles: vi.fn(),
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    overrideIndicator: vi.fn(),
    getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
      indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {}),
    ),
    resetData: vi.fn(),
    setPaneOptions: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    resize: vi.fn(),
    convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
  });
  return {
    init: vi.fn((...args: unknown[]) => {
      H.initArgs.push(args);
      return chartStub;
    }),
    dispose: vi.fn(),
  };
});

import { KlineChart, type KlineChartFeedLike } from '@/features/dashboard/KlineChart';
import { RESULT_BAR_SPACE_LIMIT } from '@/features/workbench/KlineResultChart';

function fakeFeed(): KlineChartFeedLike {
  return {
    bars: [] as Bar[],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
  };
}

const INDICATORS = { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false };

function props(over: Record<string, unknown> = {}) {
  return {
    feed: fakeFeed(),
    code: '518880',
    period: '1d' as Period,
    followLatest: false,
    indicators: INDICATORS,
    onManualZoom: () => {},
    ...over,
  };
}

describe('ADR-028 §7 barSpaceLimit 放宽边界（配置断言：只放宽结果页实例）', () => {
  beforeEach(() => {
    H.initArgs.length = 0;
  });

  it('看板基准/宫格口径（**不传** barSpaceLimit）⇒ init 不带 layout.barSpaceLimit（引擎默认 max=50）', async () => {
    render(<KlineChart {...props()} />);
    await waitFor(() => expect(H.initArgs.length).toBeGreaterThan(0));
    const options = H.initArgs[0]?.[1] as { layout?: { barSpaceLimit?: unknown } } | undefined;
    expect(options?.layout?.barSpaceLimit).toBeUndefined();
  });

  it('结果页实例（传 RESULT_BAR_SPACE_LIMIT）⇒ init 放宽到 max=400', async () => {
    render(<KlineChart {...props({ barSpaceLimit: RESULT_BAR_SPACE_LIMIT })} />);
    await waitFor(() => expect(H.initArgs.length).toBeGreaterThan(0));
    const options = H.initArgs[0]?.[1] as { layout?: { barSpaceLimit?: { min?: number; max?: number } } };
    expect(options?.layout?.barSpaceLimit?.max).toBe(400);
    expect(options?.layout?.barSpaceLimit?.min).toBe(1);
  });
});
