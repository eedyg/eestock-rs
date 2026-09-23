import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import type { ApiClient } from '@/api/client';
import { createMockClient } from '@/api/mock';
import type { WorkbenchRunView } from '@/api/types';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { useState } from 'react';
import { KlineResultChart } from './KlineResultChart';
import { IndicatorToggles } from '@/features/dashboard/IndicatorToggles';
import { useResultChartConfig, RESULT_CHART_CONFIG_KEY } from './resultChartConfig';
import {
  CARD_HEIGHT_STORAGE_KEY,
  DEFAULT_KLINE_PX,
  KLINE_CANDLE_MIN_PX,
  KLINE_AXIS_PX,
  KLINE_CARD_BORDER_PX,
  PANE_SEPARATOR_PX,
  SUB_PANE_MIN_PX,
  readCardHeight,
  writeCardHeight,
} from './resultCardHeights';
import type { RunFillsState } from './useRunSeries';

/** jsdom 无 canvas：klinecharts 整体打桩（与 ResultView.test 同模式）。 */
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  overrideIndicator: vi.fn(),
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {}),
  ),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setBarSpace: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
  registerOverlay: vi.fn(),
}));

const api: ApiClient = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });

const RUN = {
  id: 'sr_test_resize',
  name: '缩放/指标波',
  symbol: '518880',
  period: 'M5',
  from_ts: '2026-01-05T01:30:00Z',
  to_ts: '2026-01-05T07:00:00Z',
  config: { slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }], initial_capital: 100000 },
  status: 'succeeded',
  progress: 1,
  error: null,
  created_at: '2026-01-05T00:00:00Z',
  started_at: null,
  finished_at: null,
} as unknown as WorkbenchRunView;

const FILLS: RunFillsState = {
  rows: [],
  total: 0,
  recorded: true,
  loading: false,
  error: null,
  complete: true,
  truncated: false,
};

/**
 * 结果页容器：K 线卡 + 共享指标勾选（模拟 ResultView 的接线，不引曲线依赖）。
 *
 * 接线口径（2026-09-23 D6 契约变更）：
 *  - 卡高由 `KlineResultChart` **内部**按 pane 几何派生 bounds（有效下限 = 卡头 + 1 + 26 + 160 + 30×副图数）；
 *  - 记忆写**结果页独立 key**（`eestock.result.cardHeights.v1`），不再寄存在指标 key 的 `cardHeights` 字段；
 *  - 指标勾选仍在指标 key（语义不变）。
 */
function Page() {
  const cfg = useResultChartConfig();
  const [heightPx, setHeightPx] = useState<number | null>(() => readCardHeight('kline'));
  return (
    <div>
      <KlineResultChart
        run={RUN}
        fills={FILLS}
        api={api}
        indicators={cfg.indicators}
        heightPx={heightPx}
        onCommitHeight={(px) => {
          writeCardHeight('kline', px);
          setHeightPx(px);
        }}
        toggleSlot={
          <IndicatorToggles
            indicators={cfg.indicators}
            onToggle={cfg.toggleIndicator}
            testIdPrefix="wb-indicator-toggle"
          />
        }
      />
    </div>
  );
}

/**
 * 打开指标浮层（ADR-028 §2.6 第 5 项「头部瘦身」：勾选收进浮层，保留多选与 testid）。
 * 旧断言直接 `findByTestId('wb-indicator-toggle-*')`（勾选恒占整行 40px）；
 * 新口径下必须先开 `wb-indicator-menu`（否则卡头无法 ≤48px）。
 */
async function openIndicators() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('wb-indicator-menu'));
  });
  await screen.findByTestId('wb-indicator-toggles');
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('I1 副图指标可选（结果页复用看板实现）', () => {
  it('六枚指标开关（ma/vol/macd/kdj/boll/dcap）出现在结果页 K 线卡内，默认 = DASHBOARD_DEFAULTS（vol 开）', async () => {
    render(<Page />);
    // 契约变更（ADR-028 §2.6 第 5 项）：勾选在浮层内 ⇒ 需先打开入口
    await openIndicators();
    for (const k of ['ma', 'vol', 'macd', 'kdj', 'boll', 'dcap']) {
      const btn = await screen.findByTestId(`wb-indicator-toggle-${k}`);
      expect(btn.getAttribute('aria-pressed')).toBe(String(DASHBOARD_DEFAULTS.indicators[k as 'vol']));
    }
    expect((screen.getByTestId('wb-indicator-toggle-vol') as HTMLElement).textContent).toBe('VOL');
    expect((screen.getByTestId('wb-indicator-toggle-macd') as HTMLElement).textContent).toBe('MACD');
  });

  it('点击 MACD ⇒ 真身 createIndicator("MACD")（入口必须接线到图表，不得只是装饰）', async () => {
    render(<Page />);
    await waitFor(() => expect(chartStub.createIndicator).toHaveBeenCalled());
    await openIndicators();
    chartStub.createIndicator.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wb-indicator-toggle-macd'));
    });
    await waitFor(() =>
      expect(
        chartStub.createIndicator.mock.calls.some((c) => (c[0] as { name?: string })?.name === 'MACD'),
      ).toBe(true),
    );
    // 默认副图 VOL 已在场，开 MACD 不得移除它（多选语义）
    expect(chartStub.removeIndicator).not.toHaveBeenCalledWith({ name: 'VOL' });
  });

  it('关 VOL ⇒ removeIndicator("VOL")（副图真身必须受开关驱动）', async () => {
    render(<Page />);
    await waitFor(() => expect(chartStub.createIndicator).toHaveBeenCalled());
    await openIndicators();
    chartStub.removeIndicator.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wb-indicator-toggle-vol'));
    });
    await waitFor(() => expect(chartStub.removeIndicator).toHaveBeenCalledWith({ name: 'VOL' }));
  });

  it('选择独立持久化：只写结果页指标 key，且刷新（重新挂载）后保持', async () => {
    const first = render(<Page />);
    await openIndicators();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wb-indicator-toggle-macd'));
    });
    const raw = localStorage.getItem(RESULT_CHART_CONFIG_KEY);
    expect(raw, '指标选择必须落结果页独立 key').not.toBeNull();
    expect(Object.keys(localStorage)).toEqual([RESULT_CHART_CONFIG_KEY]);
    expect(JSON.parse(raw!)['indicators']['macd']).toBe(true);
    first.unmount();
    vi.clearAllMocks();
    render(<Page />);
    await openIndicators();
    await waitFor(() =>
      expect(screen.getByTestId('wb-indicator-toggle-macd').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(DASHBOARD_DEFAULTS.indicators.macd, '看板默认值不得被结果页改写').toBe(false);
  });
});

