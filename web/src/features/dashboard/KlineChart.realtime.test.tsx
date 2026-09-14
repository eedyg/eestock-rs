/**
 * 红测试（阶段 1，Red）—— T-R4「rtCallback 启动竞态：不得静默丢弃」+ T-R5「非跟随态可见性提示」
 * + T-R3(c)「只有 followLatest && !manualAdjusted 才 scrollToRealTime」。
 *
 * 本文件位置：`web/src/features/dashboard/KlineChart.realtime.test.tsx`
 * 权威依据：
 *  - 诊断：`tester/report/055_kline_realtime_bar_append_diagnosis.md` §3.3（rtCallback===null 窗口）、
 *    §0 R2（非跟随态新 bar 落在可见区之外）、§6(a)3 与 §6(b)「不打断手动缩放/历史翻阅」
 *  - 设计：`tester/design/055_realtime_append_red_test_design.md` §1 T-R4/T-R2-b、§2 桩策略
 *  - 任务口径（架构师裁决）：①**绝不**自动把非跟随态视口拉回最右；④失败不弹错。
 *
 * 覆盖缺口（为什么本次缺陷能藏这么久）：现有全部 `KlineChart.*.test.tsx` 把 `onRealtime` 打桩为
 * `vi.fn(() => () => {})`（空订阅），没有任何用例验证「WS bar → feed.onRealtime → subscribeBar 回调」
 * 这一环；本文件用**可捕获 subscribeBar 回调**的 chart 桩补齐该链路。
 *
 * 钉死的判据（当前实现必红项已标注）：
 *  - T-R4-a（必红）：引擎尚未调用 `subscribeBar`（`rtCallback===null`）期间到达的实时 bar **不得静默丢弃**；
 *    `subscribeBar` 注册后必须按序补投（缓冲），此后到达的 bar 直投（不重复、不丢）。修法：缓冲并在
 *    `subscribeBar` 注册时冲刷（诊断 §6(a)3）。
 *  - T-R5-a（必红）：`followLatest=false` 且新 bar 落在视口之外 ⇒ 必须出现「有新数据」可感知提示，
 *    且**不得**改变视口（`scrollToRealTime` 未被调用）。
 *  - T-R5-b（必红）：点击提示后才跳转到最新（`scrollToRealTime` 被调用）。
 *  - T-R5-c / T-R5-d（守卫）：跟随态不提示；非跟随态但新 bar 落在视口内不提示。
 *  - T-R3-c1（守卫）：非跟随态实时 bar 到达不得滚动（现状已满足，防回归）。
 *  - T-R3-c2（必红）：用户已手动缩放/平移（`manualAdjusted`）时**即使** `followLatest=true` 也不得滚动。
 *
 * seam 约定（本红测试要求的最小契约）：
 *  - 提示渲染在 `[data-testid="kline-chart"]` 容器内，文本包含「新数据」（与视图同域，非跟随态可直接看到）；
 *    点击该提示 ⇒ 跳转到最新（`chart.scrollToRealTime()`）。提示的视口判定同时满足两种宽度读取方式
 *    （`clientWidth` 与 `getBoundingClientRect()` 均已打桩）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import type { Bar } from '@/api/types';
import type { KlineChartFeedLike } from './KlineChart';

/** convertToPixel 单独持有 Mock 引用（stub 里做类型收窄，供用例按场景改返回值） */
const convertToPixel = vi.fn(() => ({ x: 0, y: 0 }));

const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  setBarSpace: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  overrideIndicator: vi.fn(),
  resetData: vi.fn(),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setPaneOptions: vi.fn(),
  resize: vi.fn(),
  removeOverlay: vi.fn(),
  createOverlay: vi.fn(),
  convertToPixel: convertToPixel as unknown as (...args: unknown[]) => { x: number; y: number },
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

import { KlineChart } from './KlineChart';

const BASE_INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: false };

