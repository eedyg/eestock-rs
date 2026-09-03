import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SymbolList } from './SymbolList';
import type { SymbolSnapshot } from '@/api/types';

const SYMBOLS: SymbolSnapshot[] = [
  { code: '518880', name: '黄金ETF', last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', last: 1.587, changePct: -0.31 },
];

function renderList(props?: Partial<Parameters<typeof SymbolList>[0]>) {
  const defaults = {
    symbols: SYMBOLS,
    status: 'ready' as const,
    selected: '518880',
    search: '',
    onSearchChange: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<MemoryRouter><SymbolList {...merged} /></MemoryRouter>), props: merged };
}

describe('SymbolList（symbol-list 区域）', () => {
  it('渲染 code/名称/最新价/涨跌幅', () => {
    renderList();
    expect(screen.getByText('518880')).toBeInTheDocument();
    expect(screen.getByText('黄金ETF')).toBeInTheDocument();
    expect(screen.getByText('2.431')).toBeInTheDocument();
    expect(screen.getByText('+0.62%')).toBeInTheDocument();
    expect(screen.getByText('-0.31%')).toBeInTheDocument();
  });

  it('点击标的触发 onSelect', async () => {
    const { props } = renderList();
    await userEvent.click(screen.getByText('纳指ETF'));
    expect(props.onSelect).toHaveBeenCalledWith('513310');
  });

  it('搜索框输入触发 onSearchChange', async () => {
    const { props } = renderList();
    await userEvent.type(screen.getByPlaceholderText(/搜索/), '黄金');
    expect(props.onSearchChange).toHaveBeenCalled();
  });

  it('loading 态渲染骨架行', () => {
    renderList({ status: 'loading', symbols: [] });
    expect(screen.getByTestId('symbol-list-skeleton')).toBeInTheDocument();
  });

  it('空态：未注册标的引导链 → /symbols', () => {
    renderList({ symbols: [] });
    const link = screen.getByText(/去标的管理/).closest('a');
    expect(link).toHaveAttribute('href', '/symbols');
  });

  it('错误态：错误条 + 重试按钮', async () => {
    const { props } = renderList({ status: 'error', symbols: [] });
    expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it('涨跌幅着色：涨 up / 跌 down', () => {
    renderList();
    expect(screen.getByText('+0.62%')).toHaveClass('text-up');
    expect(screen.getByText('-0.31%')).toHaveClass('text-down');
  });
});
