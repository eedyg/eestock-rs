import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { createSyncChartStub } from '@/test/syncChartStub';
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import type { Bar, Period } from '@/api/types';
import type { WindowCommand } from './klineWindowOps';

/**
 * ADR-028 §2.10 **D10 决策 1**：程序化写窗成功后**锁定视口**（禁 `fitBarSpaceToViewport` 重拟合），
 * 直到「真实手势 / 数据面变化（换 run·换周期）/ 组件卸载」才解锁。
 *
 * **判据必须有鉴别力**（禁恒真）：同一套动作在**未锁定**基线下必须**真的改掉 barSpace**（见用例 1），
 * 锁定后同一动作必须**一个字节都不动**（用例 2）——两侧共用同一驱动函数，去掉锁定实现 ⇒ 用例 2 必红。
 *
 * jsdom 无 ResizeObserver 实现 ⇒ 本文件注入**捕获型** RO，手工派发回调（与真身「容器尺寸变化」同构）。
 */

type MockFn = ReturnType<typeof vi.fn>;
type ChartStub = ReturnType<typeof createSyncChartStub> & {
  setSymbol: MockFn;
  setPeriod: MockFn;
  setDataLoader: MockFn;
  setStyles: MockFn;
  createIndicator: MockFn;
  removeIndicator: MockFn;
  overrideIndicator: MockFn;
  getIndicators: MockFn;
  resetData: MockFn;
  setPaneOptions: MockFn;
  createOverlay: MockFn;
  removeOverlay: MockFn;
  resize: MockFn;
  convertToPixel: MockFn;
};
let chartStub: ChartStub;
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

import { KlineChart, type KlineChartFeedLike } from './KlineChart';

/** 捕获型 ResizeObserver（jsdom 缺口补齐；仅测试用）。 */
class CapturingRO {
  static cbs: Array<() => void> = [];
  constructor(cb: () => void) {
    CapturingRO.cbs.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  static fireAll(): void {
    for (const cb of CapturingRO.cbs) cb();
  }
}
const realRO = globalThis.ResizeObserver;

/** 容器宽度（真身 `fitBarSpaceToViewport` 的输入）。 */
const PANE_W = 520;
/** `viewportBars` 缺省 120 ⇒ 未锁定基线里 fit 会写 `round(520/120) = 4`。 */
const FIT_BS = 4;

const ALL_IND = { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false };

function makeStub(bars: number[]): void {
  const stub = createSyncChartStub({ bars, paneWidthPx: PANE_W, limit: { min: 1, max: 400 } });
  chartStub = Object.assign(stub, {
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
  }) as unknown as ChartStub;
}

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

const now = Date.UTC(2026, 8, 14, 7, 0, 0);
function bars(n: number, stepMs = 300_000): number[] {
  return Array.from({ length: n }, (_, i) => now - (n - 1 - i) * stepMs);
}

/** 程序化写窗命令（L2 语义：成交 bar 居中 `span` 根）。 */
function cmd(rev: number, span = 60, mode: 'bars' | 'range' = 'bars'): WindowCommand {
  const list = bars(600);
  const center = list[list.length - 250]! / 1000;
  return {
    rev,
    from_ts: center - span * 150,
    to_ts: center + span * 150,
    span_bars: span,
    center_ts: center,
    span_mode: mode,
  };
}

/** 宿主容器（`ref` 所在元素）：给出 clientWidth（jsdom 无布局）。 */
function hostEl(): HTMLElement {
  const el = screen.getByTestId('kline-chart');
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: PANE_W });
  return el;
}

/** 真身 barSpace（引擎读回）。 */
const bs = (): number => chartStub.getBarSpace().bar;

