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
 * ADR-028 D2.1 / D2.3（2026-09-20 修复波）——结果页**时间轴对齐**的三项硬修复（前端集成层）：
 *
 * 1. **x 映射 = bar 索引空间（主路）**：曲线 x 必须由「K 线所绘制的同一 bar 序列」+ ts→索引查表决定；
 *    本用例通过**在同一 bar 序列里插入「曲线没有的 bar」**制造 ts 线性与索引线性的可判别差
 *    （纯 ts 间距均匀 ⇒ ts 线性映射会与索引映射给出不同 x）；
 * 2. **窗口 ↔ 视口双向精确**：K 线交互发布的必须是 `getVisibleRange()` 的**实际值**；程序化写窗后
 *    必须回读并按实测发布 + **显式披露被钳位**；
 * 3. **数据/定义域原子切换**：窗口变化后，新定义域**只能**在新数据（同 rev）到位后应用（旧数据 + 新域禁止）。
 *
 * 图表面 = `@/test/syncChartStub`（忠实模型：`setBarSpace` 越界静默 return、索引空间可见范围）。
 */
const BASE = {
  symbol: '518880',
  period: 'M5',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  policy: { LumpSum: { position_pct: 1 } } as const,
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
};

/** 曲线（run per_bar）的 ts 序列：均匀 M5（无缺口，且**不**落在整 5 分钟的整点，模拟真身 offset）。 */
function curveTs(result: WorkbenchRunResult): number[] {
  return result.per_bar.map((b) => b.ts);
}

/**
 * 合成「K 线所绘制的 bar 序列」：在曲线 ts 之间**插入额外 bar**（曲线没有的 bar）
 * ⇒ bar 索引 ≠ ts 比例（这正是「缺口折叠」的可判别形式）。
 * 返回 [barTsSec, extrasPerGap]。
 */
function klineSeries(curveSec: number[], extrasPerGap: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < curveSec.length; i++) {
    out.push(curveSec[i]!);
    for (let k = 1; k <= extrasPerGap; k++) {
      out.push(curveSec[i]! + k * 5);
    }
  }
  return out;
}

async function seed(api: ApiClient): Promise<{ run: WorkbenchRunView; result: WorkbenchRunResult }> {
  const run = await api.submitWorkbenchRun({
    ...BASE,
    name: '轴对齐修复波',
    slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
  });
  const result = await api.getWorkbenchResult(run.id);
  return { run, result };
}

/** 一次 render + 返回图表面桩（chartStub 在 vi.mock 工厂里创建，见下方 setupStub）。 */
function renderWithStub(run: WorkbenchRunView, result: WorkbenchRunResult, api: ApiClient) {
  return render(
    <ResultView run={run} result={result} loading={false} error={null} onRetry={() => {}} api={api} catalog={null} />,
  );
}

// ── 图表面桩（与 resultWindowSync.test.tsx 同款：workbench 结果页唯一图实例） ──
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

function installStub(bars: number[]): ReturnType<typeof createSyncChartStub> {
  const stub = createSyncChartStub({ bars, paneWidthPx: 520, limit: { min: 1, max: 400 } });
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

/** 读取已渲染 polyline 的首个 x（user units）。 */
function firstPolyX(testId: string): number | null {
  const poly = document.querySelector(`[data-testid="${testId}"] svg polyline`);
  const pts = poly?.getAttribute('points') ?? '';
  if (!pts.trim()) return null;
  return Number(pts.trim().split(/\s+/)[0]!.split(',')[0]);
}

const PAD = 8;
const PLOT_W = 1000 - 2 * PAD;

describe('ADR-028 D2.1 主路：曲线 x = bar 索引空间（禁 ts 线性）', () => {
  it('K 线交互后：x 由 ts→bar 索引查表决定（同一 ts 线性映射会给出不同 x ⇒ 可判别）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const { run, result } = await seed(api);
    const cTs = curveTs(result);
    // 每两个曲线点之间插 3 根「曲线没有的 bar」⇒ 索引线性 vs ts 线性出现可判别差
    const bars = klineSeries(cTs, 3).map((s) => s * 1000);
    const stub = installStub(bars);
    // 可见窗 = 末 52 根（barSpace=10、pane 520px）⇒ 覆盖曲线尾段
    stub.__setRightIndex(bars.length - 1);

    renderWithStub(run, result, api);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await waitFor(() => {
      expect(screen.getByTestId('wb-aggregate-chart').getAttribute('data-x-mode')).toBe('index');
    });
    await waitFor(() => expect(firstPolyX('wb-aggregate-chart')).not.toBeNull());

    // 期望：x 由**索引**决定（首尾铺满 plot；相邻点的槽距 = 1/(可见根数-1)）
    const range = stub.getVisibleRange();
    const slots = Math.round(range.to) - Math.round(range.from) + 1;
    const slot = PLOT_W / (slots - 1);
    const x0 = firstPolyX('wb-aggregate-chart')!;
    const x1 = Number(
      document.querySelector('[data-testid="wb-aggregate-chart"] svg polyline')!.getAttribute('points')!.trim().split(/\s+/)[1]!.split(',')[0],
    );
    // 相邻曲线点之间隔了 3 根「曲线没有的 bar」⇒ 索引空间间隔 = 4 槽
    expect(x1 - x0).toBeCloseTo(4 * slot, 1);
    // ts 线性映射的间隔 = 5s/(窗口 ts 跨度) · plot ≠ 4 槽（本序列 ts 均匀、bar 序列非均匀）
    const tsSpan = bars[bars.length - 1]! / 1000 - bars[Math.round(range.from)]! / 1000;
    const tsLinearStep = (5 / tsSpan) * PLOT_W;
    expect(Math.abs(4 * slot - tsLinearStep)).toBeGreaterThan(1);
  });
});

