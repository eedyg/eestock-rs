/**
 * 红测试（诊断阶段 1，2026-09-14）—— 「切换 period（周期）/ stock（标的）不得重置指标视图布局大小」。
 *
 * 本文件位置：`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`
 * 被测行为（用户新需求）：
 *   切换 period 或切换 stock 时，既有 pane（主图 + VOL/DCAP 等副图）的高度/layout 大小不得被重置；
 *   **数据重置是允许的**（新标的/周期的 bars 必须换进来）。
 *
 * 为什么用「有状态的 klinecharts 迷你引擎」而不是整体空桩（同 KlineChartDcapSaveLayout.test.tsx 的理由）：
 *   jsdom 无 canvas，真实 klinecharts 无法在此渲染；但本缺陷判据是 **chart 实例生命周期 + pane 语义**
 *   （整图 remount 会 dispose 旧图、init 新图 ⇒ 全部 pane 以布局默认高度 100 重建、pane id 全换），
 *   空桩（vi.fn()）表达不了 ⇒ 会永久假绿。
 *   模型语义逐条对齐真实库源码（`klinecharts@10.0.3 dist/index.esm.js`），并与真实渲染实测交叉验证：
 *   证据 `tester/evidence/053/`（真实引擎实测 VOL 199→100、DCAP 140→100、`init` 1→2、pane id 全换）。
 *
 * 真实库语义（模型依据）：
 *  1. 布局默认 pane 模板 `{minHeight:30, height:100, state:'normal', dragEnabled:true}` —— `index.esm.js:13250-13256`。
 *  2. `createIndicator` 未给 paneId ⇒ 新建 pane（新 id），以布局模板新建（height 100） —— `:15263-15290`。
 *  3. `removeIndicator` 清空 pane ⇒ pane 销毁 —— `:15323-15355`。
 *  4. 拖拽写 `pane.setOptions({height})` —— `:10764-10765`（`SeparatorWidget`）；`setPaneOptions` 亦写 options.height。
 *  5. `measureHeight`：非弹性 pane = max(minHeight, options.height)（受剩余高度钳制），弹性 candle_pane 吃剩余 —— `:14787-14835`。
 *  6. `overrideIndicator` 原地改 calcParams、不销毁 pane —— `:15296-15321`。
 *  7. `setSymbol` / `setPeriod` / `setDataLoader` 各自内部 `resetData()`（`_processDataLoad('init')`，`_clearData`+替换 `_dataList`）
 *     —— `:13410-13434`、`:13518-13524`、`:15253-15261`（原地切换可行性的库依据）。
 *  8. `init(container)` = 新建 ChartImp；组件 `[feed]` effect 重跑 = dispose + init（整图 remount）——
 *     真实实测：`tester/evidence/053/probe_period.json`（切 period/stock 各 +1 init、pane id 全换、高度回 100）。
 *
 * 当前实现（HEAD ece1d9d）：`KlineChart` 建图 effect 依赖 `[feed]`；`DashboardPage` 的 `feed` useMemo 依赖
 * `[api, ws, state.selected, state.period, viewportBars]` ⇒ 切 period / 切 stock ⇒ 新 feed ⇒ 整图 remount ⇒
 * 拖拽过的副图高度全部回默认。故本文件两条切换用例**当前必红**。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Bar } from '@/api/types';
import type { KlineChartFeedLike } from './KlineChart';

// ───────────────────────── 迷你 klinecharts（有状态） ─────────────────────────
const H = vi.hoisted(() => {
  const DEFAULT_PANE_HEIGHT = 100;
  const DEFAULT_PANE_MIN_HEIGHT = 30;
  const TOTAL_HEIGHT = 724;
  const X_AXIS_HEIGHT = 26;

  interface Ind {
    id: string;
    name: string;
    paneId: string;
    calcParams: unknown[];
    precision: number;
    result: unknown[];
  }
  interface Pane {
    id: string;
    height: number;
    minHeight: number;
    state: string;
    order: number;
    dragEnabled: boolean;
    indicators: Ind[];
    rendered: number;
  }

  const state = {
    charts: [] as Array<Record<string, unknown>>,
    log: [] as Array<{ seq: number; chart: number; api: string; arg: string }>,
    inits: 0,
    templates: new Map<string, { calc?: (...a: unknown[]) => unknown[]; precision?: number; figures?: Array<{ key: string }>; calcParams?: unknown[] }>(),
  };

  let seq = 0;
  const newId = (p: string) => `${p}${++seq}`;

  function makeChart() {
    const panes: Pane[] = [];
    const myIdx = state.charts.length;
    let symbol: unknown = null;
    let period: unknown = null;
    let loader: unknown = null;

    /** 语义 5：measureHeight 重排。 */
    function layout() {
      const content = panes.filter((p) => p.id !== 'x_axis_pane');
      const remainingTotal = TOTAL_HEIGHT - X_AXIS_HEIGHT;
      const flexible =
        content.find((p) => p.id === 'candle_pane' && p.state === 'normal') ?? content.find((p) => p.state === 'normal');
      let left = remainingTotal;
      for (const p of content) {
        if (p === flexible) continue;
        let h = p.state === 'normal' ? Math.max(p.minHeight, p.height) : p.minHeight;
        h = Math.min(h, Math.max(left, 0));
        left -= h;
        p.rendered = h;
      }
      if (flexible) flexible.rendered = Math.max(left, 0);
      for (const p of content) if (p.rendered === undefined) p.rendered = 0;
    }
    const findPane = (id: string) => panes.find((p) => p.id === id);
    function match(filter: { name?: string; paneId?: string; id?: string }) {
      const out: Array<{ pane: Pane; ind: Ind }> = [];
      for (const p of panes) {
        if (filter.paneId !== undefined && p.id !== filter.paneId) continue;
        for (const ind of p.indicators) {
          if (filter.id !== undefined && ind.id !== filter.id) continue;
          if (filter.name !== undefined && ind.name !== filter.name) continue;
          out.push({ pane: p, ind });
        }
      }
      return out;
    }
    function log(api: string, arg: unknown) {
      state.log.push({ seq: state.log.length, chart: myIdx, api, arg: JSON.stringify(arg)?.slice(0, 200) ?? '' });
    }

    const chart: Record<string, unknown> = {
      setStyles: vi.fn(),
      setBarSpace: vi.fn(),
      subscribeAction: vi.fn(),
      unsubscribeAction: vi.fn(),
      scrollToRealTime: vi.fn(),
      resize: vi.fn(),
      convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),

      /** 语义 7：记录 symbol/period/loader（原地切换可行性的断言通道）。 */
      setSymbol(s: unknown) {
        symbol = s;
        log('setSymbol', s);
      },
      getSymbol() {
        return symbol;
      },
      setPeriod(p: unknown) {
        period = p;
        log('setPeriod', p);
      },
      getPeriod() {
        return period;
      },
      setDataLoader(l: unknown) {
        loader = l;
        log('setDataLoader', {});
      },
      __loader() {
        return loader as { getBars: (arg: { type: string; callback: (bars: unknown, more: unknown) => void }) => Promise<void> } | null;
      },
      resetData() {
        log('resetData', {});
      },

      /** 语义 2。 */
      createIndicator(value: string | Record<string, unknown>, isStack?: boolean) {
        const create = (typeof value === 'string' ? { name: value } : value) as Record<string, unknown>;
        const name = String(create.name);
        const tpl = state.templates.get(name);
        if (!tpl) return null;
        const paneId = (create.paneId as string | undefined) ?? newId('indicator_pane_');
        let pane = findPane(paneId);
        if (!pane) {
          pane = {
            id: paneId,
            height: DEFAULT_PANE_HEIGHT,
            minHeight: DEFAULT_PANE_MIN_HEIGHT,
            state: 'normal',
            order: 0,
            dragEnabled: true,
            indicators: [],
            rendered: 0,
          };
          panes.push(pane);
        }
        const ind: Ind = {
          id: (create.id as string | undefined) ?? newId(`${name}_`),
          name,
          paneId,
          calcParams: (create.calcParams as unknown[] | undefined) ?? tpl.calcParams ?? [],
          precision: tpl.precision ?? 4,
          result: [],
        };
        pane.indicators.push(ind);
        layout();
        log('createIndicator', { name, paneId });
        void isStack;
        return ind.id;
      },

      /** 语义 3。 */
      removeIndicator(filter?: { name?: string; paneId?: string; id?: string }) {
        const hits = match(filter ?? {});
        if (hits.length === 0) return false;
        for (const { pane, ind } of hits) pane.indicators = pane.indicators.filter((x) => x.id !== ind.id);
        for (const p of [...panes]) {
          if (p.id === 'candle_pane' || p.id === 'x_axis_pane') continue;
          if (p.indicators.length === 0) panes.splice(panes.indexOf(p), 1);
        }
        layout();
        log('removeIndicator', filter ?? {});
        return true;
      },

      /** 语义 6。 */
      overrideIndicator(override: Record<string, unknown>) {
        const hits = match(override as { name?: string; paneId?: string; id?: string });
        if (hits.length === 0) return false;
        for (const { ind } of hits) {
          if (override.calcParams !== undefined) ind.calcParams = override.calcParams as unknown[];
        }
        layout();
        log('overrideIndicator', { name: override.name, calcParams: override.calcParams });
        return false;
      },

      /** 语义 4。 */
      setPaneOptions(options: { id?: string; height?: number; state?: string }) {
        if (options.id !== undefined) {
          const p = findPane(options.id);
          if (p && typeof options.height === 'number') p.height = options.height;
          if (p && options.state !== undefined) p.state = options.state;
        }
        layout();
        log('setPaneOptions', options);
      },
      getPaneOptions(id?: string) {
        const dump = (p: Pane) => ({ id: p.id, height: p.height, minHeight: p.minHeight, state: p.state, order: p.order, dragEnabled: p.dragEnabled });
        return id !== undefined ? (findPane(id) ? dump(findPane(id)!) : null) : panes.map(dump);
      },
      getIndicators(filter?: { name?: string; paneId?: string; id?: string }) {
        return match(filter ?? {}).map(({ ind, pane }) => ({ ...ind, paneId: pane.id }));
      },

      /** 测试口径：**渲染高度**（用户真正看到的高度）。 */
      __renderedByIndicator() {
        return Object.fromEntries(panes.map((p) => [p.indicators.map((i) => i.name).join('+') || 'candle', p.rendered]));
      },
      __paneIds() {
        return panes.filter((p) => p.id !== 'x_axis_pane').map((p) => p.id);
      },
      __log: () => state.log.filter((e) => e.chart === myIdx).map((e) => ({ ...e })),
      __dispose() {
        panes.length = 0;
      },
    };

    panes.push({ id: 'candle_pane', height: DEFAULT_PANE_HEIGHT, minHeight: DEFAULT_PANE_MIN_HEIGHT, state: 'normal', order: 0, dragEnabled: true, indicators: [], rendered: 0 });
    panes.push({ id: 'x_axis_pane', height: 32, minHeight: 32, state: 'normal', order: 100, dragEnabled: false, indicators: [], rendered: X_AXIS_HEIGHT });
    layout();
    return chart;
  }

  return { state, chartStub: makeChart };
});

