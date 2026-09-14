/**
 * 红测试（阶段 1，Red）—— T-R1「WS 入站静默自愈 + 重连后 HTTP 增量补偿」。
 *
 * 本文件位置：`web/src/ws/WsClient.watchdog.test.ts`
 * 权威依据：
 *  - 诊断：`tester/report/055_kline_realtime_bar_append_diagnosis.md` §0 R1（阻断级）／§3.4 半开连接实测
 *  - 设计：`tester/design/055_realtime_append_red_test_design.md` §1 T-R1
 *  - 任务口径（架构师裁决）：①绝不自动把非跟随态视口拉回最右；②每分钟兜底与 WS 复用同一 applyRealtime、
 *    按 ts 唯一键合并；③非交易时段跳过分钟轮询；④失败指数退避 1→2→4→8→60s、成功复位、不弹错。
 *
 * 钉死的判据（当前实现必红：无心跳、无看门狗）：
 *  - 入站静默（自「最近一次入站帧」起算）达到阈值 ⇒ 必须主动 close() 并进入**既有**
 *    指数退避重连（`minRetryMs/maxRetryMs` 语义不变）。阈值口径（阶段 2 简化）= 按交易时段门控的
 *    **固定值**：交易时段 15s / 非交易时段 300s；任一入站帧复位静默计时；**不引入应用层心跳帧**；
 *  - 半开连接（readyState 已 CLOSING、`onclose` 永不到来）也必须进入重连路径，不得因 `readyState <= 1` /
 *    `socket` 非空而早退；连接状态不得长期滞留 `open`（顶栏 pill「已连接」不得撒谎）；
 *  - 持续有入站帧时不得误触发（阈值以「最近一次入站帧」为基准）；
 *  - 重连成功后必须对当前 (code, period) 做**一次 HTTP 增量补偿**（取最新窗口，无 `before` 游标），
 *    否则「重连上了但仍缺一段」。补偿经 feed（KlineDataFeed）发起：本用例以**真实 WsClient** 作传输，
 *    不绑定补偿的接线方式（onStatusChange / 新回调 / 其它），只断言「重连后确实发生了一次最新窗口拉取」。
 *
 * seam 约定（本红测试要求的最小接口面，均为既有 public API，无新增 ABI）：
 *  - `new WsClient({ url, webSocketImpl, minRetryMs, maxRetryMs })`：用可编程 fake WebSocket + 假时钟驱动；
 *  - 看门狗阈值为**默认行为**（交易时段 15s / 非交易时段 300s，由 `@/shell/session` 门控），
 *    不要求新增可注入选项：用例以 `vi.setSystemTime(TRADING_NOW/OFFHOURS_NOW)` 钉死门控输入即可。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsClient } from './WsClient';
import { KlineDataFeed } from '@/features/dashboard/feed';
import type { ApiClient } from '@/api/client';
import type { Bar } from '@/api/types';

/** 静默阈值（**交易时段**，设计文档取值 15s）。 */
const SILENCE_MS = 15_000;
/** 静默阈值（**非交易时段**，门控固定值，阶段 2 简化）。 */
const OFFHOURS_SILENCE_MS = 300_000;
/** 交易时段锚点：2026-09-14（周一）10:00 北京时间 ⇒ tradingSession()==='trading'。 */
const TRADING_NOW = new Date('2026-09-14T02:00:00Z');
/** 非交易时段锚点：2026-09-12（周六）10:00 北京时间 ⇒ tradingSession()==='closed'。 */
const OFFHOURS_NOW = new Date('2026-09-12T02:00:00Z');

/**
 * 可控假 WebSocket：
 *  - `mode='normal'`：close() 立即派发 onclose（真实浏览器语义）；
 *  - `mode='hung'`：close() 只把 readyState 置为 CLOSING(2)、**永不**派发 onclose（半开连接复现）。
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  mode: 'normal' | 'hung' = 'normal';
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
    this.closeCalls += 1;
    if (this.readyState >= 2) return; // 已 CLOSING/CLOSED：不重复 close
    if (this.mode === 'hung') {
      this.readyState = 2; // CLOSING：onclose 永不派发（半开）
      return;
    }
    this.readyState = 3; // CLOSED → 真实浏览器会派发 onclose
    this.onclose?.();
  }
  /** 测试驱动 */
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

