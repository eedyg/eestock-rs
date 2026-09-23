import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createSyncChartStub, makeSeries } from '@/test/syncChartStub';
import { createMockClient } from '@/api/mock';
import type { Bar, FillReason, Period, WorkbenchRunFill, WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
import { KlineChart, HIGHLIGHT_DURATION_MS, HIGHLIGHT_PULSE_MS, type KlineChartFeedLike } from '@/features/dashboard/KlineChart';
import { ResultView } from './ResultView';
import { buildMarkers, makeFillKey } from './KlineResultChart';

/**
 * ADR-028 §2.4b（D4.1）—— 买卖点**醒目化** + 跳转后的 **focus / 精确到笔高亮 / 曲线竖线**。
 *
 * 判据（用户原话 ①②）：
 *  ① 「K 线上最好再标注一下买卖的点」⇒ 标记 = **实心圆点 + 描边** + **价格×股数**标签（`B 8.417×118`），
 *     同 bar 多笔**可分辨**（堆叠序，禁相互遮盖），**不加跨点连线**；
 *  ② 「l2 点击跳转之后，可以 focus 到 k 线上，并且高亮一下对应的买卖标记」⇒ 跳转后：
 *     - **上栏容器内**滚动把 K 线区域带回可见（ADR-028 §2.7 第 5 项：旧「页级 `scrollIntoView`」口径
 *       已被**取代**——整页不再滚动，focus 作用域收敛到 `wb-chart-pane` 内部）；
 *     - **只高亮被点击的那一笔**（`fillKey = rt_seq:该回合成交序号`，禁按 bar 粗定位）；高亮 = 放大 + 描边脉冲，
 *       **3 秒**回常态（不得永久选中态）；脉冲 = 定时器驱动的 overlay 重绘（不重建整图）；
 *     - 各曲线视图出现**竖线标记**，保留到下一次跳转或「全览」。
 *
 * 图表面用 `@/test/syncChartStub`（klinecharts 公开面的忠实模型：无 canvas 的 jsdom 下唯一可行）。
 */

const KC_BARS = makeSeries({ count: 600, spacingMs: 86_400_000, endTs: Date.UTC(2026, 8, 14) });
const syncStub = createSyncChartStub({ bars: KC_BARS, paneWidthPx: 520, limit: { min: 1, max: 400 } });
const chartStub = Object.assign(syncStub, {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  setStyles: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  overrideIndicator: vi.fn(),
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {}),
  ),
  resetData: vi.fn(),
  setPaneOptions: vi.fn(),
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
});
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

const INDICATORS = { ma: false, vol: false, macd: false, kdj: false, boll: false, dcap: false };

/** feed：bars 已就位（marker 吸附所需），loadInitial 立即完成。 */
function feedWithBars(): KlineChartFeedLike {
  const bars: Bar[] = KC_BARS.slice(-120).map((ms) => ({
    ts: new Date(ms).toISOString(),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 0,
    amount: 0,
  }));
  return {
    bars,
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
  };
}

function fill(over: Partial<WorkbenchRunFill>): WorkbenchRunFill {
  return {
    type: 'fill',
    bar_index: 0,
    ts: 1_700_000_000,
    side: 'Buy',
    qty: 118,
    price: 8.417,
    reason: 'Policy' as FillReason,
    rt_seq: 1,
    trade_value: 993.2,
    commission: 5,
    stamp_duty: 0,
    ...over,
  };
}

function overlayCalls(name: string) {
  return chartStub.createOverlay.mock.calls
    .map((c) => c[0] as { name: string; extendData?: Record<string, unknown>; points?: unknown })
    .filter((o) => o.name === name);
}

