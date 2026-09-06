import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import type { WsClient, WsMessage } from '@/ws/WsClient';

export type FeedStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/** 每个周期 1 个交易日的 bar 数（A股交易时段 4h=240min + 集合竞价/收盘余量；经真数据核对 1m≈241、5m≈49、15m≈17、1h≈5） */
export const BARS_PER_TRADING_DAY: Record<Period, number> = {
  '1m': 241,
  '5m': 49,
  '15m': 17,
  '1h': 5,
  '1d': 1,
  '1w': 1, // 周线：一个单位即一根（周/月不再细分为交易日，按单位计 1 根）
  '1mo': 1, // 月线：同上
};

/** 默认视口 = 当日 + 前一交易日（定稿 1d / 补定稿）：2 个交易日的 bar 数，避免裸 500 过度加载/缩成一小截。
 *  1w/1mo：周/月一个单位即一根 bar，2×交易日=2 根过疏；给合理初始窗口（周≈30 根≈半年+、月≈24 根≈两年），
 *  以覆盖足够历史又不致整屏过于稀疏/过度加载。 */
export function defaultPageSizeForPeriod(period: Period): number {
  if (period === '1w') return 30; // 周线视口：≈30 周（半年+）
  if (period === '1mo') return 24; // 月线视口：≈24 月（两年）
  return BARS_PER_TRADING_DAY[period] * 2;
}

/** 分页批量（loadBefore 向前翻页每页 bar 数）——与「视口 pageSize」分离。
 *  视口 pageSize=defaultPageSizeForPeriod（2 交易日，小）只用于初始画面铺满与宫格缩略；
 *  深翻（forward）改用本批量，避免「每翻一次只 2 根、深翻几百次」的低效（问题②根因）。
 *  取值权衡：批量越大单次往返越大、往返次数越少；给足够深翻的合理量（按周期 bar 总量与滚动坡度）。 */
export const PAGINATION_BATCH: Record<Period, number> = {
  '1m': 500, // 分钟：1 根/bar，最大批量加速深翻
  '5m': 300,
  '15m': 220,
  '1h': 120,
  '1d': 250, // 日线：250 交易日 ≈ 1 年/页，深翻到多年前也不频繁
  '1w': 150, // 周线：150 周 ≈ 3 年/页
  '1mo': 80, // 月线：80 月 ≈ 6.7 年/页
};

export function paginationBatchForPeriod(period: Period): number {
  return PAGINATION_BATCH[period];
}


type WsLike = Pick<WsClient, 'subscribe'>;

export interface KlineDataFeedDeps {
  api: ApiClient;
  ws: WsLike;
  code: string;
  period: Period;
  pageSize?: number; // 视口大小（默认 = 2 个交易日的 bar 数，defaultPageSizeForPeriod，定稿 1d/补定稿）；宫格缩略图显式传小值
  paginationBatch?: number; // 深翻每页 bar 数（默认 = paginationBatchForPeriod(period)）；不传时按周期取批量值
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
  private readonly paginationBatch: number;
  private listeners = new Set<() => void>();
  private rtListeners = new Set<(bar: Bar) => void>();
  private unsubWs: (() => void) | null = null;
  private loadPromise: Promise<void> | null = null;
  private loadingBefore = false;
  private disposed = false;

  constructor(private deps: KlineDataFeedDeps) {
    this.pageSize = deps.pageSize ?? defaultPageSizeForPeriod(deps.period);
    this.paginationBatch = deps.paginationBatch ?? paginationBatchForPeriod(deps.period);
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

  /** 向前翻页：以最早 bar 的 ts 为排他游标，去重拼接；返回新增条数。
   *  使用分页批量 `paginationBatch`（而非视口 pageSize），深翻每页取更多、往返更少（问题②修复）。 */
  async loadBefore(): Promise<number> {
    if (this.disposed || !this.hasMore || this.loadingBefore || this.bars.length === 0) return 0;
    this.loadingBefore = true;
    try {
      const before = this.bars[0]!.ts;
      const older = await this.deps.api.getKline({
        code: this.deps.code,
        period: this.deps.period,
        before,
        limit: this.paginationBatch,
      });
      if (this.disposed) return 0;
      const existing = new Set(this.bars.map((b) => b.ts));
      const fresh = older.filter((b) => !existing.has(b.ts));
      if (fresh.length > 0) this.bars = [...fresh, ...this.bars];
      if (older.length < this.paginationBatch) this.hasMore = false;
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
