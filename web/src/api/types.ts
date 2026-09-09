// API 契约类型（09-frontend.md §5；Phase C 起以 07-app-plane §1.1 真实后端契约为事实源）
// Period / GridMode / SymbolSnapshot 由 tangle 骨架（DashboardGrid）持有，此处再导出避免双事实源
export type { Period, GridMode, SymbolSnapshot } from '@/layouts/DashboardGrid';
export type { DetailRange } from '@/layouts/SourcesGrid';
export type { Settlement, FormMode, SymbolFormValues } from '@/layouts/SymbolsGrid';
import type { BacktestPeriod } from '@/layouts/BacktestGrid';
export type { BacktestPeriod } from '@/layouts/BacktestGrid';

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
  /** 看板收藏（Wave 3 页面①）：后端恒输出 favorite + favorite_sort（always 序列化；此处 optional 兼容既有构造） */
  favorite?: boolean; // 是否收藏（缺失视为非收藏）
  favorite_sort?: number | null; // 收藏排序（sort_order，起点 1；非收藏 null）
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

/** ── 页面⑧ 系统设置（08-settings.md §6 API 依赖）── */
type CrateVersion = { collector: string; storage: string; diagnose: string };

/** GET /api/system/info 响应（只读；db 断开以 db_ok=false 表达，不上错误态） */
export interface SystemInfo {
  app_version: string;
  crate_versions: CrateVersion;
  db_ok: boolean;
  uptime_secs: number;
}

/** GET /api/config/sources → 单源只读快照项（snake_case 与后端线格式同构） */
export interface SourceConfigItem {
  id: string;                 // 源 id 文本（tencent_ifzq）
  label: string;              // 中文名（前端静态映射）
  role: '1m' | 'snapshot';
  rate_per_sec: number;       // token bucket 默认 1 req/s（ADR-005 口径）
  jitter_ms: number;          // 抖动范围
  circuit_fail_count: number; // 熔断连续失败次数默认 3
  backoff_steps: string[];    // 退避档位 5s→10s→30s
  enabled: boolean;
  rotation_locked: boolean;   // 东财系（push2delay）锁定轮转序末位（ADR-006）
}

/** GET /api/config/sources 响应（只读快照，S2 读持久，缺则默认） */
export interface SourceConfigSnapshot {
  sources: SourceConfigItem[];
}

/** PATCH /api/config/sources 单源可编辑参数（label/role/rotation_locked 由服务端派生；轮转序 = 数组顺序，push2delay 末位 ADR-006）。 */
export interface SourceConfigPatchItem {
  id: string;
  rate_per_sec: number;
  jitter_ms: number;
  circuit_fail_count: number;
  backoff_steps: string[];
  enabled: boolean;
}

/** PATCH /api/config/sources 请求体（完整源清单 + 轮转序）。 */
export interface SourceConfigPatchBody {
  sources: SourceConfigPatchItem[];
}

/** GET /api/config/collector 响应（只读；交易时段写死） */
export interface CollectorConfigSnapshot {
  default_interval_sec: number;
  trading_hours: string;
}

/** PATCH /api/config/collector 请求体（交易时段写死只读，不可改）。 */
export interface CollectorConfigPatchBody {
  default_interval_sec: number;
}

/** GET /api/config/mcp 响应（S2 读持久，缺则默认） */
export interface McpConfigSnapshot {
  enabled: boolean;
  trading_tools_enabled: boolean;
  daily_limit_amount: number;
  daily_limit_count: number;
}

/** PATCH /api/config/mcp 请求体（总开关/交易工具/每日限额）。 */
export interface McpConfigPatchBody {
  enabled: boolean;
  trading_tools_enabled: boolean;
  daily_limit_amount: number;
  daily_limit_count: number;
}

/** POST /api/system/purge-raw 响应（rows_deleted=清理的 kline_raw 行数） */
export interface PurgeRawResult {
  rows_deleted: number;
}

/** POST /api/system/reset-circuits 响应（requests=写入的熔断复位请求数） */
export interface ResetCircuitsResult {
  requests: number;
}

/** GET/PUT /api/config/ma 响应/请求体：MA 窗口列表（归一化升序去重，默认 [5,10,20]；主图+宫格应用，回测弹窗不动）。 */
export interface MaConfigDto {
  windows: number[];
}

