import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import type { FeedStatus } from '@/features/dashboard/feed';

/** 各周期 bar 时间步长（毫秒）；与 merge 视图 / mock PERIOD_MS 口径一致。 */
const PERIOD_STEP_MS: Record<Period, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
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
}

/**
 * 区间作用域 K 线 feed：按 [open_ts - buffer×step, close_ts + buffer×step] 加载该 code+period 的 bar，
 * 供回测弹窗复用看板 `KlineChart`（其 DataLoader 需要 feed 具备 bars/hasMore/loadInitial/loadBefore/onRealtime）。
 *
 * 与看板 `KlineDataFeed` 的差异：
 *  - 取数走 `GET /api/kline` 的 `before`（排他上界）+ `limit`：把区间窗口拉到位后按时间戳过滤，
 *    得到「开仓→平仓 + 前后 buffer」的闭区间 bar（升序）。
 *  - `loadBefore` 恒返回 0：区间外无更早历史，不向前分页。
 *  - 禁实时：历史区间不订阅 WS；`onRealtime` 注册监听但从不触发（KlineChart 的实时标记因此不激活）。
 */
export class ScopedKlineFeed {
  bars: Bar[] = [];
  status: FeedStatus = 'idle';
  hasMore = false;

  private listeners = new Set<() => void>();
  private rtListeners = new Set<(bar: Bar) => void>();
  private loadPromise: Promise<void> | null = null;
  private disposed = false;
  private readonly buffer: number;

  constructor(private deps: ScopedKlineFeedDeps) {
    this.buffer = deps.buffer ?? 10;
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
        this.hasMore = false;
      } catch {
        if (!this.disposed) this.status = 'error';
      } finally {
        this.loadPromise = null;
        if (!this.disposed) this.emit();
      }
    })();
    return this.loadPromise;
  }

  /** 区间外无更早历史：恒返回 0（引擎据此停拉前向分页）。 */
  async loadBefore(): Promise<number> {
    return 0;
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
