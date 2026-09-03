// API 契约类型（09-frontend.md §5；以 01-dashboard §5 / 02-sources §8 为事实源）
// Period / GridMode / SymbolSnapshot 由 tangle 骨架（DashboardGrid）持有，此处再导出避免双事实源
export type { Period, GridMode, SymbolSnapshot } from '@/layouts/DashboardGrid';

/** 历史 bar（GET /api/kline，merge 视图，升序） */
export interface Bar {
  ts: string; // ISO 8601 UTC，bar 起始时刻
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 股
  amount: number; // 元
}

export type SourceRole = '1m' | 'snapshot';
export type SourceStatus = 'healthy' | 'degraded' | 'circuit';

export interface SourceHealthItem {
  id: string;
  name: string;
  role: SourceRole;
  status: SourceStatus;
}

/** GET /api/sources/health（顶部状态条 / 页面②共用） */
export interface SourcesHealth {
  collectorRunning: boolean;
  sources: SourceHealthItem[];
}