/** GET/PUT /api/config/kline 响应/请求体：K线默认视口（app_config key "kline"，迁移 0021；缺省 2）。
 *  每周期实际 bar = 该周期每日 bar 数 × viewport_days；主图+宫格应用，回测弹窗不动。 */
export interface KlineConfigDto {
  viewport_days: number;
}

// ── 页面⑤ 回测工作台（06-web/05-backtest.md L2 + 08-backtest/01-engine-adr.md §7；后端线格式见 07-app-plane/00-web-api.md §1.5）──

export type BacktestStatus = 'pending' | 'running' | 'done' | 'failed';

/** 参数种类（直通 backtest::ParamDef JSON：serde 外部标签枚举，{"Num":{"min":..}} 或 {"Choice":{"options":..}}） */
export type BacktestParamKind =
  | { Num: { min: number; max: number; step: number; def: number } }
  | { Choice: { options: string[]; def: string } };

/** 单个参数描述（GET /api/backtest/strategies → params_schema 项） */
export interface BacktestParamDef {
  key: string;
  label: string;
  kind: BacktestParamKind;
}

/** 策略目录项（GET /api/backtest/strategies；恰好 7 款内置策略） */
export interface BacktestStrategyDto {
  id: string;
  name: string;
  description: string;
  params_schema: BacktestParamDef[];
}

/** 净值/回撤序列（run.net_value；ts 为 Unix 秒） */
export interface BacktestNetValue {
  series: Array<[number, number]>;    // [ts_unix_sec, equity]
  drawdown: Array<[number, number]>;  // [ts_unix_sec, drawdown]
}

/** 8 项绩效指标（BacktestMetrics jsonb；口径 08-backtest §6 单测锁定） */
export interface Metrics {
  net_profit: number;
  max_drawdown: number;
  sharpe: number;
  win_rate: number;
  profit_factor: number;
  annualized_return: number;
  trade_count: number;
  avg_hold_bars: number;
}

/** 单笔交易明细（TradeDetail jsonb；open_ts/close_ts 为 Unix 秒） */
export interface Trade {
  open_ts: number;
  close_ts: number;
  open_bar: number;
  close_bar: number;
  open_price: number;
  close_price: number;
  shares: number;
  gross_value: number;
  commission: number;
  stamp_duty: number;
  pnl: number;
  hold_bars: number;
}

/** 回测 run（GET /api/backtest/runs、/{id}、compare 响应项；status=done 时才带结果字段） */
export interface BacktestRunDto {
  id: number;
  code: string;
  period: string;  // 后端口径：M1/M5/M15/D1
  strategy_id: string;
  params: Record<string, unknown>;
  fee: Record<string, number>;
  status: BacktestStatus;
  progress: number;
  current_ts: string | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  group_id: string | null;
  /** 初始资金（后端 RunDto；未回填时缺失） */
  initial_capital?: number;
  /** 回测区间起点（后端 RunDto；RFC3339 或 YYYY-MM-DD） */
  date_from?: string;
  /** 回测区间终点（后端 RunDto） */
  date_to?: string;
  net_value?: BacktestNetValue;
  trades?: Trade[];
  metrics?: Metrics;
}

/** 提交费用（前端骨架契约 camelCase；client 序列化为 rate_pct/min_fee/slippage_bp） */
export interface BacktestFee {
  ratePct: number;
  minFee: number;
  slippageBp: number;
}

/** 提交回测请求（前端契约；period 为前端口径 1m/5m/15m/1d，client 映射为后端 M1/M5/M15/D1） */
export interface BacktestSubmitReq {
  strategyId: string;
  params: Record<string, number | string>;  // 数值参数 + 「起:止:步长」网格字符串
  code: string;
  period: BacktestPeriod;
  fee: BacktestFee;
  from?: string;  // RFC3339；缺省由 client 兜底默认区间
  to?: string;
  initialCapital?: number;
}

/** POST /api/backtest/runs 响应：单 run → {run_id}；网格 → {group_id, run_ids} */
export interface BacktestSubmitResp {
  run_id?: number;
  group_id?: string;
  run_ids?: number[];
}

