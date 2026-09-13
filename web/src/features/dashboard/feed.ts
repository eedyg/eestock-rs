import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import type { WsClient, WsMessage } from '@/ws/WsClient';

export type FeedStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/** 行情看板 K线默认视口（K 线根数，GET /api/config/kline；缺省 120；与周期无关，主图+宫格共用）。
 *  ADR-020 §2.1：单位由「交易日数」改为「K 线根数」——同一配置值在任何周期都表示可见 N 根。 */
export const DEFAULT_KLINE_VIEWPORT_BARS = 120;
/** 视口下界（与后端 MIN_KLINE_VIEWPORT_BARS 同构）。 */
export const MIN_KLINE_VIEWPORT_BARS = 30;
/** 视口上界（与后端 MAX_KLINE_VIEWPORT_BARS 同构；< 后端 MAX_LIMIT(1000)，截断路径不可达）。 */
export const MAX_KLINE_VIEWPORT_BARS = 600;

/** 分时图（TimeshareChart）当日 1m 取数根数。
 *
 *  ① 语义：「分时图 = 当日 1m 全时段」（价格线 + 均价线覆盖整个交易日，非「视口」概念）；
 *  ② 取值：必须 ≥ 一个交易日的 1m bar 上限 241（A 股 4h 交易时段 = 240min + 集合竞价/收盘余量，
 *     经真数据核对 1m≈241/日），取 500 留缓冲（覆盖 2 个交易日，盘中/跨日边界不会截断当日）；
 *  ③ 解耦：与 `viewport_bars`（K 线默认视口配置）**解耦** —— 分时图不随该配置变化
 *     （用户改「默认K线根数」只影响 K 线主图/宫格，不应把分时线截成半天）。 */
export const TIMESHARE_1M_BARS = 500;

/** 分页批量（loadBefore 向前翻页每页 bar 数）——与「视口 pageSize」分离。
 *  视口 pageSize = viewportBars（默认 120 根，小）只用于初始画面铺满与宫格缩略；
 *  深翻（forward）改用本批量，避免「每翻一次只几根、深翻几百次」的低效（问题②根因）。
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
  pageSize?: number; // 显式视口覆盖（优先于 viewportBars；保留给测试/特化），不传则 = viewportBars
  viewportBars?: number; // 默认视口的 K 线根数（GET /api/config/kline 加载；缺省 120 兜底；主图+宫格统一）
  paginationBatch?: number; // 深翻每页 bar 数（默认 = paginationBatchForPeriod(period)）；不传时按周期取批量值
  /** **取数 warmup**（dcap 指标，design/14-dcap-indicator/02-spec.md §6；裁决依据见 §8 #19）：初始取数
   *  `limit = viewportBars + warmupBars`；多取部分仅供指标计算、**不上图**（视口最左那根才不断线）。
   *  缺省 0 = 既有 ADR-020 口径（limit = viewportBars）不变。 */
  warmupBars?: number;
}

/**
 * K线数据流（图表库无关）：初始加载 → WS 实时 append/update → 向前游标分页。
 * 图表适配层（KlineChart）把本 feed 接进 klinecharts DataLoader；
 * 宫格缩略图复用同 feed（与主图同一 viewportBars）。
 */
export class KlineDataFeed {
  bars: Bar[] = [];
  status: FeedStatus = 'idle';
  hasMore = true;

  private readonly pageSize: number;
  private readonly paginationBatch: number;
  private readonly warmupBars: number;
  private listeners = new Set<() => void>();
  private rtListeners = new Set<(bar: Bar) => void>();
  private unsubWs: (() => void) | null = null;
  private loadPromise: Promise<void> | null = null;
  private loadingBefore = false;
  private disposed = false;

  constructor(private deps: KlineDataFeedDeps) {
    this.pageSize = deps.pageSize ?? deps.viewportBars ?? DEFAULT_KLINE_VIEWPORT_BARS;
    this.paginationBatch = deps.paginationBatch ?? paginationBatchForPeriod(deps.period);
    // 非法 warmup（负数 / NaN / Inf）→ 0（不产生非法 limit）
    const warmup = deps.warmupBars ?? 0;
    this.warmupBars = Number.isFinite(warmup) && warmup > 0 ? Math.trunc(warmup) : 0;
  }

  /** 初始取数上限 = 视口根数 + warmup（warmup 部分仅供指标计算，不上图；§6 取数 warmup）。 */
  get initialLimit(): number {
    return this.pageSize + this.warmupBars;
  }

  /** 默认视口（K 线根数，GET /api/config/kline；缺省 120 兜底）。KlineChart/GridCell 的 fitBarSpace
   *  铺满目标据此计算，使初始可见 K 线数随配置变化，且与周期无关（ADR-020 §2.5）。 */
  get viewportBars(): number {
    return this.deps.viewportBars ?? DEFAULT_KLINE_VIEWPORT_BARS;
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
          limit: this.initialLimit,
        });
        if (this.disposed) return;
        this.bars = bars;
        this.hasMore = bars.length >= this.initialLimit;
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
