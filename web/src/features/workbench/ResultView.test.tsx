import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Trade,
  WorkbenchBarRecord,
  WorkbenchRunAudit,
  WorkbenchRunResult,
  WorkbenchRunView,
} from '@/api/types';
import type { ApiClient } from '@/api/client';
import { createMockClient } from '@/api/mock';
import { ResultView } from './ResultView';
import { buildMarkers } from './KlineResultChart';
import { fillsFromPerBar } from './useRunSeries';

// jsdom 无 canvas：klinecharts 整体打桩（与 BacktestPage.test 同模式）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  /** P0.1-D 补桩：`addOverlayIndicator` 的非空断言需要 `getIndicators({ name })`；
   *  由 create/remove 调用记录派生（语义见 `@/test/chartStoreStub`），不引入跨用例状态。 */
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {})),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setBarSpace: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
  registerOverlay: vi.fn(),
}));

const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });

/**
 * ADR-026 §2.2 冻结基准（与 `coder/evidence/20260919_adr026_backend/43_raw_audit_A3_A4.json.txt`
 * 中目标 run `sr_1789738328788_000005` 的真实响应逐字段同值；字段名以实际响应为准）。
 */
const AUDIT_BASELINE: WorkbenchRunAudit = {
  run_id: 'sr_1789738328788_000005',
  recorded: true,
  capital_basis: 100000,
  deployed_notional: 41397.97208076086,
  deployed_pct: 0.4139797208076086,
  cash_consumed: 41607.97208076086,
  cash_consumed_pct: 0.41607972080760863,
  planned_tranches: 100,
  reachable_batches: 43,
  batches_done: 42,
  unexecuted_orders: 1,
  last_bar_unfilled: true,
  round_trips_total: 1,
  round_trips_force_closed: 1,
  warnings: [
    {
      code: 'DCA_PLAN_UNDERFILLED',
      severity: 'warn',
      message: '计划 100 批，区间内最多可推进 43 批、已成交 42 批（剩余批次随买入区结束取消）',
    },
    { code: 'PARTIAL_DEPLOYMENT', severity: 'warn', message: '名义投入 41.40% 初始资金，年化/回撤/夏普分母仍为初始资金' },
    { code: 'ORDERS_UNEXECUTED', severity: 'info', message: '1 笔挂单未成交（末根 bar 无次 bar 可执行）' },
  ],
};

/** 只替换 `getRunAudit` 的契约 mock 客户端（其余方法照常走 mock）。 */
function apiWithAudit(impl: ApiClient['getRunAudit']): ApiClient {
  return { ...api, getRunAudit: impl };
}

const SUBMIT_BASE = {
  symbol: '518880',
  period: 'D1',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  policy: { LumpSum: { position_pct: 1 } } as const,
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
};

/** 提交 run（mock 新提交 run = `chunked_v1`，ADR-024 P4 语义）并取回 `/result` 兼容响应。 */
async function seedRunAndResult(
  client: ApiClient = api,
): Promise<{ run: WorkbenchRunView; result: WorkbenchRunResult }> {
  const run = await client.submitWorkbenchRun({
    ...SUBMIT_BASE,
    name: '结果测试',
    slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    stop: { kind: 'FixedPct', value: 0.08, trigger: 'Intrabar' },
  });
  const result = await client.getWorkbenchResult(run.id);
  return { run, result };
}

/** 种子 run（= 旧 `legacy_single` run，双读不回填）→ 用于 legacy 路径零回归用例。 */
async function seededLegacyRun(client: ApiClient = api): Promise<{ run: WorkbenchRunView; result: WorkbenchRunResult }> {
  const run = await client.getWorkbenchRun('sr_mock_seed1');
  const result = await client.getWorkbenchResult(run.id);
  return { run, result };
}

function mkProps(run: WorkbenchRunView | null, result: WorkbenchRunResult | null, over: Record<string, unknown> = {}) {
  return {
    run,
    result,
    loading: false,
    error: null as string | null,
    onRetry: vi.fn(),
    api,
    catalog: null,
    ...over,
  } as const;
}