// ── 页面⑨ 模拟实盘（11-sim-live / L3b；07-app-plane/00-web-api.md §1.6，snake_case 直通）──

export type SimSessionStatus = 'running' | 'ended';

/** 模拟会话元数据（GET /api/sim-live/state.session / sessions / sessions/{id}） */
export interface SimSession {
  id: string;
  name: string;
  status: SimSessionStatus;
  source: string;                          // 'mcp' | 'web' | 'manual' | 'preset'
  cash_init: number;
  strategy_set: string[];
  stock_set: string[];
  period: string;
  start_ts: string;
  end_ts: string | null;
}

/** 账户读模型 */
export interface SimAccount {
  session_id: string;
  cash: number;
  equity: number;
  market_value: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_fee: number;
}

/** 持仓读模型 */
export interface SimPosition {
  code: string;
  qty: number;
  avg_cost: number;
  latest: number;
  market_value: number;
  unrealized_pnl: number;
}

/** 盈亏读模型 */
export interface SimPnl {
  realized_pnl: number;
  unrealized_pnl: number;
  total_fee: number;
  net_profit: number;
}

/** 模拟订单 */
export interface SimOrder {
  id: string;
  code: string;
  side: 'buy' | 'sell';
  qty: number;
  limit_price: number | null;
  status: 'pending' | 'filled' | 'cancelled';
  filled_price: number | null;
  filled_qty: number;
  fee: number;
  ts: number;
  source: string;                          // 'strategy' | 'manual' | 'aggregate_strategy'
}

/** GET /api/sim-live/state 响应（当前会话聚合：会话+账户+持仓+P&L+开关） */
export interface SimStateDto {
  active: boolean;
  session: SimSession | null;
  account: SimAccount | null;
  positions: SimPosition[];
  pnl: SimPnl | null;
  trading_enabled: boolean;
  mcp_enabled: boolean;
}

/** 单策略对单标的独立评分（0-100） */
export interface SimStrategyScore {
  strategy_id: string;
  score: number;
  signal: 'buy' | 'sell' | 'hold';
}

/** 单 stock 评估（stock-scoring 行） */
export interface SimStockEvaluation {
  code: string;
  ts: number;
  latest_price: number;
  per_strategy_scores: SimStrategyScore[];
  aggregate_score: number;
  signal: 'buy' | 'sell' | 'hold';
}

/** 每策略当前最强标的（strategy-panel）+ 其配置（ADR §4：params/stocks/weight/stock_weights）。 */
export interface SimStrategySummary {
  strategy_id: string;
  name: string;
  strongest: { code: string; score: number; signal: 'buy' | 'sell' | 'hold' } | null;
  config?: SimStrategyConfigInput | null;
}

/** GET /api/sim-live/strategies 响应 */
export interface SimStrategiesDto {
  session_id: string;
  strategies: SimStrategySummary[];
  stocks: SimStockEvaluation[];
}

/** GET /api/sim-live/positions / orders / pnl 响应（{session_id, ...} 包络） */
export interface SimPositionsResp {
  session_id: string;
  positions: SimPosition[];
}
export interface SimOrdersResp {
  session_id: string;
  orders: SimOrder[];
}
export interface SimPnlResp {
  session_id: string;
  pnl: SimPnl;
}

/** 历史会话条目（已结束附指标摘要；metrics=BacktestMetrics jsonb） */
export interface SimSessionListEntry {
  session: SimSession;
  metrics: Record<string, unknown> | null;
}

/** 会话详情回看（元数据+结束结果） */
export interface SimSessionDetail {
  session: SimSession;
  result: { net_value: unknown; trades: unknown; metrics: unknown } | null;
}

/** POST /api/sim-live/sessions/{id}/backtest-compare 响应 */
export interface SimBacktestCompare {
  session_id: string;
  session_result: SimSessionDetail['result'];
  run_ids: number[];
}

/** 单策略配置输入（ADR 11-sim-live §4 多策略；params 为策略参数对象，按 params_schema） */
export interface SimStrategyConfigInput {
  id: string;
  /** 策略参数（数值/枚举；缺省 → 各策略 schema 默认值） */
  params?: Record<string, number | string>;
  /** 该策略实时评估的标的子集（须非空） */
  stocks: string[];
  /** 策略级聚合权重（>0，缺省 1.0） */
  weight?: number;
  /** 按标的覆盖权重（策略×股票级）；未指定某股 → 用 weight */
  stock_weights?: Record<string, number>;
}