vi.mock('klinecharts', () => {
  const stub = H;
  const module = {
    init: vi.fn(() => {
      const c = stub.state.charts.length; // 新建 chart 前的索引 = 本 chart 序号
      const chart = stub.chartStub();
      stub.state.charts.push(chart);
      stub.state.inits += 1;
      void c;
      return chart;
    }),
    dispose: vi.fn((c: { __dispose?: () => void }) => c?.__dispose?.()),
    registerIndicator: vi.fn((tpl: { name: string; calc?: unknown; precision?: number; figures?: unknown[]; calcParams?: unknown[] }) => {
      stub.state.templates.set(tpl.name, tpl as never);
    }),
  };
  // 内置模板（真实库模块内预注册；此处给出最简等价物）
  for (const name of ['MA', 'VOL', 'MACD', 'KDJ', 'BOLL']) {
    if (!stub.state.templates.has(name)) {
      stub.state.templates.set(name, {
        calc: () => [],
        precision: 2,
        figures: [{ key: 'f1' }],
      });
    }
  }
  return module;
});

// ───────────────────────── 被测组件 ─────────────────────────
import { KlineChart } from './KlineChart';

/** 可区分 code/period 的 feed（bars 由调用方给出；数据重置断言据此）。 */
function makeFeed(code: string, period: string, bars: Bar[]): KlineChartFeedLike & { code: string; period: string } {
  return {
    code,
    period,
    bars,
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
    viewportBars: 120,
  };
}

