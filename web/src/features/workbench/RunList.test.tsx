import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WorkbenchRunView } from '@/api/types';
import { RunList } from './RunList';

/** 批量历史行（布局压测用：200 条模拟真实用户累积的无界列表）。 */
function mkRuns(n: number): WorkbenchRunView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `sr_h_${i}`,
    name: `历史运行 ${i}`,
    symbol: '518880',
    period: 'D1',
    from_ts: '2026-01-01T00:00:00Z',
    to_ts: '2026-04-01T00:00:00Z',
    config: {
      slots: [],
      buy_threshold: 60,
      sell_threshold: 40,
      policy: { LumpSum: { position_pct: 1 } },
      stop: null,
      initial_capital: 100_000,
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    },
    status: 'succeeded',
    progress: 1,
    error: null,
    created_at: new Date(Date.UTC(2026, 8, 9, 6, 0, 0) - i * 60_000).toISOString(),
    started_at: null,
    finished_at: null,
  }));
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    runs: null,
    loading: false,
    error: null,
    onRetry: vi.fn(),
    selectedRunId: null,
    compareIds: [],
    progressMap: {},
    onSelectRun: vi.fn(),
    onToggleCompare: vi.fn(),
    onCancelRun: vi.fn().mockResolvedValue(undefined),
    hasMore: false,
    loadingMore: false,
    onLoadMore: vi.fn(),
    ...over,
  };
}

describe('RunList 布局（页面⑪ 运行历史有界化：内部滚动，不挤压配置区）', () => {
  it('200 条历史：行渲染在有界内部滚动容器（min-h-0 flex-1 overflow-y-auto），而非撑开整列', () => {
    render(<RunList {...baseProps({ runs: mkRuns(200) })} />);
    const scroll = screen.getByTestId('wb-run-list-scroll');
    expect(scroll.className).toContain('overflow-y-auto');
    expect(scroll.className).toContain('min-h-0');
    expect(scroll.className).toContain('flex-1');
    // 行在滚动容器内
    expect(scroll.contains(screen.getByTestId('wb-run-row-sr_h_0'))).toBe(true);
    expect(scroll.contains(screen.getByTestId('wb-run-row-sr_h_199'))).toBe(true);
    // 根容器为有界 flex 列（配合父级 max-h 生效，自身不无限增长）
    const root = screen.getByTestId('wb-run-list');
    expect(root.className).toContain('min-h-0');
    expect(root.className).toContain('flex-col');
  });

  it('标题栏与「加载更多」分页控件在滚动容器外（滚动历史时保持可见）', () => {
    render(<RunList {...baseProps({ runs: mkRuns(200), hasMore: true })} />);
    const scroll = screen.getByTestId('wb-run-list-scroll');
    expect(scroll.contains(screen.getByText(/运行历史/))).toBe(false);
    expect(scroll.contains(screen.getByTestId('wb-runs-refresh'))).toBe(false);
    const more = screen.getByTestId('wb-runs-more');
    expect(more).toBeInTheDocument();
    expect(scroll.contains(more)).toBe(false);
  });

  it('空列表 / 加载骨架也在滚动容器内（布局一致）', () => {
    const { unmount } = render(<RunList {...baseProps({ runs: [] })} />);
    const scroll = screen.getByTestId('wb-run-list-scroll');
    expect(scroll).toHaveTextContent('暂无运行记录');
    unmount();
    render(<RunList {...baseProps({ runs: null, loading: true })} />);
    expect(screen.getByTestId('wb-run-list-scroll').contains(screen.getByTestId('wb-runs-skeleton'))).toBe(true);
  });
});
