/**
 * dcap 前端接线 —— Toolbar 指标开关 + 参数面板 + KlineChart 独立副图 + 配置读写/韧性
 *
 * 本文件位置：`web/src/features/dashboard/dcapWiringP3.test.tsx`
 * 契约：`design/14-dcap-indicator/02-spec.md` §6（图表 C）/ §7（配置面 D）；`03-test-plan.md` T10/T11
 * 运行：cd web && npx vitest run src/features/dashboard/dcapWiringP3.test.tsx
 */
import { indicatorViewFromCalls, type IndicatorViewFilter } from '@/test/chartStoreStub';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { SymbolSnapshot } from '@/api/types';

const h = vi.hoisted(() => ({
  registerIndicator: vi.fn(),
  chartStub: {
    setSymbol: vi.fn(),
    setPeriod: vi.fn(),
    setDataLoader: vi.fn(),
    setBarSpace: vi.fn(),
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
  /** P0.1-D 补桩：`addOverlayIndicator` 的非空断言需要 `getIndicators({ name })`；
   *  由 create/remove 调用记录派生（语义见 `@/test/chartStoreStub`），不引入跨用例状态。 */
  getIndicators: vi.fn((filter?: IndicatorViewFilter) =>
    indicatorViewFromCalls(h.chartStub.createIndicator, h.chartStub.removeIndicator, filter ?? {})),
    setStyles: vi.fn(),
    subscribeAction: vi.fn(),
    unsubscribeAction: vi.fn(),
    scrollToRealTime: vi.fn(),
    setPaneOptions: vi.fn(),
    resize: vi.fn(),
    convertToPixel: vi.fn(() => ({ x: 0, y: 0 })),
    /** 状态差分：参数变化走 overrideIndicator（不 rebuild 指标/pane）。 */
    overrideIndicator: vi.fn(),
    /** warmup 热更新后的原地数据重载。 */
    resetData: vi.fn(),
  },
}));
vi.mock('klinecharts', () => ({
  init: vi.fn(() => h.chartStub),
  dispose: vi.fn(),
  registerIndicator: h.registerIndicator,
}));

import { stubApi } from '@/test/apiStub';
import { DashboardPage, readDcapParams } from './DashboardPage';
import { Toolbar } from './Toolbar';
import { KlineChart } from './KlineChart';
import { DCAP_INDICATOR_TEMPLATE, DEFAULT_DCAP_PARAMS } from '@/features/indicators/dcapIndicator';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';

const SYMBOLS: SymbolSnapshot[] = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
];

const DEFAULTS_ON = { ...DASHBOARD_DEFAULTS.indicators };

function fakeWs(): WsClient {
  return { subscribe: vi.fn(() => () => {}) } as unknown as WsClient;
}

function dcapCalls(): unknown[] {
  return h.chartStub.createIndicator.mock.calls.map((c) => c[0]);
}

function dcapCreateArgs(): unknown[][] {
  return h.chartStub.createIndicator.mock.calls.filter(
    (c) => (c[0] as { name?: string } | undefined)?.name === 'DCAP',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Toolbar（DCAP 默认关 + 参数面板入口）', () => {
  it('DCAP 进入指标列表且默认关（DASHBOARD_DEFAULTS.indicators.dcap = false）', () => {
    expect(DASHBOARD_DEFAULTS.indicators.dcap).toBe(false);
    const onToggle = vi.fn();
    render(
      <Toolbar
        period="15m"
        onPeriodChange={() => {}}
        chartTab="kline"
        onChartTabChange={() => {}}
        indicators={{ ...DEFAULTS_ON }}
        onToggleIndicator={onToggle}
        gridMode="single"
        onGridModeChange={() => {}}
        followLatest
        onBackToLatest={() => {}}
        maWindows={[5, 10, 20]}
        onSaveMaWindows={async () => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'DCAP' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith('dcap');
  });

  it('DCAP 参数面板（形态照 MA windows）内联在 Toolbar：展开可编辑 8 参并保存', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <Toolbar
        period="15m"
        onPeriodChange={() => {}}
        chartTab="kline"
        onChartTabChange={() => {}}
        indicators={{ ...DEFAULTS_ON }}
        onToggleIndicator={() => {}}
        gridMode="single"
        onGridModeChange={() => {}}
        followLatest
        onBackToLatest={() => {}}
        maWindows={[5, 10, 20]}
        onSaveMaWindows={async () => {}}
        dcapParams={{ ...DEFAULT_DCAP_PARAMS }}
        onSaveDcapParams={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'DCAP 配置' }));
    expect(screen.getByRole('group', { name: 'DCAP 参数' })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('dcap-input-n_l'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_DCAP_PARAMS, n_l: 120 }));
  });
});

