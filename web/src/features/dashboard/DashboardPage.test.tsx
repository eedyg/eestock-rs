import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { SymbolSnapshot } from '@/api/types';

// jsdom 无 canvas：klinecharts 整体打桩（图表适配行为由 feed/store 测试覆盖）
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
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

const SYMBOLS = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
  { code: '161226', name: '白银LOF', enabled: true, last: 0.982, changePct: 1.15 },
  { code: '159776', name: '港股通医药', enabled: true, last: 0.874, changePct: -0.8 },
  { code: '512480', name: '半导体ETF', enabled: true, last: 1.023, changePct: 0.15 },
  { code: '159915', name: '创业板ETF', enabled: true, last: 2.156, changePct: -0.42 },
];

/** 含收藏的集合（收藏优先：513310 sort1、518880 sort2，非收藏在后） */
const FAV_SYMBOLS: SymbolSnapshot[] = [
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31, favorite: true, favoriteSort: 1 },
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62, favorite: true, favoriteSort: 2 },
  { code: '161226', name: '白银LOF', enabled: true, last: 0.982, changePct: 1.15 },
  { code: '159776', name: '港股通医药', enabled: true, last: 0.874, changePct: -0.8 },
  { code: '512480', name: '半导体ETF', enabled: true, last: 1.023, changePct: 0.15 },
  { code: '159915', name: '创业板ETF', enabled: true, last: 2.156, changePct: -0.42 },
];

type WsHandler = (msg: any) => void;
function fakeWs() {
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
  } as unknown as WsClient & { emit: (t: string, m: any) => void };
}

import { stubApi } from '@/test/apiStub';

function fakeApi(): ApiClient {
  return fakeApiWith(SYMBOLS);
}