/** 开会话请求 */
export interface SimStartSessionReq {
  name: string;
  period: string;
  cash_init?: number;
  strategy_set?: string[];
  stock_set?: string[];
  source?: string;
  /** 每策略配置（ADR §4）：若提供则用之（每策略实例+参数+标的集+权重），否则用 strategy_set × stock_set（默认参数、weight=1） */
  strategies?: SimStrategyConfigInput[];
}

/** 下模拟单请求（`price`=模拟行情最新价） */
export interface SimPlaceOrderReq {
  session_id?: string;
  code: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  limit_price?: number;
  intent_id?: string;
  source?: string;
}

/** 统一交易开关 / MCP 开关请求 */
export interface SimToggleReq {
  enabled: boolean;
}

/** 撤单请求 */
export interface SimCancelOrderReq {
  session_id: string;
  order_id: string;
}

/** 停会话请求 */
export interface SimStopReq {
  session_id?: string;
}

// ── 策略 Registry（12-strategy-system / P2b；07-app-plane §1.7 后端线格式，snake_case 直传）──

/** 版本状态（domain::strategy_state；draft→published→archived 单向） */
export type StrategyStatus = 'draft' | 'published' | 'archived';
/** 权限分级（at-least 阶梯：backtest_ok ≤ sim_ok ≤ live_approved） */
export type StrategyApprovalLevel = 'backtest_ok' | 'sim_ok' | 'live_approved';
/** 策略类别：strategy=用户策略 / template=官方模板（ADR §13.2 D10） */
export type StrategyKind = 'strategy' | 'template';

