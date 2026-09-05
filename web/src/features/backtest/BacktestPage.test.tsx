import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import type { BacktestRunDto } from '@/api/types';
import { BacktestPage } from './BacktestPage';

function fakeWs() {
  const handlers = new Map<string, Set<(msg: unknown) => void>>();
  return {
    handlers,
    subscribe: vi.fn((topic: string, h: (msg: unknown) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    emit(topic: string, msg: unknown) {
      handlers.get(topic)?.forEach((h) => h(msg));
    },
  } as unknown as WsClient & { emit: (t: string, m: unknown) => void };
}

function renderPage(api: ApiClient, ws: ReturnType<typeof fakeWs>) {
  return render(
    <MemoryRouter>
      <BacktestPage api={api} ws={ws} />
    </MemoryRouter>,
  );
}

describe('BacktestPage（页面⑤回测工作台：骨架锚点 + 策略表单 + 任务列表 + 结果区 + 三态）', () => {
  let ws: ReturnType<typeof fakeWs>;
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    ws = fakeWs();
    api = stubApi();
  });

  it('骨架区域齐备：strategy-form / task-list / result-overview / metric-cards / trade-table / period-heatmap（compare/grid-rank 默认隐藏）', async () => {
    const { container } = renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('strategy-select')).toBeInTheDocument());
    for (const r of ['strategy-form', 'task-list', 'result-overview', 'metric-cards', 'trade-table', 'period-heatmap']) {
      expect(container.querySelector(`[data-region="${r}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-region="compare-view"]')).toBeNull();
    expect(container.querySelector('[data-region="grid-rank"]')).toBeNull();
  });

  it('策略下拉渲染 schema：default dual_ma 参数表单（fast/slow/position_pct），dropdown 含 7 款', async () => {
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('strategy-select')).toBeInTheDocument());
    const select = screen.getByTestId('strategy-select') as HTMLSelectElement;
    expect(select.options.length).toBe(7);
    expect(select.value).toBe('dual_ma');
    // schema 驱动：Num 参数渲染输入框
    expect(screen.getByTestId('param-fast')).toBeInTheDocument();
    expect(screen.getByTestId('param-slow')).toBeInTheDocument();
    expect(screen.getByTestId('param-position_pct')).toBeInTheDocument();
    // 默认值渲染
    expect((screen.getByTestId('param-fast') as HTMLInputElement).value).toBe('5');
    // 切换策略 → 参数表单随之改变（ma_rsi 含 rsi_period）
    await userEvent.selectOptions(select, 'ma_rsi');
    await waitFor(() => expect(screen.getByTestId('param-rsi_period')).toBeInTheDocument());
  });

  it('提交 → POST body：submitRun 收到含默认参数/周期/费用的请求', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('submit-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('submit-btn'));
    await waitFor(() => expect(api.submitRun).toHaveBeenCalled());
    expect(api.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({
        strategyId: 'dual_ma',
        code: '518880',
        period: '1d',
        fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 },
        params: expect.objectContaining({ fast: 5, slow: 20, position_pct: 1 }),
      }),
    );
  });

  it('网格展开：数值参数填「起:止:步长」→ submitRun params 含网格字符串（后端拆 params_grid）', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('grid-fast')).toBeInTheDocument());
    await user.clear(screen.getByTestId('grid-fast'));
    await user.type(screen.getByTestId('grid-fast'), '3:9:2');
    await user.click(screen.getByTestId('submit-btn'));
    await waitFor(() => expect(api.submitRun).toHaveBeenCalled());
    const req = (api.submitRun as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(req.params).toEqual(expect.objectContaining({ fast: '3:9:2' }));
  });

  it('TaskList 状态/进度：WS backtest_progress 推进运行中 run 的百分比', async () => {
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('task-row-12')).toBeInTheDocument());
    // 初始运行中进度 63%
    expect(screen.getByTestId('task-row-12')).toHaveTextContent('63%');
    ws.emit('backtest', { type: 'backtest_progress', run_id: 12, pct: 82, bar_ts: '2026-09-04T02:00:00Z' });
    await waitFor(() => expect(screen.getByTestId('task-row-12')).toHaveTextContent('82%'));
  });

  it('点已完成任务 → ResultOverview 渲染净值/回撤双图 + MetricCards 8 卡', async () => {
    const user = userEvent.setup();
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('task-row-11')).toBeInTheDocument());
    // 未选中时结果区占位
    expect(screen.getByText('选择已完成任务查看结果')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看' }));
    await waitFor(() => expect(screen.getByTestId('equity-drawdown-chart')).toBeInTheDocument());
    // 8 项指标卡
    for (const k of ['net_profit', 'max_drawdown', 'sharpe', 'win_rate', 'profit_factor', 'annualized_return', 'trade_count', 'avg_hold_bars']) {
      expect(screen.getByTestId(`metric-card-${k}`)).toBeInTheDocument();
    }
  });

  it('空态：无回测任务引导「暂无回测任务，从左侧提交」', async () => {
    api = stubApi({
      listRuns: vi.fn(async () => []),
    });
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByTestId('task-empty')).toBeInTheDocument());
    expect(screen.getByText('暂无回测任务，从左侧提交')).toBeInTheDocument();
  });

  it('空态：选中无交易的 run → 交易明细「本次回测无交易」', async () => {
    api = stubApi({
      listRuns: vi.fn(async () => [doneRunNoTrades]),
      getRun: vi.fn(async () => doneRunNoTrades),
    });
    renderPage(api, ws);
    await waitFor(() => expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('button', { name: '查看' }));
    await waitFor(() => expect(screen.getByText('本次回测无交易')).toBeInTheDocument());
  });

  it('点交易行 → 出现交易明细弹窗（不跳转，不重载）', async () => {
    const user = userEvent.setup();
    api = stubApi({
      listRuns: vi.fn(async () => [runWithTrades]),
      getRun: vi.fn(async () => runWithTrades),
    });
    renderPageWithLocation(api, ws);
    await waitFor(() => expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '查看' }));
    await waitFor(() => expect(screen.getByTestId('trade-row-1700000000')).toBeInTheDocument());
    const getRunCalls = (api.getRun as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByTestId('trade-row-1700000000'));
    // 弹窗出现而非跳转
    expect(await screen.findByTestId('trade-detail-modal')).toBeInTheDocument();
    // 路由不变（无 navigate → location 仍为 /），回测页未重载（getRun 未再调用）
    expect(screen.getByTestId('location-path')).toHaveTextContent('/');
    expect((api.getRun as ReturnType<typeof vi.fn>).mock.calls.length).toBe(getRunCalls);
  });

  it('点弹窗关闭 → 弹窗消失、回测页仍加载（不重载）', async () => {
    const user = userEvent.setup();
    api = stubApi({
      listRuns: vi.fn(async () => [runWithTrades]),
      getRun: vi.fn(async () => runWithTrades),
    });
    renderPageWithLocation(api, ws);
    await waitFor(() => expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '查看' }));
    await waitFor(() => expect(screen.getByTestId('trade-row-1700000000')).toBeInTheDocument());
    await user.click(screen.getByTestId('trade-row-1700000000'));
    expect(await screen.findByTestId('trade-detail-modal')).toBeInTheDocument();
    const getRunCalls = (api.getRun as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByTestId('trade-detail-close'));
    // 弹窗消失
    await waitFor(() => expect(screen.queryByTestId('trade-detail-modal')).not.toBeInTheDocument());
    // 回测页仍加载：交易表仍在、getRun 未再调用
    expect(screen.getByTestId('trade-row-1700000000')).toBeInTheDocument();
    expect((api.getRun as ReturnType<typeof vi.fn>).mock.calls.length).toBe(getRunCalls);
  });
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-path">{loc.pathname + loc.search}</div>;
}

function renderPageWithLocation(api: ApiClient, ws: ReturnType<typeof fakeWs>) {
  return render(
    <MemoryRouter>
      <LocationProbe />
      <BacktestPage api={api} ws={ws} />
    </MemoryRouter>,
  );
}

const doneRunNoTrades: BacktestRunDto = {
  id: 99,
  code: '518880',
  period: 'D1',
  strategy_id: 'dual_ma',
  params: { fast: 5, slow: 20 },
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
  status: 'done',
  progress: 100,
  current_ts: '2026-09-04T02:00:00Z',
  created_at: '2026-09-04T01:00:00Z',
  finished_at: '2026-09-04T02:00:00Z',
  error: null,
  group_id: null,
  net_value: { series: [[0, 100000], [1, 101000]], drawdown: [[0, 0], [1, 0]] },
  trades: [],
  metrics: { net_profit: 1000, max_drawdown: 0, sharpe: 1.2, win_rate: 0, profit_factor: 0, annualized_return: 0.1, trade_count: 0, avg_hold_bars: 0 },
};

const runWithTrades: BacktestRunDto = {
  id: 100,
  code: '518880',
  period: 'D1',
  strategy_id: 'dual_ma',
  params: { fast: 5, slow: 20 },
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
  status: 'done',
  progress: 100,
  current_ts: '2026-09-04T02:00:00Z',
  created_at: '2026-09-04T01:00:00Z',
  finished_at: '2026-09-04T02:00:00Z',
  error: null,
  group_id: null,
  net_value: { series: [[0, 100000], [1, 101000]], drawdown: [[0, 0], [1, 0]] },
  trades: [
    {
      open_ts: 1700000000,
      close_ts: 1700086400,
      open_bar: 1,
      close_bar: 2,
      open_price: 10,
      close_price: 11,
      shares: 1000,
      gross_value: 11000,
      commission: 5,
      stamp_duty: 5.5,
      pnl: 1000,
      hold_bars: 1,
    },
  ],
  metrics: { net_profit: 1000, max_drawdown: 0, sharpe: 1.2, win_rate: 1, profit_factor: 2, annualized_return: 0.1, trade_count: 1, avg_hold_bars: 1 },
};
