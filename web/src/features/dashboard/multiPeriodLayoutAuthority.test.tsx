/**
 * 红测试（P5-F-1）：把 P5 最终独立验收（`tester/test/278_p5_final_independent_acceptance_execution.md`）
 * 的 **R1 / R2** 落成可执行红测试 —— 逻辑层（jsdom，本文件）；几何层由真渲染 harness
 * `web/tester/p5-r1r2-harness/`（Playwright + 真实产品组件）承担（同一判据）。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodLayoutAuthority.test.tsx`
 *
 * 权威依据（架构裁决 2026-09-15，本轮按此实现；02-spec §6.2 / §6.3）：
 *  - **① 拖拽基线取「持久化域内的当前值」（`clamp(当前分配)`）**，不是屏幕分配值
 *    ⇒ 每次拖拽都必须单调改载荷（消除死区与「拖了没反应」）；
 *  - **② `fit` 模式下基准高度是「余量吸收项」**（屏幕高 = 可用 − Σ卫星），其持久化值仅作记录；
 *    「屏幕 vs 载荷」偏差（实测 ≤61px）属**已知且允许**（锁定为 ≤61px，见 R2-C）；
 *  - **③ 依赖完整性**：任何影响 pane 高度/分配的 `useMemo`/`useEffect` 必须把**卫星高度**列入依赖
 *    （R1 教训：父层回执只改卫星高度时被忽略 ⇒ 拖拽回弹、屏幕与服务端分叉）；
 *  - 高度权威链（§6.3）：服务端配置（唯一权威）→ 父层 props → 组件。
 *
 * 预期 red 理由（当前实现）：`MultiPeriodChartStack.tsx` 的 `specPanes` useMemo 依赖
 * `[basePeriod, baseHeight, periodsKey]` **缺卫星高度** ⇒ 父层回执只改卫星高度时被忽略
 * ⇒ 拖拽在回执落定后回弹（实测 600px 窗口：`{294,97,97,112}` 覆盖拖中的 `{294,112,82,112}`）；
 * 越域（可用 1800px）时该回弹叠加 `payload = clamp(分配)` 的 ≤61px 偏差 ⇒ 以真实服务端值重载
 * **跳变 20px**、连续 ≥1px 拖拽**载荷不变**（死区）。
 *
 * 诚实分工：jsdom 无布局引擎 ⇒ 真实像素几何（鼠标拖拽 + rect）由 `web/tester/p5-r1r2-harness/` 取证；
 * 本文件的「高度」是组件声明的分配值（`data-mp-pane-height` / inline px，与真实 rect 在几何 harness 中互证）。
 *
 * 硬约束（本文件全程遵守）：**0 写请求**（`onHeightsChange` 是页面内桩，非网络）；不触碰线上。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCallback, useState } from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import type { ApiClient } from '@/api/client';
import type { Period } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';
import { DRAG_DEBOUNCE_MS, HEIGHT_MAX, HEIGHT_MIN } from './multiPeriodLayout';

// ─────────────────────────────────────────────────────────────────────────────
// klinecharts 桩（每次 init 返回新的忠实实例桩；P2/P5-A 同源手法）
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

import { MultiPeriodChartStack } from './MultiPeriodChartStack';

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：假 api / ws（0 网络）+ 周期定义
// ─────────────────────────────────────────────────────────────────────────────

const BAR = {
  ts: '2026-09-15T02:00:00Z',
  open: 1,
  high: 1.1,
  low: 0.9,
  close: 1.05,
  volume: 100,
  amount: 105,
};

const api = stubApi({ getKline: vi.fn(async () => [BAR]) }) as unknown as ApiClient;
const ws = {
  connectionStatus: 'open',
  subscribe: (() => () => {}) as unknown,
  onStatusChange: () => () => {},
} as unknown as WsClient;

const BASE_PERIOD: Period = '15m';
const SAT0: Period = '1h';
const SAT1: Period = '5m';
const SAT2: Period = '1d';
const SATS: Period[] = [SAT0, SAT1, SAT2];
const ALL: Period[] = [BASE_PERIOD, ...SATS];
const INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };
const CODE = '518880';

type Heights = Record<string, number>;

/** 首屏请求高度（02-spec §6 默认）：基准 420 + 3×180 = 960。 */
const REQ: Heights = { [BASE_PERIOD]: 420, '1h': 180, '5m': 180, '1d': 180 };