function renderChart(
  props: Partial<Parameters<typeof KlineChart>[0]> = {},
  feed: KlineChartFeedLike = fakeFeed(),
): ReturnType<typeof render> {
  return render(
    <KlineChart
      feed={feed}
      code="518880"
      period={'1m' as Period}
      followLatest
      indicators={ALL_IND}
      onManualZoom={() => {}}
      barSpaceLimit={{ min: 1, max: 400 }}
      {...props}
    />,
  );
}

beforeEach(() => {
  CapturingRO.cbs = [];
  (globalThis as Record<string, unknown>).ResizeObserver = CapturingRO;
  vi.clearAllMocks();
  makeStub(bars(600));
});
afterEach(() => {
  (globalThis as Record<string, unknown>).ResizeObserver = realRO;
  cleanup();
});

describe('D10-1 基线（未写窗 ⇒ 无锁定）：容器尺寸变化**确实**重拟合 barSpace', () => {
  it('无 windowCommand：RO 回调把 barSpace 写成 round(520/120)=4（本文件其它用例的对照基线）', () => {
    renderChart();
    hostEl();
    const before = bs();
    expect(before).not.toBe(FIT_BS);
    act(() => CapturingRO.fireAll());
    expect(bs()).toBe(FIT_BS);
    expect(hostEl().getAttribute('data-viewport-lock')).toBeNull();
  });
});

describe('D10-1 锁定：程序化写窗成功后禁重拟合（直到真实手势/数据面变化/卸载）', () => {
  it('跳转成功后 RO 回调**不再**改写 barSpace（锁定生效）且宿主留痕 data-viewport-lock=1', () => {
    const onApplied = vi.fn();
    renderChart({ windowCommand: cmd(1), onWindowApplied: onApplied });
    hostEl();
    expect(onApplied).toHaveBeenCalled();
    const applied = bs();
    expect(applied).toBeGreaterThan(0);
    expect(hostEl().getAttribute('data-viewport-lock')).toBe('1');
    act(() => CapturingRO.fireAll());
    expect(bs(), 'RO 重拟合被锁定禁止（去掉锁定 ⇒ 本断言必红）').toBe(applied);
    // 引擎里也**没有**任何 fit 值的写入尝试（日志级证据）
    const fitWrites = chartStub.__log.filter((c) => c.method === 'setBarSpace' && c.args[0] === FIT_BS);
    expect(fitWrites.length).toBe(0);
  });

  it('锁定后数据重载（向前分页 ⇒ resetData/init 回调）不得重拟合（第二条 fit 路径同受锁定）', async () => {
    renderChart({ windowCommand: cmd(1) });
    hostEl();
    const applied = bs();
    // 触发 loader init（真身：分页/resetData 会重跑 init 回调 → 旧实现此处 fitBarSpace 覆盖跳转值）
    const loader = chartStub.setDataLoader.mock.calls[0]![0] as {
      getBars: (arg: { type: string; callback: (...a: unknown[]) => void }) => Promise<void>;
    };
    await act(async () => {
      await loader.getBars({ type: 'init', callback: () => {} });
    });
    expect(bs(), 'init 路径的重拟合必须同受锁定').toBe(applied);
  });

  it('真实手势解锁：锁定解除（留痕移除）；此后数据面变化即可重拟合（禁「窗跳不动」）', () => {
    const c = cmd(1);
    const { rerender } = renderChart({ windowCommand: c });
    hostEl();
    const applied = bs();
    expect(hostEl().getAttribute('data-viewport-lock')).toBe('1');
    act(() => {
      chartStub.__fireAction('onZoom');
    });
    expect(hostEl().getAttribute('data-viewport-lock'), '真实手势 ⇒ 交还视口自主权').toBeNull();
    // 手势后 `manualAdjusted` 仍按 ADR-020 禁用自动重拟合（既有口径不变，不是锁定残留）
    act(() => CapturingRO.fireAll());
    expect(bs(), '手动视口被尊重（既有 ADR-020 §2.6 口径）').toBe(applied);
    // 数据面变化（换周期）⇒ `manualAdjusted` 复位 ⇒ 自动重拟合恢复（锁定确实已释放）
    act(() => {
      rerender(
        <KlineChart
          feed={fakeFeed()}
          code="518880"
          period={'5m' as Period}
          followLatest
          indicators={ALL_IND}
          onManualZoom={() => {}}
          barSpaceLimit={{ min: 1, max: 400 }}
          windowCommand={c}
        />,
      );
    });
    act(() => CapturingRO.fireAll());
    expect(bs()).toBe(FIT_BS);
  });

  it('数据面变化（换周期/换 run ⇒ feed 身份变化）解锁：RO 重拟合恢复', () => {
    const c = cmd(1);
    const { rerender } = renderChart({ windowCommand: c });
    hostEl();
    expect(hostEl().getAttribute('data-viewport-lock')).toBe('1');
    act(() => {
      rerender(
        <KlineChart
          feed={fakeFeed()}
          code="518880"
          period={'5m' as Period}
          followLatest
          indicators={ALL_IND}
          onManualZoom={() => {}}
          barSpaceLimit={{ min: 1, max: 400 }}
          windowCommand={c}
        />,
      );
    });
    expect(hostEl().getAttribute('data-viewport-lock')).toBeNull();
    act(() => CapturingRO.fireAll());
    expect(bs()).toBe(FIT_BS);
  });

  it('卸载后重挂（同 slot 新实例）⇒ 锁定状态不残留（实例级状态，非模块级）', () => {
    renderChart({ windowCommand: cmd(1) });
    hostEl();
    expect(hostEl().getAttribute('data-viewport-lock')).toBe('1');
    cleanup();
    makeStub(bars(600)); // 新图实例（真身：容器不变 ⇒ 不重建；测试里显式重建以验证状态归属）
    renderChart();
    hostEl();
    expect(hostEl().getAttribute('data-viewport-lock'), '新实例必须无锁定残留').toBeNull();
    act(() => CapturingRO.fireAll());
    expect(bs()).toBe(FIT_BS);
  });

  it('非结果页消费者（不传 windowCommand）⇒ 宿主上**不出现** data-viewport-lock（F8：逐字节不变）', () => {
    renderChart();
    hostEl();
    expect(hostEl().getAttribute('data-viewport-lock')).toBeNull();
  });
});