describe('ADR-028 D2.3-2：数据/定义域**原子切换**（禁旧数据 + 新域）', () => {
  it('全览：曲线按**实测可达区间**重取（= 可见域；D10-4 同源）且定义域 = 可达区间 + 物理上限披露', async () => {
    // 600 根 run：全览把 barSpace 压到下限 1 ⇒ 面板 520px 只能显示 520 根 ⇒ **物理上限**必现
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z'), workbenchResultBars: 600 });
    const { run, result } = await seed(api);
    const cTs = curveTs(result);
    const bars = klineSeries(cTs, 0).map((s) => s * 1000);
    const stub = installStub(bars);
    stub.__setRightIndex(bars.length - 1);
    const curveSpy = vi.spyOn(api, 'getWorkbenchCurve');

    renderWithStub(run, result, api);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await waitFor(() =>
      expect(curveSpy.mock.calls.some(([], i) => (curveSpy.mock.calls[i]![1] as { from_ts?: number }).from_ts != null)).toBe(true),
    );

    curveSpy.mockClear();
    await userEvent.click(screen.getByTestId('wb-window-reset'));
    // D10-4：取数窗口必须与 x 域**同源** ⇒ 全览取数窗口 = **K 线真身可见 ts 区间**
    // （旧口径：「全览不带窗口参数取全区间」+ x 域取真身切片 ⇒ 两源错位、逐点剔除）
    await waitFor(() => {
      const hits = curveSpy.mock.calls.filter(([id]) => id === run.id);
      expect(hits.length).toBeGreaterThan(0);
      // **最后一次**取数（稳定态）必须与真身可见域同源；写入后的瞬时旧窗口取数由 rev/原子提交机制作废
      const probe0 = screen.getByTestId('wb-window-probe');
      const liveFrom = Number(probe0.getAttribute('data-live-from-ts'));
      const liveTo = Number(probe0.getAttribute('data-live-to-ts'));
      const last = hits[hits.length - 1]![1] as { from_ts?: number; to_ts?: number };
      expect(last.from_ts).toBe(liveFrom);
      expect(last.to_ts).toBe(liveTo);
    });
    // 定义域 = **可达区间**（= 窗口写回值 = 真身可见域；D10-2/D10-4）
    const probe = screen.getByTestId('wb-window-probe');
    const state = screen.getByTestId('wb-window-state');
    expect(state.getAttribute('data-source')).toBe('reset');
    expect(state.getAttribute('data-from-ts')).toBe(probe.getAttribute('data-live-from-ts'));
    expect(state.getAttribute('data-to-ts')).toBe(probe.getAttribute('data-live-to-ts'));
    await waitFor(() =>
      expect(screen.getByTestId('wb-aggregate-chart').getAttribute('data-x-domain')).toBe(
        `${probe.getAttribute('data-live-from-ts')},${probe.getAttribute('data-live-to-ts')}`,
      ),
    );
    // D2.3-3：全览的物理上限必须显式披露（显示 N / 共 M 根）
    const cap = await screen.findByTestId('wb-window-cap');
    expect(cap.textContent).toContain('显示');
    expect(cap.textContent).toContain('共 600 根');
    expect(cap.textContent).toContain('受渲染上限约束');
    // 曲线必须跟随**同一实际可见范围**（不得自行扇伸到全量）：渲染点数 ≈ 实际可见根数
    const visible = Number(probe.getAttribute('data-live-to-idx')) - Number(probe.getAttribute('data-live-from-idx')) + 1;
    expect(visible).toBe(520);
    const polyCount = (document.querySelector('[data-testid="wb-aggregate-chart"] svg polyline')!.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    expect(polyCount).toBeLessThanOrEqual(visible);
    expect(polyCount).toBeGreaterThan(0.5 * visible);
    // D10-4：剔除率 0（旧口径在本态实测剔除 75/177 = 42%）
    expect(screen.queryByTestId('wb-curve-unmatched')).toBeNull();
  });

  it('窗口变化期间：新数据未到位 ⇒ **不得**用新域渲染旧数据（保持上一组一致快照）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const { run, result } = await seed(api);
    const cTs = curveTs(result);
    const bars = klineSeries(cTs, 1).map((s) => s * 1000);
    const stub = installStub(bars);
    stub.__setRightIndex(bars.length - 1);

    // 让**窗口**取数整体挂起（单一闸门），观察挂起期间的渲染态
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const realCurve = api.getWorkbenchCurve.bind(api);
    vi.spyOn(api, 'getWorkbenchCurve').mockImplementation(async (id, q) => {
      if ((q as { from_ts?: number }).from_ts != null) await gate;
      return realCurve(id, q);
    });

    const count = () =>
      (document.querySelector('[data-testid="wb-aggregate-chart"] svg polyline')?.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

    renderWithStub(run, result, api);
    await waitFor(() => expect(screen.getByTestId('wb-window-bar')).toBeTruthy());
    // 首屏（全区间）已落定：曲线点数 = 全区间点数
    await waitFor(() => expect(count()).toBeGreaterThan(0));
    const beforeWindow = count();
    await act(async () => {
      stub.__fireAction('onVisibleRangeChange');
    });
    await waitFor(() => expect(screen.getByTestId('wb-window-load-note')).toBeTruthy());
    // 窗口取数在飞：加载态必须显式标注；曲线仍保持**上一组**（全区间）数据快照
    const note = screen.getByTestId('wb-window-load-note').textContent ?? '';
    expect(note).toContain('窗口加载中');
    const whileLoading = count();
    expect(whileLoading).toBe(beforeWindow); // 新窗口数据未到 ⇒ **不得**换（旧数据 + 新域禁止）
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(screen.getByTestId('wb-window-load-note').textContent).toContain('窗口已应用'));
    // 数据与定义域**一起**切换：新窗口数据的点数必然更少（52 根可见窗）
    await waitFor(() => expect(count()).toBeLessThan(whileLoading));
  });
});

