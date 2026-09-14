/**
 * 红测试（P5-A）：**多周期栈的 DOM 契约** —— 恰好填满 / 我方分隔条 / 拖拽 / 防抖回调 / ②③ 不变量 / ADR-020。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodLayoutDom.test.tsx`
 * 权威依据：
 *  - `design/15-multi-period/04-implementation-plan.md` P5
 *  - `design/15-multi-period/03-test-plan.md` T9（布局持久化与 ②③ 契约）
 *  - `design/15-multi-period/02-spec.md` §6（布局契约；**叠加分隔条由我们自己的容器渲染，不再由锚点 border 提供**）
 *  - ADR-020（barSpace 由 (容器宽度, 根数) 唯一决定）；ADR-022 §3.2 第 7 条（基准永不被改写）
 *  - P2-C 实测：`tester/test/271_p2c_independent_acceptance_execution.md` §9（600 vs 1140 ⇒ 540px 纵向溢出）
 *  - 本文件的设计报告：`tester/design/276_p5_layout_persistence_red_design.md` §2.2/§2.3（钉死 DOM 契约与拖拽语义）
 *
 * 预期 red 理由：`MultiPeriodChartStack` 目前**只是把卫星按普通流追加**（`height: Npx` + 无高度分配、
 * 无 `[data-mp-stack]`、无 `[data-mp-pane]`、无我方分隔条、无拖拽/持久化）⇒ 本文件全部用例当前红。
 *
 * 诚实分工：jsdom 无布局引擎 ⇒ 真正的「无纵向溢出」几何判据由
 * `web/tester/p5-layout-harness/`（Playwright + 真实产品组件）承担；本文件判 DOM 契约与分配数值。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import { DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';
import { barSpaceForViewport } from './barSpaceFit';
import { DRAG_DEBOUNCE_MS, HEIGHT_MIN, HEIGHT_MAX } from './multiPeriodLayout';

// ─────────────────────────────────────────────────────────────────────────────
// klinecharts 桩：每次 init 返回新的忠实实例桩（P2 模式；逐实例取证）
// ─────────────────────────────────────────────────────────────────────────────

const H = vi.hoisted(() => ({
  stubs: [] as any[],
  initArgs: [] as any[],
}));

vi.mock('klinecharts', async () => {
  const { createChartStoreStub } = await import('@/test/chartStoreStub');
  return {
    init: vi.fn((el: unknown) => {
      const store = createChartStoreStub();
      const stub: any = {
        ...store,
        setSymbol: vi.fn(),
        setPeriod: vi.fn(),
        setDataLoader: vi.fn((loader: unknown) => {
          stub.__loader = loader;
        }),
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
        __loader: null,
      };
      H.stubs.push(stub);
      H.initArgs.push(el);
      return stub;
    }),
    dispose: vi.fn(),
    registerIndicator: vi.fn(),
  };
});

import {
  MultiPeriodChartStack,
  DEFAULT_SATELLITE_HEIGHT,
  type MultiPeriodChartStackProps,
} from './MultiPeriodChartStack';
import { KlineChart } from './KlineChart';
import { KlineDataFeed } from './feed';

// ─────────────────────────────────────────────────────────────────────────────
// 假 api / ws + 真实 feed（合成数据；零网络）
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

function fakeApi() {
  return stubApi({ getKline: vi.fn(async () => [BAR]) }) as unknown as ApiClient;
}
function fakeWs() {
  return {
    connectionStatus: 'open',
    subscribe: (() => () => {}) as unknown,
    onStatusChange: () => () => {},
  } as unknown as WsClient;
}

const BASE_PERIOD = '15m';
const SAT0 = '1h';
const SAT1 = '5m';
const SAT2 = '1d';
const SATS = [SAT0, SAT1, SAT2];

/**
 * 红阶段：`baseHeight` / `availableHeight` / `onHeightsChange` **尚未**出现在
 * `MultiPeriodChartStackProps` 里 ⇒ 类型层面按设计报告 §2.2 的契约声明（变量化引用，
 * 同 P3 的「变量 specifier」手法：红阶段不让 `tsc -b` 被尚未存在的接口阻塞）。
 */