describe('D10-1 解锁穷尽：全览/回退等新程序化写窗 = 重新授权（窗口可再变）', () => {
  it('锁定后再次下发**新 rev** 的程序化命令 ⇒ 真身窗口确实再变（禁「锁死」）', () => {
    const c1 = cmd(1, 60);
    const c2 = cmd(2, 20);
    const onApplied = vi.fn();
    const { rerender } = renderChart({ windowCommand: c1, onWindowApplied: onApplied });
    hostEl();
    const first = chartStub.getVisibleRange();
    const firstBars = Math.round(first.to) - Math.round(first.from) + 1;
    act(() => {
      rerender(
        <KlineChart
          feed={fakeFeed()}
          code="518880"
          period={'1m' as Period}
          followLatest
          indicators={ALL_IND}
          onManualZoom={() => {}}
          barSpaceLimit={{ min: 1, max: 400 }}
          windowCommand={c2}
        />,
      );
    });
    const second = chartStub.getVisibleRange();
    const secondBars = Math.round(second.to) - Math.round(second.from) + 1;
    expect(secondBars, '新窗口必须真的生效（20 根窗口 ≠ 60 根窗口）').not.toBe(firstBars);
    expect(secondBars).toBeLessThan(firstBars);
    // 新命令仍处于锁定态（继续保护该视口）：RO 回调不得改写 barSpace
    const bsAfterSecond = bs();
    act(() => CapturingRO.fireAll());
    expect(bs(), '新程序化窗口同样受锁定保护').toBe(bsAfterSecond);
    expect(hostEl().getAttribute('data-viewport-lock')).toBe('1');
  });
});
