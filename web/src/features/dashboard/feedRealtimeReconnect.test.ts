/**
 * 红测试（阶段 1，Red）—— T-R2「WS 重连后增量补偿：断口不残留空洞」。
 *
 * 本文件位置：`web/src/features/dashboard/feedRealtimeReconnect.test.ts`
 * 权威依据：
 *  - 诊断：`tester/report/055_kline_realtime_bar_append_diagnosis.md` §6(a)1「书签式补偿」、§6(b)
 *  - 设计：`tester/design/055_realtime_append_red_test_design.md` §1 T-R1-c（重连后补齐）
 *  - 任务口径（架构师裁决）②：每分钟兜底与 WS **复用同一 applyRealtime**、按 ts 唯一键合并
 *    （更晚 append / 同 ts 覆盖 / 更早忽略）。
 *
 * 钉死的判据（当前实现必红：重连后没有任何补偿动作，断连期间漏掉的 bar 永久缺失）：
 *  - WS 断线（未收到 close 的意外断线路径由既有 onclose→指数退避重连覆盖；半开看门狗见 T-R1）期间
 *    错过 N 根 bar ⇒ 重连**成功后**必须做一次 HTTP 增量补偿，把 feed.bars 补齐到最新（无空洞）；
 *  - 合并必须幂等：补偿返回的窗口里包含「已知 bar」时不得产生重复行（按 ts 唯一键）；
 *  - 新增 bar 必须经 `feed.onRealtime` 下发给图表（否则图上看不到补齐的段，只是内存里的空洞消失）。
 *
 * seam：以**真实 WsClient**（可编程 fake WebSocket 作传输）+ 假 ApiClient 驱动，不绑定补偿的接线方式
 * （onStatusChange / 新回调 / 其它）——只断言「重连后 feed.bars 被补齐且经同一实时通路下发」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsClient } from '@/ws/WsClient';
import { KlineDataFeed } from './feed';
import type { ApiClient } from '@/api/client';
import type { Bar } from '@/api/types';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  emitClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function lastSock(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1);
  if (!s) throw new Error('no FakeWebSocket instance');
  return s;
}

function mkBar(ts: string, close = 1): Bar {
  return { ts, open: close, high: close + 0.01, low: close - 0.01, close, volume: 100, amount: 100 };
}

const T = (mm: number) => `2026-09-14T01:${String(mm).padStart(2, '0')}:00Z`;

/** 已加载 4 根（01:50–01:53）；断线期间 DB 又出了 01:54/01:55/01:56（补偿窗口含已知 bar ⇒ 顺带验证幂等） */
const LOADED: Bar[] = [mkBar(T(50), 1.0), mkBar(T(51), 1.1), mkBar(T(52), 1.2), mkBar(T(53), 1.3)];
const LATEST_WINDOW: Bar[] = [
  mkBar(T(51), 1.1), // 已知（同 ts 同 OHLC）
  mkBar(T(52), 1.2), // 已知
  mkBar(T(53), 1.3), // 已知（= 断线前最后一根）
  mkBar(T(54), 1.4), // 断线期间错过
  mkBar(T(55), 1.5), // 断线期间错过
  mkBar(T(56), 1.6), // 断线期间错过（最新）
];

/** 冲刷若干次微任务 + 定时器（补偿可能带 0ms 去抖 / 内部 await） */
async function settle() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(50);
}

async function setup(getKlineImpl: (n: number, q: { code: string; period: string; before?: string; limit?: number }) => Promise<Bar[]>) {
  let n = 0;
  const getKline = vi.fn(async (q: { code: string; period: string; before?: string; limit?: number }) => {
    n += 1;
    return getKlineImpl(n, q);
  });
  const api = { getKline } as unknown as ApiClient;
  const ws = new WsClient({
    url: 'ws://test/ws',
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    minRetryMs: 1000,
  });
  const feed = new KlineDataFeed({ api, ws, code: '518880', period: '1m', viewportBars: 4 });
  await feed.loadInitial();
  ws.connect();
  lastSock().emitOpen();
  return { getKline, ws, feed };
}

describe('T-R2 重连后 HTTP 增量补偿（断口不残留空洞）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-R2-a 断线期间错过 3 根 bar → 重连后 dataList 补齐到最新（无空洞、无重复）', async () => {
    const { ws, feed } = await setup(async (n) => (n === 1 ? LOADED : LATEST_WINDOW));
    const rtBars: Bar[] = [];
    feed.onRealtime((b) => rtBars.push(b));
    expect(feed.bars.map((b) => b.ts)).toEqual(LOADED.map((b) => b.ts));

    // 意外断线 → 既有指数退避（1s）重连
    lastSock().emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    const s1 = lastSock();
    expect(s1).not.toBe(FakeWebSocket.instances[0]);
    s1.emitOpen();
    await settle();

    // 断口补齐：01:50 … 01:56 连续（无缺失、无重复、升序）
    const ts = feed.bars.map((b) => b.ts);
    expect(ts).toEqual([T(50), T(51), T(52), T(53), T(54), T(55), T(56)]);
    expect(new Set(ts).size).toBe(ts.length);
    expect(feed.bars.at(-1)!.ts).toBe(T(56)); // 已追到最新
    // 补齐的每一根都必须经实时通路下发（否则图表仍看不到这一段）
    expect(rtBars.map((b) => b.ts)).toEqual([T(54), T(55), T(56)]);

    feed.dispose();
    ws.close();
  });

  it('T-R2-b 补偿窗口只含已知 bar（同 ts 同 OHLC）→ 幂等：不重复、不改变既有数据', async () => {
    const { ws, feed } = await setup(async (n) => (n === 1 ? LOADED : LOADED));
    lastSock().emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    lastSock().emitOpen();
    await settle();

    expect(feed.bars.map((b) => b.ts)).toEqual(LOADED.map((b) => b.ts));
    expect(feed.bars).toHaveLength(4);
    expect(feed.bars.at(-1)!.close).toBe(1.3);

    feed.dispose();
    ws.close();
  });
});