function bars(prefix: string, startIso: string, n: number, base: number, stepMs: number, step: number): Bar[] {
  const out: Bar[] = [];
  const t0 = Date.parse(startIso);
  for (let i = 0; i < n; i++) {
    const close = base + i * step;
    out.push({
      ts: new Date(t0 + i * stepMs).toISOString(),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + i,
      amount: (1000 + i) * close,
    });
  }
  void prefix;
  return out;
}

type ChartLike = Record<string, unknown> & {
  getIndicators: (f?: { name?: string }) => Array<{ name: string; paneId: string; calcParams: unknown[] }>;
  getPaneOptions: () => Array<{ id: string; height: number }>;
  setPaneOptions: (o: { id?: string; height?: number }) => void;
  __renderedByIndicator: () => Record<string, number>;
  __paneIds: () => string[];
  __log: () => Array<{ seq: number; api: string; arg: string }>;
  __loader: () => { getBars: (arg: { type: string; callback: (bars: unknown, more: unknown) => void }) => Promise<void> } | null;
  getSymbol: () => unknown;
  getPeriod: () => unknown;
};
const charts = () => H.state.charts as ChartLike[];
const lastChart = () => charts()[charts().length - 1]!;

/** ±1px 容差比较（验收口径）。 */
function expectHeightsClose(a: Record<string, number>, b: Record<string, number>): void {
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  for (const k of Object.keys(a)) expect(Math.abs(a[k]! - b[k]!), `${k} 高度 ${a[k]}→${b[k]}`).toBeLessThanOrEqual(1);
}

