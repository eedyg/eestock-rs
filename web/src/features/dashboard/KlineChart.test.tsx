import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { Bar } from '@/api/types';

// jsdom 无 canvas：klinecharts 整体打桩（chart 装配行为由 KlineChart 测试断言 createIndicator calcParams）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
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

import { KlineChart } from './KlineChart';
import type { KlineChartFeedLike } from './KlineChart';

function fakeFeed(): KlineChartFeedLike {
  return {
    bars: [] as Bar[],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
  };
}

const BASE_INDICATORS = { ma: true, macd: false, kdj: false, boll: false };

describe('KlineChart（MA 窗口可配置：calcParams 用配置 windows）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('不传 maWindows → MA calcParams 默认 [5,10,20]', () => {
    render(
      <KlineChart
        feed={fakeFeed()}
        code="518880"
        period="1d"
        followLatest
        indicators={BASE_INDICATORS}
        onManualZoom={() => {}}
      />,
    );
    expect(chartStub.createIndicator).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'MA', calcParams: [5, 10, 20] }),
      false,
    );
  });

  it('传 maWindows=[7,20,60] → MA calcParams=[7,20,60]', () => {
    render(
      <KlineChart
        feed={fakeFeed()}
        code="518880"
        period="1d"
        followLatest
        indicators={BASE_INDICATORS}
        onManualZoom={() => {}}
        maWindows={[7, 20, 60]}
      />,
    );
    expect(chartStub.createIndicator).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'MA', calcParams: [7, 20, 60] }),
      false,
    );
  });

  it('maWindows 变化 → 重新 sync 应用新 calcParams（统一配置热生效）', () => {
    const feed = fakeFeed();
    const { rerender } = render(
      <KlineChart
        feed={feed}
        code="518880"
        period="1d"
        followLatest
        indicators={BASE_INDICATORS}
        onManualZoom={() => {}}
        maWindows={[5, 10, 20]}
      />,
    );
    expect(chartStub.createIndicator).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'MA', calcParams: [5, 10, 20] }),
      false,
    );
    rerender(
      <KlineChart
        feed={feed}
        code="518880"
        period="1d"
        followLatest
        indicators={BASE_INDICATORS}
        onManualZoom={() => {}}
        maWindows={[7, 20, 60]}
      />,
    );
    // 每次 sync 会 createIndicator 多个指标（MA/VOL…）；MA 是最近一次用新窗口创建
    const maCalls = chartStub.createIndicator.mock.calls.filter(
      ([c]) => typeof c === 'object' && c !== null && (c as { name?: string }).name === 'MA',
    );
    expect(maCalls[maCalls.length - 1]![0]).toMatchObject({ name: 'MA', calcParams: [7, 20, 60] });
  });
});
