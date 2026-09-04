import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardStore } from './store';
import { KlineDataFeed } from './feed';
import type { ApiClient } from '@/api/client';
import type { Bar, SymbolSnapshot } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';

const SYMBOLS: SymbolSnapshot[] = [
  { code: '518880', name: '黄金ETF', last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', last: 1.587, changePct: -0.31 },
  { code: '161226', name: '白银LOF', last: 0.982, changePct: 1.15 },
];

function bar(ts: string, close = 1): Bar {
  return { ts, open: close, high: close, low: close, close, volume: 100, amount: 1000 };
}

function fakeApi(overrides?: Partial<ApiClient>): ApiClient {
  return stubApi({
    getSymbols: vi.fn(async () => SYMBOLS),
    getKline: vi.fn(async () => []),
    getSourcesHealth: vi.fn(async () => ({ window_secs: 3600, sources: [] })),
    ...overrides,
  });
}

type WsHandler = (msg: any) => void;
function fakeWs() {
  const handlers = new Map<string, Set<WsHandler>>();
  const ws = {
    handlers,
    subscribe: vi.fn((topic: string, h: WsHandler) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    emit(topic: string, msg: any) {
      handlers.get(topic)?.forEach((h) => h(msg));
    },
  };
  return ws as unknown as WsClient & { emit: (t: string, m: any) => void; handlers: Map<string, Set<WsHandler>> };
}

describe('DashboardStore', () => {
  let ws: ReturnType<typeof fakeWs>;
  beforeEach(() => {
    ws = fakeWs();
  });

  it('init：加载标的、默认选中首只、订阅 quote 推送', async () => {
    const api = fakeApi();
    const store = new DashboardStore({ api, ws });
    expect(store.state.symbolsStatus).toBe('loading');
    await store.init();
    expect(store.state.symbolsStatus).toBe('ready');
    expect(store.state.symbols).toHaveLength(3);
    expect(store.state.selected).toBe('518880');
    expect(ws.subscribe).toHaveBeenCalledWith('quote', expect.any(Function));
    store.dispose();
  });

  it('init：标的加载失败 → error 态', async () => {
    const api = fakeApi({ getSymbols: vi.fn(async () => { throw new Error('boom'); }) });
    const store = new DashboardStore({ api, ws });
    await store.init();
    expect(store.state.symbolsStatus).toBe('error');
    store.dispose();
  });

  it('init：空注册集合 → ready 且 selected 为 null（空态由组件表达）', async () => {
    const api = fakeApi({ getSymbols: vi.fn(async () => []) });
    const store = new DashboardStore({ api, ws });
    await store.init();
    expect(store.state.symbolsStatus).toBe('ready');
    expect(store.state.selected).toBeNull();
    store.dispose();
  });

  it('默认周期 15m、单图模式、跟随最新（定稿默认值）', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    expect(store.state.period).toBe('15m');
    expect(store.state.gridMode).toBe('single');
    expect(store.state.followLatest).toBe(true);
    store.dispose();
  });

  it('quote 推送更新对应标的最新价/涨跌幅', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    ws.emit('quote', { type: 'quote', code: '513310', last: 1.6, changePct: 0.5 });
    const s = store.state.symbols.find((x) => x.code === '513310')!;
    expect(s.last).toBe(1.6);
    expect(s.changePct).toBe(0.5);
    // 其他标的不受影响
    expect(store.state.symbols.find((x) => x.code === '518880')!.last).toBe(2.431);
    store.dispose();
  });

  it('selectSymbol 切换选中并重置跟随最新', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    store.noteManualZoom();
    expect(store.state.followLatest).toBe(false);
    store.selectSymbol('161226');
    expect(store.state.selected).toBe('161226');
    expect(store.state.followLatest).toBe(true);
    store.dispose();
  });

  it('setPeriod 切换周期', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    store.setPeriod('5m');
    expect(store.state.period).toBe('5m');
    store.dispose();
  });

  it('宫格切换不丢状态（周期/选中/搜索保持）', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    store.setPeriod('1h');
    store.selectSymbol('513310');
    store.setSearch('纳指');
    store.setGridMode('grid2x2');
    expect(store.state.gridMode).toBe('grid2x2');
    store.setGridMode('grid2x3');
    store.setGridMode('single');
    expect(store.state.period).toBe('1h');
    expect(store.state.selected).toBe('513310');
    expect(store.state.search).toBe('纳指');
    store.dispose();
  });

  it('搜索过滤：code/名称模糊匹配，大小写不敏感', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    store.setSearch('518');
    expect(store.filteredSymbols.map((s) => s.code)).toEqual(['518880']);
    store.setSearch('etf');
    expect(store.filteredSymbols.map((s) => s.code)).toEqual(['518880', '513310']);
    store.setSearch('');
    expect(store.filteredSymbols).toHaveLength(3);
    store.dispose();
  });

  it('手动缩放 → 停止跟随；回到最新 → 恢复跟随', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    store.noteManualZoom();
    expect(store.state.followLatest).toBe(false);
    store.backToLatest();
    expect(store.state.followLatest).toBe(true);
    store.dispose();
  });

  it('状态变更通知订阅者', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    const listener = vi.fn();
    store.subscribe(listener);
    await store.init();
    store.setPeriod('1m');
    expect(listener).toHaveBeenCalled();
    store.dispose();
  });

  it('dispose 后不再响应 WS 推送', async () => {
    const store = new DashboardStore({ api: fakeApi(), ws });
    await store.init();
    store.dispose();
    ws.emit('quote', { type: 'quote', code: '518880', last: 9.9, changePct: 9 });
    expect(store.state.symbols.find((s) => s.code === '518880')!.last).toBe(2.431);
  });
});

