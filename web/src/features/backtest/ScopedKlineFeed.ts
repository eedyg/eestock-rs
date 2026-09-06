import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import { defaultPageSizeForPeriod, type FeedStatus } from '@/features/dashboard/feed';

/** 各周期 bar 时间步长（毫秒）；与 merge 视图 / mock PERIOD_MS 口径一致。 */
const PERIOD_STEP_MS: Record<Period, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000, // 周线步长（约 7 天；回测周期不含 1w，仅类型完整性）
  '1mo': 30 * 86_400_000, // 月线步长（约 30 天；回测周期不含 1mo，仅类型完整性）
};

export interface ScopedKlineFeedDeps {
  api: ApiClient;
  code: string;
  period: Period;
  /** 开仓时刻（Unix 秒） */
  fromTs: number;
  /** 平仓时刻（Unix 秒） */
  toTs: number;
  /** 区间前后 buffer bar 数（默认 10） */
  buffer?: number;
  /** 向前分页每页 bar 数（默认 = defaultPageSizeForPeriod(period)，与看板 KlineDataFeed 分页口径一致） */
  pageSize?: number;
}

/**
 * 区间作用域 K 线 feed：按 [open_ts - buffer×step, close_ts + buffer×step] 加载该 code+period 的 bar，
 * 供回测弹窗复用看板 `KlineChart`（其 DataLoader 需要 feed 具备 bars/hasMore/loadInitial/loadBefore/onRealtime）。
 *
 * 与看板 `KlineDataFeed` 的差异：
 *  - 取数走 `GET /api/kline` 的 `before`（排他上界）+ `limit`：把区间窗口拉到位后按时间戳过滤，
 *    得到「开仓→平仓 + 前后 buffer」的闭区间 bar（升序）。
 *  - 支持向前分页：初始把「区间 + 前后 buffer」拉齐（hasMore 起始 true），向左平移/缩放时
 *    `loadBefore` 以当前最左 bar 的 ts 为 `before` 游标拉更早页，去重前插，返回新增条数（
 *    KlineChart 的 `loadBarsForKc` forward 只看 delta，引擎据此 prepend，无重复）。
 *  - 禁实时：历史区间不订阅 WS；`onRealtime` 注册监听但从不触发（KlineChart 的实时标记因此不激活）。
 */
export class ScopedKlineFeed {
  bars: Bar[] = [];
  status: FeedStatus = 'idle';
  hasMore = false;

  private listeners = new Set<() => void>();
  private rtListeners = new Set<(bar: Bar) => void>();
  private loadPromise: Promise<void> | null = null;
  private loadingBefore = false;
  private disposed = false;
  private readonly buffer: number;
  private readonly pageSize: number;

  constructor(private deps: ScopedKlineFeedDeps) {
    this.buffer = deps.buffer ?? 10;
    this.pageSize = deps.pageSize ?? defaultPageSizeForPeriod(deps.period);
  }

  /** 任意状态变更（加载完成/区间就绪） */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 区间 feed 无实时：注册监听但从不触发（保持 KlineChart 接口对齐）。 */
  onRealtime(cb: (bar: Bar) => void): () => void {
    this.rtListeners.add(cb);
    return () => {
      this.rtListeners.delete(cb);
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** 加载 open→close + 前后 buffer 区间的 bar。幂等：loading 中复用 Promise；ready/empty 直接返回。 */
  loadInitial(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    if (this.status === 'ready' || this.status === 'empty') return Promise.resolve();
    this.status = 'loading';
    this.emit();
    this.loadPromise = (async () => {
      try {
        const stepMs = PERIOD_STEP_MS[this.deps.period];
        const fromMs = this.deps.fromTs * 1000;
        const toMs = this.deps.toTs * 1000;
        const spanMs = Math.max(stepMs, toMs - fromMs);
        // 需要覆盖 开仓前 buffer 根 → 平仓后 buffer 根；limit 上浮 3 根作安全余量。
        const needBars = Math.ceil(spanMs / stepMs) + 2 * this.buffer + 3;
        // 排他上界：平仓后 buffer 根再往后一根，保证能取到最右的 buffer bar。
        const beforeMs = toMs + stepMs * (this.buffer + 1);
        const fetched = await this.deps.api.getKline({
          code: this.deps.code,
          period: this.deps.period,
          before: new Date(beforeMs).toISOString(),
          limit: needBars,
        });
        if (this.disposed) return;
        const lo = fromMs - stepMs * this.buffer;
        const hi = toMs + stepMs * this.buffer;
        // 过滤掉窗口外（before/limit 超出部分 + 假想无 bar 间隙），得到闭区间 bar（升序）。
        this.bars = fetched.filter((b) => {
          const t = Date.parse(b.ts);
          return t >= lo && t <= hi;
        });
        this.status = this.bars.length > 0 ? 'ready' : 'empty';
        // 区间无可见 bar → 无需向前分页，避免 hasMore=true 触发 forward 空拉忙转；
        // 否则取满请求窗口 → 认为左侧还有更早历史可拉（同 KlineDataFeed 分页口径）。
        this.hasMore = this.bars.length > 0 && fetched.length >= needBars;
      } catch {
        if (!this.disposed) this.status = 'error';
      } finally {
        this.loadPromise = null;
        if (!this.disposed) this.emit();
      }
    })();
    return this.loadPromise;
  }

  /** 向前分页：以当前最左 bar 的 ts 为排他 `before` 游标拉更早 bar，去重前插，返回新增条数。
   *  与看板 KlineDataFeed.loadBefore 同语义（KlineChart 的 forward 只回调 delta，无重复）。 */
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

  /** 历史区间无实时：恒 ignore（保持 KlineDataFeed 接口对齐）。 */
  applyRealtime(_bar: Bar): 'append' | 'update' | 'ignore' {
    return 'ignore';
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.rtListeners.clear();
  }
}
