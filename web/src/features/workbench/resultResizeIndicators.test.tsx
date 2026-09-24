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
import { CARD_HEIGHT_STORAGE_KEY } from './resultCardHeights';
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
function Page({ viewPx = 0 }: { viewPx?: number } = {}) {
  const cfg = useResultChartConfig();
  return (
    <div>
      <KlineResultChart
        run={RUN}
        fills={FILLS}
        api={api}
        indicators={cfg.indicators}
        viewPx={viewPx}
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

/**
 * I2 —— **由 D6「K 线卡可上下缩放」重锚为 D9-5「视图高度取代卡片高度」**（ADR-028 §2.9 第 5 项）。
 *
 * 契约推导（旧 → 新）：
 *  - 旧 `D6-1` 「默认卡高 520」/ `D6-2` 「S/M/L 预设 260/420/560」/ `D6-4` 「有效下限」/ `D6-6` 「下沿把手 + 双击标题复位」
 *    ⇒ **删除**：K 线卡高由外层「K 线视图」分配（卡片 `h-full`），可调性转移到**视图分隔条**（D9-6）。
 *  - 因此本组判据从「拖把手改变卡高」改为**断言卡高机制不存在**（判据须有鉴别力：旧实现下必红）。
 */
describe('I2 K 线卡高机制**已删除**（D9-5：视图高度取代卡片高度）', () => {
  it('卡片 `h-full` 随视图（不再有 inline height / flexShrink:0 的卡高契约）', async () => {
    render(<Page />);
    const card = await screen.findByTestId('wb-kline-chart');
    expect(card.style.height, '卡片不得再有 inline 卡高（D9-5）').toBe('');
    expect(card.className).toContain('h-full');
    expect(card.querySelector('.min-h-0.flex-1'), '内层图表容器必须 min-h-0 flex-1').not.toBeNull();
  });

  it('**不存在** S/M/L 预设条与卡片下沿把手（D9-5 断言缺失）', async () => {
    render(<Page />);
    await screen.findByTestId('wb-kline-chart');
    expect(screen.queryByTestId('wb-card-resize-kline'), 'K 线卡下沿把手必须不存在').toBeNull();
    for (const k of ['s', 'm', 'l']) {
      expect(screen.queryByTestId(`wb-kline-preset-${k}`), `S/M/L 预设 ${k} 必须不存在`).toBeNull();
    }
    // 视图级可调性由分隔条承担（本组件不渲染；此处只断言旧机制不再存在）
    expect(screen.queryByTestId('wb-kline-preset')?.textContent ?? null).toBeNull();
  });

  it('卡高记忆语义已删：本组件**不写**任何卡高 key（旧 `cardHeights.kline` 只作只读迁移源）', async () => {
    render(<Page />);
    await screen.findByTestId('wb-kline-chart');
    expect(localStorage.getItem(CARD_HEIGHT_STORAGE_KEY), 'K 线卡高不得再被写入').toBeNull();
  });

  it('`viewPx` 只作可观测性透出（`data-kline-view-height`），不参与卡高判定', async () => {
    render(<Page viewPx={520} />);
    const card = await screen.findByTestId('wb-kline-chart');
    await waitFor(() => expect(card.getAttribute('data-kline-view-height')).toBe('520'));
    expect(card.style.height).toBe('');
  });
});

describe('I2b 旧「刷新后卡高保持」判据的重锚', () => {
  it('旧 `cardHeights.kline` 只作**只读迁移源**：本组件挂载/卸载均不改写它（逐字节不变）', async () => {
    localStorage.setItem(CARD_HEIGHT_STORAGE_KEY, JSON.stringify({ kline: 560 }));
    const first = render(<Page />);
    await screen.findByTestId('wb-kline-chart');
    expect(localStorage.getItem(CARD_HEIGHT_STORAGE_KEY)).toBe(JSON.stringify({ kline: 560 }));
    first.unmount();
    render(<Page />);
    await screen.findByTestId('wb-kline-chart');
    expect(localStorage.getItem(CARD_HEIGHT_STORAGE_KEY)).toBe(JSON.stringify({ kline: 560 }));
  });
});
