import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createSyncChartStub } from '@/test/syncChartStub';
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { createMockClient } from '@/api/mock';
import type { ApiClient } from '@/api/client';
import type { WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
import { ResultView } from './ResultView';

/**
 * ADR-028 §2.10 **D10**（真值写回 / 活体披露 / 取数与 x 域同源）——结果页**集成层**判据。
 *
 * 图表面 = `@/test/syncChartStub`（忠实模型：`setBarSpace` 越界静默 return、索引空间可见范围、
 * 写操作派发 `onVisibleRangeChange`），因此本文件能真跑到：写窗 → 回执 → **其后真身被改写** 的全链。
 *
 * 「假绿复现」（D10 决策 3 的判别点）：旧口径下 `data-ok` = **一次性快照**（写窗当时成功即 true），
 * 故「写窗成功 → 其后真身被改写」在旧口径里**恒绿**；本文件第 2 条用例要求它**必红**。
 */

const BASE = {
  symbol: '518880',
  period: 'M5',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  policy: { LumpSum: { position_pct: 1 } } as const,
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
};

type MockFn = ReturnType<typeof vi.fn>;
interface ChartStub extends ReturnType<typeof createSyncChartStub> {
  setSymbol: MockFn;
  setPeriod: MockFn;
  setDataLoader: MockFn;
  setStyles: MockFn;
  createIndicator: MockFn;
  removeIndicator: MockFn;
  overrideIndicator: MockFn;
  getIndicators: MockFn;
  resetData: MockFn;
  setPaneOptions: MockFn;
  createOverlay: MockFn;
  removeOverlay: MockFn;
  resize: MockFn;
  convertToPixel: MockFn;
}
let chartStub: ChartStub;
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
});

function installStub(bars: number[], paneWidthPx: number): ReturnType<typeof createSyncChartStub> {
  const stub = createSyncChartStub({ bars, paneWidthPx, limit: { min: 1, max: 400 } });
  chartStub = Object.assign(stub, {
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
  }) as unknown as ChartStub;
  return stub;
}

async function seed(api: ApiClient, bars: number): Promise<{ run: WorkbenchRunView; result: WorkbenchRunResult }> {
  const run = await api.submitWorkbenchRun({
    ...BASE,
    name: 'D10 活体披露',
    slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
  });
  const result = await api.getWorkbenchResult(run.id);
  void bars;
  return { run, result };
}

/** 真身读数（对账基准）：可见 bar 的 ts 区间 + 索引 + barSpace。 */
function stubLive(stub: ReturnType<typeof createSyncChartStub>) {
  const r = stub.getVisibleRange();
  const from = Math.round(r.from);
  const to = Math.round(r.to);
  return {
    from_idx: from,
    to_idx: to,
    from_ts: Math.floor(stub.__bars[from]! / 1000),
    to_ts: Math.floor(stub.__bars[to]! / 1000),
    bars: to - from + 1,
    bar_space: stub.getBarSpace().bar,
  };
}

function probe(el: HTMLElement, attr: string): string | null {
  return el.getAttribute(attr);
}

async function jumpL2Row0(api: ApiClient, runId: string): Promise<void> {
  // 取**中部**回合的 L2 行：首/末回合贴数据边缘，其窗口会被数据边界夹取（不能作为默认构造）
  const rts = await api.getWorkbenchRoundTrips(runId);
  const list = (rts.round_trips ?? []).filter((r) => (r.l2_count ?? 0) > 0);
  expect(list.length).toBeGreaterThan(0);
  const mid = list[Math.floor(list.length / 2)]!;
  await userEvent.click(screen.getByTestId(`wb-rt-detail-${mid.rt_seq}`));
  const row = await screen.findByTestId(`wb-l2-row-${mid.rt_seq}-0`);
  expect(row).toBeTruthy();
  const jump = screen.getByTestId(`wb-l2-jump-${mid.rt_seq}-0`);
  await userEvent.click(jump);
  await waitFor(() => expect(screen.getByTestId('wb-window-state').getAttribute('data-source')).toBe('jump'));
}