const FEED_A_BARS = bars('A', '2024-01-01T00:00:00Z', 10, 10, 60_000, 1);
const FEED_B_BARS = bars('B', '2024-02-01T00:00:00Z', 6, 100, 3_600_000, 2);
const INDICATORS = { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: true };

function tree(feed: KlineChartFeedLike, code: string, period: '15m' | '1h') {
  return <KlineChart feed={feed} code={code} period={period} followLatest={false} indicators={INDICATORS} onManualZoom={() => {}} maWindows={[5, 10, 20]} />;
}

/** 用户拖拽：等价于 SeparatorWidget 把 VOL / DCAP 拉高（写 pane.height，语义 4）。 */
function dragPanes(chart: ChartLike) {
  const volPane = chart.getIndicators({ name: 'VOL' })[0]!.paneId;
  const dcapPane = chart.getIndicators({ name: 'DCAP' })[0]!.paneId;
  act(() => {
    chart.setPaneOptions({ id: volPane, height: 240 });
    chart.setPaneOptions({ id: dcapPane, height: 200 });
  });
}

describe('切换 period / stock 不得重置指标视图布局（KlineChart 建图 effect 身份）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.state.charts.length = 0;
    H.state.log.length = 0;
    H.state.inits = 0;
  });

  it('【红】切换 period：既有 pane 高度 ±1px 不变、pane id 不变、无 create/remove；数据确实换成新周期', async () => {
    const feedA = makeFeed('518880', '15m', FEED_A_BARS);
    const feedB = makeFeed('518880', '1h', FEED_B_BARS);
    const { rerender } = render(tree(feedA, '518880', '15m'));
    expect(charts()).toHaveLength(1);
    const chart = lastChart();
    dragPanes(chart);

    const before = chart.__renderedByIndicator();
    const beforeIds = chart.__paneIds();
    const logLen = chart.__log().length;

    // DashboardPage 切 period 的等价 props 变化：feed 身份更换（新 KlineDataFeed），code 不变
    await act(async () => {
      rerender(tree(feedB, '518880', '1h'));
    });

    // ① 不得整图重建（当前实现：init 再调一次 ⇒ charts().length === 2，必红）
    expect(charts().length, '切 period 不得 dispose+init 重建 chart（否则 pane 全部回默认高度）').toBe(1);
    // ② 所有既有 pane 渲染高度 ±1px 不变
    expectHeightsClose(lastChart().__renderedByIndicator(), before);
    // ③ pane id 不变（未被销毁重建）
    expect(lastChart().__paneIds()).toEqual(beforeIds);
    // ④ 无多余 remove/create（差分：布局保持 = 不触碰指标/pane 生命周期）
    const burst = lastChart().__log().slice(logLen);
    expect(burst.filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator'), '切周期不得创建/销毁指标 pane').toEqual([]);

    // ⑤ 数据确实重置：新周期 bars 必须换进 chart 的 DataLoader（根数 / 首末时间戳 / 取值）
    const loader = lastChart().__loader()!;
    let got: Array<{ timestamp: number; close: number }> = [];
    await act(async () => {
      await loader.getBars({ type: 'init', callback: (b) => { got = b as Array<{ timestamp: number; close: number }>; } });
    });
    expect(got.length).toBe(FEED_B_BARS.length);
    expect(got[0]!.timestamp).toBe(Date.parse(FEED_B_BARS[0]!.ts));
    expect(got[got.length - 1]!.timestamp).toBe(Date.parse(FEED_B_BARS[FEED_B_BARS.length - 1]!.ts));
    expect(got.map((b) => b.close)).toEqual(FEED_B_BARS.map((b) => b.close));
    expect(got.map((b) => b.close)).not.toEqual(FEED_A_BARS.map((b) => b.close));
    expect(lastChart().getSymbol()).toMatchObject({ ticker: '518880' });
    expect(lastChart().getPeriod()).toEqual({ type: 'hour', span: 1 });
  });

  it('【红】切换 stock：既有 pane 高度 ±1px 不变、pane id 不变、无 create/remove；数据确实换成新标的', async () => {
    const feedA = makeFeed('518880', '15m', FEED_A_BARS);
    const feedB = makeFeed('161226', '15m', FEED_B_BARS);
    const { rerender } = render(tree(feedA, '518880', '15m'));
    const chart = lastChart();
    dragPanes(chart);

    const before = chart.__renderedByIndicator();
    const beforeIds = chart.__paneIds();
    const logLen = chart.__log().length;

    // DashboardPage 切 stock 的等价 props 变化：feed 身份更换（新 KlineDataFeed），period 不变
    await act(async () => {
      rerender(tree(feedB, '161226', '15m'));
    });

    expect(charts().length, '切 stock 不得 dispose+init 重建 chart').toBe(1);
    expectHeightsClose(lastChart().__renderedByIndicator(), before);
    expect(lastChart().__paneIds()).toEqual(beforeIds);
    expect(lastChart().__log().slice(logLen).filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator')).toEqual([]);

    // 数据确实重置：新标的 bars 必须换进 chart 的 DataLoader
    const loader = lastChart().__loader()!;
    let got: Array<{ timestamp: number; close: number }> = [];
    await act(async () => {
      await loader.getBars({ type: 'init', callback: (b) => { got = b as Array<{ timestamp: number; close: number }>; } });
    });
    expect(got.length).toBe(FEED_B_BARS.length);
    expect(got[0]!.timestamp).toBe(Date.parse(FEED_B_BARS[0]!.ts));
    expect(got.map((b) => b.close)).toEqual(FEED_B_BARS.map((b) => b.close));
    expect(got.map((b) => b.close)).not.toEqual(FEED_A_BARS.map((b) => b.close));
    expect(lastChart().getSymbol()).toMatchObject({ ticker: '161226' });
  });

  it('【防回归】同一 feed 的 rerender（如指标/参数变化）不得重建 chart（基线，当前绿）', async () => {
    const feedA = makeFeed('518880', '15m', FEED_A_BARS);
    const { rerender } = render(tree(feedA, '518880', '15m'));
    const chart = lastChart();
    dragPanes(chart);
    const before = chart.__renderedByIndicator();

    await act(async () => {
      // 同一 feed、仅无关 props 变化（等值新对象）⇒ 指标差分幂等、不得重建 chart
      rerender(
        <KlineChart feed={feedA} code="518880" period="15m" followLatest={false} indicators={{ ...INDICATORS }} onManualZoom={() => {}} maWindows={[5, 10, 20]} />,
      );
    });

    expect(charts().length, '同一 feed 不得重建 chart').toBe(1);
    expectHeightsClose(lastChart().__renderedByIndicator(), before);
  });
});