describe('KlineDataFeed（图表无关的数据流：初始加载/向前分页/实时追加）', () => {
  let ws: ReturnType<typeof fakeWs>;
  beforeEach(() => {
    ws = fakeWs();
  });

  it('loadInitial 拉取最新 pageSize 根并订阅 bar topic', async () => {
    const api = fakeApi({
      getKline: vi.fn(async () => [bar('2026-09-04T01:00:00Z'), bar('2026-09-04T01:15:00Z')]),
    });
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', pageSize: 500 });
    await feed.loadInitial();
    expect(api.getKline).toHaveBeenCalledWith({ code: '518880', period: '15m', limit: 500 });
    expect(feed.bars).toHaveLength(2);
    expect(feed.status).toBe('ready');
    expect(ws.subscribe).toHaveBeenCalledWith('bar:518880:15m', expect.any(Function));
    feed.dispose();
  });

  it('loadBefore 以最早 bar 的 ts 为游标向前翻页并去重拼接', async () => {
    const pages: Record<string, Bar[]> = {
      initial: [bar('2026-09-04T01:45:00Z'), bar('2026-09-04T02:00:00Z'), bar('2026-09-04T02:15:00Z')],
      older: [bar('2026-09-04T01:15:00Z'), bar('2026-09-04T01:30:00Z'), bar('2026-09-04T01:45:00Z')],
    };
    const api = fakeApi({
      getKline: vi.fn(async (q: { before?: string }) => (q.before ? pages.older! : pages.initial!)),
    });
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', pageSize: 3 });
    await feed.loadInitial();
    await feed.loadBefore();
    expect(api.getKline).toHaveBeenLastCalledWith({
      code: '518880', period: '15m', before: '2026-09-04T01:45:00Z', limit: 3,
    });
    // 游标重叠的 01:45 去重，无重复无缺漏
    expect(feed.bars.map((b) => b.ts)).toEqual([
      '2026-09-04T01:15:00Z', '2026-09-04T01:30:00Z', '2026-09-04T01:45:00Z',
      '2026-09-04T02:00:00Z', '2026-09-04T02:15:00Z',
    ]);
    feed.dispose();
  });

  it('返回不足 pageSize 时 hasMore=false，之后 loadBefore 不再发请求', async () => {
    const api = fakeApi({ getKline: vi.fn(async () => [bar('2026-09-04T02:00:00Z')]) });
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', pageSize: 500 });
    await feed.loadInitial();
    expect(feed.hasMore).toBe(false); // 1 < 500
    const calls = (api.getKline as ReturnType<typeof vi.fn>).mock.calls.length;
    await feed.loadBefore();
    expect((api.getKline as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    feed.dispose();
  });

  it('空数据 → empty 态；加载失败 → error 态', async () => {
    const emptyApi = fakeApi();
    const feed1 = new KlineDataFeed({ api: emptyApi, ws, code: '518880', period: '15m' });
    await feed1.loadInitial();
    expect(feed1.status).toBe('empty');
    feed1.dispose();

    const errApi = fakeApi({ getKline: vi.fn(async () => { throw new Error('net'); }) });
    const feed2 = new KlineDataFeed({ api: errApi, ws, code: '518880', period: '15m' });
    await feed2.loadInitial();
    expect(feed2.status).toBe('error');
    feed2.dispose();
  });

  it('WS 实时：新 bar ts 更晚 → append；同 ts → update 替换；更早 → 忽略', async () => {
    const api = fakeApi({
      getKline: vi.fn(async () => [bar('2026-09-04T02:00:00Z', 1), bar('2026-09-04T02:15:00Z', 2)]),
    });
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m' });
    await feed.loadInitial();

    // update：当根未成型 bar 闪动更新
    ws.emit('bar:518880:15m', { type: 'bar', code: '518880', period: '15m', bar: bar('2026-09-04T02:15:00Z', 2.5) });
    expect(feed.bars).toHaveLength(2);
    expect(feed.bars[1]!.close).toBe(2.5);

    // append：新周期 bar
    ws.emit('bar:518880:15m', { type: 'bar', code: '518880', period: '15m', bar: bar('2026-09-04T02:30:00Z', 3) });
    expect(feed.bars).toHaveLength(3);
    expect(feed.bars[2]!.close).toBe(3);

    // ignore：迟到旧 bar
    ws.emit('bar:518880:15m', { type: 'bar', code: '518880', period: '15m', bar: bar('2026-09-04T02:00:00Z', 99) });
    expect(feed.bars[0]!.close).toBe(1);
    feed.dispose();
  });

  it('retry 从 error 态恢复重新加载', async () => {
    let fail = true;
    const api = fakeApi({
      getKline: vi.fn(async () => {
        if (fail) throw new Error('net');
        return [bar('2026-09-04T02:00:00Z')];
      }),
    });
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m' });
    await feed.loadInitial();
    expect(feed.status).toBe('error');
    fail = false;
    await feed.retry();
    expect(feed.status).toBe('ready');
    expect(feed.bars).toHaveLength(1);
    feed.dispose();
  });
});
