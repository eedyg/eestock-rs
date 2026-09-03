import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TopBar } from './TopBar';

function renderTopBar(props?: Partial<Parameters<typeof TopBar>[0]>) {
  const defaults = {
    sessionLabel: '交易中',
    sessionTime: '10:23',
    collectorRunning: true,
    healthy1m: 2,
    total1m: 2,
    wsStatus: 'open' as const,
  };
  return render(
    <MemoryRouter>
      <TopBar {...defaults} {...props} />
    </MemoryRouter>,
  );
}

describe('TopBar（顶部状态条 H=40）', () => {
  it('交易时段 pill：标签 + 时间', () => {
    renderTopBar();
    expect(screen.getByText(/交易中/)).toBeInTheDocument();
    expect(screen.getByText(/10:23/)).toBeInTheDocument();
  });

  it('采集状态灯：正常/停止', () => {
    renderTopBar();
    expect(screen.getByText('采集正常')).toBeInTheDocument();
    renderTopBar({ collectorRunning: false });
    expect(screen.getByText('采集停止')).toBeInTheDocument();
  });

  it('1m 源健康数 pill，点击跳 /sources', () => {
    renderTopBar({ healthy1m: 2, total1m: 2 });
    const pill = screen.getByText(/1m 源健康/).closest('a');
    expect(pill).toHaveAttribute('href', '/sources');
    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('健康数据未加载时显示占位', () => {
    renderTopBar({ healthy1m: null, total1m: null });
    expect(screen.getByText('--/--')).toBeInTheDocument();
  });

  it('WS 断线提示重连中', () => {
    renderTopBar({ wsStatus: 'closed' });
    expect(screen.getByText(/重连中/)).toBeInTheDocument();
  });
});
