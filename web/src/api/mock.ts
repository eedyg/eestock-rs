import type { ApiClient, KlineQuery, QualityCodeRangeQuery, QualityRangeQuery } from './client';
import type {
  AlertEventItem,
  AlertItem,
  AlertQuery,
  AlertRuleItem,
  AlertRulePatchBody,
  BacktestRunDto,
  BacktestStatus,
  BacktestStrategyDto,
  BacktestSubmitReq,
  BacktestSubmitResp,
  Bar,
  CollectorConfigSnapshot,
  DetailRange,
  DivergenceStat,
  McpConfigSnapshot,
  CollectorConfigPatchBody,
  McpConfigPatchBody,
  MetricPoint,
  Metrics,
  Period,
  PurgeRawResult,
  QualityDivergenceResponse,
  QualityDivergenceRow,
  QualityGapsResponse,
  RateLimitCounters,
  RegisterSymbolInput,
  ResetCircuitsResult,
  SourceAccuracyItem,
  SourceAccuracyResponse,
  SourceConfigItem,
  SourceConfigSnapshot,
  SourceEventItem,
  SourceHealthItem,
  SourcesHealth,
  SymbolPatchBody,
  SymbolRow,
  SymbolSnapshot,
  SystemInfo,
  Trade,
  TushareStatusResponse,
  BacktestNetValue,
  MaConfigDto,
  KlineConfigDto,
  SimBacktestCompare,
  SimCancelOrderReq,
  SimOrdersResp,
  SimPnlResp,
  SimPlaceOrderReq,
  SimPositionsResp,
  SimSession,
  SimSessionDetail,
  SimSessionListEntry,
  SimStartSessionReq,
  SimStateDto,
  SimStrategiesDto,
  SimStrategyConfigInput,
  SimStrategyScore,
  SimToggleReq,
  StrategyApprovalLevel,
  StrategyCatalogEntry,
  StrategyCreateReq,
  StrategyCreateResp,
  StrategyDiffResp,
  StrategyKind,
  StrategyManageItem,
  StrategyParamDef,
  StrategyPatchReq,
  StrategyRowDto,
  StrategyStatus,
  StrategyTestRunReq,
  StrategyTestRunResp,
  StrategyTradeDetail,
  StrategyUpdateOutcome,
  StrategyVersionRowDto,
  WorkbenchBarRecord,
  WorkbenchCompareItem,
  WorkbenchPinnedSlot,
  WorkbenchPresetRow,
  WorkbenchRunConfig,
  WorkbenchRunResult,
  WorkbenchRunStatus,
  WorkbenchRunView,
  WorkbenchSubmitReq,
} from './types';
import { ApiError } from './types';

/**
 * 手写契约 mock（09-frontend.md §4）：后端联调/测试用。
 * Phase C 起对齐 07-app-plane §1.1 真实线格式（snake_case 健康行、K线包络由 client 解）。
 * 确定性生成：同一 (code, period, ts) 恒得同一 bar，便于复现与分页测试。
 * 标的注册表有内部状态：register/update/disable 行为可在测试中闭环验证。
 */

const PERIOD_MS: Record<Period, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000, // 周线步长（约 7 天）
  '1mo': 30 * 86_400_000, // 月线步长（约 30 天）
};

const BASE_PRICE: Record<string, number> = {
  '518880': 2.4,
  '513310': 1.58,
  '161226': 0.98,
  '159776': 0.87,
};

function initialSymbols(): SymbolRow[] {
  return [
    { code: '518880', name: '黄金ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:23:00Z', last: 2.431, change_pct: 0.62 }, today_bars: 205, favorite: false, favorite_sort: null },
    { code: '513310', name: '纳指ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:23:00Z', last: 1.587, change_pct: -0.31 }, today_bars: 189, favorite: false, favorite_sort: null },
    { code: '161226', name: '白银LOF', interval_secs: 300, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:20:00Z', last: 0.982, change_pct: 1.15 }, today_bars: 41, favorite: false, favorite_sort: null },
    { code: '159776', name: '港股通医药', interval_secs: 60, settlement: 'T1', enabled: false, latest: null, today_bars: 0, favorite: false, favorite_sort: null },
  ];
}

/** 确定性伪随机 [0,1)：由 key 哈希驱动 */
function rand01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 行情看板 MA 默认窗口（GET /api/config/ma 表空/未初始化时兜底；与后端默认 [5,10,20] 同构） */
const DEFAULT_MA_WINDOWS: number[] = [5, 10, 20];

/** 行情看板 K线默认视口（GET /api/config/kline 无键/未初始化时兜底；与后端默认 2 交易日同构） */
const DEFAULT_KLINE_VIEWPORT_DAYS = 2;

/** K线默认视口校验（与后端 verify_kline_viewport_days 同构：整数 1-50）。  不合规抛 ApiError(400)。 */
function assertKlineViewportDays(viewportDays: number): void {
  if (!Number.isInteger(viewportDays) || viewportDays < 1 || viewportDays > 50) {
    throw new ApiError(400, `HTTP 400: viewport_days 须为 1..=50 整数，收到 ${viewportDays}`);
  }
}

/** MA 窗口校验 + 归一化（与后端 validate_ma_windows 同构：1-3 条、每条 1-500、去重升序）。
 *  不合规抛 ApiError(400)；归一化结果由 mock 内部状态保存并返回。 */
function normalizeMaWindows(windows: number[]): number[] {
  if (windows.length === 0) throw new ApiError(400, 'HTTP 400: MA 至少 1 条');
  if (windows.length > 3) throw new ApiError(400, 'HTTP 400: MA 最多 3 条');
  for (const w of windows) {
    if (!Number.isInteger(w) || w < 1 || w > 500) {
      throw new ApiError(400, `HTTP 400: MA 窗口须为 1..=500 整数，不合规值：${w}`);
    }
  }
  const seen = new Set<number>();
  for (const w of windows) if (!seen.has(w)) seen.add(w);
  return [...seen].sort((a, b) => a - b);
}

function makeBar(code: string, period: Period, ts: number): Bar {
  const base = BASE_PRICE[code] ?? 1;
  const r1 = rand01(`${code}:${period}:${ts}:o`);
  const r2 = rand01(`${code}:${period}:${ts}:c`);
  const r3 = rand01(`${code}:${period}:${ts}:h`);
  const r4 = rand01(`${code}:${period}:${ts}:l`);
  const open = round3(base * (1 + (r1 - 0.5) * 0.02));
  const close = round3(base * (1 + (r2 - 0.5) * 0.02));
  const high = round3(Math.max(open, close) * (1 + r3 * 0.005));
  const low = round3(Math.min(open, close) * (1 - r4 * 0.005));
  const volume = 1000 + Math.floor(r1 * 9000);
  return { ts: new Date(ts).toISOString(), open, high, low, close, volume, amount: Math.round(volume * close) };
}

function healthItem(
  source: string,
  status: SourceHealthItem['status'],
  overrides: Partial<SourceHealthItem> = {},
): SourceHealthItem {
  const circuit = status === 'circuit_open' ? 'open' : 'closed';
  return {
    source,
    window_secs: 3600,
    attempts: 60,
    successes: status === 'healthy' ? 60 : 55,
    success_rate: status === 'healthy' ? 1 : 0.915,
    p50_ms: status === 'healthy' ? 180 : 420,
    p95_ms: 900,
    circuit_state: circuit,
    status,
    last_error:
      status === 'healthy'
        ? null
        : { err_kind: status === 'circuit_open' ? 'http' : 'timeout', ts: '2026-09-04T02:18:00Z', code: null },
    last_event_ts: '2026-09-04T02:23:00Z',
    ...overrides,
  };
}

export interface MockOptions {
  now?: Date; // 测试注入固定时刻，保证可复现
  backtestRuns?: BacktestRunDto[]; // 测试注入固定 run 列表（否则用内置种子）
}

/** 页面⑦ mock 种子：与 preview/07-alerts.html 样例同构（critical/warning/info 各一） */
function initialAlertEvents(): AlertEventItem[] {
  return [
    { id: 3, rule_id: 'collection_stall', level: 'critical', source: 'collector',
      message: '采集停摆：交易时段连续 3 分钟无任何成功事件', status: 'triggered', fire_count: 1,
      first_fired_at: '2026-09-07T02:18:00Z', last_fired_at: '2026-09-07T02:18:00Z',
      acked_at: null, resolved_at: null },
    { id: 2, rule_id: 'symbol_gap_rate', level: 'warning', source: '513310',
      message: '513310 当日缺口率 7.8%（>1%）', status: 'triggered', fire_count: 4,
      first_fired_at: '2026-09-07T02:05:00Z', last_fired_at: '2026-09-07T02:35:00Z',
      acked_at: null, resolved_at: null },
    { id: 1, rule_id: 'source_success_rate', level: 'info', source: 'tencent_qt',
      message: '腾讯qt 恢复，回到轮转序列', status: 'acked', fire_count: 1,
      first_fired_at: '2026-09-07T01:47:00Z', last_fired_at: '2026-09-07T01:47:00Z',
      acked_at: '2026-09-07T01:50:00Z', resolved_at: null },
  ];
}

/** 内置规则首批种子（与迁移 0009 同口径） */
function initialAlertRules(): AlertRuleItem[] {
  return [
    { id: 'source_success_rate', name: '源成功率低于阈值', level: 'warning', threshold: 0.95, duration_minutes: 10, silence_minutes: 10, enabled: true },
    { id: 'symbol_gap_rate', name: '标的当日缺口率超阈', level: 'warning', threshold: 1, duration_minutes: 0, silence_minutes: 30, enabled: true },
    { id: 'collection_stall', name: '采集停摆（交易时段无成功事件）', level: 'critical', threshold: 3, duration_minutes: 0, silence_minutes: 10, enabled: true },
    { id: 'tushare_daily_sync', name: 'tushare 日增量失败', level: 'warning', threshold: 0, duration_minutes: 0, silence_minutes: 60, enabled: false },
  ];
}

// ── 页面⑤ 回测工作台（Wave 3 Phase 3c；契约 mock，与后端 07-app-plane/00-web-api.md §1.5 同构）──

/** 内置 7 款策略目录（id/name/description/params_schema；与 backtest::builtin_strategy_catalog 同构） */
function mockBacktestStrategies(): BacktestStrategyDto[] {
  const num = (
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    def: number,
  ) => ({ key, label, kind: { Num: { min, max, step, def } } });
  const posPct = () => num('position_pct', '仓位比例', 0, 1, 0.05, 1);
  return [
    {
      id: 'dual_ma',
      name: '双均线交叉',
      description: '快/慢均线金叉买入、死叉卖出',
      params_schema: [num('fast', '快线', 2, 200, 1, 5), num('slow', '慢线', 2, 250, 1, 20), posPct()],
    },
    {
      id: 'ma_rsi',
      name: '均线+RSI 过滤',
      description: '均线交叉定方向 + RSI 超买/超卖过滤',
      params_schema: [
        num('fast', '快线', 2, 200, 1, 5),
        num('slow', '慢线', 2, 250, 1, 20),
        num('rsi_period', 'RSI 周期', 2, 60, 1, 14),
        num('rsi_oversold', '超卖阈值', 10, 50, 1, 30),
        num('rsi_overbought', '超买阈值', 50, 90, 1, 70),
        posPct(),
      ],
    },
    {
      id: 'macd',
      name: 'MACD 金叉/死叉',
      description: 'DIF 上穿 DEA 金叉买入、下穿死叉卖出',
      params_schema: [
        num('fast', '快线', 2, 100, 1, 12),
        num('slow', '慢线', 2, 200, 1, 26),
        num('signal', '信号线', 2, 100, 1, 9),
        posPct(),
      ],
    },
    {
      id: 'boll',
      name: 'BOLL 带突破',
      description: '收破上轨买/下破下轨卖（趋势或均值回归，mode 参数）',
      params_schema: [
        num('period', '周期', 2, 200, 1, 20),
        num('k', '带宽 k', 0.5, 4, 0.1, 2),
        { key: 'mode', label: '模式', kind: { Choice: { options: ['mean_reversion', 'trend'], def: 'mean_reversion' } } },
        posPct(),
      ],
    },
    {
      id: 'kdj',
      name: 'KDJ 金叉/死叉',
      description: 'K 上穿 D 金叉买入、下穿死叉卖出',
      params_schema: [
        num('n', 'N', 2, 100, 1, 9),
        num('k_period', 'K 周期', 2, 30, 1, 3),
        num('d_period', 'D 周期', 2, 30, 1, 3),
        posPct(),
      ],
    },
    {
      id: 'momentum',
      name: '动量突破',
      description: 'close 突破 N 日高点买入、跌破 N 日低点卖出',
      params_schema: [num('lookback', '回看日', 2, 150, 1, 20), posPct()],
    },
    {
      id: 'atr_channel',
      name: 'ATR 通道突破',
      description: 'Donchian 通道突破买卖 + ATR 止损',
      params_schema: [
        num('channel_period', '通道周期', 2, 150, 1, 20),
        num('atr_period', 'ATR 周期', 2, 60, 1, 14),
        num('atr_multiplier', 'ATR 倍数', 0.5, 5, 0.5, 1),
        posPct(),
      ],
    },
  ];
}

