import type {
  AlertEventItem,
  AlertItem,
  AlertQuery,
  AlertRuleItem,
  AlertRulePatchBody,
  BacktestPeriod,
  BacktestRunDto,
  BacktestStrategyDto,
  BacktestStatus,
  BacktestSubmitReq,
  BacktestSubmitResp,
  Bar,
  CollectorConfigPatchBody,
  CollectorConfigSnapshot,
  DetailRange,
  DivergenceStat,
  KlineResponse,
  KlineConfigDto,
  MaConfigDto,
  McpConfigPatchBody,
  McpConfigSnapshot,
  MetricPoint,
  Period,
  PurgeRawResult,
  QualityDivergenceResponse,
  QualityGapsResponse,
  RateLimitCounters,
  RegisterSymbolInput,
  ResetCircuitsResult,
  SourceAccuracyResponse,
  SourceConfigItem,
  SourceConfigSnapshot,
  SourceEventItem,
  SourcesHealth,
  SymbolPatchBody,
  SymbolRow,
  SymbolSnapshot,
  SystemInfo,
  TushareStatusResponse,
  SimBacktestCompare,
  SimCancelOrderReq,
  SimOrdersResp,
  SimPnlResp,
  SimPlaceOrderReq,
  SimPositionsResp,
  SimSessionDetail,
  SimSessionListEntry,
  SimStartSessionReq,
  SimStateDto,
  SimStopReq,
  SimStrategiesDto,
  SimToggleReq,
  StrategyApprovalLevel,
  StrategyCatalogEntry,
  StrategyCreateReq,
  StrategyCreateResp,
  StrategyDiffResp,
  StrategyKind,
  StrategyManageItem,
  StrategyPatchReq,
  StrategyRowDto,
  StrategyTestRunReq,
  StrategyTestRunResp,
  StrategyUpdateOutcome,
  StrategyVersionRowDto,
  WorkbenchCompareItem,
  WorkbenchPresetConfigInput,
  WorkbenchPresetRow,
  WorkbenchRunConfig,
  WorkbenchRunResult,
  WorkbenchRunStatus,
  WorkbenchRunView,
  WorkbenchSubmitReq,
} from './types';
import { ApiError } from './types';

export interface KlineQuery {
  code: string;
  period: Period;
  before?: string; // 游标：排他上界 ts（向前翻页）
  limit?: number;
}

/** 页面④ 日期范围查询（from/to 为 YYYY-MM-DD，闭区间；thresholdPct 缺省由后端兜底 0.5） */
export interface QualityRangeQuery {
  from: string;
  to: string;
  thresholdPct?: number;
}

export interface QualityCodeRangeQuery extends QualityRangeQuery {
  code: string;
}

