// API 契约类型（09-frontend.md §5；Phase C 起以 07-app-plane §1.1 真实后端契约为事实源）
// Period / GridMode / SymbolSnapshot 由 tangle 骨架（DashboardGrid）持有，此处再导出避免双事实源
export type { Period, GridMode, SymbolSnapshot } from '@/layouts/DashboardGrid';
export type { DetailRange } from '@/layouts/SourcesGrid';
export type { Settlement, FormMode, SymbolFormValues } from '@/layouts/SymbolsGrid';
// ADR-024 P0 §5.1：回测周期白名单的**前端镜像常量/类型**（单一事实源，见该文件注释）。
// 回测周期与看板读源周期（上方 `Period`）不同源，不得混用。
import { SUPPORTED_BACKTEST_PERIODS, type BacktestPeriod } from '@/features/backtest/periods';
export { SUPPORTED_BACKTEST_PERIODS };
export type { BacktestPeriod };

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

/** GET/PUT /api/config/kline 响应/请求体：K线默认视口（app_config key "kline"，迁移 0021；缺省 120）。
 *  单位 = **K 线根数**（ADR-020：与周期无关，同一值在任意周期都表示可见 N 根；30..=600 整数）；
 *  主图+宫格应用同一值，回测弹窗固定 SCOPED_VIEWPORT_BARS=120（不读配置）。 */
export interface KlineConfigDto {
  viewport_bars: number;
}

/** GET/PUT /api/config/dcap 响应/请求体：dcap 指标显示参数（**8 个，不含 `th`**；app_config key "dcap"，迁移 0021）。
 *  范围（design/14-dcap-indicator/02-spec.md §2）与跨字段约束 `n_s < n_m < n_l`：
 *  PUT 违反 → 400；GET 无键/坏 JSON/越界旧值 → 回默认 8/26/60/1/1/1/1/3（不 500）。 */
export interface DcapConfigDto {
  n_s: number;
  n_m: number;
  n_l: number;
  r_s: number;
  r_m: number;
  r_l: number;
  smooth: number;
  m: number;
}

/** GET/PUT /api/config/multi_period 响应/请求体：多周期指标同显配置（ADR-022 / design/15-multi-period/02-spec.md §2）。
 *  `periods[0]` = 基准（K 线）周期，其后 = 卫星指标周期（≤4、不含 `1mo`、卫星 ≥ 基准、含 `1w` 时基准 ≥ `1d`）；
 *  `heights` 键与 `periods` 一一对应（[80,1200] px）；`indicators` ⊆ {`dcap`}（首版）。
 *  PUT 违反 → 400；GET 无键/坏 JSON/越界旧值 → 回默认 `enabled=false` + 单基准 + 高度 420 + `["dcap"]`（不 500）。 */
export interface MultiPeriodConfigDto {
  enabled: boolean;
  periods: string[];
  heights: Record<string, number>;
  indicators: string[];
}

// ── 回测/模拟实盘共享读模型（P4b：旧页面⑤ DTO 已退役；Metrics/Trade 为 ensemble 引擎
//    backtest::BacktestMetrics / backtest::TradeDetail 的 jsonb 形态，页面⑪ 工作台与⑨ sim-live 沿用）──

/** 8 项绩效指标（BacktestMetrics jsonb；口径 08-backtest §6 单测锁定）。
 *  ⚠ `profit_factor` 可为 `null`：JSON 无法表达 ∞（区间内无亏损）⇒ 后端回 null，前端显「∞（无亏损）」。 */
export interface Metrics {
  net_profit: number;
  max_drawdown: number;
  sharpe: number;
  win_rate: number;
  profit_factor: number | null;
  annualized_return: number;
  trade_count: number;
  avg_hold_bars: number;
}

/**
 * 回合状态（ADR-027 D7）：回测侧恒 `Closed`（期末强平终结最后一个回合）；
 * sim-live 未平仓回合为 `Open`（**禁止**伪造成交；`pnl` 恒 null）。
 */
export type RoundTripStatus = 'Open' | 'Closed';

