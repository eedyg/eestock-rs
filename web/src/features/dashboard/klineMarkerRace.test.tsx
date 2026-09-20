import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';
import type { Bar, Period } from '@/api/types';

/**
 * ADR-028 D4.1 买卖标记**次序无关重建**（竞态修复的组件级固化）。
 *
 * 根因（tester 取证：`tester/evidence/20260920_t4_flaky_rootcause/report.md` §3.5）：
 * `/fills` 先于图表 K 线数据提交时，标记重建路径读的是**挂载渲染时的 `props.overlays` 陈旧快照**
 * （当时为空）+ `feed.bars` 为空 ⇒ 建 0 个标记，且此后无任何重建路径 ⇒ **永久丢失**
 * （`data-marker-overlays=0`，而页面上仍显示「成交合计 N 笔（已加载 N/N）」= 静默不一致）。
 *
 * 本文件把「次序」两侧都固化为判据：
 *  ① K 线数据**后**到（/fills 先到）：标记必须出现（== 已加载成交笔数）；
 *  ② K 线数据**先**到（/fills 后到）：标记必须出现（既有路径，防回归）；
 *  ③ 数据代际变化（resetData/warmup/换 run/换周期 ⇒ 引擎重跑 DataLoader init）：标记必须重建且不重复；
 *  ④ 重建**事件驱动**：无事件时推进时间不得产生任何新建（禁定时轮询/固定 sleep）。
 *
 * 图表面用 `@/test/syncChartStub`（klinecharts 公开面的忠实模型），overlay 面按「先清后建」语义
 * 忠实建模 `createOverlay`/`removeOverlay({name})`（即 `getOverlays({name})` 的真身口径）。
 */

const DAY = 86_400_000;
const BAR_TSS = makeSeries({ count: 174, spacingMs: DAY, endTs: Date.UTC(2026, 8, 14) });
const BARS: Bar[] = BAR_TSS.map((ms) => ({
  ts: new Date(ms).toISOString(),
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 0,
  amount: 0,
}));
/** 成交笔数（与 tester 取样 run 的 44 笔同口径：这里只要求「每笔一个标记」）。 */
const FILL_COUNT = 44;

function markerOverlays(count = FILL_COUNT) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'marker' as const,
    ts: BAR_TSS[BAR_TSS.length - count + i]!,
    text: 'B',
    price: 1 + i / 1000,
    color: '#ff5c6c',
    shape: 'dot' as const,
    fillKey: `1:${i}`,
    label: `B 1.000×${i}`,
    stackIndex: 0,
  }));
}

const INDICATORS = { ma: false, vol: false, macd: false, kdj: false, boll: false, dcap: false };

/** overlay store 忠实建模（先清后建 ⇒ 同名 remove 后建 = 不重复；`getOverlays({name})` 口径）。 */
interface StubOverlay {
  name?: string;
  extendData?: unknown;
  points?: unknown;
}
const overlayStore: StubOverlay[] = [];

const syncStub = createSyncChartStub({ bars: [], paneWidthPx: 520 });
const chartStub = Object.assign(syncStub, {
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
  resize: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
  createOverlay: vi.fn((o: StubOverlay) => {
    overlayStore.push(o);
    return o;
  }),
  removeOverlay: vi.fn((filter?: { name?: string }) => {
    if (!filter || filter.name == null) {
      overlayStore.length = 0;
      return;
    }
    for (let i = overlayStore.length - 1; i >= 0; i--) {
      if (overlayStore[i]!.name === filter.name) overlayStore.splice(i, 1);
    }
  }),
});
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

import { KlineChart, type KlineChartFeedLike } from './KlineChart';

/** 标记数 = 真身 `getOverlays({name:'fillDot'}).length` 的等价物。 */
function liveMarkers(name = 'fillDot'): StubOverlay[] {
  return overlayStore.filter((o) => o.name === name);
}

/** 手动触发引擎的 DataLoader init（真身由 `resetData`/`setSymbol`/`setPeriod` 内部调用；
 *  jsdom + 桩 chart 不会自动调）。 */
async function triggerInitGetBars(): Promise<void> {
  const loader = chartStub.setDataLoader.mock.calls.at(-1)![0] as {
    getBars: (arg: { type: string; callback: (...args: unknown[]) => void }) => Promise<void>;
  };
  await act(async () => {
    await loader.getBars({ type: 'init', callback: () => {} });
  });
}

function baseFeed(bars: Bar[]): KlineChartFeedLike {
  return {
    bars,
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
  };
}