describe('I2 K 线卡可上下缩放 + 双击标题复位（D6-1/D6-4/D6-6 单测面）', () => {
  it('默认卡高 = 520（D6-1）且内层图表容器 flex 弹性（min-h-0 flex-1）', async () => {
    render(<Page />);
    const card = await screen.findByTestId('wb-kline-chart');
    await waitFor(() => expect(card.style.height).toBe(`${DEFAULT_KLINE_PX}px`));
    expect(card.className).not.toContain('h-64'); // 旧契约（固定 256）已移除
    expect(card.querySelector('.min-h-0.flex-1'), '内层图表容器必须 min-h-0 flex-1').not.toBeNull();
  });

  it('拖下边缘 +40px ⇒ 卡高 560 与 klinecharts 容器双跟随（D6-6）', async () => {
    render(<Page />);
    const card = await screen.findByTestId('wb-kline-chart');
    await waitFor(() => expect(card.style.height).toBe('520px'));
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 400 });
    fireEvent.mouseMove(window, { clientY: 440 });
    fireEvent.mouseUp(window, { clientY: 440 });
    await waitFor(() => expect(card.style.height).toBe('560px'));
    expect(card.style.flexShrink).toBe('0');
    expect(localStorage.getItem(CARD_HEIGHT_STORAGE_KEY)).toContain('560');
  });

  it('上拖越界 ⇒ 停在**有效下限**（D6-4：卡头 + 1 + 26 + 160 + 30×副图数；jsdom 卡头未测量 ⇒ 兜底 24）', async () => {
    render(<Page />);
    const card = await screen.findByTestId('wb-kline-chart');
    await waitFor(() => expect(card.style.height).toBe('520px'));
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 400 });
    fireEvent.mouseMove(window, { clientY: -4000 });
    fireEvent.mouseUp(window, { clientY: -4000 });
    // 有效下限 = 卡头 + **卡边框 2**（实测补项：卡 237 − 卡头 20 − 容器 215 = 2）+ 分隔 1 + x轴 26 + 160 + 30×副图数
    const expectedMin =
      24 + KLINE_CARD_BORDER_PX + PANE_SEPARATOR_PX + KLINE_AXIS_PX + KLINE_CANDLE_MIN_PX + SUB_PANE_MIN_PX * 1;
    await waitFor(() => expect(card.style.height).toBe(`${expectedMin}px`));
    expect(Number(card.style.height.replace('px', ''))).toBeGreaterThanOrEqual(200);
  });

  it('双击 K 线卡标题 ⇒ 复位到默认 520（D6-6）且记忆清除', async () => {
    render(<Page />);
    const card = await screen.findByTestId('wb-kline-chart');
    // 最大高 = 视口高 − 200（jsdom innerHeight 768 ⇒ 568）⇒ 只拖 +40（560）以免撞上限
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 400 });
    fireEvent.mouseMove(window, { clientY: 440 });
    fireEvent.mouseUp(window, { clientY: 440 });
    await waitFor(() => expect(card.style.height).toBe('560px'));
    await act(async () => {
      fireEvent.doubleClick(screen.getByTestId('wb-card-title-kline'));
    });
    await waitFor(() => expect(card.style.height).toBe('520px'));
    expect(readCardHeight('kline')).toBeNull();
  });

  it('刷新（重新挂载）后卡片高度保持', async () => {
    const first = render(<Page />);
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 400 });
    fireEvent.mouseMove(window, { clientY: 440 });
    fireEvent.mouseUp(window, { clientY: 440 });
    await waitFor(() =>
      expect((screen.getByTestId('wb-kline-chart') as HTMLElement).style.height).toBe('560px'),
    );
    first.unmount();
    render(<Page />);
    await waitFor(() =>
      expect((screen.getByTestId('wb-kline-chart') as HTMLElement).style.height).toBe('560px'),
    );
  });
});
