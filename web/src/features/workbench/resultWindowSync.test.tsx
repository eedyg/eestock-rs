import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';
import { createMockClient } from '@/api/mock';
import type { WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
import { ResultView } from './ResultView';
import { PositionRatioChart } from './PositionRatioChart';

/**
 * P5b 结果页**窗口联动**集成（F7/F9/F10）：K 线回调 → 窗口事实源 → 曲线窗口取数 →
 * 持仓比率视图（口径消歧）+ L1/L2 跳转接线与断言。
 *
 * 图表面用 syncChartStub（忠实模型，含 `setBarSpace` 越界静默 return）。
 */
const KC_BARS = makeSeries({ count: 900, spacingMs: 86_400_000, endTs: Date.UTC(2026, 8, 14) });
const syncStub = createSyncChartStub({ bars: KC_BARS, paneWidthPx: 520, limit: { min: 1, max: 400 } });
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
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
});
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });

const BASE = {
  symbol: '518880',
  period: 'D1',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  policy: { LumpSum: { position_pct: 1 } } as const,
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
};

async function seed(): Promise<{ run: WorkbenchRunView; result: WorkbenchRunResult }> {
  const run = await api.submitWorkbenchRun({
    ...BASE,
    name: '窗口联动测试',
    slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    stop: { kind: 'FixedPct', value: 0.08, trigger: 'Intrabar' },
  });
  const result = await api.getWorkbenchResult(run.id);
  return { run, result };
}

function renderView(run: WorkbenchRunView, result: WorkbenchRunResult) {
  return render(
    <ResultView
      run={run}
      result={result}
      loading={false}
      error={null}
      onRetry={() => {}}
      api={api}
      catalog={null}
    />,
  );
}

describe('F10 持仓比率视图（口径消歧：三口径各带分母）', () => {
  it('渲染 position_ratio 曲线 + cash_ratio + nav 恒等式，且三口径标签**各含分母**', () => {
    render(
      <PositionRatioChart
        points={[
          { ts: 1000, qty: 10, position_value: 500, cash: 500, nav: 1000, position_ratio: 0.5 },
          { ts: 2000, qty: 20, position_value: 800, cash: 200, nav: 1000, position_ratio: 0.8 },
        ]}
        domain={{ from_ts: 0, to_ts: 3000 }}
        cumulative={{ deployedPct: 0.4139, cashConsumedPct: 0.4160, recorded: true }}
      />,
    );
    expect(screen.getByTestId('position-line')).toBeTruthy();
    expect(screen.getByTestId('wb-last-position-ratio').textContent).toContain('position_ratio 80.00%');
    expect(screen.getByTestId('wb-last-cash-ratio').textContent).toContain('cash_ratio 20.00%');
    // nav 恒等式同屏可辨（position_value + cash == nav）
    expect(screen.getByTestId('wb-last-nav').textContent).toContain('800.00');
    expect(screen.getByTestId('wb-last-nav').textContent).toContain('200.00');
    // 三口径各带分母（ADR-028 §4.5）
    expect(screen.getByTestId('wb-basis-position-ratio').textContent).toContain('时点净值');
    expect(screen.getByTestId('wb-basis-cash-ratio').textContent).toContain('时点净值');
    expect(screen.getByTestId('wb-basis-deployed').textContent).toContain('初始资金');
    expect(screen.getByTestId('wb-basis-deployed').textContent).toContain('区间');
    expect(screen.getByTestId('wb-basis-cash-consumed').textContent).toContain('初始资金');
    expect(screen.getByTestId('wb-basis-cash-consumed').textContent).toContain('区间');
  });

  it('无点 ⇒ 显式空态（不得静默空白）', () => {
    render(<PositionRatioChart points={[]} domain={null} cumulative={null} />);
    expect(screen.getByTestId('wb-position-chart').textContent).toContain('无持仓序列数据');
  });

  it('结果页同屏出现持仓比率视图且三口径标签可见（审计加载后 deployed_pct 单值上屏）', async () => {
    const { run, result } = await seed();
    renderView(run, result);
    await waitFor(() => expect(screen.getByTestId('wb-position-chart')).toBeTruthy());
    const basis = within(screen.getByTestId('wb-position-basis'));
    expect(basis.getByTestId('wb-basis-position-ratio').textContent).toContain('时点净值');
    expect(basis.getByTestId('wb-basis-deployed').textContent).toContain('初始资金');
    expect(basis.getByTestId('wb-basis-cash-consumed').textContent).toContain('初始资金');
    // 审计为「交易明细」Tab 懒加载 ⇒ 等它到了必须给出单值（不是「审计未加载」）
    await waitFor(() =>
      expect(screen.getByTestId('wb-basis-deployed').textContent).not.toContain('审计未加载'),
    );
  });
});

