/**
 * WS 客户端（00-shell：单连接 /ws，订阅分发，断线指数退避重连）。
 * 订阅键规范（09-frontend.md §5）：`bar:<code>:<period>` / `quote` / `source_health`。
 * 连线帧：{type:"subscribe"|"unsubscribe", topic, code?, period?}；
 * 服务端推送：{type:"bar", code, period, bar} / {type:"quote", ...} / {type:"health", ...}。
 * 前后端 topic 适配（07-app-plane §1.4）：后端口径 "health" ≡ 前端 "source_health"，
 * 出站帧与入站分发经别名映射，页面层始终使用 "source_health"。
 */

const OUT_TOPIC_ALIAS: Record<string, string> = { source_health: 'health' };
const IN_TOPIC_ALIAS: Record<string, string> = { health: 'source_health' };

export type WsConnectionStatus = 'connecting' | 'open' | 'closed';
export type WsMessage = { type?: string; code?: string; period?: string; [k: string]: unknown };
type WsHandler = (msg: WsMessage) => void;

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
    };
    sock.onmessage = (ev) => {
      try {
        this.dispatch(JSON.parse(String(ev.data)) as WsMessage);
      } catch {
        // 非 JSON 帧忽略
      }
    };
    sock.onclose = () => {
      this.setStatus('closed');
      if (!this.manualClose) this.scheduleReconnect();
    };
    sock.onerror = () => {
      // onclose 随后来到，由 onclose 统一处理重连
    };
  }

  /** 手动关闭：不再自动重连 */
  close(): void {
    this.manualClose = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
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
    const min = this.opts.minRetryMs ?? 1000;
    const max = this.opts.maxRetryMs ?? 30000;
    const delay = Math.min(min * 2 ** this.retryAttempt, max);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.manualClose) {
        this.socket = null;
        this.connect();
      }
    }, delay);
  }
}