describe('D10-2 真值写回：目标不可达被夹取 ⇒ 窗口状态机 == 实测可达区间（K 线真身为准）', () => {
  it('L2 请求 120 根而面板仅容 100 根 ⇒ 页面窗口被写回实测可达区间，且 wb-window-clamped 按活体披露', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 600 });
    const { run, result } = await seed(api, 600);
    const bars = result.per_bar.map((b) => b.ts * 1000);
    // 面板 100px < 请求窗口 120 根 ⇒ 物理上不可达（bs 恒落 min=1）
    const stub = installStub(bars, 100);
    stub.__setRightIndex(bars.length - 1);

    render(<ResultView run={run} result={result} loading={false} error={null} onRetry={() => {}} api={api} catalog={null} />);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await jumpL2Row0(api, run.id);
    await waitFor(() => expect(screen.getByTestId('wb-window-probe').getAttribute('data-applied-ok')).toBe('true'));

    const live = stubLive(stub);
    const probeEl = screen.getByTestId('wb-window-probe');
    const state = screen.getByTestId('wb-window-state');
    // ① 活体探针 == 真身读数（逐字段）
    expect(probe(probeEl, 'data-live-bar-space')).toBe(String(live.bar_space));
    expect(probe(probeEl, 'data-live-from-ts')).toBe(String(live.from_ts));
    expect(probe(probeEl, 'data-live-to-ts')).toBe(String(live.to_ts));
    expect(probe(probeEl, 'data-live-bars')).toBe(String(live.bars));
    // ② 窗口状态机被写回实测可达区间（**不是**请求区间）
    expect(state.getAttribute('data-from-ts')).toBe(String(live.from_ts));
    expect(state.getAttribute('data-to-ts')).toBe(String(live.to_ts));
    expect(state.getAttribute('data-span-bars')).toBe(String(live.bars));
    expect(live.bars).toBeLessThan(120); // 确实不可达（否则本用例失去意义）
    // ③ 申请回执保留 requested 侧读数（区分「申请」与「生效」）
    expect(Number(probe(probeEl, 'data-applied-requested-bar-space'))).toBe(1);
    // ④ 钳位披露含 requested/observed 两侧（请求 120 根 / 实测可达 N 根）
    const clamped = await screen.findByTestId('wb-window-clamped');
    expect(clamped.textContent).toContain('被钳位');
    expect(clamped.textContent).toContain('120 根');
    expect(clamped.textContent).toContain(`${live.bars} 根`);
    // ⑤【§2.10.1 裁决 1】「申请未被逐值兑现」（不可达夹取）**不得**把 ok 打成 false：
    //    ok 对照**生效值**（applied.observed.bar_space）+ **写回后的窗口域**；夹取由 wb-window-clamped 披露。
    expect(probe(probeEl, 'data-live-bar-space')).toBe(probe(probeEl, 'data-applied-bar-space'));
    expect(probe(probeEl, 'data-ok'), '钳位态不得因钳位而 ok=false').toBe('true');
    expect(probe(probeEl, 'data-live-reasons')).toBe('');
  });

  it('全览（请求全区间）被物理上限夹取 ⇒ 以实测可达区间建立窗口状态（source=reset）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 600 });
    const { run, result } = await seed(api, 600);
    const bars = result.per_bar.map((b) => b.ts * 1000);
    const stub = installStub(bars, 100); // 600 根 run 在 100px 面板上物理不可全见
    stub.__setRightIndex(bars.length - 1);

    render(<ResultView run={run} result={result} loading={false} error={null} onRetry={() => {}} api={api} catalog={null} />);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await userEvent.click(screen.getByTestId('wb-window-reset'));
    await waitFor(() => expect(screen.getByTestId('wb-window-probe').getAttribute('data-applied-ok')).toBe('true'));

    const live = stubLive(stub);
    const state = screen.getByTestId('wb-window-state');
    expect(state.getAttribute('data-source')).toBe('reset');
    expect(state.getAttribute('data-from-ts')).toBe(String(live.from_ts));
    expect(state.getAttribute('data-to-ts')).toBe(String(live.to_ts));
    expect(state.getAttribute('data-span-bars')).toBe(String(live.bars));
    expect(live.bars).toBeLessThan(600);
    // 物理上限披露仍在（显示 N / 共 M 根）
    const cap = await screen.findByTestId('wb-window-cap');
    expect(cap.textContent).toContain(`显示 ${live.bars} / 共 600 根`);
    // §2.10.1 裁决 1/2：全览被物理上限夹取 ⇒ 写回实测可达区间 ⇒ 活体一致（ok=true、无 reason）
    const probeEl = screen.getByTestId('wb-window-probe');
    expect(probe(probeEl, 'data-ok')).toBe('true');
    expect(probe(probeEl, 'data-live-reasons')).toBe('');
  });
});