function renderRace(feed: KlineChartFeedLike, overlays: ReturnType<typeof markerOverlays>) {
  const props = {
    feed,
    code: '518880',
    period: '1d' as Period,
    followLatest: false,
    indicators: INDICATORS,
    onManualZoom: () => {},
  };
  const view = render(<KlineChart {...props} overlays={overlays} />);
  return {
    ...view,
    rerenderWith: (next: ReturnType<typeof markerOverlays>) =>
      view.rerender(<KlineChart {...props} overlays={next} />),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  overlayStore.length = 0;
  syncStub.__events.length = 0;
  syncStub.__log.length = 0;
});

describe('ADR-028 D4.1 标记重建：次序无关 + 幂等（竞态修复固化）', () => {
  it('① K 线数据后到（/fills 先落定）⇒ 标记仍然出现（不得用挂载时的陈旧 overlays 快照）', async () => {
    let releaseLoad: () => void = () => {};
    const pending = new Promise<void>((r) => {
      releaseLoad = r;
    });
    const feed = baseFeed([]);
    feed.loadInitial = vi.fn(() => pending);

    const { rerenderWith, getByTestId } = renderRace(feed, []);
    // /fills 先落定 ⇒ overlays: [] → 44 笔（此刻 feed.bars 仍为空：K 线数据未到）
    rerenderWith(markerOverlays());
    await waitFor(() => expect(liveMarkers().length).toBe(0));

    // K 线数据随后到位（feed.bars 填充 + DataLoader init 取数落定）
    feed.bars = [...BARS];
    releaseLoad();
    await act(async () => {
      await pending;
    });

    await waitFor(() =>
      expect(
        liveMarkers().length,
        'K 线数据一到，标记就必须按**最新** overlays 重建（每笔成交一个 fillDot）',
      ).toBe(FILL_COUNT),
    );
    expect(getByTestId('kline-chart').getAttribute('data-marker-overlays')).toBe(String(FILL_COUNT));
    // 不得有重复累积（先清后建）
    expect(overlayStore.filter((o) => o.name === 'fillDot').length).toBe(FILL_COUNT);
  });

  it('② K 线数据先到（/fills 后落定）⇒ 标记出现（既有路径，防回归）', async () => {
    const feed = baseFeed([...BARS]);
    const { rerenderWith, getByTestId } = renderRace(feed, []);
    await triggerInitGetBars();
    expect(liveMarkers().length).toBe(0);

    rerenderWith(markerOverlays());
    await waitFor(() => expect(liveMarkers().length).toBe(FILL_COUNT));
    expect(getByTestId('kline-chart').getAttribute('data-marker-overlays')).toBe(String(FILL_COUNT));
  });

  it('③ 数据代际变化（引擎重跑 DataLoader init：resetData/warmup/换 run/换周期）⇒ 标记重建且不重复', async () => {
    const feed = baseFeed([...BARS]);
    const { getByTestId } = renderRace(feed, markerOverlays());
    await waitFor(() => expect(liveMarkers().length).toBe(FILL_COUNT));

    // 代际变化：向前补取更早 bar（warmup 热更新路径 prepend）后引擎原地重载数据
    const earlier: Bar[] = BAR_TSS.slice(0, 10).map((ms, i) => ({
      ts: new Date(ms - 10 * DAY + i * DAY).toISOString(),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 0,
      amount: 0,
    }));
    feed.bars = [...earlier, ...BARS];
    await triggerInitGetBars();

    await waitFor(() =>
      expect(
        liveMarkers().length,
        '代际变化后标记数必须仍 == 成交笔数（不丢失、不重复）',
      ).toBe(FILL_COUNT),
    );
    expect(getByTestId('kline-chart').getAttribute('data-marker-overlays')).toBe(String(FILL_COUNT));
  });

  it('④ 重建事件驱动：无事件时推进时间不得新建任何标记（禁定时轮询/固定 sleep）', async () => {
    vi.useFakeTimers();
    try {
      const feed = baseFeed([...BARS]);
      renderRace(feed, markerOverlays());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(liveMarkers().length).toBe(FILL_COUNT);
      const created = chartStub.createOverlay.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(
        chartStub.createOverlay.mock.calls.length,
        '10s 内无数据/overlay 事件 ⇒ 不得有任何新建（重建只能由依赖变化驱动）',
      ).toBe(created);
      expect(liveMarkers().length).toBe(FILL_COUNT);
    } finally {
      vi.useRealTimers();
    }
  });
});