describe('F7/F9 窗口事实源：K 线交互写入 + L1 跳转 + 断言', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncStub.__events.length = 0;
    syncStub.__log.length = 0;
  });

  it('K 线交互写窗：onVisibleRangeChange ⇒ 状态机记录 source=kline，X 定义域随之传下去', async () => {
    const { run, result } = await seed();
    renderView(run, result);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      syncStub.__setRightIndex(600);
      syncStub.__fireAction('onVisibleRangeChange');
    });
    await waitFor(() => expect(screen.getByTestId('wb-window-state').textContent).toContain('来源 kline'));
    expect(screen.getByTestId('wb-window-state').textContent).toContain('rev');
  });

  it('L1 跳转：窗口 = 回合区间（source=jump），且 K 线实例收到并**断言成功**（无 applyError）', async () => {
    const { run, result } = await seed();
    renderView(run, result);
    const jumps = await screen.findAllByTestId(/^wb-rt-jump-/);
    expect(jumps.length).toBeGreaterThan(0);
    await userEvent.click(jumps[0]!);
    await waitFor(() => expect(screen.getByTestId('wb-window-state').textContent).toContain('来源 jump'));
    // 跳转必须落到 K 线实例上（写窗调用了定位原语）且未报错
    expect(syncStub.__log.some((c) => c.method === 'scrollToDataIndex')).toBe(true);
    expect(screen.queryByTestId('wb-window-apply-error')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('wb-window-applying')).toBeNull());
  });

  it('全览：窗口回到全区间（请求态）+ 以**实测可达区间**建立窗口（source=reset；D10-2 真值写回）且历史栈可回退', async () => {
    const { run, result } = await seed();
    renderView(run, result);
    const jumps = await screen.findAllByTestId(/^wb-rt-jump-/);
    await userEvent.click(jumps[0]!);
    await waitFor(() => expect(screen.getByTestId('wb-window-state').textContent).toContain('来源 jump'));
    await userEvent.click(screen.getByTestId('wb-window-reset'));
    // ADR-028 §2.10 D10 决策 2：「全览」请求全区间，而物理上只能显示可达子区间 ⇒
    // 以实测可达区间**写回窗口状态机**（source=reset），使「取数窗口 == 可见域」重新成立
    // （旧口径下窗口停在「全区间」而 x 域取真身切片 ⇒ 逐点剔除）。
    await waitFor(() => expect(screen.getByTestId('wb-window-state').textContent).toContain('来源 reset'));
    const probe = screen.getByTestId('wb-window-probe');
    const state = screen.getByTestId('wb-window-state');
    expect(state.getAttribute('data-from-ts')).toBe(probe.getAttribute('data-live-from-ts'));
    expect(state.getAttribute('data-to-ts')).toBe(probe.getAttribute('data-live-to-ts'));
    expect(state.getAttribute('data-span-bars')).toBe(probe.getAttribute('data-live-bars'));
    expect(screen.getByTestId('wb-window-history').textContent).toContain('可回退 1 步');
    // 历史回退 ⇒ 回到跳转前的窗口
    await userEvent.click(screen.getByTestId('wb-window-back'));
    await waitFor(() => expect(screen.getByTestId('wb-window-state').textContent).toContain('来源 jump'));
  });
});