function mkBar(ts: string, close = 1): Bar {
  return { ts, open: close, high: close + 0.01, low: close - 0.01, close, volume: 100, amount: 100 };
}

const TS1 = '2026-09-14T01:53:00Z';
const TS2 = '2026-09-14T01:54:00Z';
const TS3 = '2026-09-14T01:55:00Z';

/** 可捕获 `onRealtime` 回调的 feed 桩（真实 KlineDataFeed 实时面的等价物） */
function makeFeedStub() {
  let cb: ((bar: Bar) => void) | null = null;
  const feed: KlineChartFeedLike = {
    bars: [],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn((h: (bar: Bar) => void) => {
      cb = h;
      return () => {
        cb = null;
      };
    }),
    viewportBars: 120,
  };
  return { feed, emit: (b: Bar) => cb?.(b) };
}

function renderChart(opts: { followLatest?: boolean } = {}) {
  const { feed, emit } = makeFeedStub();
  const utils = render(
    <KlineChart
      feed={feed}
      code="518880"
      period="15m"
      followLatest={opts.followLatest ?? true}
      indicators={BASE_INDICATORS}
      onManualZoom={() => {}}
    />,
  );
  return { ...utils, feed, emit };
}

/** DataLoader（setDataLoader 的实参）——rtCallback 的唯一注册入口 */
function dataLoader() {
  const call = chartStub.setDataLoader.mock.calls[0];
  if (!call) throw new Error('setDataLoader 未被调用');
  return call[0] as {
    getBars: (a: { type: string; callback: (...args: unknown[]) => void }) => Promise<void>;
    subscribeBar: (a: { callback: (d: unknown) => void }) => void;
    unsubscribeBar: () => void;
  };
}

