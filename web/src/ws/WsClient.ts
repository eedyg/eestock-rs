/**
 * WS 客户端（00-shell：单连接 /ws，订阅分发，断线指数退避重连 + **入站静默看门狗**）。
 * 订阅键规范（09-frontend.md §5）：`bar:<code>:<period>` / `quote` / `source_health`。
 * 连线帧：{type:"subscribe"|"unsubscribe", topic, code?, period?}；
 * 服务端推送：{type:"bar", code, period, bar} / {type:"quote", ...} / {type:"health", ...}。
 * 前后端 topic 适配（07-app-plane §1.4）：后端口径 "health" ≡ 前端 "source_health"，
 * 出站帧与入站分发经别名映射，页面层始终使用 "source_health"。
 *
 * 活性自愈（诊断 R1，半开连接：readyState 仍 OPEN、`onclose` 永不到来）：
 * 服务端无 ping/pong 帧（协议不变更），故不引入应用层心跳帧，而用**入站静默看门狗**：
 * 自「最近一次入站帧」（无帧则自连接建立）起算，静默超过阈值即判定失联 ⇒ 主动 `close()`
 * 走既有指数退避重连（不依赖 `onclose` 是否到达）；连接状态立即离开 `open`（顶栏 pill 不撒谎）。
 *
 * **阈值取值（门控固定，阶段 2 简化）**：按既有交易时段判定（`@/shell/session` 的 `tradingSession()`，
 * 与 feed.ts 同口径：工作日 09:30–11:30 / 13:00–15:00，Asia/Shanghai）在**两个固定值**中二选一：
 *  - **交易时段 15s**：推送活跃，要求快速自愈（红线测试 T-R1 钉死的行为）；
 *  - **非交易时段 300s**：后方是数据驱动推送（Poller 仅在数据推进时发布；实测盘中约 1 帧/分钟、
 *    非交易时段 0 帧），放宽阈值避免把「本来就没数据可推」误判为失联而空转重连。
 * 任一入站帧都把静默计时复位。自愈上限：非交易时段最差 5 分钟一次重连；
 * 即使 WS 通路失效，图的 bar 仍由每分钟 HTTP 兜底补齐。
 *
 * 简化沿革：阶段 2 曾用「自适应静默估值器」（2.5 × 最近 5 个入站节奏样本的最大值 + 零帧几何升级，
 * 15s–300s 夹逼）；真浏览器实测（AppShell 恒订阅 source_health、store 恒订阅 quote ⇒ 活跃期 health 帧
 * ≈3.4s 一张）表明活跃期几乎永远有帧 ⇒ 估值器在真实运行中几乎不生效，只增加复杂度，故删去，
 * 改为按交易时段门控的固定阈值。
 */

import { tradingSession } from '@/shell/session';

const OUT_TOPIC_ALIAS: Record<string, string> = { source_health: 'health' };
const IN_TOPIC_ALIAS: Record<string, string> = {
  health: 'source_health',
  strategy_run_progress: 'strategy_run', // 后端帧 type=strategy_run_progress → 前端订阅 topic=strategy_run（P3b §1.8）
};

export type WsConnectionStatus = 'connecting' | 'open' | 'closed';
export type WsMessage = { type?: string; code?: string; period?: string; [k: string]: unknown };
type WsHandler = (msg: WsMessage) => void;

/** 入站静默阈值（毫秒，**交易时段**）：连续无任何入站帧即视为失联（诊断 R1 取值 15s）。 */
export const WS_INBOUND_SILENCE_MS = 15_000;
/** 入站静默阈值（毫秒，**非交易时段**）：推送稀薄/无推送时把重连频率压到 ≤1 次/5 分钟（不空转）。 */
export const WS_INBOUND_SILENCE_OFFHOURS_MS = 300_000;

export interface WsClientOptions {
  url: string | (() => string);
  webSocketImpl?: typeof WebSocket;
  minRetryMs?: number; // 默认 1000
  maxRetryMs?: number; // 默认 30000
}

function topicToFrame(kind: 'subscribe' | 'unsubscribe', topic: string): Record<string, string> {
  const [head, code, period] = topic.split(':');
  const frame: Record<string, string> = { type: kind, topic: OUT_TOPIC_ALIAS[head!] ?? head! };
  if (code) frame.code = code;
  if (period) frame.period = period;
  return frame;
}

function messageTopic(msg: WsMessage): string {
  if (msg.type === 'bar') return `bar:${msg.code ?? ''}:${msg.period ?? ''}`;
  const t = msg.type ?? '';
  return IN_TOPIC_ALIAS[t] ?? t;
}

export class WsClient {
  private subs = new Map<string, Set<WsHandler>>();
  private statusCbs = new Set<(s: WsConnectionStatus) => void>();
  private socket: WebSocket | null = null;
  private manualClose = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private status: WsConnectionStatus = 'closed';

  constructor(private opts: WsClientOptions) {}

  get connectionStatus(): WsConnectionStatus {
    return this.status;
  }