describe('D10-3 活体披露：ok 必须包含「当前一致」（假绿复现 ⇒ 必红）', () => {
  it('写窗成功后真身被改写（5→20）⇒ data-ok 必红；同一时刻 data-applied-ok 仍为 true（旧快照语义 = 假绿）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 600 });
    const { run, result } = await seed(api, 600);
    const bars = result.per_bar.map((b) => b.ts * 1000);
    const stub = installStub(bars, 520);
    stub.__setRightIndex(bars.length - 1);

    render(<ResultView run={run} result={result} loading={false} error={null} onRetry={() => {}} api={api} catalog={null} />);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await jumpL2Row0(api, run.id);
    const probeEl = screen.getByTestId('wb-window-probe');
    await waitFor(() => expect(probeEl.getAttribute('data-ok')).toBe('true'));
    const appliedBs = Number(probeEl.getAttribute('data-applied-requested-bar-space'));
    expect(appliedBs).toBeGreaterThan(0);

    // 变异：真身被**外部写入者**改写（实测：程序化跳转后 16ms 被 ResizeObserver 重拟合 5→6）
    await act(async () => {
      stub.setBarSpace(20);
    });
    await waitFor(() => expect(probeEl.getAttribute('data-live-bar-space')).toBe('20'));
    expect(probeEl.getAttribute('data-ok')).toBe('false'); // ⇐ 旧口径在此恒为 'true'（假绿）
    expect(probeEl.getAttribute('data-applied-ok')).toBe('true'); // 申请回执本身仍是成功的
    expect(probeEl.getAttribute('data-live-consistent')).toBe('false');
    // §2.10.1 裁决 1：reason 文案必须落在「**被改写**」类；「校准/夹取」是 wb-window-clamped 的职责
    const reasons = probeEl.getAttribute('data-live-reasons') ?? '';
    expect(reasons).toContain('被改写');
    expect(reasons).not.toContain('校准');
    expect(reasons).not.toContain('夹取');
  });

  it('一致态：data-ok=true 且 live 字段与真身读数逐字段相同', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 600 });
    const { run, result } = await seed(api, 600);
    const bars = result.per_bar.map((b) => b.ts * 1000);
    const stub = installStub(bars, 520);
    stub.__setRightIndex(bars.length - 1);

    render(<ResultView run={run} result={result} loading={false} error={null} onRetry={() => {}} api={api} catalog={null} />);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await jumpL2Row0(api, run.id);
    const probeEl = screen.getByTestId('wb-window-probe');
    await waitFor(() => expect(probeEl.getAttribute('data-ok')).toBe('true'));
    const live = stubLive(stub);
    expect(probeEl.getAttribute('data-live-from-idx')).toBe(String(live.from_idx));
    expect(probeEl.getAttribute('data-live-to-idx')).toBe(String(live.to_idx));
    expect(probeEl.getAttribute('data-live-from-ts')).toBe(String(live.from_ts));
    expect(probeEl.getAttribute('data-live-to-ts')).toBe(String(live.to_ts));
    expect(probeEl.getAttribute('data-live-bar-space')).toBe(String(live.bar_space));
  });
});

describe('D10-4 消除剔除：曲线取数与 x 域同源（含「先应用后改变」）', () => {
  it('跳转后曲线取数窗口 = 真身可见域 ⇒ 无 wb-curve-unmatched（旧口径在该构造下 > 0）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 600 });
    const { run, result } = await seed(api, 600);
    const bars = result.per_bar.map((b) => b.ts * 1000);
    const stub = installStub(bars, 520);
    stub.__setRightIndex(bars.length - 1);
    const curveSpy = vi.spyOn(api, 'getWorkbenchCurve');

    render(<ResultView run={run} result={result} loading={false} error={null} onRetry={() => {}} api={api} catalog={null} />);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await jumpL2Row0(api, run.id);
    curveSpy.mockClear();

    // 「先应用后改变」：真身可见域被移到**别处**（窗口状态机因回声抑制仍停在跳转窗）
    const shiftedRight = Math.max(0, stub.__rightIndex() - 200);
    await act(async () => {
      stub.scrollToDataIndex(shiftedRight); // 真身引擎写操作（派发 onScroll + onVisibleRangeChange）
    });
    const live = stubLive(stub);
    expect(live.to_idx, '真身确实已移动（否则本构造失去意义）').toBeLessThan(shiftedRight + 1);

    await waitFor(() => {
      const hits = curveSpy.mock.calls.filter(([, q]) => (q as { from_ts?: number }).from_ts != null);
      expect(hits.length).toBeGreaterThan(0);
      const last = hits[hits.length - 1]![1] as { from_ts: number; to_ts: number };
      // 取数窗口必须跟随**真身**（不得停在声明/跳转窗口）
      expect(last.from_ts).toBe(live.from_ts);
      expect(last.to_ts).toBe(live.to_ts);
    });
    // 剔除率 0（聚合卡不出现「N 点不在 K 线 bar 序列上（已剔除）」）
    await waitFor(() => expect(screen.queryByTestId('wb-curve-unmatched')).toBeNull());
    const poly = document.querySelector('[data-testid="wb-aggregate-chart"] svg polyline');
    const pts = (poly?.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean).length;
    expect(pts).toBeGreaterThan(0);
    expect(pts).toBeLessThanOrEqual(live.bars);
  });
});
