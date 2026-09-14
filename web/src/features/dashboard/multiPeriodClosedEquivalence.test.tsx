import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';

/**
 * 红测试（P1-A）：**T11 关闭态等价**（`03-test-plan.md` T11；口径 `02-spec.md` §7.5 + 实施计划 P1
 * 「`enabled=false` 时 DOM/行为与现状逐字节等价」）。
 *
 * 预期 red 理由：**容器/store 尚不存在**（解析 `./MultiPeriodChartStack` / `./multiPeriodStore` 失败）。
 *
 * 等价口径（本文件定义的判据，实现方不得放宽度量）：
 * 1. **DOM 结构**：`[data-region="main-chart"]` 子树结构指纹 == **现状冻结指纹**（下 `FROZEN_MAIN_CHART_FP`，
 *    取证于 P1 前 HEAD `d6462da`）⇒ 关闭态**不得新增任何包裹元素**（例：多周期容器必须是透传/直接返回 children）；
 *    指纹只含「标签层级 + `data-*` 属性 + `type`/`aria-pressed`」，**不含** class/id/style（避免样式类变动误报）。
 * 2. **调用序列/记账**：klinecharts `init` 恰 1 次（1 个实例）、`bar:` WS 订阅恰 1 个（仅基准周期 `15m`）、
 *    `getKline` 恰 1 次且 period = 默认周期、无任何其它周期的取数；**允许 1 次** `GET /api/config/multi_period`
 *    （配置读取本身不产生 K 线/WS 副作用——这是「服务端落配置」的必要读取，见 §2）。
 * 3. **零残留**：页面任意位置不得出现任何「卫星」标记元素；静默窗内不得再新增请求/订阅。
 *
 * toolbar 新增「多周期」开关**不在**本等价口径内（P1 允许开关控件出现）：只要求其默认关闭（`aria-pressed=false`），
 * 且不得产生任何图表/订阅/请求副作用。
 *
 * **P1-D-1 追加（P1-C 缺陷 D4：「Toolbar 开关缺 UI 级测试」）**：文件末尾 `D4` describe 段补齐
 * **UI 级**行为网 —— 点击 ⇒ 乐观 `aria-pressed=true`；PUT 失败 ⇒ 回滚 `false` 且无副作用；
 * PUT 成功 ⇒ `true`；再点击关闭 ⇒ `false` 且**零残留**（图表实例/WS 订阅/取数请求计数与初态一致）。
 * 与 `multiPeriodStore.test.ts`（store 往返）互补：本段从**页面**（Toolbar 点击）入口取证。
 */

// jsdom 无 canvas：klinecharts 整体打桩（同 DashboardPage.test.tsx）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  setBarSpace: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(chartStub.createIndicator, chartStub.removeIndicator, filter ?? {})),
  overrideIndicator: vi.fn(),
  resetData: vi.fn(),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setPaneOptions: vi.fn(),
  resize: vi.fn(),
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

import { DashboardPage } from './DashboardPage';
import { init, dispose } from 'klinecharts';
import { stubApi } from '@/test/apiStub';

/** 模块说明符：变量 specifier（红阶段模块缺失 ⇒ 逐用例 red，且不阻塞 tsc 静态解析）。 */
const STACK_SPECIFIER: string = './MultiPeriodChartStack';
const STORE_SPECIFIER: string = './multiPeriodStore';

async function loadStack(): Promise<React.ComponentType<any>> {
  const mod = (await import(/* @vite-ignore */ STACK_SPECIFIER)) as {
    MultiPeriodChartStack: React.ComponentType<any>;
  };
  return mod.MultiPeriodChartStack;
}

async function loadStoreClass(): Promise<new (deps: { api: ApiClient }) => unknown> {
  const mod = (await import(/* @vite-ignore */ STORE_SPECIFIER)) as {
    MultiPeriodStore: new (deps: { api: ApiClient }) => unknown;
  };
  return mod.MultiPeriodStore;
}

/**
 * 现状冻结指纹（P1 前 HEAD `d6462da`，jsdom + klinecharts 桩，单图模式、默认 15m、默认 MA 开）：
 * 取 `[data-region="main-chart"]` 子树。取证命令与原始输出见
 * `tester/evidence/263_p1a_multiperiod_config_red/`（本文件执行报告 §2）。
 */
const FROZEN_MAIN_CHART_FP = [
  '0:div[data-region=main-chart]',
  '1:div[data-region=sub-chart]',
  '1:div[data-testid=kline-chart]',
].join('\n');