/** 确定性净值/回撤序列（[ts_unix_sec, equity]；由 runId 哈希驱动，可复现）。 */
function mockBacktestNetValue(seed: string, anchorTs: number): BacktestNetValue {
  const INITIAL = 100_000;
  const series: Array<[number, number]> = [];
  const drawdown: Array<[number, number]> = [];
  const points = 120;
  let equity = INITIAL;
  let peak = INITIAL;
  for (let i = 0; i < points; i++) {
    const ts = anchorTs + i * 86_400; // 每日一根，120 天
    const r = rand01(`${seed}:eq:${i}`);
    equity = equity * (1 + (r - 0.47) * 0.04);
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    series.push([ts, round3(equity)]);
    drawdown.push([ts, round3(dd)]);
  }
  return { series, drawdown };
}

/** 确定性 8 项指标（与净值无关，契约 mock 定值；前端只读展示，口径由后端单测锁定）。 */
function mockBacktestMetrics(seed: string): Metrics {
  return {
    net_profit: round3(1000 + rand01(`${seed}:np`) * 6000),
    max_drawdown: round3(0.03 + rand01(`${seed}:dd`) * 0.08),
    sharpe: round3(0.8 + rand01(`${seed}:sh`) * 1.4),
    win_rate: round3(0.45 + rand01(`${seed}:wr`) * 0.25),
    profit_factor: round3(1.1 + rand01(`${seed}:pf`) * 1.4),
    annualized_return: round3(0.08 + rand01(`${seed}:ar`) * 0.4),
    trade_count: 20 + Math.floor(rand01(`${seed}:tc`) * 60),
    avg_hold_bars: round3(2 + rand01(`${seed}:ah`) * 30),
  };
}

/** 确定性交易明细（含盈亏/持仓时长；open/close_ts 为 Unix 秒）。 */
function mockBacktestTrades(seed: string, anchorTs: number): Trade[] {
  const n = 4;
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    const openTs = anchorTs + i * 12 * 86_400 + 9 * 3_600; // 每日 09:00 CST 起点
    const hold = 2 + Math.floor(rand01(`${seed}:h:${i}`) * 4);
    const openPrice = round3(1 + rand01(`${seed}:op:${i}`) * 3);
    const closePrice = round3(openPrice * (1 + (rand01(`${seed}:cp:${i}`) - 0.5) * 0.12));
    const shares = 1000 + Math.floor(rand01(`${seed}:sh:${i}`) * 9000);
    const pnl = Math.round((closePrice - openPrice) * shares);
    out.push({
      open_ts: openTs,
      close_ts: openTs + hold * 86_400,
      open_bar: i + 1,
      close_bar: i + 1 + hold,
      open_price: openPrice,
      close_price: closePrice,
      shares,
      gross_value: round3(closePrice * shares),
      commission: round3(5 + rand01(`${seed}:com:${i}`) * 10),
      stamp_duty: round3(closePrice * shares * 0.0005),
      pnl,
      hold_bars: hold,
    });
  }
  return out;
}

/** 解析「起:止:步长」→ 升序值（含止；后端 application::params::parse_range 同口径）。 */
function mockParseRange(s: string): number[] {
  const parts = s.split(':').map((x) => Number(x.trim()));
  const a = parts[0];
  const b = parts[1];
  const c = parts[2];
  if (a === undefined || b === undefined || c === undefined) return [];
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || c <= 0) return [];
  const out: number[] = [];
  for (let v = a; v <= b + 1e-9; v += c) out.push(v);
  return out;
}

/** 展开参数网格（base 参数 ∪ 网格键笛卡尔积；后端 application::params::expand_grid 同口径）。 */
function mockExpandGrid(
  base: Record<string, unknown>,
  grid: Record<string, string>,
): Array<Record<string, unknown>> {
  const keys = Object.entries(grid)
    .map(([k, range]) => [k, mockParseRange(range)] as const)
    .filter(([, vals]) => vals.length > 0);
  let results: Array<Record<string, unknown>> = [{ ...base }];
  for (const [k, vals] of keys) {
    const next: Array<Record<string, unknown>> = [];
    for (const r of results) {
      for (const v of vals) next.push({ ...r, [k]: v });
    }
    results = next;
  }
  return results;
}

/** 前端周期代码 → 后端口径（1m/5m/15m/1d → M1/M5/M15/D1）。 */
const BT_PERIOD_CODE: Record<string, string> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '1d': 'D1' };

/** 提交请求（前端契约）→ run 行（status 完成态；与后端 dto 同构）。 */
function makeDoneRun(req: BacktestSubmitReq, params: Record<string, unknown>, id: number, groupId: string | null, anchor: number): BacktestRunDto {
  const seed = `bt:${id}`;
  const created = new Date(anchor - 3_600_000).toISOString();
  return {
    id,
    code: req.code,
    period: BT_PERIOD_CODE[req.period] ?? 'D1',
    strategy_id: req.strategyId,
    params: params as Record<string, unknown>,
    fee: { rate_pct: req.fee.ratePct, min_fee: req.fee.minFee, slippage_bp: req.fee.slippageBp },
    status: 'done',
    progress: 100,
    current_ts: new Date(anchor).toISOString(),
    created_at: created,
    finished_at: new Date(anchor).toISOString(),
    error: null,
    group_id: groupId,
    net_value: mockBacktestNetValue(seed, anchor - 120 * 86_400),
    trades: mockBacktestTrades(seed, anchor - 120 * 86_400),
    metrics: mockBacktestMetrics(seed),
  };
}

/** 内置种子 run（done/running/pending/failed 各态，便于 task-list 三态可见；mock 内部分页/推进）。 */
function seedBacktestRuns(anchor: number): BacktestRunDto[] {
  const d = (id: number, over: Partial<BacktestRunDto>): BacktestRunDto => ({
    id,
    code: '518880',
    period: 'D1',
    strategy_id: 'dual_ma',
    params: { fast: 5, slow: 20 },
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    status: 'pending',
    progress: 0,
    current_ts: null,
    created_at: new Date(anchor - 3_600_000).toISOString(),
    finished_at: null,
    error: null,
    group_id: null,
    ...over,
  });
  return [
    d(11, {
      status: 'done',
      progress: 100,
      current_ts: new Date(anchor).toISOString(),
      finished_at: new Date(anchor).toISOString(),
      net_value: mockBacktestNetValue('bt:11', anchor - 120 * 86_400),
      trades: mockBacktestTrades('bt:11', anchor - 120 * 86_400),
      metrics: mockBacktestMetrics('bt:11'),
    }),
    d(12, {
      code: '513310',
      status: 'running',
      progress: 63,
      current_ts: new Date(anchor - 3600).toISOString(),
      group_id: 'g_seed_grid',
    }),
    d(13, { status: 'pending', code: '161226' }),
    d(14, { status: 'failed', code: '159776', error: '回测区间无 K 线 bar' }),
  ];
}

/** 轻列表：剥离结果列（net_value/trades/metrics）——列表行只需元数据+状态，结果仅 getRun。 */
function stripBacktestResult(r: BacktestRunDto): BacktestRunDto {
  const { net_value: _nv, trades: _t, metrics: _m, ...rest } = r;
  return rest;
}

/** 与后端同序：created_at DESC, id DESC（列表稳定分页）。
 *  backtestRuns 内部按插入序；排序后才 slice(offset, limit)。 */
function backtestSortDesc(a: BacktestRunDto, b: BacktestRunDto): number {
  const ca = a.created_at.localeCompare(b.created_at);
  if (ca !== 0) return -ca;
  return b.id - a.id;
}

// ── 页面⑩ 策略 Registry（12-strategy-system / P2b；契约 mock，与后端 §1.7 同构）──

/** 种子插件代码（dual_ma 参考插件语义缩略版；含 PARAMS_SCHEMA 供编辑器参数面板测试） */
const MOCK_DUAL_MA_CODE = `const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5, min: 1, max: 250, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" }
];

function init(params) {}

function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  if (fast === null || slow === null) return 50;
  return fast > slow ? 80 : 30;
}
`;

const MOCK_TEMPLATE_CODE = `const PARAMS_SCHEMA = [];

// 纯评分模板：不读 position 的最小骨架
function on_bar(ctx) {
  return 50;
}
`;

const MOCK_DUAL_MA_SCHEMA: StrategyParamDef[] = [
  { key: 'fast', type: 'int', default: 5, min: 1, max: 250, description: '快线周期' },
  { key: 'slow', type: 'int', default: 20, min: 2, max: 250, description: '慢线周期' },
];

/** 与后端同口径的内容哈希占位（mock 不做真 sha256；确定性即可）。 */
function mockSha(code: string): string {
  let h = 'sha_';
  for (let i = 0; i < 16; i++) h += '0123456789abcdef'[Math.floor(rand01(`${code}:${i}`) * 16)];
  return h;
}

/** 简易正则重解析 PARAMS_SCHEMA（与后端 extract_schema 对齐意图：保存时代码的 schema 声明即时生效）。
 *  后端是 QuickJS 实例化后读插件声明；mock 无法执行 JS，用正则提取 `PARAMS_SCHEMA = [...]` 字面量中的
 *  `{ key, type, default, min?, max?, description? }` 条目。**解析失败（无声明/无法识别）→ 空数组**（同后端 None→[] 落库语义）。 */