type StackProps = MultiPeriodChartStackProps & {
  baseHeight?: number;
  availableHeight?: number;
  onHeightsChange?: (heights: Record<string, number>) => void;
};
const Stack = MultiPeriodChartStack as unknown as (p: StackProps) => JSX.Element | null;
const AVAILABLE = 600;
/** 首屏请求高度（02-spec §6 默认）：基准 420 + 3×180 = 960 > 600 ⇒ 必然缩小。 */
const REQ_BASE = 420;
const REQ_SAT = 180;

const api = fakeApi();
const ws = fakeWs();
const feeds = new Map<string, KlineDataFeed>();
function feedFor(code: string): KlineDataFeed {
  const key = `${code}|${BASE_PERIOD}`;
  let f = feeds.get(key);
  if (!f) {
    f = new KlineDataFeed({ api, ws, code, period: BASE_PERIOD, viewportBars: 120, warmupBars: 0 });
    feeds.set(key, f);
  }
  return f;
}

const INDICATORS = { ma: true, macd: false, kdj: false, boll: false, dcap: true };

function stackTree(opts: {
  code?: string;
  dcapParams?: typeof DEFAULT_DCAP_PARAMS;
  onHeightsChange?: (h: Record<string, number>) => void;
  /** 可用高度覆盖（P5-E-1：超宽屏夹具；缺省 = `AVAILABLE` 600px）。 */
  availableHeight?: number;
  /** pane 索引覆盖（P5-E-1：更少/更高的 pane 能以更小可用高度触发基准吸收余量）；缺省 = 4 pane 夹具。 */
  panes?: readonly { period: string; height: number }[];
}) {
  const code = opts.code ?? '518880';
  const panes = opts.panes ?? SATS.map((p) => ({ period: p, height: REQ_SAT }));
  return (
    <Stack
      enabled
      code={code}
      api={api}
      ws={ws}
      indicators={INDICATORS}
      maWindows={[5, 10, 20]}
      dcapParams={opts.dcapParams ?? DEFAULT_DCAP_PARAMS}
      viewportBars={120}
      followLatest
      basePeriod={BASE_PERIOD}
      basePeriodSource="config"
      baseHeight={REQ_BASE}
      availableHeight={opts.availableHeight ?? AVAILABLE}
      onHeightsChange={opts.onHeightsChange}
      satellites={panes.map((p) => ({ period: p.period as never, height: p.height }))}
    >
      <KlineChart
        feed={feedFor(code)}
        code={code}
        period={BASE_PERIOD}
        followLatest
        indicators={INDICATORS}
        onManualZoom={() => {}}
        maWindows={[5, 10, 20]}
        dcapParams={opts.dcapParams ?? DEFAULT_DCAP_PARAMS}
        warmupBars={0}
      />
    </Stack>
  );
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 读数辅助（DOM 契约；pane 形状两种实现都接受：pane 包装层 或 `[data-mp-satellite]` 本身）
// ─────────────────────────────────────────────────────────────────────────────

function stackEl(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>('[data-mp-stack]');
  if (!el) throw new Error('缺少 [data-mp-stack]');
  return el;
}

function paneEl(root: HTMLElement, period: string, isBase: boolean): HTMLElement {
  const direct = root.querySelector<HTMLElement>(`[data-mp-pane="${period}"]`);
  if (direct) return direct;
  if (!isBase) {
    const sat = root.querySelector<HTMLElement>(`[data-mp-satellite="${period}"]`);
    if (sat) return sat;
  }
  throw new Error(`缺少 pane ${period}`);
}

function paneHeight(root: HTMLElement, period: string, isBase = false): number {
  const el = paneEl(root, period, isBase);
  const attr = el.getAttribute('data-mp-pane-height');
  if (attr !== null) return Number(attr);
  const px = el.style.height;
  if (!px.endsWith('px')) throw new Error(`pane ${period} 高度不可读：${px}`);
  return Math.round(Number.parseFloat(px));
}

function periodsAll(): string[] {
  return [BASE_PERIOD, ...SATS];
}

function allHeights(root: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of periodsAll()) out[p] = paneHeight(root, p, p === BASE_PERIOD);
  return out;
}

/** 指定周期集合的 pane 分配高度（P5-E-1：非 4-pane 夹具共用读数口径）。 */
function heightsOf(root: HTMLElement, periods: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of periods) out[p] = paneHeight(root, p, p === BASE_PERIOD);
  return out;
}

/** Σ 分配高度（渲染侧不变量：`fit`/`shrunk` ⇒ == 可用高度）。 */
function sumHeights(h: Record<string, number>): number {
  return Object.values(h).reduce((a, b) => a + b, 0);
}