function lastSock(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1);
  if (!s) throw new Error('no FakeWebSocket instance');
  return s;
}

function newClient(): WsClient {
  return new WsClient({
    url: 'ws://test/ws',
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    minRetryMs: 1000,
    maxRetryMs: 30_000,
  });
}

function topicsSent(sock: FakeWebSocket): string[] {
  return sock.sent
    .map((f) => JSON.parse(f) as { type: string; topic: string })
    .filter((f) => f.type === 'subscribe')
    .map((f) => f.topic);
}

function mkBar(ts: string, close = 1): Bar {
  return { ts, open: close, high: close + 0.01, low: close - 0.01, close, volume: 100, amount: 100 };
}

describe('T-R1 WS 入站静默自愈（看门狗 → 主动重连）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_NOW); // 既有用例的 15s 口径 = 交易时段门控；钉死时钟避免墙钟依赖
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-R1-a 静默达阈值 → 主动 close() 并进入既有指数退避重连（重连后重发全部 subscribe 帧）', () => {
    const client = newClient();
    client.subscribe('bar:518880:15m', vi.fn());
    client.subscribe('quote', vi.fn());
    client.connect();
    const s0 = lastSock();
    s0.emitOpen();
    expect(topicsSent(s0).sort()).toEqual(['bar', 'quote']);

    // 静默 14s（未达阈值）→ 不得关闭
    vi.advanceTimersByTime(SILENCE_MS - 1_000);
    expect(s0.closeCalls).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 达阈值 → 必须主动 close（当前实现无看门狗 ⇒ 此断言红）
    vi.advanceTimersByTime(1_000);
    expect(s0.closeCalls).toBe(1);
    // 不得继续自称已连接（用户症状：顶栏 pill 始终「已连接」）
    expect(client.connectionStatus).not.toBe('open');

    // 既有指数退避（minRetryMs=1000）→ 1s 后重连
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const s1 = lastSock();
    expect(s1).not.toBe(s0);

    // 重连成功后必须重发全部 topic 的 subscribe 帧
    s1.emitOpen();
    expect(topicsSent(s1).sort()).toEqual(['bar', 'quote']);
    client.close();
  });

  it('T-R1-b 半开连接（readyState 已 CLOSING、onclose 永不到来）→ 仍必须重连，不得早退', () => {
    const client = newClient();
    client.subscribe('quote', vi.fn());
    client.connect();
    const s0 = lastSock();
    s0.mode = 'hung'; // close() 后 onclose 永不派发
    s0.emitOpen();

    vi.advanceTimersByTime(SILENCE_MS);
    expect(s0.closeCalls).toBe(1); // 看门狗必须主动 close
    expect(s0.readyState).toBe(2); // CLOSING：onclose 不会来
    expect(client.connectionStatus).not.toBe('open');

    // 退避到期后必须建立新连接（不得因 socket 非空 / readyState<=1 早退）
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    lastSock().emitOpen();
    expect(topicsSent(lastSock())).toContain('quote');
    client.close();
  });

  it('T-R1-c 持续有入站帧 → 不得误触发看门狗（阈值以「最近一次入站帧」为基准）', () => {
    const client = newClient();
    client.subscribe('source_health', vi.fn());
    client.connect();
    const s0 = lastSock();
    s0.emitOpen();

    // 每 10s 一帧，累计 50s（总时长已远超 15s，但每次静默都 < 阈值）
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      s0.emitMessage({ type: 'health', window_secs: 3600, sources: [] });
    }
    // 最后一帧后 10s：仍未达阈值 → 不得关闭
    vi.advanceTimersByTime(10_000);
    expect(s0.closeCalls).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 再静默 5s（自最后一帧起恰好 15s）→ 必须关闭
    vi.advanceTimersByTime(5_000);
    expect(s0.closeCalls).toBe(1);
    client.close();
  });
});

