import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import { paginationBatchForPeriod, type FeedStatus } from '@/features/dashboard/feed';

/** 各周期 bar 时间步长（毫秒）；与 merge 视图 / mock PERIOD_MS 口径一致。 */
const PERIOD_STEP_MS: Record<Period, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000, // ADR-023：30m 档（1m 本地衍生 cagg）
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000, // 周线步长（约 7 天；回测周期不含 1w，仅类型完整性）
  '1mo': 30 * 86_400_000, // 月线步长（约 30 天；回测周期不含 1mo，仅类型完整性）
};

/** 回测区间弹窗固定视口（K 线根数；不读配置，ADR-020 §2.4）。 */
export const SCOPED_VIEWPORT_BARS = 120;

/**
 * 服务端 `/api/kline` **单页上限**（契约常量，不改后端）：
 * `crates/web/src/dto.rs: pub const MAX_LIMIT: i64 = 1000;` +
 * `crates/web/src/rest.rs: let limit = q.limit.clamp(1, MAX_LIMIT);`
 *
 * 请求超过它只会被服务端夹取到「最新 1000 根」⇒ 客户端**必须**自行按 `before` 游标向前分页；
 * 同时它是一页请求量的硬上界（多要无益）。
 */
export const SERVER_KLINE_MAX_LIMIT = 1000;

/**
 * 初始装载向前分页的**请求次数上限**（自选口径：20 页 × {@link SERVER_KLINE_MAX_LIMIT} 根 ≈ 2 万根）。
 * 触顶且仍未覆盖区间左端 ⇒ **必须显式披露**（{@link ScopedKlineFeed.historyCapNote}；ADR-024 D10 禁静默有损）。
 */
export const MAX_INITIAL_PAGES = 20;

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
  /** 向前分页每页 bar 数（默认 = paginationBatchForPeriod(period)，与看板深翻批量口径一致） */
  pageSize?: number;
  /** 初始装载向前分页的请求次数上限（默认 {@link MAX_INITIAL_PAGES}；触顶未覆盖 ⇒ 显式披露）。 */
  maxInitialPages?: number;
}

/**
 * 区间作用域 K 线 feed：按 [open_ts - buffer×step, close_ts + buffer×step] 加载该 code+period 的 bar，
 * 供回测弹窗复用看板 `KlineChart`（其 DataLoader 需要 feed 具备 bars/hasMore/loadInitial/loadBefore/onRealtime）。
 *
 * 与看板 `KlineDataFeed` 的差异：
 *  - 取数走 `GET /api/kline` 的 `before`（排他上界）+ `limit`：把区间窗口拉到位后按时间戳过滤，
 *    得到「开仓→平仓 + 前后 buffer」的闭区间 bar（升序）。
 *  - **初始装载自行向前分页**（缺陷修复，2026-09-24）：服务端单页上限
 *    {@link SERVER_KLINE_MAX_LIMIT}=1000 ⇒ 长区间（M15 > 10.4 天、M5 > 3.47 天、M1 > 16.6h）
 *    不能一次拉回。旧实现把 `needBars`（M15 × 266 天 = 25539）当 `limit` 发出去，被服务端
 *    `clamp` 成「最新 1000 根」⇒ K 线数据域被截成 `[2026-07-08, 2026-09-23]`（用户实测）。
 *    现按 `before = 当前最早 ts` 循环取页（≤ {@link MAX_INITIAL_PAGES} 次）直到覆盖区间左端。
 *  - 支持向前分页：`loadBefore` 以当前最左 bar 的 ts 为 `before` 游标拉更早页，去重前插，
 *    返回新增条数（KlineChart 的 `loadBarsForKc` forward 只看 delta，引擎据此 prepend，无重复）。
 *  - 禁实时：历史区间不订阅 WS；`onRealtime` 注册监听但从不触发（KlineChart 的实时标记因此不激活）。
 */
export class ScopedKlineFeed {
  bars: Bar[] = [];
  status: FeedStatus = 'idle';
  hasMore = false;
  /** 初始装载是否已覆盖区间左端（`from_ts − buffer×step`）；false 且无 {@link historyCapNote} ⇒ 数据本身到此为止。 */
  historyCovered = true;
  /** 初始装载**触顶**披露（null = 未触顶）；非 null ⇒ UI 必须显示（禁静默截断）。 */
  historyCapNote: string | null = null;
  /** 默认视口（K 线根数）——区间弹窗不读 viewport_bars 配置，固定 120（与看板默认同构）。 */
  readonly viewportBars: number = SCOPED_VIEWPORT_BARS;

