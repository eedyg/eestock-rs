/**
 * 红测试（诊断阶段，2026-09-13）—— 「保存 dcap 配置不得重置当前布局（pane 高度）」。
 *
 * 本文件位置：`web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`
 * 被测行为（用户需求）：修改 dcap 配置并保存后，K 线主图与各指标副图之间的高度/大小不得被重置。
 *
 * 为什么用「有状态的 klinecharts 模型」而不是整体空桩：
 *   jsdom 无 canvas，真实 klinecharts 无法在此环境渲染（既有 `KlineChart.test.tsx` 因此整体打桩）。
 *   但本缺陷的判据是 **pane 生命周期语义**（remove 会销毁 pane、create 会以布局默认高度新建），
 *   空桩（vi.fn()）表达不了这层语义 ⇒ 会永远绿。故本文件实现一个**有状态的迷你引擎**，
 *   其每条语义都逐条对齐真实库源码（klinecharts 10.0.3 `dist/index.esm.js`，行号见各处注释），
 *   并与「真实 klinecharts + 真实组件」的临时构建实测交叉验证（证据：`tester/evidence/051/`）。
 *
 * 真实库语义（模型依据，全部为真实源码行为）：
 *  1. 布局默认 pane 模板 `{ minHeight: 30, dragEnabled: true, order: 0, height: 100, state: 'normal' }`
 *     —— `index.esm.js:13250-13256`。
 *  2. `createIndicator(value, isStack)`：未给 `paneId` ⇒ 新 pane id（`createId('indicator_pane_')`）；
 *     新 pane 以布局模板新建（`height: 100`）—— `index.esm.js:15263-15290`（`_createPane(IndicatorPane,
 *     {...getLayoutOptions().pane, id})`）。
 *  3. `removeIndicator(filter)`：从 pane 上摘掉指标；**pane 指标清空 ⇒ 该 pane 被销毁**
 *     （candle/x_axis 除外）—— `index.esm.js:15323-15355`（`pane.destroy()` + `_drawPanes.splice`）。
 *  4. 用户拖拽分隔线 ⇒ `pane.setOptions({ height })`（拖后的高度是 pane 的**唯一**记忆）
 *     —— `index.esm.js:10764-10765`（`SeparatorWidget._pressedTouchMouseMoveEvent`）。
 *  5. `measureHeight` 重排：非弹性 pane 高度 = `max(minHeight, options.height)`（受剩余高度钳制），
 *     弹性 pane（candle_pane）吃掉剩余 —— `index.esm.js:14787-14835`。
 *  6. `overrideIndicator(override)`：**原地**改指标的 `calcParams` 并重算（`_calcIndicator`），
 *     不销毁 pane；其 `layout(...)` **不带 `measureHeight`** ⇒ 渲染高度不变
 *     —— `index.esm.js:14242-14283`（store）/ `15296-15321`（chart）。
 *     注意（库事实）：只发生 calc 时其返回值是 `false`（`updated` 仅在 draw/sort 时置位，
 *     `15296-15318`）⇒ **不得用返回值判成功**。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Bar } from '@/api/types';
import { DCAP_INDICATOR_TEMPLATE, dcapCalcParams, type DcapParams } from '@/features/indicators/dcapIndicator';
import type { KlineChartFeedLike } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/.diag51/KlineChart.fixed3';

// ───────────────────────── 迷你 klinecharts（有状态） ─────────────────────────
const H = vi.hoisted(() => {
  /** 布局常量（对齐真实库默认值）。 */
  const DEFAULT_PANE_HEIGHT = 100;
  const DEFAULT_PANE_MIN_HEIGHT = 30;
  /** 图表容器内容总高（与真实渲染 724px 主图区同量级；数值本身不参与断言，只决定剩余分配）。 */
  const TOTAL_HEIGHT = 724;
  const X_AXIS_HEIGHT = 26;

  interface Pane {
    id: string;
    height: number;
    minHeight: number;
    state: string;
    order: number;
    dragEnabled: boolean;
    indicators: Array<{ id: string; name: string; paneId: string; calcParams: unknown[]; precision: number; result: unknown[] }>;
    /** 渲染高度（measureHeight 结果）。 */
    rendered: number;
  }

  const state = {
    charts: [] as Array<Record<string, unknown>>,
    log: [] as Array<{ api: string; arg: string; paneIdsBefore: string[]; paneIdsAfter: string[] }>,
    templates: new Map<string, { calc?: (data: unknown[], ind: { calcParams: unknown[] }) => unknown[]; precision?: number; figures?: Array<{ key: string }> }>(),
    /** 图内数据（DCAP 模板按 calcParams 重算所需；真实引擎同样持有 dataList）。 */
    dataList: [] as Array<{ close: number }>,
  };

  let seq = 0;
  const newId = (p: string) => `${p}${++seq}`;

  function makeChart() {
    const panes: Pane[] = [];
    let chart: Record<string, unknown>;

    /** 语义 5：measureHeight 重排（non-flexible = max(minHeight, options.height)，candle 吃剩余）。 */
    function layout() {
      const content = panes.filter((p) => p.id !== 'x_axis_pane');
      const remainingTotal = TOTAL_HEIGHT - X_AXIS_HEIGHT;
      const flexible = content.find((p) => p.id === 'candle_pane' && p.state === 'normal') ?? content.find((p) => p.state === 'normal');
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

    function findPane(id: string) {
      return panes.find((p) => p.id === id);
    }
    function match(filter: { name?: string; paneId?: string; id?: string }) {
      const out: Array<{ pane: Pane; ind: Pane['indicators'][number] }> = [];
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
    function recompute(ind: Pane['indicators'][number]) {
      const tpl = state.templates.get(ind.name);
      ind.result = tpl?.calc ? (tpl.calc(state.dataList, { calcParams: ind.calcParams }) as unknown[]) : [];
      if (tpl?.precision !== undefined) ind.precision = tpl.precision;
    }
    function log(api: string, arg: unknown) {
      state.log.push({ api, arg: JSON.stringify(arg)?.slice(0, 200) ?? '', paneIdsBefore: [], paneIdsAfter: panes.map((p) => p.id) });
    }

    chart = {
      setSymbol: vi.fn(),
      setPeriod: vi.fn(),
      setDataLoader: vi.fn(),
      setStyles: vi.fn(),
      setBarSpace: vi.fn(),
      subscribeAction: vi.fn(),
      unsubscribeAction: vi.fn(),
      scrollToRealTime: vi.fn(),
      resize: vi.fn(),
      convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),

      /** 语义 2。 */
      createIndicator(value: string | Record<string, unknown>, isStack?: boolean) {
        const create = (typeof value === 'string' ? { name: value } : value) as Record<string, unknown>;
        const name = String(create.name);
        const tpl = state.templates.get(name);
        if (!tpl) return null; // 真实库：未注册 → logWarn + return null（15267-15270）
        const paneId = (create.paneId as string | undefined) ?? newId('indicator_pane_');
        let pane = findPane(paneId);
        if (!pane) {
          pane = { id: paneId, height: DEFAULT_PANE_HEIGHT, minHeight: DEFAULT_PANE_MIN_HEIGHT, state: 'normal', order: 0, dragEnabled: true, indicators: [], rendered: 0 };
          panes.push(pane);
        }
        const ind = {
          id: (create.id as string | undefined) ?? newId(`${name}_`),
          name,
          paneId,
          calcParams: (create.calcParams as unknown[] | undefined) ?? (tpl as { calcParams?: unknown[] }).calcParams ?? [],
          precision: tpl.precision ?? 4,
          result: [] as unknown[],
        };
        pane.indicators.push(ind);
        recompute(ind);
        layout();
        log('createIndicator', { name, paneId });
        void isStack;
        return ind.id;
      },

      /** 语义 3。 */
      removeIndicator(filter?: { name?: string; paneId?: string; id?: string }) {
        const hits = match(filter ?? {});
        if (hits.length === 0) return false;
        for (const { pane, ind } of hits) {
          pane.indicators = pane.indicators.filter((x) => x.id !== ind.id);
        }
        for (const p of [...panes]) {
          if (p.id === 'candle_pane' || p.id === 'x_axis_pane') continue;
          if (p.indicators.length === 0) panes.splice(panes.indexOf(p), 1); // pane 销毁
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
          recompute(ind);
        }
        layout();
        log('overrideIndicator', { name: override.name, calcParams: override.calcParams });
        // 库事实：仅 calc 变化时返回 false（不得据此判成功）。
        return false;
      },

      /** 语义 4：拖拽写 pane.height（真实实现同时 write options + bounding）。 */
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
      __renderedHeights() {
        return Object.fromEntries(panes.map((p) => [p.id, p.rendered]));
      },
      __renderedByIndicator() {
        return Object.fromEntries(panes.map((p) => [p.indicators.map((i) => i.name).join('+') || 'candle', p.rendered]));
      },
      __paneIds() {
        return panes.filter((p) => p.id !== 'x_axis_pane').map((p) => p.id);
      },
      __log: () => state.log.map((e) => ({ ...e })),
      __dispose() {
        panes.length = 0;
      },
    };
    panes.push({ id: 'candle_pane', height: DEFAULT_PANE_HEIGHT, minHeight: DEFAULT_PANE_MIN_HEIGHT, state: 'normal', order: 0, dragEnabled: true, indicators: [], rendered: 0 });
    panes.push({ id: 'x_axis_pane', height: 32, minHeight: 32, state: 'normal', order: 100, dragEnabled: false, indicators: [], rendered: X_AXIS_HEIGHT });
    layout();
    return chart;
  }

  // 合成行情（确定性）：150 根，保证 DCAP 三线（n_s/n_m/n_l + m）都能出值。
  const dataList: Array<{ close: number }> = [];
  let price = 100;
  for (let i = 0; i < 150; i++) {
    price *= 1 + Math.sin(i / 7) / 100 + (i % 11 === 0 ? -0.01 : 0.0015);
    dataList.push({ close: Math.round(price * 1000) / 1000 });
  }
  state.dataList = dataList;

  return {
    state,
    chartStub: makeChart,
    /** MA/VOL/MACD/KDJ/BOLL 是 klinecharts 内置模板：测试里给出最简等价物（只关心 calcParams 传递）。 */
    dataList,
  };
});

