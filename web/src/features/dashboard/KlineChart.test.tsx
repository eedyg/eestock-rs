import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { DEFAULT_KLINE_VIEWPORT_BARS } from './feed';

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

describe('KlineChart（fitBarSpace 铺满目标 = 配置视口根数 viewportBars，与周期无关）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('feed.viewportBars=200（15m）→ space=round(680/200)=3（不再按每日 bar 数折算）', async () => {
    renderChart({ viewportBars: 200 }, '15m');
    Object.defineProperty(screen.getByTestId('kline-chart'), 'clientWidth', { configurable: true, value: 680 });
    await triggerInitGetBars();
    expect(chartStub.setBarSpace).toHaveBeenCalledWith(3);
  });

  it('同一 viewportBars 下 1m/1d 得到同一 space（周期无关；旧实现 1m 夹 1、1d 夹 50）', async () => {
    for (const period of ['1m', '1d'] as const) {
      vi.clearAllMocks();
      const { unmount } = renderChart({ viewportBars: 120 }, period);
      Object.defineProperty(screen.getByTestId('kline-chart'), 'clientWidth', { configurable: true, value: 960 });
      await triggerInitGetBars();
      expect(chartStub.setBarSpace).toHaveBeenCalledWith(8); // round(960/120)=8
      unmount();
    }
  });

  it('无 viewportBars（fallback 默认 120）→ space=round(960/120)=8', async () => {
    expect(DEFAULT_KLINE_VIEWPORT_BARS).toBe(120);
    renderChart({}, '15m');
    Object.defineProperty(screen.getByTestId('kline-chart'), 'clientWidth', { configurable: true, value: 960 });
    await triggerInitGetBars();
    expect(chartStub.setBarSpace).toHaveBeenCalledWith(8);
  });

  it('容器宽度 ≤ 0（未布局）→ 不调用 setBarSpace', async () => {
    renderChart({ viewportBars: 120 }, '15m');
    Object.defineProperty(screen.getByTestId('kline-chart'), 'clientWidth', { configurable: true, value: 0 });
    await triggerInitGetBars();
    expect(chartStub.setBarSpace).not.toHaveBeenCalled();
  });

  it('fit 完成后在根节点写 data-viewport-fit（e2e 断言面，§5 观测性）', async () => {
    renderChart({ viewportBars: 120 }, '15m');
    const el = screen.getByTestId('kline-chart');
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 980 });
    await triggerInitGetBars();
    expect(el.getAttribute('data-viewport-fit')).toBe(
      JSON.stringify({ bars: 120, space: 8, visible: 122, clamped: false }),
    );
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

/**
 * R7：resize 语义 —— ResizeObserver 宽度变化重算 barSpace；
 * 用户手动缩放/平移后 resize 不再重算；「回到最新」（followLatest false→true）恢复跟随并重算 + scrollToRealTime。
 */
class RoMock {
  static instances: RoMock[] = [];
  observed: Element[] = [];
  constructor(public cb: ResizeObserverCallback) {
    RoMock.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
}

function fireResize() {
  const ro = RoMock.instances[RoMock.instances.length - 1]!;
  ro.cb([], ro as unknown as ResizeObserver);
}

function onZoomCallback(): () => void {
  const call = chartStub.subscribeAction.mock.calls.find(([n]) => n === 'onZoom');
  return call![1] as () => void;
}

function renderControlled(feed: KlineChartFeedLike, followLatest: boolean) {
  const tree = (f: boolean, fd: KlineChartFeedLike = feed) => (
    <KlineChart
      feed={fd}
      code="518880"
      period="15m"
      followLatest={f}
      indicators={BASE_INDICATORS}
      onManualZoom={() => {}}
      maWindows={[5, 10, 20]}
    />
  );
  const { rerender } = render(tree(followLatest));
  return { rerender: (f: boolean, fd?: KlineChartFeedLike) => rerender(tree(f, fd)) };
}

describe('KlineChart R7（resize 重算 / 手动缩放抑制 / 回到最新恢复）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    RoMock.instances = [];
    vi.stubGlobal('ResizeObserver', RoMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('容器宽度变化（ResizeObserver 回调）→ 用新宽度重新 setBarSpace', async () => {
    const feed = fakeFeed({ viewportBars: 120 });
    renderControlled(feed, true);
    const el = screen.getByTestId('kline-chart');
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 980 });
    await triggerInitGetBars();
    expect(chartStub.setBarSpace).toHaveBeenLastCalledWith(8); // round(980/120)

    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 470 });
    fireResize();
    expect(chartStub.setBarSpace).toHaveBeenLastCalledWith(4); // round(470/120)
    expect(el.getAttribute('data-viewport-fit')).toBe(
      JSON.stringify({ bars: 120, space: 4, visible: 117, clamped: false }),
    );
  });

  it('用户手动缩放（onZoom 非 programmatic）后 resize 不再重算（尊重手动视口）', async () => {
    const feed = fakeFeed({ viewportBars: 120 });
    renderControlled(feed, false);
    const el = screen.getByTestId('kline-chart');
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 980 });
    await triggerInitGetBars();
    expect(chartStub.setBarSpace).toHaveBeenCalledTimes(1);

    onZoomCallback()(); // 手动缩放
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 470 });
    fireResize();
    expect(chartStub.setBarSpace).toHaveBeenCalledTimes(1); // 未重算
  });

  it('followLatest false→true（回到最新）→ 解除抑制、重算并 scrollToRealTime', async () => {
    const feed = fakeFeed({ viewportBars: 120 });
    const { rerender } = renderControlled(feed, false);
    const el = screen.getByTestId('kline-chart');
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 980 });
    await triggerInitGetBars();
    onZoomCallback()(); // 手动缩放 → 抑制
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 470 });
    fireResize();
    expect(chartStub.setBarSpace).toHaveBeenCalledTimes(1);

    chartStub.scrollToRealTime.mockClear();
    rerender(true);
    expect(chartStub.setBarSpace).toHaveBeenLastCalledWith(4); // 重算
    expect(chartStub.scrollToRealTime).toHaveBeenCalled();
    // 抑制已解除：后续 resize 恢复重算
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 980 });
    fireResize();
    expect(chartStub.setBarSpace).toHaveBeenLastCalledWith(8);
  });

  it('feed 重建（周期切换）→ 抑制状态重置，resize 重新生效', async () => {
    const first = fakeFeed({ viewportBars: 120 });
    const { rerender } = renderControlled(first, false);
    const el = screen.getByTestId('kline-chart');
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 980 });
    await triggerInitGetBars();
    onZoomCallback()();
    fireResize();
    expect(chartStub.setBarSpace).toHaveBeenCalledTimes(1);

    rerender(false, fakeFeed({ viewportBars: 120 }));
    fireResize();
    expect(chartStub.setBarSpace).toHaveBeenLastCalledWith(8);
  });
});
