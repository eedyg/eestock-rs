import { SOURCES_DEFAULTS } from '@/layouts/SourcesGrid';
import type {
  AlertItem,
  DetailRange,
  DivergenceStat,
  MetricPoint,
  QualityGapsResponse,
  RateLimitCounters,
  SourceEventItem,
  SourcesHealth,
  SymbolSnapshot,
} from '@/api/types';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';

export interface AsyncSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const idle = <T>(): AsyncSlice<T> => ({ data: null, loading: false, error: null });

export interface DetailState {
  metrics: AsyncSlice<MetricPoint[]>;
  events: AsyncSlice<SourceEventItem[]>;
  divergence: AsyncSlice<DivergenceStat>;
  rateLimits: AsyncSlice<RateLimitCounters>;
}

/** Date → CST 日历日 'YYYY-MM-DD'（固定 +8，与浏览器时区无关，04-quality §7 同口径） */
export function cstDateStr(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 页②缺口摘要窗口：近 7 个自然日（CST），to=今日（00-web-api §1.1 缺口端点跨度钳制 ≤62 天） */
export function gapRange(now: Date): { from: string; to: string } {
  const days = SOURCES_DEFAULTS.gapRangeDays - 1;
  return {
    from: cstDateStr(new Date(now.getTime() - days * 86_400_000)),
    to: cstDateStr(now),
  };
}

export interface SourcesState {
  health: AsyncSlice<SourcesHealth>;
  /** 标的选择器数据（缺口摘要用；复用页面①/④ symbols 列表） */
  symbols: AsyncSlice<SymbolSnapshot[]>;
  /** 缺口摘要所选标的（默认首个，非任意） */
  selectedCode: string | null;
  gaps: AsyncSlice<QualityGapsResponse>;
  alerts: AsyncSlice<AlertItem[]>;
  selected: string | null;
  detailRange: DetailRange;
  detail: DetailState | null; // 仅选中时存在
  /** 源 id → 状态迁移计数（卡片闪烁/迁移动画驱动；WS 推送重拉后对比得出） */
  flashes: Record<string, number>;
  resetting: Record<string, boolean>;
  resetErrors: Record<string, string>;
}

type WsLike = Pick<WsClient, 'subscribe'>;

/**
 * 页面②数据源诊断状态机（图表库无关）。
 * 健康数据：GET /api/sources/health + WS source_health 推送触发重拉（02-sources L2 既定）；
 * detail-panel 数据随选中/范围切换加载；gaps/alerts 仅 init 加载（WS 不含其增量）。
 */
export class SourcesStore {
  private current: SourcesState = {
    health: { data: null, loading: true, error: null },
    symbols: { data: null, loading: true, error: null },
    selectedCode: null,
    gaps: idle(),
    alerts: idle(),
    selected: null,
    detailRange: SOURCES_DEFAULTS.detailRange,
    detail: null,
    flashes: {},
    resetting: {},
    resetErrors: {},
  };
  private listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(private deps: { api: ApiClient; ws: WsLike }) {}

  get state(): SourcesState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): SourcesState => this.current;

  private patch(p: Partial<SourcesState>) {
    if (this.disposed) return;
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    if (this.unsubs.length === 0) {
      this.unsubs.push(this.deps.ws.subscribe('source_health', () => void this.refreshHealth()));
    }
    // 先载符号表确定默认标的，再载缺口摘要（单标的，方案 A：页②缺口区降级为单标的摘要）
    await this.loadSymbols();
    await Promise.all([this.refreshHealth(), this.loadGaps(), this.loadAlerts()]);
  }

  /** 健康重拉（init / WS 推送 / 复位后共用）；状态迁移的源记入 flashes */
  async refreshHealth(): Promise<void> {
    try {
      const data = await this.deps.api.getSourcesHealth();
      const prev = this.current.health.data;
      const flashes = { ...this.current.flashes };
      if (prev) {
        for (const s of data.sources) {
          const before = prev.sources.find((p) => p.source === s.source);
          if (before && (before.status !== s.status || before.circuit_state !== s.circuit_state)) {
            flashes[s.source] = (flashes[s.source] ?? 0) + 1;
          }
        }
      }
      this.patch({ health: { data, loading: false, error: null }, flashes });
    } catch (e) {
      this.patch({
        health: { ...this.current.health, loading: false, error: (e as Error).message },
      });
    }
  }

  private async loadSymbols(): Promise<void> {
    this.patch({ symbols: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getSymbols();
      const code = this.current.selectedCode ?? data[0]?.code ?? null;
      this.patch({ symbols: { data, loading: false, error: null }, selectedCode: code });
    } catch (e) {
      this.patch({ symbols: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 单标的缺口摘要（方案 A：GET /api/quality/gaps?code=&from=&to=；目录见 00-web-api §1.1） */
  private async loadGaps(): Promise<void> {
    const code = this.current.selectedCode;
    if (!code) {
      this.patch({ gaps: { data: null, loading: false, error: null } });
      return;
    }
    this.patch({ gaps: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getQualityGaps({ code, ...gapRange(new Date()) });
      this.patch({ gaps: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ gaps: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 缺口摘要切换标的：更新选择并重查（默认选首个/上一标的，非任意） */
  selectCode(code: string): void {
    if (code === this.current.selectedCode) return;
    this.patch({ selectedCode: code });
    void this.loadGaps();
  }

  /** 缺口摘要重试（错误占位+重试，L2 三态） */
  async retryGaps(): Promise<void> {
    await this.loadGaps();
  }

  private async loadAlerts(): Promise<void> {
    this.patch({ alerts: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getAlerts(SOURCES_DEFAULTS.alertPreviewLimit);
      this.patch({ alerts: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ alerts: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 点卡展开/折叠（L2：再次点卡或关闭折叠） */
  selectSource(id: string | null): void {
    if (id === null || id === this.current.selected) {
      this.patch({ selected: null, detail: null });
      return;
    }
    this.patch({
      selected: id,
      detail: { metrics: idle(), events: idle(), divergence: idle(), rateLimits: idle() },
    });
    void this.loadDetail(id);
  }

  setDetailRange(range: DetailRange): void {
    this.patch({ detailRange: range });
    const id = this.current.selected;
    if (!id) return;
    // 范围切换只重查时序/分歧率/限流计数（事件流水无 range 维度，L2）
    void this.loadMetrics(id, range);
    void this.loadDivergence(id, range);
    void this.loadRateLimits(id, range);
  }

  private detailGuard(id: string): boolean {
    return !this.disposed && this.current.selected === id && this.current.detail !== null;
  }

  private async loadDetail(id: string): Promise<void> {
    await Promise.all([
      this.loadMetrics(id, this.current.detailRange),
      this.loadEvents(id),
      this.loadDivergence(id, this.current.detailRange),
      this.loadRateLimits(id, this.current.detailRange),
    ]);
  }

  private async loadMetrics(id: string, range: DetailRange): Promise<void> {
    if (!this.detailGuard(id)) return;
    this.patch({ detail: { ...this.current.detail!, metrics: { data: null, loading: true, error: null } } });
    try {
      const data = await this.deps.api.getSourceMetrics(id, range);
      if (this.detailGuard(id))
        this.patch({ detail: { ...this.current.detail!, metrics: { data, loading: false, error: null } } });
    } catch (e) {
      if (this.detailGuard(id))
        this.patch({
          detail: { ...this.current.detail!, metrics: { data: null, loading: false, error: (e as Error).message } },
        });
    }
  }

  private async loadEvents(id: string): Promise<void> {
    if (!this.detailGuard(id)) return;
    this.patch({ detail: { ...this.current.detail!, events: { data: null, loading: true, error: null } } });
    try {
      const data = await this.deps.api.getSourceEvents(id, SOURCES_DEFAULTS.eventLimit);
      if (this.detailGuard(id))
        this.patch({ detail: { ...this.current.detail!, events: { data, loading: false, error: null } } });
    } catch (e) {
      if (this.detailGuard(id))
        this.patch({
          detail: { ...this.current.detail!, events: { data: null, loading: false, error: (e as Error).message } },
        });
    }
  }

  private async loadDivergence(id: string, range: DetailRange): Promise<void> {
    if (!this.detailGuard(id)) return;
    this.patch({
      detail: { ...this.current.detail!, divergence: { data: null, loading: true, error: null } },
    });
    try {
      const data = await this.deps.api.getSourceDivergence(id, range);
      if (this.detailGuard(id))
        this.patch({
          detail: { ...this.current.detail!, divergence: { data, loading: false, error: null } },
        });
    } catch (e) {
      if (this.detailGuard(id))
        this.patch({
          detail: {
            ...this.current.detail!,
            divergence: { data: null, loading: false, error: (e as Error).message },
          },
        });
    }
  }

  private async loadRateLimits(id: string, range: DetailRange): Promise<void> {
    if (!this.detailGuard(id)) return;
    this.patch({
      detail: { ...this.current.detail!, rateLimits: { data: null, loading: true, error: null } },
    });
    try {
      const data = await this.deps.api.getSourceRateLimits(id, range);
      if (this.detailGuard(id))
        this.patch({
          detail: { ...this.current.detail!, rateLimits: { data, loading: false, error: null } },
        });
    } catch (e) {
      if (this.detailGuard(id))
        this.patch({
          detail: {
            ...this.current.detail!,
            rateLimits: { data: null, loading: false, error: (e as Error).message },
          },
        });
    }
  }

  /** 熔断手动复位：POST /api/sources/{id}/reset（202 异步；成功后重拉健康） */
  async resetCircuit(id: string): Promise<void> {
    this.patch({
      resetting: { ...this.current.resetting, [id]: true },
      resetErrors: { ...this.current.resetErrors, [id]: '' },
    });
    try {
      await this.deps.api.resetSource(id);
      await this.refreshHealth();
    } catch (e) {
      this.patch({ resetErrors: { ...this.current.resetErrors, [id]: (e as Error).message } });
    } finally {
      this.patch({ resetting: { ...this.current.resetting, [id]: false } });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}