vi.mock('klinecharts', () => {
  const stub = H;
  const module = {
    init: vi.fn(() => {
      const c = stub.chartStub();
      stub.state.charts.push(c);
      return c;
    }),
    dispose: vi.fn(),
    registerIndicator: vi.fn((tpl: { name: string; calc?: unknown; precision?: number; figures?: unknown[]; calcParams?: unknown[] }) => {
      stub.state.templates.set(tpl.name, tpl as never);
    }),
  };
  // 内置模板（真实库在模块内部预注册；此处给出最简等价物：按 calcParams 生成可区分的结果）
  for (const name of ['MA', 'VOL', 'MACD', 'KDJ', 'BOLL']) {
    stub.state.templates.set(name, {
      calc: (data: unknown[], ind: { calcParams: unknown[] }) =>
        data.map((d, i) => ({ __name: name, __i: i, __v: (d as { close: number }).close + (Number(ind.calcParams[0]) || 0) })),
      precision: 2,
      figures: [{ key: 'f1' }],
    });
  }
  return module;
});

// ───────────────────────── 被测组件 ─────────────────────────
import { KlineChart } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/.diag51/KlineChart.fixed3';

function fakeFeed(): KlineChartFeedLike {
  return {
    bars: [] as Bar[],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
    viewportBars: 120,
  };
}

