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
};

const BASE_PRICE: Record<string, number> = {
  '518880': 2.4,
  '513310': 1.58,
  '161226': 0.98,
  '159776': 0.87,
};

function initialSymbols(): SymbolRow[] {
  return [
    { code: '518880', name: '黄金ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:23:00Z', last: 2.431, change_pct: 0.62 }, today_bars: 205 },
    { code: '513310', name: '纳指ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:23:00Z', last: 1.587, change_pct: -0.31 }, today_bars: 189 },
    { code: '161226', name: '白银LOF', interval_secs: 300, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:20:00Z', last: 0.982, change_pct: 1.15 }, today_bars: 41 },
    { code: '159776', name: '港股通医药', interval_secs: 60, settlement: 'T1', enabled: false, latest: null, today_bars: 0 },
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

export function createMockClient(opts: MockOptions = {}): ApiClient {
  const anchorNow = opts.now?.getTime() ?? Date.now();
  let symbols = initialSymbols();
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

  const createBacktestRun = (
    req: BacktestSubmitReq,
    params: Record<string, unknown>,
    groupId: string | null,
  ): BacktestRunDto => makeDoneRun(req, params, nextBacktestRunId++, groupId, anchorNow);

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
      return symbols.map((s) => ({
        code: s.code,
        name: s.name ?? s.code,
        enabled: s.enabled,
        last: s.latest?.last ?? null,
        changePct: s.latest?.change_pct ?? 0,
      }));
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
      return symbols.map((s) => ({ ...s }));
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
      return { sources: mockSourceConfig() };
    },
    async getConfigCollector(): Promise<CollectorConfigSnapshot> {
      return { default_interval_sec: 60, trading_hours: '09:30-11:30/13:00-15:00' };
    },
    async getConfigMcp(): Promise<McpConfigSnapshot> {
      return { enabled: true, trading_tools_enabled: false, daily_limit_amount: 50000, daily_limit_count: 20 };
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
    async listRuns(filter?: { status?: BacktestStatus; groupId?: string }): Promise<BacktestRunDto[]> {
      let out = backtestRuns.slice();
      if (filter?.status) out = out.filter((r) => r.status === filter.status);
      if (filter?.groupId) out = out.filter((r) => r.group_id === filter.groupId);
      return out.map((r) => ({ ...r }));
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
    { id: 'push2delay', label: 'push2delay（东财系）', role: 'snapshot', ...base, rotation_locked: true },
    { id: 'exchange', label: '交易所', role: 'snapshot', ...base, rotation_locked: false },
    { id: 'tushare', label: 'tushare（历史层）', role: 'snapshot', ...base, rotation_locked: false },
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
