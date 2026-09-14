/**
 * 红测试（P2-A）：**T2 隐藏 K 线 / T5 指标继承（除 LIVE 段）/ T8 数据与预算（G3）**。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodSatellite.test.tsx`
 * 权威依据：
 *  - `design/15-multi-period/01-adr.md`（ADR-022 口径 2/4/5/9/11/12）
 *  - `design/15-multi-period/02-spec.md` §3.4（隐藏 K 线唯一手段）、§4.1（指标继承）、§4.3（`addOverlayIndicator`）、
 *    §5（数据契约：每实例一个 `KlineDataFeed` / 预算护栏 / 禁止本地聚合）、§6（布局）
 *  - `design/15-multi-period/03-test-plan.md` T2 / T5（除 LIVE 段）/ T8（G3）
 *  - `design/15-multi-period/04-implementation-plan.md` P2（卫星实例）
 *  - 本文件的设计报告：`tester/design/269_p2a_satellite_red_design.md`（定义了本文件钉死的 DOM/记账契约）
 *
 * 预期 red 理由：**P2 卫星实例尚不存在** —— `MultiPeriodChartStack(enabled=true)` 目前只透传 children
 * （`web/src/features/dashboard/MultiPeriodChartStack.tsx`），因此：只 1 次 `init`、无 `[data-mp-satellite]` 元素、
 * 卫星周期（除基准外）无取数/无订阅。**实现 P2 后本文件应转绿，且不得改动断言口径**。
 *
 * 层级策略（任务明确）：本文件用**既有忠实桩**（`src/test/chartStoreStub.ts` 复刻 `StoreImp.addIndicator`
 * 的「isStack=false ⇒ 先清空同 pane」语义）跑 jsdom；**真实 klinecharts 的像素/几何取证由 Playwright 承担**
 * （`web/tester/p2-satellite-harness/`，G4 前置声明见设计报告 §6：像素证据在阶段 3 用**页面截图**完成，
 * **禁用图表导出** `getConvertPictureUrl`——零高 pane 会抛 `InvalidStateError`）。
 *
 * 钉死的 DOM 契约（唯一新增 testability hook，见设计报告 §3.2）：
 *  卫星实例根元素必须带 `data-mp-satellite="<period>"`，其内联 `style.height === heights[period] + 'px'`；
 *  该元素内必须是该卫星 chart 的容器（`init(el)` 的 el 在其子树内）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import {
  DCAP_INDICATOR_TEMPLATE,
  DCAP_PRECISION,
  DCAP_ZERO_FIGURE_KEY,
  DEFAULT_DCAP_PARAMS,
  dcapCalcParams,
  dcapWarmupBars,
} from '@/features/indicators/dcapIndicator';
import { MAX_CONCURRENT_POLLS, resetRealtimePollGateForTest } from './realtimePoll';
import { KlineDataFeed, REALTIME_POLL_LIMIT } from './feed';

// ─────────────────────────────────────────────────────────────────────────────
// klinecharts 桩：**每次 init 返回一个新的忠实实例桩**（P1 的共享单桩无法做「逐实例」断言）
// ─────────────────────────────────────────────────────────────────────────────

/** hoisted 容器：mock 工厂工厂无法引用外部变量，故用 vi.hoisted。 */
const H = vi.hoisted(() => ({
  stubs: [] as any[],
  initArgs: [] as any[],
}));

vi.mock('klinecharts', async () => {
  const { createChartStoreStub } = await import('@/test/chartStoreStub');
  return {
    init: vi.fn((el: unknown) => {
      const store = createChartStoreStub();
      const actionHandlers = new Map<string, Set<(p: unknown) => void>>();
      const stub = {
        ...store,
        setSymbol: vi.fn(),
        setPeriod: vi.fn(),
        setDataLoader: vi.fn(),
        setBarSpace: vi.fn(),
        overrideIndicator: vi.fn(),
        resetData: vi.fn(),
        setStyles: vi.fn(),
        resize: vi.fn(),
        setPaneOptions: vi.fn(),
        scrollToRealTime: vi.fn(),
        scrollToDataIndex: vi.fn(),
        getVisibleRange: vi.fn(() => ({ from: 0, to: 10 })),
        convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
        createOverlay: vi.fn(),
        removeOverlay: vi.fn(),
        subscribeAction: vi.fn((type: string, h: (p: unknown) => void) => {
          if (!actionHandlers.has(type)) actionHandlers.set(type, new Set());
          actionHandlers.get(type)!.add(h);
        }),
        unsubscribeAction: vi.fn(),
        /** 供 T2-3「缩放/滚动后仍成立」派发用（非 klinecharts 公开 API，仅测试可见）。 */
        __actionHandlers: actionHandlers,
      };
      H.stubs.push(stub);
      H.initArgs.push(el);
      return stub;
    }),
    dispose: vi.fn(),
    registerIndicator: vi.fn(),
  };
});