/**
 * 持久化载荷的**合法性口径**（02-spec §6.2，架构裁决 2026-09-15）：
 * `payload == clamp(DOM 末次分配高度, HEIGHT_MIN, HEIGHT_MAX)`（分配本就在域内 ⇒ 逐值相等）。
 */
function clampDomain(v: number): number {
  return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, v));
}

function separators(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-mp-separator]'));
}

function separatorFor(root: HTMLElement, upper: string, lower: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-mp-separator="${upper}|${lower}"]`);
  if (!el) throw new Error(`缺少分隔条 ${upper}|${lower}`);
  return el;
}

/** 鼠标拖拽（jsdom 无 PointerEvent ⇒ 契约以鼠标事件驱动；见设计报告 §2.3）。 */
function dragBy(sep: HTMLElement, deltaY: number): void {
  fireEvent.mouseDown(sep, { clientY: 300, button: 0 });
  fireEvent.mouseMove(window, { clientY: 300 + deltaY, buttons: 1 });
  fireEvent.mouseUp(window, { clientY: 300 + deltaY });
}

function baseChartStub(): any {
  for (let i = 0; i < H.stubs.length; i++) {
    const el = H.initArgs[i] as Element | undefined;
    const inSat = el && typeof (el as Element).closest === 'function' && (el as Element).closest('[data-mp-satellite]');
    if (!inSat) return H.stubs[i];
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.stubs.length = 0;
  H.initArgs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('多周期栈 DOM 契约（P5-A 红：无高度分配/无分隔条/无拖拽）', () => {
  it('B1 栈根元素契约：`[data-mp-stack]` + 布局 JSON + 各 pane inline 高度与 JSON 一致', async () => {
    const { container } = render(stackTree({}));
    await flush();

    const el = stackEl(container);
    expect(el.getAttribute('data-mp-stack-scrollable')).toBe('false');
    const layout = JSON.parse(el.getAttribute('data-mp-stack-layout') ?? 'null') as {
      total: number;
      reason: string;
      scrollable: boolean;
      heights: Record<string, number>;
    };
    expect(layout, '栈必须把分配结果写成 data-mp-stack-layout JSON').not.toBeNull();
    expect(layout.total).toBe(AVAILABLE);
    expect(layout.reason).toBe('shrunk');
    const fromDom = allHeights(container);
    for (const p of periodsAll()) {
      expect(layout.heights[p], `${p} JSON vs DOM`).toBe(fromDom[p]!);
    }
  });

  it('B2 恰好填满：Σ 各 pane 高度 == 可用高度 600（基准吸收余量/缩小时基准最大）', async () => {
    const { container } = render(stackTree({}));
    await flush();

    const h = allHeights(container);
    const total = Object.values(h).reduce((a, b) => a + b, 0);
    expect(total, '各 pane 高度之和必须 == 可用高度（无纵向溢出的数值面）').toBe(AVAILABLE);

    // 基准 ≥200 且为最大 pane；卫星 ∈ [80, 请求值] 且落在比例带（factor=0.625 ⇒ ≈112，±6px 容舍入策略）
    expect(h[BASE_PERIOD]!).toBeGreaterThanOrEqual(200);
    for (const p of SATS) {
      expect(h[p]!, `${p} ≥ 80`).toBeGreaterThanOrEqual(80);
      expect(h[p]!, `${p} ≤ 请求值 180`).toBeLessThanOrEqual(REQ_SAT);
      expect(h[p]!, `${p} 比例带`).toBeGreaterThanOrEqual(106);
      expect(h[p]!, `${p} 比例带`).toBeLessThanOrEqual(118);
      expect(h[BASE_PERIOD]!, '基准 > 任一卫星').toBeGreaterThan(h[p]!);
    }
  });

  it('B3 每个 pane 内是各自的 chart 宿主（基准 + 各卫星）', async () => {
    const { container } = render(stackTree({}));
    await flush();

    const basePane = paneEl(container, BASE_PERIOD, true);
    expect(basePane.querySelector('[data-testid="kline-chart"]'), '基准 pane 内必须是基准图表').not.toBeNull();
    for (const p of SATS) {
      const pane = paneEl(container, p, false);
      expect(pane.querySelector('[data-testid="kline-chart"]'), `卫星 ${p} pane 内必须是其图表`).not.toBeNull();
    }
  });

  it('B4 我方分隔条：相邻 pane 之间恰 1 条、role=separator、占位为零（不侵占 pane 空间）', async () => {
    const { container } = render(stackTree({}));
    await flush();

    const list = separators(container);
    const pairs = list.map((el) => el.getAttribute('data-mp-separator'));
    expect(pairs, '分隔条数量 = 相邻 pane 对数（4 pane ⇒ 3 条）').toEqual([
      `${BASE_PERIOD}|${SAT0}`,
      `${SAT0}|${SAT1}`,
      `${SAT1}|${SAT2}`,
    ]);
    for (const el of list) {
      expect(el.getAttribute('role')).toBe('separator');
      const [upper, lower] = (el.getAttribute('data-mp-separator') ?? '').split('|');
      expect(el.getAttribute('data-mp-sep-upper')).toBe(upper);
      expect(el.getAttribute('data-mp-sep-lower')).toBe(lower);
      // ① 的教训：**不得**依赖 region 锚点 border ⇒ 分隔条必须在我们自己的栈容器内
      expect(el.closest('[data-mp-stack]'), '分隔条必须由栈容器自己渲染').toBe(stackEl(container));
    }
    // 净布局高度 0：Σ pane == 可用 ⇒ 分隔条不占空间（实现自选 absolute / 负 margin）
    const total = Object.values(allHeights(container)).reduce((a, b) => a + b, 0);
    expect(total).toBe(AVAILABLE);
  });

  it('B5 拖拽改变相邻两者高度、二者之和不变、其它 pane 不变', async () => {
    const { container } = render(stackTree({}));
    await flush();
    const before = allHeights(container);

    dragBy(separatorFor(container, BASE_PERIOD, SAT0), 20);
    const after = allHeights(container);

    expect(after[BASE_PERIOD]!, '上 pane 增长').toBe(before[BASE_PERIOD]! + 20);
    expect(after[SAT0]!, '下 pane 收缩').toBe(before[SAT0]! - 20);
    expect(after[BASE_PERIOD]! + after[SAT0]!).toBe(before[BASE_PERIOD]! + before[SAT0]!);
    for (const p of [SAT1, SAT2]) expect(after[p]!, `${p} 不得变化`).toBe(before[p]!);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(AVAILABLE);
  });

  it('B6 拖拽下限：卫星停在 80、基准不低于 200；继续拖不越界', async () => {
    const { container } = render(stackTree({}));
    await flush();

    // 向上狠拖（基准缩小、卫星增大）⇒ 基准停在 200
    dragBy(separatorFor(container, BASE_PERIOD, SAT0), -1000);
    let h = allHeights(container);
    expect(h[BASE_PERIOD]!, '基准下限 200').toBe(200);
    expect(h[SAT0]!, '卫星上限 = Σ 剩余（其它 pane 下限后）').toBe(AVAILABLE - 200 - 80 * (SATS.length - 1));

    // 向下狠拖（基准增大、卫星缩小）⇒ 卫星停在 80
    dragBy(separatorFor(container, BASE_PERIOD, SAT0), 1000);
    h = allHeights(container);
    expect(h[SAT0]!, '卫星下限 80').toBe(80);
    expect(h[BASE_PERIOD]!).toBe(AVAILABLE - 80 - 80 * (SATS.length - 1));
    expect(Object.values(h).reduce((a, b) => a + b, 0)).toBe(AVAILABLE);
  });

  it('B7 拖拽防抖持久化：<300ms 不回调、≥300ms 恰 1 次、参数 = 全 pane 布局高度', async () => {
    const onHeightsChange = vi.fn();
    const { container } = render(stackTree({ onHeightsChange }));
    await flush();
    const before = allHeights(container);

    vi.useFakeTimers();
    dragBy(separatorFor(container, BASE_PERIOD, SAT0), 20);
    expect(onHeightsChange, '拖拽后不得立刻写（防抖）').not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(onHeightsChange, '299ms 内不得写').not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(onHeightsChange, '防抖窗到 ⇒ 恰一次').toHaveBeenCalledTimes(1);

    const payload = onHeightsChange.mock.calls[0]![0] as Record<string, number>;
    expect(Object.keys(payload).sort()).toEqual(periodsAll().sort());
    expect(payload[BASE_PERIOD]).toBe(before[BASE_PERIOD]! + 20);
    expect(payload[SAT0]).toBe(before[SAT0]! - 20);
    expect(Object.values(payload).reduce((a, b) => a + b, 0), '持久化值之和 == 可用高度').toBe(AVAILABLE);
    expect(Object.values(payload).every((v) => Number.isInteger(v))).toBe(true);
  });

  it('B8 连续拖拽合并为一次写入（参数 = 末次结果）', async () => {
    const onHeightsChange = vi.fn();
    const { container } = render(stackTree({ onHeightsChange }));
    await flush();
    const before = allHeights(container);

    vi.useFakeTimers();
    const sep = separatorFor(container, BASE_PERIOD, SAT0);
    dragBy(sep, 20);
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    dragBy(sep, 40); // 累计 +60
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    dragBy(sep, 10); // 累计 +70
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(onHeightsChange, '连续拖拽只写一次').toHaveBeenCalledTimes(1);
    const payload = onHeightsChange.mock.calls[0]![0] as Record<string, number>;
    // P5-D-2（架构裁决 2026-09-15，授权最小编辑本用例数值断言）：
    //  原断言 `payload[15m] == before+70 == 334` / `payload[1h] == before−70 == 42` 属**契约变更前**的遗留口径：
    //  42 已在配置域 `[80,1200]` 之外（会被 `PUT /api/config/multi_period` 400 拒绝），与 B13/C8/C9 **互斥**
    //  （Σ==600 ⇒ base+1h == 376 固定 ⇒ 只要 1h ≥ 80 则 base ≤ 296 ≠ 334）⇒ 原数值断言数学上不可满足。
    //  **不得**据此回退域夹取（`sanitizeDragHeight` 夹配置域）；以下新口径**更强**：末次结果 == DOM、
    //  Σ == 可用高度、每项 ∈ 配置域、且被压的一方**恰好触到配置域下界** 80。
    // P5-E-1 口径注记（仅注释，断言不变；02-spec §6.2）：
    //  通用口径是 `payload == clamp(DOM 末次分配高度, 80, 1200)`；**本用例的分配本就在域内**（600px 可用）
    //  ⇒ clamp 是恒等映射 ⇒ 与「payload == 末次分配结果（逐值相等）」**等价**，故此处保留更强的逐值相等断言。
    expect(payload, 'payload == 末次分配结果（与 DOM 逐项一致）').toEqual(allHeights(container));
    expect(Object.values(payload).reduce((a, b) => a + b, 0), 'Σ == 可用高度').toBe(AVAILABLE);
    expect(payload[BASE_PERIOD]!, '方向不变：基准增大').toBeGreaterThan(before[BASE_PERIOD]!);
    expect(payload[SAT0]!, '方向不变：被压的卫星减小').toBeLessThan(before[SAT0]!);
    for (const p of periodsAll()) {
      expect(payload[p]!, `${p} 必须 ∈ 配置域 [${HEIGHT_MIN},${HEIGHT_MAX}]`).toBeGreaterThanOrEqual(HEIGHT_MIN);
      expect(payload[p]!, `${p} 必须 ∈ 配置域 [${HEIGHT_MIN},${HEIGHT_MAX}]`).toBeLessThanOrEqual(HEIGHT_MAX);
    }
    expect(payload[SAT0]!, '被狠拖的一方恰好停在配置域下界（边界成为显式断言）').toBe(HEIGHT_MIN);
    expect(payload[SAT1], '未被拖拽的两颗卫星保持相等（分配对称性）').toBe(payload[SAT2]);
    expect(payload[BASE_PERIOD]!, '基准 = 可用 − 其余三项（由等式推导，不写死 334）').toBe(
      AVAILABLE - HEIGHT_MIN - payload[SAT1]! - payload[SAT2]!,
    );
  });

  it('B9 ②③ 不变量：拖拽后换 dcap 参数 / 换标的 / 强制重渲染 ⇒ 各 pane 高度不变（±1px）', async () => {
    const { container, rerender } = render(stackTree({}));
    await flush();
    dragBy(separatorFor(container, BASE_PERIOD, SAT0), 20);
    const after = allHeights(container);

    // ② 保存 dcap 参数（等价 props 变化：feed 不变 ⇒ 不得 remount/重置高度）
    rerender(stackTree({ dcapParams: { ...DEFAULT_DCAP_PARAMS, n: 9 } as typeof DEFAULT_DCAP_PARAMS }));
    await flush();
    expectHeightsWithin(container, after, 1);

    // ③ 切标的（feed 身份变化 ⇒ 卫星重建；用户拖过的高度必须不重置）
    rerender(stackTree({ code: '513310' }));
    await flush();
    expectHeightsWithin(container, after, 1);
  });

  it('B10 非法 heights ⇒ 不崩、回退默认（基准 420 / 卫星 180）', async () => {
    const bad = (
      <Stack
        enabled
        code="518880"
        api={api}
        ws={ws}
        indicators={INDICATORS}
        maWindows={[5, 10, 20]}
        dcapParams={DEFAULT_DCAP_PARAMS}
        viewportBars={120}
        followLatest
        basePeriod={BASE_PERIOD}
        basePeriodSource="config"
        baseHeight={Number.NaN}
        satellites={[
          { period: '1h' as never, height: Number.NaN },
          { period: '5m' as never, height: -1 },
          { period: '1d' as never, height: 0 },
        ]}
      >
        <div data-testid="base-child" />
      </Stack>
    );
    const { container } = render(bad);
    await flush();

    // 量测不可用（未提供 availableHeight）⇒ 保持净化后的请求高度（默认 420 / 180）
    expect(paneHeight(container, BASE_PERIOD, true)).toBe(420);
    for (const p of SATS) expect(paneHeight(container, p, false), p).toBe(DEFAULT_SATELLITE_HEIGHT);
  });

  it('B11 ADR-020：基准 barSpace 仍由 (宽度, 根数) 决定；改高（拖拽）不改写基准视口', async () => {
    const { container } = render(stackTree({}));
    await flush();

    const baseEl = container.querySelector<HTMLElement>('[data-testid="kline-chart"]')!;
    Object.defineProperty(baseEl, 'clientWidth', { configurable: true, value: 980 });
    const stub = baseChartStub();
    expect(stub, '基准 chart 实例必须存在').toBeTruthy();
    await act(async () => {
      await stub.__loader?.getBars({ type: 'init', callback: () => {} });
    });
    expect(stub.setBarSpace, '基准 barSpace = clamp(round(980/120))').toHaveBeenLastCalledWith(
      barSpaceForViewport(980, 120),
    );
    const callsBefore = stub.setBarSpace.mock.calls.length;

    dragBy(separatorFor(container, BASE_PERIOD, SAT0), 40);
    expect(
      stub.setBarSpace.mock.calls.length,
      '高度变化属布局面 ⇒ **不得**改写基准 barSpace（视口不变量）',
    ).toBe(callsBefore);
    expect(stub.setBarSpace).toHaveBeenLastCalledWith(barSpaceForViewport(980, 120));
  });

  it('B12 关闭态零残留：无栈/无 pane/无分隔条（DOM 与现状等价）', async () => {
    const off = (
      <Stack enabled={false} basePeriod={BASE_PERIOD} code="518880">
        <div data-testid="base-child" />
      </Stack>
    );
    const { container } = render(off);
    await flush();
    expect(container.querySelector('[data-mp-stack]')).toBeNull();
    expect(container.querySelector('[data-mp-pane]')).toBeNull();
    expect(container.querySelector('[data-mp-separator]')).toBeNull();
    expect(container.querySelector('[data-testid="base-child"]')).not.toBeNull();
  });

  it('B13 拖拽期望值必须夹在**配置域** [80,1200] —— 与渲染侧分配下界（基准 200/卫星 80）不得混同', async () => {
    const onHeightsChange = vi.fn();
    const { container } = render(stackTree({ onHeightsChange }));
    await flush();
    const before = allHeights(container);
    // 前置：拖拽基线 = 当前**分配**高度 ⇒ −200 必须把基准期望推到配置域下界之下（否则本用例不是域外用例）
    expect(
      before[BASE_PERIOD]! - 200,
      '前置：该拖拽必须把基准期望值推到配置域 [80,1200] 之外',
    ).toBeLessThan(HEIGHT_MIN);

    vi.useFakeTimers();
    dragBy(separatorFor(container, BASE_PERIOD, SAT0), -200);
    await act(async () => {
      vi.advanceTimersByTime(DRAG_DEBOUNCE_MS);
    });
    expect(onHeightsChange, '拖拽必须恰 1 次回调').toHaveBeenCalledTimes(1);

    // 核心判据（02-spec §6.1 尾注）：载荷每一项都 ∈ 配置域 [80,1200] ⇒ 据此构造的 PUT body 合法（不 400 回滚）
    const payload = onHeightsChange.mock.calls[0]![0] as Record<string, number>;
    expect(Object.keys(payload).sort()).toEqual(periodsAll().sort());
    for (const p of periodsAll()) {
      const v = payload[p]!;
      expect(Number.isInteger(v), `${p} 必须为整数 px，收到 ${v}`).toBe(true);
      expect(v, `${p} 必须 ≥ ${HEIGHT_MIN}（配置域下界），收到 ${v}`).toBeGreaterThanOrEqual(HEIGHT_MIN);
      expect(v, `${p} 必须 ≤ ${HEIGHT_MAX}（配置域上界），收到 ${v}`).toBeLessThanOrEqual(HEIGHT_MAX);
    }
  });

  // ── P5-E-1（架构裁决 2026-09-15，02-spec §6.2）：**持久化载荷恒合法，渲染分配可越域** ──────────
  //  缺陷形态：可用高度 ≥ ~1201px 时 `fit` 路径让**基准吸收余量** ⇒ 分配高度可 > `HEIGHT_MAX = 1200`
  //  ⇒ 载荷照抄分配 ⇒ `PUT /api/config/multi_period` 被配置面校验（`crates/web/src/dto.rs` 第 5 条）400 拒绝
  //  （用户表现「调大窗口后拖一下就保存失败」）。
  //  判据口径（**唯一**）：`payload == clamp(DOM 末次分配高度, HEIGHT_MIN, HEIGHT_MAX)`（分配本就在域内 ⇒ 逐值相等）；
  //  **且不得**为了把载荷凑进域而夹取**渲染分配**（那会破坏 `Σ == 可用高度` 不变量）。

  it('B14 超宽屏（可用 1800px）⇒ 基准吸收余量使**渲染分配** 1261 > 1200：载荷必须还是 clamp(分配) 且各项 ∈ [80,1200]', async () => {
    const AVAIL_TALL = 1800;
    const onHeightsChange = vi.fn();
    const { container } = render(stackTree({ onHeightsChange, availableHeight: AVAIL_TALL }));
    await flush();

    // 前置：该夹具确实走「基准吸收余量 ⇒ 分配越域」（否则本用例不构成越域用例）
    const before = allHeights(container);
    expect(
      before[BASE_PERIOD]!,
      `前置：基准吸收余量后分配必须 > HEIGHT_MAX（收到 ${before[BASE_PERIOD]}）`,
    ).toBeGreaterThan(HEIGHT_MAX);

    vi.useFakeTimers();
    dragBy(separatorFor(container, BASE_PERIOD, SAT0), 1);
    await act(async () => {
      vi.advanceTimersByTime(DRAG_DEBOUNCE_MS);
    });
    expect(onHeightsChange, '拖拽必须恰 1 次回调').toHaveBeenCalledTimes(1);

    const payload = onHeightsChange.mock.calls[0]![0] as Record<string, number>;
    const dom = allHeights(container);

    // ① 渲染侧不变量：Σ 分配 == 可用高度（**不得**因夹取载荷而破坏）
    expect(sumHeights(dom), 'Σ 渲染分配 == 可用高度（不变量不得被夹取破坏）').toBe(AVAIL_TALL);

    // ② 载荷域（核心，当前红）：每一项 ∈ [80,1200] ⇒ PUT body 合法（不 400 回滚）
    expect(Object.keys(payload).sort()).toEqual(periodsAll().sort());
    for (const p of periodsAll()) {
      const v = payload[p]!;
      expect(Number.isInteger(v), `${p} 必须为整数 px，收到 ${v}`).toBe(true);
      expect(v, `${p} 载荷必须 ≥ ${HEIGHT_MIN}，收到 ${v}`).toBeGreaterThanOrEqual(HEIGHT_MIN);
      expect(
        v,
        `${p} 载荷必须 ≤ ${HEIGHT_MAX}（超宽屏基准吸收余量 ⇒ 回流的是分配值），收到 ${v}；` +
          `口径要求 payload == clamp(DOM ${dom[p]}, ${HEIGHT_MIN}, ${HEIGHT_MAX}) = ${clampDomain(dom[p]!)}`,
      ).toBeLessThanOrEqual(HEIGHT_MAX);
    }

    // ③ 口径等式：payload == clamp(DOM 末次分配高度, 80, 1200)（渲染分配**允许**越域，载荷必须被夹）
    for (const p of periodsAll()) {
      expect(payload[p], `${p}：payload 必须 == clamp(DOM 分配, ${HEIGHT_MIN}, ${HEIGHT_MAX})`).toBe(
        clampDomain(dom[p]!),
      );
    }
    // 主语必须是**渲染分配**（`dom`）：02-spec §6.2 的两条**并列**契约 = 「渲染分配**可越域**（>1200）」
    // + 「持久化载荷被夹取（≤1200）」。本行钉前者（拖后分配仍越域 = 前置再现）；**不得**改回 `payload`
    // ——payload 已被 ②（≤1200）与 ③（== clamp(dom) = 1200）钉死，改回即自相矛盾（P5-E-2 裁决）。
    expect(dom[BASE_PERIOD]!, '基准 pane 是越域的那个（前置再现）').toBeGreaterThan(HEIGHT_MAX);
  });

  it('B15 1400px 容器 + 两颗 80px 卫星 ⇒ 基准分得 1240 > 1200：载荷 == clamp(分配)，Σ 分配仍 == 1400', async () => {
    const AVAIL_1400 = 1400;
    const periods = [BASE_PERIOD, SAT0, SAT1];
    const onHeightsChange = vi.fn();
    const { container } = render(
      stackTree({
        onHeightsChange,
        availableHeight: AVAIL_1400,
        // 卫星取配置域下界 80 ⇒ Σ 请求 = 420 + 80 + 80 = 580 ≤ 1400 ⇒ `fit` ⇒ 基准 = 1400 − 160 = 1240
        panes: [
          { period: SAT0, height: HEIGHT_MIN },
          { period: SAT1, height: HEIGHT_MIN },
        ],
      }),
    );
    await flush();

    const before = heightsOf(container, periods);
    expect(
      before[BASE_PERIOD]!,
      `前置：fit 路径基准吸收余量必须 > HEIGHT_MAX（收到 ${before[BASE_PERIOD]}）`,
    ).toBeGreaterThan(HEIGHT_MAX);
    expect(sumHeights(before), '前置：Σ 分配 == 可用高度').toBe(AVAIL_1400);

    vi.useFakeTimers();
    dragBy(separatorFor(container, BASE_PERIOD, SAT0), 1);
    await act(async () => {
      vi.advanceTimersByTime(DRAG_DEBOUNCE_MS);
    });
    expect(onHeightsChange, '拖拽必须恰 1 次回调').toHaveBeenCalledTimes(1);

    const payload = onHeightsChange.mock.calls[0]![0] as Record<string, number>;
    const dom = heightsOf(container, periods);

    expect(Object.keys(payload).sort()).toEqual([...periods].sort());
    expect(sumHeights(dom), 'Σ 渲染分配 == 可用高度（不变量不得被夹取破坏）').toBe(AVAIL_1400);

    for (const p of periods) {
      const v = payload[p]!;
      expect(Number.isInteger(v), `${p} 必须为整数 px，收到 ${v}`).toBe(true);
      expect(v, `${p} 载荷必须 ≥ ${HEIGHT_MIN}，收到 ${v}`).toBeGreaterThanOrEqual(HEIGHT_MIN);
      expect(
        v,
        `${p} 载荷必须 ≤ ${HEIGHT_MAX}，收到 ${v}；` +
          `口径要求 payload == clamp(DOM ${dom[p]}, ${HEIGHT_MIN}, ${HEIGHT_MAX}) = ${clampDomain(dom[p]!)}`,
      ).toBeLessThanOrEqual(HEIGHT_MAX);
      expect(payload[p], `${p}：payload 必须 == clamp(DOM 分配, ${HEIGHT_MIN}, ${HEIGHT_MAX})`).toBe(
        clampDomain(dom[p]!),
      );
    }
    expect(dom[BASE_PERIOD]!, '渲染分配允许越域（不得为凑载荷域而夹取分配）').toBeGreaterThan(HEIGHT_MAX);
  });
});

function expectHeightsWithin(root: HTMLElement, expected: Record<string, number>, tol: number): void {
  for (const p of periodsAll()) {
    const got = paneHeight(root, p, p === BASE_PERIOD);
    expect(Math.abs(got - expected[p]!), `${p}: ${got} vs ${expected[p]}`).toBeLessThanOrEqual(tol);
  }
}
