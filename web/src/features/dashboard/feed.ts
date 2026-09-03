import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import type { WsClient, WsMessage } from '@/ws/WsClient';

export type FeedStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

type WsLike = Pick<WsClient, 'subscribe'>;

export interface KlineDataFeedDeps {
  api: ApiClient;
  ws: WsLike;
  code: string;
  period: Period;
  pageSize?: number; // 默认 500（定稿 1d：默认当日+前一交易日，向前按需分页）
}

/**
 * K线数据流（图表库无关）：初始加载 → WS 实时 append/update → 向前游标分页。
 * 图表适配层（KlineChart）把本 feed 接进 klinecharts DataLoader；
 * 宫格缩略图复用同 feed（小 pageSize）。
 */
export class KlineDataFeed {
  bars: Bar[] = [];
  status: FeedStatus = 'idle';
  hasMore = true;

  private readonly pageSize: number;
  private listeners = new Set<() => void>();
  private rtListeners = new Set<(bar: Bar) => void>();
  private unsubWs: (() => void) | null = null;
  private loadPromise: Promise<void> | null = null;
  private loadingBefore = false;
  private disposed = false;

  constructor(private deps: KlineDataFeedDeps) {
    this.pageSize = deps.pageSize ?? 500;
  }

  /** 任意状态变更（加载完成/分页拼接/实时更新） */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 仅实时 bar（append/update）触发；分页不触发 */
  onRealtime(cb: (bar: Bar) => void): () => void {
    this.rtListeners.add(cb);
    return () => {
      this.rtListeners.delete(cb);
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** 幂等：loading 中复用同一 Promise；ready/empty 直接返回 */
  loadInitial(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    if (this.status === 'ready' || this.status === 'empty') return Promise.resolve();
    this.status = 'loading';
    this.emit();
    this.loadPromise = (async () => {
      try {
        const bars = await this.deps.api.getKline({
          code: this.deps.code,
          period: this.deps.period,
          limit: this.pageSize,
        });
        if (this.disposed) return;
        this.bars = bars;
        this.hasMore = bars.length >= this.pageSize;
        this.status = bars.length > 0 ? 'ready' : 'empty';
        this.subscribeRealtime();
      } catch {
        if (!this.disposed) this.status = 'error';
      } finally {
        this.loadPromise = null;
        if (!this.disposed) this.emit();
      }
    })();
    return this.loadPromise;
  }

  retry(): Promise<void> {
    this.status = 'idle';
    return this.loadInitial();
  }

  /** 向前翻页：以最早 bar 的 ts 为排他游标，去重拼接；返回新增条数 */
  async loadBefore(): Promise<number> {
    if (this.disposed || !this.hasMore || this.loadingBefore || this.bars.length === 0) return 0;
    this.loadingBefore = true;
    try {
      const before = this.bars[0]!.ts;
      const older = await this.deps.api.getKline({
        code: this.deps.code,
        period: this.deps.period,
        before,
        limit: this.pageSize,
      });
      if (this.disposed) return 0;
      const existing = new Set(this.bars.map((b) => b.ts));
      const fresh = older.filter((b) => !existing.has(b.ts));
      if (fresh.length > 0) this.bars = [...fresh, ...this.bars];
      if (older.length < this.pageSize) this.hasMore = false;
      this.emit();
      return fresh.length;
    } finally {
      this.loadingBefore = false;
    }
  }

  private subscribeRealtime() {
    if (this.unsubWs) return;
    this.unsubWs = this.deps.ws.subscribe(
      `bar:${this.deps.code}:${this.deps.period}`,
      (msg: WsMessage) => {
        if (msg.type === 'bar' && msg.bar) this.applyRealtime(msg.bar as Bar);
      },
    );
  }

  /** WS 实时（定稿 1c）：更晚 ts → appendBar；同 ts → updateBar 闪动替换；更早 → 忽略 */
  applyRealtime(bar: Bar): 'append' | 'update' | 'ignore' {
    const last = this.bars.at(-1);
    const t = Date.parse(bar.ts);
    let result: 'append' | 'update' | 'ignore';
    if (!last || t > Date.parse(last.ts)) {
      this.bars = [...this.bars, bar];
      if (this.status === 'empty') this.status = 'ready';
      result = 'append';
    } else if (t === Date.parse(last.ts)) {
      this.bars = [...this.bars.slice(0, -1), bar];
      result = 'update';
    } else {
      result = 'ignore';
    }
    if (result !== 'ignore') {
      this.rtListeners.forEach((cb) => cb(bar));
      this.emit();
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubWs?.();
    this.unsubWs = null;
    this.listeners.clear();
    this.rtListeners.clear();
  }
}
