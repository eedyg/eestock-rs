/**
 * ADR-027 §2.9/2.10/2.11/2.12 + ADR-028 §2.4 —— 交易明细 L1/L2 分层前端契约（03-test-plan F1–F5、F12）。
 *
 * 本文件是 P5a 的**验收载体**（判据全部正向断言具体值，禁止「没报错即通过」）：
 * - F1：默认只渲染 L1 一层；`[明细]` 展开/收起；`aria-expanded` 状态断言；**取消隐式整行点击**。
 * - F2：L2 懒加载 —— 展开前**无** L2 请求；展开后按 `rt_seq` 请求且分页正确（next_offset 续拉）。
 * - F3：L2 `[明细]` 展开字段详情（费用三件套 / 双口径均价 / `cum_*` 累计）。
 * F4：对账不一致告警（累加不一致 **或** 后端 audit `rt_reconcile.mismatched` 非空）
 *     ⇒ 展开区顶部醒目告警含 Δ 值且**冻结**展示两侧数值（禁静默按 L1 渲染）。
 * F5：`cum_*` 末行 == 该回合 L1 对应字段（逐字段相等）。
 * F12：K 线买卖标记取数完整性（> 首页大小 ⇒ 分页拉全 + 显式披露总量与已加载量）。
 */
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@/api/client';
import type { ComponentProps } from 'react';
import type {
  RoundTrip,
  RoundTripFill,
  WorkbenchFillsResponse,
  WorkbenchRunAudit,
  WorkbenchRunFill,
  WorkbenchRoundTripFillsResponse,
  WorkbenchRoundTripsResponse,
  WorkbenchRunResult,
  WorkbenchRunView,
} from '@/api/types';
import { createMockClient } from '@/api/mock';
import { ResultView } from './ResultView';
import { L2_PAGE_SIZE, SERIES_PAGE_SIZE } from './useRunSeries';

// jsdom 无 canvas：klinecharts 整体打桩（与 ResultView.test 同模式）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {}),
  ),
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

const api = createMockClient({ now: new Date('2026-09-20T06:00:00Z') });

const SUBMIT_BASE = {
  symbol: '518880',
  period: 'D1',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  policy: { LumpSum: { position_pct: 1 } } as const,
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
};

const DAY = 86_400;
const T0 = 1_767_225_600; // 2026-01-01T00:00:00Z

function fill(over: Partial<RoundTripFill>): RoundTripFill {
  return {
    rt_seq: 1,
    code: '518880',
    bar_index: 1,
    ts: T0,
    side: 'Buy',
    qty: 100,
    price: 10,
    trade_value: 1000,
    commission: 5,
    stamp_duty: 0,
    reason: 'Policy',
    ...over,
  };
}

/**
 * 事实样本（手算，口径见 02-spec §2）：
 * 买 100@10.00（费 5）→ 买 100@10.20（费 5）→ 卖 200@10.50（费 5.25 / 印花 1.05）
 * invested = (1000+5) + (1020+5) = 2030 ; proceeds = 2100 − 5.25 − 1.05 = 2093.70 ; pnl = 63.70
 * commission = 15.25 ; stamp_duty = 1.05 ; gross_value = 2100 ; shares = 200
 * open_price = 2020/200 = 10.100 ; close_price = 2100/200 = 10.500
 */
const RT1_FILLS: RoundTripFill[] = [
  fill({ rt_seq: 1, bar_index: 1, ts: T0, side: 'Buy', price: 10, trade_value: 1000, commission: 5, stamp_duty: 0 }),
  fill({ rt_seq: 1, bar_index: 2, ts: T0 + DAY, side: 'Buy', price: 10.2, trade_value: 1020, commission: 5, stamp_duty: 0 }),
  fill({ rt_seq: 1, bar_index: 3, ts: T0 + 2 * DAY, side: 'Sell', qty: 200, price: 10.5, trade_value: 2100, commission: 5.25, stamp_duty: 1.05 }),
];
const RT1: RoundTrip = {
  rt_seq: 1, code: '518880', status: 'Closed',
  open_ts: T0, close_ts: T0 + 2 * DAY, open_bar: 1, close_bar: 3,
  shares: 200, buy_count: 2, sell_count: 1,
  open_price: 10.1, close_price: 10.5,
  gross_value: 2100, commission: 15.25, stamp_duty: 1.05, pnl: 63.7,
  hold_bars: 2, reason: 'Policy', l2_count: 3,
};

