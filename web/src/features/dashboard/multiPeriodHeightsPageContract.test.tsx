/**
 * 红测试（P5-A）：**页面级高度持久化与 ②③ 契约**（T9 的写入路径面）。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodHeightsPageContract.test.tsx`
 * 权威依据：
 *  - `design/15-multi-period/04-implementation-plan.md` P5；`03-test-plan.md` T9
 *  - `design/15-multi-period/02-spec.md` §6（拖拽 → **防抖持久化到 config**；保存 dcap / 切周期 / 切标的
 *    均**不得重置**任何实例高度）
 *  - 形态照既有 MA/dcap **乐观更新 + 失败回滚**（`DashboardPage.saveDcapParams`/`toggleMultiPeriod`）
 *  - 本文件的设计报告：`tester/design/276_p5_layout_persistence_red_design.md` §2.4
 *
 * 预期 red 理由：实现侧当前既无高度分配（`[data-mp-separator]`/`[data-mp-pane]` 不存在）、
 * 也无拖拽写路径 ⇒ 全部用例当前红。
 *
 * 硬约束（本文件全程遵守）：**0 写请求** —— api 全部为本地 stub（`saveMultiPeriodConfig` 为 vi.fn，
 * 不发网络）；不触碰线上、不跑 tangle。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { resetRealtimePollGateForTest } from './realtimePoll';
import { HEIGHT_MIN, HEIGHT_MAX } from './multiPeriodLayout';

// ─────────────────────────────────────────────────────────────────────────────
// klinecharts 桩（每次 init 返回新忠实实例；P2 同源）
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('klinecharts', async () => {
  const { createChartStoreStub } = await import('@/test/chartStoreStub');
  return {
    init: vi.fn(() => ({
      ...createChartStoreStub(),
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
      getSize: vi.fn(() => ({ width: 980, height: 600 })),
      convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
      createOverlay: vi.fn(),
      removeOverlay: vi.fn(),
      subscribeAction: vi.fn(),
      unsubscribeAction: vi.fn(),
    })),
    dispose: vi.fn(),
    registerIndicator: vi.fn(),
  };
});

import { DashboardPage } from './DashboardPage';

// ─────────────────────────────────────────────────────────────────────────────
// ResizeObserver 桩（jsdom 无布局 ⇒ 显式给主图区可用高度 600px = P2-C 实测口径）
// ─────────────────────────────────────────────────────────────────────────────

const AVAILABLE = 600;
class RoMock {
  static instances: RoMock[] = [];
  observed: Element[] = [];
  constructor(public cb: ResizeObserverCallback) {
    RoMock.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
}
/** 给所有观察者投递「主图区 600px 高」的尺寸（宽度 980 供 ADR-020 的 barSpace 路径）。 */
async function reportSize(): Promise<void> {
  const entry = { contentRect: { height: AVAILABLE, width: 980 } } as unknown as ResizeObserverEntry;
  for (const ro of RoMock.instances) {
    await act(async () => {
      ro.cb([entry], ro as unknown as ResizeObserver);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 假 api / ws（**0 写请求**：PUT 走本地 vi.fn）
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOLS = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
];
const BAR = {
  ts: '2026-09-15T02:00:00Z',
  open: 1,
  high: 1.1,
  low: 0.9,
  close: 1.05,
  volume: 100,
  amount: 105,
};
const BASE_PERIOD = '15m';
/** 卫星周期满足 P1 护栏（卫星 ≥ 基准、不含 1mo、1w 需基准 ≥1d ⇒ 本组不含 1w）。 */
const SAT0 = '1h';
const SAT1 = '1d';
const SATS = [SAT0, SAT1];
const ALL = [BASE_PERIOD, ...SATS];
/** 首屏请求高度：420 + 2×180 = 780 > 600 ⇒ 必然缩小。 */
const REQ = { [BASE_PERIOD]: 420, '1h': 180, '1d': 180 };

function fakeWs() {
  const handlers = new Map<string, Set<(m: unknown) => void>>();
  return {
    connectionStatus: 'open',
    subscribe: vi.fn((topic: string, h: (m: unknown) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    onStatusChange: () => () => {},
  } as unknown as WsClient;
}

interface Ctx {
  api: ApiClient;
  saveMultiPeriodConfig: ReturnType<typeof vi.fn>;
  saveDcapConfig: ReturnType<typeof vi.fn>;
  view: ReturnType<typeof render>;
}

/** MP 配置（mock 服务端态；保存成功后更新 ⇒ 供「刷新/重进」用例读取）。
 *
 *  **必须模块级 + `beforeEach` 重置**（P5-D-1 夹具缺陷修复，2026-09-15；架构裁定 = 夹具缺陷、非产品缺陷）：
 *  C4 在被测调用 `unmount()` 后重新 `setup()`，而 `setup()` 内部每次都新建 `makeCtx()`。若 `serverState`
 *  是 `makeCtx` 的局部量，重进拿到的是**新建的初始态** ⇒ 重进 `GET` 回的是拖前高度（实测重进 15m=324
 *  vs `saved`=344，差值恰为拖拽量 20），与 C4 注释声明的「同一 serverState」自相矛盾。
 *  因此本用例组把服务端态提到模块级：同一次用例内的「刷新/重进」复用同一份态，跨用例由 `beforeEach` 隔离。
 *  **只改夹具：不改产品代码、不删任何断言。** */
let serverState: Record<string, unknown> = {};

/** 重置 mock 服务端态（初始配置 = `REQ`）。 */
function resetServerState(): void {
  serverState = {
    enabled: true,
    periods: [...ALL],
    heights: { ...REQ },
    indicators: ['dcap'],
  };
}

function makeCtx(opts: { onSave?: (cfg: unknown) => Promise<unknown> } = {}): Ctx {
  const saveMultiPeriodConfig = vi.fn(async (cfg: unknown) => {
    const out = opts.onSave ? await opts.onSave(cfg) : cfg;
    Object.assign(serverState, out as Record<string, unknown>);
    return serverState;
  });
  const saveDcapConfig = vi.fn(async (cfg: unknown) => cfg);
  const overrides = {
    getSymbols: vi.fn(async () => SYMBOLS),
    getKline: vi.fn(async () => [BAR]),
    getKlineConfig: vi.fn(async () => ({ viewport_bars: 120 })),
    getMultiPeriodConfig: vi.fn(async () => ({ ...serverState })),
    saveMultiPeriodConfig,
    saveDcapConfig,
  } as unknown as Partial<ApiClient>;
  const api = stubApi(overrides);
  return { api, saveMultiPeriodConfig, saveDcapConfig, view: null as never };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function setup(opts: { onSave?: (cfg: unknown) => Promise<unknown> } = {}): Promise<Ctx> {
  const ctx = makeCtx(opts);
  const ws = fakeWs();
  const view = render(
    <MemoryRouter>
      <DashboardPage api={ctx.api} ws={ws} />
    </MemoryRouter>,
  );
  ctx.view = view;
  await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
  await flush();
  await reportSize(); // 主图区可用高度 600px 就绪
  await flush();
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// 读数/操作辅助（与 DOM 契约测试同源口径）
// ─────────────────────────────────────────────────────────────────────────────

function paneEl(root: HTMLElement, period: string, isBase: boolean): HTMLElement {
  const direct = root.querySelector<HTMLElement>(`[data-mp-pane="${period}"]`);
  if (direct) return direct;
  if (!isBase) {
    const sat = root.querySelector<HTMLElement>(`[data-mp-satellite="${period}"]`);
    if (sat) return sat;
  }
  throw new Error(`缺少 pane ${period}`);
}

function heights(root: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ALL) {
    const el = paneEl(root, p, p === BASE_PERIOD);
    const attr = el.getAttribute('data-mp-pane-height');
    out[p] = attr !== null ? Number(attr) : Math.round(Number.parseFloat(el.style.height));
  }
  return out;
}

function separator(root: HTMLElement, upper: string, lower: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-mp-separator="${upper}|${lower}"]`);
  if (!el) throw new Error(`缺少分隔条 ${upper}|${lower}`);
  return el;
}

/** 鼠标拖拽 + 等防抖窗（300ms；用真实计时器 ⇒ 不干扰页面其它异步链路）。 */
async function dragBy(sep: HTMLElement, deltaY: number): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(sep, { clientY: 300, button: 0 });
    fireEvent.mouseMove(window, { clientY: 300 + deltaY, buttons: 1 });
    fireEvent.mouseUp(window, { clientY: 300 + deltaY });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 450)); // ≥ DRAG_DEBOUNCE_MS(300)
  });
  await flush(2);
}

/**
 * **配置面校验的本地镜像**（`crates/web/src/dto.rs::validate_multi_period_config` 第 5 条）：
 * `heights` 键与 `periods` 一一对应，且每值 ∈ `[HEIGHT_MIN, HEIGHT_MAX]`（= `[80,1200]`）。
 * 用于断言「据此构造的 `PUT` body 合法（不会 400 回滚）」——纯本地函数，**0 写请求**。
 * 域上下界从 `multiPeriodLayout` 导入（单一事实源；不得在本文件硬编码数字）。
 */
function configDomainErrors(body: { periods?: string[]; heights?: Record<string, number> }): string[] {
  const errs: string[] = [];
  const periods = body.periods ?? [];
  const hs = body.heights ?? {};
  if (Object.keys(hs).length !== periods.length || !periods.every((p) => p in hs)) {
    errs.push(`heights 键必须与 periods 一一对应：periods=${JSON.stringify(periods)} heights键=${JSON.stringify(Object.keys(hs))}`);
  }
  for (const [k, v] of Object.entries(hs)) {
    if (!Number.isInteger(v) || v < HEIGHT_MIN || v > HEIGHT_MAX) {
      errs.push(`heights[${k}] 须 ∈ [${HEIGHT_MIN},${HEIGHT_MAX}]，收到 ${v}`);
    }
  }
  return errs;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetServerState(); // 夹具修复：跨用例隔离；用例内多次 `setup()` 共用同一份服务端态
  RoMock.instances = [];
  vi.stubGlobal('ResizeObserver', RoMock);
  resetRealtimePollGateForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('页面级高度拖拽与持久化（P5-A 红）', () => {
  it('C1 拖拽 ⇒ 防抖后恰 1 次 PUT /api/config/multi_period，且 periods/indicators/enabled 原样不重置', async () => {
    const ctx = await setup();
    const before = heights(ctx.view.container);
    expect(Object.values(before).reduce((a, b) => a + b, 0), '首屏必须恰好填满 600').toBe(AVAILABLE);

    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), 20);
    const after = heights(ctx.view.container);

    expect(ctx.saveMultiPeriodConfig, '拖拽必须防抖持久化（恰 1 次）').toHaveBeenCalledTimes(1);
    const body = ctx.saveMultiPeriodConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.heights).toEqual(after);
    expect(body.periods, '切周期列表不得被重置').toEqual([...ALL]);
    expect(body.indicators, '指标集合不得被重置').toEqual(['dcap']);
    expect(body.enabled, '开关不得被重置').toBe(true);
    expect(after[BASE_PERIOD]!).toBe(before[BASE_PERIOD]! + 20);
    expect(after[SAT0]!).toBe(before[SAT0]! - 20);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(AVAILABLE);
  });

  it('C2 乐观更新：PUT 未 resolve 时 DOM 已是拖后高度', async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => {
      release = r;
    });
    const ctx = await setup({ onSave: () => pending });
    const before = heights(ctx.view.container);

    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), 20);
    const optimistic = heights(ctx.view.container);

    expect(ctx.saveMultiPeriodConfig).toHaveBeenCalledTimes(1);
    expect(optimistic[BASE_PERIOD], '乐观：写请求在途时 DOM 即为拖后高度').toBe(
      before[BASE_PERIOD]! + 20,
    );

    await act(async () => {
      release({ enabled: true, periods: [...ALL], heights: { ...optimistic }, indicators: ['dcap'] });
      await Promise.resolve();
    });
    await flush(2);
    expect(heights(ctx.view.container)[BASE_PERIOD]!).toBe(before[BASE_PERIOD]! + 20);
  });

  it('C3 失败回滚：PUT 拒绝 ⇒ 高度回到拖前值（±1px）、无 unhandled rejection', async () => {
    const ctx = await setup({
      onSave: () => Promise.reject(new Error('服务端拒绝（模拟）')),
    });
    const before = heights(ctx.view.container);

    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), 20);
    await flush(3);
    const after = heights(ctx.view.container);

    for (const p of ALL) {
      expect(Math.abs(after[p]! - before[p]!), `${p} 必须回滚`).toBeLessThanOrEqual(1);
    }
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(AVAILABLE);
  });

  it('C4 刷新/重进后保持：拖拽持久化成功 ⇒ 重新挂载（GET 回显新 heights）⇒ 高度不变（±1px）', async () => {
    const ctx = await setup();
    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), 20);
    const saved = heights(ctx.view.container);
    expect(ctx.saveMultiPeriodConfig).toHaveBeenCalledTimes(1);

    // 刷新/重进（同一 serverState ⇒ GET 返回拖后 heights）
    act(() => ctx.view.unmount());
    await flush(1);
    const reopened = await setup();
    const restored = heights(reopened.view.container);
    for (const p of ALL) {
      expect(Math.abs(restored[p]! - saved[p]!), `${p} 重进后必须保持`).toBeLessThanOrEqual(1);
    }
  });

  it('C5 ②③ 切标的 ⇒ 各 pane 高度不变（±1px）且不写多周期配置', async () => {
    const ctx = await setup();
    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), 20);
    const after = heights(ctx.view.container);
    ctx.saveMultiPeriodConfig.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByText('纳指ETF'));
    });
    await flush(3);

    const now = heights(ctx.view.container);
    for (const p of ALL) expect(Math.abs(now[p]! - after[p]!), `${p} 不得被重置`).toBeLessThanOrEqual(1);
    expect(ctx.saveMultiPeriodConfig, '切标的不得写多周期配置').not.toHaveBeenCalled();
  });

  it('C6 ②③ 切周期 ⇒ 各 pane 高度不变（±1px）', async () => {
    const ctx = await setup();
    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), 20);
    const after = heights(ctx.view.container);
    ctx.saveMultiPeriodConfig.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1h' }));
    });
    await flush(3);

    const now = heights(ctx.view.container);
    for (const p of ALL) expect(Math.abs(now[p]! - after[p]!), `${p} 不得被重置`).toBeLessThanOrEqual(1);
    expect(ctx.saveMultiPeriodConfig).not.toHaveBeenCalled();
  });

  it('C7 ②③ 保存 dcap 参数 ⇒ 各 pane 高度不变（±1px）且不写多周期配置', async () => {
    const ctx = await setup();
    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), 20);
    const after = heights(ctx.view.container);
    ctx.saveMultiPeriodConfig.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'DCAP 配置' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    await flush(3);

    expect(ctx.saveDcapConfig, 'dcap 保存路径必须被走到（否则本用例是空断言）').toHaveBeenCalled();
    const now = heights(ctx.view.container);
    for (const p of ALL) expect(Math.abs(now[p]! - after[p]!), `${p} 不得被重置`).toBeLessThanOrEqual(1);
    expect(ctx.saveMultiPeriodConfig).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // P5-D-1（红）：**期望 px 必须始终夹在配置域 `[80,1200]`**（02-spec §6.1 尾注，架构裁决 2026-09-15）
  //
  // 契约：拖拽只允许把**期望值**改写进**配置面校验域** `[80,1200]`；而**分配下界**（基准 200 /
  // 卫星 80）是**渲染侧**夹取 —— 两者不得混同。若不夹配置域，拖到域外的期望值会被写进
  // `PUT /api/config/multi_period` ⇒ 服务端 400 ⇒ 回滚（用户表现为「拖了但没保存」；实测可拖到 42px）。
  //
  // 预期 red 理由（当前实现）：`sanitizeDragHeight` 只夹**上界**（`Math.min(HEIGHT_MAX, …)`）
  // 不夹下界（80）⇒ 狠拖下界后 `onHeightsChange` 载荷（= PUT `heights`）出现 <80 的值 ⇒ C8/C9 红。
  // 反向（去掉夹取 ⇒ 必红）已由本组两用例正向钉死；实现侧本轮**零改动**（红测试先落）。
  // ───────────────────────────────────────────────────────────────────────────

  it('C8 拖拽期望值必须夹在配置域 [80,1200]：狠拖下界（期望 <80）也不得产出域外 PUT body', async () => {
    const ctx = await setup();
    const before = heights(ctx.view.container);
    // 前置：向上狠拖 250px ⇒ 期望 = 拖前分配高度 − 250 必须**低于**配置域下界（否则本用例不是域外用例）
    expect(
      before[BASE_PERIOD]! - 250,
      '前置：该拖拽必须把基准期望值推到配置域下界之下',
    ).toBeLessThan(HEIGHT_MIN);

    await dragBy(separator(ctx.view.container, BASE_PERIOD, SAT0), -250);

    expect(ctx.saveMultiPeriodConfig, '拖拽必须恰 1 次持久化').toHaveBeenCalledTimes(1);
    const body = ctx.saveMultiPeriodConfig.mock.calls[0]![0] as {
      periods: string[];
      heights: Record<string, number>;
    };

    // 载荷键集合必须 = periods（否则配置面第 5 条校验直接拒）
    expect(Object.keys(body.heights).sort()).toEqual([...ALL].sort());
    // 核心判据：**每一项** 都 ∈ 配置域 [80,1200]（整数 px）
    for (const p of ALL) {
      const v = body.heights[p];
      expect(Number.isInteger(v), `${p} 必须为整数 px，收到 ${v}`).toBe(true);
      expect(v, `${p} 必须 ≥ ${HEIGHT_MIN}（配置域下界），收到 ${v}`).toBeGreaterThanOrEqual(HEIGHT_MIN);
      expect(v, `${p} 必须 ≤ ${HEIGHT_MAX}（配置域上界），收到 ${v}`).toBeLessThanOrEqual(HEIGHT_MAX);
    }
    expect(configDomainErrors(body), 'PUT body 必须通过配置面校验（否则 400 + 回滚）').toEqual([]);
  });

  it('C9 拖拽域外值 ⇒ 镜像配置面校验的 stub 会 400 ⇒ 用户可见「拖了但没保存」', async () => {
    const rejections: string[] = [];
    const ctx = await setup({
      onSave: (cfg) => {
        const errs = configDomainErrors(cfg as { periods?: string[]; heights?: Record<string, number> });
        if (errs.length) {
          rejections.push(errs.join('; '));
          return Promise.reject(new Error(`400（模拟配置面校验）：${errs.join('; ')}`));
        }
        return Promise.resolve(cfg);
      },
    });
    const before = heights(ctx.view.container);
    // 前置：卫星 1h 向上狠拖 100px ⇒ 期望低于配置域下界（同一窗口内互补重分配）
    expect(before[SAT0]! - 100, '前置：该拖拽必须把卫星期望值推到配置域下界之下').toBeLessThan(
      HEIGHT_MIN,
    );

    await dragBy(separator(ctx.view.container, SAT0, SAT1), -100);
    await flush(3);

    expect(
      rejections,
      '拖拽产出域外 heights ⇒ 服务端 400（根因：期望值未夹配置域；用户表现为「拖了但没保存」）',
    ).toEqual([]);
    const now = heights(ctx.view.container);
    expect(now[SAT0]!, '拖后结果必须被服务端接受（不得回滚到拖前）').toBeLessThan(before[SAT0]!);
    expect(Object.values(now).reduce((a, b) => a + b, 0), '分配面仍须恰好填满').toBe(AVAILABLE);
  });
});
