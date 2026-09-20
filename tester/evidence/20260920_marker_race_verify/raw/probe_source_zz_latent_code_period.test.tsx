/**
 * 临时取证探针（tester，本波；跑完即删，源码归档到
 * `tester/evidence/20260920_marker_race_verify/raw/probe_source_zz_latent_code_period.test.tsx`）。
 *
 * 用途：为「同类位置 #2：Effect W 读 `props.code`/`props.period` 而依赖只有 `[feed]`」给**可执行**判定依据：
 * 在同一 `feed` 对象身份下改变 `code`/`period` props（= 违反调用方隐式契约的场景），观察
 * `chart.setSymbol` / `chart.setPeriod` 是否被重新调用 —— 不调用即「陈旧值」形态（潜在隐患）。
 * 本探针**不改生产代码**，只观测并落盘读数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bar, Period } from '@/api/types';
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';

const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  setBarSpace: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {})),
  overrideIndicator: vi.fn(),
  resetData: vi.fn(),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setPaneOptions: vi.fn(),
  resize: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })) as unknown as (...args: unknown[]) => { x: number; y: number },
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

import { KlineChart } from '@/features/dashboard/KlineChart';
import type { KlineChartFeedLike } from '@/features/dashboard/KlineChart';

const OUT = process.env.ZZ_PROBE_OUT ?? '/tmp/zz-probe';

function fakeFeed(): KlineChartFeedLike {
  return {
    bars: [] as Bar[],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
  };
}

const IND = { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false };

function view(feed: KlineChartFeedLike, code: string, period: Period) {
  return (
    <KlineChart feed={feed} code={code} period={period} followLatest indicators={IND} onManualZoom={() => {}} />
  );
}

describe('探针：同类位置 #2（props.code/period 读法）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('同一 feed 身份下改 code/period：chart.setSymbol/setPeriod 是否被重新调用', () => {
    const feed = fakeFeed();
    const { rerender } = render(view(feed, '518880', '1d'));
    const afterMount = {
      setSymbol: chartStub.setSymbol.mock.calls.length,
      setPeriod: chartStub.setPeriod.mock.calls.length,
      symbols: chartStub.setSymbol.mock.calls.map((c) => (c[0] as { ticker?: string }).ticker),
    };

    // 变更 props（同一 feed 对象）
    rerender(view(feed, '159776', '1h'));
    const afterChange = {
      setSymbol: chartStub.setSymbol.mock.calls.length,
      setPeriod: chartStub.setPeriod.mock.calls.length,
      symbols: chartStub.setSymbol.mock.calls.map((c) => (c[0] as { ticker?: string }).ticker),
      periods: chartStub.setPeriod.mock.calls.map((c) => String(c[0])),
    };

    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      resolve(OUT, 'latent_code_period.json'),
      JSON.stringify({ afterMount, afterChange }, null, 2),
      'utf8',
    );

    // 观测事实（本探针只记录，不断言「应当」如何）：
    expect(afterChange.setSymbol, '同 feed 身份下 code 变化**不会**重接 symbol（陈旧值形态）').toBe(afterMount.setSymbol);
    expect(afterChange.setPeriod, '同 feed 身份下 period 变化**不会**重接 period（陈旧值形态）').toBe(afterMount.setPeriod);
  });
});
