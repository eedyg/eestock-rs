import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NavBar } from './NavBar';
import { NAV_ITEMS } from './navItems';

describe('NavBar（00-shell：11 项按波次置灰）', () => {
  it('渲染 11 个导航项', () => {
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    expect(screen.getAllByRole('listitem')).toHaveLength(11);
    expect(NAV_ITEMS.map((i) => i.path)).toEqual([
      '/', '/sources', '/symbols', '/quality', '/backtest', '/trading', '/alerts', '/settings', '/sim-live', '/strategies', '/backtest-workbench',
    ]);
  });

  it('Wave 2 Phase C + 设置页 S1 + 回测 W3 + 模拟实盘 L3b 解锁 ①②③④⑤⑦⑧⑨，仅⑥置灰且带波次标签', () => {
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    for (const [label, href] of [
      ['① 行情看板', '/'],
      ['② 数据源诊断', '/sources'],
      ['③ 标的管理', '/symbols'],
      ['④ 数据质量', '/quality'],
      ['⑤ 回测工作台', '/backtest'],
      ['⑦ 告警中心', '/alerts'],
      ['⑧ 系统设置', '/settings'],
      ['⑨ 模拟实盘', '/sim-live'],
      ['⑩ 策略', '/strategies'],
      ['⑪ 回测工作台', '/backtest-workbench'],
    ] as const) {
      expect(screen.getByText(label).closest('a')).toHaveAttribute('href', href);
    }
    // 置灰项不是链接
    for (const label of ['⑥ 交易面板']) {
      expect(screen.getByText(label).closest('a')).toBeNull();
    }
    // 波次标签
    expect(screen.queryAllByText('W1')).toHaveLength(0); // ②③ 已解锁
    expect(screen.queryAllByText('W2')).toHaveLength(0); // ④⑦ 已由 Wave 2 解锁
    expect(screen.queryAllByText('W3')).toHaveLength(0); // ⑤ 已由 Wave 3 解锁
    expect(screen.getByText('W4')).toBeInTheDocument(); // ⑥
  });

  it('当前路由项高亮（aria-current）', () => {
    render(<MemoryRouter initialEntries={['/']}><NavBar /></MemoryRouter>);
    expect(screen.getByText('① 行情看板').closest('a')).toHaveAttribute('aria-current', 'page');
  });
});
