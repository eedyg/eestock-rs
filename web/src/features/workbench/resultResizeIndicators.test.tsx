import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import type { ApiClient } from '@/api/client';
import { createMockClient } from '@/api/mock';
import type { WorkbenchRunView } from '@/api/types';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { KlineResultChart } from './KlineResultChart';
import { IndicatorToggles } from '@/features/dashboard/IndicatorToggles';
import { useResultChartConfig, RESULT_CHART_CONFIG_KEY } from './resultChartConfig';
import { useCardResize } from './cardResize';
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

/** 结果页容器：K 线卡 + 共享指标勾选（模拟 ResultView 的接线，不引曲线依赖）。 */
function Page() {
  const cfg = useResultChartConfig();
  // 与 ResultView 同法接线（同一 hook；避免「测试用假 API、生产用真 API」的口径漂移）
  const resize = useCardResize({
    cardId: 'kline',
    heightPx: cfg.cardHeight('kline'),
    onCommit: (px) => cfg.setCardHeight('kline', px),
    defaultPx: 256,
  });
  return (
    <div>
      <KlineResultChart
        run={RUN}
        fills={FILLS}
        api={api}
        indicators={cfg.indicators}
        resize={resize}
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

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('I1 副图指标可选（结果页复用看板实现）', () => {
  it('六枚指标开关（ma/vol/macd/kdj/boll/dcap）出现在结果页 K 线卡内，默认 = DASHBOARD_DEFAULTS（vol 开）', async () => {
    render(<Page />);
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
    chartStub.removeIndicator.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wb-indicator-toggle-vol'));
    });
    await waitFor(() => expect(chartStub.removeIndicator).toHaveBeenCalledWith({ name: 'VOL' }));
  });

  it('选择独立持久化：只写结果页 key，且刷新（重新挂载）后保持', async () => {
    const first = render(<Page />);
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
    await waitFor(() =>
      expect(screen.getByTestId('wb-indicator-toggle-macd').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(DASHBOARD_DEFAULTS.indicators.macd, '看板默认值不得被结果页改写').toBe(false);
  });
});

describe('I2 K 线卡可上下缩放 + 双击标题复位', () => {
  it('拖下边缘 120px ⇒ 卡片 inline 高度 = 256+120，且内层图表容器 flex 弹性（min-h-0 flex-1）', async () => {
    render(<Page />);
    const card = await screen.findByTestId('wb-kline-chart');
    expect(card.className).toContain('h-64');
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 400 });
    fireEvent.mouseMove(window, { clientY: 520 });
    fireEvent.mouseUp(window, { clientY: 520 });
    await waitFor(() => expect(card.style.height).toBe('376px'));
    expect(card.style.flexShrink).toBe('0');
    expect(localStorage.getItem(RESULT_CHART_CONFIG_KEY)).toContain('376');
  });

  it('双击 K 线卡标题 ⇒ 复位（inline 高度清空 + 配置回 null）', async () => {
    render(<Page />);
    const card = await screen.findByTestId('wb-kline-chart');
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 400 });
    fireEvent.mouseMove(window, { clientY: 500 });
    fireEvent.mouseUp(window, { clientY: 500 });
    await waitFor(() => expect(card.style.height).toBe('356px'));
    await act(async () => {
      fireEvent.doubleClick(screen.getByTestId('wb-card-title-kline'));
    });
    await waitFor(() => expect(card.style.height).toBe(''));
    expect(JSON.parse(localStorage.getItem(RESULT_CHART_CONFIG_KEY)!)['cardHeights']['kline']).toBeNull();
  });

  it('刷新（重新挂载）后卡片高度保持', async () => {
    const first = render(<Page />);
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 400 });
    fireEvent.mouseMove(window, { clientY: 500 });
    fireEvent.mouseUp(window, { clientY: 500 });
    await waitFor(() =>
      expect((screen.getByTestId('wb-kline-chart') as HTMLElement).style.height).toBe('356px'),
    );
    first.unmount();
    render(<Page />);
    await waitFor(() =>
      expect((screen.getByTestId('wb-kline-chart') as HTMLElement).style.height).toBe('356px'),
    );
  });
});