const BASE_INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };
const P0: DcapParams = { n_s: 8, n_m: 26, n_l: 60, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3 };
const P1: DcapParams = { ...P0, r_s: 1.3, smooth: 0 };

const charts = () => H.state.charts as Array<Record<string, unknown> & {
  getIndicators: (f?: { name?: string }) => Array<{ name: string; paneId: string; calcParams: unknown[]; result: unknown[] }>;
  __renderedByIndicator: () => Record<string, number>;
  __paneIds: () => string[];
  __log: () => Array<{ api: string; arg: string }>;
  setPaneOptions: (o: { id?: string; height?: number }) => void;
}>;
const lastChart = () => charts()[charts().length - 1]!;

/** ±1px 容差比较（验收口径）。 */
function expectHeightsClose(a: Record<string, number>, b: Record<string, number>): void {
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  for (const k of Object.keys(a)) expect(Math.abs(a[k]! - b[k]!)).toBeLessThanOrEqual(1);
}

describe('保存 dcap 配置不得重置 pane 布局（KlineChart ⇄ syncIndicators 差分）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.state.charts.length = 0;
    H.state.log.length = 0;
  });

  it('【红】改 dcapParams（真实保存路径的等价 props 变化）后：既有 pane 高度不变（±1px）、pane 不被销毁重建、dcap 线值按新参数更新', () => {
    const feed = fakeFeed();
    const props = (p: DcapParams) => (
      <KlineChart
        feed={feed}
        code="518880"
        period="15m"
        followLatest
        indicators={BASE_INDICATORS}
        onManualZoom={() => {}}
        maWindows={[5, 10, 20]}
        dcapParams={p}
      />
    );
    const { rerender } = render(props(P0));
    const chart = lastChart();

    // 用户拖拽：等价于 SeparatorWidget 把 VOL / DCAP 拉高（写 pane.height，语义 4）
    const volPane = chart.getIndicators({ name: 'VOL' })[0]!.paneId;
    const dcapPane = chart.getIndicators({ name: 'DCAP' })[0]!.paneId;
    act(() => {
      chart.setPaneOptions({ id: volPane, height: 240 });
      chart.setPaneOptions({ id: dcapPane, height: 200 });
    });

    const before = chart.__renderedByIndicator();
    const beforeIds = chart.__paneIds();
    const beforeDcap = chart.getIndicators({ name: 'DCAP' })[0]!;
    const logLen = chart.__log().length;

    // 保存 dcap 参数（DashboardPage.saveDcapParams 的等价 props 变化：feed 不变 ⇒ 不 remount）
    act(() => rerender(props(P1)));

    const after = chart.__renderedByIndicator();
    const afterIds = chart.__paneIds();

    // ① 布局不得被重置（±1px）
    expectHeightsClose(after, before);
    // ② pane 不得被销毁重建（id 集合不变）
    expect(afterIds).toEqual(beforeIds);
    // ③ 保存期间不得对既有指标做 remove/create（差分：仅启用状态翻转才 create/remove）
    const churn = chart.__log().slice(logLen).filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator');
    expect(churn).toEqual([]);

    // ④ DCAP 线值必须按新参数更新（与真实 CORE 模板的独立重算逐位一致）
    const dcap = chart.getIndicators({ name: 'DCAP' })[0]!;
    expect(dcap.calcParams).toEqual(dcapCalcParams(P1));
    const oracle = DCAP_INDICATOR_TEMPLATE.calc!(H.dataList as never, { calcParams: dcapCalcParams(P1) } as never) as Array<Record<string, number | null>>;
    const actual = dcap.result as Array<Record<string, number | null>>;
    expect(actual.length).toBe(oracle.length);
    for (let i = 0; i < oracle.length; i++) {
      for (const k of ['s', 'm', 'l']) {
        const a = actual[i]![k];
        const b = oracle[i]![k];
        if (a === null || b === null) expect(a).toBe(b);
        else expect(Math.abs((a as number) - (b as number))).toBeLessThanOrEqual(1e-12);
      }
      expect(actual[i]!['zero']).toBe(0);
    }
    // 且确实变了（不是拿旧参数重算）
    const oldOracle = DCAP_INDICATOR_TEMPLATE.calc!(H.dataList as never, { calcParams: dcapCalcParams(P0) } as never) as Array<Record<string, number | null>>;
    const tail = (arr: Array<Record<string, number | null>>) => JSON.stringify(arr[arr.length - 1]);
    expect(tail(oldOracle)).not.toBe(tail(oracle));
    void beforeDcap;
  });

  it('【守卫】指标启用状态翻转仍必须 create/remove（差分不得吞掉开关语义）', () => {
    const feed = fakeFeed();
    const tree = (indicators: Record<'ma' | 'macd' | 'kdj' | 'boll' | 'dcap', boolean>) => (
      <KlineChart feed={feed} code="518880" period="15m" followLatest indicators={indicators} onManualZoom={() => {}} maWindows={[5, 10, 20]} dcapParams={P0} />
    );
    const { rerender } = render(tree(BASE_INDICATORS));
    const chart = lastChart();
    expect(chart.getIndicators({ name: 'DCAP' }).length).toBe(1);

    // DCAP 关：pane 应被移除
    act(() => rerender(tree({ ...BASE_INDICATORS, dcap: false })));
    expect(chart.getIndicators({ name: 'DCAP' }).length).toBe(0);
    expect(chart.__renderedByIndicator()['DCAP']).toBeUndefined();

    // DCAP 再开：pane 应重新建立并带参数
    act(() => rerender(tree({ ...BASE_INDICATORS, dcap: true })));
    const dcap = chart.getIndicators({ name: 'DCAP' });
    expect(dcap.length).toBe(1);
    expect(dcap[0]!.calcParams).toEqual(dcapCalcParams(P0));
  });
});
