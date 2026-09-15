/**
 * 286 红测试（TDD 先红）：VOL 成交量副图 ⇒ 可关闭的普通指标开关（默认开、会话态）。
 *
 * 本文件位置：`web/src/features/dashboard/volToggle.test.tsx`（本阶段**唯一**新增物）
 * 设计报告：`tester/design/286_vol_toggle_red_design.md`
 * 执行报告：`tester/test/286_vol_toggle_red.md`
 * 证据目录：`tester/evidence/286_vol_red/`
 *
 * 口径（父级已裁决，不得自行变更）：
 *  - VOL 与 MA/MACD/KDJ/BOLL/DCAP **并列**为全局指标开关；`DASHBOARD_DEFAULTS.indicators.vol = true`（默认开）；
 *    会话态（不落服务端配置、刷新回默认）。`IndicatorName` 派生自 `DASHBOARD_DEFAULTS.indicators`，
 *    而该常量位于 **tangle 生成物** `web/src/layouts/DashboardGrid.tsx`（事实源 `design/06-web/01-dashboard.md`）。
 *    本阶段**不改**该文档、不改生成物、不改任何实现文件。
 *  - 关掉 ⇒ 主图（`KlineChart`）与**所有多周期卫星**（`MultiPeriodSatellite` ⇐ `MultiPeriodChartStack`）
 *    都不再有 VOL 副图。
 *
 * 现有两处「VOL 特权」（实现阶段删除；本文件只把它们写成断言/约束，不在此处修改）：
 *  ① `KlineChart.tsx` 的 `INDICATOR_DEFS` 用 `key: IndicatorName | 'vol'` 作类型逃逸；
 *  ② `syncIndicators` 内 `def.key === 'vol' ? true : indicators[def.key]` 的硬编码常开。
 *
 * 预期红/绿（本阶段 = 实现前基线）：
 *  R1 红 · R2 红 · R3 红（vol:false 分支）· R4 红（vol:false 中间态）· R5 红 · R6 **绿**（兜底守卫：
 *  现状经硬编码常开恰好满足；实现后必须仍满足 ⇒ 防「删特权时把兜底默认一并删掉」）。
 *
 * 夹具口径（沿用既有 `KlineChart*.test.tsx` / P2 卫星测试）：
 *  - jsdom 无 canvas ⇒ `klinecharts` 整体打桩；本文件用**有状态迷你引擎**，其语义逐条对齐
 *    klinecharts 10.0.3 `dist/index.esm.js` 行号（见下方「迷你 klinecharts」注释）。理由：R4 的判据是
 *    **pane 生命周期语义**（空桩表达不了「pane 被销毁/重建」「拖拽后的高度是 pane 的唯一记忆」），
 *    空桩会让 R4 永远绿（同 `KlineChartDcapSaveLayout.test.tsx` 的取舍）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { Bar } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { resetRealtimePollGateForTest } from './realtimePoll';
import type { IndicatorName } from './Toolbar';

// ─────────────────────────────────────────────────────────────────────────────
// 迷你 klinecharts（有状态）：R3/R4 的 pane 生命周期判据需要语义模型，而非空桩
// ─────────────────────────────────────────────────────────────────────────────

const H = vi.hoisted(() => {
  /** 布局常量（对齐真实库默认值 `index.esm.js:13250-13256`）。 */
  const DEFAULT_PANE_HEIGHT = 100;
  const DEFAULT_PANE_MIN_HEIGHT = 30;
  /** 图表内容总高（与真实主图区同量级；数值本身不参与断言，只决定剩余高度分配）。 */
  const TOTAL_HEIGHT = 724;
  const X_AXIS_HEIGHT = 26;

  interface StubIndicator {
    id: string;
    name: string;
    paneId: string;
    calcParams: unknown[];
    precision: number;
  }
  interface StubPane {
    id: string;
    height: number;
    minHeight: number;
    state: string;
    order: number;
    dragEnabled: boolean;
    indicators: StubIndicator[];
    /** 渲染高度（measureHeight 结果）。 */
    rendered: number;
  }
  interface StubFilter {
    id?: string;
    name?: string;
    paneId?: string;
  }
  interface LogEntry {
    api: string;
    arg: string;
  }

  const state = {
    charts: [] as any[],
    initArgs: [] as any[],
    log: [] as LogEntry[],
    /** 已注册指标模板（内置 MA/VOL/MACD/KDJ/BOLL 在 mock 工厂里预置；DCAP 由组件 `registerIndicator`）。 */
    templates: new Map<string, { calcParams?: unknown[]; precision?: number }>(),
  };

  let seq = 0;
  const newId = (prefix: string) => `${prefix}${++seq}`;
  const safeJson = (value: unknown): string => {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  };

  function makeChart() {
    const panes: StubPane[] = [];

    /**
     * 语义 5（`:14787-14835` measureHeight）：非弹性 pane 渲染高度 = `max(minHeight, options.height)`
     * （受剩余高度钳制），弹性 pane（candle_pane）吃掉剩余。
     */
    function layout() {
      const content = panes.filter((p) => p.id !== 'x_axis_pane');
      const flexible =
        content.find((p) => p.id === 'candle_pane' && p.state === 'normal') ??
        content.find((p) => p.state === 'normal');
      let left = TOTAL_HEIGHT - X_AXIS_HEIGHT;
      for (const pane of content) {
        if (pane === flexible) continue;
        const wanted = pane.state === 'normal' ? Math.max(pane.minHeight, pane.height) : pane.minHeight;
        const given = Math.min(wanted, Math.max(left, 0));
        left -= given;
        pane.rendered = given;
      }
      if (flexible) flexible.rendered = Math.max(left, 0);
    }

    const findPane = (id: string): StubPane | undefined => panes.find((p) => p.id === id);

    /** `StoreImp.getIndicatorsByFilter`（`:14180-14196`）：`id` 优先；否则按 `name`；未给即不筛。 */
    function hits(filter: StubFilter): Array<{ pane: StubPane; ind: StubIndicator }> {
      const out: Array<{ pane: StubPane; ind: StubIndicator }> = [];
      for (const pane of panes) {
        if (filter.paneId !== undefined && pane.id !== filter.paneId) continue;
        for (const ind of pane.indicators) {
          if (filter.id !== undefined && ind.id !== filter.id) continue;
          if (filter.name !== undefined && ind.name !== filter.name) continue;
          out.push({ pane, ind });
        }
      }
      return out;
    }

    function log(api: string, arg: unknown) {
      state.log.push({ api, arg: safeJson(arg) });
    }

    const chart = {
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
      removeOverlay: vi.fn(),
      createOverlay: vi.fn(),
      resetData: vi.fn(() => log('resetData', {})),

      /**
       * 语义 2（`:15263-15290`）：未给 `paneId` ⇒ 新建 pane（布局默认 `height:100`）；
       * `isStack` 语义（`:14162-14166`）：省略/`false` ⇒ **先清空同 pane**（替换语义）。
       */
      createIndicator(
        value: string | { name: string; paneId?: string; id?: string; calcParams?: unknown[] },
        isStack?: boolean,
      ) {
        const spec = typeof value === 'string' ? { name: value } : value;
        const tpl = state.templates.get(spec.name);
        if (!tpl) return null; // 真实库：未注册 ⇒ logWarn + return null（`:15267-15270`）
        const paneId = spec.paneId ?? newId('indicator_pane_');
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
        if (isStack !== true) pane.indicators = [];
        const ind: StubIndicator = {
          id: spec.id ?? newId(`${spec.name}_`),
          name: spec.name,
          paneId,
          calcParams: spec.calcParams ?? tpl.calcParams ?? [],
          precision: tpl.precision ?? 4,
        };
        pane.indicators.push(ind);
        layout();
        log('createIndicator', { name: spec.name, paneId, calcParams: spec.calcParams, isStack: isStack === true });
        return ind.id;
      },

      /** 语义 3（`:15323-15355`）：指标清空的非 candle/x_axis pane 被销毁（`pane.destroy()`）。 */
      removeIndicator(filter?: StubFilter) {
        const found = hits(filter ?? {});
        if (found.length === 0) return false;
        for (const { pane, ind } of found) pane.indicators = pane.indicators.filter((x) => x.id !== ind.id);
        for (const pane of [...panes]) {
          if (pane.id === 'candle_pane' || pane.id === 'x_axis_pane') continue;
          if (pane.indicators.length === 0) panes.splice(panes.indexOf(pane), 1);
        }
        layout();
        log('removeIndicator', filter ?? {});
        return true;
      },

      /** 语义 6（`:14242-14283` / `:15296-15321`）：原地改 calcParams，不销毁 pane；仅 calc 变化时返回 `false`。 */
      overrideIndicator(override: StubFilter & { calcParams?: unknown[] }) {
        const found = hits(override);
        if (found.length === 0) return false;
        for (const { ind } of found) {
          if (override.calcParams !== undefined) ind.calcParams = override.calcParams;
        }
        layout();
        log('overrideIndicator', { name: override.name, calcParams: override.calcParams });
        return false;
      },

      /** 语义 4（`:10764-10765`）：用户拖拽分隔线 ⇒ `pane.setOptions({ height })`（拖后高度是唯一记忆）。 */
      setPaneOptions(options: { id?: string; height?: number; state?: string; minHeight?: number }) {
        if (options.id !== undefined) {
          const pane = findPane(options.id);
          if (pane) {
            if (typeof options.height === 'number') pane.height = options.height;
            if (options.state !== undefined) pane.state = options.state;
            if (typeof options.minHeight === 'number') pane.minHeight = options.minHeight;
          }
        }
        layout();
        log('setPaneOptions', options);
      },

      getPaneOptions(id?: string) {
        const dump = (pane: StubPane) => ({
          id: pane.id,
          height: pane.height,
          minHeight: pane.minHeight,
          state: pane.state,
          order: pane.order,
          dragEnabled: pane.dragEnabled,
        });
        if (id !== undefined) {
          const pane = findPane(id);
          return pane ? dump(pane) : null;
        }
        return panes.map(dump);
      },

      getIndicators(filter?: StubFilter) {
        return hits(filter ?? {}).map(({ ind, pane }) => ({ ...ind, paneId: pane.id }));
      },

      // ── 测试口径读数（非 klinecharts API）────────────────────────────────────
      /** pane id 列表（不含 x_axis，按 pane 顺序）。 */
      __paneIds: () => panes.filter((p) => p.id !== 'x_axis_pane').map((p) => p.id),
      /** pane id → 渲染高度。 */
      __renderedHeights: () => Object.fromEntries(panes.map((p) => [p.id, p.rendered])),
      /** 「指标名集合 → 渲染高度」（candle pane 显示为 `candle`）。 */
      __renderedByIndicator: () =>
        Object.fromEntries(panes.map((p) => [p.indicators.map((i) => i.name).join('+') || 'candle', p.rendered])),
      /** 某指标名当前所在 pane id（不在场 ⇒ null）。 */
      __paneIdOf: (name: string) => hits({ name })[0]?.pane.id ?? null,
      __log: () => state.log.map((e) => ({ ...e })),
    };

    panes.push({
      id: 'candle_pane',
      height: DEFAULT_PANE_HEIGHT,
      minHeight: DEFAULT_PANE_MIN_HEIGHT,
      state: 'normal',
      order: 0,
      dragEnabled: true,
      indicators: [],
      rendered: 0,
    });
    panes.push({
      id: 'x_axis_pane',
      height: 32,
      minHeight: 32,
      state: 'normal',
      order: 100,
      dragEnabled: false,
      indicators: [],
      rendered: X_AXIS_HEIGHT,
    });
    layout();
    return chart;
  }

  return { state, makeChart };
});

