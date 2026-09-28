import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  RoundTrip,
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
  round_trips_closed: 1,
  round_trips_open: 0,
  rt_reconcile: { checked: 1, mismatched: [], tolerance: 1e-6 },
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

  it('结果渲染：K线容器 + 总分曲线（阈值线+三区着色）+ 各策略曲线 + 净值回撤 + 默认 Tab「回合与逐笔」', async () => {
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
    // 默认 Tab：回合与逐笔（ADR-028 §2.7 第 2 项；旧标签「交易明细」已按新口径更名）
    expect(screen.getByTestId('wb-tab-trades')).toBeInTheDocument();
    expect(screen.getByTestId('wb-round-trips-table')).toBeInTheDocument();
  });

  /**
   * D9 三视图结构性判据（ADR-028 §2.9 D9-1/D9-2/D9-4/D9-5/D9-12）——由 D7「上栏/下栏」重锚而来：
   * 旧契约的 `wb-chart-pane`（K 线 + 曲线卡**混合**上栏）在 D9 被拆成 `wb-kline-view`（K 线视图）
   * 与 `wb-indicator-view`（指标视图）⇒ 断言按**所断言内容**分别指向新容器。
   */
  it('D9-1/D9-2/D9-4：三视图归属正确、K 线视图无收起入口、明细 4 tab 全在明细视图内、整页不滚动', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    await screen.findByTestId('wb-round-trips-table');
    const resultRoot = screen.getByTestId('wb-result');
    const klineView = screen.getByTestId('wb-kline-view');
    const indicatorView = screen.getByTestId('wb-indicator-view');
    const detailView = screen.getByTestId('wb-detail-view');
    const detailPane = screen.getByTestId('wb-detail-pane');

    // D9-1：K 线卡 ∈ K 线视图；四张曲线卡 ∈ 指标视图；明细 4 tab ∈ 明细视图
    expect(klineView.contains(screen.getByTestId('wb-kline-chart')), 'K 线卡必须在 K 线视图内').toBe(true);
    expect(klineView.contains(screen.getByTestId('wb-window-bar')), '窗口控制条 ∈ K 线视图（D9-8 的 60px 项）').toBe(true);
    for (const card of ['wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart']) {
      const el = screen.queryByTestId(card);
      if (el) expect(indicatorView.contains(el), `${card} 必须在指标视图内`).toBe(true);
    }
    expect(detailView.contains(detailPane)).toBe(true);
    expect(detailPane.contains(screen.getByTestId('wb-round-trips-table')), 'L1/L2 必须在明细视图').toBe(true);
    expect(indicatorView.contains(screen.getByTestId('wb-round-trips-table')), '明细不得在指标视图').toBe(false);

    // D9-2：K 线视图**不存在**收起入口；指标/明细**存在**
    expect(klineView.querySelector('[data-collapse-view]'), 'K 线视图不得有收起入口').toBeNull();
    expect(screen.getByTestId('wb-indicator-collapse').getAttribute('data-collapse-view')).toBe('indicators');
    expect(screen.getByTestId('wb-detail-collapse').getAttribute('data-collapse-view')).toBe('detail');

    // 默认 tab = 回合与逐笔；其余三块同容器内
    expect(screen.getByTestId('wb-tab-trades').getAttribute('aria-selected')).toBe('true');
    for (const [tabKey, blockId] of [
      ['perbar', 'wb-perbar-table'],
      ['events', 'wb-event-log'],
      ['metrics', 'wb-metrics-table'],
    ] as const) {
      await user.click(screen.getByTestId(`wb-tab-${tabKey}`));
      expect(detailPane.contains(screen.getByTestId(blockId)), `${blockId} 必须在明细视图`).toBe(true);
    }

    // D9-4：整页不滚（K 线视图无内部滚动；指标/明细各自 overflow-auto）
    expect(resultRoot.className, 'wb-result 不得再是滚动容器（overflow-auto）').not.toContain('overflow-auto');
    expect(klineView.className, 'K 线视图不得有内部滚动').not.toContain('overflow-auto');
    expect(indicatorView.className).toContain('overflow-auto');
    expect(detailPane.className).toContain('overflow-auto');

    // D9-12：观测性（比例 / 高度 / 收起态都可读；jsdom 无布局 ⇒ 默认比例回查）
    expect(Number(resultRoot.getAttribute('data-view-ratio-kline'))).toBeCloseTo(0.55, 2);
    expect(Number(resultRoot.getAttribute('data-view-ratio-indicators'))).toBeCloseTo(0.29, 2);
    expect(Number(resultRoot.getAttribute('data-view-ratio-detail'))).toBeCloseTo(0.16, 2);
    expect(resultRoot.getAttribute('data-view-collapsed-indicators')).toBe('false');
    expect(resultRoot.getAttribute('data-view-collapsed-detail')).toBe('false');
    expect(Number(resultRoot.getAttribute('data-view-available'))).toBeGreaterThan(0);
    expect(Number(resultRoot.getAttribute('data-view-height-kline'))).toBeGreaterThanOrEqual(299);
    expect(Number(resultRoot.getAttribute('data-view-height-indicators'))).toBeGreaterThanOrEqual(180);
    expect(Number(resultRoot.getAttribute('data-view-height-detail'))).toBeGreaterThanOrEqual(95);
  });

  it('D9-3：收起指标/明细 ⇒ 视图消失但**恢复条常驻可点**，再展开复原；收起态记忆', async () => {
    const user = userEvent.setup();
    const { run, result } = await seedRunAndResult();
    render(<ResultView {...mkProps(run, result)} />);
    await screen.findByTestId('wb-round-trips-table');

    await user.click(screen.getByTestId('wb-indicator-collapse'));
    expect(screen.queryByTestId('wb-indicator-view'), '收起后指标视图不占位').toBeNull();
    expect(screen.getByTestId('wb-restore-indicators'), '恢复条必须常驻可见').toBeInTheDocument();
    expect(screen.getByTestId('wb-restore-indicators').textContent).toContain('指标');
    await user.click(screen.getByTestId('wb-restore-indicators'));
    expect(screen.getByTestId('wb-indicator-view')).toBeInTheDocument();

    await user.click(screen.getByTestId('wb-detail-collapse'));
    expect(screen.queryByTestId('wb-detail-view')).toBeNull();
    expect(screen.getByTestId('wb-restore-detail').textContent).toContain('明细');
    await user.click(screen.getByTestId('wb-restore-detail'));
    expect(screen.getByTestId('wb-detail-view')).toBeInTheDocument();
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
    // 精确源条数 = per_bar fill 事件数（不漏不加）；ADR-027 D11：总量与已加载量**常显**
    const expected = fillsFromPerBar(result.per_bar).length;
    expect(note).toHaveTextContent(`成交合计 ${expected} 笔（精确源 /fills，已加载 ${expected} / 共 ${expected}）`);
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
    expect(screen.getByTestId('wb-round-trips-table')).toBeInTheDocument();
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
    // ADR-027 v2：L1 = `RoundTrip`（回合），逐回合带 `rt_seq`/摘要
    const trade = (reason: RoundTrip['reason'], rtSeq: number): RoundTrip => ({
      rt_seq: rtSeq,
      code: '518880',
      status: 'Closed',
      open_ts: 1_700_000_000,
      close_ts: 1_700_086_400,
      open_bar: 0,
      close_bar: 1,
      open_price: 2,
      close_price: 2.1,
      shares: 100,
      buy_count: 1,
      sell_count: 1,
      gross_value: 210,
      commission: 5,
      stamp_duty: 0,
      pnl: 5,
      hold_bars: 1,
      l2_count: 2,
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
            trades: [trade('Policy', 1), trade('StopTrigger', 2), trade('ForceClose', 3), trade(undefined, 4)],
          },
          { api: client },
        )}
      />,
    );
    expect(screen.getByTestId('wb-rt-source-1')).toHaveTextContent('正常');
    expect(screen.getByTestId('wb-rt-source-2')).toHaveTextContent('止损');
    expect(screen.getByTestId('wb-rt-source-3')).toHaveTextContent('期末强平');
    expect(screen.getByTestId('wb-rt-source-4')).toHaveTextContent('未记录');
    // 审计为异步取数 ⇒ 等其落地，避免测试结束后才 setState（act 噪声）
    expect(await screen.findByTestId('wb-audit-summary')).toBeInTheDocument();
  });

  it('ADR-026：来源列历史 run 实测 —— mock 种子 run（legacy_single，TradeDetail 无 reason 字段）→ 未记录', async () => {
    const { run, result } = await seededLegacyRun();
    render(<ResultView {...mkProps(run, result)} />);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(screen.getByTestId('wb-rt-source-1')).toHaveTextContent('未记录');
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

// ───────────── ADR-029 Step 1（Web 侧）：目标暴露披露（D7/§4-E10）─────────────
// 契约：ADR-029 D7「UI 需能显示目标暴露…并标注『总分曲线是诊断量，不等于仓位』」+ E10 逐 bar 观测。
// Rust 车道并行实施中：观测字段（`target_pct/current_pct/deadzone_blocked/clamped_by_guard`）
// **未就绪时必须显式留白**（禁把缺失读成 0，ADR-024 D10），就绪时按字段计数展示。
describe('ResultView（ADR-029 Step 1：目标暴露 + 逐 bar 观测披露）', () => {
  beforeEach(() => vi.clearAllMocks());

  const EXPOSURE_POLICY = {
    Exposure: {
      target: { ScoreMapped: { at_threshold_pct: 0.2, at_full_pct: 0.5, sell: 'Flat' as const } },
      ramp: { RateCap: { pct_per_bar: 0.05 } },
      guard: { max_pct: 0.9, min_pct: 0, deadzone_pct: 0.005 },
    },
  };

  function withPolicy(run: WorkbenchRunView, policy: WorkbenchRunView['config']['policy']): WorkbenchRunView {
    return { ...run, config: { ...run.config, policy } };
  }

  it('D7/E10：Exposure run ⇒ 配置端点披露 + 观测字段缺省时显式「未记录」（禁以 0 冒充）', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(withPolicy(run, EXPOSURE_POLICY), result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));

    const box = await screen.findByTestId('wb-result-exposure-disclosure');
    expect(box).toBeInTheDocument();
    // BLOCKED-1/R26：结果侧披露必须用**结果侧专属** testid（与配置侧 `wb-exposure-*` 区分）
    // —— 工作台选中 run 后两侧同时挂载，同名 id ⇒ Playwright strict mode 双命中。
    expect(screen.queryByTestId('wb-exposure-disclosure')).toBeNull();
    expect(screen.queryByTestId('wb-exposure-target')).toBeNull();
    // 目标端（run 配置快照 = 真实事实源）
    const target = screen.getByTestId('wb-result-exposure-target');
    expect(target).toHaveTextContent('ScoreMapped');
    expect(target).toHaveTextContent('at_threshold_pct=20.0%');
    expect(target).toHaveTextContent('at_full_pct=50.0%');
    expect(target).toHaveTextContent('sell=Flat');
    expect(target).toHaveTextContent('RateCap');
    expect(target).toHaveTextContent('pct_per_bar=5.0%');
    expect(target).toHaveTextContent('max_pct=90.0%');
    expect(target).toHaveTextContent('deadzone_pct=0.50%');
    // 逐 bar 观测缺省（Rust 车道未落地）⇒ 显式「未记录」+ 只用既有事实（审计 deployed_pct）占位
    const unrecorded = screen.getByTestId('wb-exposure-unrecorded');
    expect(unrecorded).toHaveTextContent('未记录');
    await waitFor(() => expect(screen.getByTestId('wb-exposure-unrecorded')).toHaveTextContent('41.40%'));
    expect(screen.queryByTestId('wb-exposure-observed')).toBeNull();
    // D7 披露文案
    expect(screen.getByTestId('wb-exposure-score-note')).toHaveTextContent('总分曲线是诊断量');
    expect(screen.getByTestId('wb-exposure-score-note')).toHaveTextContent('不等于仓位');
    // 聚合分曲线卡处也有常驻诊断注（总分 ≠ 仓位）
    expect(screen.getByTestId('wb-score-diagnostic-note')).toHaveTextContent('不等于仓位');
  });

  it('D7/E10：逐 bar 观测就绪 ⇒ 展示末值目标/当前暴露与 deadzone_blocked / clamped_by_guard 计数', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    // 构造 4 根 bar：最后一根带观测值；2 根死区拦截；1 根被 guard 夹取
    const rows: WorkbenchBarRecord[] = result.per_bar.slice(0, 4).map((r, i) => ({
      ...r,
      target_pct: i === 3 ? 0.5 : 0.4,
      current_pct: i === 3 ? 0.42 : 0.4,
      deadzone_blocked: i < 2,
      clamped_by_guard: i === 3,
    }));
    const withObs = { ...result, per_bar: rows } as WorkbenchRunResult;
    render(<ResultView {...mkProps(withPolicy(run, EXPOSURE_POLICY), withObs, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));

    const observed = await screen.findByTestId('wb-exposure-observed');
    expect(observed).toHaveTextContent('已加载 4 根');
    expect(observed).toHaveTextContent('目标 50.0%');
    expect(observed).toHaveTextContent('当前 42.0%');
    expect(observed).toHaveTextContent('死区拦截 2 bar');
    expect(observed).toHaveTextContent('guard 夹取 1 bar');
    expect(screen.queryByTestId('wb-exposure-unrecorded')).toBeNull();
  });

  it('ADR-029 E16：审计新增告警码（EXPOSURE_INTENT_GAP / EXPOSURE_CHURN）经既有 warnings[] 通用渲染可见', async () => {
    const warnings: WorkbenchRunAudit['warnings'] = [
      {
        code: 'EXPOSURE_INTENT_GAP',
        severity: 'warn',
        message: '意图 vs 实际暴露差值 18.00%（目标 50.00% / 实际 32.00%）：路径受 ramp/guard 约束未走满',
      },
      {
        code: 'EXPOSURE_CHURN',
        severity: 'info',
        message: '评估段下单 42 次 / 费用占净值 0.31%：分数抖动导致换手偏高',
      },
    ];
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, warnings })));
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(withPolicy(run, EXPOSURE_POLICY), result, { api: client })} />);
    // warnings 顶层键集不变 ⇒ 结果页无需新字段解析：按 code 通用渲染（数值在 message 文本内）
    const gap = await screen.findByTestId('wb-audit-warning-EXPOSURE_INTENT_GAP');
    expect(gap).toHaveTextContent('意图 vs 实际暴露差值 18.00%');
    const churn = screen.getByTestId('wb-audit-warning-EXPOSURE_CHURN');
    expect(churn).toHaveTextContent('费用占净值 0.31%');
    expect(screen.getByTestId('wb-audit-warnings')).toBeInTheDocument();
  });

  it('ADR-029 零回归：非 Exposure run（LumpSum）⇒ 不渲染目标暴露块（仅保留总分诊断注）', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));
    expect(await screen.findByTestId('wb-metrics-table')).toBeInTheDocument();
    expect(screen.queryByTestId('wb-result-exposure-disclosure')).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * ADR-029 Step 1.5（D11/D15）Web 车道 C3：三层读数披露（意图 / 输出目标 / 当前持仓）、
 * 审计 `exposure` 段（gap / 未达成意图 / 死区占比 / 成本放大）与 **`null` 处理**（独立复验 R6）。
 *
 * 契约事实源：`design/12-strategy-system/06-plan-exposure-step1_5.md` §2.2（三层语义）/§2.6（观测键）/
 * §3.1（审计 `exposure` 段 17 键样例）；ADR-029 §8 D11/D15。
 * ════════════════════════════════════════════════════════════════════════════════════════════ */