  private listeners = new Set<() => void>();
  private rtListeners = new Set<(bar: Bar) => void>();
  private loadPromise: Promise<void> | null = null;
  private loadingBefore = false;
  private disposed = false;
  private readonly buffer: number;
  private readonly pageSize: number;
  private readonly maxInitialPages: number;

  constructor(private deps: ScopedKlineFeedDeps) {
    this.buffer = deps.buffer ?? 10;
    this.pageSize = deps.pageSize ?? paginationBatchForPeriod(deps.period);
    this.maxInitialPages = deps.maxInitialPages ?? MAX_INITIAL_PAGES;
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

  /** 加载 open→close + 前后 buffer 区间的 bar。幂等：loading 中复用 Promise；ready/empty 直接返回。
   *
   * 分页口径（服务端单页上限 {@link SERVER_KLINE_MAX_LIMIT}）：
   *  1. 单次请求 `limit = min(needBars, 上限)`（多要只会被夹取）；
   *  2. 未覆盖区间左端且本页取满 ⇒ 以本页最旧 ts 为排他游标再取一页（≤ {@link MAX_INITIAL_PAGES} 次）；
   *  3. 触顶且仍未覆盖 ⇒ {@link historyCapNote} 显式披露（禁静默截断，ADR-024 D10）。
   */
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
        // 需要覆盖 开仓前 buffer 根 → 平仓后 buffer 根；limit 上浮 3 根作安全余量（**区间总根数**口径）。
        const needBars = Math.ceil(spanMs / stepMs) + 2 * this.buffer + 3;
        // 单页请求量：不得超过服务端单页上限（超了只会被夹取到「最新 1000 根」，拿不到更早历史）。
        const pageLimit = Math.min(needBars, SERVER_KLINE_MAX_LIMIT);
        // 排他上界：平仓后 buffer 根再往后一根，保证能取到最右的 buffer bar。
        let cursor = new Date(toMs + stepMs * (this.buffer + 1)).toISOString();
        const lo = fromMs - stepMs * this.buffer;
        const hi = toMs + stepMs * this.buffer;
        const byTs = new Map<number, Bar>();
        let pages = 0;
        let earliestMs = Number.POSITIVE_INFINITY;
        let pageFull = false;
        let covered = false;
        while (pages < this.maxInitialPages) {
          const page = await this.deps.api.getKline({
            code: this.deps.code,
            period: this.deps.period,
            before: cursor,
            limit: pageLimit,
          });
          if (this.disposed) return;
          pages += 1;
          pageFull = page.length >= pageLimit;
          for (const b of page) {
            const t = Date.parse(b.ts);
            if (!byTs.has(t)) byTs.set(t, b);
            if (t < earliestMs) earliestMs = t;
          }
          if (page.length === 0) break; // 数据尽头（本 code/period 无更早 bar）
          if (earliestMs <= lo) {
            covered = true; // 已覆盖区间左端
            break;
          }
          if (!pageFull) break; // 本页未取满 ⇒ 更早已无数据
          cursor = page[0]!.ts; // 排他游标 = 本页最旧 ts
        }
        // 升序归并（跨页去重：游标为排他上界，正常情况下无重叠）
        const all = [...byTs.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        // 过滤掉窗口外（before/limit 超出部分 + 假想无 bar 间隙），得到闭区间 bar（升序）。
        this.bars = all.filter((b) => {
          const t = Date.parse(b.ts);
          return t >= lo && t <= hi;
        });
        this.status = this.bars.length > 0 ? 'ready' : 'empty';
        // **向前分页可用性**（游标语义，与后端 `next_before` 同口径）：本次最后一页**取满**
        // ⇒ 服务端还有更早数据可拉。旧实现拿「返回条数 ≥ 请求条数」比较：请求被服务端夹取时
        // （返回 1000 < needBars）恒为假 ⇒ `loadBefore` 首行 return 0 ⇒ 向左拖/滚永不触发分页（缺陷 L2）。
        this.hasMore = this.bars.length > 0 && pageFull;
        this.historyCovered = covered;
        this.historyCapNote =
          !covered && pages >= this.maxInitialPages
            ? `K 线历史触顶披露：初始装载最多 ${this.maxInitialPages} 次向前分页 × 每页 ≤ ${SERVER_KLINE_MAX_LIMIT} 根，已取到 ${new Date(
                earliestMs,
              ).toISOString()}，仍未到区间起点 ${new Date(lo).toISOString()} ⇒ 左侧历史可能不全`
            : null;
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