vi.mock('klinecharts', () => {
  const stub = H;
  const module = {
    /** 每次 `init` 一个**新的**有状态实例（逐实例可断言；与 P2 卫星测试同手法）。 */
    init: vi.fn((el: unknown, _opts?: unknown) => {
      const chart = stub.makeChart();
      stub.state.charts.push(chart);
      stub.state.initArgs.push(el);
      return chart;
    }),
    dispose: vi.fn(),
    registerOverlay: vi.fn(),
    registerIndicator: vi.fn((tpl: { name: string; precision?: number; calcParams?: unknown[] }) => {
      stub.state.templates.set(tpl.name, tpl);
    }),
  };
  // 内置模板（真实库在模块内部预注册；此处给出最简等价物：只关心「已注册」与默认 calcParams）
  const builtins: Array<[string, number[], number]> = [
    ['MA', [5, 10, 20], 2],
    ['VOL', [5, 10, 20], 0],
    ['MACD', [12, 26, 9], 2],
    ['KDJ', [9, 3, 3], 2],
    ['BOLL', [20, 2], 2],
  ];
  for (const [name, calcParams, precision] of builtins) {
    stub.state.templates.set(name, { calcParams, precision });
  }
  return module;
});

// ─────────────────────────────────────────────────────────────────────────────
// 被测组件（mock 之后再 import，保持与既有测试同序）
// ─────────────────────────────────────────────────────────────────────────────