describe('ResultView（ADR-029 Step 1.5：意图披露 + 审计 exposure 段 + null 处理）', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Step 1.5 形态的 Exposure 策略（RateCap 缺省 `on_signal_break` ⇒ 运行期 Pause）。 */
  const E15_POLICY = {
    Exposure: {
      target: { ScoreMapped: { at_threshold_pct: 0.2, at_full_pct: 0.5, sell: 'Scaled' as const } },
      ramp: { RateCap: { pct_per_bar: 0.05, down_pct_per_bar: 0.2 } },
      guard: { max_pct: 0.9, min_pct: 0, deadzone_pct: 0.005, deadzone_min_notional: 100 },
    },
  };
  const E15_POLICY_CONTINUE = {
    Exposure: {
      ...E15_POLICY.Exposure,
      ramp: { RateCap: { pct_per_bar: 0.05, down_pct_per_bar: 0.2, on_signal_break: 'Continue' as const } },
    },
  };

  /** 审计 `exposure` 段（逐字取自 06-plan §3.1 样例形状；数值为真值样例）。 */
  const EXPOSURE_AUDIT = {
    bars: 1810,
    orders: 58,
    orders_per_bar: 0.0319,
    fees: 297.8804660338809,
    fee_pct: 0.0029788,
    nominal_fee_rate: 0.00025,
    cost_amplification: 32.0,
    max_target_gap: 0.010216,
    max_target_gap_bar: 1599,
    max_intent_gap: 0.031,
    max_intent_gap_bar: 1234,
    unmet_intent_bars: 12,
    clamped_bars: 0,
    deadzone_blocked_bars: 1760,
    rate_limited_bars: 6,
    sell_transition_bars: 0,
    affordability_capped_bars: 0,
  };

  function withPolicy(run: WorkbenchRunView, policy: WorkbenchRunView['config']['policy']): WorkbenchRunView {
    return { ...run, config: { ...run.config, policy } };
  }

  /**
   * R6 必查项：预热段的 `per_bar` **带键但值为 `null`**（真实读数，见 `perBarObservationKeys.test.ts`
   * 的 `RC_RAW_WARMUP`）⇒ 过滤谓词必须排除 `null`，否则「已加载 N 根」把预热段计入（虚高）、
   * 末值读数取到 `null` 并显示成「—」（= 把「未记录」当读数展示）。
   */
  it('R6/null：预热段（键在但 `null`）不得计入观测根数，也不得成为末值读数', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: EXPOSURE_AUDIT })));
    const { run, result } = await seedRunAndResult(client);
    const rows: WorkbenchBarRecord[] = result.per_bar.slice(0, 6).map((r, i) => ({
      ...r,
      warmup: i < 3,
      // 预热 3 根：键在、值 `null`（不得读成 0）；后 3 根为真实观测
      target_pct: i < 3 ? null : 0.4,
      current_pct: i < 3 ? null : 0.38,
      intent_pct: i < 3 ? null : 0.42,
      down_ramp_cap_pct_per_bar: i < 3 ? null : 0.2,
      deadzone_blocked: i === 3 || i === 4,
      rate_limited: i === 3,
    }));
    const withObs = { ...result, per_bar: rows } as WorkbenchRunResult;
    render(<ResultView {...mkProps(withPolicy(run, E15_POLICY), withObs, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));

    const observed = await screen.findByTestId('wb-exposure-observed');
    // 分母 = **3**（有真实读数者），不是 6（键在即计 = 虚高）
    expect(observed).toHaveTextContent('已加载 3 根');
    expect(observed).not.toHaveTextContent('已加载 6 根');
    // 末值读数取自末根**真实**观测（不得显示 —/null）
    expect(observed).toHaveTextContent('目标 40.0%');
    expect(observed).toHaveTextContent('当前 38.0%');
    // 死区拦截 2 bar（i=3、4；预热 3 根的 `false` 不计）；限速 1 bar
    expect(observed).toHaveTextContent('死区拦截 2 bar');
    expect(observed).toHaveTextContent('限速 1 bar');
    expect(screen.queryByTestId('wb-exposure-unrecorded')).toBeNull();
  });

  it('R6/null：全为 `null`（预热段或非 Exposure 观测）⇒ 显式「未记录」，**不得**显「目标 —」', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: null })));
    const { run, result } = await seedRunAndResult(client);
    const rows: WorkbenchBarRecord[] = result.per_bar.slice(0, 3).map((r) => ({
      ...r,
      warmup: true,
      target_pct: null,
      current_pct: null,
      intent_pct: null,
      down_ramp_cap_pct_per_bar: null,
    }));
    const allNull = { ...result, per_bar: rows } as WorkbenchRunResult;
    render(<ResultView {...mkProps(withPolicy(run, E15_POLICY), allNull, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));
    expect(await screen.findByTestId('wb-exposure-unrecorded')).toBeInTheDocument();
    expect(screen.queryByTestId('wb-exposure-observed')).toBeNull();
    // 审计段亦为 `null` ⇒ 「未记录」（不得把 0 当读数）
    expect(screen.getByTestId('wb-result-exposure-audit-unrecorded')).toBeInTheDocument();
  });

  it('D11：三层读数同时披露（意图 / 输出目标 / 当前持仓）+ 消歧文案；`intent_pct` 缺键 ⇒ 显「未记录」而非 0', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: EXPOSURE_AUDIT })));
    const { run, result } = await seedRunAndResult(client);
    const rows: WorkbenchBarRecord[] = result.per_bar.slice(0, 4).map((r, i) => ({
      ...r,
      warmup: false,
      target_pct: 0.4,
      current_pct: 0.38,
      // 前两根缺 `intent_pct` 键（旧 run 容差），后两根有值
      ...(i < 2 ? {} : { intent_pct: 0.42 }),
      down_ramp_cap_pct_per_bar: 0.2,
    }));
    const withObs = { ...result, per_bar: rows } as WorkbenchRunResult;
    render(<ResultView {...mkProps(withPolicy(run, E15_POLICY), withObs, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));

    const readings = await screen.findByTestId('wb-result-exposure-readings');
    expect(readings).toHaveTextContent('意图');
    expect(readings).toHaveTextContent('42.0%');
    expect(readings).toHaveTextContent('输出目标');
    expect(readings).toHaveTextContent('40.0%');
    expect(readings).toHaveTextContent('当前持仓');
    expect(readings).toHaveTextContent('38.0%');
    // 消歧：三个名字的**口径**必须写清（这正是 F1「意图不可见」的修复）
    expect(readings).toHaveTextContent('死区/限速');
    expect(readings).toHaveTextContent('次 bar');
  });

  it('D11/F1：`intent_pct` 全缺（Step 1 旧 run）⇒ 意图显「未记录」，**不得**以 0 冒充', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: null })));
    const { run, result } = await seedRunAndResult(client);
    const rows: WorkbenchBarRecord[] = result.per_bar.slice(0, 3).map((r) => ({
      ...r,
      warmup: false,
      target_pct: 0.4,
      current_pct: 0.38,
    }));
    const noIntent = { ...result, per_bar: rows } as WorkbenchRunResult;
    render(<ResultView {...mkProps(withPolicy(run, E15_POLICY), noIntent, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));
    const readings = await screen.findByTestId('wb-result-exposure-readings');
    expect(readings).toHaveTextContent('未记录');
    expect(readings).not.toHaveTextContent('意图 0.0%');
  });

  it('D15：审计 `exposure` 段披露（gap 双层 / 未达成意图 / 死区拦截占比 / 成本放大 + 实际 vs 名义费率消歧）', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: EXPOSURE_AUDIT })));
    const { run, result } = await seedRunAndResult(client);
    render(<ResultView {...mkProps(withPolicy(run, E15_POLICY), result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));

    const auditBox = await screen.findByTestId('wb-result-exposure-audit');
    expect(auditBox).toHaveTextContent('1810'); // 评估段 bar 数
    const gaps = screen.getByTestId('wb-result-exposure-audit-gaps');
    expect(gaps).toHaveTextContent('max_target_gap');
    expect(gaps).toHaveTextContent('1.02%'); // 0.010216
    expect(gaps).toHaveTextContent('执行层');
    expect(gaps).toHaveTextContent('max_intent_gap');
    expect(gaps).toHaveTextContent('3.10%'); // 0.031
    expect(gaps).toHaveTextContent('unmet_intent_bars');
    expect(gaps).toHaveTextContent('12');
    const counters = screen.getByTestId('wb-result-exposure-audit-counters');
    // 死区拦截占比 = 1760 / 1810 = 97.2%
    expect(counters).toHaveTextContent('97.2%');
    const cost = screen.getByTestId('wb-result-exposure-audit-cost');
    expect(cost).toHaveTextContent('cost_amplification');
    expect(cost).toHaveTextContent('32.0');
    // 消歧：实际费率（占初始资金）vs 名义费率（bps%）——两者分母不同，不得混读
    expect(cost).toHaveTextContent('0.025%'); // 名义 0.00025
    expect(cost).toHaveTextContent('0.30%'); // 费用占净值 fee_pct = 0.29788%
    expect(cost).toHaveTextContent('成交额');
  });

  it('D15：`exposure === null` ⇒ 审计段显「未记录」（不得把 0 当读数）', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: null })));
    const { run, result } = await seedRunAndResult(client);
    const rows: WorkbenchBarRecord[] = result.per_bar.slice(0, 3).map((r) => ({
      ...r, warmup: false, target_pct: 0.4, current_pct: 0.38, intent_pct: 0.42,
    }));
    render(<ResultView {...mkProps(withPolicy(run, E15_POLICY), { ...result, per_bar: rows } as WorkbenchRunResult, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));
    const box = await screen.findByTestId('wb-result-exposure-audit-unrecorded');
    expect(box).toHaveTextContent('未记录');
    expect(screen.queryByTestId('wb-result-exposure-audit-counters')).toBeNull();
  });

  it('D12：`on_signal_break` 缺省（运行期 Pause）⇒ 必须写明「路径暂停、停在中途属契约行为」；`Continue` ⇒ 写明继续推进', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: EXPOSURE_AUDIT })));
    const { run, result } = await seedRunAndResult(client);
    const { unmount } = render(<ResultView {...mkProps(withPolicy(run, E15_POLICY), result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));
    const pauseNote = await screen.findByTestId('wb-result-exposure-break-note');
    expect(pauseNote).toHaveTextContent('Pause');
    expect(pauseNote).toHaveTextContent('缺省');
    expect(pauseNote).toHaveTextContent('停在');
    unmount();

    const client2 = apiWithAudit(vi.fn(async () => ({ ...AUDIT_BASELINE, exposure: EXPOSURE_AUDIT })));
    const seed2 = await seedRunAndResult(client2);
    render(<ResultView {...mkProps(withPolicy(seed2.run, E15_POLICY_CONTINUE), seed2.result, { api: client2 })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));
    const contNote = await screen.findByTestId('wb-result-exposure-break-note');
    expect(contNote).toHaveTextContent('Continue');
    expect(contNote).toHaveTextContent('继续');
  });

  it('D12/零回归：`Immediate`（`on_signal_break` 不存在于该变体）⇒ 不渲染 break 注', async () => {
    const user = userEvent.setup();
    const client = apiWithAudit(vi.fn(async () => AUDIT_BASELINE));
    const { run, result } = await seedRunAndResult(client);
    const immediate = {
      Exposure: { ...E15_POLICY.Exposure, ramp: { Immediate: null } },
    } as unknown as WorkbenchRunView['config']['policy'];
    render(<ResultView {...mkProps(withPolicy(run, immediate), result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-tab-metrics'));
    await screen.findByTestId('wb-result-exposure-disclosure');
    expect(screen.queryByTestId('wb-result-exposure-break-note')).toBeNull();
  });
});