describe('KlineChart（DCAP = 独立副图 pane + 3 figure + precision 5 + calcParams）', () => {
  function fakeFeed() {
    return {
      bars: [],
      hasMore: false,
      loadInitial: vi.fn(async () => {}),
      loadBefore: vi.fn(async () => 0),
      onRealtime: vi.fn(() => () => {}),
    };
  }

  function renderChart(indicators: Record<string, boolean>, dcapParams?: typeof DEFAULT_DCAP_PARAMS) {
    return render(
      <KlineChart
        feed={fakeFeed()}
        code="518880"
        period="15m"
        followLatest
        indicators={indicators as never}
        onManualZoom={() => {}}
        dcapParams={dcapParams}
      />,
    );
  }

  it('开 DCAP：注册（precision 5 模板）+ createIndicator(isStack=true) 建独立副图，calcParams 8 参', () => {
    renderChart({ ...DEFAULTS_ON, dcap: true });
    expect(h.registerIndicator).toHaveBeenCalledWith(DCAP_INDICATOR_TEMPLATE);
    expect(DCAP_INDICATOR_TEMPLATE.precision).toBe(5);
    const calls = dcapCreateArgs();
    // 建图 effect 与指标热切换 effect 在 mount 各跑一次同步（既有行为，MA 同）：
    // 两次参数必须**完全一致**（幂等），且均为独立副图（isStack=true）。
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c[0]).toEqual({ name: 'DCAP', calcParams: [8, 26, 60, 1, 1, 1, 1, 3] });
      expect(c[1]).toBe(true); // isStack=true ⇒ 独立副图 pane（不叠 candle_pane）
      expect((c[0] as { paneId?: string }).paneId).toBeUndefined();
    }
    expect(new Set(calls.map((c) => JSON.stringify(c))).size).toBe(1);
  });

  it('关 DCAP（默认）：不注册、不创建（不产生残留 pane）', () => {
    renderChart({ ...DEFAULTS_ON, dcap: false });
    expect(h.registerIndicator).not.toHaveBeenCalled();
    expect(dcapCreateArgs()).toHaveLength(0);
  });

  it('dcapParams 生效：n/r/smooth/m 全部按配置进 calcParams（非默认值）', () => {
    renderChart(
      { ...DEFAULTS_ON, dcap: true },
      { n_s: 5, n_m: 10, n_l: 20, r_s: 1.5, r_m: 1.2, r_l: 1.02, smooth: 0, m: 5 },
    );
    expect(dcapCreateArgs()[0]![0]).toEqual({
      name: 'DCAP',
      calcParams: [5, 10, 20, 1.5, 1.2, 1.02, 0, 5],
    });
  });

  it('其他指标不受扰：MA 仍叠主图（paneId=candle_pane），MACD/KDJ/BOLL 仍独立副图', () => {
    renderChart({ ...DEFAULTS_ON, dcap: true, macd: true });
    const byName = (n: string) =>
      h.chartStub.createIndicator.mock.calls.find((c) => (c[0] as { name?: string } | undefined)?.name === n);
    expect((byName('MA')![0] as { paneId?: string }).paneId).toBe('candle_pane');
    expect(byName('MACD')![1]).toBe(true);
    expect(dcapCalls().length).toBeGreaterThan(0);
  });
});