  onStatusChange(cb: (s: WsConnectionStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => {
      this.statusCbs.delete(cb);
    };
  }

  private setStatus(s: WsConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusCbs.forEach((cb) => cb(s));
  }

  connect(): void {
    this.manualClose = false;
    if (this.socket && this.socket.readyState <= 1) return; // 已连接/连接中
    const Impl = this.opts.webSocketImpl ?? WebSocket;
    const url = typeof this.opts.url === 'function' ? this.opts.url() : this.opts.url;
    const sock: WebSocket = new Impl(url);
    this.socket = sock;
    this.setStatus('connecting');
    sock.onopen = () => {
      this.retryAttempt = 0;
      this.setStatus('open');
      for (const topic of this.subs.keys()) {
        this.sendFrame(topicToFrame('subscribe', topic));
      }
      this.armWatchdog(); // 自连接建立起算静默（订阅后首帧应很快到达）
    };
    sock.onmessage = (ev) => {
      this.armWatchdog(); // 任一入站帧都把静默计时复位
      try {
        this.dispatch(JSON.parse(String(ev.data)) as WsMessage);
      } catch {
        // 非 JSON 帧忽略
      }
    };
    sock.onclose = () => {
      if (this.socket !== sock) return; // 迟到的旧连接 close 事件：忽略（防重复重连/多连接并存）
      this.handleDisconnect();
    };
    sock.onerror = () => {
      // onclose 随后来到，由 onclose 统一处理重连；半开（onclose 永不到来）由看门狗兜底
    };
  }

  /** 手动关闭：不再自动重连 */
  close(): void {
    this.manualClose = true;
    this.clearWatchdog();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
  }

  /** 清理看门狗计时器（重复调用安全）。 */
  private clearWatchdog(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /**
   * 当前静默阈值（门控固定值）：交易时段 15s（推送活跃 ⇒ 快速自愈）；其余时段 300s（推送稀薄 ⇒ 不空转）。
   * 交易时段判定复用宿主既有能力 `@/shell/session`（与 feed.ts 的分钟兜底同一口径）。
   */
  private silenceThresholdMs(): number {
    return tradingSession(new Date()) === 'trading'
      ? WS_INBOUND_SILENCE_MS
      : WS_INBOUND_SILENCE_OFFHOURS_MS;
  }

  /** 重置静默计时：每次入站帧/连接建立时调用。 */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.silenceTimer = setTimeout(() => this.onInboundSilence(), this.silenceThresholdMs());
  }

  /**
   * 入站静默到点：判定连接已失联（半开也算）⇒ 主动 close + 进入既有指数退避重连。
   * 不依赖 `onclose`：真实浏览器 close() 会派发 onclose（由 `sock.onclose` 走 handleDisconnect），
   * 半开连接不派发 ⇒ 这里自行进入断线处理（两路都收敛到幂等的 `scheduleReconnect`）。
   */
  private onInboundSilence(): void {
    this.silenceTimer = null;
    if (this.manualClose) return;
    const sock = this.socket;
    if (!sock) {
      this.scheduleReconnect();
      return;
    }
    try {
      sock.close();
    } catch {
      // close 异常不影响重连路径
    }
    this.handleDisconnectIfStillCurrent(sock);
  }

  /** 半开路径：close() 未派发 onclose（`this.socket` 仍指向同一连接）⇒ 自行进入断线处理。 */
  private handleDisconnectIfStillCurrent(sock: WebSocket): void {
    if (this.socket !== sock) return; // onclose 已同步处理过（正常路径）
    this.handleDisconnect();
  }

  /** 断线处理（幂等：`onclose` / 看门狗两条路径可重复进入，只应调度一次重连）。 */
  private handleDisconnect(): void {
    this.clearWatchdog();
    this.setStatus('closed');
    if (this.manualClose) return;
    this.scheduleReconnect();
  }

  subscribe(topic: string, handler: WsHandler): () => void {
    if (!this.subs.has(topic)) this.subs.set(topic, new Set());
    const set = this.subs.get(topic)!;
    set.add(handler);
    if (set.size === 1 && this.status === 'open') {
      this.sendFrame(topicToFrame('subscribe', topic));
    }
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.subs.delete(topic);
        if (this.status === 'open') this.sendFrame(topicToFrame('unsubscribe', topic));
      }
    };
  }

  private sendFrame(frame: Record<string, string>) {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private dispatch(msg: WsMessage) {
    const topic = messageTopic(msg);
    this.subs.get(topic)?.forEach((h) => h(msg));
  }

  private scheduleReconnect() {
    if (this.retryTimer) return; // 已调度（onclose 与看门狗先后到达时只调度一次）
    const min = this.opts.minRetryMs ?? 1000;
    const max = this.opts.maxRetryMs ?? 30000;
    const delay = Math.min(min * 2 ** this.retryAttempt, max);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.manualClose) {
        this.socket = null; // 旧连接（可能仍半开）不再作为当前连接：其迟到事件被忽略
        this.connect();
      }
    }, delay);
  }
}