describe('T-R1-d 自愈后必须做一次 HTTP 增量补偿（口径②：与兜底同一最新窗口口径）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_NOW); // 既有用例的 15s 口径 = 交易时段门控；钉死时钟避免墙钟依赖
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('静默 15s → 主动重连 → 对当前 (code, period) 拉一次最新窗口（无 before 游标）', async () => {
    const initial: Bar[] = [
      mkBar('2026-09-14T01:50:00Z', 1.0),
      mkBar('2026-09-14T01:51:00Z', 1.1),
      mkBar('2026-09-14T01:52:00Z', 1.2),
    ];
    const getKline = vi.fn(
      async (_q: { code: string; period: string; before?: string; limit?: number }) => initial,
    );
    const api = { getKline } as unknown as ApiClient;
    const ws = newClient();
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '1m', viewportBars: 3 });

    await feed.loadInitial();
    ws.connect();
    const s0 = lastSock();
    s0.emitOpen();
    const before = getKline.mock.calls.length;
    expect(before).toBe(1); // 初始加载

    // 静默到阈值 → 看门狗主动 close
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(s0.closeCalls).toBe(1);

    // 退避 1s 后重连并 open
    await vi.advanceTimersByTimeAsync(1_000);
    const s1 = lastSock();
    expect(s1).not.toBe(s0);
    s1.emitOpen();
    await vi.advanceTimersByTimeAsync(50); // 冲刷补偿请求（含可能的 0ms 去抖）

    // 必须发生一次增量补偿：同一 code/period 的最新窗口（不是向前翻页）
    expect(getKline.mock.calls.length).toBeGreaterThan(before);
    const q = getKline.mock.calls.at(-1)![0];
    expect(q.code).toBe('518880');
    expect(q.period).toBe('1m');
    expect(q.before).toBeUndefined();

    feed.dispose();
    ws.close();
  });
});

// ── 阶段 2 简化（改写，不削弱）：门控固定阈值 ──────────────────────────────────────────────
// 权威口径（架构师裁决；design/06-web/01-dashboard.md §3 补定稿 clause 4）：
//   不引入应用层心跳帧；看门狗阈值 = 按交易时段（`@/shell/session` 的 `tradingSession()`，与 feed.ts
//   分钟兜底同口径）门控的**固定值**：交易时段 15s（推送活跃 ⇒ 快速自愈）；非交易时段 300s
//   （后端口是数据驱动推送：盘中约 1 帧/分钟、非交易时段 0 帧 ⇒ 放宽避免空转重连）。
//   任一入站帧都把静默计时复位。
//
// 本组用例**替代**阶段 2 早期的「自适应静默估值器」用例（阈值 = 2.5 × 最近 5 个入站节奏样本的最大值、
// 零帧静默按 2^n 几何升级、15s–300s 夹逼）：那组断言把「估值器」这一实现细节钉死在测试里，而真浏览器
// 实测（AppShell 恒订阅 source_health、store 恒订阅 quote ⇒ 活跃期 health 帧 ≈3.4s 一张）表明估值器
// 在真实运行中几乎不生效。改按新口径后，鉴别力**只增不减**（未放宽、未删除任何判据）：
//   ① 交易时段静默 14s 不触发 / 达 15s 必须触发；② 非交易时段静默 15s **不得**触发；
//   ③ 非交易时段须静默满 300s 才触发；④ 任一入站帧复位计时（间隔 < 阈值的连续帧永不触发）。
describe('T-R1-e 门控固定阈值（阶段 2 简化：交易时段 15s / 非交易时段 300s）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-R1-e1 交易时段：静默 14s 不得触发，达 15s 必须触发（阈值恰为 15s）', () => {
    const client = newClient();
    client.subscribe('quote', vi.fn());
    client.connect();
    const sock = lastSock();
    sock.mode = 'hung'; // 半开：close() 不派发 onclose
    sock.emitOpen();

    vi.advanceTimersByTime(14_000);
    expect(sock.closeCalls).toBe(0); // 未达阈值不得关闭
    vi.advanceTimersByTime(1_000);
    expect(sock.closeCalls).toBe(1); // 达阈值必须关闭（交易时段快自愈）
    expect(client.connectionStatus).not.toBe('open');
    client.close();
  });

  it('T-R1-e2 非交易时段（周六）：静默 15s 不得触发；静默满 300s 才触发', () => {
    vi.setSystemTime(OFFHOURS_NOW); // 2026-09-12 周六 10:00 北京 ⇒ tradingSession()==='closed'
    const client = newClient();
    client.subscribe('quote', vi.fn());
    client.connect();
    const sock = lastSock();
    sock.mode = 'hung';
    sock.emitOpen();

    vi.advanceTimersByTime(15_000);
    expect(sock.closeCalls).toBe(0); // 关键鉴别点：非交易时段 15s **不得**触发（空转重连）
    vi.advanceTimersByTime(OFFHOURS_SILENCE_MS - 15_000 - 1);
    expect(sock.closeCalls).toBe(0); // 299.999s：仍未达 300s
    vi.advanceTimersByTime(1);
    expect(sock.closeCalls).toBe(1); // 恰达 300s：必须触发
    expect(client.connectionStatus).not.toBe('open');
    client.close();
  });

  it('T-R1-e3 任一入站帧复位静默计时（交易时段：间隔 < 15s 的连续帧不触发；末帧后须重新计满 15s）', () => {
    const client = newClient();
    client.subscribe('source_health', vi.fn());
    client.connect();
    const sock = lastSock();
    sock.mode = 'hung';
    sock.emitOpen();

    // 每 10s 一帧共 5 帧：累计 50s 已远超 15s 阈值，但每次静默都 < 15s（复位生效）⇒ 不得触发
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      expect(sock.closeCalls).toBe(0);
      sock.emitMessage({ type: 'health', window_secs: 3600, sources: [] });
    }
    vi.advanceTimersByTime(14_000);
    expect(sock.closeCalls).toBe(0); // 自最后一帧起 14s：仍未达阈值
    vi.advanceTimersByTime(1_000);
    expect(sock.closeCalls).toBe(1); // 自最后一帧起满 15s：必须触发
    client.close();
  });
});

