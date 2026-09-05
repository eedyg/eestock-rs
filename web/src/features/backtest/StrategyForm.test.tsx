import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BacktestStrategyDto, BacktestSubmitReq } from '@/api/types';
import { StrategyForm } from './StrategyForm';

const strategy: BacktestStrategyDto = {
  id: 'dual_ma',
  name: '双均线交叉',
  description: 'd',
  params_schema: [
    { key: 'fast', label: '快线', kind: { Num: { min: 2, max: 200, step: 1, def: 5 } } },
    { key: 'slow', label: '慢线', kind: { Num: { min: 2, max: 250, step: 1, def: 20 } } },
  ],
};

function renderForm(onSubmit = vi.fn()) {
  render(
    <StrategyForm
      strategies={[strategy]}
      loading={false}
      error={null}
      onRetry={() => {}}
      submitting={false}
      submitError={null}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit };
}

function getLastReq(onSubmit: ReturnType<typeof vi.fn>): BacktestSubmitReq {
  return onSubmit.mock.calls.at(-1)![0] as BacktestSubmitReq;
}

describe('StrategyForm（初始金额 + 回测区间 from/to 输入）', () => {
  it('初始金额输入 → 提交 body 含 initialCapital', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await waitFor(() => expect(screen.getByTestId('strategy-select')).toBeInTheDocument());
    const cap = screen.getByTestId('initial-capital');
    await user.clear(cap);
    await user.type(cap, '250000');
    await user.click(screen.getByTestId('submit-btn'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(getLastReq(onSubmit).initialCapital).toBe(250000);
  });

  it('from/to 日期输入 → 提交 body 含 from/to（RFC3339 起点值）', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await waitFor(() => expect(screen.getByTestId('strategy-select')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('date-from'), { target: { value: '2024-01-01' } });
    fireEvent.change(screen.getByTestId('date-to'), { target: { value: '2024-06-30' } });
    await user.click(screen.getByTestId('submit-btn'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const req = getLastReq(onSubmit);
    expect(req.from).toBe('2024-01-01T00:00:00.000Z');
    expect(req.to).toBe('2024-06-30T00:00:00.000Z');
  });

  it('非法：初始金额 ≤ 0 → 内联错误，不提交', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await waitFor(() => expect(screen.getByTestId('strategy-select')).toBeInTheDocument());
    const cap = screen.getByTestId('initial-capital');
    await user.clear(cap);
    await user.type(cap, '0');
    await user.click(screen.getByTestId('submit-btn'));
    expect(await screen.findByTestId('form-error')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('非法：from ≥ to → 内联错误，不提交', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await waitFor(() => expect(screen.getByTestId('strategy-select')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('date-from'), { target: { value: '2024-06-30' } });
    fireEvent.change(screen.getByTestId('date-to'), { target: { value: '2024-01-01' } });
    await user.click(screen.getByTestId('submit-btn'));
    expect(await screen.findByTestId('form-error')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
