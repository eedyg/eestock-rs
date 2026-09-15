/**
 * 红测试（P5.5-A）：**两步周期选择器**（先选 K 线周期 → 再选指标周期）。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodPicker.test.tsx`
 * 设计报告（接口契约的权威定义）：`tester/design/283_p5.5_period_picker_red_design.md`
 * 权威依据：
 *  - `design/15-multi-period/01-adr.md` §2.5（两步选择规则、1w 条件、1mo 不提供、最多 3 指标周期）；
 *  - `design/15-multi-period/02-spec.md` §1（`MultiPeriodPeriodPicker` 新组件）、§2/§2.1（配置契约 +
 *    **选择器必须同时写 `periods[0]` 与 `state.period` 以消除「基准被配置覆盖」的可观测不一致**）、
 *    §7（护栏：仅单图、总周期 ≤4、卫星 ≥ 基准、含 1w 须基准 ≥1d、总 pane ≤12 且**明确报错不静默截断**）、
 *    §6（高度分配/持久化契约）。
 *
 * 预期 red 理由：模块 `./multiPeriodPicker` **尚不存在**（解析失败）⇒ 全部用例红。
 * 实现方落地后本文件应转绿，且**不得改动断言口径**（口径由本文件 + 设计报告 §2 钉死）。
 *
 * 明确不做（范围外）：不改 dcap 口径、不动 P4（LIVE 虚线段）、不改 tangle 生成物、
 * 不测真实渲染像素（G4 属独立验收阶段）。
 *
 * 硬约束（全程遵守）：**0 写请求/0 出网** —— api 全部为本地 stub（`saveMultiPeriodConfig` = vi.fn 或
 * 真实 mock client 的内存实现）；不触碰线上进程/配置；不跑 tangle。
 *
 * ── 被测模块契约（实现方必须导出，见设计报告 §2）────────────────────────────────
 *  `multiPeriodPicker.tsx`：
 *   - `MULTI_PERIOD_PICKER_PERIODS: Period[]`      步骤 1 全集（全部周期 \ {`1mo`}）
 *   - `MAX_INDICATOR_PERIODS = 3`                  指标周期上限（总周期 ≤4）
 *   - `indicatorPeriodOptions(base): {period, enabled, reason}[]`  步骤 2 候选（= {P ≥ base} \ {1mo}；
 *      1w 在 base < 1d 时出现但 enabled=false 且 reason 非空；base ≥ 1d 时 enabled=true）
 *   - `multiPeriodPaneCount(periods, indicators)`  总 pane 数（**去重后** indicators 计数）
 *   - `validatePickerSelection({base, indicatorPeriods, indicators})` ⇒ `{ok, issues:[{dimension,message}]}`
 *   - `heightsForSelection({base, indicatorPeriods}, prevHeights)`  键随周期增删（默认基准 420 / 卫星 180）
 *   - `MultiPeriodPeriodPicker`（组件，DOM 契约见设计报告 §2.3）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { ApiError } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { createMockClient } from '@/api/mock';
import { resetRealtimePollGateForTest } from './realtimePoll';

// ─────────────────────────────────────────────────────────────────────────────
// klinecharts 桩（jsdom 无 canvas；页面级用例用。行为面由 chartStoreStub 忠实模拟）
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
// 模块装载（变量 specifier：红阶段模块缺失 ⇒ **逐用例** red，且不阻塞 `tsc -b` 静态解析）
// ─────────────────────────────────────────────────────────────────────────────

const PICKER_SPECIFIER: string = './multiPeriodPicker';

interface PeriodOption {
  period: string;
  enabled: boolean;
  reason: string | null;
}
interface PickerIssue {
  dimension: string;
  message: string;
}
interface PickerModule {
  MULTI_PERIOD_PICKER_PERIODS: string[];
  MAX_INDICATOR_PERIODS: number;
  indicatorPeriodOptions(base: string): PeriodOption[];
  multiPeriodPaneCount(periods: readonly string[], indicators: readonly string[]): number;
  validatePickerSelection(input: {
    base: string;
    indicatorPeriods: readonly string[];
    indicators: readonly string[];
  }): { ok: boolean; issues: PickerIssue[] };
  heightsForSelection(
    sel: { base: string; indicatorPeriods: readonly string[] },
    prevHeights: Record<string, number>,
  ): Record<string, number>;
  MultiPeriodPeriodPicker: React.ComponentType<Record<string, unknown>>;
}

async function loadPicker(): Promise<PickerModule> {
  return (await import(/* @vite-ignore */ PICKER_SPECIFIER)) as unknown as PickerModule;
}

