import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import type { WsClient, WsMessage } from '@/ws/WsClient';
import { tradingSession } from '@/shell/session';
import { pollLatestWindow } from './realtimePoll';

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

// ── 实时更新口径（诊断 055 R1/R2/R3；架构师裁决①②③④）────────────────────────────────

/** 每分钟兜底间隔（交易时段 + 页面可见）；与 WS 共用同一 `applyRealtime`（口径②）。 */
export const REALTIME_POLL_INTERVAL_MS = 60_000;
/** 兜底取数根数：覆盖「采集侧跳标签 / 偶发缺行」造成的 1–2 根缺口（诊断 §6(b) 建议 3~5）。 */
export const REALTIME_POLL_LIMIT = 5;
/** 兜底失败退避序列：1→2→4→8→60s（封顶 60s）；任一通路成功即复位（口径④）。 */
export const REALTIME_POLL_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 60_000];

/** 实时写入来源：WS 推送 / 每分钟兜底（含重连补偿，同为 HTTP 取数）。 */
export type RealtimeSource = 'ws' | 'poll';

/** 实时通路可观测面（诊断 §6(b)「可观测性」）：最近来源 / 最近写入与成功取数时间 / 连续失败数。 */
export interface RealtimeStats {
  /** 最近一次实时写入（append/update）的来源 */
  lastSource: RealtimeSource | null;
  /** 最近一次实时写入时间（epoch ms） */
  lastWriteAt: number | null;
  /** 最近一次成功 HTTP 取数（兜底/重连补偿）时间（epoch ms） */
  lastPollOkAt: number | null;
  /** 连续兜底失败次数（成功复位 0；退避序列按其取值） */
  pollFailures: number;
}

/** 同 ts 且 OHLCV 完全一致 ⇒ 视为同一根 bar（幂等：不写、不 emit；口径②「同 ts 覆盖」的严格形式）。 */
function sameBarValues(a: Bar, b: Bar): boolean {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.amount === b.amount
  );
}