function mockExtractParamsSchema(code: string): StrategyParamDef[] {
  const m = /PARAMS_SCHEMA\s*=\s*\[([\s\S]*?)\]\s*;?/.exec(code);
  if (!m) return [];
  const body = m[1]!;
  const out: StrategyParamDef[] = [];
  const entryRe = /\{([^{}]*)\}/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(body)) !== null) {
    const fields = em[1]!;
    const str = (k: string): string | undefined => {
      const fm = new RegExp(`${k}\\s*:\\s*"([^"]*)"`).exec(fields);
      return fm?.[1];
    };
    const num = (k: string): number | undefined => {
      const fm = new RegExp(`${k}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(fields);
      return fm ? Number(fm[1]) : undefined;
    };
    const key = str('key');
    const type = str('type');
    const def = num('default');
    // 条目缺 key/type/default → 整体视为解析失败（返回空数组，与「解析失败置空」口径一致）
    if (key === undefined || (type !== 'int' && type !== 'float') || def === undefined) return [];
    const def0: StrategyParamDef = { key, type, default: def };
    const min = num('min');
    const max = num('max');
    const desc = str('description');
    if (min !== undefined) def0.min = min;
    if (max !== undefined) def0.max = max;
    if (desc !== undefined) def0.description = desc;
    out.push(def0);
  }
  return out;
}

/** 试算区间上限（与后端 application::strategy 同口径：D1 ≤ 366*5 天；分钟级 M1/M5/M15 ≤ 93 天）。 */
const MOCK_TESTRUN_D1_MAX_SPAN_DAYS = 366 * 5;
const MOCK_TESTRUN_MINUTE_MAX_SPAN_DAYS = 93;

interface MockStrategyStore {
  strategies: StrategyRowDto[];
  versions: StrategyVersionRowDto[];
  seq: number;
}

function seedStrategyStore(anchor: number): MockStrategyStore {
  const iso = (offMs: number) => new Date(anchor - offMs).toISOString();
  const v = (
    id: string,
    strategyId: string,
    version: number,
    code: string,
    status: StrategyStatus,
    approval: StrategyApprovalLevel,
    schema: StrategyParamDef[],
    ageMs: number,
  ): StrategyVersionRowDto => ({
    id,
    strategy_id: strategyId,
    version,
    code,
    params_schema: schema,
    sha256: mockSha(code),
    status,
    approval_level: approval,
    created_at: iso(ageMs),
    published_at: status === 'draft' ? null : iso(ageMs - 60_000),
  });
  return {
    seq: 100,
    strategies: [
      { id: 'st_mock_dual_ma', name: '双均线插件策略', description: 'MA 金叉死叉评分',
        kind: 'strategy', created_by: 'seed', created_at: iso(10 * 86400_000), updated_at: iso(3600_000) },
      { id: 'st_mock_tpl_pure', name: '纯评分模板', description: '官方模板：最小骨架',
        kind: 'template', created_by: 'system', created_at: iso(10 * 86400_000), updated_at: iso(10 * 86400_000) },
      { id: 'st_mock_draft', name: '未发布草稿策略', description: '仅 draft，catalog 不可见',
        kind: 'strategy', created_by: 'seed', created_at: iso(7200_000), updated_at: iso(1800_000) },
    ],
    versions: [
      v('sv_mock_dual_v1', 'st_mock_dual_ma', 1, MOCK_DUAL_MA_CODE, 'published', 'sim_ok', MOCK_DUAL_MA_SCHEMA, 5 * 86400_000),
      v('sv_mock_dual_v2', 'st_mock_dual_ma', 2, MOCK_DUAL_MA_CODE + '\n// v2 draft 调整\n', 'draft', 'backtest_ok', MOCK_DUAL_MA_SCHEMA, 86400_000),
      v('sv_mock_tpl_v1', 'st_mock_tpl_pure', 1, MOCK_TEMPLATE_CODE, 'published', 'backtest_ok', [], 10 * 86400_000),
      v('sv_mock_draft_v1', 'st_mock_draft', 1, MOCK_TEMPLATE_CODE, 'draft', 'backtest_ok', [], 7200_000),
    ],
  };
}

/** approval 阶梯 rank（at-least 过滤；与后端 ApprovalLevel::rank 同构）。 */
function approvalRank(l: StrategyApprovalLevel): number {
  return l === 'backtest_ok' ? 1 : l === 'sim_ok' ? 2 : 3;
}

// ── 页面⑪ 回测工作台（12-strategy-system / P3b；§1.8 契约 mock）──

/** 确定性 ensemble 运行结果（ADR §13.4 五 jsonb 列形状；由 run id 哈希驱动，可复现）。
 *  per_bar 60 根日线粒度：scores（每 slot 一分，偶发插件错误记中立 50 + error 文本）/aggregate
 *  （权重加权）/signal（config 阈值判定）/orders/events（含一次 StopTrigger 成交与插件 log）；
 *  trades/net_value/drawdown/metrics 与旧回测 mock 同口径生成。 */
function mockWorkbenchResult(
  seed: string,
  config: WorkbenchRunConfig,
  fromMs: number,
  toMs: number,
): WorkbenchRunResult {
  const N = 60;
  const stepSec = Math.max(60, Math.floor((toMs - fromMs) / 1000 / N));
  const startSec = Math.floor(fromMs / 1000);
  const totalWeight = config.slots.reduce((s, x) => s + x.weight, 0) || 1;
  const perBar: WorkbenchBarRecord[] = [];
  const trades: Trade[] = [];
  const netValue: Array<[number, number]> = [];
  const drawdown: Array<[number, number]> = [];
  let equity = config.initial_capital;
  let peak = equity;
  let holding: { qty: number; price: number; openTs: number; openBar: number } | null = null;
  for (let i = 0; i < N; i++) {
    const ts = startSec + i * stepSec;
    const price = round3(2 + rand01(`${seed}:px:${i}`) * 1.5);
    const scores = config.slots.map((_s, idx) => {
      // 确定性错误素材：bar 7 必出插件错误（G5 中立分 50 + error 文本）；其余按 3% 哈希随机
      const isErr = i === 7 || rand01(`${seed}:err:${idx}:${i}`) < 0.03;
      const score = isErr ? 50 : Math.round(rand01(`${seed}:sc:${idx}:${i}`) * 100);
      return isErr
        ? { slot_idx: idx, score, error: 'mock 插件错误（契约桩）' }
        : { slot_idx: idx, score };
    });
    const aggregate = round3(scores.reduce((s, x) => s + x.score * config.slots[x.slot_idx]!.weight, 0) / totalWeight);
    const signal: WorkbenchBarRecord['signal'] =
      aggregate >= config.buy_threshold ? 'Buy' : aggregate <= config.sell_threshold ? 'Sell' : 'Hold';
    const orders: WorkbenchBarRecord['orders'] = [];
    const events: WorkbenchBarRecord['events'] = [];
    if (scores.some((s) => s.error)) {
      const bad = scores.findIndex((s) => s.error);
      events.push({
        type: 'plugin_error', slot_idx: bad, sha256: config.slots[bad]?.sha256 ?? '',
        bar_index: i, error: 'mock 插件错误（契约桩）',
      });
    }
    if (i % 17 === 0) events.push({ type: 'plugin_log', slot_idx: 0, bar_index: i, message: `mock log bar=${i}` });
    // 简薄撮合同构：Buy 开/加仓、Sell 平仓；中段插一笔硬止损强平（StopTrigger 不同图标测试素材）
    const stopBar = Math.floor(N / 2);
    if (i === stopBar && config.stop) {
      // 确定性止损素材：无持仓则补一笔建仓，保证 stopBar 处必有 StopTrigger 强平
      if (!holding) holding = { qty: 100, price: round3(price * 1.08), openTs: ts - stepSec, openBar: i - 1 };
      const sp = round3(holding.price * (1 - 0.08));
      events.push({ type: 'fill', bar_index: i, side: 'Sell', qty: holding.qty, price: sp, reason: 'StopTrigger' });
      equity += (sp - holding.price) * holding.qty;
      trades.push({
        open_ts: holding.openTs, close_ts: ts, open_bar: holding.openBar, close_bar: i,
        open_price: holding.price, close_price: sp, shares: holding.qty,
        gross_value: round3(sp * holding.qty), commission: 10, stamp_duty: round3(sp * holding.qty * 0.0005),
        pnl: Math.round((sp - holding.price) * holding.qty - 10), hold_bars: i - holding.openBar,
      });
      holding = null;
    } else if (!holding && signal === 'Buy') {
      const qty = Math.floor((equity * 0.9) / price / 100) * 100 || 100;
      events.push({ type: 'fill', bar_index: i, side: 'Buy', qty, price, reason: 'Policy' });
      holding = { qty, price, openTs: ts, openBar: i };
    } else if (holding && signal === 'Sell') {
      events.push({ type: 'fill', bar_index: i, side: 'Sell', qty: holding.qty, price, reason: 'Policy' });
      equity += (price - holding.price) * holding.qty;
      trades.push({
        open_ts: holding.openTs, close_ts: ts, open_bar: holding.openBar, close_bar: i,
        open_price: holding.price, close_price: price, shares: holding.qty,
        gross_value: round3(price * holding.qty), commission: 10, stamp_duty: round3(price * holding.qty * 0.0005),
        pnl: Math.round((price - holding.price) * holding.qty - 10), hold_bars: i - holding.openBar,
      });
      holding = null;
    }
    const eq = round3(equity + (holding ? (price - holding.price) * holding.qty : 0));
    peak = Math.max(peak, eq);
    netValue.push([ts, eq]);
    drawdown.push([ts, peak > 0 ? round3((peak - eq) / peak) : 0]);
    perBar.push({ ts, scores, aggregate, signal, orders, events });
  }
  // 期末仍持仓 → 强平（ForceClose）
  if (holding) {
    const last = perBar[perBar.length - 1]!;
    const price = round3(2 + rand01(`${seed}:px:end`) * 1.5);
    last.events.push({ type: 'fill', bar_index: N - 1, side: 'Sell', qty: holding.qty, price, reason: 'ForceClose' });
    trades.push({
      open_ts: holding.openTs, close_ts: last.ts, open_bar: holding.openBar, close_bar: N - 1,
      open_price: holding.price, close_price: price, shares: holding.qty,
      gross_value: round3(price * holding.qty), commission: 10, stamp_duty: round3(price * holding.qty * 0.0005),
      pnl: Math.round((price - holding.price) * holding.qty - 10), hold_bars: N - 1 - holding.openBar,
    });
    const eq = round3(equity + (price - holding.price) * holding.qty);
    netValue[netValue.length - 1] = [last.ts, eq];
    peak = Math.max(peak, eq);
    drawdown[drawdown.length - 1] = [last.ts, peak > 0 ? round3((peak - eq) / peak) : 0];
  }
  return { per_bar: perBar, trades, net_value: netValue, drawdown, metrics: mockBacktestMetrics(seed) };
}

/** 种子工作台 runs（succeeded/running/failed 三态；config 钉住形状与 submit 同构）。 */
function seedWorkbenchRuns(
  anchor: number,
  store: MockStrategyStore,
): Map<string, { view: WorkbenchRunView; result: WorkbenchRunResult | null }> {
  const iso = (offMs: number) => new Date(anchor - offMs).toISOString();
  const dual = store.versions.find((v) => v.id === 'sv_mock_dual_v1')!;
  const tpl = store.versions.find((v) => v.id === 'sv_mock_tpl_v1')!;
  const pin = (v: StrategyVersionRowDto, weight: number): WorkbenchPinnedSlot => ({
    strategy_id: v.strategy_id,
    version_id: v.id,
    version: v.version,
    sha256: v.sha256,
    params: Object.fromEntries(v.params_schema.map((p) => [p.key, p.default])),
    weight,
  });
  const baseConfig = (slots: WorkbenchPinnedSlot[]): WorkbenchRunConfig => ({
    slots,
    buy_threshold: 60,
    sell_threshold: 40,
    policy: { LumpSum: { position_pct: 1 } },
    stop: { kind: 'FixedPct', value: 0.08, trigger: 'Intrabar' },
    initial_capital: 100_000,
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
  });
  const mk = (
    id: string,
    over: Partial<WorkbenchRunView>,
    config: WorkbenchRunConfig,
  ): { view: WorkbenchRunView; result: WorkbenchRunResult | null } => {
    const fromMs = anchor - 90 * 86_400_000;
    const view: WorkbenchRunView = {
      id,
      name: '',
      symbol: '518880',
      period: 'D1',
      from_ts: new Date(fromMs).toISOString(),
      to_ts: iso(0),
      config,
      status: 'queued',
      progress: 0,
      error: null,
      created_at: iso(3_600_000),
      started_at: null,
      finished_at: null,
      ...over,
    };
    const result =
      view.status === 'succeeded' ? mockWorkbenchResult(id, config, fromMs, anchor) : null;
    return { view, result };
  };
  const map = new Map<string, { view: WorkbenchRunView; result: WorkbenchRunResult | null }>();
  map.set('sr_mock_seed1', mk('sr_mock_seed1', {
    name: '种子·双均线', status: 'succeeded', progress: 1,
    created_at: iso(7_200_000), started_at: iso(7_200_000), finished_at: iso(7_100_000),
  }, baseConfig([pin(dual, 1)])));
  map.set('sr_mock_seed2', mk('sr_mock_seed2', {
    name: '种子·双策略组合', status: 'succeeded', progress: 1,
    created_at: iso(3_600_000), started_at: iso(3_600_000), finished_at: iso(3_500_000),
  }, baseConfig([pin(dual, 1), pin(tpl, 2)])));
  map.set('sr_mock_seed3', mk('sr_mock_seed3', {
    name: '种子·运行中', status: 'running', progress: 0.42,
    created_at: iso(1_800_000), started_at: iso(1_800_000),
  }, baseConfig([pin(dual, 1)])));
  map.set('sr_mock_seed4', mk('sr_mock_seed4', {
    name: '种子·失败', status: 'failed', progress: 0.1, error: 'mock 引擎错误（契约桩）',
    created_at: iso(900_000), started_at: iso(900_000), finished_at: iso(800_000),
  }, baseConfig([pin(dual, 1)])));
  return map;
}

export function createMockClient(opts: MockOptions = {}): ApiClient {
  const anchorNow = opts.now?.getTime() ?? Date.now();
  let symbols = initialSymbols();
  /** 看板收藏（Wave 3 页面①）：已收藏 code 的有序列表（favoriteOrder 下标+1 = sort_order；起点 1）。
   *  star=追加（max+1）、unstar=移除、reorder=整序；getSymbols 据其注入 favorite/favorite_sort 并收藏优先。 */
  let favoriteOrder: string[] = [];
  /** 行情看板 MA 窗口（GET/PUT /api/config/ma mock 内存态；默认 [5,10,20]） */
  let maWindows: number[] = [...DEFAULT_MA_WINDOWS];
  /** 行情看板 K线默认视口（GET/PUT /api/config/kline mock 内存态；默认 2 交易日） */
  let klineViewportDays: number = DEFAULT_KLINE_VIEWPORT_DAYS;
  /** 页面⑧ S2 源参数配置 mock 内存态（GET/PATCH /api/config/sources；默认 = 内置源参数） */
  let sourceConfig: SourceConfigItem[] = mockSourceConfig();
  /** 页面⑧ S2 采集参数 mock 内存态（GET/PATCH /api/config/collector；默认 60） */
  let collectorConfig: CollectorConfigSnapshot = { default_interval_sec: 60, trading_hours: '09:30-11:30/13:00-15:00' };
  /** 页面⑧ S2 MCP 配置 mock 内存态（GET/PATCH /api/config/mcp；默认 总开/交易工具关/50000·20） */
  let mcpConfig: McpConfigSnapshot = { enabled: true, trading_tools_enabled: false, daily_limit_amount: 50000, daily_limit_count: 20 };
  /** 已收藏 code 的 sort_order 映射（与后端 favorite_map 同构：非收藏不在 map，sort_order 起点 1） */
  const favMap = (): Map<string, number> =>
    new Map(favoriteOrder.map((c, i) => [c, i + 1]));
  const assertSymbolExists = (code: string) => {
    if (!symbols.some((s) => s.code === code)) {
      throw new ApiError(404, `HTTP 404: code 未注册`);
    }
  };
  /** 页面⑦ 内部状态：ack/patch 行为可在测试中闭环验证 */
  const alertEvents = initialAlertEvents();
  const alertRules = initialAlertRules();
  /** 测试观测口：已收到的复位请求 */
  const resetLog: string[] = [];
  /** 页面⑤ 回测：内部 run 列表（构造时可用 opts.backtestRuns 注入种子，否则内置四态） */
  let backtestRuns: BacktestRunDto[] =
    opts.backtestRuns ?? seedBacktestRuns(anchorNow);
  let nextBacktestRunId =
    (backtestRuns.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  /** 页面⑩ 策略 Registry mock 内存态（策略行 + 版本行；行为可闭环验证）。 */
  const strategyStore = seedStrategyStore(anchorNow);
  /** 页面⑪ 回测工作台 mock 内存态（runs 含结果 / presets；§1.8 行为可闭环验证）。 */
  const workbenchRuns = seedWorkbenchRuns(anchorNow, strategyStore);
  let workbenchSeq = 100;
  const workbenchPresets = new Map<string, WorkbenchPresetRow>();
  let workbenchPresetSeq = 1;
  /** 新建 draft 版本（从指定版本派生；与后端 create_draft_from 同口径）。局部函数而非对象方法，
   *  避免 stubApi（vi.fn 包装）下 `this` 上下文丢失。 */
  const createDraftFromVersion = (strategyId: string, fromVersionId: string): StrategyVersionRowDto => {
    const from = strategyStore.versions.find((x) => x.id === fromVersionId);
    if (!from || !strategyStore.strategies.some((x) => x.id === strategyId)) {
      throw new ApiError(404, `HTTP 404: 版本 ${fromVersionId} 不存在`);
    }
    if (from.strategy_id !== strategyId) {
      throw new ApiError(400, 'HTTP 400: 版本不属该策略');
    }
    const n = Math.max(
      0,
      ...strategyStore.versions.filter((x) => x.strategy_id === strategyId).map((x) => x.version),
    );
    const vid = `sv_mock_${strategyStore.seq}_v${n + 1}`;
    strategyStore.seq += 1;
    const nv: StrategyVersionRowDto = {
      ...from,
      id: vid,
      version: n + 1,
      status: 'draft',
      approval_level: 'backtest_ok',
      created_at: new Date(anchorNow).toISOString(),
      published_at: null,
    };
    strategyStore.versions.push(nv);
    return { ...nv };
  };

  const createBacktestRun = (
    req: BacktestSubmitReq,
    params: Record<string, unknown>,
    groupId: string | null,
  ): BacktestRunDto => makeDoneRun(req, params, nextBacktestRunId++, groupId, anchorNow);

  /** 页面⑨ 模拟实盘：内存态（活跃会话/账户/策略评估/订单/历史）；与 MCP 共享同一服务（同 client 状态）。 */
  let simSeq = 12;
  let simLive = seedSimLiveState(anchorNow);
  const mutateSim = () => {
    // 重算 pnl 快照（未实现 = 市值 - 成本×量；已实现/费用累计）。
    const unrealized = simLive.positions.reduce(
      (s, p) => s + (p.latest - p.avg_cost) * p.qty, 0);
    const market_value = simLive.positions.reduce((s, p) => s + p.market_value, 0);
    simLive.account = {
      ...simLive.account,
      equity: simLive.account.cash + market_value,
      market_value,
      unrealized_pnl: unrealized,
    };
    simLive.pnl = {
      realized_pnl: simLive.account.realized_pnl,
      unrealized_pnl: unrealized,
      total_fee: simLive.account.total_fee,
      net_profit: simLive.account.realized_pnl + unrealized,
    };
  };

  const queryAlerts = async (q: AlertQuery): Promise<AlertEventItem[]> => {
    const out = alertEvents
      .filter(
        (e) =>
          (q.level == null || e.level === q.level) &&
          (q.source == null || e.source === q.source) &&
          (q.from == null || e.last_fired_at >= q.from) &&
          (q.to == null || e.last_fired_at < q.to),
      )
      .sort((a, b) => b.last_fired_at.localeCompare(a.last_fired_at));
    return out.slice(0, q.limit ?? 200).map((e) => ({ ...e }));
  };

  return {
    async getSymbols(): Promise<SymbolSnapshot[]> {
      const map = favMap();
      const list = symbols.map((s) => ({
        code: s.code,
        name: s.name ?? s.code,
        enabled: s.enabled,
        last: s.latest?.last ?? null,
        changePct: s.latest?.change_pct ?? 0,
        favorite: map.has(s.code),
        favoriteSort: map.get(s.code) ?? null,
      }));
      // 与后端 /api/symbols 同构：收藏优先（favorite_sort 升序），非收藏保持原序（稳定排序）
      list.sort((a, b) => {
        if (a.favorite && b.favorite) return (a.favoriteSort ?? 0) - (b.favoriteSort ?? 0);
        if (a.favorite) return -1;
        if (b.favorite) return 1;
        return 0;
      });
      return list;
    },
    // ── 看板收藏（Wave 3 页面①；与后端 favorite.rs 同构：star 追加 max+1 幂等、unstar 幂等、reorder 校验已收藏）──
    async starSymbol(code: string): Promise<void> {
      assertSymbolExists(code);
      if (!favoriteOrder.includes(code)) favoriteOrder = [...favoriteOrder, code];
    },
    async unstarSymbol(code: string): Promise<void> {
      assertSymbolExists(code);
      favoriteOrder = favoriteOrder.filter((c) => c !== code);
    },
    async reorderFavorites(codes: string[]): Promise<void> {
      const set = new Set(favoriteOrder);
      for (const c of codes) {
        if (!set.has(c)) {
          throw new ApiError(400, `HTTP 400: code ${c} 未收藏`);
        }
      }
      favoriteOrder = [...codes];
    },
    async getKline({ code, period, before, limit = 500 }: KlineQuery): Promise<Bar[]> {
      const step = PERIOD_MS[period];
      // 排他上界：缺省为当前周期边界（最新一根已完成 bar）
      const endExclusive = before ? Date.parse(before) : Math.floor(anchorNow / step) * step;
      const bars: Bar[] = [];
      for (let i = limit; i >= 1; i--) {
        bars.push(makeBar(code, period, endExclusive - step * i));
      }
      return bars;
    },
    async getSourcesHealth(): Promise<SourcesHealth> {
      return {
        window_secs: 3600,
        sources: [
          healthItem('tencent_ifzq', 'healthy', { successes: 59, success_rate: 0.992 }),
          healthItem('sina_jsonp', 'degraded'),
          healthItem('tencent_qt', 'circuit_open', { attempts: 12, successes: 3, success_rate: 0.25, last_event_ts: '2026-09-04T02:18:00Z' }),
          healthItem('sina_hq', 'healthy'),
          healthItem('push2delay', 'healthy', { success_rate: null, attempts: 0, successes: 0 }),
        ],
      };
    },
    async getSymbolsAdmin(): Promise<SymbolRow[]> {
      const map = favMap();
      return symbols.map((s) => ({
        ...s,
        favorite: map.has(s.code),
        favorite_sort: map.get(s.code) ?? null,
      }));
    },
    async registerSymbol(input: RegisterSymbolInput): Promise<SymbolRow> {
      if (symbols.some((s) => s.code === input.code)) {
        throw new ApiError(409, 'HTTP 409: code 已注册（编辑用 PATCH）');
      }
      if (/^(4|8|920)/.test(input.code)) {
        throw new ApiError(422, 'HTTP 422: 北交所标的（4/8/920 前缀）暂不支持');
      }
      const row: SymbolRow = {
        code: input.code,
        name: input.name ?? null,
        interval_secs: input.interval_secs ?? 60,
        settlement: input.settlement ?? 'T1',
        enabled: input.enabled ?? true,
        latest: null,
        today_bars: 0,
        favorite: false,
        favorite_sort: null,
      };
      symbols = [...symbols, row];
      return { ...row };
    },
    async updateSymbol(code: string, patch: SymbolPatchBody): Promise<SymbolRow> {
      const idx = symbols.findIndex((s) => s.code === code);
      if (idx < 0) throw new ApiError(404, 'HTTP 404: code 未注册');
      const cur = symbols[idx]!;
      const next: SymbolRow = {
        ...cur,
        name: patch.name !== undefined ? patch.name : cur.name,
        interval_secs: patch.interval_secs ?? cur.interval_secs,
        settlement: patch.settlement ?? cur.settlement,
        enabled: patch.enabled ?? cur.enabled,
      };
      symbols = [...symbols.slice(0, idx), next, ...symbols.slice(idx + 1)];
      return { ...next };
    },
    async resetSource(id: string): Promise<void> {
      resetLog.push(id);
    },
    async getAlerts(limit = 10): Promise<AlertItem[]> {
      // 页面②告警预览语义基线（02-sources §7 样例数据，SourcesPage 测试锁定）；
      // 与页面⑦种子事件解耦：预览展示的是熔断/缺口样例流，不受 ack/patch 影响
      void limit;
      return [
        { ts: '2026-09-04T02:18:00Z', level: 'crit', text: '腾讯qt 连续失败 3 次，已熔断' },
        { ts: '2026-09-04T02:05:00Z', level: 'warn', text: '159776 当日缺口率 26.8%（>20%）' },
        { ts: '2026-09-04T01:47:00Z', level: 'info', text: '新浪jsonp 恢复，回到轮转序列' },
      ];
    },
    // ── Wave 2 Phase B：页面⑦ 告警中心 ──
    getAlertEvents: queryAlerts,
    async ackAlert(id: number): Promise<AlertEventItem> {
      const e = alertEvents.find((x) => x.id === id);
      if (!e || e.status !== 'triggered') {
        throw new ApiError(404, 'HTTP 404: 告警不存在或不在未确认状态');
      }
      e.status = 'acked';
      e.acked_at = new Date(anchorNow).toISOString();
      return { ...e };
    },
    async getAlertRules(): Promise<AlertRuleItem[]> {
      return alertRules.map((r) => ({ ...r }));
    },
    async patchAlertRule(id: string, patch: AlertRulePatchBody): Promise<AlertRuleItem> {
      const r = alertRules.find((x) => x.id === id);
      if (!r) throw new ApiError(404, 'HTTP 404: 规则不存在（内置规则预置，不可增删）');
      if (patch.threshold !== undefined) r.threshold = patch.threshold;
      if (patch.enabled !== undefined) r.enabled = patch.enabled;
      if (patch.silence_minutes !== undefined) r.silence_minutes = patch.silence_minutes;
      return { ...r };
    },
    async getSourceEvents(id: string, limit = 50): Promise<SourceEventItem[]> {
      const kinds: SourceEventItem['kind'][] = ['success', 'failure', 'rate_limited', 'circuit'];
      return Array.from({ length: Math.min(limit, 8) }, (_, i) => {
        const kind = kinds[Math.floor(rand01(`${id}:ev:${i}`) * 4)]!;
        return {
          ts: new Date(anchorNow - i * 61_000).toISOString(),
          kind,
          detail:
            kind === 'success'
              ? `OK ${120 + Math.floor(rand01(`${id}:lat:${i}`) * 300)}ms`
              : kind === 'failure'
                ? '连接重置'
                : kind === 'rate_limited'
                  ? '429'
                  : '熔断',
          traceId: Array.from({ length: 8 }, (_, j) =>
            '0123456789abcdef'[Math.floor(rand01(`${id}:tr:${i}:${j}`) * 16)],
          ).join(''),
        };
      });
    },
    async getSourceMetrics(id: string, range: DetailRange): Promise<MetricPoint[]> {
      const n = range === '1h' ? 12 : range === 'today' ? 32 : 48;
      return Array.from({ length: n }, (_, i) => ({
        ts: new Date(anchorNow - (n - 1 - i) * 5 * 60_000).toISOString(),
        successRate: round3(90 + rand01(`${id}:sr:${range}:${i}`) * 10),
        p50Ms: Math.round(150 + rand01(`${id}:p50:${range}:${i}`) * 400),
      }));
    },
    async getSourceDivergence(id: string, _range: DetailRange): Promise<DivergenceStat> {
      return { divergeBars: Math.floor(rand01(`${id}:div`) * 20), thresholdPct: 0.5 };
    },
    async getSourceRateLimits(id: string, _range: DetailRange): Promise<RateLimitCounters> {
      return {
        http403: Math.floor(rand01(`${id}:r403`) * 2),
        http429: Math.floor(rand01(`${id}:r429`) * 4),
        connReset: Math.floor(rand01(`${id}:rreset`) * 6),
      };
    },
    // ── Wave 2 Phase C：页面④ 数据质量（04-quality §7.1 线格式；确定性生成可复现）──
    async getQualityDivergence(q: QualityCodeRangeQuery): Promise<QualityDivergenceResponse> {
      const threshold = q.thresholdPct ?? 0.5;
      const rows = mockDivergenceRows(q.code);
      const n = rows.length;
      const divergent = rows.filter((r) => Math.abs(r.deviation_pct) > threshold).length;
      return {
        code: q.code,
        from: q.from,
        to: q.to,
        threshold_pct: threshold,
        summary: {
          compared_bars: n,
          divergent_bars: divergent,
          divergence_rate: n > 0 ? divergent / n : null,
          consistency_rate: n > 0 ? (n - divergent) / n : null,
          max_deviation_pct: n > 0 ? Math.abs(rows[0]!.deviation_pct) : null,
        },
        rows,
      };
    },
    async getSourceAccuracy(q: QualityRangeQuery): Promise<SourceAccuracyResponse> {
      const threshold = q.thresholdPct ?? 0.5;
      const bySource = new Map<string, number[]>();
      for (const r of mockDivergenceRows('518880').concat(mockDivergenceRows('513310'))) {
        const key = r.raw_source ?? 'unknown';
        bySource.set(key, [...(bySource.get(key) ?? []), Math.abs(r.deviation_pct)]);
      }
      const sources: SourceAccuracyItem[] = [...bySource.entries()].map(([source, devs]) => ({
        source,
        samples: devs.length,
        consistency_rate: devs.filter((d) => d <= threshold).length / devs.length,
        avg_deviation_pct: devs.reduce((a, b) => a + b, 0) / devs.length,
        max_deviation_pct: Math.max(...devs),
      }));
      sources.sort(
        (a, b) =>
          (b.consistency_rate ?? 0) - (a.consistency_rate ?? 0) || a.source.localeCompare(b.source),
      );
      return { from: q.from, to: q.to, threshold_pct: threshold, sources };
    },
    async getQualityGaps(q: QualityCodeRangeQuery): Promise<QualityGapsResponse> {
      // 固定样例（preview/04-quality.html 同构）：落在查询区间内的缺口日出卡
      const days = [
        { date: '2026-09-02', expected_bars: 241, actual_bars: 235, missing_bars: 6,
          segments: [
            { start: '10:41', end: '10:45', count: 5, class: 'source_fault' as const },
            { start: '13:07', end: '13:07', count: 1, class: 'upstream_no_data' as const },
          ] },
        { date: '2026-08-28', expected_bars: 241, actual_bars: 210, missing_bars: 31,
          segments: [
            { start: '14:30', end: '15:00', count: 31, class: 'system_gap' as const },
          ] },
      ].filter((d) => d.date >= q.from && d.date <= q.to);
      return { code: q.code, from: q.from, to: q.to, days };
    },
    async getTushareStatus(): Promise<TushareStatusResponse> {
      const checkpoints = symbols
        .filter((s) => s.enabled)
        .map((s) => ({
          code: s.code,
          period: '1m',
          last_synced_date: '2026-09-03',
          updated_at: '2026-09-03T22:30:00Z',
        }));
      return {
        checkpoints,
        covered_codes: checkpoints.length,
        last_updated_at: '2026-09-03T22:30:00Z',
        last_event: { ts: '2026-09-03T22:30:00Z', ok: true, err_kind: null },
        quota_remaining: null,
      };
    },
    // ── 页面⑧ 系统设置（08-settings §6；仅 S1 只读/运维端点，无配置持久化）──
    async getSystemInfo(): Promise<SystemInfo> {
      return { app_version: '0.1.0', crate_versions: { collector: '0.1.0', storage: '0.1.0', diagnose: '0.1.0' }, db_ok: true, uptime_secs: 61 };
    },
    async getConfigSources(): Promise<SourceConfigSnapshot> {
      return { sources: sourceConfig.map((s) => ({ ...s })) };
    },
    async saveConfigSources(sources: SourceConfigItem[]): Promise<SourceConfigSnapshot> {
      // 校验：东财末位（ADR-006）+ 每源值域；仿真后端 400
      const items = sources as unknown as { id: string; rate_per_sec: number; jitter_ms: number; circuit_fail_count: number; backoff_steps: string[]; enabled: boolean }[];
      for (const it of items) {
        if (it.rate_per_sec < 0 || it.jitter_ms < 0 || it.circuit_fail_count < 0 || it.backoff_steps.length === 0) {
          throw new ApiError(400, `HTTP 400: 源 ${it.id} 参数不合法`);
        }
      }
      if (items[items.length - 1]?.id !== 'push2delay') {
        throw new ApiError(400, 'HTTP 400: 轮转序违规：push2delay（东财系）必须为末位（ADR-006）');
      }
      sourceConfig = items.map((it) => {
        const meta = sourceConfig.find((s) => s.id === it.id);
        return { id: it.id, label: meta?.label ?? it.id, role: meta?.role ?? 'snapshot',
          rate_per_sec: it.rate_per_sec, jitter_ms: it.jitter_ms, circuit_fail_count: it.circuit_fail_count,
          backoff_steps: [...it.backoff_steps], enabled: it.enabled, rotation_locked: meta?.rotation_locked ?? false };
      });
      return { sources: sourceConfig.map((s) => ({ ...s })) };
    },
    async getConfigCollector(): Promise<CollectorConfigSnapshot> {
      return { ...collectorConfig };
    },
    async saveConfigCollector(patch: CollectorConfigPatchBody): Promise<CollectorConfigSnapshot> {
      if (patch.default_interval_sec < 60) {
        throw new ApiError(400, 'HTTP 400: default_interval_sec 须 ≥60');
      }
      collectorConfig = { ...collectorConfig, default_interval_sec: patch.default_interval_sec };
      return { ...collectorConfig };
    },
    async getConfigMcp(): Promise<McpConfigSnapshot> {
      return { ...mcpConfig };
    },
    async saveConfigMcp(patch: McpConfigPatchBody): Promise<McpConfigSnapshot> {
      if (patch.daily_limit_amount < 0 || patch.daily_limit_count < 0) {
        throw new ApiError(400, 'HTTP 400: 每日限额须 ≥0');
      }
      mcpConfig = { ...patch };
      return { ...mcpConfig };
    },
    // ── 行情看板 MA 可配置（后端 W1：GET/PUT /api/config/ma；主图+宫格应用，回测弹窗不动）──
    async getMaConfig(): Promise<MaConfigDto> {
      return { windows: maWindows.slice() };
    },
    async saveMaConfig(windows: number[]): Promise<MaConfigDto> {
      const normalized = normalizeMaWindows(windows);
      maWindows = normalized;
      return { windows: normalized.slice() };
    },
    // ── 行情看板 K线默认视口（后端 W1：GET/PUT /api/config/kline；主图+宫格应用，回测弹窗不动）──
    async getKlineConfig(): Promise<KlineConfigDto> {
      return { viewport_days: klineViewportDays };
    },
    async saveKlineConfig(viewportDays: number): Promise<KlineConfigDto> {
      assertKlineViewportDays(viewportDays);
      klineViewportDays = viewportDays;
      return { viewport_days: klineViewportDays };
    },
    async purgeRaw(confirm: string): Promise<PurgeRawResult> {
      if (confirm !== 'PURGE') {
        throw new ApiError(400, 'HTTP 400: confirm 字段缺失或不匹配（须为 PURGE）');
      }
      return { rows_deleted: 0 };
    },
    async resetCircuits(confirm: string): Promise<ResetCircuitsResult> {
      if (confirm !== 'RESET') {
        throw new ApiError(400, 'HTTP 400: confirm 字段缺失或不匹配（须为 RESET）');
      }
      return { requests: 0 };
    },
    // ── 页面⑤ 回测工作台（Wave 3 Phase 3c；契约 mock，与后端 §1.5 同构）──
    async getStrategies(): Promise<BacktestStrategyDto[]> {
      return mockBacktestStrategies();
    },
    async submitRun(req: BacktestSubmitReq): Promise<BacktestSubmitResp> {
      // 网格参数（字符串「起:止:步长」）→ 展开为任务组；否则单 run
      const grid: Record<string, string> = {};
      const base: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.params)) {
        if (typeof v === 'string') grid[k] = v;
        else base[k] = v;
      }
      if (Object.keys(grid).length > 0) {
        const children = mockExpandGrid(base, grid);
        const group_id = `g_mock_${nextBacktestRunId}`;
        const runs = children.map((params) => createBacktestRun(req, params, group_id));
        // 同类任务组共享 group_id（复用 makeDoneRun 用 seed 派生，保证确定且互异）
        for (const r of runs) r.group_id = group_id;
        backtestRuns = [...backtestRuns, ...runs];
        return { group_id, run_ids: runs.map((r) => r.id) };
      }
      const run = createBacktestRun(req, base, null);
      backtestRuns = [...backtestRuns, run];
      return { run_id: run.id };
    },
    async listRuns(filter?: {
      status?: BacktestStatus;
      groupId?: string;
      limit?: number;
      offset?: number;
    }): Promise<BacktestRunDto[]> {
      let out = backtestRuns.slice();
      if (filter?.status) out = out.filter((r) => r.status === filter.status);
      if (filter?.groupId) out = out.filter((r) => r.group_id === filter.groupId);
      out.sort(backtestSortDesc);
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? out.length;
      out = out.slice(offset, offset + Math.max(0, limit));
      return out.map(stripBacktestResult);
    },
    async getRun(id: number): Promise<BacktestRunDto> {
      const r = backtestRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, `HTTP 404: run ${id} 不存在`);
      return { ...r };
    },
    async compare(ids: number[]): Promise<BacktestRunDto[]> {
      return ids
        .map((id) => backtestRuns.find((x) => x.id === id))
        .filter((r): r is BacktestRunDto => r != null)
        .map((r) => ({ ...r }));
    },
    async deleteRun(id: number): Promise<void> {
      if (!backtestRuns.some((r) => r.id === id)) {
        throw new ApiError(404, `HTTP 404: run ${id} 不存在`);
      }
      backtestRuns = backtestRuns.filter((r) => r.id !== id);
    },
    // ── 页面⑨ 模拟实盘（§1.6；模拟实盘，不触真实券商）──
    async getSimState(_sessionId?: string): Promise<SimStateDto> {
      return { active: simLive.session.status === 'running', session: simLive.session,
        account: simLive.account, positions: simLive.positions.map((p) => ({ ...p })),
        pnl: simLive.pnl, trading_enabled: simLive.trading_enabled, mcp_enabled: simLive.mcp_enabled };
    },
    async getSimPositions(_sessionId?: string): Promise<SimPositionsResp> {
      return { session_id: simLive.session.id, positions: simLive.positions.map((p) => ({ ...p })) };
    },
    async getSimOrders(_sessionId?: string): Promise<SimOrdersResp> {
      return { session_id: simLive.session.id, orders: simLive.orders.map((o) => ({ ...o })) };
    },
    async getSimPnl(_sessionId?: string): Promise<SimPnlResp> {
      return { session_id: simLive.session.id, pnl: { ...simLive.pnl } };
    },
    async getSimStrategies(_sessionId?: string): Promise<SimStrategiesDto> {
      return simStrategiesView(simLive);
    },
    async startSimSession(req: SimStartSessionReq): Promise<{ started: boolean; session: SimSession }> {
      const id = `s_${simSeq}`;
      simSeq += 1;
      // ADR §4 多策略：若提供每策略明细 → 会话级 strategy_set/stock_set 由策略派生（去重、保序）。
      const detail = req.strategies ?? [];
      const strategy_set = detail.length > 0
        ? Array.from(new Set(detail.map((s) => s.strategy_id)))
        : (req.strategy_set ?? []);
      const stock_set = detail.length > 0
        ? Array.from(new Set(detail.flatMap((s) => s.stocks)))
        : (req.stock_set ?? []);
      const session: SimSession = {
        id,
        name: req.name,
        status: 'running',
        source: req.source ?? 'web',
        cash_init: req.cash_init ?? 1_000_000,
        strategy_set,
        stock_set,
        period: req.period,
        start_ts: new Date(anchorNow).toISOString(),
        end_ts: null,
      };
      simLive = {
        session,
        account: { session_id: id, cash: session.cash_init, equity: session.cash_init,
          market_value: 0, realized_pnl: 0, unrealized_pnl: 0, total_fee: 0 },
        positions: [],
        orders: [],
        pnl: { realized_pnl: 0, unrealized_pnl: 0, total_fee: 0, net_profit: 0 },
        trading_enabled: false,
        mcp_enabled: true,
        strategies: simLive.strategies,
        history: simLive.history,
        strategiesDetail: detail,
      };
      return { started: true, session };
    },
    async stopSimSession(req: { session_id?: string }): Promise<{ session_id: string; stopped: boolean }> {
      const id = req.session_id ?? simLive.session.id;
      if (simLive.session.id !== id || simLive.session.status === 'ended') {
        return { session_id: id, stopped: false };
      }
      const ended = { ...simLive.session, status: 'ended' as const, end_ts: new Date(anchorNow).toISOString() };
      simLive = { ...simLive, session: ended };
      simLive.history = [{ session: ended, metrics: toSimMetrics(simLive.pnl) }, ...simLive.history];
      // 若还有其它运行会话，则退回未运行态；此处简化：已 ended 后 state.active=false。
      return { session_id: id, stopped: true };
    },
    async placeSimOrder(req: SimPlaceOrderReq): Promise<{ session_id: string; filled: boolean; fill: unknown | null; reason?: string }> {
      const side = req.side as 'buy' | 'sell';
      const fee = round4(req.price * req.qty * 0.00025);
      // 限价触及判定：买限价=市价 ≤ 限价成交；卖限价=市价 ≥ 限价成交。未触及 → pending。
      const limitTouched = req.limit_price == null
        ? true
        : side === 'buy' ? req.price <= req.limit_price : req.price >= req.limit_price;
      if (!limitTouched) {
        // 限价未触及 → pending（不成交）。
        simLive.orders.push({ id: `o_${simSeq++}`, code: req.code, side, qty: req.qty,
          limit_price: req.limit_price ?? null, status: 'pending', filled_price: null, filled_qty: 0,
          fee: 0, ts: anchorNow, source: req.source ?? 'manual' });
        return { session_id: simLive.session.id, filled: false, fill: null, reason: '限价未触及，记为 pending 单' };
      }
      const price = round4(req.price);
      const fill = { code: req.code, side, qty: req.qty, price, fee };
      // 更新持仓（简化：买加仓/卖减仓，买卖价差区分为开/平）。
      const pos = simLive.positions.find((p) => p.code === req.code);
      if (side === 'buy') {
        if (pos) {
          const newQty = pos.qty + req.qty;
          pos.avg_cost = (pos.avg_cost * pos.qty + price * req.qty) / newQty;
          pos.qty = newQty;
        } else {
          simLive.positions.push({ code: req.code, qty: req.qty, avg_cost: price, latest: price,
            market_value: price * req.qty, unrealized_pnl: 0 });
        }
        simLive.account.cash = round4(simLive.account.cash - price * req.qty - fee);
      } else {
        if (pos) {
          const realized = (price - pos.avg_cost) * Math.min(req.qty, pos.qty);
          simLive.account.realized_pnl = round4(simLive.account.realized_pnl + realized);
          pos.qty -= req.qty;
          if (pos.qty <= 0) simLive.positions = simLive.positions.filter((p) => p.code !== req.code);
          simLive.account.cash = round4(simLive.account.cash + price * req.qty - fee);
        }
      }
      simLive.account.total_fee = round4(simLive.account.total_fee + fee);
      simLive.orders.push({ id: `o_${simSeq++}`, code: req.code, side, qty: req.qty,
        limit_price: req.limit_price ?? null, status: 'filled', filled_price: price, filled_qty: req.qty,
        fee, ts: anchorNow, source: req.source ?? 'manual' });
      mutateSim();
      return { session_id: simLive.session.id, filled: true, fill };
    },
    async cancelSimOrder(req: SimCancelOrderReq): Promise<{ session_id: string; order_id: string; cancelled: boolean }> {
      const o = simLive.orders.find((x) => x.id === req.order_id);
      if (!o || o.status !== 'pending') return { session_id: req.session_id, order_id: req.order_id, cancelled: false };
      o.status = 'cancelled';
      return { session_id: req.session_id, order_id: req.order_id, cancelled: true };
    },
    async toggleSimTrading(req: SimToggleReq): Promise<{ session_id: string; trading_enabled: boolean }> {
      simLive.trading_enabled = req.enabled;
      return { session_id: simLive.session.id, trading_enabled: req.enabled };
    },
    async toggleSimMcp(req: SimToggleReq): Promise<{ mcp_enabled: boolean }> {
      simLive.mcp_enabled = req.enabled;
      return { mcp_enabled: req.enabled };
    },
    async getSimSessions(): Promise<SimSessionListEntry[]> {
      return simLive.history.map((h) => ({ session: { ...h.session }, metrics: h.metrics }));
    },
    async getSimSession(id: string): Promise<SimSessionDetail> {
      const found = simLive.history.find((h) => h.session.id === id);
      if (!found) throw new ApiError(404, `HTTP 404: session ${id} 不存在`);
      return { session: { ...found.session }, result: found.metrics ? { net_value: {}, trades: [], metrics: found.metrics } : null };
    },
    async runSimBacktestCompare(id: string): Promise<SimBacktestCompare> {
      const found = simLive.history.find((h) => h.session.id === id);
      if (!found) throw new ApiError(404, `HTTP 404: session ${id} 不存在`);
      return {
        session_id: id,
        session_result: found.metrics ? { net_value: {}, trades: [], metrics: found.metrics } : null,
        run_ids: [`sr_mock_${1001 + simLive.history.findIndex((h) => h.session.id === id)}`],
      };
    },
    // ── 页面⑩ 策略 Registry（§1.7；mock 行为与后端语义同构）──
    async getStrategyManageList(filter?: { kind?: StrategyKind }): Promise<StrategyManageItem[]> {
      const list = strategyStore.strategies
        .filter((s) => !filter?.kind || s.kind === filter.kind)
        .map((s) => {
          const vs = strategyStore.versions.filter((x) => x.strategy_id === s.id);
          const latest = vs.length > 0 ? vs.reduce((a, b) => (b.version > a.version ? b : a)) : null;
          const pubs = vs.filter((x) => x.status === 'published');
          const latestPub = pubs.length > 0 ? pubs.reduce((a, b) => (b.version > a.version ? b : a)) : null;
          return {
            ...s,
            version_count: vs.length,
            latest_version: latest
              ? { id: latest.id, version: latest.version, status: latest.status,
                  approval_level: latest.approval_level, sha256: latest.sha256,
                  created_at: latest.created_at, published_at: latest.published_at }
              : null,
            latest_published: latestPub
              ? { id: latestPub.id, version: latestPub.version, approval_level: latestPub.approval_level }
              : null,
          };
        });
      return list;
    },
    async getStrategyCatalog(filter?: { level?: StrategyApprovalLevel; kind?: StrategyKind }): Promise<StrategyCatalogEntry[]> {
      const out: StrategyCatalogEntry[] = [];
      for (const s of strategyStore.strategies) {
        if (filter?.kind && s.kind !== filter.kind) continue;
        const pubs = strategyStore.versions.filter(
          (x) => x.strategy_id === s.id && x.status === 'published',
        );
        if (pubs.length === 0) continue;
        const latest = pubs.reduce((a, b) => (b.version > a.version ? b : a));
        if (filter?.level && approvalRank(latest.approval_level) < approvalRank(filter.level)) continue;
        out.push({ strategy: { ...s }, version: { ...latest } });
      }
      return out;
    },
    async createStrategy(req: StrategyCreateReq): Promise<StrategyCreateResp> {
      if (!req.name.trim()) throw new ApiError(400, 'HTTP 400: name 必填');
      if (!req.code.trim()) throw new ApiError(400, 'HTTP 400: code 必填');
      if (req.kind !== undefined && req.kind !== 'strategy' && req.kind !== 'template') {
        throw new ApiError(400, 'HTTP 400: kind 须为 strategy/template');
      }
      const id = `st_mock_${strategyStore.seq}`;
      const vid = `sv_mock_${strategyStore.seq}_v1`;
      strategyStore.seq += 1;
      const nowIso = new Date(anchorNow).toISOString();
      const strategy: StrategyRowDto = {
        id, name: req.name.trim(), description: req.description ?? '',
        kind: req.kind ?? 'strategy', created_by: 'web', created_at: nowIso, updated_at: nowIso,
      };
      const version: StrategyVersionRowDto = {
        id: vid, strategy_id: id, version: 1, code: req.code,
        params_schema: [], sha256: mockSha(req.code), status: 'draft',
        approval_level: 'backtest_ok', created_at: nowIso, published_at: null,
      };
      strategyStore.strategies.push(strategy);
      strategyStore.versions.push(version);
      return { strategy: { ...strategy }, version: { ...version } };
    },
    async patchStrategy(id: string, patch: StrategyPatchReq): Promise<StrategyRowDto> {
      // 校验顺序对齐后端 update_meta：先 400（空 patch / name trim 后空）后 404（未知 id）
      if (patch.name === undefined && patch.description === undefined) {
        throw new ApiError(400, 'HTTP 400: 至少一个字段');
      }
      if (patch.name !== undefined && !patch.name.trim()) {
        throw new ApiError(400, 'HTTP 400: name 不能为空');
      }
      const s = strategyStore.strategies.find((x) => x.id === id);
      if (!s) throw new ApiError(404, `HTTP 404: 策略 ${id} 不存在`);
      if (patch.name !== undefined) {
        s.name = patch.name.trim();
      }
      if (patch.description !== undefined) s.description = patch.description;
      s.updated_at = new Date(anchorNow).toISOString();
      return { ...s };
    },
    async getStrategy(id: string): Promise<StrategyRowDto> {
      const s = strategyStore.strategies.find((x) => x.id === id);
      if (!s) throw new ApiError(404, `HTTP 404: 策略 ${id} 不存在`);
      return { ...s };
    },
    async getStrategyVersions(id: string): Promise<StrategyVersionRowDto[]> {
      if (!strategyStore.strategies.some((x) => x.id === id)) {
        throw new ApiError(404, `HTTP 404: 策略 ${id} 不存在`);
      }
      return strategyStore.versions
        .filter((x) => x.strategy_id === id)
        .sort((a, b) => a.version - b.version)
        .map((x) => ({ ...x }));
    },
    async createStrategyVersion(strategyId: string, fromVersionId: string): Promise<StrategyVersionRowDto> {
      return createDraftFromVersion(strategyId, fromVersionId);
    },
    async updateStrategyVersion(vid: string, code: string): Promise<StrategyUpdateOutcome> {
      if (!code.trim()) throw new ApiError(400, 'HTTP 400: code 必填');
      const v = strategyStore.versions.find((x) => x.id === vid);
      if (!v) throw new ApiError(404, `HTTP 404: 版本 ${vid} 不存在`);
      if (v.status === 'archived') throw new ApiError(409, 'HTTP 409: archived 版本不可编辑');
      if (v.status === 'draft') {
        v.code = code;
        v.sha256 = mockSha(code);
        v.params_schema = mockExtractParamsSchema(code); // 保存即重解析 schema（对齐后端 extract_schema）
        return { outcome: 'updated', version: { ...v } };
      }
      // published → 自动落新 draft（ADR §13.5 防呆）
      const nv = createDraftFromVersion(v.strategy_id, v.id);
      const stored = strategyStore.versions.find((x) => x.id === nv.id)!;
      stored.code = code;
      stored.sha256 = mockSha(code);
      stored.params_schema = mockExtractParamsSchema(code); // new_draft 分支同样重解析
      return { outcome: 'new_draft', version: { ...stored } };
    },
    async publishStrategyVersion(vid: string): Promise<StrategyVersionRowDto> {
      const v = strategyStore.versions.find((x) => x.id === vid);
      if (!v) throw new ApiError(404, `HTTP 404: 版本 ${vid} 不存在`);
      if (v.status !== 'draft') throw new ApiError(409, 'HTTP 409: 仅 draft 可发布');
      // 发布门禁占位：代码须含 on_bar（模拟冒烟；真实门禁由后端 QuickJS 实例化）
      if (!v.code.includes('on_bar')) {
        throw new ApiError(400, 'HTTP 400: 发布门禁未通过（on_bar 缺失）');
      }
      v.status = 'published';
      v.published_at = new Date(anchorNow).toISOString();
      return { ...v };
    },
    async archiveStrategyVersion(vid: string): Promise<StrategyVersionRowDto> {
      const v = strategyStore.versions.find((x) => x.id === vid);
      if (!v) throw new ApiError(404, `HTTP 404: 版本 ${vid} 不存在`);
      if (v.status !== 'published') throw new ApiError(409, 'HTTP 409: 仅 published 可归档');
      v.status = 'archived';
      return { ...v };
    },
    async diffStrategyVersions(from: string, to: string): Promise<StrategyDiffResp> {
      const f = strategyStore.versions.find((x) => x.id === from);
      const t = strategyStore.versions.find((x) => x.id === to);
      if (!f || !t) throw new ApiError(404, 'HTTP 404: 版本不存在（diff 两端均须有效）');
      const side = (v: StrategyVersionRowDto) => ({
        id: v.id, strategy_id: v.strategy_id, version: v.version, status: v.status, code: v.code,
      });
      return { from: side(f), to: side(t) };
    },
    async runStrategyTest(req: StrategyTestRunReq): Promise<StrategyTestRunResp> {
      if ((req.code !== undefined) === (req.versionId !== undefined)) {
        throw new ApiError(400, 'HTTP 400: code 与 version_id 须且仅须提供一个');
      }
      if (!req.symbol.trim()) throw new ApiError(400, 'HTTP 400: symbol（标的代码）必填');
      if (req.mode !== 'pure_score' && req.mode !== 'sim_position') {
        throw new ApiError(400, 'HTTP 400: mode 须为 pure_score/sim_position');
      }
      const fromMs = Date.parse(req.from);
      const toMs = Date.parse(req.to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
        throw new ApiError(400, 'HTTP 400: from 须早于 to');
      }
      // 区间上限校验（复刻后端：D1 ≤ 5 年 / 分钟级 ≤ 3 个月 → 400）
      const spanDays = Math.round((toMs - fromMs) / 86_400_000);
      const limitDays =
        req.period === 'D1' ? MOCK_TESTRUN_D1_MAX_SPAN_DAYS : MOCK_TESTRUN_MINUTE_MAX_SPAN_DAYS;
      if (spanDays > limitDays) {
        throw new ApiError(
          400,
          `HTTP 400: 试算区间超限：${req.period} 跨度 ${spanDays} 天 > 上限 ${limitDays} 天`,
        );
      }
      if (req.versionId && !strategyStore.versions.some((x) => x.id === req.versionId)) {
        throw new ApiError(404, `HTTP 404: 版本 ${req.versionId} 不存在`);
      }
      const code = req.code ?? strategyStore.versions.find((x) => x.id === req.versionId)!.code;
      if (!code.includes('on_bar')) throw new ApiError(400, 'HTTP 400: 插件缺少 on_bar');
      // 确定性评分序列（由 code+symbol 哈希驱动，30 点），sim_position 补信号/成交/事件
      const seed = `${code.length}:${req.symbol}`;
      const n = 30;
      const step = Math.max(60, Math.floor((toMs - fromMs) / 1000 / n));
      const scores = Array.from({ length: n }, (_, i) => ({
        ts: Math.floor(fromMs / 1000) + i * step,
        score: Math.round(rand01(`${seed}:${i}`) * 100),
      }));
      const signals = req.mode === 'sim_position'
        ? scores.map((p) => ({ ts: p.ts, signal: p.score >= 60 ? 'buy' : p.score <= 40 ? 'sell' : 'hold' }))
        : [];
      const trades: StrategyTradeDetail[] = req.mode === 'sim_position'
        ? [{
            open_ts: scores[2]!.ts, close_ts: scores[10]!.ts, open_bar: 2, close_bar: 10,
            open_price: 2.4, close_price: 2.52, shares: 1000, gross_value: 2520,
            commission: 5, stamp_duty: 1.26, pnl: 113.74, hold_bars: 8,
          }]
        : [];
      const events = [{ type: 'log', bar_index: 0, message: 'mock 试算事件（契约桩）' }];
      return {
        mode: req.mode,
        symbol: req.symbol,
        period: req.period,
        bar_count: n,
        scores,
        signals,
        trades,
        events,
        truncated: { scores: false, events: false, trades: false },
      };
    },
    // ── 页面⑪ 回测工作台（§1.8；mock 行为与后端契约同构）──
    // 与旧回测 mock 同先例：submit 同步落终态（succeeded + 结果可取），异步进度由 WS 测试桩驱动。
    async submitWorkbenchRun(req: WorkbenchSubmitReq): Promise<WorkbenchRunView> {
      // web 层预校验同构（workbench.rs submit_run）：symbol 空/未注册、period、from/to、slots、fee
      if (!req.symbol.trim()) throw new ApiError(400, 'HTTP 400: symbol 必填');
      if (!symbols.some((s) => s.code === req.symbol)) {
        throw new ApiError(400, `HTTP 400: symbol ${req.symbol} 未注册`);
      }
      if (!['M1', 'M5', 'M15', 'D1'].includes(req.period)) {
        throw new ApiError(400, 'HTTP 400: period 须为 M1/M5/M15/D1');
      }
      const fromMs = Date.parse(req.from);
      const toMs = Date.parse(req.to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new ApiError(400, 'HTTP 400: from/to 须为 RFC3339');
      if (fromMs >= toMs) throw new ApiError(400, 'HTTP 400: from 须早于 to');
      if (req.slots.length === 0 || req.slots.length > 10) {
        throw new ApiError(400, 'HTTP 400: slots 必填（1..=10）');
      }
      for (const key of ['rate_pct', 'min_fee', 'slippage_bp'] as const) {
        if (typeof req.fee?.[key] !== 'number') throw new ApiError(400, `HTTP 400: fee.${key} 缺失或应为数值`);
      }
      // 服务层校验同构：weight>0、版本存在(404)/published、params 按 schema 缺省填充并越界检查、阈值不倒挂
      const buy = req.buy_threshold ?? 60;
      const sell = req.sell_threshold ?? 40;
      if (buy <= sell) throw new ApiError(400, 'HTTP 400: 阈值倒挂（buy_threshold 须 > sell_threshold）');
      const pinnedSlots: WorkbenchPinnedSlot[] = req.slots.map((s) => {
        if (!(s.weight > 0)) throw new ApiError(400, 'HTTP 400: weight 须 > 0');
        const v = strategyStore.versions.find((x) => x.id === s.version_id);
        if (!v) throw new ApiError(404, `HTTP 404: 版本 ${s.version_id} 不存在`);
        if (v.status !== 'published') throw new ApiError(400, `HTTP 400: 版本 ${s.version_id} 非 published`);
        // 未知参数键拒绝（对齐后端 fill_and_validate_params：schema 未声明的键 → 400）
        for (const k of Object.keys(s.params ?? {})) {
          if (!v.params_schema.some((p) => p.key === k)) {
            throw new ApiError(400, `HTTP 400: 未知参数键: ${k}（schema 未声明）`);
          }
        }
        const params: Record<string, number> = {};
        for (const p of v.params_schema) {
          const val = s.params?.[p.key] ?? p.default;
          if (typeof val !== 'number' || Number.isNaN(val)) throw new ApiError(400, `HTTP 400: 参数 ${p.key} 须为数值`);
          if ((p.min !== undefined && val < p.min) || (p.max !== undefined && val > p.max)) {
            throw new ApiError(400, `HTTP 400: 参数 ${p.key} 越 schema 范围`);
          }
          params[p.key] = val;
        }
        return {
          strategy_id: v.strategy_id,
          version_id: v.id,
          version: v.version,
          sha256: v.sha256,
          params,
          weight: s.weight,
        };
      });
      const policy = req.policy as Record<string, unknown> | undefined;
      if (!policy || (!policy.LumpSum && !policy.Dca)) throw new ApiError(400, 'HTTP 400: policy 非法');
      const config: WorkbenchRunConfig = {
        slots: pinnedSlots,
        buy_threshold: buy,
        sell_threshold: sell,
        policy: req.policy,
        stop: req.stop ?? null,
        initial_capital: req.initial_capital ?? 100_000,
        fee: req.fee,
      };
      const id = `sr_mock_${workbenchSeq}`;
      workbenchSeq += 1;
      const nowIso = new Date(anchorNow).toISOString();
      const view: WorkbenchRunView = {
        id,
        name: req.name ?? '',
        symbol: req.symbol,
        period: req.period,
        from_ts: new Date(fromMs).toISOString(),
        to_ts: new Date(toMs).toISOString(),
        config,
        status: 'succeeded',
        progress: 1,
        error: null,
        created_at: nowIso,
        started_at: nowIso,
        finished_at: nowIso,
      };
      workbenchRuns.set(id, { view, result: mockWorkbenchResult(id, config, fromMs, toMs) });
      return { ...view };
    },
    async listWorkbenchRuns(filter?: {
      status?: WorkbenchRunStatus;
      limit?: number;
      offset?: number;
    }): Promise<WorkbenchRunView[]> {
      let out = [...workbenchRuns.values()].map((r) => r.view);
      if (filter?.status) out = out.filter((r) => r.status === filter.status);
      // 与后端同序：created_at DESC, id DESC
      out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 100;
      return out.slice(offset, offset + Math.max(0, limit)).map((v) => ({ ...v }));
    },
    async getWorkbenchRun(id: string): Promise<WorkbenchRunView> {
      const r = workbenchRuns.get(id);
      if (!r) throw new ApiError(404, `HTTP 404: run ${id} 不存在`);
      return { ...r.view };
    },
    async getWorkbenchResult(id: string): Promise<WorkbenchRunResult> {
      const r = workbenchRuns.get(id);
      if (!r || r.view.status !== 'succeeded' || !r.result) {
        throw new ApiError(404, `HTTP 404: run ${id} 未知或未成功（无结果）`);
      }
      return r.result;
    },
    async cancelWorkbenchRun(id: string): Promise<WorkbenchRunView> {
      const r = workbenchRuns.get(id);
      if (!r) throw new ApiError(404, `HTTP 404: run ${id} 不存在`);
      if (r.view.status !== 'queued' && r.view.status !== 'running') {
        throw new ApiError(409, `HTTP 409: run ${id} 已终态（${r.view.status}），不可取消`);
      }
      r.view = { ...r.view, status: 'canceled', finished_at: new Date(anchorNow).toISOString() };
      return { ...r.view };
    },
    async compareWorkbenchRuns(ids: string[]): Promise<WorkbenchCompareItem[]> {
      if (ids.length === 0) throw new ApiError(400, 'HTTP 400: ids 必填（run id 数组）');
      const out: WorkbenchCompareItem[] = [];
      for (const id of ids) {
        const r = workbenchRuns.get(id);
        if (!r || r.view.status !== 'succeeded' || !r.result) continue; // 未知/未成功跳过
        out.push({
          run_id: id,
          name: r.view.name,
          symbol: r.view.symbol,
          period: r.view.period,
          net_value: r.result.net_value,
          metrics: r.result.metrics,
        });
      }
      return out;
    },
    async listWorkbenchPresets(): Promise<WorkbenchPresetRow[]> {
      return [...workbenchPresets.values()]
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .map((p) => ({ ...p }));
    },
    async createWorkbenchPreset(req: { name: string; config: WorkbenchRunConfig }): Promise<WorkbenchPresetRow> {
      const name = req.name.trim();
      if (!name) throw new ApiError(400, 'HTTP 400: name 必填');
      if (!req.config?.slots || req.config.slots.length === 0) {
        throw new ApiError(400, 'HTTP 400: 配置非法（slots 空）');
      }
      if ([...workbenchPresets.values()].some((p) => p.name === name)) {
        throw new ApiError(409, `HTTP 409: 预设名 ${name} 重名`);
      }
      const id = `sp_mock_${workbenchPresetSeq}`;
      workbenchPresetSeq += 1;
      const nowIso = new Date(anchorNow).toISOString();
      const row: WorkbenchPresetRow = { id, name, config: req.config, created_at: nowIso, updated_at: nowIso };
      workbenchPresets.set(id, row);
      return { ...row };
    },
    async getWorkbenchPreset(id: string): Promise<WorkbenchPresetRow> {
      const p = workbenchPresets.get(id);
      if (!p) throw new ApiError(404, `HTTP 404: 预设 ${id} 不存在`);
      return { ...p };
    },
    async updateWorkbenchPreset(id: string, req: { name: string; config: WorkbenchRunConfig }): Promise<WorkbenchPresetRow> {
      const name = req.name.trim();
      if (!name) throw new ApiError(400, 'HTTP 400: name 必填');
      if (!req.config?.slots || req.config.slots.length === 0) {
        throw new ApiError(400, 'HTTP 400: 配置非法（slots 空）');
      }
      const p = workbenchPresets.get(id);
      if (!p) throw new ApiError(404, `HTTP 404: 预设 ${id} 不存在`);
      if ([...workbenchPresets.values()].some((x) => x.id !== id && x.name === name)) {
        throw new ApiError(409, `HTTP 409: 预设名 ${name} 重名`);
      }
      const next: WorkbenchPresetRow = { ...p, name, config: req.config, updated_at: new Date(anchorNow).toISOString() };
      workbenchPresets.set(id, next);
      return { ...next };
    },
    async deleteWorkbenchPreset(id: string): Promise<void> {
      if (!workbenchPresets.delete(id)) throw new ApiError(404, `HTTP 404: 预设 ${id} 不存在`);
    },
    async applyWorkbenchPreset(id: string): Promise<WorkbenchRunConfig> {
      const p = workbenchPresets.get(id);
      if (!p) throw new ApiError(404, `HTTP 404: 预设 ${id} 不存在`);
      return p.config;
    },
  };
}

/** 页面⑨ 模拟实盘 mock 种子（活跃会话 + 账户/持仓/订单 + 3 策略评估 + 历史会话）。
 *  确定性生成，无实时行情；与后端同构（§1.6）。 */
interface SimLiveSeed {
  session: SimSession;
  account: {
    session_id: string; cash: number; equity: number; market_value: number;
    realized_pnl: number; unrealized_pnl: number; total_fee: number;
  };
  positions: Array<{ code: string; qty: number; avg_cost: number; latest: number;
    market_value: number; unrealized_pnl: number }>;
  orders: Array<{ id: string; code: string; side: 'buy' | 'sell'; qty: number;
    limit_price: number | null; status: 'pending' | 'filled' | 'cancelled';
    filled_price: number | null; filled_qty: number; fee: number; ts: number; source: string }>;
  pnl: { realized_pnl: number; unrealized_pnl: number; total_fee: number; net_profit: number };
  trading_enabled: boolean;
  mcp_enabled: boolean;
  strategies: SimStrategiesDto;
  history: SimSessionListEntry[];
  /** ADR §4 多策略：每策略明细（id/params/stocks/weight/stock_weights）；空 = 简单档。 */
  strategiesDetail: SimStrategyConfigInput[];
}

function seedSimLiveState(now: number): SimLiveSeed {
  const gold = { code: '518880', qty: 50_000, avg_cost: 8.65, latest: 9.165 };
  const csi500 = { code: '159577', qty: 280_000, avg_cost: 1.51, latest: 1.761 };
  const mk = (p: { code: string; qty: number; avg_cost: number; latest: number }) => ({
    ...p,
    market_value: round4(p.qty * p.latest),
    unrealized_pnl: round4((p.latest - p.avg_cost) * p.qty),
  });
  const positions = [mk(gold), mk(csi500)];
  const market_value = round4(positions.reduce((s, p) => s + p.market_value, 0));
  const unrealized = round4(positions.reduce((s, p) => s + p.unrealized_pnl, 0));
  const cash = round4(312_842.1);
  const realized = round4(12_408.3);
  const total_fee = round4(1_230.5);
  const session: SimSession = {
    id: `s_${now}`,
    name: '黄金ETF+中证500 策略',
    status: 'running',
    source: 'web',
    cash_init: 1_000_000,
    strategy_set: ['dual_ma', 'macd', 'ma_rsi'],
    stock_set: ['518880', '159577', '161226'],
    period: 'M1',
    start_ts: new Date(now).toISOString(),
    end_ts: null,
  };
  const stocks: SimStrategiesDto['stocks'] = [
    { code: '518880', ts: now, latest_price: 9.165,
      per_strategy_scores: [{ strategy_id: 'dual_ma', score: 86, signal: 'buy' },
        { strategy_id: 'macd', score: 12, signal: 'hold' },
        { strategy_id: 'ma_rsi', score: 64, signal: 'buy' }],
      aggregate_score: 72, signal: 'buy' },
    { code: '159577', ts: now, latest_price: 1.761,
      per_strategy_scores: [{ strategy_id: 'dual_ma', score: 51, signal: 'hold' },
        { strategy_id: 'macd', score: 3, signal: 'hold' },
        { strategy_id: 'ma_rsi', score: 21, signal: 'hold' }],
      aggregate_score: 28, signal: 'hold' },
    { code: '161226', ts: now, latest_price: 0.982,
      per_strategy_scores: [{ strategy_id: 'dual_ma', score: 8, signal: 'sell' },
        { strategy_id: 'macd', score: 15, signal: 'sell' },
        { strategy_id: 'ma_rsi', score: 31, signal: 'hold' }],
      aggregate_score: 18, signal: 'sell' },
  ];
  const nameMap: Record<string, string> = { dual_ma: '双均线交叉', macd: 'MACD 金叉', ma_rsi: '均线+RSI' };
  const strategies: SimStrategiesDto['strategies'] = Object.keys(nameMap).map((id) => {
    let strongest: { code: string; score: number; signal: 'buy' | 'sell' | 'hold' } | null = null;
    for (const st of stocks) {
      const s = st.per_strategy_scores.find((x) => x.strategy_id === id);
      if (s && (!strongest || s.score > strongest.score)) strongest = { code: st.code, score: s.score, signal: s.signal };
    }
    return { strategy_id: id, name: nameMap[id] ?? id, strongest };
  });
  const orders = [
    { id: `o_1`, code: '518880', side: 'buy' as const, qty: 10_000, limit_price: null, status: 'filled' as const,
      filled_price: 9.151, filled_qty: 10_000, fee: 22.88, ts: now - 60_000, source: 'strategy' },
    { id: `o_2`, code: '159577', side: 'buy' as const, qty: 20_000, limit_price: null, status: 'filled' as const,
      filled_price: 1.742, filled_qty: 20_000, fee: 8.71, ts: now - 30_000, source: 'manual' },
    { id: `o_3`, code: '161226', side: 'buy' as const, qty: 10_000, limit_price: 0.99, status: 'cancelled' as const,
      filled_price: null, filled_qty: 0, fee: 0, ts: now - 15_000, source: 'manual' },
  ];
  const history: SimSessionListEntry[] = [
    { session: { id: `s_old11`, name: '双均线+RSI', status: 'ended', source: 'web', cash_init: 1_000_000,
        strategy_set: ['dual_ma', 'ma_rsi'], stock_set: ['518880', '159577'], period: 'M1',
        start_ts: new Date(now - 5 * 86400_000).toISOString(), end_ts: new Date(now - 4 * 86400_000).toISOString(),
      },
      metrics: { net_profit: 64_200, max_drawdown: -3.1, sharpe: 1.28, win_rate: 0.625,
        profit_factor: 1.4, annualized_return: 0.18, trade_count: 24, avg_hold_bars: 90 } },
    { session: { id: `s_old10`, name: 'MACD', status: 'ended', source: 'web', cash_init: 1_000_000,
        strategy_set: ['macd'], stock_set: ['159577'], period: 'M1',
        start_ts: new Date(now - 12 * 86400_000).toISOString(), end_ts: new Date(now - 11 * 86400_000).toISOString(),
      },
      metrics: { net_profit: 21_800, max_drawdown: -1.7, sharpe: 0.84, win_rate: 0.55,
        profit_factor: 1.12, annualized_return: 0.06, trade_count: 18, avg_hold_bars: 120 } },
  ];
  return {
    session,
    account: { session_id: session.id, cash, equity: round4(cash + market_value), market_value,
      realized_pnl: realized, unrealized_pnl: unrealized, total_fee },
    positions,
    orders,
    pnl: { realized_pnl: realized, unrealized_pnl: unrealized, total_fee, net_profit: round4(realized + unrealized) },
    trading_enabled: true,
    mcp_enabled: true,
    strategies: { session_id: session.id, strategies, stocks },
    history,
    strategiesDetail: [],
  };
}

/** 模拟实盘策略名映射（sim-live 策略面板展示；与内置 3 款种子名同构）。 */
const SIM_STRATEGY_NAMES: Record<string, string> = {
  dual_ma: '双均线交叉',
  macd: 'MACD 金叉',
  ma_rsi: '均线+RSI',
};

/** 单策略信号（sim-live 聚合口径：≥60 buy，≤30 sell，否则 hold）。 */
function simSignal(score: number): 'buy' | 'sell' | 'hold' {
  if (score >= 60) return 'buy';
  if (score <= 30) return 'sell';
  return 'hold';
}

/** 合成单策略分（确定性哈希；供不在内置种子集的 stock×strategy 组合补位）。 */
function synthSimScore(code: string, strategyId: string): number {
  return Math.round(rand01(`sim:${code}:${strategyId}`) * 100);
}

/** 页面⑨ 模拟实盘：策略评估视图（每策略最强 + 每 stock 聚合/独立分）。
 *  由会话的 strategy_set/stock_set 派生（开会话选集即刻反映到面板/评分区）；
 *  不在内置种子集（518880/159577/161226 × dual_ma/macd/ma_rsi）的组合用确定性分补位。
 *  内置种子集保留原始分数/聚合/信号（兼容既有 mock 测试锁定值）。 */
function simStrategiesView(simLive: SimLiveSeed): SimStrategiesDto {
  const { strategy_set, stock_set } = simLive.session;
  const seedStocks = simLive.strategies.stocks;
  const seedStrategyIds = Array.from(
    new Set(seedStocks.flatMap((s) => s.per_strategy_scores.map((x) => x.strategy_id))),
  );
  // ADR §4 多策略：若提供每策略明细 → 用它（id/标的集/权重）；否则回退简单档（strategy_set × stock_set）。
  const detail = simLive.strategiesDetail;
  const useDetail = detail.length > 0;
  const strategyIds = useDetail
    ? detail.map((x) => x.strategy_id)
    : (strategy_set.length > 0 ? strategy_set : seedStrategyIds);
  const stockCodes = useDetail
    ? Array.from(new Set(detail.flatMap((x) => x.stocks)))
    : (stock_set.length > 0 ? stock_set : seedStocks.map((s) => s.code));
  // 权重 w[S,X] = stock_weights[X] ?? weight（策略×标的级；简单档恒 1.0）。
  const weightOf = (sid: string, code: string): number => {
    if (!useDetail) return 1.0;
    const s = detail.find((x) => x.strategy_id === sid);
    if (!s) return 1.0;
    return s.stock_weights?.[code] ?? s.weight ?? 1.0;
  };

  const stocks: SimStrategiesDto['stocks'] = stockCodes.map((code) => {
    const seed = seedStocks.find((x) => x.code === code);
    const per_strategy_scores: SimStrategyScore[] = strategyIds.map((sid) => {
      const seedScore = seed?.per_strategy_scores.find((x) => x.strategy_id === sid);
      if (seedScore) return { strategy_id: sid, score: seedScore.score, signal: seedScore.signal };
      const score = synthSimScore(code, sid);
      return { strategy_id: sid, score, signal: simSignal(score) };
    });
    const fullySeeded =
      !useDetail &&
      seed != null &&
      strategyIds.length === seed.per_strategy_scores.length &&
      strategyIds.every((sid) => seed.per_strategy_scores.some((x) => x.strategy_id === sid));
    if (fullySeeded && seed) {
      return {
        code, ts: seed.ts, latest_price: seed.latest_price,
        per_strategy_scores, aggregate_score: seed.aggregate_score, signal: seed.signal,
      };
    }
    // 聚合评分 = Σ(w[S,X]·score)/Σ(w[S,X])（策略×标的权重；简单档各向 1）。
    const wsum = per_strategy_scores.reduce((s, x) => s + weightOf(x.strategy_id, code), 0);
    const agg = wsum > 0
      ? Math.round(per_strategy_scores.reduce((s, x) => s + weightOf(x.strategy_id, code) * x.score, 0) / wsum)
      : 50;
    return {
      code, ts: seed?.ts ?? Date.now(),
      latest_price: seed?.latest_price ?? (BASE_PRICE[code] ?? 1),
      per_strategy_scores, aggregate_score: agg, signal: simSignal(agg),
    };
  });

  const strategies: SimStrategiesDto['strategies'] = strategyIds.map((sid) => {
    let strongest: { code: string; score: number; signal: 'buy' | 'sell' | 'hold' } | null = null;
    for (const st of stocks) {
      const s = st.per_strategy_scores.find((x) => x.strategy_id === sid);
      if (s && (!strongest || s.score > strongest.score)) strongest = { code: st.code, score: s.score, signal: s.signal };
    }
    const cfg = useDetail ? detail.find((x) => x.strategy_id === sid) : undefined;
    return {
      strategy_id: sid,
      name: SIM_STRATEGY_NAMES[sid] ?? sid,
      strongest,
      // P4a：config 槽 = Registry 钉住快照形状（version_id/version/sha256 + params/stocks/权重）。
      config: cfg ? {
        version_id: `sv_mock_${cfg.strategy_id}_v1`,
        version: 1,
        sha256: mockSha(cfg.strategy_id),
        params: cfg.params ?? {},
        stocks: cfg.stocks,
        weight: cfg.weight ?? 1.0,
        stock_weights: cfg.stock_weights ?? {},
      } : null,
    };
  });

  return { session_id: simLive.session.id, strategies, stocks };
}

/** 页面⑨ 把 pnl 快照映射为 BacktestMetrics jsonb 摘要（历史会话指标；口径 08-backtest）。 */
function toSimMetrics(pnl: SimLiveSeed['pnl']): Record<string, unknown> {
  return {
    net_profit: pnl.net_profit,
    max_drawdown: -1.2,
    sharpe: 1.0,
    win_rate: 0.6,
    profit_factor: 1.2,
    annualized_return: 0.1,
    trade_count: 20,
    avg_hold_bars: 90,
  };
}

/** 页面⑧ 内置源配置快照（08-settings §8；等同 SETTINGS_DEFAULTS 默认值，只读不落库）。
 *  内置源清单与 frontend sourceMeta 同构；push2delay（东财系）rotation_locked=true（ADR-006）。 */
function mockSourceConfig(): SourceConfigItem[] {
  const base = {
    rate_per_sec: 1,
    jitter_ms: 0,
    circuit_fail_count: 3,
    backoff_steps: ['5s', '10s', '30s'],
    enabled: true,
  };
  return [
    { id: 'tencent_ifzq', label: '腾讯ifzq', role: '1m', ...base, rotation_locked: false },
    { id: 'sina_jsonp', label: '新浪jsonp', role: '1m', ...base, rotation_locked: false },
    { id: 'tencent_qt', label: '腾讯qt', role: 'snapshot', ...base, rotation_locked: false },
    { id: 'sina_hq', label: '新浪hq', role: 'snapshot', ...base, rotation_locked: false },
    { id: 'ths_cs', label: '同花顺', role: 'snapshot', ...base, rotation_locked: false },
    { id: 'exchange', label: '交易所', role: 'snapshot', ...base, rotation_locked: false },
    { id: 'tushare', label: 'tushare（历史层）', role: 'snapshot', ...base, rotation_locked: false },
    { id: 'push2delay', label: 'push2delay（东财系）', role: 'snapshot', ...base, rotation_locked: true }, // ADR-006 末位
  ];
}

/** 页面④ 分歧对照 mock 行（|偏差| 降序；两 1m 源交替归属，少量超阈分歧） */
function mockDivergenceRows(code: string): QualityDivergenceRow[] {
  const base = BASE_PRICE[code] ?? 1;
  const rows: QualityDivergenceRow[] = [];
  const start = Date.UTC(2026, 8, 1, 1, 30); // 2026-09-01 09:30 CST
  for (let i = 0; i < 24; i++) {
    const r = rand01(`${code}:div:${i}`);
    // 大多数 |偏差| ≤0.3%（一致），少数 0.5%-2%（分歧）
    const dev = r < 0.8 ? r * 0.375 : 0.5 + (r - 0.8) * 7.5;
    const sign = rand01(`${code}:sign:${i}`) < 0.5 ? -1 : 1;
    const accurate = round3(base * (1 + (rand01(`${code}:acc:${i}`) - 0.5) * 0.02));
    rows.push({
      ts: new Date(start + i * 17 * 60_000).toISOString(),
      raw_close: round3(accurate * (1 + (sign * dev) / 100)),
      accurate_close: accurate,
      deviation_pct: sign * dev,
      raw_source: i % 2 === 0 ? 'tencent_ifzq' : 'sina_jsonp',
    });
  }
  rows.sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct));
  return rows;
}
