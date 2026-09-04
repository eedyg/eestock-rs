// API 契约类型（09-frontend.md §5；Phase C 起以 07-app-plane §1.1 真实后端契约为事实源）
// Period / GridMode / SymbolSnapshot 由 tangle 骨架（DashboardGrid）持有，此处再导出避免双事实源
export type { Period, GridMode, SymbolSnapshot } from '@/layouts/DashboardGrid';
export type { DetailRange } from '@/layouts/SourcesGrid';
export type { Settlement, FormMode, SymbolFormValues } from '@/layouts/SymbolsGrid';

/** 历史 bar（GET /api/kline 响应 bars 项，merge 视图，升序） */
export interface Bar {
  ts: string; // ISO 8601 UTC，bar 起始时刻
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 股
  amount: number; // 元
}

/** GET /api/kline 响应包络（07-app-plane §1.1） */
export interface KlineResponse {
  code: string;
  period: string;
  bars: Bar[];
  next_before: string | null;
}

// ── 数据源健康（GET /api/sources/health / WS health 推送；07-app-plane §1.1 后端线格式）──

export type CircuitState = 'closed' | 'half_open' | 'open';
export type SourceStatus = 'healthy' | 'degraded' | 'circuit_open';

export interface SourceLastError {
  err_kind: string | null;
  ts: string;
  code: string | null;
}

/** 后端 SourceHealth 行（字段名与后端 serde 一致，不做驼峰转换） */
export interface SourceHealthItem {
  source: string; // 源 id（SourceId::as_str 口径，如 tencent_ifzq）
  window_secs: number;
  attempts: number;
  successes: number;
  success_rate: number | null; // attempts=0 → null（显示 —）
  p50_ms: number | null;
  p95_ms: number | null;
  circuit_state: CircuitState;
  status: SourceStatus;
  last_error: SourceLastError | null;
  last_event_ts: string | null;
}

/** GET /api/sources/health 响应 / WS {type:"health"} 帧载荷 */
export interface SourcesHealth {
  window_secs: number;
  sources: SourceHealthItem[];
}

// ── 标的管理（页面③；03-symbols §6 / 07-app-plane §8）──

export interface SymbolLatest {
  ts: string;
  last: number;
  change_pct: number | null;
}

/** GET /api/symbols（with_stats=1 时带 today_bars） */
export interface SymbolRow {
  code: string;
  name: string | null;
  interval_secs: number;
  settlement: string; // 'T0' | 'T1'
  enabled: boolean;
  latest: SymbolLatest | null;
  today_bars?: number; // 仅 with_stats=1 响应携带
}

/** POST /api/symbols 请求体（缺省 60s/T1/启用 由后端兜底） */
export interface RegisterSymbolInput {
  code: string;
  name?: string;
  interval_secs?: number;
  settlement?: string;
  enabled?: boolean;
}

/** PATCH /api/symbols/{code} 请求体（缺省字段 = 不改） */
export interface SymbolPatchBody {
  name?: string;
  interval_secs?: number;
  settlement?: string;
  enabled?: boolean;
}

// ── 页面②补充数据源（Phase C 前端契约假设；后端端点为 Phase C 后续/Wave 2，
//    真实模式下缺失端点走错误三态，mock 模式完整可览）──

/** GET /api/collection/gaps?date=today 项（缺口率口径：02-sources §6） */
export interface GapStat {
  code: string;
  name: string | null;
  expected: number; // 当日应有 bar
  actual: number; // 实有 bar
  gapPct: number; // 缺口率 %
}

/** GET /api/alerts?limit= 项（页面⑦接口复用，只读预览） */
export interface AlertItem {
  ts: string;
  level: 'crit' | 'warn' | 'info';
  text: string;
}

/** GET /api/sources/{id}/events 项（事件流水） */
export interface SourceEventItem {
  ts: string;
  kind: 'success' | 'failure' | 'rate_limited' | 'circuit';
  detail: string;
  traceId: string | null;
}

/** GET /api/sources/{id}/metrics 时序点 */
export interface MetricPoint {
  ts: string;
  successRate: number | null; // %
  p50Ms: number | null;
}

/** GET /api/sources/{id}/divergence 响应 */
export interface DivergenceStat {
  divergeBars: number;
  thresholdPct: number;
}

/** 限流计数器组（随 metrics 响应或独立字段；封禁观测点 02-sources §4） */
export interface RateLimitCounters {
  http403: number;
  http429: number;
  connReset: number;
}

/** 后端错误线格式 {error: string} → 前端 ApiError */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