// ── 阶段 2 加强（真浏览器实测校准）：补偿接线边界 ──────────────────────────────────────────
// 实测发现（coder/evidence/055_realtime_phase2/probe_r1_r3.log）：常规时序下 WS 在**页面启动时**就已
// open，而 feed 的 loadInitial 稍后才订阅状态 ⇒ 若只把「观察到的第一次 open」当首连，则**首次真重连**
// 不会补偿。本用例锁住修复：订阅时 WS 已 open ⇒ 仍把随后的第一次 open 判为「首连」，第二次才补偿。
describe('T-R1-f 重连补偿接线边界（阶段 2 加强）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_NOW); // 既有用例的 15s 口径 = 交易时段门控；钉死时钟避免墙钟依赖
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('订阅时 WS 已 open ⇒ 首次重连必须补偿（最新窗口、无 before 游标）', async () => {
    const initial: Bar[] = [
      mkBar('2026-09-14T01:50:00Z', 1.0),
      mkBar('2026-09-14T01:51:00Z', 1.1),
      mkBar('2026-09-14T01:52:00Z', 1.2),
    ];
    const getKline = vi.fn(async (_q: { code: string; period: string; before?: string; limit?: number }) => initial);
    const api = { getKline } as unknown as ApiClient;
    const ws = newClient();
    ws.connect();
    const s0 = lastSock();
    s0.emitOpen(); // WS 先建立（页面启动时序）
    expect(ws.connectionStatus).toBe('open');

    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '1m', viewportBars: 3 });
    await feed.loadInitial();
    const before = getKline.mock.calls.length;
    expect(before).toBe(1);

    // 意外断线 → 指数退避重连；这一次 open 是 feed 观察到的第一次，但**本次连接之前已有 open**
    s0.emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    const s1 = lastSock();
    expect(s1).not.toBe(s0);
    s1.emitOpen();
    await vi.advanceTimersByTimeAsync(50);

    expect(getKline.mock.calls.length).toBeGreaterThan(before);
    expect(getKline.mock.calls.at(-1)![0]).toMatchObject({ code: '518880', period: '1m' });
    expect(getKline.mock.calls.at(-1)![0].before).toBeUndefined();

    feed.dispose();
    ws.close();
  });
});