describe('ADR-028 D2.3-1：程序化写窗回读 + 钳位披露', () => {
  it('L2 跳转：请求 120 根但引擎实测 ≠ 120 ⇒ 显式披露「被钳位」（回执 ok / 活体 ok 分列）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
    const { run, result } = await seed(api);
    const cTs = curveTs(result);
    const bars = klineSeries(cTs, 1).map((s) => s * 1000);
    const stub = installStub(bars);
    stub.__setRightIndex(bars.length - 1);

    renderWithStub(run, result, api);
    const rows = await screen.findAllByTestId(/^wb-rt-detail-/);
    expect(rows.length).toBeGreaterThan(0);
    await userEvent.click(rows[0]!);
    const jump = (await screen.findAllByTestId(/^wb-l2-jump-/))[0]!;
    await userEvent.click(jump);
    await waitFor(() => expect(screen.getByTestId('wb-window-state').getAttribute('data-source')).toBe('jump'));
    // 申请回执：写窗**当时**成功（`setBarSpace` 未被静默吞掉）
    await waitFor(() => expect(screen.getByTestId('wb-window-probe').getAttribute('data-applied-ok')).toBe('true'));
    const clamped = await screen.findByTestId('wb-window-clamped');
    expect(clamped.textContent).toContain('被钳位');
    // 发布的是**实测值**（页面窗口 == 真身可见域），不是请求值
    const probe = screen.getByTestId('wb-window-probe');
    const state = screen.getByTestId('wb-window-state');
    expect(state.getAttribute('data-from-ts')).toBe(probe.getAttribute('data-live-from-ts'));
    expect(state.getAttribute('data-to-ts')).toBe(probe.getAttribute('data-live-to-ts'));
    expect(state.getAttribute('data-span-bars')).toBe(probe.getAttribute('data-live-bars'));
    // **§2.10.1 裁决 1**（2026-09-25 架构侧裁决，取代 D10-3 原文口径）：
    // `data-ok` 对照**生效值**（`applied.observed.bar_space`）+ 写回后的窗口域，**不**对照 `requested`。
    // 本态请求 120 根而 run 数据不足 ⇒ 引擎把生效 barSpace 压低（requested ≠ 生效）＝「申请未被逐值兑现」，
    // 该差异由 `wb-window-clamped` 独立披露（必含 requested/observed）⇒ **不得**把 `data-ok` 打成 false
    // （否则真实的「写窗后被改写」信号会被校准噪声淹没）。
    expect(probe.getAttribute('data-applied-requested-bar-space')).not.toBe(probe.getAttribute('data-applied-bar-space'));
    expect(probe.getAttribute('data-live-bar-space')).toBe(probe.getAttribute('data-applied-bar-space'));
    expect(probe.getAttribute('data-ok')).toBe('true');
    expect(probe.getAttribute('data-live-consistent')).toBe('true');
    expect(probe.getAttribute('data-live-reasons')).toBe('');
    // 披露仍须给出 requested/observed 两侧（钳位不静默）
    expect(clamped.textContent).toContain('120 根');
  });
});