/**
 * L1：**回合**（`design/17-trade-detail-layering/02-spec.md` §1.2；Rust `backtest::TradeDetail`）。
 *
 * 口径（02-spec §2，全回合口径；**非**端点口径）：
 * - `gross_value` = Σ_sell `trade_value`；`pnl` = proceeds − invested（整回合现金流差，无成本分摊/FIFO）；
 * - `invested` = Σ_buy (`trade_value` + `commission`)；`proceeds` = Σ_sell (`trade_value` − `commission` − `stamp_duty`)；
 * - `open_price`/`close_price` = 加权**有效价（不含费）**（`close_price` 无卖出 ⇒ null，**禁止**造 0）。
 *
 * 懒加载摘要（D8）：`l2_count`/`buy_count`/`sell_count` 由 L1 行携带，展开时才按 `rt_seq` 拉 L2 分页切片。
 */
export interface RoundTrip {
  /** 回合序号（ADR-027 D6，per `(run|session, code)` 从 1 单调递增）。 */
  rt_seq: number;
  /** 标的（sim-live 多标的必需；回测填 run 的 symbol）。 */
  code: string;
  status: RoundTripStatus;
  open_ts: number;
  /** `Open` 回合 ⇒ null（**禁止**造数）。 */
  close_ts: number | null;
  open_bar: number;
  close_bar: number | null;
  shares: number;
  buy_count: number;
  sell_count: number;
  /** 加权有效买价（**不含费**）= Σ_buy trade_value / Σ_buy qty。 */
  open_price: number;
  /** 加权有效卖价（**不含费**）；无任何卖出 ⇒ null。 */
  close_price: number | null;
  gross_value: number;
  /** Σ 买入佣金 + Σ 卖出佣金。 */
  commission: number;
  /** Σ 卖出印花税。 */
  stamp_duty: number;
  /** `Closed` ⇒ 精确值；`Open` ⇒ null。 */
  pnl: number | null;
  hold_bars: number | null;
  /** ADR-026 §2.3：清仓那一笔的来源（新 run 引擎写入；历史 run 缺字段 ⇒ 未记录）。
   *  取值为 {@link FillReason}（sim-live 人工来源 = `Manual`）；后端为 `Option<String>`。 */
  reason?: FillReason | null;
  /** 本回合成交笔数（= L2 分页 `total`；供 D8 懒加载摘要）。 */
  l2_count: number;
}

/**
 * L2：**一笔成交事实**（`design/17-trade-detail-layering/02-spec.md` §1.1；Rust `backtest::FillFact`）。
 *
 * 费用三件套（`trade_value`/`commission`/`stamp_duty`）由**撮合点写入**，前端**禁止**由
 * `(side, qty, price)` + 费率复算（ADR-027 D4 / §1 F10：最低佣金分支先减后除不可逆）。
 * `avg_price_excl_fee` / `avg_cost_incl_fee` / `cum_*` 为 UI 侧的**逐笔累计派生**（ADR-027 D9 口径，
 * 见 `features/workbench/roundTripAccum.ts` 的公式注），不新增后端字段。
 */
