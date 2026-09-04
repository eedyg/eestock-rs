import type {
  AlertEventItem,
  AlertItem,
  AlertQuery,
  AlertRuleItem,
  AlertRulePatchBody,
  Bar,
  DetailRange,
  DivergenceStat,
  GapStat,
  KlineResponse,
  MetricPoint,
  Period,
  RateLimitCounters,
  RegisterSymbolInput,
  SourceEventItem,
  SourcesHealth,
  SymbolPatchBody,
  SymbolRow,
  SymbolSnapshot,
} from './types';
import { ApiError } from './types';

export interface KlineQuery {
  code: string;
  period: Period;
  before?: string; // 游标：排他上界 ts（向前翻页）
  limit?: number;
}

export interface ApiClient {
  /** 页面①：注册集合 + 最新价快照（GET /api/symbols，latest 内联展开为 SymbolSnapshot） */
  getSymbols(): Promise<SymbolSnapshot[]>;
  /** 页面①：K线游标分页（解 {bars} 包络，升序） */
  getKline(q: KlineQuery): Promise<Bar[]>;
  /** 状态条 + 页面②：源健康窗口聚合 */
  getSourcesHealth(): Promise<SourcesHealth>;
  // ── Phase C：页面③ 标的管理 ──
  /** GET /api/symbols?with_stats=1（含当日 bar 数列） */
  getSymbolsAdmin(): Promise<SymbolRow[]>;
  /** 注册（201）；409=已注册、422=北交所、400=校验失败（ApiError 透传供表单内联提示） */
  registerSymbol(input: RegisterSymbolInput): Promise<SymbolRow>;
  /** 编辑/停用（200）；404=未注册 */
  updateSymbol(code: string, patch: SymbolPatchBody): Promise<SymbolRow>;
  // ── Phase C：页面② 数据源诊断 ──
  /** 熔断手动复位（202 异步：DB 控制通道，数据面消费后生效） */
  resetSource(id: string): Promise<void>;
  /** 当日缺口率（后端端点 Phase C 后续；真实模式缺失走错误三态） */
  getGaps(): Promise<GapStat[]>;
  /** 告警预览（页面②遗留形状；Wave 2 Phase B 起适配自 /api/alerts 新事件线格式） */
  getAlerts(limit?: number): Promise<AlertItem[]>;
  // ── Wave 2 Phase B：页面⑦ 告警中心（07-alerts §6）──
  /** 告警列表（过滤 level/from/to/source/limit；last_fired_at 降序） */
  getAlertEvents(q: AlertQuery): Promise<AlertEventItem[]>;
  /** 确认（记录确认时刻，持久化）；404=不存在或非未确认态 */
  ackAlert(id: number): Promise<AlertEventItem>;
  /** 内置规则列表 */
  getAlertRules(): Promise<AlertRuleItem[]>;
  /** 规则调整（仅阈值/开关/静默时长，热生效）；404=未知 id */
  patchAlertRule(id: string, patch: AlertRulePatchBody): Promise<AlertRuleItem>;
  /** 源事件流水（detail-panel） */
  getSourceEvents(id: string, limit?: number): Promise<SourceEventItem[]>;
  /** 成功率/延迟时序（detail-panel） */
  getSourceMetrics(id: string, range: DetailRange): Promise<MetricPoint[]>;
  /** 分歧率统计（detail-panel） */
  getSourceDivergence(id: string, range: DetailRange): Promise<DivergenceStat>;
  /** 限流计数器组（detail-panel；403/429/连接重置，封禁观测点 02-sources §4） */
  getSourceRateLimits(id: string, range: DetailRange): Promise<RateLimitCounters>;
}

/** 后端 SymbolDto → 骨架 SymbolSnapshot（latest 展开；无 bar/无名兜底） */
function dtoToSnapshot(d: SymbolRow): SymbolSnapshot {
  return {
    code: d.code,
    name: d.name ?? d.code,
    last: d.latest?.last ?? 0,
    changePct: d.latest?.change_pct ?? 0,
  };
}

/** 页面⑦新事件线格式 → 页面②遗留预览形状（level 映射 + 最近触发时刻/内容） */
export function toLegacyAlert(e: AlertEventItem): AlertItem {
  return {
    ts: e.last_fired_at,
    level: e.level === 'critical' ? 'crit' : e.level === 'warning' ? 'warn' : 'info',
    text: e.message,
  };
}

export function createHttpClient(baseUrl = '', fetcher: typeof fetch = fetch): ApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetcher(`${baseUrl}${path}`, {
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      ...init,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status} ${path}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = `${msg}: ${body.error}`;
      } catch {
        // 非 JSON 错误体忽略
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as T;
  }
  const get = <T>(path: string) => request<T>(path);
  return {
    getSymbols: async () => (await get<SymbolRow[]>('/api/symbols')).map(dtoToSnapshot),
    getKline: async (q) => {
      const params = new URLSearchParams({ code: q.code, period: q.period });
      if (q.before) params.set('before', q.before);
      if (q.limit != null) params.set('limit', String(q.limit));
      const resp = await get<KlineResponse>(`/api/kline?${params.toString()}`);
      return resp.bars;
    },
    getSourcesHealth: () => get('/api/sources/health'),
    getSymbolsAdmin: () => get('/api/symbols?with_stats=1'),
    registerSymbol: (input) =>
      request('/api/symbols', { method: 'POST', body: JSON.stringify(input) }),
    updateSymbol: (code, patch) =>
      request(`/api/symbols/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    resetSource: async (id) => {
      await request(`/api/sources/${encodeURIComponent(id)}/reset`, { method: 'POST' });
    },
    getGaps: () => get('/api/collection/gaps?date=today'),
    getAlerts: async (limit = 10) =>
      (await get<AlertEventItem[]>(`/api/alerts?limit=${limit}`)).map(toLegacyAlert),
    // ── Wave 2 Phase B：页面⑦ ──
    getAlertEvents: (q) => {
      const params = new URLSearchParams();
      if (q.level) params.set('level', q.level);
      if (q.from) params.set('from', new Date(q.from).toISOString());
      if (q.to) params.set('to', new Date(q.to).toISOString());
      if (q.source) params.set('source', q.source);
      if (q.limit != null) params.set('limit', String(q.limit));
      const qs = params.toString();
      return get(`/api/alerts${qs ? `?${qs}` : ''}`);
    },
    ackAlert: (id) => request(`/api/alerts/${id}/ack`, { method: 'POST' }),
    getAlertRules: () => get('/api/alert-rules'),
    patchAlertRule: (id, patch) =>
      request('/api/alert-rules', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) }),
    getSourceEvents: (id, limit = 50) =>
      get(`/api/sources/${encodeURIComponent(id)}/events?limit=${limit}`),
    getSourceMetrics: (id, range) =>
      get(`/api/sources/${encodeURIComponent(id)}/metrics?range=${range}`),
    getSourceDivergence: (id, range) =>
      get(`/api/sources/${encodeURIComponent(id)}/divergence?range=${range}`),
    getSourceRateLimits: (id, range) =>
      get(`/api/sources/${encodeURIComponent(id)}/rate-limits?range=${range}`),
  };
}
