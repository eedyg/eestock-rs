import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bar, Period } from '@/api/types';

// jsdom 无 canvas：klinecharts 整体打桩（chart 装配行为由 KlineChart 测试断言 createIndicator calcParams）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  setBarSpace: vi.fn(),
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

function fakeFeed(overrides: Partial<KlineChartFeedLike> = {}): KlineChartFeedLike {
  return {
    bars: [] as Bar[],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
    ...overrides,
  };
}

/** 手动触发 KlineChart 的 DataLoader init（真实环境 klinecharts 引擎会自动调 getBars('init')；
 *  jsdom + 桩 chart 不会自动调，需手动触发以驱动 fitBarSpace）。 */
async function triggerInitGetBars(): Promise<void> {
  const loader = chartStub.setDataLoader.mock.calls[0]![0] as {
    getBars: (arg: { type: string; callback: (...args: unknown[]) => void }) => Promise<void>;
  };
  await loader.getBars({ type: 'init', callback: () => {} });
}

const BASE_INDICATORS = { ma: true, macd: false, kdj: false, boll: false };

function renderChart(overrides: Partial<KlineChartFeedLike> = {}, period: Period = '1d') {
  return render(
    <KlineChart
      feed={fakeFeed(overrides)}
      code="518880"
      period={period}
      followLatest
      indicators={BASE_INDICATORS}
      onManualZoom={() => {}}
    />,
  );
}

describe('KlineChart（fitBarSpace 铺满目标 = 配置视口 viewportDays×每日bar，而非恒 2 视口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('feed.viewportDays=4（15m）→ fitBarSpace 目标=17×4=68，setBarSpace 用 68(space=10) 而非 34(space=20)', async () => {
    renderChart({ viewportDays: 4 }, '15m');
    // 容器宽 680：target=68 → space=round(680/68)=10；若仍用默认 2 视口(34) → space=20
    Object.defineProperty(screen.getByTestId('kline-chart'), 'clientWidth', { configurable: true, value: 680 });
    await triggerInitGetBars();
    expect(chartStub.setBarSpace).toHaveBeenCalledWith(10);
  });

  it('无 viewportDays（fallback 默认 2）→ fitBarSpace 目标=17×2=34（旧行为保留，不破坏无配置 feed）', async () => {
    renderChart({}, '15m');
    Object.defineProperty(screen.getByTestId('kline-chart'), 'clientWidth', { configurable: true, value: 680 });
    await triggerInitGetBars();
    expect(chartStub.setBarSpace).toHaveBeenCalledWith(20);
  });
});

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