/** 越域判据的可用高度（02-spec §6.2 / P5-E：可用 ≥1201px 时 `fit` 基准吸收余量可 >1200）。 */
const AVAIL_SHORT = 600;
const AVAIL_TALL = 1800;

const DEFAULT_ECHO_CONTEXT = DEFAULT_DCAP_PARAMS;

/**
 * **受控父层**（复刻 `DashboardPage.saveMultiPeriodHeights` 的写路径）：
 * 乐观写 store ⇒ `PUT /api/config/multi_period`（页面内桩，**0 网络**）⇒ 成功回显成为 props 权威，
 * 并以 **Promise** 回执「父层已接管高度权威」（§6.3）。
 */
function Parent({
  available,
  initial,
  payloads,
  echo,
}: {
  available: number;
  initial: Heights;
  payloads: Heights[];
  /** 成功回显（`true`，默认）或失败回滚（`false`）——两者都必须让 props 重新成为权威。 */
  echo?: boolean;
}) {
  const [heights, setHeights] = useState<Heights>(initial);
  const onHeightsChange = useCallback(
    (h: Heights) => {
      const body = { ...h };
      payloads.push(body); // 页面内桩「服务端」（不发网络）
      // 乐观更新 + 服务端回显（成功路径逐字节回显；失败路径由 echo=false 的用例另行覆盖）
      setHeights((prev) => (echo === false ? { ...prev } : { ...body }));
      return Promise.resolve();
    },
    [payloads, echo],
  );
  return <StackTree heights={heights} available={available} onHeightsChange={onHeightsChange} />;
}

/** 纯 props 树（不挂写路径）：用于「仅卫星高度变化 ⇒ 分配必须重算」的依赖完整性判据。 */
function PropsOnly({ heights, available }: { heights: Heights; available: number }) {
  return <StackTree heights={heights} available={available} />;
}

