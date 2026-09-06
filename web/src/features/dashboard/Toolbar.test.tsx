import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    maWindows: [5, 10, 20],
    onSaveMaWindows: vi.fn(async () => {}),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<Toolbar {...merged} />), props: merged };
}

/** 模拟父级（DashboardPage）持有 maWindows 的乐观更新处理器：编辑→保存→乐观 set + await 接口，失败回滚。 */
function MaConfigHarness({ saveMaConfig }: { saveMaConfig: (w: number[]) => Promise<number[]> }) {
  const [maWindows, setMaWindows] = useState<number[]>([5, 10, 20]);
  const onSaveMaWindows = async (windows: number[]) => {
    const prev = maWindows;
    setMaWindows([...windows]);
    try {
      const normalized = await saveMaConfig(windows);
      setMaWindows(normalized);
    } catch {
      setMaWindows(prev);
    }
  };
  return (
    <Toolbar
      period="15m"
      onPeriodChange={() => {}}
      chartTab="kline"
      onChartTabChange={() => {}}
      indicators={{ ma: true, macd: false, kdj: false, boll: false }}
      onToggleIndicator={() => {}}
      gridMode="single"
      onGridModeChange={() => {}}
      followLatest={true}
      onBackToLatest={() => {}}
      maWindows={maWindows}
      onSaveMaWindows={onSaveMaWindows}
    />
  );
}

describe('Toolbar（toolbar 区域）', () => {
  it('周期按钮组 1m/5m/15m/1h/日/周/月，当前周期高亮', () => {
    renderToolbar({ period: '15m' });
    for (const p of ['1m', '5m', '15m', '1h', '日', '周', '月']) {
      expect(screen.getByRole('button', { name: p })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '周' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('点击周期触发 onPeriodChange', async () => {
    const { props } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: '5m' }));
    expect(props.onPeriodChange).toHaveBeenCalledWith('5m');
  });

  it('周线/月线按钮：点击触发 onPeriodChange(1w/1mo)', async () => {
    const { props } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: '周' }));
    expect(props.onPeriodChange).toHaveBeenCalledWith('1w');
    await userEvent.click(screen.getByRole('button', { name: '月' }));
    expect(props.onPeriodChange).toHaveBeenCalledWith('1mo');
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

  // ── MA 可配置（W2）：控件调 onSaveMaWindows + 乐观更新 ──
  it('MA 配置控件：改窗口 → 保存调用 onSaveMaWindows(解析后窗口)', async () => {
    const onSaveMaWindows = vi.fn(async () => {});
    renderToolbar({ onSaveMaWindows });
    expect(screen.queryByRole('button', { name: 'MA 配置' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'MA 配置' }));
    const input0 = screen.getByLabelText('MA 窗口 1');
    await userEvent.clear(input0);
    await userEvent.type(input0, '7');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSaveMaWindows).toHaveBeenCalledWith([7, 10, 20]);
  });

  it('MA 配置控件：保存后标签乐观更新为新窗口（父级同步 maWindows）', async () => {
    let resolve!: (w: number[]) => void;
    const saveMaConfig = vi.fn(() => new Promise<number[]>((res) => { resolve = res; }));
    render(<MaConfigHarness saveMaConfig={saveMaConfig} />);
    const trigger = screen.getByRole('button', { name: 'MA 配置' });
    expect(trigger.textContent).toContain('MA(5,10,20)');
    await userEvent.click(trigger);
    await userEvent.clear(screen.getByLabelText('MA 窗口 1'));
    await userEvent.type(screen.getByLabelText('MA 窗口 1'), '7');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 乐观：父级先同步 setMaWindows，标签立即显示新窗口
    expect(screen.getByRole('button', { name: 'MA 配置' }).textContent).toContain('MA(7,10,20)');
    expect(saveMaConfig).toHaveBeenCalledWith([7, 10, 20]);
    resolve([7, 10, 20]);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'MA 配置' }).textContent).toContain('MA(7,10,20)'),
    );
  });

  it('MA 配置控件：保存失败 → 回滚到原窗口', async () => {
    const saveMaConfig = vi.fn(async () => { throw new Error('net'); });
    render(<MaConfigHarness saveMaConfig={saveMaConfig} />);
    await userEvent.click(screen.getByRole('button', { name: 'MA 配置' }));
    await userEvent.clear(screen.getByLabelText('MA 窗口 1'));
    await userEvent.type(screen.getByLabelText('MA 窗口 1'), '7');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(saveMaConfig).toHaveBeenCalledWith([7, 10, 20]);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'MA 配置' }).textContent).toContain('MA(5,10,20)'),
    );
  });
});