beforeEach(() => {
  vi.clearAllMocks();
  syncStub.__events.length = 0;
  syncStub.__log.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── ① 买卖点醒目化（结构可断言） ─────────────────────────

describe('ADR-028 D4.1 ①买卖点醒目化（buildMarkers）', () => {
  it('实心圆点形态 + 价格×股数标签（B 8.417×118，fmt 口径同页面）+ 买红/卖绿/止损橙；不加连线', () => {
    const markers = buildMarkers([
      fill({ rt_seq: 1, ts: 1000, side: 'Buy', price: 8.417, qty: 118 }),
      fill({ rt_seq: 2, ts: 2000, side: 'Sell', price: 9.1, qty: 100 }),
      fill({ rt_seq: 3, ts: 3000, side: 'Sell', price: 7.7, qty: 50, reason: 'StopTrigger' }),
    ]);
    // ① 醒目化：点（dot）形态（不再是「竖线注解」），且**没有**跨点连线类 overlay
    expect(markers.every((m) => m.shape === 'dot')).toBe(true);
    expect(markers.every((m) => m.type === 'marker')).toBe(true);
    // ① 价格×股数标签：与页面既有 fmtNum 口径一致（price 3 位 / qty 4 位上限）
    expect(markers[0]!.label).toBe('B 8.417×118');
    expect(markers[1]!.label).toBe('S 9.100×100');
    expect(markers[2]!.label).toBe('⊗ 7.700×50');
    // 买红 / 卖绿 / 硬止损橙
    expect(markers[0]!.color).toBe('#ff5c6c');
    expect(markers[1]!.color).toBe('#00e0a4');
    expect(markers[2]!.color).toBe('#fb923c');
    // ② 判别身份键（rt_seq:回合成交序号；从 0 起且**逐 rt 递增**）
    expect(markers.map((m) => m.fillKey)).toEqual(['1:0', '2:0', '3:0']);
  });

  it('同 bar 多笔成交**可分辨**：堆叠序递增（互不遮盖）+ 标签各不相同', () => {
    const sameBar = 1_700_000_000;
    const markers = buildMarkers([
      fill({ rt_seq: 7, ts: sameBar, side: 'Buy', price: 8.417, qty: 118 }),
      fill({ rt_seq: 7, ts: sameBar, side: 'Buy', price: 8.5, qty: 200 }),
      fill({ rt_seq: 8, ts: sameBar, side: 'Sell', price: 8.9, qty: 318 }),
    ]);
    // 同一 ts（同 bar）三笔 ⇒ 堆叠序 0/1/2（渲染时纵向偏移，禁相互遮盖）
    expect(markers.map((m) => m.stackIndex)).toEqual([0, 1, 2]);
    expect(new Set(markers.map((m) => m.label)).size).toBe(3);
    // 判别键：同 rt 的用序号区分，不同 rt 各自从 0 起
    expect(markers.map((m) => m.fillKey)).toEqual(['7:0', '7:1', '8:0']);
  });

  it('fillKey 口径：makeFillKey 与 L2 行下标一一对应（`rt:idx`）', () => {
    expect(makeFillKey(3, 1)).toBe('3:1');
  });
});

// ───────────────────── ② 高亮：精确到笔 + 3 秒回常态（定时器驱动） ─────────────────────

describe('ADR-028 D4.1 ②高亮（KlineChart overlay 面）', () => {
  it('标记 overlay = fillDot（实心圆点 + 标签）；同 bar 堆叠序写入 extendData', async () => {
    const markers = buildMarkers([
      fill({ rt_seq: 7, ts: KC_BARS[KC_BARS.length - 2]! / 1000, side: 'Buy' }),
      fill({ rt_seq: 7, ts: KC_BARS[KC_BARS.length - 2]! / 1000, side: 'Buy', qty: 200 }),
    ]);
    render(
      <KlineChart
        feed={feedWithBars()}
        code="518880"
        period={'1d' as Period}
        followLatest={false}
        indicators={INDICATORS}
        onManualZoom={() => {}}
        overlays={markers}
      />,
    );
    await waitFor(() => expect(overlayCalls('fillDot').length).toBeGreaterThanOrEqual(2));
    // **幂等**：每次（重）同步先按名清旧 marker 再建 ⇒ 图上不会累积重复标记（两批而非四枚并存）
    expect(
      chartStub.removeOverlay.mock.calls.some((c) => (c[0] as { name?: string } | undefined)?.name === 'fillDot'),
    ).toBe(true);
    const data = overlayCalls('fillDot')
      .slice(-2)
      .map((o) => o.extendData as Record<string, unknown>);
    expect(data.map((d) => d.label)).toEqual(['B 8.417×118', 'B 8.417×200']);
    // 同 bar 两笔：堆叠序不同 ⇒ 纵向不重叠（可分辨）
    expect(data.map((d) => d.stackIndex)).toEqual([0, 1]);
    expect(data.every((d) => d.highlight === false)).toBe(true);
  });

  it('**只高亮被点击的那一笔**（fillKey 精确）+ 脉冲相位推进 + 3 秒到点回常态（overlay 被清）', async () => {
    vi.useFakeTimers();
    const markers = buildMarkers([
      fill({ rt_seq: 7, ts: KC_BARS[KC_BARS.length - 2]! / 1000, side: 'Buy', qty: 118 }),
      fill({ rt_seq: 7, ts: KC_BARS[KC_BARS.length - 2]! / 1000, side: 'Buy', qty: 200 }),
    ]);
    const { container } = render(
      <KlineChart
        feed={feedWithBars()}
        code="518880"
        period={'1d' as Period}
        followLatest={false}
        indicators={INDICATORS}
        onManualZoom={() => {}}
        overlays={markers}
        highlightFillKey={'7:1'}
        highlightRev={1}
      />,
    );
    const root = () => container.querySelector('[data-testid="kline-chart"]')!;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // 精确到笔：高亮 overlay 的 fillKey 恒为被点的那一笔（7:1），绝不出现 7:0
    const hl = () => overlayCalls('fillDotHighlight');
    expect(hl().length).toBeGreaterThan(0);
    expect(hl().every((o) => (o.extendData as Record<string, unknown>).fillKey === '7:1')).toBe(true);
    expect(hl().every((o) => (o.extendData as Record<string, unknown>).highlight === true)).toBe(true);
    // 堆叠序随目标笔携带 ⇒ 高亮落在该笔自身的偏移位（不飘到兄弟笔上）
    expect((hl()[0]!.extendData as Record<string, unknown>).stackIndex).toBe(1);
    expect(root().getAttribute('data-highlight-active')).toBe('true');
    // 脉冲：定时器推进 ⇒ 相位递增 + overlay 重绘（canvas 内无 CSS 动画）
    const before = hl().length;
    await act(async () => {
      vi.advanceTimersByTime(HIGHLIGHT_PULSE_MS);
    });
    expect(root().getAttribute('data-highlight-pulse')).toBe('2');
    expect(hl().length).toBeGreaterThan(before);
    // 3 秒到点 ⇒ 回常态（无永久选中态）
    await act(async () => {
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
    });
    expect(root().getAttribute('data-highlight-active')).toBe('false');
    expect(root().getAttribute('data-highlight-pulse')).toBe('0');
    expect(overlayCalls('fillDotHighlight').length).toBe(hl().length); // 高亮 overlay 不再新建
    expect(
      chartStub.removeOverlay.mock.calls.some(
        (c) => (c[0] as { name?: string } | undefined)?.name === 'fillDotHighlight',
      ),
    ).toBe(true);
  });
});

// ───────────────── ② 结果页集成：focus 滚动 + 精确到笔高亮 + 曲线竖线 ─────────────────

const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
const BASE = {
  symbol: '518880',
  period: 'D1',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  policy: { LumpSum: { position_pct: 1 } } as const,
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
};

describe('ADR-028 D4.1 ②结果页：L2 跳转 ⇒ focus 滚动 + 精确到笔高亮 + 曲线竖线', () => {
  it('点击 L2 第 2 笔跳转：上栏容器内 focus 滚动（页级 scrollIntoView 已废弃）；高亮键 = rt_seq:1；曲线出现竖线；「全览」清除', async () => {
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    const run = await api.submitWorkbenchRun({
      ...BASE,
      name: 'D4.1 focus/highlight',
      slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
      stop: { kind: 'FixedPct', value: 0.08, trigger: 'Intrabar' },
    });
    const result: WorkbenchRunResult = await api.getWorkbenchResult(run.id);
    const view: WorkbenchRunView = run;
    // L1 列表（`/round-trips`）：挑一个 `l2_count ≥ 2` 的回合（同回合两笔 ⇒ 可断言「精确到笔」）
    const l1 = await api.getWorkbenchRoundTrips(run.id, { offset: 0, limit: 100 });
    const user = userEvent.setup();
    const { container } = render(
      <ResultView run={view} result={result} loading={false} error={null} onRetry={() => {}} api={api} catalog={null} />,
    );

    // 找一个 l2_count ≥ 2 的回合（回合区间内至少两笔 ⇒ 可断言「精确到笔」）
    await waitFor(() => expect(screen.getByTestId('wb-round-trips-table')).toBeTruthy());
    const target = l1.round_trips.find((rt) => rt.l2_count >= 2);
    if (!target) throw new Error('mock 数据无 l2_count≥2 的回合（无法构造「同回合两笔」）');
    const rtSeq = target.rt_seq;
    await user.click(screen.getByTestId(`wb-rt-detail-${rtSeq}`));
    await waitFor(() => expect(screen.getByTestId(`wb-l2-row-${rtSeq}-1`)).toBeTruthy());
    const fillTs = Number(screen.getByTestId(`wb-l2-row-${rtSeq}-1`).querySelector('td')!.textContent);

    scrollIntoView.mockClear();
    const focusRevBefore = Number(screen.getByTestId('wb-chart-pane').getAttribute('data-focus-scroll') ?? '0');
    await user.click(screen.getByTestId(`wb-l2-jump-${rtSeq}-1`));

    // ① focus（契约变更推导：ADR-028 §2.7 第 5 项「作用域收敛到上栏容器内」）
    //    旧断言 = `scrollIntoView` 被调用（页级滚动）；新断言 = 上栏容器内发生 focus 滚动，
    //    且**页级 `scrollIntoView` 不得再被调用**（否则作用域未收敛、会连带滚动祖先容器）。
    await waitFor(() =>
      expect(Number(screen.getByTestId('wb-chart-pane').getAttribute('data-focus-scroll') ?? '0')).toBeGreaterThan(
        focusRevBefore,
      ),
    );
    expect(scrollIntoView, 'focus 滚动不得再用页级 scrollIntoView（作用域必须收敛到上栏）').not.toHaveBeenCalled();
    // ② 高亮：**只高亮被点击的那一笔**（键 = rt_seq:1）
    await waitFor(() => expect(screen.getByTestId('kline-chart').getAttribute('data-highlight-key')).toBe(makeFillKey(rtSeq, 1)));
    expect(screen.getByTestId('wb-jump-highlight-note').getAttribute('data-state')).toBe('ok');
    // ③ 曲线竖线：四视图同一时点各一条（保留到下一次跳转 / 「全览」）
    await waitFor(() => expect(container.querySelectorAll('[data-testid="wb-vline"]').length).toBeGreaterThan(0));
    const vlines = Array.from(container.querySelectorAll('[data-testid="wb-vline"]'));
    expect(new Set(vlines.map((v) => v.getAttribute('data-vline-ts'))).size).toBe(1);
    expect(Number(vlines[0]!.getAttribute('data-vline-ts'))).toBeGreaterThan(0);
    // ① 高亮 3 秒后回常态不由本用例断言（见 KlineChart 级定时器用例）；此处断言键一直指向目标笔
    expect(screen.getByTestId('wb-kline-focus-anchor').getAttribute('data-marker-ts')).not.toBe('');
    // 「全览」⇒ 清竖线 + 清高亮（不得留永久选中态）
    await user.click(screen.getByTestId('wb-window-reset'));
    await waitFor(() => expect(container.querySelectorAll('[data-testid="wb-vline"]').length).toBe(0));
    expect(screen.getByTestId('kline-chart').getAttribute('data-highlight-key')).toBe('');
    void fillTs;
  });
});
