// 左侧导航 8 项（00-shell §路由索引）；按波次置灰（09-frontend.md §8）
export interface NavItem {
  path: string;
  label: string;
  wave?: string; // 置灰项的波次标签
  enabled: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '① 行情看板', enabled: true },
  { path: '/sources', label: '② 数据源诊断', wave: 'W1', enabled: false },
  { path: '/symbols', label: '③ 标的管理', wave: 'W1', enabled: false },
  { path: '/quality', label: '④ 数据质量', wave: 'W2', enabled: false },
  { path: '/backtest', label: '⑤ 回测工作台', wave: 'W3', enabled: false },
  { path: '/trading', label: '⑥ 交易面板', wave: 'W4', enabled: false },
  { path: '/alerts', label: '⑦ 告警中心', wave: 'W2', enabled: false },
  { path: '/settings', label: '⑧ 系统设置', enabled: false },
];
