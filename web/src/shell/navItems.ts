// 左侧导航 8 项（00-shell §路由索引）；按波次置灰（09-frontend.md §8）
export interface NavItem {
  path: string;
  label: string;
  wave?: string; // 置灰项的波次标签
  enabled: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '① 行情看板', enabled: true },
  // Phase C 解锁②③（09-frontend.md §8 口径更新）
  { path: '/sources', label: '② 数据源诊断', enabled: true },
  { path: '/symbols', label: '③ 标的管理', enabled: true },
  { path: '/quality', label: '④ 数据质量', enabled: true },  // Wave 2 Phase C 解锁
  { path: '/backtest', label: '⑤ 回测工作台', enabled: true },  // Wave 3 Phase 3c 解锁
  { path: '/trading', label: '⑥ 交易面板', wave: 'W4', enabled: false },
  { path: '/alerts', label: '⑦ 告警中心', enabled: true },  // Wave 2 Phase B 解锁
  { path: '/settings', label: '⑧ 系统设置', enabled: true },  // 页面⑧ 设置页 S1 低风险切片解锁
  { path: '/sim-live', label: '⑨ 模拟实盘', enabled: true },  // 11-sim-live / L3b：web 面板（模拟实盘，不触真实券商）
];