/** 策略元数据行（StrategyRow） */
export interface StrategyRowDto {
  id: string;
  name: string;
  description: string;
  kind: StrategyKind;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** 插件 PARAMS_SCHEMA 声明项（02-plugin-abi §1；strategy-runtime ParamDef serde 形状） */
export interface StrategyParamDef {
  key: string;
  type: 'int' | 'float';
  default: number;
  min?: number;
  max?: number;
  description?: string;
}

/** 策略版本行（StrategyVersionRow；params_schema JSONB → StrategyParamDef[]） */
export interface StrategyVersionRowDto {
  id: string;
  strategy_id: string;
  version: number;
  code: string;
  params_schema: StrategyParamDef[];
  sha256: string;
  status: StrategyStatus;
  approval_level: StrategyApprovalLevel;
  created_at: string;
  published_at: string | null;
}

/** catalog 条目（GET /api/strategies；策略 + 其最新 published 版本） */
export interface StrategyCatalogEntry {
  strategy: StrategyRowDto;
  version: StrategyVersionRowDto;
}

/** 管理列表版本摘要（GET /api/strategies/manage latest_version/latest_published 内联形状） */
export interface StrategyVersionBrief {
  id: string;
  version: number;
  status: StrategyStatus;
  approval_level: StrategyApprovalLevel;
  sha256: string;
  created_at: string;
  published_at: string | null;
}

/** 管理列表条目（含仅 draft 策略；列表页数据源） */
export interface StrategyManageItem {
  id: string;
  name: string;
  description: string;
  kind: StrategyKind;
  created_by: string;
  created_at: string;
  updated_at: string;
  version_count: number;
  latest_version: StrategyVersionBrief | null;
  latest_published: { id: string; version: number; approval_level: StrategyApprovalLevel } | null;
}

/** POST /api/strategies 请求体 */
export interface StrategyCreateReq {
  name: string;
  description?: string;
  kind?: StrategyKind;
  code: string;
}

/** POST /api/strategies 响应（201：v1 draft） */
export interface StrategyCreateResp {
  strategy: StrategyRowDto;
  version: StrategyVersionRowDto;
}

/** PATCH /api/strategies/{id} 请求体（至少一个字段） */
export interface StrategyPatchReq {
  name?: string;
  description?: string;
}

/** PUT /api/strategies/versions/{vid} 响应：draft 原地更新 / published 自动落新 draft（ADR §13.5） */
export interface StrategyUpdateOutcome {
  outcome: 'updated' | 'new_draft';
  version: StrategyVersionRowDto;
}

/** GET /api/strategies/versions/diff 响应（前端渲染 diff） */
export interface StrategyDiffSide {
  id: string;
  strategy_id: string;
  version: number;
  status: StrategyStatus;
  code: string;
}
export interface StrategyDiffResp {
  from: StrategyDiffSide;
  to: StrategyDiffSide;
}

/** 试算模式（ADR §13.5 双模式） */
export type StrategyTestMode = 'pure_score' | 'sim_position';

/** POST /api/strategies/test-run 请求（前端驼峰 → client 转 snake；code 与 versionId 二选一） */
export interface StrategyTestRunReq {
  code?: string;
  versionId?: string;
  params?: Record<string, number | string>;
  symbol: string;
  period: 'M1' | 'M5' | 'M15' | 'D1';
  from: string; // RFC3339
  to: string; // RFC3339
  mode: StrategyTestMode;
}

/** 试算评分点（score=null：插件熔断停用后的 bar） */
export interface StrategyScorePoint {
  ts: number; // Unix 秒
  score: number | null;
}

/** sim_position 模式逐 bar 信号点 */
export interface StrategySignalPoint {
  ts: number;
  signal: string; // buy|sell|hold
}

/** sim_position 模式成交明细（backtest::TradeDetail JSON 形状） */
export interface StrategyTradeDetail {
  open_ts: number;
  close_ts: number;
  open_bar: number;
  close_bar: number;
  open_price: number;
  close_price: number;
  shares: number;
  gross_value: number;
  commission: number;
  stamp_duty: number;
  pnl: number;
  hold_bars: number;
}

/** 试算事件（插件日志/插件错误/熔断；type 为 serde rename 后字段名） */
export interface StrategyTestEvent {
  type: string;
  bar_index: number;
  message: string;
}

/** 试算响应（POST /api/strategies/test-run；截断标记 truncated） */
export interface StrategyTestRunResp {
  mode: StrategyTestMode;
  symbol: string;
  period: string;
  bar_count: number;
  scores: StrategyScorePoint[];
  signals: StrategySignalPoint[];
  trades: StrategyTradeDetail[];
  events: StrategyTestEvent[];
  truncated: { scores: boolean; events: boolean; trades: boolean };
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

// ── 页面⑪ 回测工作台（12-strategy-system / P3b；07-app-plane/00-web-api.md §1.8）──
// 字段名与后端 serde 线格式一致（snake_case 透传，不做驼峰转换）。

/** 策略运行状态（StrategyRunStatus serde snake_case） */
export type WorkbenchRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** POST /api/workbench/runs 槽位（version_id 为 sv_ 前缀 published 版本） */
export interface WorkbenchSlotReq {
  version_id: string;
  params?: Record<string, number>;
  weight: number;
}

/** ExecutionPolicy serde 外部标签形态（strategy-core policy.rs） */
export type WorkbenchPolicy =
  | { LumpSum: { position_pct: number } }
  | { Dca: { tranches: number; mode: 'Equal' | 'FixedAmount'; amount?: number | null; interval: number } };

/** StopConfig serde 形态（strategy-core stop.rs；trigger 缺省 Intrabar） */
export interface WorkbenchStop {
  kind: 'FixedPct' | 'Trailing' | 'Atr';
  value: number;
  trigger?: 'Intrabar' | 'CloseBasis';
}

/** fee 形状（web 层 validate_backtest_fee 三键） */
export interface WorkbenchFee {
  rate_pct: number;
  min_fee: number;
  slippage_bp: number;
}

/** POST /api/workbench/runs body（from/to RFC3339；buy/sell_threshold、initial_capital、stop 可省） */
export interface WorkbenchSubmitReq {
  name?: string;
  symbol: string;
  period: string; // M1/M5/M15/D1
  from: string;
  to: string;
  slots: WorkbenchSlotReq[];
  buy_threshold?: number;
  sell_threshold?: number;
  policy: WorkbenchPolicy;
  stop?: WorkbenchStop | null;
  initial_capital?: number;
  fee: WorkbenchFee;
}

/** 钉住槽位（config.slots 项；submit 时快照 strategy_id/version/sha256，params 按 schema 缺省填充） */
export interface WorkbenchPinnedSlot {
  strategy_id: string;
  version_id: string;
  version: number;
  sha256: string;
  params: Record<string, number>;
  weight: number;
}

/** 钉住配置快照（strategy_run.config / strategy_preset.config / POST presets/{id}/apply 返回形状） */
export interface WorkbenchRunConfig {
  slots: WorkbenchPinnedSlot[];
  buy_threshold: number;
  sell_threshold: number;
  policy: WorkbenchPolicy;
  stop: WorkbenchStop | null;
  initial_capital: number;
  fee: WorkbenchFee;
}

/** StrategyRunView（strategy_run 轻量行；结果不内联，经 result 端点单独取） */
export interface WorkbenchRunView {
  id: string; // sr_ 前缀
  name: string;
  symbol: string;
  period: string; // M1/M5/M15/D1
  from_ts: string; // RFC3339
  to_ts: string;
  config: WorkbenchRunConfig;
  status: WorkbenchRunStatus;
  progress: number; // 0..1
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** per_bar 单 slot 评分（score 恒有值——插件错误 bar 记中立 50，error 字段携带错误文本） */
export interface WorkbenchBarScore {
  slot_idx: number;
  score: number;
  error?: string;
}

/** per_bar 订单意图（OrderIntent serde；次 bar open 成交——Intrabar 止损除外） */
export interface WorkbenchOrderIntent {
  side: 'Buy' | 'Sell';
  qty: number;
  reason: 'Policy' | 'StopTrigger' | 'ForceClose';
}

/** per_bar 事件（bar_record_json 投影：插件错误/熔断/插件 log/成交） */
export type WorkbenchEngineEvent =
  | { type: 'plugin_error'; slot_idx: number; sha256: string; bar_index: number; error: string }
  | { type: 'circuit_breaker'; slot_idx: number; sha256: string; bar_index: number }
  | { type: 'plugin_log'; slot_idx: number; bar_index: number; message: string }
  | { type: 'fill'; bar_index: number; side: 'Buy' | 'Sell'; qty: number; price: number; reason: 'Policy' | 'StopTrigger' | 'ForceClose' };

/** per_bar 全量记录（ADR §13.4；UI 端抽样渲染，后端不做有损预处理） */
export interface WorkbenchBarRecord {
  ts: number; // Unix 秒
  scores: WorkbenchBarScore[];
  aggregate: number;
  signal: 'Buy' | 'Sell' | 'Hold';
  orders: WorkbenchOrderIntent[];
  events: WorkbenchEngineEvent[];
}

/** 8 项绩效（backtest::BacktestMetrics serde 形状，与既有 Metrics 同构） */
export type WorkbenchMetrics = Metrics;

/** StrategyRunResult（GET /api/workbench/runs/{id}/result；五 jsonb 列聚合） */
export interface WorkbenchRunResult {
  per_bar: WorkbenchBarRecord[];
  trades: Trade[];
  net_value: Array<[number, number]>; // [ts_unix_sec, equity]
  drawdown: Array<[number, number]>; // [ts_unix_sec, dd]
  metrics: WorkbenchMetrics;
}

/** CompareItem（POST /api/workbench/runs/compare；输入序，未知/未成功 run 被后端跳过） */
export interface WorkbenchCompareItem {
  run_id: string;
  name: string;
  symbol: string;
  period: string;
  net_value: Array<[number, number]>;
  metrics: WorkbenchMetrics;
}

/** StrategyPresetRow（组合预设；config 为钉住形态） */
export interface WorkbenchPresetRow {
  id: string; // sp_ 前缀
  name: string;
  config: WorkbenchRunConfig;
  created_at: string;
  updated_at: string;
}

/** 预设 create/update 的 config 入参（未钉住形态：后端 validate_preset_config 校验+钉住，
 *  slots 仅需 {version_id, params?, weight}；WorkbenchRunConfig（钉住形态）可直接赋给本类型）。 */
export interface WorkbenchPresetConfigInput {
  slots: WorkbenchSlotReq[];
  buy_threshold?: number;
  sell_threshold?: number;
  policy: WorkbenchPolicy;
  stop?: WorkbenchStop | null;
  initial_capital?: number;
  fee: WorkbenchFee;
}