async function renderPicker(props: Record<string, unknown> = {}) {
  const mod = await loadPicker();
  expect(
    typeof mod.MultiPeriodPeriodPicker,
    '模块必须导出组件 MultiPeriodPeriodPicker（02-spec §1）',
  ).toBe('function');
  const view = render(
    <mod.MultiPeriodPeriodPicker
      basePeriod="15m"
      indicatorPeriods={[]}
      indicators={['dcap']}
      onConfirm={() => {}}
      {...props}
    />,
  );
  return { ...view, mod };
}

/** 选择器内可选/被禁的候选（DOM 契约：`button[data-mp-indicator-period]`）。 */
function indicatorButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('[data-mp-indicator-period]'));
}
function option(root: HTMLElement, period: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-mp-indicator-period="${period}"]`);
}
function optionReason(root: HTMLElement, period: string): string {
  return (root.querySelector(`[data-mp-indicator-reason="${period}"]`)?.textContent ?? '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 纯函数：步骤收窄 + 护栏（02-spec §2.1/§7、ADR-022 §2.5）
// ─────────────────────────────────────────────────────────────────────────────

describe('A. 两步选择器的纯函数契约（步骤收窄 + 护栏）', () => {
  it('A1 步骤 1 全集 = 全部周期 \\ {1mo}（顺序 1m/5m/15m/1h/1d/1w）', async () => {
    const m = await loadPicker();
    expect(m.MULTI_PERIOD_PICKER_PERIODS).toEqual(['1m', '5m', '15m', '1h', '1d', '1w']);
    expect(m.MULTI_PERIOD_PICKER_PERIODS, '1mo 不得出现在步骤 1（ADR-022 §2.5 用户裁决）').not.toContain(
      '1mo',
    );
  });

  it('A2 步骤 2 候选自动收窄为 {P ≥ 步骤1} \\ {1mo}：base=1d ⇒ {1d,1w}；小于基准的一律不出现', async () => {
    const m = await loadPicker();
    const opts = m.indicatorPeriodOptions('1d');
    expect(
      opts.filter((o) => o.enabled).map((o) => o.period),
      'base=1d ⇒ 候选 = {1d,1w}（允许相等；不含 1mo）',
    ).toEqual(['1d', '1w']);
    expect(opts.map((o) => o.period), '小于基准的周期不得出现').not.toContain('1h');
    expect(opts.map((o) => o.period)).not.toContain('5m');

    const m15 = m.indicatorPeriodOptions('15m');
    expect(
      m15.filter((o) => o.enabled).map((o) => o.period),
      'base=15m ⇒ 候选 = {15m,1h,1d}（1w 因基准 <1d 被禁）',
    ).toEqual(['15m', '1h', '1d']);
  });

  it('A3 1w 护栏：base ≥1d ⇒ 可选；base <1d ⇒ 出现但不可选且给出原因（不得静默消失）；base=1w ⇒ 仅自身', async () => {
    const m = await loadPicker();
    const oneW = (base: string) => m.indicatorPeriodOptions(base).find((o) => o.period === '1w');

    expect(oneW('1d'), 'base=1d ⇒ 1w 必须可选（ADR-022 §2.5）').toMatchObject({ enabled: true });
    expect(oneW('1w'), 'base=1w ⇒ 仅自身可选').toMatchObject({ enabled: true });

    const blocked = oneW('5m');
    expect(blocked, 'base <1d ⇒ 1w 仍须出现（用户要能看到原因，而非静默消失）').toBeTruthy();
    expect(blocked!.enabled, 'base=5m (<1d) ⇒ 1w 不可选').toBe(false);
    expect(blocked!.reason ?? '', '不可选必须给出原因文本').not.toBe('');
  });

  it('A4 最多 3 个指标周期（总周期 ≤4）：第 4 个 ⇒ 校验拒绝且错误含维度名 periods', async () => {
    const m = await loadPicker();
    expect(m.MAX_INDICATOR_PERIODS, '指标周期上限 = 3（ADR-022 §2 口径 2）').toBe(3);
    const ok = m.validatePickerSelection({
      base: '1m',
      indicatorPeriods: ['5m', '15m', '1h'],
      indicators: ['dcap'],
    });
    expect(ok.ok, '3 个指标周期 + 1 基准 = 4 总周期 ⇒ 合法').toBe(true);

    const bad = m.validatePickerSelection({
      base: '1m',
      indicatorPeriods: ['5m', '15m', '1h', '1d'],
      indicators: ['dcap'],
    });
    expect(bad.ok, '4 个指标周期 ⇒ 必须拒绝（总周期 ≤4）').toBe(false);
    expect(bad.issues.map((i) => i.dimension)).toContain('periods');
    expect(bad.issues.every((i) => i.message.trim() !== ''), '拒绝必须带可读原因').toBe(true);
  });

  it('A5 总 pane 预算 ≤12：计数基于**去重后** indicators；越限 ⇒ 拒绝且错误含被拒维度名（不静默截断）', async () => {
    const m = await loadPicker();
    expect(
      m.multiPeriodPaneCount(['1m', '5m', '15m', '1h'], ['dcap', 'dcap', 'dcap', 'dcap']),
      '去重口径：4 周期 × 1 指标 ⇒ 1 + 3×1 = 4 pane（§7.4）',
    ).toBe(4);
    expect(
      m.multiPeriodPaneCount(['1m', '5m', '15m', '1h'], ['dcap', 'macd', 'kdj', 'boll']),
      '去重后 4 指标 × 3 卫星 + 1 基准 = 13 > 12',
    ).toBe(13);

    const bad = m.validatePickerSelection({
      base: '1m',
      indicatorPeriods: ['5m', '15m', '1h'],
      indicators: ['dcap', 'macd', 'kdj', 'boll'],
    });
    expect(bad.ok, '总 pane >12 ⇒ 必须拒绝保存').toBe(false);
    const dims = bad.issues.map((i) => i.dimension);
    expect(
      dims.some((d) => d === 'pane' || d === 'indicators'),
      '错误必须包含被拒维度名（indicators/pane；§7.4）',
    ).toBe(true);
    expect(bad.issues.map((i) => i.message).join(' | '), '错误信息须可定位被拒维度').toMatch(
      /pane|indicators/i,
    );
  });

  it('A6 非法组合（卫星 < 基准 / 含 1mo / 含 1w 且基准 <1d）⇒ 校验拒绝且含维度名 periods', async () => {
    const m = await loadPicker();
    const cases: Array<{ base: string; indicatorPeriods: string[]; why: string }> = [
      { base: '1d', indicatorPeriods: ['1h'], why: '卫星 < 基准' },
      { base: '1m', indicatorPeriods: ['1mo'], why: '含 1mo' },
      { base: '1m', indicatorPeriods: ['1w'], why: '含 1w 但基准 <1d' },
    ];
    for (const c of cases) {
      const out = m.validatePickerSelection({
        base: c.base,
        indicatorPeriods: c.indicatorPeriods,
        indicators: ['dcap'],
      });
      expect(out.ok, `${c.why} ⇒ 必须拒绝`).toBe(false);
      expect(out.issues.map((i) => i.dimension), `${c.why} ⇒ 维度名须为 periods`).toContain('periods');
    }
  });

  it('A7 heights 键随周期增删（新增用默认 420/180；保留既有值；移除不留残键）', async () => {
    const m = await loadPicker();
    const added = m.heightsForSelection({ base: '15m', indicatorPeriods: ['1h', '1d'] }, { '15m': 300, '1h': 150 });
    expect(added, '新增 1d ⇒ 卫星默认 180；既有 1h 的 150 必须保留').toEqual({
      '15m': 300,
      '1h': 150,
      '1d': 180,
    });

    const removed = m.heightsForSelection(
      { base: '15m', indicatorPeriods: ['1h'] },
      { '15m': 300, '1h': 150, '1d': 180 },
    );
    expect(Object.keys(removed).sort(), '移除周期 ⇒ 键必须删除（零残键）').toEqual(['15m', '1h']);

    const fresh = m.heightsForSelection({ base: '1m', indicatorPeriods: ['5m'] }, {});
    expect(fresh, '空历史 ⇒ 基准 420 / 卫星 180（02-spec §6 默认）').toEqual({ '1m': 420, '5m': 180 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 组件两步流程（jsdom 渲染：步骤 1 → 步骤 2 候选收窄 / 1w 原因 / 至多 3 / 载荷）
// ─────────────────────────────────────────────────────────────────────────────

describe('B. 两步选择器组件（步骤 1 ⇒ 步骤 2 候选收窄）', () => {
  it('B1 步骤 1 渲染全集（无 1mo）；点 1d ⇒ 步骤 2 候选收窄为 {1d,1w}（5m 不出现）', async () => {
    const { container } = await renderPicker({ basePeriod: '1m' });
    const step1 = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-mp-base-period]'));
    expect(
      step1.map((b) => b.getAttribute('data-mp-base-period')),
      '步骤 1 必须是全部周期 \\ {1mo}',
    ).toEqual(['1m', '5m', '15m', '1h', '1d', '1w']);

    await userEvent.click(container.querySelector('[data-mp-base-period="1d"]')!);
    expect(
      indicatorButtons(container).map((b) => b.getAttribute('data-mp-indicator-period')),
      '步骤 2 候选随步骤 1 自动收窄（{P ≥ 1d}）',
    ).toEqual(['1d', '1w']);
    expect(option(container, '5m'), '小于基准的周期不得残留').toBeNull();
  });

  it('B2 base=5m（<1d）⇒ 1w 出现在步骤 2 但禁用，且原因可读（不得静默隐藏）', async () => {
    const { container } = await renderPicker({ basePeriod: '1m' });
    await userEvent.click(container.querySelector('[data-mp-base-period="5m"]')!);

    const w = option(container, '1w');
    expect(w, '1w 必须在步骤 2 出现（用户要能看到为何不可选）').not.toBeNull();
    expect(w!.disabled, 'base=5m <1d ⇒ 1w 不可选').toBe(true);
    expect(optionReason(container, '1w'), '不可选必须给出原因文本').not.toBe('');
    expect(option(container, '1m'), '小于基准的 1m 不得出现').toBeNull();
  });

  it('B3 指标周期至多 3 个：选满 3 后第 4 个候选禁用并给出原因；确认载荷恰 3 个卫星', async () => {
    const onConfirm = vi.fn();
    const { container } = await renderPicker({ basePeriod: '1m', onConfirm });
    for (const p of ['1m', '5m', '15m']) {
      await userEvent.click(option(container, p)!);
    }
    const fourth = option(container, '1h');
    expect(fourth, '1h 仍是候选（≥ 基准）').not.toBeNull();
    expect(fourth!.disabled, '已达上限 3 ⇒ 第 4 个不可选（不得静默截断）').toBe(true);
    expect(optionReason(container, '1h'), '达上限必须给出原因').not.toBe('');

    await userEvent.click(screen.getByTestId('mp-picker-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const sel = onConfirm.mock.calls[0]![0] as { basePeriod: string; indicatorPeriods: string[] };
    expect(sel.indicatorPeriods, '载荷卫星数必须 ≤3').toHaveLength(3);
  });

  it('B4 确认载荷 = {basePeriod, 按秩升序的指标周期集合}（选中顺序不影响规范序）', async () => {
    const onConfirm = vi.fn();
    const { container } = await renderPicker({ basePeriod: '1m', onConfirm });
    await userEvent.click(container.querySelector('[data-mp-base-period="15m"]')!);
    await userEvent.click(option(container, '1d')!); // 先选大周期
    await userEvent.click(option(container, '1h')!);

    await userEvent.click(screen.getByTestId('mp-picker-confirm'));
    const sel = onConfirm.mock.calls[0]![0] as { basePeriod: string; indicatorPeriods: string[] };
    expect(sel.basePeriod).toBe('15m');
    expect(sel.indicatorPeriods, '规范序 = 周期秩升序').toEqual(['1h', '1d']);
  });

  it('B5 服务端 400（onConfirm 失败）⇒ 选择器可见报错且保留选择（不静默关闭、不截断）', async () => {
    // 「服务端」= 真实 mock client（与后端 `validate_multi_period_config` 同构）：非法组合必然 400。
    const server = createMockClient();
    const onConfirm = vi.fn(async () => {
      // 绕过 UI 的非法组合（模拟旧数据/被篡改的提交）：卫星 < 基准 ⇒ 服务端 400
      await server.saveMultiPeriodConfig({
        enabled: true,
        periods: ['1d', '1h'],
        heights: { '1d': 420, '1h': 180 },
        indicators: ['dcap'],
      });
    });
    const { container } = await renderPicker({ basePeriod: '1m', onConfirm });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="mp-picker-confirm"]')!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const err = container.querySelector(
      '[data-testid="mp-picker-error"], [data-mp-picker-error], [data-mp-error]',
    );
    expect(err, '服务端 400 必须可见（不得静默吞掉）').not.toBeNull();
    expect((err!.textContent ?? '').trim(), '报错文案不得为空').not.toBe('');
    expect(
      container.querySelector('[data-testid="mp-picker"]') ?? container.querySelector('[data-mp-picker]'),
      '失败后选择器必须保留（可选重试），不得静默关闭',
    ).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 页面级：提交语义 / 失败回滚 / 开关与模式 / 零残留 / heights 兼容
// ─────────────────────────────────────────────────────────────────────────────

// ── ResizeObserver 桩（jsdom 无布局 ⇒ 主图区可用高度 600px，P5 口径）───────────────
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
async function reportSize(): Promise<void> {
  const entry = { contentRect: { height: AVAILABLE, width: 980 } } as unknown as ResizeObserverEntry;
  for (const ro of RoMock.instances) {
    await act(async () => {
      ro.cb([entry], ro as unknown as ResizeObserver);
    });
  }
}

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

type WsHandler = (msg: unknown) => void;
interface FakeWs {
  handlers: Map<string, Set<WsHandler>>;
  subscribe: ReturnType<typeof vi.fn>;
}
function fakeWs(): FakeWs {
  const handlers = new Map<string, Set<WsHandler>>();
  return {
    handlers,
    subscribe: vi.fn((topic: string, h: WsHandler) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
  } as unknown as FakeWs;
}
const activeSubs = (ws: FakeWs, topic: string): number => ws.handlers.get(topic)?.size ?? 0;
const barTopics = (ws: FakeWs): string[] =>
  Array.from(ws.handlers.keys())
    .filter((t) => t.startsWith('bar:') && (ws.handlers.get(t)?.size ?? 0) > 0)
    .sort();

let serverState: Record<string, unknown> = {};
function setServerConfig(cfg: Record<string, unknown>): void {
  serverState = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
}

interface Ctx {
  api: ApiClient;
  ws: FakeWs;
  getKline: ReturnType<typeof vi.fn>;
  saveMultiPeriodConfig: ReturnType<typeof vi.fn>;
  view: ReturnType<typeof render>;
}

function makeCtx(opts: { onSave?: (cfg: unknown) => Promise<unknown> } = {}): Ctx {
  const saveMultiPeriodConfig = vi.fn(async (cfg: unknown) => {
    const out = opts.onSave ? await opts.onSave(cfg) : cfg;
    Object.assign(serverState, out as Record<string, unknown>);
    return serverState;
  });
  const getKline = vi.fn(async () => [BAR]);
  const overrides = {
    getSymbols: vi.fn(async () => SYMBOLS),
    getKline,
    getKlineConfig: vi.fn(async () => ({ viewport_bars: 120 })),
    getMultiPeriodConfig: vi.fn(async () => ({ ...serverState })),
    saveMultiPeriodConfig,
  } as unknown as Partial<ApiClient>;
  const api = stubApi(overrides);
  return { api, ws: fakeWs(), getKline, saveMultiPeriodConfig, view: null as never };
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
  const view = render(
    <MemoryRouter>
      <DashboardPage api={ctx.api} ws={ctx.ws as unknown as WsClient} />
    </MemoryRouter>,
  );
  ctx.view = view;
  await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
  await flush();
  await reportSize();
  await flush();
  return ctx;
}

function satellites(ctx: Ctx): string[] {
  return Array.from(ctx.view.container.querySelectorAll<HTMLElement>('[data-mp-satellite]')).map(
    (el) => el.getAttribute('data-mp-satellite') ?? '',
  );
}
function basePanePeriod(ctx: Ctx): string | null {
  return (
    ctx.view.container
      .querySelector<HTMLElement>('[data-mp-pane-role="base"]')
      ?.getAttribute('data-mp-pane') ?? null
  );
}
/** 选择器内的可见报错（PUT 失败/服务端 400 必须可见，不得静默）。 */
function pickerError(ctx: Ctx): string {
  const el = ctx.view.container.querySelector(
    '[data-testid="mp-picker-error"], [data-mp-picker-error], [data-mp-error]',
  );
  return (el?.textContent ?? '').trim();
}

/** 打开选择器（入口契约：`button[data-testid="mp-periods-open"]`）。 */
async function openPicker(ctx: Ctx): Promise<void> {
  const open = ctx.view.container.querySelector<HTMLElement>('[data-testid="mp-periods-open"]');
  expect(open, '启用多周期后必须有打开选择器的入口（data-testid="mp-periods-open"）').not.toBeNull();
  await userEvent.click(open!);
  await flush(2);
  expect(
    ctx.view.container.querySelector('[data-testid="mp-picker"]'),
    '点击入口必须打开两步选择器（data-testid="mp-picker"）',
  ).not.toBeNull();
}

/** 在已打开的选择器内：选基准 + 勾选指标周期 + 确认。 */
async function chooseAndConfirm(ctx: Ctx, base: string, indicatorPeriods: string[]): Promise<void> {
  const root = ctx.view.container;
  const baseBtn = root.querySelector<HTMLElement>(`[data-mp-base-period="${base}"]`);
  expect(baseBtn, `步骤 1 必须提供 ${base}`).not.toBeNull();
  await userEvent.click(baseBtn!);
  for (const p of indicatorPeriods) {
    const btn = root.querySelector<HTMLButtonElement>(`[data-mp-indicator-period="${p}"]`);
    expect(btn, `步骤 2 必须提供候选 ${p}（base=${base}）`).not.toBeNull();
    expect(btn!.disabled, `候选 ${p} 必须可选（base=${base}）`).toBe(false);
    await userEvent.click(btn!);
  }
  const confirm = root.querySelector<HTMLElement>('[data-testid="mp-picker-confirm"]');
  expect(confirm, '必须有确认按钮').not.toBeNull();
  await act(async () => {
    fireEvent.click(confirm!);
  });
  await flush(4);
}

beforeEach(() => {
  vi.clearAllMocks();
  RoMock.instances = [];
  vi.stubGlobal('ResizeObserver', RoMock);
  resetRealtimePollGateForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('C. 页面级：两步选择器提交语义（写 periods[0] 与 state.period）', () => {
  it('C1 确认 ⇒ PUT /api/config/multi_period（periods/heights 键/indicators/enabled）；基准 pane = 步骤1 选择，且「基准被配置覆盖」消除', async () => {
    setServerConfig({
      enabled: true,
      periods: ['1m', '5m'],
      heights: { '1m': 420, '5m': 180 },
      indicators: ['dcap'],
    });
    const ctx = await setup();

    // 前置：配置基准 1m ≠ 工具栏周期 15m ⇒ 当前处于「基准被配置覆盖」的可观测不一致态
    expect(basePanePeriod(ctx), '前置：基准由 periods[0] 决定（= 1m）').toBe('1m');
    expect(
      ctx.view.container.querySelector('[data-mp-base-override]'),
      '前置：被覆盖时必须显式可观测（徽标）——这正是 P5.5 要消除的状态',
    ).not.toBeNull();

    await openPicker(ctx);
    await chooseAndConfirm(ctx, '15m', ['1h']);

    expect(ctx.saveMultiPeriodConfig, '确认必须恰 1 次 PUT').toHaveBeenCalledTimes(1);
    const body = ctx.saveMultiPeriodConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.enabled, '确认即启用多周期').toBe(true);
    expect(body.periods, '载荷 periods = [步骤1 基准, ...指标周期]').toEqual(['15m', '1h']);
    expect(
      Object.keys(body.heights as Record<string, number>).sort(),
      'heights 键必须与 periods 一一对应',
    ).toEqual(['15m', '1h']);
    expect(body.indicators).toEqual(['dcap']);

    // 提交语义：**同时**写 periods[0] 与 state.period ⇒ 覆盖态必须消失（02-spec §2.1）
    await waitFor(() => {
      expect(basePanePeriod(ctx), '基准 pane 必须 = 步骤 1 选择的周期').toBe('15m');
    });
    const sat = ctx.view.container.querySelector<HTMLElement>('[data-mp-satellite="1h"]');
    expect(sat, '指标周期必须成为卫星实例').not.toBeNull();
    expect(
      sat!.getAttribute('data-mp-base-period-source'),
      'periods[0] == state.period ⇒ 基准不再由配置覆盖（source=toolbar）',
    ).toBe('toolbar');
    expect(
      ctx.view.container.querySelector('[data-mp-base-override]'),
      '覆盖徽标必须消失（消除 §2.1 的可观测不一致状态）',
    ).toBeNull();
    // 同时写 state.period 的行为证据：基准图按 15m 取数
    expect(
      ctx.getKline.mock.calls.some((c) => {
        const q = c[0] as { code?: string; period?: string };
        return q.code === '518880' && q.period === '15m';
      }),
      '同时写 state.period ⇒ 基准取数周期必须为 15m',
    ).toBe(true);
  });

  it('C2 失败回滚（PUT 400 拒绝）⇒ 卫星/基准回到提交前 + 可见报错（不静默）', async () => {
    setServerConfig({
      enabled: true,
      periods: ['1m', '5m'],
      heights: { '1m': 420, '5m': 180 },
      indicators: ['dcap'],
    });
    const ctx = await setup({
      onSave: () =>
        Promise.reject(new ApiError(400, 'HTTP 400: periods 卫星周期 1h 须 ≥ 基准 15m')),
    });

    await openPicker(ctx);
    await chooseAndConfirm(ctx, '15m', ['1h']);
    await flush(4);

    expect(ctx.saveMultiPeriodConfig, '必须真发 PUT（乐观更新 + 回滚形态，不得静默放弃）').toHaveBeenCalledTimes(
      1,
    );
    expect(satellites(ctx), '失败后卫星集合必须回滚到提交前').toEqual(['5m']);
    expect(basePanePeriod(ctx), '失败后基准 pane 必须回滚').toBe('1m');
    expect(pickerError(ctx), '失败必须可见报错（不得静默）').not.toBe('');
  });
});

describe('C. 页面级：开关与模式（仅单图可用）+ 关闭零残留 + heights 兼容', () => {
  it('C4 宫格模式 ⇒ 多周期强制关闭/入口隐藏：零卫星、零卫星周期订阅', async () => {
    setServerConfig({
      enabled: true,
      periods: ['1m', '5m', '15m'],
      heights: { '1m': 420, '5m': 180, '15m': 180 },
      indicators: ['dcap'],
    });
    const ctx = await setup();
    expect(satellites(ctx).length, '前置：单图下卫星存在').toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '2×2' }));
    await flush(4);

    expect(satellites(ctx), '宫格模式必须零卫星（02-spec §7.1）').toEqual([]);
    const toggle = screen.queryByRole('button', { name: '多周期' });
    if (toggle) {
      expect(
        toggle.getAttribute('aria-pressed'),
        '宫格模式下多周期入口必须为关闭态（隐藏或强制关闭）',
      ).toBe('false');
    }
    expect(
      barTopics(ctx.ws).filter((t) => t.endsWith(':1m') || t.endsWith(':5m')),
      '宫格模式不得残留卫星周期的 WS 订阅',
    ).toEqual([]);
  });

  it('C5 关闭多周期开关 ⇒ 零残留（卫星归零、卫星周期无新增取数/订阅）', async () => {
    setServerConfig({
      enabled: true,
      periods: ['1m', '5m'],
      heights: { '1m': 420, '5m': 180 },
      indicators: ['dcap'],
    });
    const ctx = await setup();
    const satCallsBefore = ctx.getKline.mock.calls.filter(
      (c) => (c[0] as { period?: string }).period === '5m',
    ).length;
    expect(satCallsBefore, '前置：卫星 5m 已取数').toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '多周期' }));
    });
    await flush(4);

    const off = ctx.saveMultiPeriodConfig.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(off?.enabled, '关闭必须落服务端配置（enabled=false）').toBe(false);

    await waitFor(() => expect(satellites(ctx)).toEqual([]));
    expect(
      ctx.getKline.mock.calls.filter((c) => (c[0] as { period?: string }).period === '5m').length,
      '关闭后不得再为卫星周期取数',
    ).toBe(satCallsBefore);
    expect(activeSubs(ctx.ws, 'bar:518880:5m'), '关闭后卫星订阅必须释放').toBe(0);
    expect(activeSubs(ctx.ws, 'bar:518880:1m'), '关闭后原基准（1m）订阅必须释放').toBe(0);
    expect(barTopics(ctx.ws), '仅剩工具栏周期的订阅').toEqual(['bar:518880:15m']);
  });

  it('C6 heights 兼容：新增/移除周期 ⇒ 键随之增删（保留既有值）+ 不破坏 P5 分配契约（Σ == 可用）', async () => {
    setServerConfig({
      enabled: true,
      periods: ['15m', '1h'],
      heights: { '15m': 300, '1h': 150 },
      indicators: ['dcap'],
    });
    const ctx = await setup();
    expect(basePanePeriod(ctx)).toBe('15m');

    await openPicker(ctx);
    await chooseAndConfirm(ctx, '15m', ['1h', '1d']);

    const body = ctx.saveMultiPeriodConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(
      body.heights,
      '新增 1d ⇒ 键增删随 periods；既有 1h=150 必须保留（不得整体重置）',
    ).toEqual({ '15m': 300, '1h': 150, '1d': 180 });

    await waitFor(() => expect(satellites(ctx)).toEqual(['1h', '1d']));
    const panes = Array.from(ctx.view.container.querySelectorAll<HTMLElement>('[data-mp-pane]')).map((el) =>
      Number(el.getAttribute('data-mp-pane-height')),
    );
    expect(panes, '每个周期一个 pane').toHaveLength(3);
    expect(panes.reduce((a, b) => a + b, 0), 'P5 分配契约保持：Σ 分配高度 == 可用高度（600）').toBe(
      AVAILABLE,
    );
  });
});