describe('DashboardPage（warmup 取数 + GET/PUT /api/config/dcap + 读取韧性）', () => {
  function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      getSymbols: vi.fn(async () => SYMBOLS),
      getKline: vi.fn(async () => [
        { ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
      ]),
      getSourcesHealth: vi.fn(async () => ({ window_secs: 3600, sources: [] })),
      ...overrides,
    });
  }

  async function renderPage(api: ApiClient) {
    render(
      <MemoryRouter>
        <DashboardPage api={api} ws={fakeWs()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
  }

  function klineLimits(api: ApiClient): number[] {
    return (api.getKline as unknown as { mock: { calls: Array<[{ limit?: number }]> } }).mock.calls.map(
      (c) => c[0].limit!,
    );
  }

  /** 按请求 `limit` 回相应根数（**升序** ts，与真实 `GET /api/kline` 同口径）的看板 api——
   *  用于验证「开 DCAP 后向前补取差额」的窗口口径（真实后端也是按 limit 返回根数）。 */
  function windowApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      getSymbols: vi.fn(async () => SYMBOLS),
      getSourcesHealth: vi.fn(async () => ({ window_secs: 3600, sources: [] })),
      getKline: vi.fn(async (req: { limit: number; before?: string }) => {
        const end = req.before ? Date.parse(req.before) : Date.UTC(2026, 0, 5, 0, 0);
        return Array.from({ length: req.limit }, (_, i) => ({
          ts: new Date(end - (req.limit - i) * 60_000).toISOString(),
          open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1,
        }));
      }) as unknown as ApiClient['getKline'],
      ...overrides,
    });
  }

  it('保存 dcap 参数（n_l 变化）⇒ **不重建 feed/图表**：setDataLoader 仅一次、只向前补取差额', async () => {
    // 回归：「保存 dcap 配置不得重置 pane 布局」的根因之一是 warmup 进 feed 身份 → feed 重建 → 整图 remount。
    const saveDcapConfig = vi.fn(async (p: never) => p);
    const api = windowApi({ saveDcapConfig: saveDcapConfig as never });
    await renderPage(api);
    fireEvent.click(screen.getByRole('button', { name: 'DCAP' })); // 开 DCAP（warmup 62）
    await waitFor(() => expect(klineLimits(api)).toEqual([120, 62]));
    expect(h.chartStub.setDataLoader).toHaveBeenCalledTimes(1); // 图表实例唯一

    fireEvent.click(screen.getByRole('button', { name: 'DCAP 配置' }));
    fireEvent.change(screen.getByTestId('dcap-input-n_l'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveDcapConfig).toHaveBeenCalledWith(expect.objectContaining({ n_l: 120, m: 3 })),
    );

    // n_l 60→120 ⇒ warmup 62→122 ⇒ 窗口 182→242：仅补差额 60（而非整图重建后的再一次全量取数）
    await waitFor(() => expect(klineLimits(api)).toEqual([120, 62, 60]));
    // 主图 chart 实例未重建（无 remount ⇒ pane 不被销毁重建 ⇒ 用户拖拽高度保持）
    expect(h.chartStub.setDataLoader).toHaveBeenCalledTimes(1);
  });

  it('DCAP 默认关 → 不 warmup：初始取数 limit = viewport_bars（120）', async () => {
    const api = fakeApi();
    await renderPage(api);
    expect(screen.getByRole('button', { name: 'DCAP' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(klineLimits(api)).toContain(120));
    expect(klineLimits(api).every((l) => l === 120)).toBe(true);
  });

  it('开 DCAP → 补取 warmup：加载窗口 = viewport_bars + (n_l + m − 1) = 120 + 62（不重建 feed）', async () => {
    const api = windowApi();
    await renderPage(api);
    expect(klineLimits(api)).toEqual([120]); // 关态口径不变（ADR-020：不因 dcap 扩大取数）
    fireEvent.click(screen.getByRole('button', { name: 'DCAP' }));
    // 不 remount（无又一次 120/182 全量取数）：以已加载最左 ts 为游标向前补取差额 (182 − 120) = 62；
    // 加载窗口合计 120 + 62 = 182 = viewport_bars + (n_l + m − 1) —— T10 口径（端态）不变。
    await waitFor(() => expect(klineLimits(api)).toEqual([120, 62]));
    const calls = (api.getKline as unknown as { mock: { calls: Array<[{ before?: string }]> } }).mock.calls;
    expect(calls[1]![0].before).toBe('2026-01-04T22:00:00.000Z'); // 最左已加载 bar（升序窗口首根：120 根 → 22:00Z）
  });

  it('warmup 跟随配置：viewport_bars=200 且库中 n_l=250/m=60 → 窗口 = 200 + 309', async () => {
    const api = windowApi({
      getKlineConfig: vi.fn(async () => ({ viewport_bars: 200 })),
      getDcapConfig: vi.fn(async () => ({
        n_s: 8, n_m: 26, n_l: 250, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 60,
      })),
    });
    await renderPage(api);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'DCAP 配置' })).toHaveTextContent('DCAP(8,26,250)'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'DCAP' }));
    // 120 = 默认视口首次取数（配置读回前的 120 兜底），200 = viewport_bars 读回后重建 feed（视图配置变），
    // 309 = 开 DCAP 后的 warmup 差额（窗口 200 + 309 = 509）
    await waitFor(() => expect(klineLimits(api)).toEqual([120, 200, 309]));
  });

  it('GET /api/config/dcap 读回后回显到面板；保存 → PUT（8 参）并乐观更新摘要', async () => {
    const saveDcapConfig = vi.fn(async (p: never) => p);
    const api = fakeApi({ saveDcapConfig: saveDcapConfig as never });
    await renderPage(api);
    fireEvent.click(screen.getByRole('button', { name: 'DCAP 配置' }));
    fireEvent.change(screen.getByTestId('dcap-input-n_s'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveDcapConfig).toHaveBeenCalledWith({
        n_s: 5, n_m: 26, n_l: 60, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'DCAP 配置' })).toHaveTextContent('DCAP(5,26,60)'),
    );
  });

  it('GET 读失败 → 保持默认参数（不阻塞看板、不回滚为非法值）', async () => {
    const api = fakeApi({
      getDcapConfig: vi.fn(async () => {
        throw new Error('network');
      }),
    });
    await renderPage(api);
    await waitFor(() => expect(api.getDcapConfig).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'DCAP 配置' })).toHaveTextContent('DCAP(8,26,60)');
  });
});

describe('readDcapParams（ADR-020 韧性：mount 读取重试，避免「重启回默认」假象）', () => {
  const params = { n_s: 5, n_m: 10, n_l: 20, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3 };

  it('前两次失败 + 第三次成功 → 返回服务端参数（瞬时失败被穿越）', async () => {
    const getDcapConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('flaky1'))
      .mockRejectedValueOnce(new Error('flaky2'))
      .mockResolvedValueOnce(params);
    const got = await readDcapParams({ getDcapConfig } as unknown as ApiClient, {
      backoffMs: [0, 0],
      sleep: async () => {},
    });
    expect(got).toEqual(params);
    expect(getDcapConfig).toHaveBeenCalledTimes(3);
  });

  it('全部失败 → 抛错（由调用方兜底为默认，不静默吞错）', async () => {
    const getDcapConfig = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(
      readDcapParams({ getDcapConfig } as unknown as ApiClient, { attempts: 2, backoffMs: [0], sleep: async () => {} }),
    ).rejects.toThrow('down');
    expect(getDcapConfig).toHaveBeenCalledTimes(2);
  });
});