import { init } from 'klinecharts';
import { Toolbar } from './Toolbar';
import { KlineChart, type KlineChartFeedLike } from './KlineChart';
import { MultiPeriodSatellite } from './MultiPeriodSatellite';
import { MultiPeriodChartStack } from './MultiPeriodChartStack';
import { DashboardPage } from './DashboardPage';

interface StubFilter {
  id?: string;
  name?: string;
  paneId?: string;
}

interface ChartStub {
  createIndicator(
    value: string | { name: string; paneId?: string; id?: string; calcParams?: unknown[] },
    isStack?: boolean,
  ): string | null;
  removeIndicator(filter?: StubFilter): boolean;
  overrideIndicator(override: StubFilter & { calcParams?: unknown[] }): boolean;
  setPaneOptions(options: { id?: string; height?: number; state?: string; minHeight?: number }): void;
  getIndicators(filter?: StubFilter): Array<{ id: string; name: string; paneId: string; calcParams?: unknown[] }>;
  getPaneOptions(id?: string): unknown;
  /** 全部 pane id（不含 x_axis，按 pane 顺序）。 */
  __paneIds(): string[];
  /** pane id → 渲染高度。 */
  __renderedHeights(): Record<string, number>;
  /** 「指标名集合 → 渲染高度」（candle pane 显示为 candle）。 */
  __renderedByIndicator(): Record<string, number>;
  /** 某指标名当前所在 pane id（不在场 ⇒ null）。 */
  __paneIdOf(name: string): string | null;
  /** 逐次 API 调用记录（createIndicator/removeIndicator/... 的「调用记录桩」）。 */
  __log(): Array<{ api: string; arg: string }>;
}

