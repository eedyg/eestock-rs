import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@/api/client';
import type { StrategyTestRunResp } from '@/api/types';
import { ApiError } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { TestRunPanel } from './TestRunPanel';

const SCHEMA = [
  { key: 'fast', type: 'int' as const, default: 5, min: 1, max: 250, description: '快线周期' },
  { key: 'slow', type: 'int' as const, default: 20, min: 2, max: 250, description: '慢线周期' },
];

const CODE = 'function on_bar(ctx) { return 50; }';

describe('TestRunPanel（试算面板：双模式表单 → test-run → 结果渲染）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = stubApi();
  });

  it('表单校验：标的为空 → 内联错误，不调 test-run', async () => {
    const user = userEvent.setup();
    render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
    await user.clear(screen.getByTestId('tr-symbol'));
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() => expect(screen.getByTestId('tr-form-error')).toBeInTheDocument());
    expect(api.runStrategyTest).not.toHaveBeenCalled();
  });

  it('参数按 schema 渲染（默认值填充）；参数越界 → 内联校验错误', async () => {
    const user = userEvent.setup();
    render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
    expect((screen.getByTestId('tr-param-fast') as HTMLInputElement).value).toBe('5');
    await user.clear(screen.getByTestId('tr-param-fast'));
    await user.type(screen.getByTestId('tr-param-fast'), '9999');
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() => expect(screen.getByTestId('tr-form-error')).toHaveTextContent('fast'));
    expect(api.runStrategyTest).not.toHaveBeenCalled();
  });

  it('pure_score 运行：POST test-run（内联 code + 参数）→ 评分曲线 + 事件列表', async () => {
    const user = userEvent.setup();
    render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
    await waitFor(() => expect(screen.getByTestId('tr-run')).toBeInTheDocument());
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() => expect(api.runStrategyTest).toHaveBeenCalled());
    const req = (api.runStrategyTest as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(req).toEqual(
      expect.objectContaining({
        code: CODE,
        symbol: '518880',
        mode: 'pure_score',
        params: expect.objectContaining({ fast: 5, slow: 20 }),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('score-chart')).toBeInTheDocument());
    expect(screen.getByTestId('tr-events')).toBeInTheDocument();
    // pure_score 无成交区
    expect(screen.queryByTestId('tr-trades')).toBeNull();
  });

  it('sim_position 运行：渲染成交表 + 信号标记', async () => {
    const user = userEvent.setup();
    render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
    await user.selectOptions(screen.getByTestId('tr-mode'), 'sim_position');
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() => expect(screen.getByTestId('tr-trades')).toBeInTheDocument());
    expect(screen.getByTestId('score-chart')).toBeInTheDocument();
    expect(screen.getByTestId('tr-trades')).toHaveTextContent('113.74'); // mock 种子盈亏
  });

  it('truncated 标记 → 截断提示；400 错误（区间超限等）→ 友好展示', async () => {
    const truncatedResp: StrategyTestRunResp = {
      mode: 'pure_score',
      symbol: '518880',
      period: 'D1',
      bar_count: 3,
      scores: [
        { ts: 1, score: 50 },
        { ts: 2, score: 60 },
      ],
      signals: [],
      trades: [],
      events: [],
      truncated: { scores: true, events: false, trades: false },
    };
    api = stubApi({ runStrategyTest: vi.fn().mockResolvedValue(truncatedResp) });
    const user = userEvent.setup();
    const { unmount } = render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() => expect(screen.getByTestId('tr-truncated')).toHaveTextContent('截断'));
    unmount();
    // 400 错误（后端区间超限/参数越界）→ 友好内联展示
    api = stubApi({
      runStrategyTest: vi.fn().mockRejectedValue(new ApiError(400, 'HTTP 400: 分钟级试算区间不能超过 3 个月')),
    });
    render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() => expect(screen.getByTestId('tr-run-error')).toHaveTextContent(/400|区间/));
  });
});