function fakeApiWith(symbols: SymbolSnapshot[]): ApiClient {
  return stubApi({
    getSymbols: vi.fn(async () => symbols),
    getKline: vi.fn(async () => [
      { ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
    ]),
    getSourcesHealth: vi.fn(async () => ({ window_secs: 3600, sources: [] })),
  });
}

describe('DashboardPage（页面①集成：骨架锚点 + 数据流 + 交互）', () => {
  let ws: ReturnType<typeof fakeWs>;
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    ws = fakeWs();
    api = fakeApi();
  });

  async function renderPage() {
    render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
  }

  it('渲染 tangle 骨架区域锚点（dashboard/symbol-list/toolbar/main-chart/sub-chart）', async () => {
    const { container } = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    for (const region of ['dashboard', 'symbol-list', 'main-area', 'toolbar', 'main-chart', 'sub-chart']) {
      expect(container.querySelector(`[data-region="${region}"]`)).not.toBeNull();
    }
  });

  it('默认 15m 高亮；业务组件经 portal 挂入骨架区域', async () => {
    const { container } = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');
    // symbol-list 内容确实落在骨架锚点内
    const symRegion = container.querySelector('[data-region="symbol-list"]')!;
    expect(within(symRegion as HTMLElement).getByText('518880')).toBeInTheDocument();
  });

  it('点击标的切换选中', async () => {
    const { container } = render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('白银LOF')).toBeInTheDocument());
    await userEvent.click(screen.getByText('白银LOF'));
    const symRegion = container.querySelector('[data-region="symbol-list"]')!;
    await waitFor(() => {
      expect(within(symRegion as HTMLElement).getByText('白银LOF').closest('[data-selected="true"]')).not.toBeNull();
    });
  });

  it('搜索过滤标的列表', async () => {
    render(
      <MemoryRouter>
        <DashboardPage api={api} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/搜索/), '513');
    await waitFor(() => {
      expect(screen.queryByText('黄金ETF')).not.toBeInTheDocument();
      expect(screen.getByText('纳指ETF')).toBeInTheDocument();
    });
  });

  it('WS quote 推送实时更新列表价格', async () => {
    await renderPage();
    act(() => {
      ws.emit('quote', { type: 'quote', code: '518880', last: 2.5, changePct: 3.46 });
    });
    await waitFor(() => expect(screen.getByText('2.500')).toBeInTheDocument());
    expect(screen.getByText('+3.46%')).toBeInTheDocument();
  });

  it('宫格 2×2 渲染 4 格（code/名称/涨跌幅表头），点格回单图聚焦', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: '2×2' }));
    const grid = document.querySelector('[data-region="grid-view"]')!;
    await waitFor(() => {
      const cells = grid.querySelectorAll('[data-grid-cell]');
      expect(cells).toHaveLength(4);
    });
    // R1：2×2 → grid-rows-2（两行等高均分网格高度，末行不坍缩）
    expect(grid.classList.contains('grid-rows-2')).toBe(true);
    expect(within(grid as HTMLElement).getByText('港股通医药')).toBeInTheDocument();
    // 主图/副图被宫格替代
    expect(document.querySelector('[data-region="main-chart"]')).toBeNull();
    // 点格 → 选中该标的并回单图
    await userEvent.click(within(grid as HTMLElement).getByText('白银LOF'));
    await waitFor(() => {
      expect(document.querySelector('[data-region="main-chart"]')).not.toBeNull();
    });
  });

  it('2×3 宫格渲染 6 格', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: '2×3' }));
    const grid = document.querySelector('[data-region="grid-view"]')!;
    await waitFor(() => {
      expect(grid.querySelectorAll('[data-grid-cell]')).toHaveLength(6);
    });
    // R1：2×3 → grid-rows-3（三行等高均分网格高度，末行不坍缩）
    expect(grid.classList.contains('grid-rows-3')).toBe(true);
  });

  it('周期切换触发新周期数据加载', async () => {
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => {
      expect(api.getKline).toHaveBeenCalledWith(expect.objectContaining({ code: '518880', period: '1h' }));
    });
  });

  // ── Wave 3 页面① 看板收藏（F2 前端）──

  it('收藏置顶回归：收藏优先不影响宫格/单图/选中（Q4 仅影响 symbol-list）', async () => {
    const apiFav = fakeApiWith(FAV_SYMBOLS);
    render(
      <MemoryRouter>
        <DashboardPage api={apiFav} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    // symbol-list 收藏优先：513310(sort1) → 518880(sort2) → 非收藏在后
    const symRegion = document.querySelector('[data-region="symbol-list"]') as HTMLElement;
    const codes = [...symRegion.querySelectorAll('button')].map(
      (b) => b.querySelector('b')?.textContent,
    );
    expect(codes).toEqual(['513310', '518880', '161226', '159776', '512480', '159915']);
    // 宫格 2×2 仍渲染 4 格（收藏优先不破坏宫格）
    await userEvent.click(screen.getByRole('button', { name: '2×2' }));
    const grid = document.querySelector('[data-region="grid-view"]')!;
    await waitFor(() => expect(grid.querySelectorAll('[data-grid-cell]')).toHaveLength(4));
    // 点选某标的 → 回单图聚焦（选中行为不破坏）
    await userEvent.click(within(grid as HTMLElement).getByText('白银LOF'));
    await waitFor(() => expect(document.querySelector('[data-region="main-chart"]')).not.toBeNull());
  });

  it('看板收藏集成：点星 → 调 api.starSymbol + 行移入收藏区', async () => {
    const starSymbol = vi.fn(async () => {});
    const apiFav = stubApi({
      getSymbols: vi.fn(async () => FAV_SYMBOLS),
      getKline: vi.fn(async () => [
        { ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
      ]),
      getSourcesHealth: vi.fn(async () => ({ window_secs: 3600, sources: [] })),
      starSymbol,
    });
    render(
      <MemoryRouter>
        <DashboardPage api={apiFav} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '收藏 161226' }));
    expect(starSymbol).toHaveBeenCalledWith('161226');
    const symRegion = document.querySelector('[data-region="symbol-list"]') as HTMLElement;
    await waitFor(() => {
      expect(within(symRegion).getByText('白银LOF').closest('button')!.getAttribute('data-fav')).toBe('true');
    });
  });

  it('看板收藏集成：收藏行拖拽 → 调 api.reorderFavorites(新顺序)', async () => {
    const reorder = vi.fn(async () => {});
    const apiFav = stubApi({
      getSymbols: vi.fn(async () => FAV_SYMBOLS),
      getKline: vi.fn(async () => [
        { ts: '2026-09-04T02:00:00Z', open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100, amount: 105 },
      ]),
      getSourcesHealth: vi.fn(async () => ({ window_secs: 3600, sources: [] })),
      reorderFavorites: reorder,
    });
    render(
      <MemoryRouter>
        <DashboardPage api={apiFav} ws={ws} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('黄金ETF')).toBeInTheDocument());
    const source = document.querySelector('[data-handle="513310"]')!;
    const target = screen.getByText('黄金ETF').closest('button')!;
    const tf = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') };
    fireEvent.dragStart(source, { dataTransfer: tf });
    fireEvent.dragOver(target, { dataTransfer: tf });
    fireEvent.drop(target, { dataTransfer: tf });
    await waitFor(() => {
      expect(reorder).toHaveBeenCalledWith(['518880', '513310']);
    });
  });
});