const charts = (): ChartStub[] => H.state.charts as unknown as ChartStub[];

function lastChart(): ChartStub {
  const all = charts();
  const chart = all[all.length - 1];
  if (!chart) throw new Error('前置失败：klinecharts 实例不存在（init 未被调用）');
  return chart;
}

// ─────────────────────────────────────────────────────────────────────────────
// 指标夹具：`IndicatorName` 当前**不含** `vol`（tangle 生成物未含该键） ⇒ 用具名类型表达
// 「既有的 5 个开关 + vol」这一**实现后**的 props 面，避免 TS 多余属性检查把红测试拦在编译层。
// ─────────────────────────────────────────────────────────────────────────────

type VolIndicators = Record<IndicatorName, boolean> & { vol: boolean };

function indicators(over: Partial<Record<IndicatorName | 'vol', boolean>> = {}): VolIndicators {
  const merged: VolIndicators = { ma: true, macd: false, kdj: false, boll: false, dcap: false, vol: true, ...over };
  return merged;
}

function fakeFeed(overrides: Partial<KlineChartFeedLike> = {}): KlineChartFeedLike {
  return {
    bars: [] as Bar[],
    hasMore: false,
    loadInitial: vi.fn(async () => {}),
    loadBefore: vi.fn(async () => 0),
    onRealtime: vi.fn(() => () => {}),
    ...overrides,
  };
}

const SAT_BAR: Bar = {
  ts: '2026-09-14T02:00:00Z',
  open: 1,
  high: 1.1,
  low: 0.9,
  close: 1.05,
  volume: 100,
  amount: 105,
};

