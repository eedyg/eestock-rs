import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkbenchBarRecord, WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
import { createMockClient } from '@/api/mock';
import { ResultView } from './ResultView';
import { buildMarkers } from './KlineResultChart';

// jsdom 无 canvas：klinecharts 整体打桩（与 BacktestPage.test 同模式）
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

const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });

async function seedRunAndResult(): Promise<{ run: WorkbenchRunView; result: WorkbenchRunResult }> {
  const run = await api.submitWorkbenchRun({
    name: '结果测试',
    symbol: '518880',
    period: 'D1',
    from: '2026-01-01T00:00:00Z',
    to: '2026-04-01T00:00:00Z',
    slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    stop: { kind: 'FixedPct', value: 0.08, trigger: 'Intrabar' },
    policy: { LumpSum: { position_pct: 1 } },
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
  });
  const result = await api.getWorkbenchResult(run.id);
  return { run, result };
}

function mkProps(run: WorkbenchRunView | null, result: WorkbenchRunResult | null, over: Record<string, unknown> = {}) {
  return {
    run,
    result,
    loading: false,
    error: null as string | null,
    onRetry: vi.fn(),
    api,
    catalog: null,
    ...over,
  } as const;
}

describe('ResultView（ADR §13.5 结果页布局）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未选中 run → 占位；failed run → error 展示；结果加载失败 → 错误+重试', async () => {
    const { unmount } = render(<ResultView {...mkProps(null, null)} />);
    expect(screen.getByTestId('wb-result-empty')).toBeInTheDocument();
    unmount();

    const { result } = await seedRunAndResult();
    void result;
    const failedRun = (await api.listWorkbenchRuns({ status: 'failed' }))[0]!;
    render(<ResultView {...mkProps(failedRun, null)} />);
    expect(screen.getByTestId('wb-run-error')).toHaveTextContent('mock 引擎错误');
  });

  it('结果渲染：K线容器 + 总分曲线（阈值线+三区着色）+ 各策略曲线 + 净值回撤 + 默认 Tab 交易明细', async () => {
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    expect(screen.getByTestId('wb-kline-chart')).toBeInTheDocument();
    // 总分曲线：60/40 阈值线 + buy/hold/sell 三区着色
    expect(screen.getByTestId('wb-aggregate-chart')).toBeInTheDocument();
    expect(screen.getByTestId('threshold-buy')).toBeInTheDocument();
    expect(screen.getByTestId('threshold-sell')).toBeInTheDocument();
    expect(screen.getByTestId('zone-buy')).toBeInTheDocument();
    expect(screen.getByTestId('zone-hold')).toBeInTheDocument();
    expect(screen.getByTestId('zone-sell')).toBeInTheDocument();
    // 各策略评分曲线（图例开关，默认前 3 → 单 slot 默认开）
    expect(screen.getByTestId('wb-slot-chart')).toBeInTheDocument();
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    // 净值+回撤
    expect(screen.getByTestId('wb-equity-chart')).toBeInTheDocument();
    // 默认 Tab：交易明细
    expect(screen.getByTestId('wb-tab-trades')).toBeInTheDocument();
    expect(screen.getByTestId('wb-trades-table')).toBeInTheDocument();
  });

  it('Tab 切换：8项绩效 / 逐bar评分表 / 事件日志（含插件错误与 log）', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    await user.click(screen.getByTestId('wb-tab-metrics'));
    expect(screen.getByTestId('wb-metrics-table')).toHaveTextContent('net_profit');
    expect(screen.getByTestId('wb-metrics-table')).toHaveTextContent('avg_hold_bars');
    await user.click(screen.getByTestId('wb-tab-perbar'));
    expect(screen.getByTestId('wb-perbar-table')).toBeInTheDocument();
    await user.click(screen.getByTestId('wb-tab-events'));
    const log = screen.getByTestId('wb-event-log');
    expect(log).toHaveTextContent('plugin_log');
    expect(log).toHaveTextContent('mock log bar=0');
    expect(log).toHaveTextContent('plugin_error');
  });

  it('逐bar评分表分页：>100 行分页器可见且翻页', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    // 合成 250 bar（mock 结果为 60 bar；分页行为用合成数据锁定）
    const perBar: WorkbenchBarRecord[] = Array.from({ length: 250 }, (_, i) => ({
      ts: result.per_bar[0]!.ts + i * 86_400,
      scores: [{ slot_idx: 0, score: i % 101 }],
      aggregate: i % 101,
      signal: 'Hold' as const,
      orders: [],
      events: [],
    }));
    render(<ResultView {...mkProps(run, { ...result, per_bar: perBar })} />);
    await user.click(screen.getByTestId('wb-tab-perbar'));
    expect(screen.getByTestId('wb-perbar-page-info')).toHaveTextContent('1 / 3');
    expect(screen.getAllByTestId(/^wb-perbar-row-/).length).toBe(100);
    await user.click(screen.getByTestId('wb-perbar-next'));
    expect(screen.getByTestId('wb-perbar-page-info')).toHaveTextContent('2 / 3');
  });

  it('图例开关：取消勾选 → 该策略曲线移除', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    const chart = screen.getByTestId('wb-slot-chart');
    expect(chart.querySelectorAll('polyline').length).toBe(1);
    await user.click(screen.getByTestId('legend-slot-0'));
    expect(chart.querySelectorAll('polyline').length).toBe(0);
  });

  it('buildMarkers：fill 事件 → B/S 标记；StopTrigger → ⊗ 不同图标', async () => {
    const { result } = await seedRunAndResult();
    const markers = buildMarkers(result.per_bar);
    expect(markers.length).toBeGreaterThan(0);
    const buy = markers.find((m) => m.text === 'B');
    const stop = markers.find((m) => m.text === '⊗');
    expect(buy).toBeTruthy();
    expect(stop).toBeTruthy(); // 种子含 FixedPct 止损 → 中段 StopTrigger 强平
    expect(stop!.color).not.toBe(buy!.color);
    // 普通平仓 S（mock 期末 ForceClose 或 Sell 信号）
    expect(markers.some((m) => m.text === 'S')).toBe(true);
  });

  it('loading 骨架；结果 404（未成功）→ 错误+重试', async () => {
    const { run } = await seedRunAndResult();
    const { unmount } = render(<ResultView {...mkProps(run, null, { loading: true })} />);
    expect(screen.getByTestId('wb-result-skeleton')).toBeInTheDocument();
    unmount();
    const onRetry = vi.fn();
    render(<ResultView {...mkProps(run, null, { error: 'HTTP 404: 无结果', onRetry })} />);
    expect(screen.getByTestId('wb-result-error')).toHaveTextContent('404');
    await userEvent.setup().click(screen.getByText('重试'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('切换 run（无中间 loading 重挂载）：图例勾选态不跨 run 泄漏，默认前 3 按新 run slots 重新生效', async () => {
    const user = userEvent.setup();
    const base = {
      symbol: '518880',
      period: 'D1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
      policy: { LumpSum: { position_pct: 1 } } as const,
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    };
    // runA 双 slot / runB 单 slot（slot 数不同）
    const runA = await api.submitWorkbenchRun({
      ...base,
      slots: [
        { version_id: 'sv_mock_dual_v1', weight: 1 },
        { version_id: 'sv_mock_tpl_v1', weight: 2 },
      ],
    });
    const resultA = await api.getWorkbenchResult(runA.id);
    const runB = await api.submitWorkbenchRun({ ...base, slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }] });
    const resultB = await api.getWorkbenchResult(runB.id);
    const { rerender } = render(<ResultView {...mkProps(runA, resultA)} />);
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByTestId('legend-slot-0'));
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(false);
    // 直接 rerender 到 runB（模拟无 loading 间隙的切换）→ 勾选态按 runB slots 重置为默认
    rerender(<ResultView {...mkProps(runB, resultB)} />);
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('legend-slot-1')).toBeNull();
    // 切回 runA → 默认前 3 重新生效（不残留上次取消勾选）
    rerender(<ResultView {...mkProps(runA, resultA)} />);
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('legend-slot-1') as HTMLInputElement).checked).toBe(true);
  });

  it('自定义阈值 70/30：阈值线/三区着色按 70/30 渲染（非默认 60/40）', async () => {
    const run = await api.submitWorkbenchRun({
      name: '阈值测试',
      symbol: '518880',
      period: 'D1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
      buy_threshold: 70,
      sell_threshold: 30,
      policy: { LumpSum: { position_pct: 1 } },
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    });
    const result = await api.getWorkbenchResult(run.id);
    render(<ResultView {...mkProps(run, result)} />);
    const chart = screen.getByTestId('wb-aggregate-chart');
    expect(chart).toHaveTextContent('买入阈 70 / 卖出阈 30');
    // 阈值线 y 位置按 70/30 映射（H=160, PAD=8：y(s)=8+(1-s/100)*144）
    const yBuy = Number(screen.getByTestId('threshold-buy').getAttribute('y1'));
    const ySell = Number(screen.getByTestId('threshold-sell').getAttribute('y1'));
    expect(yBuy).toBeCloseTo(8 + 0.3 * 144, 1); // 70 → 51.2
    expect(ySell).toBeCloseTo(8 + 0.7 * 144, 1); // 30 → 108.8
    // 三区：hold 区高度 = y(30)-y(70) ≈ 57.6（默认 60/40 时为 28.8）
    const zoneHold = screen.getByTestId('zone-hold');
    expect(Number(zoneHold.getAttribute('height'))).toBeCloseTo(0.4 * 144, 1);
    expect(Number(zoneHold.getAttribute('y'))).toBeCloseTo(8 + 0.3 * 144, 1);
  });

  it('头部进度叠加 progressMap（与 RunList 同模式）：running run 实时进度覆盖 REST 行进度', async () => {
    const running = (await api.listWorkbenchRuns({ status: 'running' }))[0]!;
    expect(running.progress).toBe(0.42);
    const { unmount } = render(<ResultView {...mkProps(running, null)} />);
    expect(screen.getByTestId('wb-run-progress')).toHaveTextContent('42%');
    unmount();
    render(
      <ResultView
        {...mkProps(running, null, {
          progressMap: { [running.id]: { progress: 0.87, barTs: null } },
        })}
      />,
    );
    expect(screen.getByTestId('wb-run-progress')).toHaveTextContent('87%');
  });
});
