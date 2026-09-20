import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { Toolbar, type ToolbarProps } from './Toolbar';
import { INDICATOR_DEFS, IndicatorToggles } from './IndicatorToggles';

/**
 * ADR-028 §2.4c 第 1 项「复用看板」的**共享小组件**守卫：
 *  - 指标名单与勾选逻辑**只有一处**（`IndicatorToggles` + `INDICATOR_DEFS`），看板 Toolbar 与结果页都消费它；
 *  - 看板侧行为零回归：六枚开关、`aria-pressed` 语义、MA 配置控件 / DCAP 参数面板仍内联在其按钮之后；
 *  - 结果页通过 `testIdPrefix` 拿到稳定 testid（看板不传 ⇒ 不产生额外 testid，dashboard 用例零影响）。
 */
describe('S0 共享名单：INDICATOR_DEFS = ma/vol/macd/kdj/boll/dcap（与 DASHBOARD_DEFAULTS 键集同构）', () => {
  it('名单键集与看板默认值键集逐一对应', () => {
    expect(INDICATOR_DEFS.map((d) => d.key)).toEqual(['ma', 'vol', 'macd', 'kdj', 'boll', 'dcap']);
    expect(INDICATOR_DEFS.map((d) => d.key).sort()).toEqual(Object.keys(DASHBOARD_DEFAULTS.indicators).sort());
  });
});

describe('S1 共享组件行为', () => {
  it('按名单渲染 6 枚按钮，aria-pressed 跟随入参，点击回调带 key', () => {
    const onToggle = vi.fn();
    render(
      <IndicatorToggles
        indicators={{ ...DASHBOARD_DEFAULTS.indicators, macd: true } as never}
        onToggle={onToggle}
        testIdPrefix="wb-indicator-toggle"
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(6);
    expect(screen.getByTestId('wb-indicator-toggle-macd').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('wb-indicator-toggle-vol').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('wb-indicator-toggle-dcap').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('wb-indicator-toggle-kdj'));
    expect(onToggle).toHaveBeenCalledWith('kdj');
  });

  it('不传 testIdPrefix ⇒ 不产生 testid（看板 DOM 零变化）', () => {
    render(<IndicatorToggles indicators={{ ...DASHBOARD_DEFAULTS.indicators } as never} onToggle={() => {}} />);
    expect(screen.queryByTestId('wb-indicator-toggle-vol')).toBeNull();
  });
});

describe('S2 看板 Toolbar 零回归（同一实现）', () => {
  function mkProps(): ToolbarProps {
    return {
      period: '15m' as const,
      onPeriodChange: vi.fn(),
      chartTab: 'kline' as const,
      onChartTabChange: vi.fn(),
      indicators: { ...DASHBOARD_DEFAULTS.indicators },
      onToggleIndicator: vi.fn(),
      gridMode: 'single' as const,
      onGridModeChange: vi.fn(),
      followLatest: true,
      onBackToLatest: vi.fn(),
      maWindows: [5, 10, 20],
      onSaveMaWindows: vi.fn(async () => {}),
    };
  }

  it('六枚指标按钮仍在（文本/按下态/位置语义不变），MA 与 DCAP 的配置入口仍内联跟随', () => {
    render(<Toolbar {...mkProps()} />);
    for (const d of INDICATOR_DEFS) {
      const btn = screen.getByRole('button', { name: new RegExp(`^${d.name}$`) });
      expect(btn.getAttribute('aria-pressed')).toBe(String(DASHBOARD_DEFAULTS.indicators[d.key]));
      fireEvent.click(btn);
    }
    // MA 窗口配置控件（aria-label = 'MA 配置'；文本为 MA(5,10,20) ▾）
    expect(screen.getByRole('button', { name: 'MA 配置' })).toBeTruthy();
    // DCAP 参数面板入口（与 DCAP 开关并列；两者都可访问名含 DCAP ⇒ 用精确名区分）
    // 字符串 name 默认「全字符等值」匹配 ⇒ 'DCAP' 只命中开关本体（参数面板入口名不同）
    expect(screen.getByRole('button', { name: 'DCAP' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /DCAP/ }).length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: '单图' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('点击看板指标按钮 ⇒ onToggleIndicator 收到对应 key（复用同一逻辑）', () => {
    const props = mkProps();
    render(<Toolbar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^VOL$/ }));
    expect(props.onToggleIndicator).toHaveBeenCalledWith('vol');
    fireEvent.click(screen.getByRole('button', { name: /^MACD$/ }));
    expect(props.onToggleIndicator).toHaveBeenCalledWith('macd');
  });
});