/** 视口宽度 + 实时 bar 像素 x（两种宽度读取方式都打桩，避免绑定实现细节） */
function setViewport(el: HTMLElement, width: number, rtX: number) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  el.getBoundingClientRect = () =>
    ({ width, height: 400, left: 0, top: 0, right: width, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  convertToPixel.mockReturnValue({ x: rtX, y: 100 });
}

describe('T-R4 rtCallback 启动竞态（subscribeBar 注册前到达的实时 bar 不得静默丢弃）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertToPixel.mockReturnValue({ x: 0, y: 0 });
  });

  it('T-R4-a 注册前到达的 bar 必须缓冲、注册后按序补投；其后到达的直投', async () => {
    const { emit } = renderChart();
    const loader = dataLoader();
    expect(typeof loader.subscribeBar).toBe('function');

    // 引擎尚未调用 subscribeBar ⇒ rtCallback === null
    await act(async () => {
      emit(mkBar(TS1, 1.5));
      emit(mkBar(TS2, 1.6));
    });

    const cb = vi.fn();
    await act(async () => {
      loader.subscribeBar({ callback: cb });
    });

    // 缓冲的两根必须补投（当前实现 `rtCallback?.(kc)` 直接丢弃 ⇒ 此断言红）
    expect(cb).toHaveBeenCalledTimes(2);
    const delivered = cb.mock.calls.map((c) => c[0] as { timestamp: number; close: number });
    expect(delivered.map((d) => d.timestamp)).toEqual([Date.parse(TS1), Date.parse(TS2)]);
    expect(delivered[0]!.close).toBe(1.5);

    // 注册之后到达的必须直投（缓冲不残留、不重复）
    await act(async () => {
      emit(mkBar(TS3, 1.7));
    });
    expect(cb).toHaveBeenCalledTimes(3);
    expect((cb.mock.calls[2]![0] as { timestamp: number }).timestamp).toBe(Date.parse(TS3));
  });

  it('T-R4-b 守卫：无竞态（先注册 subscribeBar，再到达）时不得重复投递', async () => {
    const { emit } = renderChart();
    const cb = vi.fn();
    await act(async () => {
      dataLoader().subscribeBar({ callback: cb });
    });
    await act(async () => {
      emit(mkBar(TS1, 1.5));
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('T-R3-c 只有 followLatest && !manualAdjusted 才 scrollToRealTime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertToPixel.mockReturnValue({ x: 0, y: 0 });
  });

  it('T-R3-c1 守卫：非跟随态实时 bar 到达不得滚动（口径①：绝不把非跟随视口拉回最右）', async () => {
    const { emit } = renderChart({ followLatest: false });
    const before = chartStub.scrollToRealTime.mock.calls.length;
    await act(async () => {
      emit(mkBar(TS1, 1.5));
    });
    expect(chartStub.scrollToRealTime.mock.calls.length).toBe(before);
  });

  it('T-R3-c2 用户已手动缩放/平移（manualAdjusted）时即使 followLatest=true 也不得滚动', async () => {
    const { emit } = renderChart({ followLatest: true });
    // 捕获图表动作订阅，模拟用户手动缩放（非程序化滚动）
    const onZoom = chartStub.subscribeAction.mock.calls.find((c) => c[0] === 'onZoom')?.[1] as
      | (() => void)
      | undefined;
    expect(typeof onZoom).toBe('function');
    act(() => {
      onZoom!();
    });

    const before = chartStub.scrollToRealTime.mock.calls.length;
    await act(async () => {
      emit(mkBar(TS1, 1.5));
    });
    expect(chartStub.scrollToRealTime.mock.calls.length).toBe(before);
  });
});

describe('T-R5 非跟随态可见性提示（有新数据，且不改变视口；点击后才跳转最新）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-R5-a 新 bar 落在视口之外 → 出现「新数据」提示，且视口不变（不 scrollToRealTime）', async () => {
    const { emit } = renderChart({ followLatest: false });
    const container = screen.getByTestId('kline-chart');
    // 诊断实测：非跟随态 rtX=2165 / 绘图区宽 1251 ⇒ 新 bar 在可见区之外
    setViewport(container, 680, 2165);
    const before = chartStub.scrollToRealTime.mock.calls.length;

    await act(async () => {
      emit(mkBar(TS1, 1.5));
    });

    expect(within(container).queryAllByText(/新数据/).length).toBeGreaterThan(0);
    expect(chartStub.scrollToRealTime.mock.calls.length).toBe(before);
  });

  it('T-R5-b 点击提示 → 跳转到最新（scrollToRealTime）', async () => {
    const { emit } = renderChart({ followLatest: false });
    const container = screen.getByTestId('kline-chart');
    setViewport(container, 680, 2165);
    await act(async () => {
      emit(mkBar(TS1, 1.5));
    });
    const hint = within(container).queryAllByText(/新数据/)[0];
    expect(hint).toBeTruthy();
    const before = chartStub.scrollToRealTime.mock.calls.length;
    await act(async () => {
      fireEvent.click(hint!.closest('button') ?? hint!);
    });
    expect(chartStub.scrollToRealTime.mock.calls.length).toBeGreaterThan(before);
  });

  it('T-R5-c 守卫：跟随态（followLatest=true）不得出现提示', async () => {
    const { emit } = renderChart({ followLatest: true });
    const container = screen.getByTestId('kline-chart');
    setViewport(container, 680, 620); // 跟随态新 bar 落在可见区内
    await act(async () => {
      emit(mkBar(TS1, 1.5));
    });
    expect(within(container).queryAllByText(/新数据/)).toHaveLength(0);
  });

  it('T-R5-d 守卫：非跟随态但新 bar 落在可见区内 → 不得提示', async () => {
    const { emit } = renderChart({ followLatest: false });
    const container = screen.getByTestId('kline-chart');
    setViewport(container, 680, 100); // 视口内
    await act(async () => {
      emit(mkBar(TS1, 1.5));
    });
    expect(within(container).queryAllByText(/新数据/)).toHaveLength(0);
  });
});