type WsLike = Pick<WsClient, 'subscribe'> &
  Partial<Pick<WsClient, 'onStatusChange' | 'connectionStatus'>>;

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
  /** 取数 warmup（可变：dcap 参数保存走 `setWarmupBars` 热更新，**不重建 feed** ⇒ 图表不 remount）。 */
  private warmupBars: number;
  private listeners = new Set<() => void>();
  private rtListeners = new Set<(bar: Bar) => void>();
  private unsubWs: (() => void) | null = null;
  private unsubWsStatus: (() => void) | null = null;
  private loadPromise: Promise<void> | null = null;
  private loadingBefore = false;
  private disposed = false;
  /** 每分钟兜底定时器（自 re-arm：退避期间不得再叠加固定 60s 触发）。 */
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** 兜底/补偿取数互斥（避免并发覆盖；与 `loadingBefore` 独立）。 */
  private pollBusy = false;
  /** WS 是否曾经 open 过：首次 open 不算重连（初始 HTTP 取数已覆盖），其后每次 open 才补偿。 */
  private wsEverOpen = false;
  private stats: RealtimeStats = { lastSource: null, lastWriteAt: null, lastPollOkAt: null, pollFailures: 0 };

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

  /** 当前目标的加载窗口（视口根数 + warmup）；HOT 更新后随之变化。 */
  private targetWindow(): number {
    return this.pageSize + this.warmupBars;
  }

  /**
   * 取数 warmup 热更新（dcap 参数保存路径，02-spec §6「配置保存不得重建 pane」）：
   * - **不重建 feed**（调用方保留同一 feed ⇒ KlineChart 不 remount ⇒ pane 布局/视口不被重置）；
   * - warmup **增大**时按**差额**以已加载最左 bar 的 ts 为排他游标向前补取（前插），
   *   使加载窗口回到 `viewportBars + warmup`（= 与「以新 warmup 重新构造 feed」等价的数据面）；
   * - warmup 减小/不变、尚无数据、已够宽 → 只更新字段、不取数（ADR-020：关 DCAP 不多取）。
   *
   * 返回**是否真的补取了更早的 bar**（true ⇒ 调用方需原地重载数据，如 `chart.resetData()`）。
   * 任何取数失败都不抛（保持既有数据；最左 warmup 段退化为断线，向左滚页会自然补齐）。
   */
  async setWarmupBars(warmup: number): Promise<boolean> {
    const next = Number.isFinite(warmup) && warmup > 0 ? Math.trunc(warmup) : 0;
    const prev = this.warmupBars;
    this.warmupBars = next;
    if (next <= prev) return false;
    if (this.disposed || this.loadingBefore || this.bars.length === 0) return false;
    const need = this.targetWindow() - this.bars.length;
    if (need <= 0) return false;
    this.loadingBefore = true;
    try {
      const before = this.bars[0]!.ts;
      const older = await this.deps.api.getKline({
        code: this.deps.code,
        period: this.deps.period,
        before,
        limit: need,
      });
      if (this.disposed) return false;
      this.hasMore = older.length >= need;
      const existing = new Set(this.bars.map((b) => b.ts));
      const fresh = older.filter((b) => !existing.has(b.ts));
      if (fresh.length === 0) return false;
      this.bars = [...fresh, ...this.bars];
      this.emit();
      return true;
    } catch {
      // 补取失败：保持既有数据（不回滚 warmup 字段：后续分页/重载仍按新口径）
      return false;
    } finally {
      this.loadingBefore = false;
    }
  }

  /** 默认视口（K 线根数，GET /api/config/kline；缺省 120 兜底）。KlineChart/GridCell 的 fitBarSpace
   *  铺满目标据此计算，使初始可见 K 线数随配置变化，且与周期无关（ADR-020 §2.5）。 */
  get viewportBars(): number {
    return this.deps.viewportBars ?? DEFAULT_KLINE_VIEWPORT_BARS;
  }

  /** 实时通路可观测面（诊断 §6(b)）：最近来源 / 最近写入时间 / 最近成功取数 / 连续失败数。 */
  get realtimeStats(): Readonly<RealtimeStats> {
    return this.stats;
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
        this.startRealtimePoll();
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
        if (msg.type === 'bar' && msg.bar) this.applyRealtime(msg.bar as Bar, 'ws');
      },
    );
    // 重连补偿（诊断 §6(a)1「书签式补偿」）：WS 掉线期间的新 bar 只靠重连会永久缺失
    // （`applyRealtime` 只能接上最新一根）⇒ 重连成功后做一次最新窗口 HTTP 增量。
    const onStatusChange = this.deps.ws.onStatusChange?.bind(this.deps.ws);
    if (onStatusChange) {
      // 订阅时 WS 已处于 open（先建连接后加载数据的常规时序）⇒ 那是「首连」不是「重连」，不得误当补偿点。
      if (this.deps.ws.connectionStatus === 'open') this.wsEverOpen = true;
      this.unsubWsStatus = onStatusChange((s) => {
        if (s !== 'open') return;
        if (!this.wsEverOpen) {
          this.wsEverOpen = true; // 首次连接：初始取数已覆盖，不重复补偿
          return;
        }
        void this.pollIncrement('poll'); // 补偿失败只计入退避，不弹错
      });
    }
  }

  /** 启动每分钟兜底轮询（loadInitial 成功后自动调度；交易时段/可见性在轮询体内判定）。 */
  private startRealtimePoll(): void {
    if (this.disposed || this.pollTimer) return;
    this.schedulePoll(REALTIME_POLL_INTERVAL_MS);
  }

  /** 自 re-arm 定时器（每次调度先清旧，退避期间不会叠加固定 60s 触发）。 */
  private schedulePoll(delayMs: number): void {
    if (this.disposed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollTick();
    }, delayMs);
  }

  /** 轮询体：交易时段 + 页面可见才发请求（口径③）；否则只重排定时器（0 HTTP）。 */
  private async pollTick(): Promise<void> {
    if (this.disposed) return;
    if (!this.shouldPollNow()) {
      this.schedulePoll(REALTIME_POLL_INTERVAL_MS);
      return;
    }
    const ok = await this.pollIncrement('poll');
    if (this.disposed) return;
    const failures = this.stats.pollFailures;
    this.schedulePoll(
      ok
        ? REALTIME_POLL_INTERVAL_MS // 成功 ⇒ 复位为常规 60s 节奏
        : (REALTIME_POLL_BACKOFF_MS[Math.min(failures - 1, REALTIME_POLL_BACKOFF_MS.length - 1)] ??
            REALTIME_POLL_INTERVAL_MS),
    );
  }

  /** 是否该真正发兜底请求：页面可见（`document.hidden` 抑制）+ 交易时段（口径③）。
   *  交易时段判定复用宿主既有能力 `@/shell/session`（02-sources §L2 写死口径：工作日 09:30-11:30 / 13:00-15:00）。 */
  private shouldPollNow(): boolean {
    if (this.disposed || this.pollBusy) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    return tradingSession(new Date()) === 'trading';
  }

  /**
   * 增量取数 + 合并（每分钟兜底 / WS 重连补偿共用，口径②）：取最新窗口（无 `before`）→ 逐根走**同一** `applyRealtime`
   * （更晚 append / 同 ts 覆盖 / 更早忽略；同 ts 且 OHLCV 一致则不写不 emit ⇒ 与 WS 天然不重复）。
   * 永不抛错（失败计入退避、不清空、不弹错）；返回是否成功。
   */
  async pollIncrement(source: RealtimeSource = 'poll'): Promise<boolean> {
    if (this.disposed || this.pollBusy) return false;
    this.pollBusy = true;
    try {
      const bars = await pollLatestWindow(
        this.deps.api,
        this.deps.code,
        this.deps.period,
        REALTIME_POLL_LIMIT,
      );
      if (this.disposed) return false;
      for (const bar of bars) this.applyRealtime(bar, source);
      this.stats = { ...this.stats, lastPollOkAt: Date.now(), pollFailures: 0 };
      return true;
    } catch {
      this.stats = { ...this.stats, pollFailures: this.stats.pollFailures + 1 };
      return false;
    } finally {
      this.pollBusy = false;
    }
  }

  /** WS 实时 / 兜底增量合并（定稿 1c；口径②）：更晚 ts → appendBar；同 ts（值变）→ updateBar 闪动替换；
   *  更早 → 忽略；同 ts 且 OHLCV 一致 → 忽略（幂等，不重复写入/不重烩）。`source` 仅用于可观测面。 */
  applyRealtime(bar: Bar, source: RealtimeSource = 'ws'): 'append' | 'update' | 'ignore' {
    const last = this.bars.at(-1);
    const t = Date.parse(bar.ts);
    let result: 'append' | 'update' | 'ignore';
    if (!last || t > Date.parse(last.ts)) {
      this.bars = [...this.bars, bar];
      if (this.status === 'empty') this.status = 'ready';
      result = 'append';
    } else if (t === Date.parse(last.ts)) {
      if (sameBarValues(last, bar)) return 'ignore'; // 幂等：与兜底/重连补偿重复取回同一根
      this.bars = [...this.bars.slice(0, -1), bar];
      result = 'update';
    } else {
      result = 'ignore';
    }
    if (result !== 'ignore') {
      this.stats = { ...this.stats, lastSource: source, lastWriteAt: Date.now() };
      this.rtListeners.forEach((cb) => cb(bar));
      this.emit();
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.unsubWs?.();
    this.unsubWs = null;
    this.unsubWsStatus?.();
    this.unsubWsStatus = null;
    this.listeners.clear();
    this.rtListeners.clear();
  }
}
