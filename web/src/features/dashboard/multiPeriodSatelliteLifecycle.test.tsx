/**
 * 红测试（P2-B 补充）：**卫星生命周期与失败可见**（P2-A 未覆盖面）。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodSatelliteLifecycle.test.tsx`
 * 权威依据：`design/15-multi-period/02-spec.md` §5/§7.5/§9、`03-test-plan.md` T11/T12、
 * `04-implementation-plan.md` P2（本文件由 P2-B 的实现方落红，既有测试文件零改动）。
 *
 * 覆盖（P2-A 的 `multiPeriodSatellite.test.tsx` 只覆盖 T2/T5/T8 的静态面）：
 *  L1 **失败可见**（T12 前半）：卫星取数初始化失败 ⇒ 页面出现 `[data-mp-satellite-error="<period>"]`，
 *     且基准图不受影响（不得静默降级为只画基准）。
 *  L2 **关闭零残留**（T11 + 02-spec §7.5）：多周期开启（有卫星）⇒ 关闭 ⇒ 卫星实例完全销毁
 *     （DOM 节点消失、卫星周期 WS 订阅释放、静默窗内无新增取数/实例）。
 *  L3 **切标的不串数据**（T11 后半）：切换标的 ⇒ 各卫星按新 code/period 重建，旧 code 的卫星订阅释放。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { MAX_CONCURRENT_POLLS, resetRealtimePollGateForTest } from './realtimePoll';
import { REALTIME_POLL_LIMIT } from './feed';

// ─────────────────────────────────────────────────────────────────────────────
// klinecharts 桩：每次 init 一个新的忠实实例桩（与 P2-A 同手法：逐实例可断言）
// ─────────────────────────────────────────────────────────────────────────────

const H = vi.hoisted(() => ({ stubs: [] as any[], count: 0 }));

vi.mock('klinecharts', async () => {
  const { createChartStoreStub } = await import('@/test/chartStoreStub');
  return {
    init: vi.fn(() => {
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
        __actionHandlers: actionHandlers,
      };
      H.stubs.push(stub);
      H.count += 1;
      return stub;
    }),
    dispose: vi.fn(),
    registerIndicator: vi.fn(),
  };
});

import { init } from 'klinecharts';
import { DashboardPage } from './DashboardPage';

// ─────────────────────────────────────────────────────────────────────────────
// 假 api / 假 ws
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOLS = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
];
const VIEWPORT_BARS = 120;
const BAR = {
  ts: '2026-09-14T02:00:00Z',
  open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105,
};

/** 多周期配置：基准 15m（= 页面默认 K 线周期）+ 卫星 1h。 */
const MP_CFG = {
  enabled: true,
  periods: ['15m', '1h'],
  heights: { '15m': 420, '1h': 180 },
  indicators: ['dcap'],
};

/** 4 周期 × 1 标的（基准 1m；G3 预算护栏口径）。 */
const MP_4 = {
  enabled: true,
  periods: ['1m', '5m', '15m', '1h'],
  heights: { '1m': 420, '5m': 180, '15m': 180, '1h': 180 },
  indicators: ['dcap'],
};

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

/** 某 topic 的**活跃订阅数**（unsubscribe 后为 0；不看 Map key 残留）。 */
function activeSubs(ws: FakeWs, topic: string): number {
  return ws.handlers.get(topic)?.size ?? 0;
}

