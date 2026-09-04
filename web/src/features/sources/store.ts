import { SOURCES_DEFAULTS } from '@/layouts/SourcesGrid';
import type {
  AlertItem,
  DetailRange,
  DivergenceStat,
  GapStat,
  MetricPoint,
  RateLimitCounters,
  SourceEventItem,
  SourcesHealth,
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

export interface SourcesState {
  health: AsyncSlice<SourcesHealth>;
  gaps: AsyncSlice<GapStat[]>;
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

  private async loadGaps(): Promise<void> {
    this.patch({ gaps: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getGaps();
      this.patch({ gaps: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ gaps: { data: null, loading: false, error: (e as Error).message } });
    }
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