describe('ResultView（ADR §13.5 结果页布局）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未选中 run → 占位；failed run → error 展示；结果加载失败 → 错误+重试', async () => {
    const { unmount } = render(<ResultView {...mkProps(null, null)} />);
    expect(screen.getByTestId('wb-result-empty')).toBeInTheDocument();
    unmount();

    const failedRun = (await api.listWorkbenchRuns({ status: 'failed' }))[0]!;
    render(<ResultView {...mkProps(failedRun, null)} />);
    expect(screen.getByTestId('wb-run-error')).toHaveTextContent('mock 引擎错误');
  });

  it('结果渲染：K线容器 + 总分曲线（阈值线+三区着色）+ 各策略曲线 + 净值回撤 + 默认 Tab 交易明细', async () => {
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    expect(screen.getByTestId('wb-kline-chart')).toBeInTheDocument();
    // ADR-024 P6：chunked ⇒ 曲线经 /curve 异步取数（显式抽样）
    expect(await screen.findByTestId('wb-aggregate-chart')).toBeInTheDocument();
    expect(screen.getByTestId('threshold-buy')).toBeInTheDocument();
    expect(screen.getByTestId('threshold-sell')).toBeInTheDocument();
    expect(screen.getByTestId('zone-buy')).toBeInTheDocument();
    expect(screen.getByTestId('zone-hold')).toBeInTheDocument();
    expect(screen.getByTestId('zone-sell')).toBeInTheDocument();
    // 各策略评分曲线（图例开关，默认前 3 → 单 slot 默认开）
    expect(screen.getByTestId('wb-slot-chart')).toBeInTheDocument();
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    // 净值+回撤
    expect(screen.getByTestId('wb-equity-chart')).toBeInTheDocument();
    // 默认 Tab：交易明细
    expect(screen.getByTestId('wb-tab-trades')).toBeInTheDocument();
    expect(screen.getByTestId('wb-trades-table')).toBeInTheDocument();
  });

  it('Tab 切换：8项绩效 / 逐bar评分表 / 事件日志（含插件错误与 log）', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    await user.click(screen.getByTestId('wb-tab-metrics'));
    expect(screen.getByTestId('wb-metrics-table')).toHaveTextContent('net_profit');
    expect(screen.getByTestId('wb-metrics-table')).toHaveTextContent('avg_hold_bars');
    await user.click(screen.getByTestId('wb-tab-perbar'));
    expect(screen.getByTestId('wb-perbar-table')).toBeInTheDocument();
    await user.click(screen.getByTestId('wb-tab-events'));
    const log = screen.getByTestId('wb-event-log');
    expect(log).toHaveTextContent('plugin_log');
    expect(log).toHaveTextContent('mock log bar=0');
    expect(log).toHaveTextContent('plugin_error');
  });

  it('legacy_single 路径零回归：从 /result 内联列同步派生，且不请求 /curve', async () => {
    const spy = vi.spyOn(api, 'getWorkbenchCurve');
    const { run, result } = await seededLegacyRun();
    expect(result.result_format).toBe('legacy_single');
    render(<ResultView {...mkProps(run, result)} />);
    // 同步渲染（无 await）
    expect(screen.getByTestId('wb-aggregate-chart')).toBeInTheDocument();
    expect(screen.getByTestId('wb-equity-chart')).toBeInTheDocument();
    expect(screen.getByTestId('wb-aggregate-sampling')).toHaveTextContent('共 60 bar');
    expect(spy).not.toHaveBeenCalled();
    // ADR-026：默认 Tab（交易明细）会异步取审计 ⇒ 等其落地，免测试结束后才 setState
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
  });

  it('逐bar评分表分页：>100 行分页器可见且翻页（legacy 全量内联列路径）', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    // 合成 250 bar 的 **legacy** 结果（chunked 由 /bars 分页，见「长区间」用例）
    const perBar: WorkbenchBarRecord[] = Array.from({ length: 250 }, (_, i) => ({
      ts: result.per_bar[0]!.ts + i * 86_400,
      scores: [{ slot_idx: 0, score: i % 101 }],
      aggregate: i % 101,
      signal: 'Hold' as const,
      orders: [],
      events: [],
    }));
    render(
      <ResultView
        {...mkProps(run, { ...result, result_format: 'legacy_single', per_bar: perBar })}
      />,
    );
    await user.click(screen.getByTestId('wb-tab-perbar'));
    expect(screen.getByTestId('wb-perbar-page-info')).toHaveTextContent('1 / 3');
    expect(screen.getByTestId('wb-perbar-coverage')).toHaveTextContent('已加载 250 根');
    expect(screen.queryByTestId('wb-perbar-more-note')).toBeNull(); // legacy 全量 ⇒ 无更多
    expect(screen.getAllByTestId(/^wb-perbar-row-/).length).toBe(100);
    await user.click(screen.getByTestId('wb-perbar-next'));
    expect(screen.getByTestId('wb-perbar-page-info')).toHaveTextContent('2 / 3');
  });

  it('图例开关：取消勾选 → 该策略曲线移除', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    const chart = await screen.findByTestId('wb-slot-chart');
    expect(chart.querySelectorAll('polyline').length).toBe(1);
    await user.click(screen.getByTestId('legend-slot-0'));
    expect(chart.querySelectorAll('polyline').length).toBe(0);
  });

  it('buildMarkers：成交事实源 → B/S 标记；StopTrigger → ⊗ 不同图标', async () => {
    const { result } = await seedRunAndResult();
    const fills = fillsFromPerBar(result.per_bar);
    const markers = buildMarkers(fills);
    expect(markers.length).toBeGreaterThan(0);
    const buy = markers.find((m) => m.text === 'B');
    const stop = markers.find((m) => m.text === '⊗');
    expect(buy).toBeTruthy();
    expect(stop).toBeTruthy(); // 种子含 FixedPct 止损 → 中段 StopTrigger 强平
    expect(stop!.color).not.toBe(buy!.color);
    // 普通平仓 S（mock 期末 ForceClose 或 Sell 信号）
    expect(markers.some((m) => m.text === 'S')).toBe(true);
    // 标记数与成交事实源一一对应（不抽样、不漏）
    expect(markers.length).toBe(fills.length);
  });

  it('loading 骨架；结果 404（未成功）→ 错误+重试', async () => {
    const { run } = await seedRunAndResult();
    const { unmount } = render(<ResultView {...mkProps(run, null, { loading: true })} />);
    expect(screen.getByTestId('wb-result-skeleton')).toBeInTheDocument();
    unmount();
    const onRetry = vi.fn();
    render(<ResultView {...mkProps(run, null, { error: 'HTTP 404: 无结果', onRetry })} />);
    expect(screen.getByTestId('wb-result-error')).toHaveTextContent('404');
    await userEvent.setup().click(screen.getByText('重试'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('切换 run（无中间 loading 重挂载）：图例勾选态不跨 run 泄漏，默认前 3 按新 run slots 重新生效', async () => {
    const user = userEvent.setup();
    // 本用例锁定「图例 reconcile」语义（与取数路径无关）→ 用 legacy 形态保持同步渲染。
    const runA = await api.submitWorkbenchRun({
      ...SUBMIT_BASE,
      slots: [
        { version_id: 'sv_mock_dual_v1', weight: 1 },
        { version_id: 'sv_mock_tpl_v1', weight: 2 },
      ],
    });
    const resultA = { ...(await api.getWorkbenchResult(runA.id)), result_format: 'legacy_single' as const };
    const runB = await api.submitWorkbenchRun({ ...SUBMIT_BASE, slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }] });
    const resultB = { ...(await api.getWorkbenchResult(runB.id)), result_format: 'legacy_single' as const };
    const { rerender } = render(<ResultView {...mkProps(runA, resultA)} />);
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByTestId('legend-slot-0'));
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(false);
    // 直接 rerender 到 runB（模拟无 loading 间隙的切换）→ 勾选态按 runB slots 重置为默认
    rerender(<ResultView {...mkProps(runB, resultB)} />);
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('legend-slot-1')).toBeNull();
    // 切回 runA → 默认前 3 重新生效（不残留上次取消勾选）
    rerender(<ResultView {...mkProps(runA, resultA)} />);
    expect((screen.getByTestId('legend-slot-0') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('legend-slot-1') as HTMLInputElement).checked).toBe(true);
    // ADR-026：每次切 run 会重取审计（run 变）⇒ 等最后一次落地，免 act 噪声
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
  });

  it('自定义阈值 70/30：阈值线/三区着色按 70/30 渲染（非默认 60/40）', async () => {
    const run = await api.submitWorkbenchRun({
      ...SUBMIT_BASE,
      name: '阈值测试',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
      buy_threshold: 70,
      sell_threshold: 30,
    });
    const result = await api.getWorkbenchResult(run.id);
    render(<ResultView {...mkProps(run, result)} />);
    const chart = await screen.findByTestId('wb-aggregate-chart');
    expect(chart).toHaveTextContent('买入阈 70 / 卖出阈 30');
    // 阈值线 y 位置按 70/30 映射（H=160, PAD=8：y(s)=8+(1-s/100)*144）
    const yBuy = Number(screen.getByTestId('threshold-buy').getAttribute('y1'));
    const ySell = Number(screen.getByTestId('threshold-sell').getAttribute('y1'));
    expect(yBuy).toBeCloseTo(8 + 0.3 * 144, 1); // 70 → 51.2
    expect(ySell).toBeCloseTo(8 + 0.7 * 144, 1); // 30 → 108.8
    // 三区：hold 区高度 = y(30)-y(70) ≈ 57.6（默认 60/40 时为 28.8）
    const zoneHold = screen.getByTestId('zone-hold');
    expect(Number(zoneHold.getAttribute('height'))).toBeCloseTo(0.4 * 144, 1);
    expect(Number(zoneHold.getAttribute('y'))).toBeCloseTo(8 + 0.3 * 144, 1);
  });

  it('头部进度叠加 progressMap（与 RunList 同模式）：running run 实时进度覆盖 REST 行进度', async () => {
    const running = (await api.listWorkbenchRuns({ status: 'running' }))[0]!;
    expect(running.progress).toBe(0.42);
    const { unmount } = render(<ResultView {...mkProps(running, null)} />);
    expect(screen.getByTestId('wb-run-progress')).toHaveTextContent('42%');
    unmount();
    render(
      <ResultView
        {...mkProps(running, null, {
          progressMap: { [running.id]: { progress: 0.87, barTs: null } },
        })}
      />,
    );
    expect(screen.getByTestId('wb-run-progress')).toHaveTextContent('87%');
  });

  // ── ADR-024 P6 前端契约（取数路径改造） ──

  it('P6-关键：长区间（12000 根 chunked）不得静默截断 —— 必须出现 has_more 提示与加载入口', async () => {
    const user = userEvent.setup();
    const bigApi = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 12_000 });
    const run = await bigApi.submitWorkbenchRun({
      ...SUBMIT_BASE,
      name: '长区间',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    });
    const result = await bigApi.getWorkbenchResult(run.id);
    // 契约：`/result` 只回首页 5000 + **显式** has_more/next_offset（非静默）
    expect(result.result_format).toBe('chunked_v1');
    expect(result.per_bar).toHaveLength(5000);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(5000);

    render(<ResultView {...mkProps(run, result, { api: bigApi })} />);
    // 曲线：服务端显式抽样 + 原始根数标注
    expect(await screen.findByTestId('wb-aggregate-chart')).toBeInTheDocument();
    expect(screen.getByTestId('wb-aggregate-sampling')).toHaveTextContent('共 12000 bar');
    expect(screen.getByTestId('wb-aggregate-sampling')).toHaveTextContent('服务端抽样 2000 点');
    expect(screen.getByTestId('wb-equity-sampling')).toHaveTextContent('共 12000 bar');

    // 逐 bar 表：**必须**给出「已加载 N / 共 M」与加载入口，而不是只渲染 5000 行
    await user.click(screen.getByTestId('wb-tab-perbar'));
    const note = await screen.findByTestId('wb-perbar-more-note');
    expect(note).toHaveTextContent('已加载 5000 / 共 12000 根');
    expect(note).toHaveTextContent('未加载 7000 根');
    const more = screen.getByTestId('wb-perbar-load-more');
    expect(more).toBeInTheDocument();

    // 消费 next_offset：点两次 → 加载满 12000，提示消失
    await user.click(more);
    await waitFor(() => expect(screen.getByTestId('wb-perbar-loaded')).toHaveTextContent('10000'));
    await user.click(screen.getByTestId('wb-perbar-load-more'));
    await waitFor(() => expect(screen.getByTestId('wb-perbar-loaded')).toHaveTextContent('12000'));
    await waitFor(() => expect(screen.queryByTestId('wb-perbar-more-note')).toBeNull());
    expect(screen.getByTestId('wb-perbar-coverage')).toHaveTextContent('共 12000 bar');
  });

  it('P6：事件日志覆盖范围显式标注 + 加载更多（禁抽样）', async () => {
    const user = userEvent.setup();
    const bigApi = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 12_000 });
    const run = await bigApi.submitWorkbenchRun({
      ...SUBMIT_BASE,
      name: '长区间事件',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    });
    const result = await bigApi.getWorkbenchResult(run.id);
    render(<ResultView {...mkProps(run, result, { api: bigApi })} />);
    await user.click(screen.getByTestId('wb-tab-events'));
    const cov = await screen.findByTestId('wb-event-log-coverage');
    expect(cov).toHaveTextContent('覆盖 已加载 5000 / 共 12000 根 bar');
    expect(screen.getByTestId('wb-event-log-load-more')).toBeInTheDocument();
    await user.click(screen.getByTestId('wb-event-log-load-more'));
    await waitFor(() =>
      expect(screen.getByTestId('wb-event-log-coverage')).toHaveTextContent('已加载 10000 / 共 12000 根 bar'),
    );
  });

  it('P6：K 线买卖标记来自 /fills 精确源（不用 trades、不用抽样 per_bar）', async () => {
    const spy = vi.spyOn(api, 'getWorkbenchFills');
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    const note = await screen.findByTestId('wb-fills-note');
    expect(spy).toHaveBeenCalledWith(run.id, { limit: 5000 });
    expect(note).toHaveTextContent('精确源 /fills');
    // 精确源条数 = per_bar fill 事件数（不漏不加）
    const expected = fillsFromPerBar(result.per_bar).length;
    expect(note).toHaveTextContent(`成交 ${expected} 笔`);
  });

  it('P6：/fills 回 recorded=false（P6 前的 chunked run）⇒ 显式提示，不静默少标记', async () => {
    const missApi = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchFillsMissing: true });
    const run = await missApi.submitWorkbenchRun({
      ...SUBMIT_BASE,
      name: '无 fills 块',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    });
    const result = await missApi.getWorkbenchResult(run.id);
    render(<ResultView {...mkProps(run, result, { api: missApi })} />);
    const note = await screen.findByTestId('wb-fills-note');
    expect(note).toHaveTextContent('未记录成交明细');
  });

  // ── ADR-026 §2.4 前端披露（审计摘要 / 来源列 / 口径注 / 懒加载） ──

  it('ADR-026：交易明细 Tab 审计摘要行 + warnings 非阻断提示条（成交/回合/强平/名义投入口径）', async () => {
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    const fills = await client.getWorkbenchFills(run.id, { limit: 5000 });
    render(<ResultView {...mkProps(run, result, { api: client })} />);

    const summary = await screen.findByTestId('wb-audit-summary');
    // 逐笔源口径：成交笔数取自 /fills（非 trades，非抽样）；并显式拆分「买入成交」与「期末强平卖出」
    expect(summary).toHaveTextContent(
      `成交合计 ${fills.total} 笔（含期末强平卖出 ${AUDIT_BASELINE.round_trips_force_closed} 笔）`,
    );
    expect(summary).toHaveTextContent('回合 1 条（其中强平合成 1 条）');
    expect(summary).toHaveTextContent('名义投入 41.40%（分母 = 初始资金）');
    // ADR-026 §2.1 口径消歧：敞口与资金占用分别命名披露
    expect(screen.getByTestId('wb-audit-cash')).toHaveTextContent('现金消耗（含佣金）41.61%');
    // 口径消歧（2026-09-19 整改）：L2 的「买入成交 M 笔」= 审计 `batches_done`，
    // 与 L1 的 `/fills` 全口径（含期末强平卖出）**分别命名** ⇒ 两个数不再可混读。
    expect(screen.getByTestId('wb-audit-cash')).toHaveTextContent(`买入成交 ${AUDIT_BASELINE.batches_done} 笔`);
    expect(screen.getByTestId('wb-audit-cash')).not.toHaveTextContent('已成交 42');

    // warnings：非阻断提示条（带 data-testid；仍渲染表格 = 不阻断）
    const box = screen.getByTestId('wb-audit-warnings');
    expect(box).toHaveTextContent('计划 100 批');
    expect(screen.getByTestId('wb-audit-warning-DCA_PLAN_UNDERFILLED')).toBeInTheDocument();
    expect(screen.getByTestId('wb-audit-warning-PARTIAL_DEPLOYMENT')).toBeInTheDocument();
    expect(screen.getByTestId('wb-audit-warning-ORDERS_UNEXECUTED')).toBeInTheDocument();
    expect(screen.getByTestId('wb-trades-table')).toBeInTheDocument();
  });

  it('ADR-026：warnings 为空 ⇒ 不渲染提示条（无告警不占位）', async () => {
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, warnings: [] })));
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('wb-audit-warnings')).toBeNull();
  });

  it('ADR-026：交易明细「来源」列 —— 正常 / 止损 / 期末强平；历史 run（缺字段）→ 未记录', async () => {
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    const trade = (reason: Trade['reason']): Trade => ({
      open_ts: 1_700_000_000,
      close_ts: 1_700_086_400,
      open_bar: 0,
      close_bar: 1,
      open_price: 2,
      close_price: 2.1,
      shares: 100,
      gross_value: 210,
      commission: 5,
      stamp_duty: 0,
      pnl: 5,
      hold_bars: 1,
      ...(reason === undefined ? {} : { reason }),
    });
    render(
      <ResultView
        {...mkProps(
          run,
          {
            ...result,
            result_format: 'legacy_single',
            per_bar: [],
            trades: [trade('Policy'), trade('StopTrigger'), trade('ForceClose'), trade(undefined)],
          },
          { api: client },
        )}
      />,
    );
    expect(screen.getByTestId('wb-trade-source-0')).toHaveTextContent('正常');
    expect(screen.getByTestId('wb-trade-source-1')).toHaveTextContent('止损');
    expect(screen.getByTestId('wb-trade-source-2')).toHaveTextContent('期末强平');
    expect(screen.getByTestId('wb-trade-source-3')).toHaveTextContent('未记录');
    // 审计为异步取数 ⇒ 等其落地，避免测试结束后才 setState（act 噪声）
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
  });

  it('ADR-026：来源列历史 run 实测 —— mock 种子 run（legacy_single，TradeDetail 无 reason 字段）→ 未记录', async () => {
    const { run, result } = await seededLegacyRun();
    render(<ResultView {...mkProps(run, result)} />);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(screen.getByTestId('wb-trade-source-0')).toHaveTextContent('未记录');
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
  });

  it('ADR-026：8项绩效 Tab —— 口径注（分母 = 初始资金）+ 资金投入率；profit_factor=null → ∞（无亏损）并注明', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    render(
      <ResultView
        {...mkProps(run, { ...result, metrics: { ...result.metrics, profit_factor: null } }, { api: client })}
      />,
    );
    await user.click(screen.getByTestId('wb-tab-metrics'));
    const basis = await screen.findByTestId('wb-metrics-basis');
    expect(basis).toHaveTextContent('分母 = 初始资金');
    const deployed = screen.getByTestId('wb-metrics-deployed');
    await waitFor(() => expect(deployed).toHaveTextContent('41.40%'));
    expect(deployed).toHaveTextContent('资金投入率');
    expect(screen.getByTestId('wb-metrics-table')).toHaveTextContent('∞（无亏损）');
    expect(screen.getByTestId('wb-metrics-pf-note')).toHaveTextContent('∞');
  });

  it('ADR-026：profit_factor 有值 ⇒ 显示数值且无 ∞ 注', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    await user.click(screen.getByTestId('wb-tab-metrics'));
    const table = await screen.findByTestId('wb-metrics-table');
    expect(result.metrics.profit_factor).toBeTypeOf('number');
    expect(table).toHaveTextContent(result.metrics.profit_factor!.toFixed(2));
    expect(screen.queryByTestId('wb-metrics-pf-note')).toBeNull();
  });

  it('ADR-026：审计按 Tab 懒加载 —— 仅审计 Tab 打请求、切回不重复、无结果 run 不请求', async () => {
    const user = userEvent.setup();
    const spy = vi.fn(async () => AUDIT_BASELINE);
    const client = apiWithAudit(spy);
    const { run, result } = await seedRunAndResult(client);
    const { unmount } = render(<ResultView {...mkProps(run, result, { api: client })} />);
    await screen.findByTestId('wb-audit-summary');
    expect(spy).toHaveBeenCalledTimes(1);

    // 非审计 Tab（逐bar评分/事件）不触发审计请求
    await user.click(screen.getByTestId('wb-tab-perbar'));
    await user.click(screen.getByTestId('wb-tab-events'));
    expect(spy).toHaveBeenCalledTimes(1);

    // 切回审计 Tab：已有该 run 的审计 ⇒ 复用，不重复打请求
    await user.click(screen.getByTestId('wb-tab-trades'));
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);

    // 无结果（running）run ⇒ 无结果就无审计，不得无脑请求
    unmount();
    const running = (await client.listWorkbenchRuns({ status: 'running' }))[0]!;
    render(<ResultView {...mkProps(running, null, { api: client })} />);
    expect(screen.getByTestId('wb-result-pending')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ADR-026：审计 loading 三态骨架（请求未落地前显加载中）', async () => {
    let resolveAudit: (v: WorkbenchRunAudit) => void = () => undefined;
    const client = apiWithAudit(
      vi.fn(() => new Promise<WorkbenchRunAudit>((resolve) => {
        resolveAudit = resolve;
      })),
    );
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    expect(screen.getByTestId('wb-audit-loading')).toBeInTheDocument();
    act(() => resolveAudit(AUDIT_BASELINE));
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('wb-audit-loading')).toBeNull();
  });

  it('ADR-026：审计 error → 重试三态（沿用既有 loading/error/retry 模式）', async () => {
    const user = userEvent.setup();
    let first = true;
    const spy = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error('HTTP 500: audit');
      }
      return AUDIT_BASELINE;
    });
    const client = apiWithAudit(spy);
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    const err = await screen.findByTestId('wb-audit-error');
    expect(err).toHaveTextContent('审计加载失败');
    await user.click(screen.getByTestId('wb-audit-retry'));
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('wb-audit-error')).toBeNull();
  });

  it('ADR-026：recorded=false ⇒ 显式「未记录」，绝不把 0 渲染成投入率', async () => {
    const user = userEvent.setup();
    const missApi = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchAuditMissing: true });
    const run = await missApi.submitWorkbenchRun({
      ...SUBMIT_BASE,
      name: '无审计事实源',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    });
    const result = await missApi.getWorkbenchResult(run.id);
    render(<ResultView {...mkProps(run, result, { api: missApi })} />);
    const box = await screen.findByTestId('wb-audit-unrecorded');
    expect(box).toHaveTextContent('未记录');
    expect(screen.queryByTestId('wb-audit-summary')).toBeNull();

    await user.click(screen.getByTestId('wb-tab-metrics'));
    const deployed = screen.getByTestId('wb-metrics-deployed');
    await waitFor(() => expect(deployed).toHaveTextContent('未记录'));
    expect(deployed).not.toHaveTextContent('0.0%');
  });

  it('ADR-026：/fills 未记录（P6 前 chunked run）⇒ 摘要行的成交笔数也不得伪造为 0', async () => {
    const missApi = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchFillsMissing: true });
    const run = await missApi.submitWorkbenchRun({
      ...SUBMIT_BASE,
      name: '无 fills 块的审计',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
    });
    const result = await missApi.getWorkbenchResult(run.id);
    render(<ResultView {...mkProps(run, result, { api: missApi })} />);
    const summary = await screen.findByTestId('wb-audit-summary');
    expect(summary).toHaveTextContent('成交合计 未记录（/fills 事实源缺失）');
    expect(summary).not.toHaveTextContent('成交合计 0 笔');
  });

  it('ADR-026：提交 run（chunked，Dca 计划未满）⇒ 契约 mock 派生出 DCA_PLAN_UNDERFILLED 提示', async () => {
    const dcaApi = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const run = await dcaApi.submitWorkbenchRun({
      ...SUBMIT_BASE,
      name: 'DCA 未满批',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
      policy: { Dca: { mode: 'Equal', tranches: 100, interval: 1 } },
    });
    const result = await dcaApi.getWorkbenchResult(run.id);
    render(<ResultView {...mkProps(run, result, { api: dcaApi })} />);
    const summary = await screen.findByTestId('wb-audit-summary');
    expect(summary).toHaveTextContent('名义投入');
    expect(screen.getByTestId('wb-audit-warning-DCA_PLAN_UNDERFILLED')).toHaveTextContent('计划 100 批');
  });
});