function fakeApi(opts: { failPeriods?: string[]; mp?: Record<string, unknown> } = {}) {
  const fail = new Set(opts.failPeriods ?? []);
  const getKline = vi.fn(async (q: { code: string; period: string }) => {
    if (fail.has(q.period)) throw new Error(`模拟卫星取数失败：${q.period}`);
    return [BAR];
  });
  const getMultiPeriodConfig = vi.fn(async () => opts.mp ?? MP_CFG);
  const saveMultiPeriodConfig = vi.fn(async (cfg: unknown) => cfg);
  const api = {
    ...stubApi({
      getSymbols: vi.fn(async () => SYMBOLS),
      getKline,
      getKlineConfig: vi.fn(async () => ({ viewport_bars: VIEWPORT_BARS })),
    }),
    getMultiPeriodConfig,
    saveMultiPeriodConfig,
  } as unknown as ApiClient;
  return { api, getKline, getMultiPeriodConfig, saveMultiPeriodConfig };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderEnabled(opts: Parameters<typeof fakeApi>[0] = {}) {
  const ws = fakeWs();
  const { api, getKline, getMultiPeriodConfig, saveMultiPeriodConfig } = fakeApi(opts);
  const view = render(
    <MemoryRouter>
      <DashboardPage api={api} ws={ws as unknown as WsClient} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
  await flush();
  return { ws, view, getKline, getMultiPeriodConfig, saveMultiPeriodConfig };
}

function satellites(view: { container: HTMLElement }): HTMLElement[] {
  return Array.from(view.container.querySelectorAll<HTMLElement>('[data-mp-satellite]'));
}

beforeEach(() => {
  vi.clearAllMocks();
  H.stubs.length = 0;
  H.count = 0;
  resetRealtimePollGateForTest();
});
// ─────────────────────────────────────────────────────────────────────────────
// L4 G3 预算护栏（4 周期 × 1 标的：初始化 HTTP / WS 订阅 / 每分钟兜底）
// ─────────────────────────────────────────────────────────────────────────────

describe('L4 G3 预算护栏（4 周期 × 1 标的）', () => {
  it('L4-1 初始化 HTTP=4（每周期恰 1）、WS 订阅=4（各 1 活跃）、每分钟兜底 ≤4 且并发闸 ≤3、不丢请求', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-14T02:00:00Z'));
    try {
      const { ws, getKline } = await renderEnabled({ mp: MP_4 });

      // ① 实例与初始化 HTTP：4 实例、每周期恰 1 次窗口取数（limit = viewport_bars；DCAP 未开无 warmup）
      expect(init, '4 周期 ⇒ 4 个 chart 实例（每实例一个 feed）').toHaveBeenCalledTimes(4);      const all = () =>
        getKline.mock.calls.map((c) => c[0] as { period: string; limit?: number; before?: string });
      const initQueries = all().filter((q) => q.before === undefined && q.limit === VIEWPORT_BARS);
      expect(initQueries.length, '初始化 HTTP ≤ 4（4 周期 × 1 标的）').toBeLessThanOrEqual(4);
      expect([...new Set(initQueries.map((q) => q.period))].sort()).toEqual(['15m', '1h', '1m', '5m']);
      // ② WS 订阅：4 个 (code,period) key，各恰 1 个活跃 handler（≤4）
      for (const p of ['1m', '5m', '15m', '1h']) {
        expect(activeSubs(ws, `bar:518880:${p}`), `卫星/基准周期 ${p} 必须恰 1 个活跃订阅`).toBe(1);
      }

      // ③ 每分钟兜底：挂起请求 ⇒ 观测并发闸（在途 ≤ 3，其余排队）与「不跨周期合并」
      const pending: Array<() => void> = [];
      getKline.mockImplementation(
        () =>
          new Promise((resolve) => {
            pending.push(() => resolve([{ ...BAR }]));
          }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      const polls = () => all().filter((q) => q.before === undefined && q.limit === REALTIME_POLL_LIMIT);
      const dispatch = polls();
      expect(dispatch.length, `并发闸：未 resolve 时在途兜底 ≤ ${MAX_CONCURRENT_POLLS}`).toBeLessThanOrEqual(
        MAX_CONCURRENT_POLLS,
      );
      expect(
        new Set(dispatch.map((q) => q.period)).size,
        '每 (code,period) 各自成 key（不跨周期合并）',
      ).toBe(dispatch.length);

      // ④ 释放名额 ⇒ 排队中的兜底继续发起（不丢请求；最终覆盖 4 周期且每周期 ≤1 次/分钟）
      await act(async () => {
        pending.splice(0).forEach((r) => r());
        await vi.advanceTimersByTimeAsync(0);
      });
      const after = polls();
      expect(after.length, '每分钟兜底总数 ≤ 4（4 周期 × 1 标的）').toBeLessThanOrEqual(4);
      expect([...new Set(after.map((q) => q.period))].sort()).toEqual(['15m', '1h', '1m', '5m']);
      for (const q of after) expect(q.limit).toBe(REALTIME_POLL_LIMIT);
    } finally {
      vi.useRealTimers();
    }
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// L5 单周期配置（无卫星）⇒ 与现状逐字节等价（用户裁决 A 的第 2 条）
// ─────────────────────────────────────────────────────────────────────────────

describe('L5 单周期配置（enabled=true 但无卫星）⇒ P1 等价性保持', () => {
  it('L5-1 不新增实例/订阅/取数：init=1、仅基准周期 1 个活跃订阅、getKline 恰 1 次（period=工具栏周期）', async () => {
    const single = {
      enabled: true,
      periods: ['15m'],
      heights: { '15m': 420 },
      indicators: ['dcap'],
    };
    const { ws, view, getKline } = await renderEnabled({ mp: single });

    expect(init, 'enabled=true 但无卫星 ⇒ 仍是 1 个实例（init 不得递增）').toHaveBeenCalledTimes(1);
    expect(satellites(view), '不得出现卫星节点').toEqual([]);
    expect(activeSubs(ws, 'bar:518880:15m'), '仅基准周期 1 个订阅').toBe(1);
    expect(
      Array.from(ws.handlers.keys()).filter((t) => t.startsWith('bar:')),
      '不得新增其它周期订阅',
    ).toEqual(['bar:518880:15m']);
    expect(getKline, '取数恰 1 次（不因「启用」多取）').toHaveBeenCalledTimes(1);
    expect(getKline.mock.calls[0]![0]).toMatchObject({ code: '518880', period: '15m' });

    // 静默窗：无迟到实例/取数/订阅
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(init).toHaveBeenCalledTimes(1);
    expect(getKline).toHaveBeenCalledTimes(1);
  });

  it('L5-2 有卫星且基准被配置覆盖 ⇒ 显式可观测（data-mp-base-period / source=config，禁止静默不一致）', async () => {
    const { view } = await renderEnabled({ mp: MP_4 });
    const sat = satellites(view)[0]!;
    expect(sat.getAttribute('data-mp-base-period'), '基准周期（被配置覆盖）必须可观测').toBe('1m');
    expect(sat.getAttribute('data-mp-base-period-source')).toBe('config');
    expect(view.container.querySelector('[data-mp-base-override]'), '页面必须有“基准 1m”徽标').not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 失败可见（T12 前半）
// ─────────────────────────────────────────────────────────────────────────────

describe('L1 卫星初始化失败必须可见（不得静默降级）', () => {
  it('L1-1 卫星 1h 取数失败 ⇒ 出现 [data-mp-satellite-error="1h"]；基准图仍在（未降级/未崩）', async () => {
    const { view, getKline } = await renderEnabled({ failPeriods: ['1h'] });

    await waitFor(() =>
      expect(
        view.container.querySelector('[data-mp-satellite-error]'),
        '任一卫星初始化失败必须在页面上可见报错（02-spec §9「失败可见」）',
      ).not.toBeNull(),
    );
    const err = view.container.querySelector('[data-mp-satellite-error]')!;
    expect(err.getAttribute('data-mp-satellite-error'), '报错必须标注失败的卫星周期').toBe('1h');
    expect(err.textContent ?? '', '报错文案必须能让用户定位（含周期）').toMatch(/1h/);

    // 基准图不受影响（仍是 2 个实例：基准 15m + 卫星 1h；卫星失败不得连带拆掉基准）
    expect(getKline.mock.calls.some((c) => (c[0] as { period?: string }).period === '15m')).toBe(true);
    expect(init, '失败可见而非静默降级：实例仍在（基准 + 失败卫星各 1）').toHaveBeenCalledTimes(2);
    expect(satellites(view).map((el) => el.getAttribute('data-mp-satellite'))).toEqual(['1h']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L2 关闭零残留（T11 / 02-spec §7.5）
// ─────────────────────────────────────────────────────────────────────────────

describe('L2 关闭多周期 ⇒ 卫星实例完全销毁（零残留）', () => {
  it('L2-1 关闭后：无卫星 DOM、卫星周期订阅释放、静默窗内无新增取数/实例', async () => {
    const { ws, view, getKline } = await renderEnabled();

    // 前置：卫星实例与订阅确实存在（否则本用例空洞）
    expect(satellites(view).map((el) => el.getAttribute('data-mp-satellite'))).toEqual(['1h']);
    expect(activeSubs(ws, 'bar:518880:1h'), '前置：卫星周期必须有 1 个活跃 WS 订阅').toBe(1);
    expect(init, '前置：基准 + 卫星 = 2 实例').toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole('button', { name: '多周期' }));
    await flush();
    await waitFor(() => expect(satellites(view)).toHaveLength(0));

    // ② 零残留：DOM / 订阅 / 取数 / 实例
    expect(satellites(view), '关闭后不得残留卫星节点').toEqual([]);
    expect(activeSubs(ws, 'bar:518880:1h'), '关闭后卫星周期订阅必须释放（零残留）').toBe(0);
    expect(activeSubs(ws, 'bar:518880:15m'), '基准订阅必须仍在').toBe(1);

    // ③ 静默窗：不得有迟到实例/取数
    const klineCalls = getKline.mock.calls.length;
    const initCalls = (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(getKline.mock.calls.length, '关闭后不得有迟到取数').toBe(klineCalls);
    expect(
      (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
      '关闭后不得有迟到新建实例',
    ).toBe(initCalls);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L3 切标的不串数据（T11 后半）
// ─────────────────────────────────────────────────────────────────────────────

describe('L3 切标的 ⇒ 各卫星按新 code/period 重建（不串数据）', () => {
  it('L3-1 518880 → 513310：卫星取数/订阅切到新 code，旧 code 卫星订阅释放', async () => {
    const { ws, view, getKline } = await renderEnabled();
    expect(satellites(view).map((el) => el.getAttribute('data-mp-satellite'))).toEqual(['1h']);

    await userEvent.click(screen.getByText('纳指ETF'));
    await flush();

    // ① 新 code 的卫星取数（period 必须仍是卫星自己那个 = 1h，且 code = 新标的）
    expect(
      getKline.mock.calls.some(
        (c) => (c[0] as { code?: string; period?: string }).code === '513310' &&
          (c[0] as { period?: string }).period === '1h',
      ),
      '切标的后卫星必须按 (新 code, 卫星 period) 取数',
    ).toBe(true);
    // ② 订阅切换：新 code 卫星活跃、旧 code 卫星释放（零残留）
    expect(activeSubs(ws, 'bar:513310:1h'), '新 code 的卫星订阅必须建立').toBe(1);
    expect(activeSubs(ws, 'bar:518880:1h'), '旧 code 的卫星订阅必须释放（不串数据）').toBe(0);
    // ③ 卫星节点保持（按周期一一对应，未重建为别的周期）
    expect(satellites(view).map((el) => el.getAttribute('data-mp-satellite'))).toEqual(['1h']);
  });
});
