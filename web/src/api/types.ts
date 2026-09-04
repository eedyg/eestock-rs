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

/** GET /api/alerts?limit= 项（页面②告警预览遗留形状；Wave 2 Phase B 起由 client/mock 适配层从新事件线格式映射） */
export interface AlertItem {
  ts: string;
  level: 'crit' | 'warn' | 'info';
  text: string;
}

// ── 页面⑦ 告警中心（Wave 2 Phase B；07-alerts §6 / 02-alerts §5 后端线格式，snake_case 不驼峰转换）──

export type AlertLevelName = 'info' | 'warning' | 'critical';
export type AlertStatusName = 'triggered' | 'acked' | 'resolved';

/** GET /api/alerts 项 / WS {type:"alert"} 帧载荷（聚合防刷屏：同 rule+source 未恢复一条） */
export interface AlertEventItem {
  id: number;
  rule_id: string;
  level: AlertLevelName;
  source: string; // 源ID / 标的 code / 系统组件
  message: string;
  status: AlertStatusName;
  fire_count: number; // 聚合触发计数
  first_fired_at: string;
  last_fired_at: string;
  acked_at: string | null;
  resolved_at: string | null;
}

/** GET /api/alert-rules 项（内置规则；仅 threshold/enabled/silence_minutes 可调） */
export interface AlertRuleItem {
  id: string;
  name: string;
  level: AlertLevelName;
  threshold: number; // 语义按 id：成功率下限(0-1)/缺口率%/停摆分钟数/未用
  duration_minutes: number;
  silence_minutes: number;
  enabled: boolean;
}

/** GET /api/alerts 查询参数（缺省不过滤；from/to 为 last_fired_at 口径 RFC3339） */
export interface AlertQuery {
  level?: AlertLevelName;
  from?: string;
  to?: string;
  source?: string;
  limit?: number;
}

/** PATCH /api/alert-rules 请求体（缺省字段 = 不改） */
export interface AlertRulePatchBody {
  threshold?: number;
  enabled?: boolean;
  silence_minutes?: number;
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

// ── 页面④ 数据质量（Wave 2 Phase A 后端定稿；04-quality.md §7.1 / 07-app-plane §1.1，snake_case 不驼峰转换）──

/** 分歧汇总（无比对样本 → 比率/极值 null，前端空态「该范围无比对数据」） */
export interface QualityDivergenceSummary {
  compared_bars: number;
  divergent_bars: number;
  divergence_rate: number | null; // 0-1
  consistency_rate: number | null; // 0-1（|偏差|≤threshold 占比）
  max_deviation_pct: number | null; // |偏差| 极值
}

/** 分歧行（|偏差| 降序；只比 close，D4 口径） */
export interface QualityDivergenceRow {
  ts: string; // ISO 8601 UTC，bar 起始时刻
  raw_close: number;
  accurate_close: number;
  deviation_pct: number;
  raw_source: string | null; // SourceId（如 tencent_ifzq）
}

/** GET /api/quality/divergence?code=&from=&to=&threshold_pct= 响应 */
export interface QualityDivergenceResponse {
  code: string;
  from: string;
  to: string;
  threshold_pct: number;
  summary: QualityDivergenceSummary;
  rows: QualityDivergenceRow[];
}

/** 源一致率排行项（一致率降序，平手按 source 名序） */
export interface SourceAccuracyItem {
  source: string;
  samples: number;
  consistency_rate: number | null;
  avg_deviation_pct: number | null;
  max_deviation_pct: number | null;
}

/** GET /api/quality/source-accuracy?from=&to=&threshold_pct= 响应 */
export interface SourceAccuracyResponse {
  from: string;
  to: string;
  threshold_pct: number;
  sources: SourceAccuracyItem[];
}

/** 缺口分类（D5 三级口径） */
export type GapClass = 'source_fault' | 'upstream_no_data' | 'system_gap';

/** 缺口段（start/end 为 CST "HH:MM"，含端点；count=缺 bar 数） */
export interface GapSegmentItem {
  start: string;
  end: string;
  count: number;
  class: GapClass;
}

/** 单日缺口卡（仅当日有缺口时返回；非交易日整日不出卡） */
export interface DayGapItem {
  date: string; // YYYY-MM-DD
  expected_bars: number;
  actual_bars: number;
  missing_bars: number;
  segments: GapSegmentItem[];
}

/** GET /api/quality/gaps?code=&from=&to= 响应 */
export interface QualityGapsResponse {
  code: string;
  from: string;
  to: string;
  days: DayGapItem[];
}

/** tushare 同步 checkpoint 行 */
export interface SyncCheckpoint {
  code: string;
  period: string;
  last_synced_date: string; // YYYY-MM-DD
  updated_at: string; // ISO 8601 UTC
}

/** tushare 最近事件（source_health_events source='tushare'，7 天窗口） */
export interface TushareEvent {
  ts: string;
  ok: boolean;
  err_kind: string | null;
}

/** GET /api/tushare/status 响应（quota_remaining 恒 null：积分余额未入库，前端渲染 —） */
export interface TushareStatusResponse {
  checkpoints: SyncCheckpoint[];
  covered_codes: number;
  last_updated_at: string | null;
  last_event: TushareEvent | null;
  quota_remaining: null;
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
