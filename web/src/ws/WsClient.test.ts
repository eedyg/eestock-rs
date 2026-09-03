import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsClient } from './WsClient';

/** 可控假 WebSocket：记录发送帧，手动触发 open/message/close */
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
  // 测试驱动
  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  emitMessage(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  emitClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function createClient(opts?: { minRetryMs?: number; maxRetryMs?: number }) {
  return new WsClient({
    url: 'ws://test/ws',
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    ...opts,
  });
}

describe('WsClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('连接建立后发送订阅帧（bar topic 拆解为 type/topic/code/period）', () => {
    const client = createClient();
    client.subscribe('bar:518880:15m', vi.fn());
    client.connect();
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.url).toBe('ws://test/ws');
    sock.emitOpen();
    expect(JSON.parse(sock.sent[0]!)).toEqual({
      type: 'subscribe', topic: 'bar', code: '518880', period: '15m',
    });
    client.close();
  });

  it('quote / source_health 等无参 topic 不带 code/period', () => {
    const client = createClient();
    client.subscribe('quote', vi.fn());
    client.subscribe('source_health', vi.fn());
    client.connect();
    FakeWebSocket.instances[0]!.emitOpen();
    const frames = FakeWebSocket.instances[0]!.sent.map((f) => JSON.parse(f));
    expect(frames).toContainEqual({ type: 'subscribe', topic: 'quote' });
    expect(frames).toContainEqual({ type: 'subscribe', topic: 'source_health' });
    client.close();
  });

  it('按 topic 分发：bar 消息只派发给匹配的 code+period 订阅者', () => {
    const client = createClient();
    const h1 = vi.fn();
    const h2 = vi.fn();
    client.subscribe('bar:518880:15m', h1);
    client.subscribe('bar:518880:5m', h2);
    client.connect();
    const sock = FakeWebSocket.instances[0]!;
    sock.emitOpen();
    const bar = { ts: '2026-09-04T02:00:00Z', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 };
    sock.emitMessage({ type: 'bar', code: '518880', period: '15m', bar });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h1.mock.calls[0]![0]).toMatchObject({ type: 'bar', code: '518880', bar });
    expect(h2).not.toHaveBeenCalled();
    client.close();
  });

  it('退订后不再派发，并发送 unsubscribe 帧', () => {
    const client = createClient();
    const h = vi.fn();
    const unsub = client.subscribe('quote', h);
    client.connect();
    const sock = FakeWebSocket.instances[0]!;
    sock.emitOpen();
    unsub();
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: 'unsubscribe', topic: 'quote' });
    sock.emitMessage({ type: 'quote', code: '518880', last: 2.4, changePct: 0.6 });
    expect(h).not.toHaveBeenCalled();
    client.close();
  });

  it('意外断线按指数退避重连（1s→2s→4s），重连后自动恢复订阅', () => {
    const client = createClient({ minRetryMs: 1000, maxRetryMs: 30000 });
    client.subscribe('quote', vi.fn());
    client.connect();
    FakeWebSocket.instances[0]!.emitOpen();
    FakeWebSocket.instances[0]!.emitClose(); // 意外断线

    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); // 1s → 第一次重连
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]!.emitClose(); // 又断
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1); // 2s → 第二次重连
    expect(FakeWebSocket.instances).toHaveLength(3);

    // 重连成功后恢复订阅
    FakeWebSocket.instances[2]!.emitOpen();
    const frames = FakeWebSocket.instances[2]!.sent.map((f) => JSON.parse(f));
    expect(frames).toContainEqual({ type: 'subscribe', topic: 'quote' });
    client.close();
  });

  it('退避封顶 maxRetryMs', () => {
    const client = createClient({ minRetryMs: 1000, maxRetryMs: 3000 });
    client.connect();
    FakeWebSocket.instances[0]!.emitOpen();
    for (let i = 0; i < 5; i++) {
      FakeWebSocket.instances.at(-1)!.emitClose();
      vi.advanceTimersByTime(3000);
    }
    // 每次都重连成功，间隔封顶 3s（若未封顶，第 5 次需 16s+）
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(6);
    client.close();
  });

  it('手动 close 后不再重连', () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]!.emitOpen();
    client.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('open 前订阅的 topic 在连接后统一补发；运行期订阅立即发送', () => {
    const client = createClient();
    client.subscribe('quote', vi.fn());
    client.connect();
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.sent).toHaveLength(0); // 未 open 不发送
    sock.emitOpen();
    expect(sock.sent).toHaveLength(1);
    client.subscribe('source_health', vi.fn());
    expect(sock.sent).toHaveLength(2);
    client.close();
  });

  it('状态回调：connecting → open → closed', () => {
    const client = createClient();
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));
    client.connect();
    FakeWebSocket.instances[0]!.emitOpen();
    FakeWebSocket.instances[0]!.emitClose();
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
    client.close();
  });
});
