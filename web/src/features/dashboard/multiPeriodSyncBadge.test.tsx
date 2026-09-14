/**
 * 红测试（P3-A）：**T8bis-④/⑤「对齐受限」角标（UI 标注）与降级可观测字段的端到端链路**。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodSyncBadge.test.tsx`
 * 权威依据：`design/15-multi-period/01-adr.md` §2.3、`02-spec.md` §3.2 第 5 条（**用户裁决方案 1：诚实降级 + UI 标注**）、
 * §9（可观测性）；`03-test-plan.md` T8bis；`tester/design/272_p3_sync_red_design.md`（钉死 DOM 契约）。
 *
 * 预期 red 理由：**P3 跨图同步尚未实现** ⇒ 基准缩放不会传播到卫星、不会写入降级状态、页面无角标。
 *
 * 钉死的 testability 契约（**实现方须满足；除此之外不新增任何 DOM 要求**）：
 *  1. 退化卫星的 pane 内必须渲染 `[data-mp-sync-degraded="<period>"]`（位于该卫星根 `[data-mp-satellite]` 子树内）；
 *     - 文案含「对齐受限」；
 *     - `title`（hover 原因）同时含「缩小基准」与「改选周期」两个可行动指引；
 *     - `data-mp-span-diff-min` = 最近一次对齐的跨度差（分钟，数字，> 0）⇒ 与 `syncDegraded` 一起**从页面可读**；
 *  2. 非退化（或用户缩小基准后）⇒ 该元素**不存在**（不得残留）；
 *  3. pane 宽度来源：`chart.getSize().width`（真实 klinecharts API）；jsdom 无布局 ⇒ 本文件同时把宿主
 *     `clientWidth` 打桩为 520，两种读法都必须给出同一结论（不得因 jsdom 宽度 0 而静默不判）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { makeSeries, type SyncChartStub } from '@/test/syncChartStub';
import { resetRealtimePollGateForTest } from './realtimePoll';

// ─────────────────────────────────────────────────────────────────────────────
// klinecharts 桩：每次 init 一个**同步可用**的忠实实例桩（含 bars / barSpace / 索引窗）
// ─────────────────────────────────────────────────────────────────────────────

const H = vi.hoisted(() => ({ stubs: [] as any[], initArgs: [] as any[], loaders: [] as any[] }));

vi.mock('klinecharts', async () => {
  const { createSyncChartStub } = await import('@/test/syncChartStub');
  const { createChartStoreStub } = await import('@/test/chartStoreStub');
  return {
    init: vi.fn((el: unknown, options?: any) => {
      // 卫星实例必须**在 init 时把 barSpaceLimit 放宽**（口径 9：默认 50 会静默吞掉大倍率）；
      // 基准实例不得放宽（ADR-020 严格）。本桩照 init 选项建模，未放宽 ⇒ 大 barSpace 被静默吞掉。
      const max = options?.layout?.barSpaceLimit?.max;
      const sync: any = createSyncChartStub({
        bars: [],
        paneWidthPx: 520,
        barSpace: 10,
        limit: { min: 1, max: typeof max === 'number' ? max : 50 },
      });
      // 数据装载：复刻引擎「setDataLoader/setSymbol/setPeriod 各自 resetData ⇒ 跑一次 init 取数」的行为
      const runInit = () => {
        const loader: any = sync.__loader;
        if (!loader?.getBars) return;
        void loader.getBars({
          type: 'init',
          callback: (list: Array<{ timestamp?: number; ts?: string }> = []) => {
            const ts = list
              .map((b) => (typeof b.timestamp === 'number' ? b.timestamp : Date.parse(String(b.ts))))
              .filter((n) => Number.isFinite(n))
              .sort((a, b) => a - b);
            sync.__bars.length = 0;
            sync.__bars.push(...ts);
            sync.__setRightIndex(ts.length - 1);
          },
        });
      };
      const merged: any = {
        ...createChartStoreStub(),
        overrideIndicator: vi.fn(),
        resetData: vi.fn(),
        setStyles: vi.fn(),
        resize: vi.fn(),
        setPaneOptions: vi.fn(),
        convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
        createOverlay: vi.fn(),
        removeOverlay: vi.fn(),
        ...sync, // 同步面（barSpace / 索引窗 / 事件）以忠实桩为准
        setDataLoader: vi.fn((l: unknown) => {
          H.loaders.push(l);
          sync.__loader = l;
          runInit();
        }),
        setSymbol: vi.fn(() => runInit()),
        setPeriod: vi.fn(() => runInit()),
        __sync: sync,
      };
      H.stubs.push(merged);
      H.initArgs.push(el);
      return merged;
    }),
    dispose: vi.fn(),
    registerIndicator: vi.fn(),
  };
});

import { DashboardPage } from './DashboardPage';

// ─────────────────────────────────────────────────────────────────────────────
// 合成数据（按 P0.3 实测密度比 D(1m→1h)=37.8 校准：base 间隔 = 1h / 37.8）
// ─────────────────────────────────────────────────────────────────────────────

const BASE_PERIOD = '1m';
const SAT_PERIOD = '1h';
const END_TS = Date.UTC(2026, 8, 14, 7, 0, 0);
const BASE_BARS = 400;
const SAT_BARS = 20;
const BASE_SPACING = 3_600_000 / 37.8; // 95.24s（密度校准）

const MP_CONFIG = {
  enabled: true,
  periods: [BASE_PERIOD, SAT_PERIOD],
  heights: { [BASE_PERIOD]: 420, [SAT_PERIOD]: 180 },
  indicators: ['dcap'],
};

const SYMBOLS = [{ code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 }];

function toApiBars(tsList: number[]) {
  return tsList.map((ts, i) => ({
    ts: new Date(ts).toISOString(),
    open: 1 + i * 0.001,
    high: 1.1 + i * 0.001,
    low: 0.9 + i * 0.001,
    close: 1.05 + i * 0.001,
    volume: 100,
    amount: 105,
  }));
}

function fakeApi() {
  const baseTs = makeSeries({ count: BASE_BARS, spacingMs: BASE_SPACING, endTs: END_TS });
  const satTs = makeSeries({ count: SAT_BARS, spacingMs: 3_600_000, endTs: END_TS });
  const getKline = vi.fn(async (q: { period?: string }) =>
    q.period === SAT_PERIOD ? toApiBars(satTs) : toApiBars(baseTs),
  );
  const api = {
    ...stubApi({
      getSymbols: vi.fn(async () => SYMBOLS),
      getKline,
      getKlineConfig: vi.fn(async () => ({ viewport_bars: 120 })),
      getMultiPeriodConfig: vi.fn(async () => MP_CONFIG),
    }),
  } as unknown as ApiClient;
  return { api, getKline };
}

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

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function stubIndexes(): { base: number; sat: number } {
  const sat = H.stubs.findIndex((_, i) =>
    (H.initArgs[i] as Element | undefined)?.closest?.('[data-mp-satellite]'),
  );
  const base = H.stubs.findIndex(
    (_, i) => !(H.initArgs[i] as Element | undefined)?.closest?.('[data-mp-satellite]'),
  );
  return { base, sat };
}

function asStub(i: number): SyncChartStub {
  return H.stubs[i] as unknown as SyncChartStub;
}

const CLIENT_WIDTH = 520;

describe('T8bis-④/⑤「对齐受限」角标与降级可观测字段（P3-A 红：同步尚未实现）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.stubs.length = 0;
    H.initArgs.length = 0;
    H.loaders.length = 0;
    resetRealtimePollGateForTest();
    // jsdom 无布局：把宿主宽度打桩为 520（与实测锚定 pane 宽一致）⇒ 两种宽度读法都可判定
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => CLIENT_WIDTH,
    });
  });

  afterEach(() => {
    // 还原原型（避免污染其它用例）
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  it('退化场景：基准缩放到 satBS>pane/2 ⇒ 角标出现（含原因指引 + 跨度差）；缩小基准 ⇒ 角标消失且回到正常对齐', async () => {
    const { api } = fakeApi();
    const view = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={fakeWs()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await flush();

    // 前置：基准 + 卫星各 1 个实例，且卫星已装载该周期 bar
    const { base, sat } = stubIndexes();
    expect(base, '必须恰有一个基准实例').toBeGreaterThanOrEqual(0);
    expect(sat, '必须恰有一个卫星实例').toBeGreaterThan(base);
    expect(asStub(base).__bars.length).toBe(BASE_BARS);
    expect(asStub(sat).__bars.length).toBe(SAT_BARS);
    expect(view.container.querySelector('[data-mp-sync-degraded]'), '初始（未交互）不得有角标').toBeNull();

    // 基准缩放到 8 px/bar ⇒ 推导 satBS = round(8 × 37.8) = 302 > 520/2 = 260 ⇒ 必然退化
    await act(async () => {
      asStub(base).setBarSpace(8);
    });
    await flush();

    // ① 卫星 barSpace = 能容纳 ≥2 根的最大值（260），**不得**照用推导值 302
    expect(asStub(sat).getBarSpace().bar).toBe(260);
    expect(asStub(sat).getVisibleRange().to - asStub(sat).getVisibleRange().from + 1).toBeGreaterThanOrEqual(2);

    // ② 角标出现且带原因指引 + 跨度差可读（页面可观测）
    await waitFor(() =>
      expect(
        view.container.querySelector(`[data-mp-satellite="${SAT_PERIOD}"] [data-mp-sync-degraded="${SAT_PERIOD}"]`),
        '退化时卫星 pane 必须显示「对齐受限」角标（禁止静默虚假对齐）',
      ).not.toBeNull(),
    );
    const badge = view.container.querySelector<HTMLElement>(
      `[data-mp-satellite="${SAT_PERIOD}"] [data-mp-sync-degraded="${SAT_PERIOD}"]`,
    )!;
    expect(badge.textContent).toContain('对齐受限');
    expect(badge.getAttribute('title') ?? '', 'hover/点击原因必须可行动').toContain('缩小基准');
    expect(badge.getAttribute('title') ?? '').toContain('改选周期');
    const spanDiff = Number(badge.getAttribute('data-mp-span-diff-min'));
    expect(Number.isFinite(spanDiff), 'data-mp-span-diff-min 必须是可读数字').toBe(true);
    expect(spanDiff, '跨度差必须 > 0（不得伪造 0 掩盖降级）').toBeGreaterThan(0);

    // ③ 用户缩小基准图（4 px/bar ⇒ 推导 151 ≤ 260）⇒ 角标消失、回到正常对齐
    await act(async () => {
      asStub(base).setBarSpace(4);
    });
    await flush();

    expect(asStub(sat).getBarSpace().bar).toBe(151);
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-mp-sync-degraded]'),
        '缩小基准后角标必须消失（不得残留）',
      ).toBeNull(),
    );
    expect(
      asStub(sat).getVisibleRange().to - asStub(sat).getVisibleRange().from + 1,
      '正常对齐下卫星可见 bar ≥2',
    ).toBeGreaterThanOrEqual(2);
  });

  it('反向（变异必红）：若无角标 DOM 契约，退化状态在页面上不可读 ⇒ 本用例必须失败（锁「不得静默」）', async () => {
    const { api } = fakeApi();
    const view = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={fakeWs()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await flush();

    const { base } = stubIndexes();
    await act(async () => {
      asStub(base).setBarSpace(8);
    });
    await flush();

    // 退化状态的可观测面：角标 + 跨度差（二者缺一即视为静默）
    const badge = view.container.querySelector('[data-mp-sync-degraded]');
    expect(badge, '退化状态必须可由页面读出（`syncDegraded` + 跨度差）').not.toBeNull();
    expect(badge!.getAttribute('data-mp-span-diff-min')).not.toBeNull();
  });
});