export interface RoundTripFill {
  rt_seq: number;
  code: string;
  /** **真实 bar 序号**（禁 ts/bar_sec 反算）。 */
  bar_index: number;
  ts: number;
  side: 'Buy' | 'Sell';
  qty: number;
  /** 成交有效价（含滑点）。 */
  price: number;
  /** = qty × price（引擎实算值）。 */
  trade_value: number;
  commission: number;
  /** 买入恒 0。 */
  stamp_duty: number;
  reason: FillReason;
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
  /** P4a：会话事件流（插件错误/熔断告警，最近 50 条；无事件 → 空数组） */
  session_events?: SimSessionEvent[];
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
  config?: SimPinnedConfig | null;
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

/** POST /api/sim-live/sessions/{id}/backtest-compare 响应
 * （P4a 口径变化：统一 ensemble 引擎，run_ids 为 sr_ 前缀字符串） */
export interface SimBacktestCompare {
  session_id: string;
  session_result: SimSessionDetail['result'];
  run_ids: string[];
}

/** 单策略配置输入（⚠️ P4a 破坏性 wire 变更：strategy_id = Registry 策略 id（st_ 前缀，
 * 旧内建 id 不再接受）；params 按版本 params_schema，缺省填充） */
export interface SimStrategyConfigInput {
  strategy_id: string;
  /** 钉住版本 id（sv_ 前缀；缺省 = 最新 published） */
  version_id?: string;
  /** 策略参数（数值；缺省 → 版本 schema 默认值） */
  params?: Record<string, number | string>;
  /** 该策略实时评估的标的子集（须非空 ≤30） */
  stocks: string[];
  /** 策略级聚合权重（>0，缺省 1.0） */
  weight?: number;
  /** 按标的覆盖权重（策略×股票级）；未指定某股 → 用 weight */
  stock_weights?: Record<string, number>;
}

/** 钉住策略配置（GET /api/sim-live/strategies 的 config 槽；P4a：Registry 钉住快照） */
export interface SimPinnedConfig {
  version_id: string;
  version: number;
  sha256: string;
  params?: Record<string, number | string>;
  stocks: string[];
  weight?: number;
  stock_weights?: Record<string, number>;
}

/** 会话事件（P4a：插件错误/熔断告警；state 响应附最近 50 条） */
export type SimSessionEvent =
  | { type: 'plugin_error'; ts: number; code: string; strategy_id: string; sha256: string; bar_index: number; error: string }
  | { type: 'circuit_breaker'; ts: number; code: string; strategy_id: string; sha256: string; bar_index: number };

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
  /** 可删除标记（裁决 2026-09-10）：全部版本 draft 或无版本 → true；任何版本曾为 published（含已归档）→ false */
  deletable: boolean;
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
  period: BacktestPeriod;
  from: string; // RFC3339
  to: string; // RFC3339
  mode: StrategyTestMode;
  /** ADR-024 P5 §3.1.1：资源护栏二次确认（预估 bar 数 ≥ 阈值时需 `true` 重提放行）；
   *  与后端 `TestRunReq.confirm` 同语义（缺省 false）。 */
  confirm?: boolean;
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

/**
 * 试算/回测响应侧 `fee` 的回显形状（ADR-019 D11 两段显式形状；**不是**钉住 config 的扁平 fee）。
 * 形状来源（后端 = 事实源）：`crates/application/src/fee.rs::resolved_fee_to_json`。
 * 设计事实源：`design/07-app-plane/01-mcp.md` 的「⚠️ WIRE 变更（ADR-019 D11）」段——
 * `effective` = 引擎**实际应用**参数 + `source`；`profile` = 解析到的档案**全量事实** +
 * `not_modeled`（经手费/证管费/过户费：入库但引擎未建模，显式标注以免被误读为已计入成本）。
 * 零运行时影响：本批仅补类型声明（无消费者、无 mock 改动）。
 */
export interface ResolvedFee {
  /** 引擎实际应用参数（任何未参与撮合的档案字段**不得**出现在此段）。 */
  effective: {
    commission_rate_pct: number;
    min_fee: number;
    stamp_duty_pct: number;
    slippage_bp: number;
    source: 'explicit' | 'profile' | 'default';
  };
  /** 档案全量事实 + `not_modeled`；**未解析到档案时后端不输出该段**（故可选）。 */
  profile?: {
    type: string;
    commission_rate_pct: number;
    min_fee: number;
    exchange_fee_pct: number;
    regulatory_fee_pct: number;
    stamp_duty_pct: number;
    transfer_fee_pct: number;
    note: string;
    source: string;
    /** 档案数值费率键 − 引擎已消费字段（升序）；始终存在（schema 稳定）。 */
    not_modeled: string[];
  };
  /** 解析到的标的类型（`symbols.type`）；未解析 = null。 */
  symbol_type: string | null;
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
  /** 响应回显的生效费用（两段形状，见 {@link ResolvedFee}）；旧 fixture/后端省略时可缺。 */
  fee?: ResolvedFee;
  // ── ADR-024 P5 §3.1：试算同口径（去档 + 收缩回显 + 均匀抽样标记）──
  /** 评分/信号序列是否经**均匀抽样**（保首尾）；旧后端可缺。 */
  downsampled?: boolean;
  /** 抽样前原始评分数；旧后端可缺。 */
  original_points?: number;
  requested_from?: string;
  requested_to?: string;
  effective_from?: string;
  effective_to?: string;
  clamped?: boolean;
  clamp_reason?: string | null;
  estimated_bars?: number | null;
}

/** ADR-024 §3.1.1 结构化错误体 `{error:{code,message,detail}}` 的 detail（部分字段）。 */
export interface ApiErrorDetail {
  symbol?: string;
  period?: string;
  requested_from?: string;
  requested_to?: string;
  available_from?: string | null;
  available_to?: string | null;
  requested_bars?: number;
  limit_bars?: number;
  confirm_bars?: number;
  estimated_secs?: number;
  confirmable?: boolean;
  [k: string]: unknown;
}

/** 后端错误线格式 `{error: string}`（旧）或 `{error:{code,message,detail}}`（ADR-024 P5 结构化）→ 前端 ApiError。
 *  结构化错误可被**编程**消费：`e.code`/`e.detail`（如 range_empty 展示可用区间、resource_guard 走二次确认）。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public detail?: ApiErrorDetail,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `GET /api/workbench/available_range`（ADR-024 P5 §5.2）：日期控件 min/max 联动数据源。 */
export interface WorkbenchAvailableRange {
  symbol: string;
  period: string;
  available_from: string | null;
  available_to: string | null;
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

/** ADR-029 D3：`exposure` **目标**维的卖出侧口径。
 *  - `Flat`：`score ≤ sell_threshold` ⇒ 目标 0（清仓）；
 *  - `Scaled`：对称降档 —— `score=0 ⇒ 0`，`score=sell_threshold ⇒ at_threshold_pct`（同一斜率映射）。 */
export type ExposureSellPolicy = 'Flat' | 'Scaled';

/** ADR-029 D3：`exposure.target` 目标维（serde 外部标签；**无 rename**）。
 *  - `Fixed`：常数目标（= 现行 `LumpSum` 的目标语义；`score ≤ sell_threshold` ⇒ 目标 0）；
 *  - `ScoreMapped`：目标随聚合分**线性**变化（`score=buy_threshold ⇒ at_threshold_pct`、`score=100 ⇒ at_full_pct`）；
 *    中立带（`sell_threshold < score < buy_threshold`）⇒ 保持上一目标。
 *  量纲：`pct` / `at_*_pct` 均为**净值占比**（0..1）。 */
export type ExposureTarget =
  | { Fixed: { pct: number } }
  | { ScoreMapped: { at_threshold_pct: number; at_full_pct: number; sell: ExposureSellPolicy } };

/** ADR-029 D4：`ramp` **到达方式**维（Step 1 仅两个基元）。
 *  - `Immediate`：当 bar 目标即全额（= 现行 `LumpSum` 的路径）；serde 单元变体 ⇒ 载荷为 `null`；
 *  - `RateCap`：每 bar 目标变动上限 `pct_per_bar`（量纲 = 每 bar 允许变动**金额 / 净值**）。 */
export type ExposureRamp = { Immediate: null } | { RateCap: { pct_per_bar: number } };

/** ADR-029 D5/D8：`guard` **硬边界**维。
 *  `max_pct` 强制夹取（策略无权覆盖）、`min_pct` 下限、`deadzone_pct` 死区
 *  （`|目标 − 当前暴露| < deadzone_pct` ⇒ 不下单；量纲 = **暴露比例差**，与 `position_ratio` 同量纲）。 */
export interface ExposureGuardSpec {
  max_pct: number;
  min_pct: number;
  deadzone_pct: number;
}

/** ADR-029 D3–D5：`ExecutionPolicy::Exposure` 直通 JSON 形状（`target` × `ramp` × `guard`）。 */
export interface ExposurePolicySpec {
  target: ExposureTarget;
  ramp: ExposureRamp;
  guard: ExposureGuardSpec;
}

/** ExecutionPolicy serde 外部标签形态（strategy-core policy.rs）。
 *  ADR-029 D2：`LumpSum`/`Dca` 为 **legacy 只读**变体（逐字节不变）；`Exposure` 为 Step 1 新增变体。 */
export type WorkbenchPolicy =
  | { LumpSum: { position_pct: number } }
  | { Dca: { tranches: number; mode: 'Equal' | 'FixedAmount'; amount?: number | null; interval: number } }
  | { Exposure: ExposurePolicySpec };

/** StopConfig serde 形态（strategy-core stop.rs；trigger 缺省 Intrabar） */
export interface WorkbenchStop {
  kind: 'FixedPct' | 'Trailing' | 'Atr';
  value: number;
  trigger?: 'Intrabar' | 'CloseBasis';
}

/** fee 形状（web 层 validate_backtest_fee 三键入参；钉住 config 落库为 `fee_model_to_json` **4 键**，
 * 第 4 键 `stamp_duty_pct` 由后端按标的 type 解析后钉入，前端不读写 → 声明为可选。 */
export interface WorkbenchFee {
  rate_pct: number;
  min_fee: number;
  slippage_bp: number;
  /** 钉住 config 的落地形态含该键（`fee_model_to_json`）；入参三键可省。 */
  stamp_duty_pct?: number;
}

/** POST /api/workbench/runs body（from/to RFC3339；buy/sell_threshold、initial_capital、stop 可省） */
export interface WorkbenchSubmitReq {
  name?: string;
  symbol: string;
  period: string; // M1/M5/M15/M30/H1/D1（ADR-024 P0：单一事实源见 SUPPORTED_BACKTEST_PERIODS）
  from: string;
  to: string;
  slots: WorkbenchSlotReq[];
  buy_threshold?: number;
  sell_threshold?: number;
  policy: WorkbenchPolicy;
  stop?: WorkbenchStop | null;
  initial_capital?: number;
  fee: WorkbenchFee;
  /** ADR-024 P5 §3.1.1：资源护栏二次确认（预估 bar 数 ≥ 阈值时需 `true` 重提放行）。 */
  confirm?: boolean;
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
  /** I-2/D6 **预热段**请求根数（后端 config 快照；旧 run 可缺 ⇒ 容差消费）。
   *  预热段：引擎仍逐 bar 评分（`per_bar.warmup=true`）但**不执行 Policy/不产订单/不计净值与绩效**。 */
  warmup_requested?: number;
  /** I-2/D6 实际生效的预热根数（< 请求值 = 历史不足）。评估段裁剪的**精确根数**依据（ADR-028 D2.4）。 */
  warmup_effective?: number;
}

/** StrategyRunView（strategy_run 轻量行；结果不内联，经 result 端点单独取） */
export interface WorkbenchRunView {
  id: string; // sr_ 前缀
  name: string;
  symbol: string;
  period: string; // M1/M5/M15/M30/H1/D1（ADR-024 P0）
  from_ts: string; // RFC3339 —— **生效**区间起（收缩后）
  to_ts: string; // **生效**区间止（收缩后）
  config: WorkbenchRunConfig;
  status: WorkbenchRunStatus;
  progress: number; // 0..1
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  // ── ADR-024 P5 §3.1：收缩/预估回显（旧后端可缺 ⇒ 容差消费）──
  /** 用户**原始**请求区间起（收缩前）。 */
  requested_from?: string;
  requested_to?: string;
  /** effective != requested。 */
  clamped?: boolean;
  /** `"data_range"` | null。 */
  clamp_reason?: string | null;
  /** 提交时 `count(*)` 预扫描的 bar 数（降级 = null）。 */
  estimated_bars?: number | null;
  /** 执行后精确 bar 数（P4：由 /brief 提供；run 行可缺）。 */
  bars_total?: number | null;
  /** 结果存储格式（P4：由 /brief/result 提供；run 行可缺）。 */
  result_format?: WorkbenchResultFormat | null;
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

/** per_bar 事件（bar_record_json 投影：插件错误/熔断/插件 log/成交）。
 *  `fill` 携带引擎成交时刻写入的**全部事实**（ADR-027 D4：`rt_seq` + 费用三件套），
 *  使 legacy（内联列）路径与 `/fills` 路径同源同口径、无下游复算。 */
export type WorkbenchEngineEvent =
  | { type: 'plugin_error'; slot_idx: number; sha256: string; bar_index: number; error: string }
  | { type: 'circuit_breaker'; slot_idx: number; sha256: string; bar_index: number }
  | { type: 'plugin_log'; slot_idx: number; bar_index: number; message: string }
  | {
      type: 'fill';
      bar_index: number;
      side: 'Buy' | 'Sell';
      qty: number;
      price: number;
      reason: FillReason;
      rt_seq: number;
      trade_value: number;
      commission: number;
      stamp_duty: number;
    };

/** per_bar 全量记录（ADR §13.4；UI 端抽样渲染，后端不做有损预处理） */
export interface WorkbenchBarRecord {
  ts: number; // Unix 秒
  scores: WorkbenchBarScore[];
  aggregate: number;
  signal: 'Buy' | 'Sell' | 'Hold';
  orders: WorkbenchOrderIntent[];
  events: WorkbenchEngineEvent[];
  // ── ADR-029 D7/E10：`Exposure` 模式的逐 bar 观测（Step 1 Rust 车道就绪后出现；旧 run / 旧变体缺省）──
  /** 目标暴露（净值占比 0..1，已含 `guard.max_pct` 夹取后的取值）。 */
  target_pct?: number;
  /** 当前实际暴露（净值占比 0..1）。 */
  current_pct?: number;
  /** 本 bar 因 `guard.deadzone_pct` 死区**未下单**。 */
  deadzone_blocked?: boolean;
  /** 本 bar 目标被 `guard.max_pct` 强制夹取。 */
  clamped_by_guard?: boolean;
}

/** 8 项绩效（backtest::BacktestMetrics serde 形状，与既有 Metrics 同构） */
export type WorkbenchMetrics = Metrics;

/** 结果存储格式判别列（ADR-024 D8 / §3.2）：后端以它判别读取路径。
 *  `legacy_single` = `/result` 内联三列全量（旧 run，双读不回填）；
 *  `chunked_v1` = 数据在 `strategy_run_bars` 分块（图表走 `/curve`、明细走 `/bars`、成交走 `/fills`）。 */
export type WorkbenchResultFormat = 'legacy_single' | 'chunked_v1';

/** 完全平仓回合的来源（ADR-026 §2.3 = `TradeDetail.reason`；引擎写入清仓那一笔的来源）。
 *  `Policy` = 策略信号正常平仓 / `StopTrigger` = 止损触发 / `ForceClose` = 期末强平。
 *  历史 run（ADR-026 之前）该字段缺失 ⇒ 前端显示「未记录」（**不**反推、**不**伪造）。 */
export type TradeReason = 'Policy' | 'StopTrigger' | 'ForceClose';

/** 成交来源（ADR-027 §1.1 `FillReason` 四值）：在 `TradeReason` 之外增 `Manual`（sim-live 人工/外部来源）。 */
export type FillReason = TradeReason | 'Manual';

/** `/curve` 可抽样 kind（ADR-027 §4.1/§4.2：`position` 为点形状持仓序列，**非**事实源、可抽样）。 */
export type CurveKind = 'per_bar' | 'net_value' | 'drawdown' | 'position';

/** 持仓序列点（`kind=position`；口径冻结见 02-spec §4.2）：
 *  `position_ratio = position_value / nav`（`nav ≤ 0` ⇒ 0，UI 并列 `cash_ratio = 1 − position_ratio`）。
 *  **消歧**：本比率（时点市值/时点净值）≠ `deployed_pct`/`cash_consumed_pct`（区间累计/初始资金）。 */
export interface WorkbenchPositionPoint {
  ts: number;
  qty: number;
  position_value: number;
  cash: number;
  nav: number;
  position_ratio: number;
}

/** GET /api/workbench/runs/{id}/brief（轻量摘要；列表/轮询用，避免拉大包）。
 *  P5 字段（effective_from·effective_to·clamped·estimated_bars）在 P4 为先占位真值，前端只读展示不推导。 */
export interface WorkbenchResultBrief {
  id: string;
  name: string;
  symbol: string;
  period: string;
  status: WorkbenchRunStatus;
  progress: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  requested_from: string;
  requested_to: string;
  effective_from: string;
  effective_to: string;
  clamped: boolean;
  estimated_bars: number | null;
  /** per_bar 总根数（chunked = 分块推得；legacy = 内联长度）。 */
  bars_total: number;
  /** legacy_single | chunked_v1；无结果行为 null。 */
  result_format: WorkbenchResultFormat | null;
  /** per_bar 分块数（legacy = 0）。 */
  chunk_count: number;
  metrics: WorkbenchMetrics | null;
}

/** 显式抽样曲线（`GET …/curve`）：`downsampled`/`original_bars` 必带（ADR-024 D10）。
 *  ⚠ 后端**不做隐式/未标注的有损**：凡 `downsampled=true`，UI 必须显式标注抽样点数与原始根数。 */
export interface WorkbenchCurveResponse<T = unknown> {
  kind: CurveKind;
  points: T[];
  downsampled: boolean;
  original_bars: number;
  k: number;
  /** 窗口回显（ADR-028 D3；缺省无窗口 = 全区间 ⇒ null）。 */
  window_from_ts: number | null;
  window_to_ts: number | null;
  /** 窗口内**原始**根数（抽样前）—— 采样的分母（`original_bars` = 全区间分母）。 */
  window_bars: number;
}

/** `GET /api/workbench/runs/{id}/round-trips`（ADR-027 §5.2，L1 懒加载首屏）。
 *  完整性契约（D11）：`total` + `recorded` + `has_more`/`next_offset` 齐备，UI **不得**静默截断。 */
export interface WorkbenchRoundTripsResponse {
  run_id: string;
  total: number;
  recorded: boolean;
  has_more: boolean;
  next_offset: number | null;
  round_trips: RoundTrip[];
}

/** `GET /api/workbench/runs/{id}/round-trips/{rt_seq}/fills`（ADR-027 §5.3，L2 切片）。
 *  未知 `rt_seq` ⇒ 404（**禁止**空数组冒充「无成交」）。 */
export interface WorkbenchRoundTripFillsResponse {
  run_id: string;
  rt_seq: number;
  total: number;
  has_more: boolean;
  next_offset: number | null;
  fills: RoundTripFill[];
}

/** `GET …/bars`（分页或区间读）：`has_more`/`next_offset` 必须被消费（D9 禁静默截断）。 */
export interface WorkbenchBarsResponse {
  kind: string;
  bars: WorkbenchBarRecord[];
  total: number;
  has_more: boolean;
  next_offset: number | null;
  /** 序号分页回声（区间读为 0）。 */
  offset: number;
  limit: number;
  /** 区间读回声（序号分页缺省）。 */
  from?: string;
  to?: string;
}

/** 成交明细条目（`EngineEvent::Fill` 投影 + 所在 bar 的 ts，K 线标记锚点）。
 *
 * 口径注（ADR-027 §5.4，v2）：`rt_seq`/`trade_value`/`commission`/`stamp_duty` 为**引擎撮合点写入的事实**，
 * 前端**禁止**由 `(side, qty, price)` + 费率复算（最低佣金分支不可逆，复算不保证逐位相等）。
 * 注：后端 `/fills` 元素实际还含 `code`（读径注入 = run 的 symbol，与 L2 切片同一事实源）；
 * 本类型保持 `02-spec` §7 的最小增量集，多余键被忽略——若 UI 需消费 `code`，须先改 `02-spec` §7。 */
export interface WorkbenchRunFill {
  type: 'fill';
  bar_index: number;
  /** 所在 bar 的 epoch 秒（K 线标记锚定用）。 */
  ts: number;
  side: 'Buy' | 'Sell';
  qty: number;
  price: number;
  reason: FillReason;
  /** ADR-027 §5.4：归属键 + 费用三件套（引擎事实，前端**禁止**复算）。 */
  rt_seq: number;
  trade_value: number;
  commission: number;
  stamp_duty: number;
}

/** `GET …/fills`（成交明细分页读；ADR-024 P6 有界精确源，**禁止抽样**）。
 *  K 线买卖标记的**唯一**数据源（不用 `trades`：`TradeDetail` 仅完全平仓时合成
 *  ⇒ 部分买入/加仓与部分卖出不进 `trades`）。 */
export interface WorkbenchFillsResponse {
  run_id: string;
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  /** `false` = 该 chunked run 无 fills 块（「未写」，与「无成交」`true`+`total=0` 可区分）。 */
  recorded: boolean;
  fills: WorkbenchRunFill[];
}

/** 执行完整度审计的非阻断提示（ADR-026 §2.2；仅信息性，不改变引擎行为、不拒绝提交）。
 *  `code` ∈ {`DCA_PLAN_UNDERFILLED`, `PARTIAL_DEPLOYMENT`, `ORDERS_UNEXECUTED`}（判据常量集中后端）。 */
export interface WorkbenchAuditWarning {
  code: string;
  severity: 'info' | 'warn';
  message: string;
}

/**
 * 执行完整度审计（GET /api/workbench/runs/{id}/audit；ADR-026 §2.2 **冻结**契约，snake_case 直通，
 * 字段名以真实响应为事实源）。
 *
 * 口径消歧（ADR-026 §2.1，禁同物异名）：
 * - `deployed_*` = **敞口**（Σ buy 成交额，不含费用）；
 * - `cash_consumed*` = **资金占用**（敞口 + Σ buy 佣金）。
 *
 * `recorded=false` ⇒ 事实源缺失（per_bar.orders/events 与 fills 皆不可得）：其余数值均为 0、
 * `warnings` 为空 —— UI **必须**显「未记录」而**不得**把 0 读成「0% 投入」。
 */
export interface WorkbenchRunAudit {
  run_id: string;
  /** 事实源是否齐全（per_bar.orders/events 或 fills 可得）。 */
  recorded: boolean;
  /** 绩效分母口径（= run config initial_capital）。 */
  capital_basis: number;
  deployed_notional: number;
  deployed_pct: number;
  cash_consumed: number;
  cash_consumed_pct: number;
  /** 计划批数（仅 `Dca` 策略有值，其余 null）。 */
  planned_tranches: number | null;
  /** 区间内可达轮次（per_bar 的 Buy 意图数，含 warmup 段排除）。 */
  reachable_batches: number;
  /** 已成交买入批数（逐笔源 /fills）。 */
  batches_done: number;
  /** 未执行挂单 = 意图数 − 买入成交数（≥0）。 */
  unexecuted_orders: number;
  /** 末根 in-range bar 存在 Buy 意图（结构上无次 bar 可成交）。 */
  last_bar_unfilled: boolean;
  /** 完全平仓回合数（= `trades` 长度）。 */
  round_trips_total: number;
  /** 其中由期末强平合成的回合数（读侧派生，历史 run 亦可判）。 */
  round_trips_force_closed: number;
  /** ADR-027 §5.5：`Closed` 回合数（回测恒 = `round_trips_total`）。 */
  round_trips_closed: number;
  /** ADR-027 §5.5：`Open` 回合数（回测恒 0；sim-live 未平仓回合）。 */
  round_trips_open: number;
  /** ADR-027 §5.5 逐回合自洽（D10 告警源）：`mismatched` 非空 ⇒ UI **必须**显式告警。 */
  rt_reconcile: {
    checked: number;
    mismatched: number[];
    tolerance: number;
  };
  warnings: WorkbenchAuditWarning[];
}

/** StrategyRunResult（GET /api/workbench/runs/{id}/result；ADR-024 §3.2 **兼容** 形状）。
 *  `legacy_single` ⇒ 三列全量 + `has_more:false`；
 *  `chunked_v1` ⇒ `summary` + 首页 per_bar + `has_more` + `next_offset`（**显式**截断非静默），
 *  `net_value`/`drawdown` 为空（图表改走 `/curve`）。 */
export interface WorkbenchRunResult {
  /** 判别列：前端**必须**据此分流（禁止把占位 `net_value: []` 当数据）。 */
  result_format: WorkbenchResultFormat;
  /** chunked_v1 的轻量摘要（legacy 时为 null/缺省）。 */
  summary?: WorkbenchResultBrief | null;
  per_bar: WorkbenchBarRecord[];
  /** ADR-027 §5.1：`trades` 元素为 **L1 回合** v2 形状（全回合口径，非端点口径）。 */
  trades: RoundTrip[];
  net_value: Array<[number, number]>; // [ts_unix_sec, equity]
  drawdown: Array<[number, number]>; // [ts_unix_sec, dd]
  metrics: WorkbenchMetrics;
  /** chunked_v1：per_bar 是否还有更多页（**必须**消费，不得静默只显首页）。 */
  has_more?: boolean;
  next_offset?: number | null;
}

/** CompareItem（POST /api/workbench/runs/compare；输入序，未知/未成功 run 被后端跳过）。
 *  ADR-024 D9/D10：`net_value` 为**服务端抽样后**的曲线，`downsampled`/`original_bars` 必须回显。 */
export interface WorkbenchCompareItem {
  run_id: string;
  name: string;
  symbol: string;
  period: string;
  net_value: Array<[number, number]>;
  metrics: WorkbenchMetrics;
  /** 净值是否经服务端抽样（false = 全量）。 */
  downsampled: boolean;
  /** 抽样前净值点数（`downsampled=true` 时用于标注）。 */
  original_bars: number;
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