import { init } from 'klinecharts';
import { DashboardPage } from './DashboardPage';

type ChartStub = ReturnType<typeof makeStubType>;
/** 仅类型占位（真实对象由 mock 工厂构造）。 */
function makeStubType() {
  return {
    setPaneOptions: vi.fn(),
    setStyles: vi.fn(),
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    getIndicators: vi.fn(
      (_filter?: { id?: string; name?: string; paneId?: string }) =>
        [] as Array<{ name: string; paneId: string }>,
    ),
    overrideIndicator: vi.fn(),
    subscribeAction: vi.fn(),
    __actionHandlers: new Map<string, Set<(p: unknown) => void>>(),
    mock: { calls: [] as unknown[][] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 假 api / 假 ws
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOLS = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
];
const VIEWPORT_BARS = 120;
/** 基准周期（DashboardPage 默认周期 = `DASHBOARD_DEFAULTS.period` = '15m'）。 */
const BASE_PERIOD = '15m';

const BAR = {
  ts: '2026-09-14T02:00:00Z',
  open: 1,
  high: 1.1,
  low: 0.9,
  close: 1.05,
  volume: 100,
  amount: 105,
};

interface KlineQueryLike {
  code: string;
  period: string;
  limit?: number;
  before?: string;
}

interface Ctx {
  ws: FakeWs;
  getKline: ReturnType<typeof vi.fn>;
  getMultiPeriodConfig: ReturnType<typeof vi.fn>;
  view: ReturnType<typeof render>;
}

interface FakeWs {
  handlers: Map<string, Set<(m: unknown) => void>>;
  subscribe: ReturnType<typeof vi.fn>;
}

function fakeWs(): FakeWs {
  const handlers = new Map<string, Set<(m: unknown) => void>>();
  return {
    handlers,
    subscribe: vi.fn((topic: string, h: (m: unknown) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
  } as unknown as FakeWs;
}

/** 假 ApiClient：契约 mock 底座 + 覆写取数/配置读取（保留调用记录 ⇒ G3 计数证据）。 */
function fakeApi(mpConfig: Record<string, unknown>) {
  const getKline = vi.fn(async (_q: KlineQueryLike) => [BAR]);
  const getMultiPeriodConfig = vi.fn(async () => mpConfig);
  const api = {
    ...stubApi({
      getSymbols: vi.fn(async () => SYMBOLS),
      getKline,
      getKlineConfig: vi.fn(async () => ({ viewport_bars: VIEWPORT_BARS })),
    }),
    getMultiPeriodConfig,
  } as unknown as ApiClient;
  return { api, getKline, getMultiPeriodConfig };
}

async function renderEnabled(mpConfig: Record<string, unknown>): Promise<Ctx> {
  const ws = fakeWs();
  const { api, getKline, getMultiPeriodConfig } = fakeApi(mpConfig);
  const view = render(
    <MemoryRouter>
      <DashboardPage api={api} ws={ws as unknown as WsClient} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
  await flush();
  return { ws, getKline, getMultiPeriodConfig, view };
}

/** 冲干净 microtask/timer 队列（配置 load → 建实例 → 各 feed 取数）。 */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐实例读数辅助
// ─────────────────────────────────────────────────────────────────────────────

function stubs(): ChartStub[] {
  return H.stubs as ChartStub[];
}

/** 卫星根元素（契约：`data-mp-satellite="<period>"`）。 */
function satelliteEls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-mp-satellite]'));
}

/** 卫星根元素声明的周期（按声明顺序）。 */
function satellitePeriods(root: HTMLElement): string[] {
  return satelliteEls(root).map((el) => el.getAttribute('data-mp-satellite') ?? '');
}

/** 某个 chart 桩对应的容器元素所在卫星（无 ⇒ null = 基准实例）。 */
function satelliteOf(index: number): HTMLElement | null {
  const el = H.initArgs[index] as Element | undefined;
  if (!el || typeof (el as Element).closest !== 'function') return null;
  return (el as Element).closest('[data-mp-satellite]') as HTMLElement | null;
}

/** 基准实例（不属于任何卫星）的 chart 桩下标。 */
function baseIndex(): number {
  for (let i = 0; i < stubs().length; i++) if (!satelliteOf(i)) return i;
  return -1;
}

/** 卫星实例 chart 桩下标（按卫星元素顺序）。 */
function satelliteIndexes(): number[] {
  return stubs()
    .map((_, i) => i)
    .filter((i) => satelliteOf(i) !== null);
}

/** `createIndicator` 调用（滤 paneId / name）。 */
function createCalls(index: number, filter: { name?: string; paneId?: string } = {}) {
  const calls = stubs()[index]!.createIndicator.mock.calls as unknown as Array<
    [string | { name: string; paneId?: string }, boolean?]
  >;
  return calls.filter((c) => {
    const spec = typeof c[0] === 'string' ? { name: c[0] } : c[0];
    if (filter.name !== undefined && spec.name !== filter.name) return false;
    if (filter.paneId !== undefined && (spec as { paneId?: string }).paneId !== filter.paneId)
      return false;
    return true;
  });
}

function setPaneCalls(index: number) {
  return stubs()[index]!.setPaneOptions.mock.calls as unknown as Array<[Record<string, unknown>]>;
}

function barTopics(ws: FakeWs): string[] {
  return Array.from(ws.handlers.keys())
    .filter((t) => t.startsWith('bar:'))
    .sort();
}

/** 初始化窗口取数（无 `before` 游标、limit ≠ 兜底窗口）。 */
function initQueries(getKline: ReturnType<typeof vi.fn>): KlineQueryLike[] {
  return (getKline.mock.calls as unknown as Array<[KlineQueryLike]>)
    .map((c) => c[0])
    .filter((q) => q.before === undefined && q.limit !== REALTIME_POLL_LIMIT);
}

/** 全部非兜底取数（窗口 + `before` 游标补取）。 */
function nonPollQueries(getKline: ReturnType<typeof vi.fn>): KlineQueryLike[] {
  return (getKline.mock.calls as unknown as Array<[KlineQueryLike]>)
    .map((c) => c[0])
    .filter((q) => q.limit !== REALTIME_POLL_LIMIT);
}

function pollQueries(getKline: ReturnType<typeof vi.fn>): KlineQueryLike[] {
  return (getKline.mock.calls as unknown as Array<[KlineQueryLike]>)
    .map((c) => c[0])
    .filter((q) => q.before === undefined && q.limit === REALTIME_POLL_LIMIT);
}

function byPeriod(queries: KlineQueryLike[]): Map<string, KlineQueryLike[]> {
  const m = new Map<string, KlineQueryLike[]>();
  for (const q of queries) {
    if (!m.has(q.period)) m.set(q.period, []);
    m.get(q.period)!.push(q);
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// T2 隐藏 K 线（卫星）
// ─────────────────────────────────────────────────────────────────────────────

/** 2 周期（基准 15m + 卫星 1h）：与 DashboardPage 默认周期一致 ⇒ 不掺入「基准周期由 config 决定」的耦合。 */
const MP_2 = {
  enabled: true,
  periods: [BASE_PERIOD, '1h'],
  heights: { [BASE_PERIOD]: 420, '1h': 180 },
  indicators: ['dcap'],
};

describe('T2 卫星实例隐藏 K 线（state:minimize + separator:0）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.stubs.length = 0;
    H.initArgs.length = 0;
    resetRealtimePollGateForTest();
  });

  it('T2-1 卫星 candle_pane 必须用 state:"minimize"+minHeight:0 折叠、separator.size=0；且不得依赖 height:0', async () => {
    const { view } = await renderEnabled(MP_2);

    // ① 实例数 = 1 基准 + 1 卫星
    expect(init, '每个实例各 1 次 init（基准 1 + 卫星 1）').toHaveBeenCalledTimes(2);
    expect(satellitePeriods(view.container), '卫星根元素必须带 data-mp-satellite="1h"').toEqual([
      '1h',
    ]);

    const satIdx = satelliteIndexes()[0];
    expect(satIdx, '卫星 chart 实例必须存在（init 的容器在 [data-mp-satellite] 子树内）').toBeDefined();
    const sat = stubs()[satIdx!]!;

    // ② 唯一可行手段（02-spec §3.4）：state:'minimize' + minHeight:0
    const minimize = setPaneCalls(satIdx!).filter(
      (c) => (c[0] as { id?: string }).id === 'candle_pane',
    );
    expect(minimize.length, '卫星应显式配置 candle_pane pane options').toBeGreaterThan(0);
    expect(
      minimize.some((c) => c[0].state === 'minimize' && c[0].minHeight === 0),
      "卫星 candle_pane 必须 state:'minimize' 且 minHeight:0（02-spec §3.4 唯一可行手段）",
    ).toBe(true);

    // ③ 不得依赖 height:0（库守卫静默忽略：index.esm.js:15421 ⇒ 库事实回归的调用面）
    expect(
      minimize.some((c) => 'height' in c[0]),
      '卫星隐藏 K 线不得走 setPaneOptions({height:0})（被静默忽略，index.esm.js:15421）',
    ).toBe(false);

    // ④ 残留空隙（分隔条）必须归零
    const styleCalls = sat.setStyles.mock.calls as unknown as Array<[Record<string, any>]>;
    expect(
      styleCalls.some((c) => (c[0] as any)?.separator?.size === 0),
      '卫星 setStyles({separator:{size:0}}) 必须调用（零高 pane 的残留间隙）',
    ).toBe(true);

    // ⑤ 基准实例不得被折叠（K 线只在基准实例显示）
    const base = baseIndex();
    expect(base, '基准实例必须存在').toBeGreaterThanOrEqual(0);
    const baseMinimize = setPaneCalls(base).filter(
      (c) => (c[0] as { id?: string }).id === 'candle_pane' && c[0].state === 'minimize',
    );
    expect(baseMinimize, '基准实例的 candle_pane 不得被 minimize（卫星才隐藏 K 线）').toEqual([]);
  });

  it('T2-2 卫星实例高度 = heights[period]（指标 pane 填满实例容器）', async () => {
    const { view } = await renderEnabled(MP_2);
    const els = satelliteEls(view.container);
    expect(els.length, '卫星实例数 = periods[1..] 长度（1）').toBe(1);
    for (const el of els) {
      const period = el.getAttribute('data-mp-satellite')!;
      const h = (MP_2.heights as Record<string, number>)[period];
      expect(
        el.style.height,
        `卫星 ${period} 实例容器高度必须 = heights[${period}]（${h}px）⇒ 指标 pane 填满实例`,
      ).toBe(`${h}px`);
    }
  });

  it('T2-3 缩放/滚动后仍成立：不重建实例、折叠不回弹、分隔条仍为 0', async () => {
    const { view, ws } = await renderEnabled(MP_2);
    const satIdx = satelliteIndexes()[0]!;
    const sat = stubs()[satIdx]!;

    // 派发 onZoom/onScroll（KlineChart 订阅的两个用户交互动作）到**所有**实例
    await act(async () => {
      for (const s of stubs()) {
        for (const handlers of s.__actionHandlers.values()) {
          for (const h of handlers) {
            try {
              h({ from: 1, to: 60 });
            } catch {
              /* 桩容器无 DOM 度量，忽略 */
            }
          }
        }
      }
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(init, '缩放/滚动不得重建实例（init 计数不变）').toHaveBeenCalledTimes(2);
    expect(satellitePeriods(view.container), '卫星实例不得消失/重建').toEqual(['1h']);

    const minimize = setPaneCalls(satIdx).filter((c) => (c[0] as { id?: string }).id === 'candle_pane');
    expect(
      minimize.every((c) => c[0].state === 'minimize' && c[0].minHeight === 0),
      '缩放/滚动后卫星 candle_pane 仍必须是 minimize（不得回弹为可见）',
    ).toBe(true);
    const styleCalls = sat.setStyles.mock.calls as unknown as Array<[Record<string, any>]>;
    expect(
      (styleCalls[styleCalls.length - 1]![0] as any)?.separator?.size ?? null,
      '缩放/滚动后 separator.size 仍为 0',
    ).toBe(0);
    // 无多余订阅/取数风暴（滚动不应触发额外 HTTP）
    expect(barTopics(ws).length, '滚动不得新增/重建 WS 订阅').toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 指标继承（除 LIVE 段）
// ─────────────────────────────────────────────────────────────────────────────

/** 基准勾选集合（02-spec §4.1）：{MA, MACD, KDJ, BOLL, DCAP}（MA 默认开，其余点开）。 */
const CHECKED = ['MA', 'MACD', 'KDJ', 'BOLL', 'DCAP'] as const;

async function enableCheckedIndicators(): Promise<void> {
  for (const name of ['MACD', 'KDJ', 'BOLL', 'DCAP'] as const) {
    fireEvent.click(screen.getByRole('button', { name }));
  }
  await flush();
}

/** 每个实例的在场指标名集合（桩复刻 `StoreImp.getIndicatorsByFilter`）。 */
function indicatorNames(index: number): string[] {
  return (stubs()[index]!.getIndicators.mock.calls.length >= 0
    ? (stubs()[index]!.getIndicators({}) as Array<{ name: string }>)
    : []
  ).map((i) => i.name);
}

describe('T5 指标继承（每实例各自渲染基准勾选集合；除 LIVE 段）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.stubs.length = 0;
    H.initArgs.length = 0;
    resetRealtimePollGateForTest();
  });

  it('T5-1 基准勾选 {MA,MACD,KDJ,BOLL,DCAP} ⇒ 每个卫星各自非空且集合一致', async () => {
    await renderEnabled(MP_2);
    await enableCheckedIndicators();

    const idxs = [baseIndex(), ...satelliteIndexes()];
    expect(idxs.length, '实例数 = 1 基准 + 1 卫星').toBe(2);

    for (const i of idxs) {
      for (const name of CHECKED) {
        expect(
          stubs()[i]!.getIndicators({ name }).length,
          `实例 #${i}（${satelliteOf(i) ? '卫星' : '基准'}）必须有 ${name} 指标在场（getIndicators 非空）`,
        ).toBeGreaterThan(0);
      }
    }
    const baseSet = [...indicatorNames(idxs[0]!)].sort();
    for (const i of idxs.slice(1)) {
      expect(
        [...indicatorNames(i)].sort(),
        `卫星 #${i} 的指标集合必须与基准一致（继承基准勾选集合，02-spec §4.1）`,
      ).toEqual(baseSet);
    }
  });

  it('T5-2 叠加指标必须走 addOverlayIndicator：所有 createIndicator 显式 isStack=true 且无静默顶掉', async () => {
    const { view } = await renderEnabled(MP_2);
    await enableCheckedIndicators();

    // 前置：卫星实例必须在（否则本用例只覆盖基准实例 ⇒ 断言空洞）
    expect(init, '前置：每实例 1 次 init（基准 1 + 卫星 1）').toHaveBeenCalledTimes(2);
    expect(satellitePeriods(view.container), '前置：卫星实例存在').toEqual(['1h']);

    for (let i = 0; i < stubs().length; i++) {
      const calls = stubs()[i]!.createIndicator.mock.calls as unknown as Array<[unknown, unknown]>;
      const naked = calls
        .map((c, n) => ({ n, arg: c[1] }))
        .filter(({ arg }) => arg !== true)
        .map(({ n, arg }) => `#${n} isStack=${String(arg)}`);
      expect(
        naked,
        `实例 #${i} 存在裸 createIndicator(isStack≠true)（P7 根因：会静默清空该 pane）`,
      ).toEqual([]);

      // 非空断言：创建过的每个指标名在结束时都必须仍在场（不得被后续创建静默顶掉）
      const created = new Set(
        calls.map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as { name: string }).name)),
      );
      for (const name of created) {
        expect(
          stubs()[i]!.getIndicators({ name }).length,
          `实例 #${i}：${name} 被创建后又被静默顶掉（isStack 语义坑）`,
        ).toBeGreaterThan(0);
      }
    }

    // 基准 MA 必须走入口语义：先 removeIndicator({name:'MA'}) 再 createIndicator(...,true)
    const base = baseIndex();
    const removeNames = (stubs()[base]!.removeIndicator.mock.calls as unknown as Array<
      [{ name?: string }]
    >).map((c) => c[0]?.name);
    expect(removeNames, "基准实例 MA 必须经 addOverlayIndicator（显式 removeIndicator({name:'MA'}) 后追加）").toContain(
      'MA',
    );
    expect(createCalls(base, { name: 'MA' }).length, '基准 MA 必须在场且只建一次').toBe(1);
  });

  it('T5-3 DCAP 逐实例：precision 5 + 0 参考线（zero figure）+ 数据不足断线', async () => {
    const { view } = await renderEnabled(MP_2);
    await enableCheckedIndicators();

    const expectedParams = dcapCalcParams(DEFAULT_DCAP_PARAMS);
    const idxs = [baseIndex(), ...satelliteIndexes()];
    // 前置：逐实例 = 基准 + 每个卫星（否则只验基准实例 ⇒ 断言空洞）
    expect(init, '前置：每实例 1 次 init（基准 1 + 卫星 1）').toHaveBeenCalledTimes(2);
    expect(satellitePeriods(view.container), '前置：卫星实例存在').toEqual(['1h']);
    expect(idxs.length, '前置：实例数 = 2').toBe(2);
    for (const i of idxs) {
      // 逐实例创建记录：DCAP 走 isStack=true（独立副图 pane）
      const dcapCalls = createCalls(i, { name: 'DCAP' });
      expect(dcapCalls.length, `实例 #${i} 必须创建 DCAP`).toBeGreaterThan(0);
      expect(
        dcapCalls.filter((c) => c[1] === true).length,
        `实例 #${i} 的 DCAP 必须 isStack=true（独立副图 pane）`,
      ).toBe(dcapCalls.length);
      expect(
        (dcapCalls[0]![0] as { calcParams?: number[] }).calcParams,
        `实例 #${i} 的 DCAP calcParams 必须 = 当前 dcap 显示参数`,
      ).toEqual(expectedParams);

      // 逐实例参数下：模板事实（precision 5 / zero 参考线 / 数据不足断线）
      expect(DCAP_INDICATOR_TEMPLATE.precision, 'DCAP 模板必须 precision=5（默认 4 会丢第 5 位）').toBe(
        DCAP_PRECISION,
      );
      expect(
        DCAP_INDICATOR_TEMPLATE.figures!.some((f) => f.key === DCAP_ZERO_FIGURE_KEY),
        'DCAP 模板必须含 0 参考线 figure（zero）',
      ).toBe(true);

      // 数据不足（2 根 @ 需 n_l+m−1=62）⇒ 三线断线、zero 恒 0、长度对齐、不抛
      const short = Array.from({ length: 2 }, (_, n) => ({
        timestamp: 1_760_000_000_000 + n * 60_000,
        open: 1,
        high: 1,
        low: 1,
        close: 1 + n * 0.001,
        volume: 1,
      }));
      const out = DCAP_INDICATOR_TEMPLATE.calc!(
        short as never,
        { calcParams: expectedParams } as never,
      ) as unknown as Array<Record<string, unknown>>;
      expect(out.length, `实例 #${i}：DCAP 输出长度必须等于 bar 数（断线不缩短）`).toBe(2);
      expect(out[1], `实例 #${i}：数据不足必须断线（三线 null）且 0 线仍在`).toMatchObject({
        s: null,
        m: null,
        l: null,
        zero: 0,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 数据与预算（G3）
// ─────────────────────────────────────────────────────────────────────────────

/** 4 周期 × 1 标的（基准 1m；卫星 5m/15m/1h，均 ≥ 基准且不含 1mo）。 */
const MP_4 = {
  enabled: true,
  periods: ['1m', '5m', '15m', '1h'],
  heights: { '1m': 420, '5m': 180, '15m': 180, '1h': 180 },
  indicators: ['dcap'],
};

describe('T8 数据与预算（G3：4 周期 × 1 标的）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.stubs.length = 0;
    H.initArgs.length = 0;
    resetRealtimePollGateForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T8-1 每实例 1 个 KlineDataFeed：4 次 init / 每周期各 1 次初始化 HTTP / 4 个 bar: 订阅', async () => {
    const { ws, getKline } = await renderEnabled(MP_4);

    expect(init, '4 周期 ⇒ 4 个 chart 实例（每实例一个 feed）').toHaveBeenCalledTimes(4);
    expect(
      satellitePeriods(document.querySelector('[data-region="main-chart"]') as HTMLElement),
      '卫星实例 = periods[1..]（5m/15m/1h）',
    ).toEqual(['5m', '15m', '1h']);

    // 初始化 HTTP：每周期恰 1 次、命中各自 period，且 limit = 视口根数（DCAP 未开 ⇒ 无 warmup）
    const queries = initQueries(getKline);
    const grouped = byPeriod(queries);
    expect([...grouped.keys()].sort(), '初始化取数必须覆盖 4 个配置周期，且不得取配置外的周期').toEqual([
      '15m',
      '1h',
      '1m',
      '5m',
    ]);
    for (const [period, qs] of grouped) {
      expect(qs.length, `周期 ${period} 的初始化取数必须恰 1 次（每实例一个 feed，不重复）`).toBe(1);
      expect(qs[0]!.code, '取数标的必须 = 当前选中标的').toBe('518880');
      expect(qs[0]!.limit, `周期 ${period} 初始化 limit 必须 = viewport_bars（DCAP 未开 ⇒ 无 warmup）`).toBe(
        VIEWPORT_BARS,
      );
    }

    // WS：每实例 1 个 bar:{code}:{period} 订阅（4 个 key，不跨周期合并）
    expect(barTopics(ws as unknown as FakeWs), 'WS 订阅 = 4 个周期的 4 个 key').toEqual([
      'bar:518880:15m',
      'bar:518880:1h',
      'bar:518880:1m',
      'bar:518880:5m',
    ]);
  });

  it('T8-2 每分钟兜底 ≤4、按 (code,period) 各自成 key（不跨周期合并）、并发闸 ≤3【两段式：段 1 挂起窗口内 ≤3 / 段 2 释放名额后补发至覆盖 4 周期】', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 交易日 2026-09-14 10:00 北京（= 02:00Z）⇒ trading 会话（既有 feed 兜底调度口径）
    vi.setSystemTime(new Date('2026-09-14T02:00:00Z'));

    const { getKline } = await renderEnabled(MP_4);
    expect(init, '前置：4 实例已建').toHaveBeenCalledTimes(4);

    // 让兜底请求**挂起**（不 resolve）⇒ 观测并发闸与排队行为
    const pending: Array<() => void> = [];
    getKline.mockImplementation(
      (_q: KlineQueryLike) =>
        new Promise((resolve) => {
          pending.push(() => resolve([{ ...BAR }]));
        }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // ── 段 1（挂起窗口内）：并发闸 ≤ MAX_CONCURRENT_POLLS + 预算上限 ≤4 + 已派发 key 互不相同 ──
    const inFlight = pollQueries(getKline);
    expect(
      new Set(inFlight.map((q) => `${q.code}:${q.period}`)).size,
      '每周期各自成 key（不得跨周期合并成一个请求）',
    ).toBe(inFlight.length);
    expect(
      inFlight.length,
      '段 1 前置：挂起窗口内必须确有兜底请求在途（否则并发闸断言空洞）',
    ).toBeGreaterThan(0);
    expect(
      inFlight.length,
      `段 1（挂起窗口内）：在途兜底 ≤ MAX_CONCURRENT_POLLS(${MAX_CONCURRENT_POLLS})；超出的 (code,period) 必须排队而非同时发起`,
    ).toBeLessThanOrEqual(MAX_CONCURRENT_POLLS);
    expect(inFlight.length, '每分钟兜底请求数 ≤ 4（4 周期 × 1 标的）').toBeLessThanOrEqual(4);
    expect(
      new Set(inFlight.map((q) => `${q.code}:${q.period}`)).size,
      '段 1：已派发的 (code,period) 必须互不相同（同 key 必须合并，不得重复占用并发名额）',
    ).toBe(inFlight.length);
    for (const [period, qs] of byPeriod(inFlight)) {
      expect(qs.length, `段 1：周期 ${period} 每分钟兜底恰 ≤1 次`).toBeLessThanOrEqual(1);
      expect(qs[0]!.limit, '分钟兜底取数根数 = REALTIME_POLL_LIMIT（覆盖 1–2 根缺口的增量窗口）').toBe(
        REALTIME_POLL_LIMIT,
      );
    }

    // ── 段 2（释放一个名额后）：排队请求必须继续发起（不丢请求）⇒ 最终覆盖 4 周期 ──
    expect(pending.length, '段 1 前置：挂起中的请求数必须 = 观测到的在途数（供逐槽放行）').toBe(
      inFlight.length,
    );
    await act(async () => {
      // 只放行一个名额：排队中的 (code,period) 必须由闸门接续派发（严禁一次全放）
      pending.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    });

    const afterRelease = pollQueries(getKline);
    expect(
      afterRelease.length,
      '段 2：释放 1 个名额后排队中的兜底必须继续发起（不丢请求）',
    ).toBeGreaterThan(inFlight.length);
    expect(afterRelease.length, '每分钟兜底请求数 ≤ 4（4 周期 × 1 标的）').toBeLessThanOrEqual(4);
    expect(
      new Set(afterRelease.map((q) => `${q.code}:${q.period}`)).size,
      '段 2：全部已派发 (code,period) 仍必须互不相同（不得跨周期合并）',
    ).toBe(afterRelease.length);
    expect(
      [...byPeriod(afterRelease).keys()].sort(),
      '段 2：释放名额后兜底最终必须覆盖全部 4 个周期（每周期 ≤1 次/分钟）',
    ).toEqual(['15m', '1h', '1m', '5m']);
    for (const [period, qs] of byPeriod(afterRelease)) {
      expect(qs.length, `段 2：周期 ${period} 每分钟兜底恰 ≤1 次`).toBeLessThanOrEqual(1);
      expect(qs[0]!.limit, '分钟兜底取数根数 = REALTIME_POLL_LIMIT（覆盖 1–2 根缺口的增量窗口）').toBe(
        REALTIME_POLL_LIMIT,
      );
    }
    vi.useRealTimers();
  });

  it('T8-3 warmup 口径：DCAP 显示时每实例都必须 warmup（窗口 limit = viewport+warmup 或 before 游标补取）', async () => {
    const { getKline } = await renderEnabled(MP_4);
    await enableCheckedIndicators();

    const warmup = dcapWarmupBars(DEFAULT_DCAP_PARAMS);
    expect(warmup, '前置：默认 dcap 参数的 warmup 必须 > 0（8/26/60, m=3 ⇒ 62）').toBeGreaterThan(0);

    // 前置：4 个周期都必须有取数（否则本用例对「卫星是否 warmup」空洞）
    const grouped = byPeriod(nonPollQueries(getKline));
    expect([...grouped.keys()].sort(), '前置：4 个实例都必须有取数记录').toEqual([
      '15m',
      '1h',
      '1m',
      '5m',
    ]);

    // 02-spec §5「warmup 仅当该实例显示 dcap」+ 既有热更新契约（KlineChart §6）：
    // 合法路径有两条，二者之一成立即算 warmup 达标 ——
    //   (a) 建 feed 时 DCAP 已开 ⇒ 窗口取数 limit = viewport_bars + warmup；
    //   (b) DCAP 后开（勾选/参数保存） ⇒ 原地 `before` 游标向前补取 warmup 差额（不重建 pane）。
    for (const [period, qs] of grouped) {
      const warmupHit = qs.some(
        (q) =>
          (q.before === undefined && q.limit === VIEWPORT_BARS + warmup) ||
          (q.before !== undefined && (q.limit ?? 0) > 1),
      );
      expect(
        warmupHit,
        `周期 ${period}：DCAP 显示后该实例必须 warmup（窗口 limit=${VIEWPORT_BARS + warmup}，或 before 游标补取）`,
      ).toBe(true);
    }
  });

  it('T8-4 禁止本地聚合（行为级）：每周期请求命中各自 period，不得用基准周期聚合替代', async () => {
    const { getKline } = await renderEnabled(MP_4);
    const queries = initQueries(getKline);

    // ① 请求的 period 集合恰 = 配置周期集合（没有「只取 1m 再自行聚合」的痕迹：卫星周期必须真取后端）
    expect([...byPeriod(queries).keys()].sort()).toEqual(['15m', '1h', '1m', '5m']);
    // ② 不得出现「同一周期被多实例重复取数」（本地聚合实现通常会取低周期再派生 ⇒ 低周期被多取）
    const counts = [...byPeriod(queries).values()].map((v) => v.length);
    expect(counts.every((c) => c === 1), '每个周期恰 1 次初始化取数（无派生/聚合式重复取低周期）').toBe(true);
    // ③ 每实例的 bar 数据流 = 自己的 period（KlineDataFeed 身份：每实例一个 feed）
    const feedPeriods = initQueries(getKline).map((q) => q.period);
    expect(new Set(feedPeriods).size, '4 个实例 ⇒ 4 个互不相同的 feed 周期').toBe(4);
    // ④ 既有实现事实：取数直接携带实例 period（不聚合）——源码锚点见 multiPeriodNoLocalAggregation.test.ts
    expect(KlineDataFeed.name, '每实例复用既有 KlineDataFeed（不新增聚合层）').toBe('KlineDataFeed');
  });
});