function fakeWs(): WsClient {
  const handlers = new Map<string, Set<(m: unknown) => void>>();
  return {
    subscribe: vi.fn((topic: string, h: (m: unknown) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
  } as unknown as WsClient;
}

function fakeApi(): ApiClient {
  return stubApi({ getKline: vi.fn(async () => [SAT_BAR]) } as Partial<ApiClient>);
}

/** 冲干净 feed 的 microtask/timer 队列（避免 act 告警；断言不依赖它）。 */
async function flush(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  H.state.charts.length = 0;
  H.state.initArgs.length = 0;
  H.state.log.length = 0;
  resetRealtimePollGateForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 默认值（tangle 生成物；本阶段**只断言、不修改**）
// ─────────────────────────────────────────────────────────────────────────────

describe('R1 默认值：DASHBOARD_DEFAULTS.indicators 必须含 vol 且默认 true', () => {
  it('R1-1 indicators.vol === true（默认开，与 ma/macd/kdj/boll/dcap 并列）', () => {
    // 索引访问而非 `.vol`：tangle 生成物当前**没有** vol 键 ⇒ 属性访问会变成 TS 编译错（红测试不得靠编译错红）
    const defaults: Record<string, boolean> = DASHBOARD_DEFAULTS.indicators;
    expect(defaults['vol'], 'DASHBOARD_DEFAULTS.indicators.vol 必须为 true（默认开）').toBe(true);
  });

  it('R1-2 开关集合 = {ma,macd,kdj,boll,dcap,vol}（VOL 是一个**并列**开关，不是隐藏特权）', () => {
    const defaults: Record<string, boolean> = DASHBOARD_DEFAULTS.indicators;
    expect(Object.keys(defaults).sort(), 'VOL 必须成为与 MA/MACD/KDJ/BOLL/DCAP 并列的开关项').toEqual([
      'boll',
      'dcap',
      'kdj',
      'ma',
      'macd',
      'vol',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 工具栏开关（DOM 层；沿用 Toolbar.test.tsx 既有写法）
// ─────────────────────────────────────────────────────────────────────────────

function renderToolbar(indicatorsValue: VolIndicators = indicators()) {
  const onToggleIndicator = vi.fn();
  render(
    <Toolbar
      period="15m"
      onPeriodChange={() => {}}
      chartTab="kline"
      onChartTabChange={() => {}}
      indicators={indicatorsValue}
      onToggleIndicator={onToggleIndicator}
      gridMode="single"
      onGridModeChange={() => {}}
      followLatest
      onBackToLatest={() => {}}
      maWindows={[5, 10, 20]}
      onSaveMaWindows={async () => {}}
    />,
  );
  return { onToggleIndicator };
}

const volToggle = () => screen.queryByRole('button', { name: /VOL/ });

describe('R2 工具栏开关：VOL 渲染为可点的指标开关', () => {
  it('R2-1 VOL 开关存在（文本含 VOL），且既有 5 个开关仍在（并列，不是替换）', () => {
    renderToolbar();
    for (const name of ['MA', 'MACD', 'KDJ', 'BOLL', 'DCAP']) {
      expect(screen.queryByRole('button', { name }), `${name} 开关必须仍在工具栏`).not.toBeNull();
    }
    expect(volToggle(), '工具栏必须渲染出 VOL 开关（元素文本含 VOL）').not.toBeNull();
  });

  it('R2-2 默认开：indicators.vol=true ⇒ VOL 开关 aria-pressed="true"', () => {
    renderToolbar(indicators({ vol: true }));
    expect(volToggle()?.getAttribute('aria-pressed'), 'VOL 默认开 ⇒ 开关须为按下态').toBe('true');
  });

  it('R2-3 关态：indicators.vol=false ⇒ VOL 开关 aria-pressed="false"', () => {
    renderToolbar(indicators({ vol: false }));
    expect(volToggle()?.getAttribute('aria-pressed'), 'VOL 关 ⇒ 开关须为未按下态').toBe('false');
  });

  it('R2-4 点击 VOL ⇒ onToggleIndicator 收到 "vol"', async () => {
    const { onToggleIndicator } = renderToolbar();
    const toggle = volToggle();
    expect(toggle, '前置：VOL 开关必须存在').not.toBeNull();
    await userEvent.click(toggle!);
    expect(onToggleIndicator).toHaveBeenCalledWith('vol');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 图表生效（KlineChart：indicators.vol 必须真正驱动 VOL 副图）
// ─────────────────────────────────────────────────────────────────────────────

function renderKline(indicatorsValue: VolIndicators, overrides: Partial<KlineChartFeedLike> = {}) {
  return render(
    <KlineChart
      feed={fakeFeed(overrides)}
      code="518880"
      period="15m"
      followLatest
      indicators={indicatorsValue}
      onManualZoom={() => {}}
      maWindows={[5, 10, 20]}
      dcapParams={DEFAULT_DCAP_PARAMS}
    />,
  );
}

describe('R3 图表生效：indicators.vol=false ⇒ 不创建 VOL；true ⇒ 有且仅有一个 VOL', () => {
  it('R3-1 初始即 vol:false ⇒ 无 VOL 指标、无残留 VOL 副图 pane，且其它指标不受影响', () => {
    renderKline(indicators({ vol: false, macd: true }));
    const chart = lastChart();
    expect(chart.getIndicators({ name: 'VOL' }).length, 'vol:false 时不得创建 VOL 指标').toBe(0);
    expect(chart.__renderedByIndicator()['VOL'], 'vol:false 时不得残留空 VOL 副图 pane').toBeUndefined();
    expect(chart.getIndicators({ name: 'MA' }).length, 'MA（主图叠加）不受 VOL 关闭影响').toBe(1);
    expect(chart.getIndicators({ name: 'MACD' }).length, 'MACD（独立副图）不受 VOL 关闭影响').toBe(1);
    expect(chart.__paneIds(), 'candle pane 恒在').toContain('candle_pane');
  });

  it('R3-2 true ⇒ false（会话内关掉）⇒ VOL 副图消失；MA/MACD 不被动到', () => {
    const tree = (vol: boolean) => (
      <KlineChart
        feed={fakeFeed()}
        code="518880"
        period="15m"
        followLatest
        indicators={indicators({ vol, macd: true })}
        onManualZoom={() => {}}
        maWindows={[5, 10, 20]}
        dcapParams={DEFAULT_DCAP_PARAMS}
      />
    );
    const { rerender } = render(tree(true));
    const chart = lastChart();
    expect(chart.getIndicators({ name: 'VOL' }).length, '前置：vol:true 时 VOL 在场').toBe(1);

    act(() => rerender(tree(false)));
    expect(chart.getIndicators({ name: 'VOL' }).length, 'vol 由 true 翻到 false ⇒ VOL 必须被移除').toBe(0);
    expect(chart.__renderedByIndicator()['VOL'], '关闭后不得残留空 VOL pane').toBeUndefined();
    expect(chart.getIndicators({ name: 'MA' }).length, '关 VOL 不得连带移除 MA').toBe(1);
    expect(chart.getIndicators({ name: 'MACD' }).length, '关 VOL 不得连带移除 MACD').toBe(1);
    expect(charts().length, '关 VOL 不得重建图表实例').toBe(1);
  });

  it('R3-3 vol:true ⇒ 有且仅有一个 VOL（独立副图 pane，不叠 candle_pane、不重复创建）', () => {
    renderKline(indicators({ vol: true }));
    const chart = lastChart();
    expect(chart.getIndicators({ name: 'VOL' }).length, 'vol:true 时必须有且仅有一个 VOL').toBe(1);
    const paneId = chart.__paneIdOf('VOL');
    expect(paneId, 'VOL 必须落在独立副图 pane').not.toBeNull();
    expect(paneId, 'VOL 不得叠加在 candle_pane 上（MA 才是叠加指标）').not.toBe('candle_pane');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 不重建 pane（既有硬契约的延伸：状态差分只翻转 VOL，绝不重建其它 pane）
// ─────────────────────────────────────────────────────────────────────────────

describe('R4 vol 翻转不得重建其它 pane、不得重置用户拖拽过的既有高度', () => {
  it('R4-1 true→false→true：非 VOL pane 的 id/顺序不变、拖拽高度保持、无其它指标 churn', () => {
    const tree = (vol: boolean) => (
      <KlineChart
        feed={fakeFeed()}
        code="518880"
        period="15m"
        followLatest
        indicators={indicators({ vol, macd: true })}
        onManualZoom={() => {}}
        maWindows={[5, 10, 20]}
        dcapParams={DEFAULT_DCAP_PARAMS}
      />
    );
    const { rerender } = render(tree(true));
    const chart = lastChart();

    // 前置：VOL（独立副图）+ MACD（独立副图）各在场，各占一个 pane
    const volPaneId = chart.__paneIdOf('VOL');
    const macdPaneId = chart.__paneIdOf('MACD');
    expect(chart.getIndicators({ name: 'VOL' }).length).toBe(1);
    expect(chart.getIndicators({ name: 'MACD' }).length).toBe(1);
    expect(macdPaneId).not.toBeNull();

    // 用户拖拽：等价于 SeparatorWidget 把 MACD 副图拉高（写 pane.height —— 拖后高度是唯一记忆，语义 4）
    act(() => {
      chart.setPaneOptions({ id: macdPaneId!, height: 240 });
    });
    const before = {
      paneIds: chart.__paneIds(),
      rendered: chart.__renderedByIndicator(),
      macdHeight: (chart.getPaneOptions(macdPaneId!) as { height: number }).height,
      logLen: chart.__log().length,
    };
    expect(before.macdHeight, '前置：拖拽已写入 pane 高度 240').toBe(240);
    expect(before.rendered['MACD'], '前置：拖后 MACD 渲染高度 = 240').toBe(240);

    // ① 关掉 VOL（会话态翻转）
    act(() => rerender(tree(false)));
    expect(chart.getIndicators({ name: 'VOL' }).length, 'vol:false ⇒ VOL 副图必须消失').toBe(0);
    expect(chart.__paneIds(), '关 VOL：MACD pane 的 id 必须原样保留（不得销毁重建）').toContain(macdPaneId);
    expect(chart.__paneIdOf('MACD'), '关 VOL：MACD 仍在原 pane').toBe(macdPaneId);
    expect(chart.__renderedHeights()[macdPaneId!], '关 VOL 不得重置用户拖拽过的 MACD 高度').toBe(240);

    // ② 再打开 VOL
    act(() => rerender(tree(true)));
    expect(chart.getIndicators({ name: 'VOL' }).length, 'vol:true ⇒ VOL 副图重新出现（有且仅有一个）').toBe(1);

    const afterVolPaneId = chart.__paneIdOf('VOL');
    const after = { paneIds: chart.__paneIds(), rendered: chart.__renderedByIndicator() };

    // 其它 pane（尤其 candle pane）的 id 与相对顺序不得被重建
    const beforeOther = before.paneIds.filter((id) => id !== volPaneId);
    const afterOther = after.paneIds.filter((id) => id !== volPaneId && id !== afterVolPaneId);
    expect(afterOther, '非 VOL pane 的 id 集合与顺序必须逐项不变（不得重建）').toEqual(beforeOther);
    expect(after.paneIds[0], 'candle pane 必须仍是第一个 pane（不得被重建/重排）').toBe('candle_pane');

    // 拖拽高度不得被重置（唯一记忆仍在）
    expect((chart.getPaneOptions(macdPaneId!) as { height: number }).height, 'pane.height 必须保持 240').toBe(240);
    expect(chart.__renderedHeights()[macdPaneId!], 'MACD 渲染高度必须保持 240').toBe(240);

    // 翻转期间的 create/remove 只允许涉及 VOL；不得出现其它指标 churn、不得有布局重置调用
    const burst = chart.__log().slice(before.logLen);
    expect(
      burst.filter((e) => (e.api === 'createIndicator' || e.api === 'removeIndicator') && !e.arg.includes('VOL')),
      '翻转 vol 只允许对 VOL 做 create/remove（其它指标的 remove/create = pane 被销毁重建）',
    ).toEqual([]);
    expect(
      burst.filter((e) => e.api === 'setPaneOptions'),
      '翻转 vol 不得调用 setPaneOptions（高度重置路径）',
    ).toEqual([]);

    // 全程单实例：不得整图 remount
    expect(init, '不得重新 init 图表（= 不得重建 pane）').toHaveBeenCalledTimes(1);
    expect(charts().length, '图表实例数恒为 1').toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 卫星继承（多周期卫星同样由 indicators.vol 驱动）
// ─────────────────────────────────────────────────────────────────────────────

function renderSatellite(indicatorsValue: VolIndicators) {
  return render(
    <MultiPeriodSatellite
      api={fakeApi()}
      ws={fakeWs()}
      code="518880"
      period="1h"
      height={180}
      indicators={indicatorsValue}
      maWindows={[5, 10, 20]}
      dcapParams={DEFAULT_DCAP_PARAMS}
      viewportBars={120}
      followLatest
      basePeriod="15m"
      basePeriodSource="toolbar"
    />,
  );
}

/** 基准实例的 chart 桩（`init` 的容器**不在**任何 `[data-mp-satellite]` 子树内）。 */
function baseChart(): ChartStub {
  const index = H.state.initArgs.findIndex(
    (el) => typeof (el as Element | null)?.closest === 'function' && !(el as Element).closest('[data-mp-satellite]'),
  );
  expect(index, '前置：基准 chart 实例必须存在（init 容器不在卫星子树内）').toBeGreaterThanOrEqual(0);
  return charts()[index]!;
}

/** 卫星实例的 chart 桩（`init` 的容器位于 `[data-mp-satellite]` 子树内）。 */
function satelliteChart(): ChartStub {
  const index = H.state.initArgs.findIndex(
    (el) => typeof (el as Element | null)?.closest === 'function' && !!(el as Element).closest('[data-mp-satellite]'),
  );
  expect(index, '前置：卫星 chart 实例必须存在（init 容器在 [data-mp-satellite] 子树内）').toBeGreaterThanOrEqual(0);
  return charts()[index]!;
}

describe('R5 卫星继承：indicators.vol=false ⇒ 卫星同样无 VOL', () => {
  it('R5-1 MultiPeriodSatellite（indicators.vol=false）⇒ 卫星不创建 VOL，MA 仍在', async () => {
    renderSatellite(indicators({ vol: false }));
    await flush();
    const sat = satelliteChart();
    expect(sat.getIndicators({ name: 'VOL' }).length, '卫星必须继承 vol=false（不得有 VOL 副图）').toBe(0);
    expect(sat.getIndicators({ name: 'MA' }).length, '卫星其它继承指标不受影响').toBe(1);
  });

  it('R5-2 MultiPeriodChartStack 透传 vol=false ⇒ 卫星同样不创建 VOL', async () => {
    render(
      <MultiPeriodChartStack
        enabled
        satellites={[{ period: '1h', height: 180 }]}
        api={fakeApi()}
        ws={fakeWs()}
        code="518880"
        availableHeight={600}
        basePeriod="15m"
        indicators={indicators({ vol: false })}
      >
        <div data-testid="mp-stack-base-child" />
      </MultiPeriodChartStack>,
    );
    await flush();
    const sat = satelliteChart();
    expect(sat.getIndicators({ name: 'VOL' }).length, '栈透传 vol=false ⇒ 卫星不得创建 VOL').toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R6 兜底默认（守卫：栈未收到 indicators 时的内部 DEFAULT_INDICATORS 必须含 vol:true）
// ─────────────────────────────────────────────────────────────────────────────

describe('R6 兜底默认：MultiPeriodChartStack 未收到 indicators ⇒ 兜底默认仍须含 vol:true', () => {
  it('R6-1 不传 indicators prop ⇒ 卫星仍会创建 VOL（兜底默认 vol:true）', async () => {
    render(
      <MultiPeriodChartStack
        enabled
        satellites={[{ period: '1h', height: 180 }]}
        api={fakeApi()}
        ws={fakeWs()}
        code="518880"
        availableHeight={600}
        basePeriod="15m"
      >
        <div data-testid="mp-stack-base-child" />
      </MultiPeriodChartStack>,
    );
    await flush();

    const sat = satelliteChart();
    const volCreates = sat.__log().filter((e) => e.api === 'createIndicator' && e.arg.includes('"VOL"'));
    expect(
      volCreates.length,
      '兜底默认必须含 vol:true ⇒ 卫星必须调用 createIndicator({name:"VOL"})',
    ).toBeGreaterThan(0);
    expect(sat.getIndicators({ name: 'VOL' }).length, '兜底默认 vol:true ⇒ 卫星有且仅有一个 VOL').toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R7（附加，非父级枚举条目）：页面级接线 —— 工具栏 VOL 开关必须真的作用到主图，且是**会话态**
// ─────────────────────────────────────────────────────────────────────────────

describe('R7（附加）页面级：工具栏 VOL 开关驱动主图，且不落服务端配置（会话态）', () => {
  it('R7-1 点击 VOL ⇒ 主图 VOL 副图消失；不调用任何配置写接口', async () => {
    const ws = fakeWs();
    const api = stubApi({
      getSymbols: vi.fn(async () => [
        { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
      ]),
      getKline: vi.fn(async () => [SAT_BAR]),
      getMultiPeriodConfig: vi.fn(async () => ({
        enabled: false,
        periods: ['15m'],
        heights: { '15m': 420 },
        indicators: [],
      })),
    } as Partial<ApiClient>);

    render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await flush();

    const chart = baseChart();
    expect(chart.getIndicators({ name: 'VOL' }).length, '前置：默认开 ⇒ 主图有 VOL 副图').toBe(1);

    /** 配置写接口调用计数快照（会话态判据：VOL 开关不得写服务端配置）。 */
    const writeCalls = () => {
      const record = api as unknown as Record<string, { mock: { calls: unknown[] } }>;
      return ['saveMaConfig', 'saveDcapConfig', 'saveMultiPeriodConfig', 'saveKlineConfig']
        .map((name) => `${name}:${record[name]!.mock.calls.length}`)
        .join(',');
    };
    const before = writeCalls();

    const toggle = screen.queryByRole('button', { name: /VOL/ });
    expect(toggle, '前置：工具栏必须渲染出 VOL 开关').not.toBeNull();
    await userEvent.click(toggle!);
    await flush();

    expect(chart.getIndicators({ name: 'VOL' }).length, '关掉 VOL ⇒ 主图不再有 VOL 副图').toBe(0);
    expect(writeCalls(), 'VOL 是会话态：切换不得写任何服务端配置').toBe(before);
  });
});
