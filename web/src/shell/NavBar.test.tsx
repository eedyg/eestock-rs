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

  it('Phase B 仅 ① 行情看板可点击，其余置灰且带波次标签', () => {
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    const dashboard = screen.getByText('① 行情看板').closest('a');
    expect(dashboard).toHaveAttribute('href', '/');

    // 置灰项不是链接
    for (const label of ['② 数据源诊断', '③ 标的管理', '④ 数据质量', '⑤ 回测工作台', '⑥ 交易面板', '⑦ 告警中心', '⑧ 系统设置']) {
      expect(screen.getByText(label).closest('a')).toBeNull();
    }
    // 波次标签
    expect(screen.getAllByText('W1')).toHaveLength(2); // ②③
    expect(screen.getAllByText('W2')).toHaveLength(2); // ④⑦
    expect(screen.getByText('W3')).toBeInTheDocument(); // ⑤
    expect(screen.getByText('W4')).toBeInTheDocument(); // ⑥
  });

  it('当前路由项高亮（aria-current）', () => {
    render(<MemoryRouter initialEntries={['/']}><NavBar /></MemoryRouter>);
    expect(screen.getByText('① 行情看板').closest('a')).toHaveAttribute('aria-current', 'page');
  });
});
