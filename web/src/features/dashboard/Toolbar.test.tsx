import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toolbar } from './Toolbar';

function renderToolbar(props?: Partial<Parameters<typeof Toolbar>[0]>) {
  const defaults = {
    period: '15m' as const,
    onPeriodChange: vi.fn(),
    chartTab: 'kline' as const,
    onChartTabChange: vi.fn(),
    indicators: { ma: true, macd: false, kdj: false, boll: false },
    onToggleIndicator: vi.fn(),
    gridMode: 'single' as const,
    onGridModeChange: vi.fn(),
    followLatest: true,
    onBackToLatest: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<Toolbar {...merged} />), props: merged };
}

describe('Toolbar（toolbar 区域）', () => {
  it('周期按钮组 1m/5m/15m/1h/日，当前周期高亮', () => {
    renderToolbar({ period: '15m' });
    for (const p of ['1m', '5m', '15m', '1h', '日']) {
      expect(screen.getByRole('button', { name: p })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('点击周期触发 onPeriodChange', async () => {
    const { props } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: '5m' }));
    expect(props.onPeriodChange).toHaveBeenCalledWith('5m');
  });

  it('K线/分时 Tab 切换', async () => {
    const { props } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: '分时' }));
    expect(props.onChartTabChange).toHaveBeenCalledWith('timeshare');
  });

  it('指标勾选 MA 默认开，MACD/KDJ/BOLL 默认关；点击切换', async () => {
    const { props } = renderToolbar();
    expect(screen.getByRole('button', { name: 'MA' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'MACD' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'BOLL' }));
    expect(props.onToggleIndicator).toHaveBeenCalledWith('boll');
  });

  it('宫格切换 单图/2×2/2×3', async () => {
    const { props } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: '2×2' }));
    expect(props.onGridModeChange).toHaveBeenCalledWith('grid2x2');
    await userEvent.click(screen.getByRole('button', { name: '2×3' }));
    expect(props.onGridModeChange).toHaveBeenCalledWith('grid2x3');
  });

  it('手动缩放后（followLatest=false）回到最新可点', async () => {
    const { props } = renderToolbar({ followLatest: false });
    const btn = screen.getByRole('button', { name: /回到最新/ });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(props.onBackToLatest).toHaveBeenCalled();
  });

  it('跟随中回到最新按钮禁用', () => {
    renderToolbar({ followLatest: true });
    expect(screen.getByRole('button', { name: /回到最新/ })).toBeDisabled();
  });
});