export interface ApiClient {
  /** 页面①：注册集合 + 最新价快照（GET /api/symbols，latest 内联展开为 SymbolSnapshot） */
  getSymbols(): Promise<SymbolSnapshot[]>;
  /** 页面①：K线游标分页（解 {bars} 包络，升序） */
  getKline(q: KlineQuery): Promise<Bar[]>;
  /** 看板收藏（Wave 3 页面①）：一键收藏（POST /api/symbols/{code}/favorite；幂等，404=code 未注册） */
  starSymbol(code: string): Promise<void>;
  /** 看板收藏：取消收藏（DELETE /api/symbols/{code}/favorite；幂等，404=code 未注册） */
  unstarSymbol(code: string): Promise<void>;
  /** 看板收藏：批量重排（PUT /api/symbols/favorites/order body {codes}；codes 顺序即收藏区展示顺序，须均为已收藏 code，否则 400） */
  reorderFavorites(codes: string[]): Promise<void>;
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
  // ── Wave 2 Phase C：页面④ 数据质量（04-quality §7.1 / 07-app-plane §1.1）──
  /** 分歧对照（只比 close，D4 口径；rows 按 |偏差| 降序） */
  getQualityDivergence(q: QualityCodeRangeQuery): Promise<QualityDivergenceResponse>;
  /** 源一致率排行（一致率降序） */
  getSourceAccuracy(q: QualityRangeQuery): Promise<SourceAccuracyResponse>;
  /** 历史缺口报告（仅含有缺口交易日；segment 时刻 CST HH:MM） */
  getQualityGaps(q: QualityCodeRangeQuery): Promise<QualityGapsResponse>;
  /** tushare 同步状态（sync-panel；quota_remaining 恒 null） */
  getTushareStatus(): Promise<TushareStatusResponse>;
  // ── 页面⑧ 系统设置（08-settings §6；仅 S1 只读/运维端点，无配置持久化）──
  /** 系统信息（应用/crate 版本、DB 状态、运行时长；只读） */
  getSystemInfo(): Promise<SystemInfo>;
  /** 源参数快照（S2 读持久，缺则默认） */
  getConfigSources(): Promise<SourceConfigSnapshot>;
  /** 保存源参数（PATCH /api/config/sources；完整清单+轮转序，东财末位 ADR-006，值域校验） */
  saveConfigSources(sources: SourceConfigItem[]): Promise<SourceConfigSnapshot>;
  /** 采集参数快照（默认间隔 + 交易时段（写死）） */
  getConfigCollector(): Promise<CollectorConfigSnapshot>;
  /** 保存采集参数（PATCH /api/config/collector；default_interval_sec ≥60） */
  saveConfigCollector(patch: CollectorConfigPatchBody): Promise<CollectorConfigSnapshot>;
  /** MCP 配置快照（总开关/交易工具/每日限额） */
  getConfigMcp(): Promise<McpConfigSnapshot>;
  /** 保存 MCP 配置（PATCH /api/config/mcp；金额/笔数 ≥0） */
  saveConfigMcp(patch: McpConfigPatchBody): Promise<McpConfigSnapshot>;
  /** 行情看板 MA 窗口配置（GET /api/config/ma；主图+宫格应用，回测弹窗不动） */
  getMaConfig(): Promise<MaConfigDto>;
  /** 保存 MA 窗口配置（PUT /api/config/ma；后端校验 1-3 条/1-500、归一化升序去重） */
  saveMaConfig(windows: number[]): Promise<MaConfigDto>;
  /** 行情看板 K线默认视口配置（GET /api/config/kline；缺省 2；回测弹窗不动） */
  getKlineConfig(): Promise<KlineConfigDto>;
  /** 保存 K线默认视口配置（PUT /api/config/kline；后端校验 1-50 整数） */
  saveKlineConfig(viewportDays: number): Promise<KlineConfigDto>;
  /** 清空 kline_raw（危险；confirm 须为 'PURGE'，缺失/不匹配 → 400） */
  purgeRaw(confirm: string): Promise<PurgeRawResult>;
  /** 全部源熔断状态重置（危险；confirm 须匹配，缺失/不匹配 → 400） */
  resetCircuits(confirm: string): Promise<ResetCircuitsResult>;
  // ── 页面⑤ 回测工作台（Wave 3 Phase 3c；07-app-plane/00-web-api.md §1.5）──
  /** 策略目录（GET /api/backtest/strategies；7 款内置，params_schema 驱动参数表单） */
  getStrategies(): Promise<BacktestStrategyDto[]>;
  /** 提交回测/网格（POST /api/backtest/runs；网格展开→任务组）。body 字段后端 snake_case */
  submitRun(req: BacktestSubmitReq): Promise<BacktestSubmitResp>;
  /** 任务列表（GET /api/backtest/runs；status/group_id 过滤 + limit/offset 分页；**轻量：不含结果字段**，结果仅 getRun） */
  listRuns(filter?: {
    status?: BacktestStatus;
    groupId?: string;
    limit?: number;
    offset?: number;
  }): Promise<BacktestRunDto[]>;
  /** 单 run 详情（GET /api/backtest/runs/{id}；完成时含净值/交易/指标） */
  getRun(id: number): Promise<BacktestRunDto>;
  /** 多 run 对比（GET /api/backtest/compare?ids=；不存在的 run 被后端过滤） */
  compare(ids: number[]): Promise<BacktestRunDto[]>;
  /** 删除回测 run（DELETE /api/backtest/runs/{id}；200 成功/404 不存在） */
  deleteRun(id: number): Promise<void>;
  // ── 页面⑨ 模拟实盘（Wave 4/L3b；07-app-plane/00-web-api.md §1.6，与 MCP 共享同一 SimLiveService）──
  /** 当前会话聚合（GET /api/sim-live/state；account+positions+pnl+trading_enabled+mcp_enabled） */
  getSimState(sessionId?: string): Promise<SimStateDto>;
  /** 持仓（GET /api/sim-live/positions） */
  getSimPositions(sessionId?: string): Promise<SimPositionsResp>;
  /** 订单（GET /api/sim-live/orders） */
  getSimOrders(sessionId?: string): Promise<SimOrdersResp>;
  /** 盈亏（GET /api/sim-live/pnl） */
  getSimPnl(sessionId?: string): Promise<SimPnlResp>;
  /** 策略评估概览（GET /api/sim-live/strategies；每策略独立分+聚合分） */
  getSimStrategies(sessionId?: string): Promise<SimStrategiesDto>;
  /** 开会话（POST /api/sim-live/start-session） */
  startSimSession(req: SimStartSessionReq): Promise<{ started: boolean; session: import('./types').SimSession }>;
  /** 停会话（POST /api/sim-live/stop-session） */
  stopSimSession(req: SimStopReq): Promise<{ session_id: string; stopped: boolean }>;
  /** 下模拟单（POST /api/sim-live/place-order；`price`=模拟行情最新价） */
  placeSimOrder(req: SimPlaceOrderReq): Promise<{ session_id: string; filled: boolean; fill: unknown | null; reason?: string }>;
  /** 撤单（POST /api/sim-live/cancel-order） */
  cancelSimOrder(req: SimCancelOrderReq): Promise<{ session_id: string; order_id: string; cancelled: boolean }>;
  /** 统一交易开关（POST /api/sim-live/trading） */
  toggleSimTrading(req: SimToggleReq): Promise<{ session_id: string; trading_enabled: boolean }>;
  /** MCP sim_* 服务快捷开关（POST /api/sim-live/mcp-toggle；共享同一 SimLiveService） */
  toggleSimMcp(req: SimToggleReq): Promise<{ mcp_enabled: boolean }>;
  /** 历史会话列表（GET /api/sim-live/sessions） */
  getSimSessions(): Promise<SimSessionListEntry[]>;
  /** 会话详情回看（GET /api/sim-live/sessions/{id}） */
  getSimSession(id: string): Promise<SimSessionDetail>;
  /** 「回测一下」对比（POST /api/sim-live/sessions/{id}/backtest-compare） */
  runSimBacktestCompare(id: string): Promise<SimBacktestCompare>;
  // ── 页面⑩ 策略 Registry（12-strategy-system / P2b；07-app-plane §1.7）──
  /** 管理列表（GET /api/strategies/manage?kind=；含仅 draft 策略，列表页数据源） */
  getStrategyManageList(filter?: { kind?: StrategyKind }): Promise<StrategyManageItem[]>;
  /** 策略 catalog（GET /api/strategies?level=&kind=；仅 published；level at-least 语义；模板下拉数据源） */
  getStrategyCatalog(filter?: { level?: StrategyApprovalLevel; kind?: StrategyKind }): Promise<StrategyCatalogEntry[]>;
  /** 新建策略（POST /api/strategies；201 v1 draft；模板创建时 code 预填模板代码） */
  createStrategy(req: StrategyCreateReq): Promise<StrategyCreateResp>;
  /** 策略元数据编辑（PATCH /api/strategies/{id}；至少一个字段） */
  patchStrategy(id: string, patch: StrategyPatchReq): Promise<StrategyRowDto>;
  /** 策略详情（GET /api/strategies/{id}） */
  getStrategy(id: string): Promise<StrategyRowDto>;
  /** 版本列表（GET /api/strategies/{id}/versions；version 升序） */
  getStrategyVersions(id: string): Promise<StrategyVersionRowDto[]>;
  /** 从指定版本新建 draft（POST /api/strategies/{id}/versions；回滚/派生） */
  createStrategyVersion(strategyId: string, fromVersionId: string): Promise<StrategyVersionRowDto>;
  /** 保存代码（PUT /api/strategies/versions/{vid}；draft 原地更新 / published 自动新 draft；archived → 409） */
  updateStrategyVersion(vid: string, code: string): Promise<StrategyUpdateOutcome>;
  /** 发布（POST /api/strategies/versions/{vid}/publish；门禁冒烟通过才转 published） */
  publishStrategyVersion(vid: string): Promise<StrategyVersionRowDto>;
  /** 归档（POST /api/strategies/versions/{vid}/archive；仅 published） */
  archiveStrategyVersion(vid: string): Promise<StrategyVersionRowDto>;
  /** 版本 diff（GET /api/strategies/versions/diff?from=&to=；前端渲染行级 diff） */
  diffStrategyVersions(from: string, to: string): Promise<StrategyDiffResp>;
  /** 在线试算（POST /api/strategies/test-run；同步；双模式 pure_score/sim_position） */
  runStrategyTest(req: StrategyTestRunReq): Promise<StrategyTestRunResp>;
  // ── 页面⑪ 回测工作台（12-strategy-system / P3b；07-app-plane §1.8）──
  /** 提交 ensemble 运行（POST /api/workbench/runs；201 queued 行含钉住 config 快照） */
  submitWorkbenchRun(req: WorkbenchSubmitReq): Promise<WorkbenchRunView>;
  /** 运行历史（GET /api/workbench/runs；status 过滤 + limit/offset 分页；轻量不含结果） */
  listWorkbenchRuns(filter?: {
    status?: WorkbenchRunStatus;
    limit?: number;
    offset?: number;
  }): Promise<WorkbenchRunView[]>;
  /** 单 run 详情（GET /api/workbench/runs/{id}；404 未知 id） */
  getWorkbenchRun(id: string): Promise<WorkbenchRunView>;
  /** 运行结果（GET /api/workbench/runs/{id}/result；per_bar 全量五 jsonb；404 未知/未成功） */
  getWorkbenchResult(id: string): Promise<WorkbenchRunResult>;
  /** 协作式取消（POST /api/workbench/runs/{id}/cancel；409 已终态/404 未知） */
  cancelWorkbenchRun(id: string): Promise<WorkbenchRunView>;
  /** 多 run 并排对比（POST /api/workbench/runs/compare body {ids}；输入序；未知/未成功跳过） */
  compareWorkbenchRuns(ids: string[]): Promise<WorkbenchCompareItem[]>;
  /** 组合预设列表（GET /api/workbench/presets；created_at ASC） */
  listWorkbenchPresets(): Promise<WorkbenchPresetRow[]>;
  /** 预设详情（GET /api/workbench/presets/{id}；404） */
  getWorkbenchPreset(id: string): Promise<WorkbenchPresetRow>;
  /** 新建预设（POST /api/workbench/presets；201；409 重名/400 配置非法；config 未钉住形态，后端钉住） */
  createWorkbenchPreset(req: { name: string; config: WorkbenchPresetConfigInput }): Promise<WorkbenchPresetRow>;
  /** 更新预设（PUT /api/workbench/presets/{id}；404/409 撞名） */
  updateWorkbenchPreset(id: string, req: { name: string; config: WorkbenchPresetConfigInput }): Promise<WorkbenchPresetRow>;
  /** 删除预设（DELETE /api/workbench/presets/{id}；404） */
  deleteWorkbenchPreset(id: string): Promise<void>;
  /** 应用预设（POST /api/workbench/presets/{id}/apply → 钉住 config，供 submit 合并 symbol/period/from/to） */
  applyWorkbenchPreset(id: string): Promise<WorkbenchRunConfig>;
}

