import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { ApiClient, KlineQuery } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { Bar } from '@/api/types';
import { TimeshareChart } from './TimeshareChart';
import { stubApi } from '@/test/apiStub';
import { shanghaiDayKey } from '@/shell/session';
import { DEFAULT_KLINE_VIEWPORT_BARS, KlineDataFeed, TIMESHARE_1M_BARS } from './feed';

// 构造落在「今日」上海时段的 bar ts（避免真实时钟跨日边界导致过滤为空）
function shTodayUtcBase(): number {
  const [y, m, d] = shanghaiDayKey(new Date()).split('-').map(Number);
  // shanghaiDayKey 返回 "YYYY-M-D"（月份 0 基）；noUncheckedIndexedAccess 下解构为 number|undefined，故落 0 兜底
  return Date.UTC(y ?? 0, m ?? 0, d ?? 0, 4, 0, 0); // 上海中午 12:00 → UTC 04:00
}
function bar(minOffset: number, close: number): Bar {
  const ts = new Date(shTodayUtcBase() + minOffset * 60 * 1000).toISOString();
  return { ts, open: close, high: close, low: close, close, volume: 100, amount: close * 100 };
}

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

function fakeApi(bars: Bar[]): ApiClient {
  return stubApi({ getKline: vi.fn(async () => bars) });
}

describe('TimeshareChart（O1：盘中实时刷新——订阅 WS bar 帧，价格线+均价线随新数据更新）', () => {
  let ws: ReturnType<typeof fakeWs>;
  beforeEach(() => {
    ws = fakeWs();
  });

  it('mount 拉取当日 1m 快照并渲染价格/均价线末值', async () => {
    render(<TimeshareChart api={fakeApi([bar(0, 2.0), bar(1, 2.5)])} ws={ws} code="518880" />);
    await waitFor(() => expect(screen.getByText('2.500')).toBeInTheDocument());
    // 均价 = 累计成交额/累计成交量 = (200+250)/(100+100) = 2.25
    expect(screen.getByText(/均价 2\.250/)).toBeInTheDocument();
  });

  it('WS 新 bar 追加后末值/均价随之更新（盘中不重挂载也前进）', async () => {
    render(<TimeshareChart api={fakeApi([bar(0, 2.0), bar(1, 2.5)])} ws={ws} code="518880" />);
    await waitFor(() => expect(screen.getByText('2.500')).toBeInTheDocument());
    act(() => {
      ws.emit('bar:518880:1m', { type: 'bar', code: '518880', period: '1m', bar: bar(2, 2.7) });
    });
    await waitFor(() => expect(screen.getByText('2.700')).toBeInTheDocument());
    // 均价 = 累计成交额/累计成交量 = (200+250+270)/(100+100+100)=2.4
    expect(screen.getByText(/均价 2\.400/)).toBeInTheDocument();
  });

  it('WS 对同一 ts 的 bar 更新（未成型当根）会替换而非追加', async () => {
    render(<TimeshareChart api={fakeApi([bar(0, 2.0), bar(1, 2.5)])} ws={ws} code="518880" />);
    await waitFor(() => expect(screen.getByText('2.500')).toBeInTheDocument());
    act(() => {
      ws.emit('bar:518880:1m', { type: 'bar', code: '518880', period: '1m', bar: bar(1, 2.9) });
    });
    await waitFor(() => expect(screen.getByText('2.900')).toBeInTheDocument());
    expect(screen.queryByText('2.500')).not.toBeInTheDocument();
  });
});

// ── ADR-020 D7：分时图取数 = 当日 1m 全时段，与「K 线默认视口根数」解耦 ──
// 起因：feed.ts 默认 pageSize 由「2 交易日(1m=482)」改为「K 线根数 120」后，分时 Tab 会退化为
// 最近 ~120 分钟（半个交易日；A 股 1m 单日 ≈241 根）→ 分时线画不满当日。分时不具「视口」语义，
// 用户改「默认K线根数」不应改变分时 Tab，故固定 TIMESHARE_1M_BARS（≥241，当日全覆盖）。
describe('TimeshareChart（D7：当日 1m 全时段取数，不随 viewport_bars 配置变化）', () => {
  it('mount 取数 limit ≥ 一个交易日 1m 上限 241（旧口径 482 → 新默认 120 的退化必红）', async () => {
    const getKline = vi.fn(async (_q: KlineQuery) => [bar(0, 2.0)]);
    render(<TimeshareChart api={stubApi({ getKline })} ws={fakeWs()} code="518880" />);
    await waitFor(() => expect(getKline).toHaveBeenCalled());
    const q = getKline.mock.calls[0]![0];
    expect(q.period).toBe('1m');
    expect(q.limit).toBeGreaterThanOrEqual(241);
    // 与 K 线视口配置解耦：不得等于随配置变化的默认视口根数
    expect(q.limit).not.toBe(DEFAULT_KLINE_VIEWPORT_BARS);
  });
  it('解耦回归：若跟随 K 线视口（默认 120）则当日仅覆盖 ~半小时 —— 分时固定 500 且 ≥241', async () => {
    // 反证：跟随视口配置的 feed 请求 limit=120 < 241（当日画不满，属退化）
    const cfgApi = stubApi({ getKline: vi.fn(async () => []) });
    const followingFeed = new KlineDataFeed({ api: cfgApi, ws: fakeWs(), code: '518880', period: '1m' });
    await followingFeed.loadInitial();
    expect(cfgApi.getKline).toHaveBeenCalledWith(expect.objectContaining({ limit: DEFAULT_KLINE_VIEWPORT_BARS }));
    expect(DEFAULT_KLINE_VIEWPORT_BARS).toBeLessThan(241);
    followingFeed.dispose();

    // 实际分时组件固定 TIMESHARE_1M_BARS（≥241，当日全覆盖；与 viewport_bars 解耦）
    const getKline = vi.fn(async (_q: KlineQuery) => [bar(0, 2.0)]);
    render(<TimeshareChart api={stubApi({ getKline })} ws={fakeWs()} code="518880" />);
    await waitFor(() => expect(getKline).toHaveBeenCalled());
    expect(TIMESHARE_1M_BARS).toBeGreaterThanOrEqual(241);
    expect(getKline.mock.calls[0]![0].limit).toBe(TIMESHARE_1M_BARS);
  });
});