/** rt2：两侧数值一致，但**后端 audit** 报该回合不一致 ⇒ 仍必须显式告警（D10 守卫）。 */
const RT2_FILLS: RoundTripFill[] = [
  fill({ rt_seq: 2, bar_index: 10, ts: T0 + 9 * DAY, side: 'Buy', price: 8, trade_value: 800, commission: 5, stamp_duty: 0 }),
  fill({ rt_seq: 2, bar_index: 11, ts: T0 + 10 * DAY, side: 'Sell', price: 8.4, trade_value: 840, commission: 5, stamp_duty: 0.42 }),
];
const RT2: RoundTrip = {
  rt_seq: 2, code: '518880', status: 'Closed',
  open_ts: T0 + 9 * DAY, close_ts: T0 + 10 * DAY, open_bar: 10, close_bar: 11,
  shares: 100, buy_count: 1, sell_count: 1,
  open_price: 8, close_price: 8.4,
  gross_value: 840, commission: 10, stamp_duty: 0.42, pnl: 24.58,
  hold_bars: 1, reason: 'Policy', l2_count: 2,
};

/** rt3：UI 累加 != L1（L1.commission 被注入为 99）⇒ 前端对账必须告警并冻结两侧数值。 */
const RT3_FILLS: RoundTripFill[] = [RT1_FILLS[0]!, RT1_FILLS[1]!, RT1_FILLS[2]!].map((f) => ({ ...f, rt_seq: 3, bar_index: f.bar_index + 20 }));
const RT3: RoundTrip = { ...RT1, rt_seq: 3, open_bar: 21, close_bar: 23, open_ts: T0 + 21 * DAY, close_ts: T0 + 23 * DAY, commission: 99 };

const RTS: RoundTrip[] = [RT1, RT2, RT3];

const AUDIT_BASE: WorkbenchRunAudit = {
  run_id: 'sr_mock_rt',
  recorded: true,
  capital_basis: 100_000,
  deployed_notional: 2820,
  deployed_pct: 0.0282,
  cash_consumed: 2830,
  cash_consumed_pct: 0.0283,
  planned_tranches: null,
  reachable_batches: 5,
  batches_done: 5,
  unexecuted_orders: 0,
  last_bar_unfilled: false,
  round_trips_total: 3,
  round_trips_force_closed: 0,
  round_trips_closed: 3,
  round_trips_open: 0,
  rt_reconcile: { checked: 3, mismatched: [2], tolerance: 1e-6 },
  warnings: [],
};

/** 只替换 L1/L2/audit 三个端点的契约 mock（其余方法照常走 mock）。 */
function apiWith(over: Partial<ApiClient>): ApiClient {
  return { ...api, ...over };
}

function l1Response(rows: RoundTrip[] = RTS, over: Partial<WorkbenchRoundTripsResponse> = {}): WorkbenchRoundTripsResponse {
  return { run_id: 'sr_mock_rt', total: rows.length, recorded: true, has_more: false, next_offset: null, round_trips: rows, ...over };
}

function l2Response(rtSeq: number, fills: RoundTripFill[], over: Partial<WorkbenchRoundTripFillsResponse> = {}): WorkbenchRoundTripFillsResponse {
  return { run_id: 'sr_mock_rt', rt_seq: rtSeq, total: fills.length, has_more: false, next_offset: null, fills, ...over };
}