/** 后端 SymbolDto → 骨架 SymbolSnapshot（latest 展开；无 bar/无名兜底）。
 *  D2：enabled 透传；latest=null → last=null（前端渲染「无数据」/「已停用」，不伪造 0.000）。
 *  看板收藏：favorite/favorite_sort 透传（恒输出；缺失兜底 false/null）。 */
function dtoToSnapshot(d: SymbolRow): SymbolSnapshot {
  return {
    code: d.code,
    name: d.name ?? d.code,
    enabled: d.enabled,
    last: d.latest?.last ?? null,
    changePct: d.latest?.change_pct ?? 0,
    favorite: d.favorite ?? false,
    favoriteSort: d.favorite_sort ?? null,
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
    // ── 看板收藏（Wave 3 页面①；07-app-plane/00-web-api.md §1.5）──
    starSymbol: async (code) => {
      await request(`/api/symbols/${encodeURIComponent(code)}/favorite`, { method: 'POST' });
    },
    unstarSymbol: async (code) => {
      await request(`/api/symbols/${encodeURIComponent(code)}/favorite`, { method: 'DELETE' });
    },
    reorderFavorites: async (codes) => {
      await request('/api/symbols/favorites/order', { method: 'PUT', body: JSON.stringify({ codes }) });
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
    // ── Wave 2 Phase C：页面④ ──
    getQualityDivergence: (q) => get(`/api/quality/divergence?${qualityParams(q).toString()}`),
    getSourceAccuracy: (q) => get(`/api/quality/source-accuracy?${qualityParams(q).toString()}`),
    getQualityGaps: (q) => get(`/api/quality/gaps?${qualityParams(q).toString()}`),
    getTushareStatus: () => get('/api/tushare/status'),
    // ── 页面⑧ 系统设置（08-settings §6；仅 S1 只读/运维端点）──
    getSystemInfo: () => get<SystemInfo>('/api/system/info'),
    getConfigSources: () => get<SourceConfigSnapshot>('/api/config/sources'),
    saveConfigSources: (sources) =>
      request<SourceConfigSnapshot>('/api/config/sources', {
        method: 'PATCH',
        body: JSON.stringify({
          sources: sources.map(({ id, rate_per_sec, jitter_ms, circuit_fail_count, backoff_steps, enabled }) => ({
            id, rate_per_sec, jitter_ms, circuit_fail_count, backoff_steps, enabled,
          })),
        }),
      }),
    getConfigCollector: () => get<CollectorConfigSnapshot>('/api/config/collector'),
    saveConfigCollector: (patch) =>
      request<CollectorConfigSnapshot>('/api/config/collector', { method: 'PATCH', body: JSON.stringify(patch) }),
    getConfigMcp: () => get<McpConfigSnapshot>('/api/config/mcp'),
    saveConfigMcp: (patch) =>
      request<McpConfigSnapshot>('/api/config/mcp', { method: 'PATCH', body: JSON.stringify(patch) }),
    getMaConfig: () => get<MaConfigDto>('/api/config/ma'),
    saveMaConfig: (windows) =>
      request<MaConfigDto>('/api/config/ma', { method: 'PUT', body: JSON.stringify({ windows }) }),
    getKlineConfig: () => get<KlineConfigDto>('/api/config/kline'),
    saveKlineConfig: (viewportDays) =>
      request<KlineConfigDto>('/api/config/kline', { method: 'PUT', body: JSON.stringify({ viewport_days: viewportDays }) }),
    purgeRaw: (confirm) =>
      request<PurgeRawResult>('/api/system/purge-raw', {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      }),
    resetCircuits: (confirm) =>
      request<ResetCircuitsResult>('/api/system/reset-circuits', {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      }),
    // ── 页面⑤ 回测工作台（Wave 3 Phase 3c）──
    getStrategies: () => get<BacktestStrategyDto[]>('/api/backtest/strategies'),
    submitRun: (req) =>
      request<BacktestSubmitResp>('/api/backtest/runs', {
        method: 'POST',
        body: JSON.stringify(toBacktestSubmitBody(req)),
      }),
    listRuns: (filter) => {
      const params = new URLSearchParams();
      if (filter?.status) params.set('status', filter.status);
      if (filter?.groupId) params.set('group_id', filter.groupId);
      if (filter?.limit != null) params.set('limit', String(filter.limit));
      if (filter?.offset != null) params.set('offset', String(filter.offset));
      const qs = params.toString();
      return get<BacktestRunDto[]>(`/api/backtest/runs${qs ? `?${qs}` : ''}`);
    },
    getRun: (id) => get<BacktestRunDto>(`/api/backtest/runs/${id}`),
    compare: (ids) => get<BacktestRunDto[]>(`/api/backtest/compare?ids=${ids.join(',')}`),
    deleteRun: async (id) => {
      const res = await fetcher(`${baseUrl}/api/backtest/runs/${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status} /api/backtest/runs/${id}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = `${msg}: ${body.error}`;
        } catch {
          // 非 JSON 错误体忽略（如 204/空响应）
        }
        throw new ApiError(res.status, msg);
      }
    },
    // ── 页面⑨ 模拟实盘（§1.6；与 MCP 共享同一 SimLiveService）──
    getSimState: (sessionId) => get(`/api/sim-live/state${simSessionQuery(sessionId)}`),
    getSimPositions: (sessionId) => get(`/api/sim-live/positions${simSessionQuery(sessionId)}`),
    getSimOrders: (sessionId) => get(`/api/sim-live/orders${simSessionQuery(sessionId)}`),
    getSimPnl: (sessionId) => get(`/api/sim-live/pnl${simSessionQuery(sessionId)}`),
    getSimStrategies: (sessionId) =>
      get(`/api/sim-live/strategies${simSessionQuery(sessionId)}`),
    startSimSession: async (req) => {
      const res = await fetcher(`${baseUrl}/api/sim-live/start-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        throw new ApiError(res.status, `HTTP ${res.status} /api/sim-live/start-session`);
      }
      return (await res.json()) as Promise<{ started: boolean; session: import('./types').SimSession }>;
    },
    stopSimSession: (req) => request('/api/sim-live/stop-session', { method: 'POST', body: JSON.stringify(req) }),
    placeSimOrder: (req) => request('/api/sim-live/place-order', { method: 'POST', body: JSON.stringify(req) }),
    cancelSimOrder: (req) => request('/api/sim-live/cancel-order', { method: 'POST', body: JSON.stringify(req) }),
    toggleSimTrading: (req) => request('/api/sim-live/trading', { method: 'POST', body: JSON.stringify(req) }),
    toggleSimMcp: (req) => request('/api/sim-live/mcp-toggle', { method: 'POST', body: JSON.stringify(req) }),
    getSimSessions: () => get('/api/sim-live/sessions'),
    getSimSession: (id) => get(`/api/sim-live/sessions/${encodeURIComponent(id)}`),
    runSimBacktestCompare: (id) =>
      request(`/api/sim-live/sessions/${encodeURIComponent(id)}/backtest-compare`, { method: 'POST' }),
    // ── 页面⑩ 策略 Registry（§1.7）──
    getStrategyManageList: (filter) => {
      const params = new URLSearchParams();
      if (filter?.kind) params.set('kind', filter.kind);
      const qs = params.toString();
      return get<{ items: StrategyManageItem[] }>(`/api/strategies/manage${qs ? `?${qs}` : ''}`).then(
        (r) => r.items,
      );
    },
    getStrategyCatalog: (filter) => {
      const params = new URLSearchParams();
      if (filter?.level) params.set('level', filter.level);
      if (filter?.kind) params.set('kind', filter.kind);
      const qs = params.toString();
      return get<StrategyCatalogEntry[]>(`/api/strategies${qs ? `?${qs}` : ''}`);
    },
    createStrategy: (req) =>
      request<StrategyCreateResp>('/api/strategies', { method: 'POST', body: JSON.stringify(req) }),
    patchStrategy: (id, patch) =>
      request<StrategyRowDto>(`/api/strategies/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    getStrategy: (id) => get<StrategyRowDto>(`/api/strategies/${encodeURIComponent(id)}`),
    getStrategyVersions: (id) =>
      get<StrategyVersionRowDto[]>(`/api/strategies/${encodeURIComponent(id)}/versions`),
    createStrategyVersion: (strategyId, fromVersionId) =>
      request<StrategyVersionRowDto>(`/api/strategies/${encodeURIComponent(strategyId)}/versions`, {
        method: 'POST',
        body: JSON.stringify({ from_version_id: fromVersionId }),
      }),
    updateStrategyVersion: (vid, code) =>
      request<StrategyUpdateOutcome>(`/api/strategies/versions/${encodeURIComponent(vid)}`, {
        method: 'PUT',
        body: JSON.stringify({ code }),
      }),
    publishStrategyVersion: (vid) =>
      request<StrategyVersionRowDto>(`/api/strategies/versions/${encodeURIComponent(vid)}/publish`, {
        method: 'POST',
      }),
    archiveStrategyVersion: (vid) =>
      request<StrategyVersionRowDto>(`/api/strategies/versions/${encodeURIComponent(vid)}/archive`, {
        method: 'POST',
      }),
    diffStrategyVersions: (from, to) =>
      get<StrategyDiffResp>(
        `/api/strategies/versions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    runStrategyTest: (req) =>
      request<StrategyTestRunResp>('/api/strategies/test-run', {
        method: 'POST',
        body: JSON.stringify({
          ...(req.code !== undefined ? { code: req.code } : {}),
          ...(req.versionId !== undefined ? { version_id: req.versionId } : {}),
          params: req.params ?? {},
          symbol: req.symbol,
          period: req.period,
          from: req.from,
          to: req.to,
          mode: req.mode,
        }),
      }),
    // ── 页面⑪ 回测工作台（§1.8）──
    submitWorkbenchRun: (req) =>
      request<WorkbenchRunView>('/api/workbench/runs', { method: 'POST', body: JSON.stringify(req) }),
    listWorkbenchRuns: (filter) => {
      const params = new URLSearchParams();
      if (filter?.status) params.set('status', filter.status);
      if (filter?.limit != null) params.set('limit', String(filter.limit));
      if (filter?.offset != null) params.set('offset', String(filter.offset));
      const qs = params.toString();
      return get<WorkbenchRunView[]>(`/api/workbench/runs${qs ? `?${qs}` : ''}`);
    },
    getWorkbenchRun: (id) => get<WorkbenchRunView>(`/api/workbench/runs/${encodeURIComponent(id)}`),
    getWorkbenchResult: (id) =>
      get<WorkbenchRunResult>(`/api/workbench/runs/${encodeURIComponent(id)}/result`),
    cancelWorkbenchRun: (id) =>
      request<WorkbenchRunView>(`/api/workbench/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    compareWorkbenchRuns: (ids) =>
      request<WorkbenchCompareItem[]>('/api/workbench/runs/compare', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    listWorkbenchPresets: () => get<WorkbenchPresetRow[]>('/api/workbench/presets'),
    getWorkbenchPreset: (id) =>
      get<WorkbenchPresetRow>(`/api/workbench/presets/${encodeURIComponent(id)}`),
    createWorkbenchPreset: (req) =>
      request<WorkbenchPresetRow>('/api/workbench/presets', { method: 'POST', body: JSON.stringify(req) }),
    updateWorkbenchPreset: (id, req) =>
      request<WorkbenchPresetRow>(`/api/workbench/presets/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(req),
      }),
    deleteWorkbenchPreset: async (id) => {
      await request(`/api/workbench/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    applyWorkbenchPreset: (id) =>
      request<WorkbenchRunConfig>(`/api/workbench/presets/${encodeURIComponent(id)}/apply`, { method: 'POST' }),
  };
}

/** 后端口径周期代码（front 1m/5m/15m/1d → M1/M5/M15/D1；H1 回测不支持） */
const BACKTEST_PERIOD_CODE: Record<BacktestPeriod, string> = {
  '1m': 'M1',
  '5m': 'M5',
  '15m': 'M15',
  '1d': 'D1',
} as const;

/** 缺省回测区间（RFC3339；UI 未传 from/to 时兜底，后端 [from,to) 闭开） */
const DEFAULT_BT_FROM = '2026-01-01T00:00:00Z';
const DEFAULT_BT_TO = '2026-12-31T00:00:00Z';

/** 提交请求 → 后端 body：period 映射 + params 与 params_grid 拆分 + fee/初始资金 snake_case。 */
function toBacktestSubmitBody(req: BacktestSubmitReq): Record<string, unknown> {
  const numeric: Record<string, number> = {};
  const grid: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.params)) {
    if (typeof v === 'string') grid[k] = v;  // 「起:止:步长」网格值
    else numeric[k] = v;
  }
  const body: Record<string, unknown> = {
    code: req.code,
    period: BACKTEST_PERIOD_CODE[req.period],
    from: req.from ?? DEFAULT_BT_FROM,
    to: req.to ?? DEFAULT_BT_TO,
    strategy_id: req.strategyId,
    params: numeric,
    fee: { rate_pct: req.fee.ratePct, min_fee: req.fee.minFee, slippage_bp: req.fee.slippageBp },
  };
  if (Object.keys(grid).length > 0) body.params_grid = grid;
  if (req.initialCapital != null) body.initial_capital = req.initialCapital;
  return body;
}

/** 页面④ 查询参数序列化（code 可选；thresholdPct → threshold_pct，缺省不带由后端兜底） */
function qualityParams(q: Partial<QualityCodeRangeQuery> & QualityRangeQuery): URLSearchParams {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.code) params.set('code', q.code);
  if (q.thresholdPct != null) params.set('threshold_pct', String(q.thresholdPct));
  return params;
}

/** 页面⑨ sim-live：可选 `session_id` 查询参数（缺省时后端回落当前运行会话）。 */
function simSessionQuery(sessionId?: string): string {
  if (!sessionId) return '';
  return `?session_id=${encodeURIComponent(sessionId)}`;
}