/** 结构指纹：标签层级 + `data-*`/`type`/`aria-pressed` + 非空文本（忽略 class/id/style）。 */
function fingerprint(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node, depth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(`${depth}:text:${t}`);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    const attrs = Array.from(e.attributes)
      .filter((a) => a.name.startsWith('data-') || a.name === 'type' || a.name === 'aria-pressed')
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join(' ');
    parts.push(`${depth}:${e.tagName.toLowerCase()}${attrs ? `[${attrs}]` : ''}`);
    Array.from(e.childNodes).forEach((c) => walk(c, depth + 1));
  };
  walk(el, 0);
  return parts.join('\n');
}

const SYMBOLS = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
];

type WsHandler = (msg: any) => void;
/** 假 WsClient + 订阅登记表（可读 handler 数 ⇒ 订阅计数证据）。 */
interface FakeWs {
  handlers: Map<string, Set<WsHandler>>;
  subscribe: ReturnType<typeof vi.fn>;
  emit: (topic: string, msg: any) => void;
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
    emit(topic: string, msg: any) {
      handlers.get(topic)?.forEach((h) => h(msg));
    },
  } as unknown as FakeWs;
}

const DEFAULT_MP_CONFIG = {
  enabled: false,
  periods: ['1m'],
  heights: { '1m': 420 },
  indicators: ['dcap'],
};

