import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NavBar } from './NavBar';
import { NAV_ITEMS } from './navItems';

describe('NavBar（00-shell：8 项按波次置灰）', () => {
  it('渲染 8 个导航项', () => {
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    expect(NAV_ITEMS.map((i) => i.path)).toEqual([
      '/', '/sources', '/symbols', '/quality', '/backtest', '/trading', '/alerts', '/settings',
    ]);
  });

  it('Phase C 解锁 ①②③，其余置灰且带波次标签', () => {
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    for (const [label, href] of [
      ['① 行情看板', '/'],
      ['② 数据源诊断', '/sources'],
      ['③ 标的管理', '/symbols'],
    ] as const) {
      expect(screen.getByText(label).closest('a')).toHaveAttribute('href', href);
    }
    // 置灰项不是链接
    for (const label of ['④ 数据质量', '⑤ 回测工作台', '⑥ 交易面板', '⑦ 告警中心', '⑧ 系统设置']) {
      expect(screen.getByText(label).closest('a')).toBeNull();
    }
    // 波次标签
    expect(screen.queryAllByText('W1')).toHaveLength(0); // ②③ 已解锁
    expect(screen.getAllByText('W2')).toHaveLength(2); // ④⑦
    expect(screen.getByText('W3')).toBeInTheDocument(); // ⑤
    expect(screen.getByText('W4')).toBeInTheDocument(); // ⑥
  });

  it('当前路由项高亮（aria-current）', () => {
    render(<MemoryRouter initialEntries={['/']}><NavBar /></MemoryRouter>);
    expect(screen.getByText('① 行情看板').closest('a')).toHaveAttribute('aria-current', 'page');
  });
});
