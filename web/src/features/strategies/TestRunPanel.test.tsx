import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiClient } from '@/api/client';
import type { StrategyTestRunResp } from '@/api/types';
import { ApiError } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { TestRunPanel } from './TestRunPanel';

// ADR-024 P0 §5.1 —— 周期下拉的**独立期望**：取自契约向量（**不是**被测常量自身，否则是同义反复）。
// 单一真相：`design/16-backtest-scalability/contract-vectors.json::backtest_periods`。
// 该期望与产出解耦：删掉常量里的 'M30'、或组件改成手写第二份白名单，本用例都必须变红。
// web/src/features/strategies → 仓库根
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_VECTORS = JSON.parse(
  readFileSync(resolve(HERE, '../../../../design/16-backtest-scalability/contract-vectors.json'), 'utf8'),
) as { backtest_periods: string[] };

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

  // ADR-024 P0：周期下拉必须覆盖回测单一事实源全集（含 M30），不得手写第二份。
  // 期望 = 契约向量（独立期望）；对 M30 成员资格**敏感**（删常量里的 M30 即红）。
  it('周期下拉 = contract-vectors.json::backtest_periods（六档含 M30，独立期望）', () => {
    render(<TestRunPanel api={api} code={CODE} schema={SCHEMA} />);
    const sel = screen.getByTestId('tr-period') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(CONTRACT_VECTORS.backtest_periods);
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
