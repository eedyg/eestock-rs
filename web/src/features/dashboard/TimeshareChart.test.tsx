import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { Bar } from '@/api/types';
import { TimeshareChart } from './TimeshareChart';
import { stubApi } from '@/test/apiStub';
import { shanghaiDayKey } from '@/shell/session';

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