async function mkRunAndResult(client: ApiClient = api): Promise<{ run: WorkbenchRunView; result: WorkbenchRunResult }> {
  const run = await client.submitWorkbenchRun({
    ...SUBMIT_BASE,
    name: 'L1/L2 用例',
    slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
  });
  const result = await client.getWorkbenchResult(run.id);
  return { run, result };
}

type ResultViewProps = ComponentProps<typeof ResultView>;

function mkProps(
  run: WorkbenchRunView | null,
  result: WorkbenchRunResult | null,
  over: Partial<ResultViewProps> = {},
): ResultViewProps {
  return { run, result, loading: false, error: null, onRetry: vi.fn(), api, catalog: null, ...over };
}

describe('交易明细 L1/L2 分层（ADR-027 D8/D9/D10；ADR-028 D4）', () => {
  // ── F1：默认一层 + 两枚按钮 + aria-expanded + 取消隐式行点击 ──

  it('F1：默认只渲染 L1 一层；[明细] 展开/收起（aria-expanded）；点击行内文本不触发展开', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const client = apiWith({
      getWorkbenchRoundTrips: vi.fn(async () => l1Response()),
      getWorkbenchRoundTripFills: vi.fn(async (_id: string, rt: number) => l2Response(rt, RT1_FILLS)),
      getRunAudit: vi.fn(async () => AUDIT_BASE),
    });
    const { run, result } = await mkRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client, onJump })} />);

    // L1 一层：三条回合行；展开前**无**任何 L2 行
    expect(await screen.findByTestId('wb-rt-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('wb-rt-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('wb-rt-row-3')).toBeInTheDocument();
    expect(screen.queryByTestId('wb-l2-row-1-0')).toBeNull();
    expect(screen.queryByTestId('wb-rt-l2-1')).toBeNull();

    // L1 摘要（D8）：l2_count + 买卖笔数
    expect(screen.getByTestId('wb-rt-summary-1')).toHaveTextContent('成交 3 笔（买 2 / 卖 1）');

    // 两枚按钮：稳定 testid + aria-expanded（L1 [明细] 默认收起）
    const detail = screen.getByTestId('wb-rt-detail-1');
    expect(detail).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('wb-rt-jump-1')).toBeInTheDocument();
    // 取消隐式整行点击：点行内文本不得展开
    await user.click(screen.getByTestId('wb-rt-open-1'));
    expect(screen.queryByTestId('wb-l2-row-1-0')).toBeNull();
    expect(detail).toHaveAttribute('aria-expanded', 'false');

    // 展开 ⇒ L2 行数 == l2_count == 3
    await user.click(detail);
    expect(detail).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByTestId('wb-rt-l2-1')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^wb-l2-row-1-/)).toHaveLength(RT1.l2_count);

    // 再点 ⇒ 收起
    await user.click(detail);
    expect(detail).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByTestId('wb-l2-row-1-0')).toBeNull());

    // [跳转]：L1 → 回合区间；L2 → 该笔 bar（本波只派发事件，由 P5b 接窗口状态）
    await user.click(screen.getByTestId('wb-rt-jump-1'));
    expect(onJump).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'L1', rt_seq: 1, open_bar: 1, close_bar: 3 }),
    );
    await user.click(screen.getByTestId('wb-rt-detail-1'));
    await screen.findByTestId('wb-l2-row-1-2');
    await user.click(screen.getByTestId('wb-l2-jump-1-2'));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ level: 'L2', rt_seq: 1, bar_index: 3 }));
  });

  // ── F2：懒加载（展开前无请求）+ 分页正确 ──

  it('F2：展开前无 L2 请求；展开后按 rt_seq 请求且按 next_offset 续拉全部页', async () => {
    const l2Spy = vi.fn(async (_id: string, rt: number, q?: { offset?: number; limit?: number }) => {
      const offset = q?.offset ?? 0;
      // 两页：首页 L2_PAGE_SIZE 行 + 尾页 1 行（显式 has_more/next_offset）
      const page: RoundTripFill[] =
        offset === 0
          ? Array.from({ length: L2_PAGE_SIZE }, (_, i) => fill({ rt_seq: rt, bar_index: i, ts: T0 + i * DAY }))
          : [fill({ rt_seq: rt, bar_index: L2_PAGE_SIZE, ts: T0 + L2_PAGE_SIZE * DAY, side: 'Sell', price: 10.5, trade_value: 1050, commission: 5, stamp_duty: 0.53 })];
      return l2Response(rt, page, offset === 0
        ? { total: L2_PAGE_SIZE + 1, has_more: true, next_offset: L2_PAGE_SIZE }
        : { total: L2_PAGE_SIZE + 1, has_more: false, next_offset: null });
    });
    const client = apiWith({
      getWorkbenchRoundTrips: vi.fn(async () => l1Response([{ ...RT1, l2_count: L2_PAGE_SIZE + 1, buy_count: L2_PAGE_SIZE, sell_count: 1 }])),
      getWorkbenchRoundTripFills: l2Spy,
      getRunAudit: vi.fn(async () => ({ ...AUDIT_BASE, rt_reconcile: { checked: 1, mismatched: [], tolerance: 1e-6 } })),
    });
    const { run, result } = await mkRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    await screen.findByTestId('wb-rt-row-1');

    // 展开前：零 L2 请求（懒加载）
    expect(l2Spy).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByTestId('wb-rt-detail-1'));
    await waitFor(() => expect(l2Spy).toHaveBeenCalledTimes(2));
    expect(l2Spy.mock.calls[0]!.slice(0, 2)).toEqual([run.id, 1]);
    expect(l2Spy.mock.calls[0]![2]).toEqual({ offset: 0, limit: L2_PAGE_SIZE });
    expect(l2Spy.mock.calls[1]![2]).toEqual({ offset: L2_PAGE_SIZE, limit: L2_PAGE_SIZE });
    // 分页拉全 ⇒ L2 行数 == total，且加载态结束
    await waitFor(() => expect(screen.getAllByTestId(/^wb-l2-row-1-/)).toHaveLength(L2_PAGE_SIZE + 1));
    expect(screen.getByTestId('wb-rt-l2-1')).toHaveTextContent(`已加载 ${L2_PAGE_SIZE + 1} / 共 ${L2_PAGE_SIZE + 1} 笔`);
    // 收起后再次展开 ⇒ 复用已取数（不重复打请求）
    await userEvent.setup().click(screen.getByTestId('wb-rt-detail-1'));
    await userEvent.setup().click(screen.getByTestId('wb-rt-detail-1'));
    expect(l2Spy).toHaveBeenCalledTimes(2);
  });

  // ── F3：L2 [明细] 字段详情（费用三件套 / 双口径均价 / cum_*） ──

  it('F3：L2 [明细] 展开该笔完整字段（双口径均价 + 费用三件套 + cum_ 累计）', async () => {
    const user = userEvent.setup();
    const client = apiWith({
      getWorkbenchRoundTrips: vi.fn(async () => l1Response()),
      getWorkbenchRoundTripFills: vi.fn(async (_id: string, rt: number) => l2Response(rt, RT1_FILLS)),
      getRunAudit: vi.fn(async () => AUDIT_BASE),
    });
    const { run, result } = await mkRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-rt-detail-1'));
    const btn = await screen.findByTestId('wb-l2-detail-1-2');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    const panel = screen.getByTestId('wb-l2-fields-1-2');
    // 费用三件套（来自引擎事实，禁下游复算）
    expect(panel).toHaveTextContent('trade_value');
    expect(panel).toHaveTextContent('2100.00');
    expect(panel).toHaveTextContent('commission');
    expect(panel).toHaveTextContent('5.25');
    expect(panel).toHaveTextContent('stamp_duty');
    expect(panel).toHaveTextContent('1.05');
    // 双口径均价（必须带限定词；裸用「均价」= 违约）
    expect(panel).toHaveTextContent('avg_price_excl_fee（不含费，= 累计成交额/累计股数）');
    expect(screen.getByTestId('wb-l2-avg-price-1-2')).toHaveTextContent('10.500');
    expect(panel).toHaveTextContent('avg_cost_incl_fee（含费，对账口径）');
    expect(screen.getByTestId('wb-l2-avg-cost-1-2')).toHaveTextContent('10.468'); // (2100−5.25−1.05)/200 = 10.4685 → 3 位
    // cum_ 累计列（常显 + 明细内逐字段）
    expect(screen.getByTestId('wb-l2-cum-commission-1-2')).toHaveTextContent('15.25');
    expect(screen.getByTestId('wb-l2-cum-stamp-1-2')).toHaveTextContent('1.05');
    expect(screen.getByTestId('wb-l2-cum-cashflow-1-2')).toHaveTextContent('63.70'); // 原名「累计盈亏」⇒ D12 改名「累计净现金流」（算法一字不改）
  });

  // ── F5：cum_* 末行 == L1 字段（逐字段相等） ──

  it('F5：cum_ 末行与该回合 L1 对应字段逐字段相等（佣金/印花税/已实现盈亏）', async () => {
    const user = userEvent.setup();
    const client = apiWith({
      getWorkbenchRoundTrips: vi.fn(async () => l1Response()),
      getWorkbenchRoundTripFills: vi.fn(async (_id: string, rt: number) => l2Response(rt, RT1_FILLS)),
      getRunAudit: vi.fn(async () => ({ ...AUDIT_BASE, rt_reconcile: { checked: 3, mismatched: [], tolerance: 1e-6 }, round_trips_closed: 3 })),
    });
    const { run, result } = await mkRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-rt-detail-1'));
    await screen.findByTestId('wb-l2-row-1-2');

    const last = screen.getAllByTestId(/^wb-l2-row-1-/).at(-1)!;
    expect(last).toHaveAttribute('data-last-row', 'true'); // 末行标记（累计行 == L1 的锚点）
    expect(screen.getByTestId('wb-l2-cum-commission-1-2').textContent).toBe(screen.getByTestId('wb-rt-commission-1').textContent);
    expect(screen.getByTestId('wb-l2-cum-stamp-1-2').textContent).toBe(screen.getByTestId('wb-rt-stamp-1').textContent);
    expect(screen.getByTestId('wb-l2-cum-cashflow-1-2').textContent).toBe(screen.getByTestId('wb-rt-pnl-1').textContent);
    // 干净回合（两侧一致 + audit 无该 seq）⇒ 不出现告警
    expect(screen.queryByTestId('wb-rt-reconcile-1')).toBeNull();
  });

  // ── F13：L2 成本归属新列（ADR-027 §2.14 D12 / 09-plan §4）──

  it('F13（ADR-027 D12）：新列「持仓成本 / 本笔卖出盈亏 / 累计已实现盈亏」+「累计盈亏」改名「累计净现金流」', async () => {
    const user = userEvent.setup();
    const client = apiWith({
      getWorkbenchRoundTrips: vi.fn(async () => l1Response()),
      getWorkbenchRoundTripFills: vi.fn(async (_id: string, rt: number) => l2Response(rt, RT1_FILLS)),
      getRunAudit: vi.fn(async () => AUDIT_BASE),
    });
    const { run, result } = await mkRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);
    await user.click(await screen.findByTestId('wb-rt-detail-1'));
    await screen.findByTestId('wb-l2-row-1-2');

    // ① 表头：新列存在；旧列名「累计盈亏」**消失**（改名生效，非新增并列）
    expect(screen.getByTestId('wb-l2-th-cost-1')).toHaveTextContent('持仓成本');
    expect(screen.getByTestId('wb-l2-th-sellpnl-1')).toHaveTextContent('本笔卖出盈亏');
    expect(screen.getByTestId('wb-l2-th-cum-realized-pnl-1')).toHaveTextContent('累计已实现盈亏');
    expect(screen.getByTestId('wb-l2-th-cum-cashflow-1')).toHaveTextContent('累计净现金流');
    expect(screen.queryByText('累计盈亏')).toBeNull(); // 裸用旧名 ⇒ 违约

    // ② 列顺序（架构侧钦定）：金额 / 佣金 / 印花税 / 持仓成本 / 本笔卖出盈亏 / 累计佣金 / 累计印花税 /
    //    累计已实现盈亏 / 累计净现金流 / 来源 / 操作
    const headerIds = screen.getAllByTestId(/^wb-l2-th-/).map((th) => th.getAttribute('data-testid'));
    expect(headerIds).toEqual([
      'wb-l2-th-bar-1', 'wb-l2-th-ts-1', 'wb-l2-th-side-1', 'wb-l2-th-qty-1', 'wb-l2-th-price-1',
      'wb-l2-th-value-1', 'wb-l2-th-commission-1', 'wb-l2-th-stamp-1', 'wb-l2-th-cost-1', 'wb-l2-th-sellpnl-1',
      'wb-l2-th-cum-commission-1', 'wb-l2-th-cum-stamp-1', 'wb-l2-th-cum-realized-pnl-1', 'wb-l2-th-cum-cashflow-1',
      'wb-l2-th-source-1', 'wb-l2-th-op-1',
    ]);

    // ③ 持仓成本：买行 = 该笔后含费移动加权单位成本；全平（末笔）⇒ —
    //    买 100@10（费 5）⇒ 10.05；再买 100@10.20（费 5）⇒ 2030/200 = 10.150；末笔全平 ⇒ 无持仓
    expect(screen.getByTestId('wb-l2-cost-1-0')).toHaveTextContent('10.050');
    expect(screen.getByTestId('wb-l2-cost-1-1')).toHaveTextContent('10.150');
    expect(screen.getByTestId('wb-l2-cost-1-2')).toHaveTextContent('—');

    // ④ 本笔卖出盈亏：买行 —；卖行 `+63.70 (+3.14%)`（63.70 / 被消耗成本 2030 = 3.14%）
    expect(screen.getByTestId('wb-l2-sellpnl-1-0')).toHaveTextContent('—');
    expect(screen.getByTestId('wb-l2-sellpnl-1-1')).toHaveTextContent('—');
    expect(screen.getByTestId('wb-l2-sellpnl-1-2')).toHaveTextContent('+63.70 (+3.14%)');
    expect(screen.getByTestId('wb-l2-sellpnl-1-2').textContent).toContain('%');

    // ⑤ 累计已实现盈亏：**首笔卖出前**买入行为 0.00（I6①：买入不改变累计 ⇒ 买入行 == 其前一笔的值；
    //    首笔卖出后买入行可正可负，故此处**不得**断言「买入行恒 ≥ 0」），末笔 == L1 pnl 文本（I5 锚点）
    expect(screen.getByTestId('wb-l2-cum-realized-pnl-1-0')).toHaveTextContent('0.00');
    expect(screen.getByTestId('wb-l2-cum-realized-pnl-1-1')).toHaveTextContent('0.00');
    expect(screen.getByTestId('wb-l2-cum-realized-pnl-1-2').textContent).toBe(screen.getByTestId('wb-rt-pnl-1').textContent);

    // ⑥ 累计净现金流（原「累计盈亏」算法一字不改）：买后大额负数；末行 == L1 pnl（对账可见性保留）
    expect(screen.getByTestId('wb-l2-cum-cashflow-1-0')).toHaveTextContent('-1005.00');
    expect(screen.getByTestId('wb-l2-cum-cashflow-1-1')).toHaveTextContent('-2030.00');
    expect(screen.getByTestId('wb-l2-cum-cashflow-1-2').textContent).toBe(screen.getByTestId('wb-rt-pnl-1').textContent);
  });

  // ── F4：对账不一致告警（冻结两侧数值） ──

  it('F4：累加 != L1 ⇒ 告警行含 Δ 且冻结展示两侧数值；audit mismatched 非空同样告警', async () => {
    const user = userEvent.setup();
    const client = apiWith({
      getWorkbenchRoundTrips: vi.fn(async () => l1Response()),
      getWorkbenchRoundTripFills: vi.fn(async (_id: string, rt: number) => {
        if (rt === 2) return l2Response(2, RT2_FILLS);
        if (rt === 3) return l2Response(3, RT3_FILLS);
        return l2Response(rt, RT1_FILLS);
      }),
      getRunAudit: vi.fn(async () => AUDIT_BASE),
    });
    const { run, result } = await mkRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);

    // rt3：L1.commission=99 而 Σ L2=15.25 ⇒ Δ=83.75，两侧数值都必须在场（禁静默按 L1 渲染）
    await user.click(await screen.findByTestId('wb-rt-detail-3'));
    const warn3 = await screen.findByTestId('wb-rt-reconcile-3');
    expect(warn3).toHaveAttribute('role', 'alert');
    expect(warn3).toHaveTextContent('对账不一致');
    expect(warn3).toHaveTextContent('commission');
    expect(warn3).toHaveTextContent('L1 99.00');
    expect(warn3).toHaveTextContent('累计 15.25');
    expect(warn3).toHaveTextContent('Δ 83.75');
    // 冻结展示：L1 行仍显示 L1 值（不被改写），L2 累计行仍显示累计值
    expect(screen.getByTestId('wb-rt-commission-3')).toHaveTextContent('99.00');

    // rt2：两侧数值一致，但后端 audit 报该回合不一致 ⇒ 仍必须告警（D10）
    await user.click(screen.getByTestId('wb-rt-detail-2'));
    const warn2 = await screen.findByTestId('wb-rt-reconcile-2');
    expect(warn2).toHaveTextContent('audit rt_reconcile.mismatched');
    expect(warn2).toHaveTextContent('rt_seq 2');
  });

  // ── F12：K 线标记取数完整性（> 首页大小 ⇒ 分页拉全 + 显式披露） ──

  it('F12：成交 > 首页大小 ⇒ 分页拉全（消费 next_offset）并显式披露 总量/已加载量', async () => {
    const first = SERIES_PAGE_SIZE;
    const total = first + 3;
    const mk = (n: number, off: number): WorkbenchRunFill[] =>
      Array.from({ length: n }, (_, i) => ({
        type: 'fill' as const,
        bar_index: off + i,
        ts: T0 + (off + i) * DAY,
        side: 'Buy' as const,
        qty: 100,
        price: 10,
        reason: 'Policy' as const,
        rt_seq: 1,
        trade_value: 1000,
        commission: 5,
        stamp_duty: 0,
      }));
    const fillsSpy = vi.fn(async (_id: string, q?: { offset?: number; limit?: number }): Promise<WorkbenchFillsResponse> => {
      const offset = q?.offset ?? 0;
      const rows = offset === 0 ? mk(first, 0) : mk(3, first);
      return {
        run_id: 'x', total, offset, limit: q?.limit ?? SERIES_PAGE_SIZE,
        has_more: offset === 0, next_offset: offset === 0 ? first : null, recorded: true, fills: rows,
      };
    });
    const client = apiWith({ getWorkbenchFills: fillsSpy });
    const { run, result } = await mkRunAndResult(client);
    render(<ResultView {...mkProps(run, result, { api: client })} />);

    await waitFor(() => expect(fillsSpy).toHaveBeenCalledTimes(2));
    expect(fillsSpy.mock.calls[0]![1]).toEqual({ limit: SERIES_PAGE_SIZE });
    expect(fillsSpy.mock.calls[1]![1]).toEqual({ offset: first, limit: SERIES_PAGE_SIZE });
    const note = await screen.findByTestId('wb-fills-note');
    expect(note).toHaveTextContent('精确源 /fills');
    expect(note).toHaveTextContent(`成交合计 ${total} 笔`);
    expect(note).toHaveTextContent(`已加载 ${total} / 共 ${total}`);
  });
});
