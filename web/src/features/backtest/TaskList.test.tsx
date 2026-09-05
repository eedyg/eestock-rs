import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { BacktestRunDto, BacktestStrategyDto, BacktestStatus } from '@/api/types';
import { TaskList } from './TaskList';

const strategy: BacktestStrategyDto = {
  id: 'dual_ma',
  name: '双均线',
  description: 'd',
  params_schema: [],
};

function makeRun(id: number, status: BacktestStatus): BacktestRunDto {
  return {
    id,
    code: '518880',
    period: 'D1',
    strategy_id: 'dual_ma',
    params: {},
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    status,
    progress: status === 'done' ? 100 : 0,
    current_ts: null,
    created_at: '2026-09-04T01:00:00Z',
    finished_at: status === 'done' ? '2026-09-04T02:00:00Z' : null,
    error: status === 'failed' ? '回测区间无 K 线 bar' : null,
    group_id: null,
  };
}

/** 受控 Harness：onDeleteRun 成功后从本地 runs 移除该行（驱动「行消失」）。 */
function Harness({ onDeleteRun }: { onDeleteRun: (id: number) => Promise<void> }) {
  const [runs, setRuns] = useState<BacktestRunDto[]>([makeRun(1, 'done'), makeRun(2, 'failed')]);
  const del = async (id: number) => {
    await onDeleteRun(id);
    setRuns((r) => r.filter((x) => x.id !== id));
  };
  return (
    <TaskList
      runs={runs}
      strategies={[strategy]}
      loading={false}
      error={null}
      onRetry={() => {}}
      selectedRunId={null}
      compareIds={[]}
      progressMap={{}}
      onSelectRun={() => {}}
      onToggleCompare={() => {}}
      onDeleteRun={del}
    />
  );
}

describe('TaskList（每行删除按钮：二次确认 → 删除 → 行消失；404 → 错误提示）', () => {
  it('删除按钮 → 确认 → 调 onDeleteRun → 行消失', async () => {
    const user = userEvent.setup();
    const onDeleteRun = vi.fn(async () => {});
    render(<Harness onDeleteRun={onDeleteRun} />);
    await waitFor(() => expect(screen.getByTestId('task-row-1')).toBeInTheDocument());
    await user.click(screen.getByTestId('task-delete-1'));
    expect(await screen.findByTestId('task-delete-confirm-1')).toBeInTheDocument();
    await user.click(screen.getByTestId('task-delete-confirm-1'));
    await waitFor(() => expect(onDeleteRun).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.queryByTestId('task-row-1')).not.toBeInTheDocument());
  });

  it('取消确认 → 不调 onDeleteRun，行保留', async () => {
    const user = userEvent.setup();
    const onDeleteRun = vi.fn(async () => {});
    render(<Harness onDeleteRun={onDeleteRun} />);
    await waitFor(() => expect(screen.getByTestId('task-row-1')).toBeInTheDocument());
    await user.click(screen.getByTestId('task-delete-1'));
    await user.click(await screen.findByTestId('task-delete-cancel-1'));
    expect(onDeleteRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('task-row-1')).toBeInTheDocument();
  });

  it('404 → onDeleteRun 失败 → 错误提示', async () => {
    const user = userEvent.setup();
    const onDeleteRun = vi.fn(async () => {
      throw new Error('HTTP 404: run 不存在');
    });
    render(<Harness onDeleteRun={onDeleteRun} />);
    await waitFor(() => expect(screen.getByTestId('task-row-1')).toBeInTheDocument());
    await user.click(screen.getByTestId('task-delete-1'));
    await user.click(await screen.findByTestId('task-delete-confirm-1'));
    expect(await screen.findByTestId('task-delete-error')).toBeInTheDocument();
    expect(onDeleteRun).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('task-row-1')).toBeInTheDocument(); // 失败不删行
  });
});