function StackTree({
  heights,
  available,
  onHeightsChange,
}: {
  heights: Heights;
  available: number;
  onHeightsChange?: (h: Heights) => void | Promise<unknown>;
}) {
  return (
    <MultiPeriodChartStack
      enabled
      code={CODE}
      api={api}
      ws={ws}
      indicators={INDICATORS}
      maWindows={[5, 10, 20]}
      dcapParams={DEFAULT_ECHO_CONTEXT}
      viewportBars={120}
      followLatest
      basePeriod={BASE_PERIOD}
      basePeriodSource="config"
      baseHeight={heights[BASE_PERIOD]}
      availableHeight={available}
      onHeightsChange={onHeightsChange}
      satellites={SATS.map((p) => ({ period: p, height: heights[p]! }))}
    >
      <div data-testid="base-child" />
    </MultiPeriodChartStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 读数 / 拖拽辅助（与 P5-A 的 DOM 契约测试同源口径 ⇒ 可与几何 harness 互证）
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

function heightsOf(root: HTMLElement): Heights {
  const out: Heights = {};
  for (const p of ALL) {
    const el = paneEl(root, p, p === BASE_PERIOD);
    const attr = el.getAttribute('data-mp-pane-height');
    out[p] = attr !== null ? Number(attr) : Math.round(Number.parseFloat(el.style.height));
  }
  return out;
}

function separatorFor(root: HTMLElement, upper: string, lower: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-mp-separator="${upper}|${lower}"]`);
  if (!el) throw new Error(`缺少分隔条 ${upper}|${lower}`);
  return el;
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** 真实计时器等过防抖窗（`DRAG_DEBOUNCE_MS` + 余量）⇒ 每次拖拽恰 1 次载荷。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, DRAG_DEBOUNCE_MS + 150));
  });
  await flush(2);
}

interface DragResult {
  /** 拖中（mousemove 后、mouseup 前）的 DOM 分配 —— 即「拖拽请求的屏幕结果」。 */
  during: Heights;
  /** 防抖载荷落定 + 父层回执 settle 后的 DOM 分配。 */
  after: Heights;
}

/**
 * 鼠标拖拽一步（jsdom 无 PointerEvent ⇒ 契约以鼠标事件驱动，P5-A 同源）：
 * mousedown(分隔条) → mousemove(window) → 读「拖中」→ mouseup(window) → 等防抖 + 回执 → 读「拖后」。
 */
async function dragWithEcho(root: HTMLElement, upper: string, lower: string, deltaY: number): Promise<DragResult> {
  const sep = separatorFor(root, upper, lower); // 每次重新取节点（回执后可能被 React 复用/重建）
  await act(async () => {
    fireEvent.mouseDown(sep, { clientY: 300, button: 0 });
    fireEvent.mouseMove(window, { clientY: 300 + deltaY, buttons: 1 });
  });
  const during = heightsOf(root);
  await act(async () => {
    fireEvent.mouseUp(window, { clientY: 300 + deltaY });
  });
  await settle();
  return { during, after: heightsOf(root) };
}

function diff(a: Heights, b: Heights): Heights {
  const out: Heights = {};
  for (const p of ALL) out[p] = (b[p] ?? 0) - (a[p] ?? 0);
  return out;
}

function maxAbsDiff(a: Heights, b: Heights): number {
  return Math.max(...ALL.map((p) => Math.abs((a[p] ?? 0) - (b[p] ?? 0))));
}

function sum(h: Heights): number {
  return ALL.reduce((acc, p) => acc + (h[p] ?? 0), 0);
}

/** `payload == clamp(DOM 末次分配高度, 80, 1200)`（02-spec §6.2 的唯一口径）。 */
function clampDomain(v: number): number {
  return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, v));
}

/**
 * 回执权威判据（R1）：拖拽必须生效（上增/下减），且**父层回执 settle 后**的 DOM 必须等于拖中分配
 * ——不得回弹到「请求前的分配」（P5 验收实测回弹 + 屏幕/服务端分叉）。
 */
function assertEchoAdopted(
  s: DragResult,
  before: Heights,
  upper: string,
  lower: string,
  available: number,
): void {
  const detail =
    `[回执前=${JSON.stringify(before)} 拖中=${JSON.stringify(s.during)} ` +
    `回执后=${JSON.stringify(s.after)} after−during=${JSON.stringify(diff(s.during, s.after))}]`;
  expect(s.during[upper]!, `上 pane 必须随拖拽增大 ${detail}`).toBeGreaterThan(before[upper]!);
  expect(s.during[lower]!, `下 pane 必须随拖拽减小 ${detail}`).toBeLessThan(before[lower]!);
  expect(s.after, `回执 settle 后必须采用回执值（不得回弹到请求前的分配）${detail}`).toEqual(s.during);
  expect(sum(s.after), `Σ 分配 == 可用高度 ${detail}`).toBe(available);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// R1：高度权威链 + 依赖完整性
// ─────────────────────────────────────────────────────────────────────────────

describe('R1 父层回执必须成为高度权威（依赖完整性）', () => {
  it('R1-A 依赖完整性：父层只改卫星高度 ⇒ 分配必须重算（不得沿用旧卫星请求）', async () => {
    // 依据 02-spec §6.2 尾条（③）：任何影响 pane 高度/分配的 memo/effect 必须把卫星高度列入依赖。
    const { container, rerender } = render(
      <PropsOnly heights={{ [BASE_PERIOD]: 294, '1h': 97, '5m': 97, '1d': 112 }} available={AVAIL_SHORT} />,
    );
    await flush();
    // 前置：Σ 请求 = 600 = 可用 ⇒ `fit` ⇒ 逐值等于请求（基准 = 余量吸收项，此处恰为 294）
    expect(heightsOf(container), '前置：首屏分配').toEqual({ [BASE_PERIOD]: 294, '1h': 97, '5m': 97, '1d': 112 });

    // 父层回执**只改卫星高度**（基准 294 不变）——这正是 P5 验收里被静默忽略的那种变化
    rerender(<PropsOnly heights={{ [BASE_PERIOD]: 294, '1h': 112, '5m': 82, '1d': 112 }} available={AVAIL_SHORT} />);
    await flush();

    expect(
      heightsOf(container),
      '父层 props 是高度权威（§6.3）：仅卫星高度变化也必须重算分配；' +
        '返回旧卫星请求（97/97/112）即「依赖缺卫星高度」缺陷',
    ).toEqual({ [BASE_PERIOD]: 294, '1h': 112, '5m': 82, '1d': 112 });
  });

  it('R1-B 父层回执只改卫星高度 ⇒ 必须采用回执值（连续两次卫星↔卫星拖拽不得回弹）', async () => {
    // 复刻 P5 最终验收 ③（真渲染实测，600px）：before {294,97,97,112} → during {294,112,82,112}
    //                                              → after {294,97,97,112}（回弹 = 屏幕与服务端分叉）。
    // 关键：该回执**只改卫星高度**（基准 294 不变）⇒ 当前实现的 specPanes memo（依赖缺卫星高度）忽略回执。
    const payloads: Heights[] = [];
    /** 「服务端配置」= 当前持久化布局（Σ=600）——重载后的真实状态。 */
    const PERSISTED: Heights = { [BASE_PERIOD]: 294, '1h': 97, '5m': 97, '1d': 112 };
    const { container } = render(<Parent available={AVAIL_SHORT} initial={PERSISTED} payloads={payloads} />);
    await flush();
    expect(heightsOf(container), '前置：服务端配置 == 当前布局 ⇒ 逐值渲染').toEqual(PERSISTED);

    // ① 卫星↔卫星（1h|5m）+15 ⇒ 回执的两项都落在**卫星**上
    const s1 = await dragWithEcho(container, '1h', '5m', 15);
    expect(s1.during, '① 拖中（P5 验收实测 {294,112,82,112}）').toEqual({
      [BASE_PERIOD]: 294,
      '1h': 112,
      '5m': 82,
      '1d': 112,
    });
    expect(payloads.at(-1), '① 载荷 == 拖中分配（域内 ⇒ clamp 恒等）').toEqual(s1.during);
    assertEchoAdopted(s1, PERSISTED, '1h', '5m', AVAIL_SHORT);

    // ② **连续第二次**卫星↔卫星（换一条分隔条 5m|1d）+10 ⇒ 回执仍只改卫星高度
    const before2 = s1.after;
    expect(before2, '② 前置：① 的回执值必须已生效').toEqual(s1.during);
    const s2 = await dragWithEcho(container, '5m', '1d', 10);
    expect(payloads.at(-1), '② 载荷 == 拖中分配').toEqual(s2.during);
    assertEchoAdopted(s2, before2, '5m', '1d', AVAIL_SHORT);

    // 载荷侧（写路径不变量）：两次拖拽 ⇒ 恰两份载荷，且每项 ∈ 配置域
    expect(payloads.length, '两次拖拽 ⇒ 恰两份载荷（每次防抖恰 1 次写）').toBe(2);
    for (let i = 0; i < payloads.length; i++) {
      for (const p of ALL) {
        expect(payloads[i]![p], `载荷 #${i + 1} ${p} ≥ ${HEIGHT_MIN}`).toBeGreaterThanOrEqual(HEIGHT_MIN);
        expect(payloads[i]![p], `载荷 #${i + 1} ${p} ≤ ${HEIGHT_MAX}`).toBeLessThanOrEqual(HEIGHT_MAX);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2：越域（可用 ≥1201px）载荷无死区 + 重载无跳变
// ─────────────────────────────────────────────────────────────────────────────

describe('R2 越域（可用 1800px）载荷无死区、重载无跳变', () => {
  it('R2-A 连续同向 ≥1px 拖拽 ⇒ 载荷必须每次都变化（不得「拖了载荷不变」）', async () => {
    // 依据裁决 ①：拖拽基线取「持久化域内的当前值」⇒ 每次拖拽单调改载荷。
    // 当前实现：越域场景里回执只改卫星高度 ⇒ memo 忽略回执（R1）⇒ 下一次拖拽的基线/屏幕仍是旧值
    // ⇒ 载荷重复（实测：连续 +1 的载荷在第二次之后不再变化）。
    const payloads: Heights[] = [];
    const { container } = render(<Parent available={AVAIL_TALL} initial={REQ} payloads={payloads} />);
    await flush();

    const screen0 = heightsOf(container);
    expect(screen0[BASE_PERIOD], '前置：越域（基准吸收余量 1800 − 3×180 = 1260 > 1200）').toBeGreaterThan(HEIGHT_MAX);

    await dragWithEcho(container, BASE_PERIOD, '1h', 1);
    await dragWithEcho(container, BASE_PERIOD, '1h', 1);
    await dragWithEcho(container, BASE_PERIOD, '1h', 1);

    expect(payloads.length, '三次 ≥1px 拖拽 ⇒ 每次都必须有一份载荷').toBe(3);
    // 被拖的一方（1h）在载荷里必须**每次**随拖拽方向单调变化（+1 拖拽 ⇒ 1h 递减 1）
    expect(payloads[0]!['1h'], '第 1 次拖拽后的载荷 1h').toBe(179);
    expect(
      payloads[1]!['1h'],
      `第 2 次拖拽后的载荷必须继续变化（收到 ${payloads[1]!['1h']}）⇒ 不得「拖了载荷不变」`,
    ).toBe(178);
    expect(
      payloads[2]!['1h'],
      `第 3 次拖拽后的载荷必须继续变化（收到 ${payloads[2]!['1h']}）⇒ 不得「拖了载荷不变」；` +
        `载荷序列=${JSON.stringify(payloads)}`,
    ).toBe(177);
    // 每次载荷都必须与上一次不同（更强、更贴契约本身：任何 ≥1px 拖拽都不得零效果）
    for (let i = 1; i < payloads.length; i++) {
      expect(payloads[i], `载荷 #${i + 1} 必须 ≠ 载荷 #${i}`).not.toEqual(payloads[i - 1]);
    }
    // 载荷恒合法（域内整数）；**基准项**允许停在 1200（裁决 ②：其持久化值仅作记录，屏幕与载荷偏差 ≤61px）
    for (const [i, pl] of payloads.entries()) {
      for (const p of ALL) {
        expect(Number.isInteger(pl[p]), `载荷 #${i + 1} ${p} 必须为整数 px`).toBe(true);
        expect(pl[p]!, `载荷 #${i + 1} ${p} 必须 ∈ [${HEIGHT_MIN},${HEIGHT_MAX}]`).toBeGreaterThanOrEqual(HEIGHT_MIN);
        expect(pl[p]!, `载荷 #${i + 1} ${p} 必须 ∈ [${HEIGHT_MIN},${HEIGHT_MAX}]`).toBeLessThanOrEqual(HEIGHT_MAX);
      }
    }
  });

  it('R2-B 越域 + 以真实服务端值重载 ⇒ 屏幕不得跳变（实测 20px）且屏幕-载荷偏差 ≤61px', async () => {
    const payloads: Heights[] = [];
    const { container } = render(<Parent available={AVAIL_TALL} initial={REQ} payloads={payloads} />);
    await flush();

    // 拖 ①：基准 +1（载荷被夹到 1200 —— 裁决 ② 允许的已知偏差）
    await dragWithEcho(container, BASE_PERIOD, '1h', 1);
    const p1 = payloads.at(-1)!;
    expect(p1[BASE_PERIOD], '载荷基项被夹到域上界（02-spec §6.2「载荷恒合法」）').toBe(HEIGHT_MAX);
    expect(p1['1h']).toBe(179);

    // 拖 ②：同一条分隔条反向 −20（验收实测：屏幕零反馈 + 服务端已变 ⇒ 分叉）
    const s2 = await dragWithEcho(container, BASE_PERIOD, '1h', -20);
    const p2 = payloads.at(-1)!;
    expect(p2, '载荷 #2（= 真实服务端值）').toEqual({
      [BASE_PERIOD]: HEIGHT_MAX,
      '1h': 199,
      '5m': 180,
      '1d': 180,
    });

    // 偏差（已知且允许）：屏幕分配 vs 载荷 ⇒ 必须 ≤61px（把「允许的偏差」上限锁死）
    const deviationAfter = maxAbsDiff(s2.after, p2);
    expect(
      deviationAfter,
      `裁决 ②：屏幕分配与持久化载荷的偏差必须 ≤61px（实测 ${deviationAfter}px；` +
        `屏幕=${JSON.stringify(s2.after)} 载荷=${JSON.stringify(p2)}）`,
    ).toBeLessThanOrEqual(61);

    // 「重载」：以**真实服务端值**（= 载荷 #2）作为服务端配置重新挂载 ⇒ 屏幕必须与拖后一致（无跳变）
    const reloaded = render(<PropsOnly heights={{ ...p2 }} available={AVAIL_TALL} />);
    await flush();
    const screenReloaded = heightsOf(reloaded.container);
    const jump = maxAbsDiff(s2.after, screenReloaded);
    expect(
      jump,
      '以真实服务端值重载后屏幕必须与拖后一致（±1px，不得跳变）：' +
        `拖后屏幕=${JSON.stringify(s2.after)} 重载屏幕=${JSON.stringify(screenReloaded)} ` +
        `跳变=${jump}px（P5 验收实测 20px）`,
    ).toBeLessThanOrEqual(1);
    // 重载后各项仍 ∈ 载荷域内、且 Σ == 可用（重载不得改变分配口径）
    expect(sum(screenReloaded), '重载后 Σ 分配 == 可用高度').toBe(AVAIL_TALL);
  });

  it('R2-C 越域载荷口径：payload == clamp(DOM)、Σ DOM == 可用（渲染分配可越域，载荷恒合法）', async () => {
    const payloads: Heights[] = [];
    const { container } = render(<Parent available={AVAIL_TALL} initial={REQ} payloads={payloads} />);
    await flush();

    const s = await dragWithEcho(container, '1h', '5m', 5);
    const pl = payloads.at(-1)!;
    expect(pl, '卫星↔卫星拖拽 ⇒ 载荷逐项 = clamp(DOM)').toEqual({
      [BASE_PERIOD]: clampDomain(s.during[BASE_PERIOD]!),
      '1h': clampDomain(s.during['1h']!),
      '5m': clampDomain(s.during['5m']!),
      '1d': clampDomain(s.during['1d']!),
    });
    // 拖中也必须反映在载荷里（≥1px 拖拽 ⇒ 载荷相应变化；当前实现：屏幕回弹 ⇒ 载荷仍变但屏幕/服务端分叉）
    expect(pl['1h'], '拖拽必须体现在载荷中').toBeGreaterThan(REQ['1h']!);
    expect(pl['5m'], '拖拽必须体现在载荷中').toBeLessThan(REQ['5m']!);
    expect(sum(s.after), '回执后 Σ 分配仍 == 可用高度').toBe(AVAIL_TALL);
    expect(s.after[BASE_PERIOD], '越域场景：屏幕基准仍可 > HEIGHT_MAX（渲染分配允许越域）').toBeGreaterThan(
      HEIGHT_MAX,
    );
  });
});