/** 假 ApiClient：底座用契约 mock（`stubApi`），覆写取数/配置读取并保留调用计数。 */
function fakeApi() {
  const getKline = vi.fn(async (_q: { code: string; period: string }) => [
    { ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
  ]);
  const getMultiPeriodConfig = vi.fn(async () => DEFAULT_MP_CONFIG);
  const api = {
    ...stubApi({ getSymbols: vi.fn(async () => SYMBOLS), getKline }),
    getMultiPeriodConfig,
  } as unknown as ApiClient;
  return { api, getKline, getMultiPeriodConfig };
}

function barTopics(ws: FakeWs): string[] {
  return Array.from(ws.handlers.keys()).filter((t) => t.startsWith('bar:')).sort();
}

describe('T11 关闭态等价（P1：容器/store 尚不存在 ⇒ 红）', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderBase() {
    const ws = fakeWs();
    const { api, getKline, getMultiPeriodConfig } = fakeApi();
    const view = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws as unknown as WsClient} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await waitFor(() => expect(getKline).toHaveBeenCalled());
    return { ws, api, getKline, getMultiPeriodConfig, view };
  }

  it('关闭态 DOM 结构等价：main-chart 子树指纹 == 现状冻结指纹（不得新增包裹层）', async () => {
    await loadStack(); // 红阶段：容器模块不存在
    const { view } = await renderBase();
    const region = view.container.querySelector('[data-region="main-chart"]');
    expect(region).not.toBeNull();
    expect(fingerprint(region!)).toBe(FROZEN_MAIN_CHART_FP);
  });

  it('关闭态记账等价：1 个图表实例 / 1 个 bar: 订阅 / 仅基准周期 1 次取数（无多余 feed/订阅/请求）', async () => {
    await loadStack();
    await loadStoreClass();
    const { ws, getKline, getMultiPeriodConfig } = await renderBase();

    // 实例数：klinecharts.init 恰 1 次（无卫星实例、无重复 init）
    expect(init).toHaveBeenCalledTimes(1);
    // 订阅数：仅基准周期 1 个 bar: 订阅（+ 既有 quote）
    expect(barTopics(ws)).toEqual(['bar:518880:15m']);
    expect(Array.from(ws.handlers.keys()).filter((t) => t === 'quote')).toHaveLength(1);
    // 请求数：K 线恰 1 次、周期 = 默认 15m、无任何其它周期（卫星）取数
    expect(getKline).toHaveBeenCalledTimes(1);
    expect(getKline.mock.calls[0]![0]).toMatchObject({ code: '518880', period: '15m' });
    // 配置读取：允许至多 1 次 GET /api/config/multi_period（服务端落配置的必要读取）
    expect(getMultiPeriodConfig.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('关闭态容器透明：MultiPeriodChartStack(enabled=false) 直接透传 children，且不创建任何图表实例', async () => {
    const MultiPeriodChartStack = await loadStack();
    const { container } = render(
      <MemoryRouter>
        {React.createElement(
          MultiPeriodChartStack,
          { enabled: false },
          React.createElement('div', { 'data-sentinel': '1' }),
        )}
      </MemoryRouter>,
    );
    // 逐节点等价：除 children 外**不得**引入任何包裹元素/兄弟节点
    expect(container.innerHTML).toBe('<div data-sentinel="1"></div>');
    expect(init).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('关闭态零残留：页面无任何「卫星」标记元素；静默窗内无新增请求/订阅；开关默认关', async () => {
    await loadStack();
    const { ws, getKline, getMultiPeriodConfig, view } = await renderBase();

    // ① 页面任意位置无卫星标记（无卫星 DOM）
    const offenders = Array.from(view.container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((a) => /satellite|卫星/i.test(a.name) || /satellite|卫星/i.test(a.value))
        .map((a) => `${el.tagName}[${a.name}=${a.value}]`),
    );
    expect(offenders).toEqual([]);

    // ② 静默窗：不得有迟到/残留的取数或订阅（卫星实例初始化、额外 feed、额外 WS 订阅都会在此暴露）
    const klineCalls = getKline.mock.calls.length;
    const cfgCalls = getMultiPeriodConfig.mock.calls.length;
    const topics = JSON.stringify(barTopics(ws));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(getKline.mock.calls.length).toBe(klineCalls);
    expect(getMultiPeriodConfig.mock.calls.length).toBe(cfgCalls);
    expect(JSON.stringify(barTopics(ws))).toBe(topics);
    expect(init).toHaveBeenCalledTimes(1);

    // ③ 开关（若 P1 已加）：默认必须为关闭态
    for (const toggle of screen.queryAllByRole('button', { name: /多周期/ })) {
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// D4（P1-C 缺陷 D4）：Toolbar「多周期」开关的 **UI 级**行为网
// ─────────────────────────────────────────────────────────────────────────────
//
// 口径（`02-spec.md` §7.5「关闭多周期开关 ⇒ 完全回到现状：单实例、单周期，不得有残留实例/订阅/请求」
// + 实施计划「乐观更新 + 失败回滚」，形状照既有 MA/dcap 保存路径）：
//   ① 点击 ⇒ **乐观** `aria-pressed=true`（PUT 未决时即可见）；
//   ② PUT 失败 ⇒ 回滚 `aria-pressed=false` + **无副作用**（无新实例/订阅/取数）；
//   ③ PUT 成功 ⇒ 保持 `true`；
//   ④ 再点击关闭 ⇒ `false` 且**零残留**：`klinecharts.init` 计数、`bar:` WS 订阅、`getKline` 请求计数
//      与 `[data-region=main-chart]` 结构指纹均回到初态（并再次核对「无卫星标记元素」）。
// 红/绿说明（诚实声明）：本段是**覆盖缺口**补齐（P1-C D4：实现侧无 UI 级测试），
// 实现车道 P1 的乐观更新/回滚已落地 ⇒ 预期本段**立即可绿**（若红即为真实回归/缺陷）。

/** 可控 PUT：deferred 模式（用于观察「PUT 未决」窗口 + 注入失败）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type MpCfg = { enabled: boolean; periods: string[]; heights: Record<string, number>; indicators: string[] };
const MP_CFG_OFF: MpCfg = { enabled: false, periods: ['1m'], heights: { '1m': 420 }, indicators: ['dcap'] };
const MP_CFG_ON: MpCfg = { enabled: true, periods: ['1m'], heights: { '1m': 420 }, indicators: ['dcap'] };

describe('D4 Toolbar「多周期」开关 UI 级（乐观更新 / 失败回滚 / 关闭零残留）', () => {
  beforeEach(() => vi.clearAllMocks());

  /** 页面装配：PUT 由 deferred 完全受控（可观察未决窗口、可注入失败）。 */
  async function renderToggle() {
    const ws = fakeWs();
    const { api, getKline, getMultiPeriodConfig } = fakeApi();
    const pending: Array<ReturnType<typeof deferred<MpCfg>>> = [];
    const saveMultiPeriodConfig = vi.fn((_cfg: MpCfg) => {
      const d = deferred<MpCfg>();
      pending.push(d);
      return d.promise;
    });
    (api as unknown as { saveMultiPeriodConfig: typeof saveMultiPeriodConfig }).saveMultiPeriodConfig =
      saveMultiPeriodConfig;

    const view = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws as unknown as WsClient} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await waitFor(() => expect(getKline).toHaveBeenCalled());

    const toggle = screen.getByRole('button', { name: '多周期' });
    const region = view.container.querySelector('[data-region="main-chart"]');
    expect(region).not.toBeNull();
    return {
      ws, getKline, getMultiPeriodConfig, saveMultiPeriodConfig, pending, view, toggle, region: region!,
    };
  }

  /** 无卫星残留判据（与关闭态等价口径同源：任何位置不得出现 satellite/卫星 标记）。 */
  function satelliteMarkers(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((a) => /satellite|卫星/i.test(a.name) || /satellite|卫星/i.test(a.value))
        .map((a) => `${el.tagName}[${a.name}=${a.value}]`),
    );
  }

  it('点击 ⇒ 乐观 aria-pressed=true；PUT 失败 ⇒ 回滚 false 且无副作用（实例/订阅/取数不变）', async () => {
    const t = await renderToggle();
    expect(t.toggle, '初态：开关关闭').toHaveAttribute('aria-pressed', 'false');

    const fp0 = fingerprint(t.region);
    const init0 = (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const topics0 = barTopics(t.ws);
    const kline0 = t.getKline.mock.calls.length;

    // ① 点击 ⇒ 乐观更新（PUT 尚未 resolve）
    await userEvent.click(t.toggle);
    expect(t.toggle, '点击后必须**乐观**置 true（PUT 未决）').toHaveAttribute('aria-pressed', 'true');
    expect(t.saveMultiPeriodConfig).toHaveBeenCalledTimes(1);
    expect(t.saveMultiPeriodConfig.mock.calls[0]![0]).toMatchObject(MP_CFG_ON);
    expect(
      (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length, '未决窗口内不得新建图表实例').toBe(init0);
    expect(barTopics(t.ws), '未决窗口内不得新增 WS 订阅').toEqual(topics0);
    expect(t.getKline.mock.calls.length, '未决窗口内不得新增取数').toBe(kline0);

    // ② PUT 失败 ⇒ 回滚
    await act(async () => {
      t.pending[0]!.reject(new Error('模拟 PUT 失败：500'));
      await Promise.resolve();
    });
    await waitFor(() => expect(t.toggle).toHaveAttribute('aria-pressed', 'false'), { timeout: 2000 });
    expect(t.toggle, '失败后必须回滚为 false').toHaveAttribute('aria-pressed', 'false');
    expect(fingerprint(t.region), '失败回滚后主图 DOM 必须回到初态').toBe(fp0);
    expect(
      (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length, '失败回滚不得新建实例').toBe(init0);
    expect(barTopics(t.ws), '失败回滚不得残留订阅').toEqual(topics0);
    expect(t.getKline.mock.calls.length, '失败回滚不得新增取数').toBe(kline0);
    expect(satelliteMarkers(t.view.container), '失败回滚不得留下卫星节点').toEqual([]);
  });

  it('成功 ⇒ true；再点击关闭 ⇒ false 且零残留（实例/订阅/请求计数与初态一致）', async () => {
    const t = await renderToggle();
    const fp0 = fingerprint(t.region);
    const init0 = (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const topics0 = barTopics(t.ws);
    const kline0 = t.getKline.mock.calls.length;
    const cfgReads0 = t.getMultiPeriodConfig.mock.calls.length;

    // ③ 点击 → 乐观 true → PUT 成功 ⇒ 保持 true
    await userEvent.click(t.toggle);
    expect(t.toggle).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      t.pending[0]!.resolve(MP_CFG_ON);
      await Promise.resolve();
    });
    await waitFor(() => expect(t.saveMultiPeriodConfig).toHaveBeenCalledTimes(1));
    expect(t.toggle, 'PUT 成功后开关保持 true').toHaveAttribute('aria-pressed', 'true');

    // ④ 再点击关闭 → 乐观 false → PUT 成功 ⇒ false 且**零残留**
    await userEvent.click(t.toggle);
    expect(t.toggle, '关闭点击后必须乐观 false').toHaveAttribute('aria-pressed', 'false');
    await act(async () => {
      t.pending[1]!.resolve(MP_CFG_OFF);
      await Promise.resolve();
    });
    await waitFor(() => expect(t.saveMultiPeriodConfig).toHaveBeenCalledTimes(2));
    expect(t.toggle, '关闭后必须为 false').toHaveAttribute('aria-pressed', 'false');
    expect(t.saveMultiPeriodConfig.mock.calls[1]![0], '关闭必须落服务端（enabled=false）')
      .toMatchObject(MP_CFG_OFF);

    // 零残留：DOM 指纹 / 实例 / 订阅 / 取数 / 配置读取计数全部回到初态
    expect(fingerprint(t.region), '关闭后主图 DOM 指纹必须回到初态').toBe(fp0);
    expect(
      (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length, '关闭后实例数必须回到初态').toBe(init0);
    expect(barTopics(t.ws), '关闭后 WS 订阅必须回到初态').toEqual(topics0);
    expect(t.getKline.mock.calls.length, '关闭后取数计数必须回到初态').toBe(kline0);
    expect(t.getMultiPeriodConfig.mock.calls.length, '关闭后不得追加配置读取').toBe(cfgReads0);
    expect(satelliteMarkers(t.view.container), '关闭后不得有卫星标记元素').toEqual([]);

    // 静默窗：关闭后不得有迟到实例/订阅/取数
    const klineAfterClose = t.getKline.mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(t.getKline.mock.calls.length).toBe(klineAfterClose);
    expect(
      (init as unknown as ReturnType<typeof vi.fn>).mock.calls.length, '关闭后不得迟到新建实例').toBe(init0);
    expect(barTopics(t.ws)).toEqual(topics0);
  });
});
