import { QUALITY_DEFAULTS, type QualityView } from '@/layouts/QualityGrid';
import type {
  QualityDivergenceResponse,
  QualityGapsResponse,
  SourceAccuracyResponse,
  SymbolSnapshot,
  TushareStatusResponse,
} from '@/api/types';
import type { ApiClient } from '@/api/client';

export interface AsyncSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface QualityRange {
  from: string; // YYYY-MM-DD（CST 日界）
  to: string;
}

export interface QualityFilterState {
  code: string | null;
  range: QualityRange;
  view: QualityView;
}

export interface QualityState {
  symbols: AsyncSlice<SymbolSnapshot[]>;
  filter: QualityFilterState;
  divergence: AsyncSlice<QualityDivergenceResponse>;
  accuracy: AsyncSlice<SourceAccuracyResponse>;
  gaps: AsyncSlice<QualityGapsResponse>;
  tushare: AsyncSlice<TushareStatusResponse>;
}

/** Date → CST 日历日 "YYYY-MM-DD"（固定 +8，与浏览器时区无关） */
export function cstDateStr(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 默认范围：近 7 个自然日（CST），to=今日（缺口/分歧复盘窗口；后端上限 62 天） */
export function defaultRange(now: Date, days = 7): QualityRange {
  return {
    from: cstDateStr(new Date(now.getTime() - (days - 1) * 86_400_000)),
    to: cstDateStr(now),
  };
}

const idle: AsyncSlice<never> = { data: null, loading: false, error: null };

/**
 * 页面④数据质量状态机（04-quality L2）：
 * 过滤（标的+日期范围）变更即重查 divergence/accuracy/gaps 三端点；视图切换为客户端状态不重查；
 * tushare 状态独立加载（sync-panel）。四区各自三态互不阻塞。
 * 一致率口径取 QUALITY_DEFAULTS.consistencyThresholdPct（0.5），缺省不传由后端兜底同值。
 */
export class QualityStore {
  private current: QualityState;
  private listeners = new Set<() => void>();
  private now: () => Date;

  constructor(private deps: { api: ApiClient; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
    this.current = {
      symbols: { ...idle, loading: true },
      filter: { code: null, range: defaultRange(this.now()), view: QUALITY_DEFAULTS.view },
      divergence: { ...idle },
      accuracy: { ...idle },
      gaps: { ...idle },
      tushare: { ...idle, loading: true },
    };
  }

  get state(): QualityState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): QualityState => this.current;

  private patch(p: Partial<QualityState>) {
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    await Promise.all([this.loadSymbols(), this.loadTushare()]);
    await this.loadQuality();
  }

  private async loadSymbols(): Promise<void> {
    try {
      const data = await this.deps.api.getSymbols();
      const code = this.current.filter.code ?? data[0]?.code ?? null;
      this.patch({ symbols: { data, loading: false, error: null }, filter: { ...this.current.filter, code } });
    } catch (e) {
      this.patch({ symbols: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  private async loadTushare(): Promise<void> {
    this.patch({ tushare: { ...this.current.tushare, loading: true, error: null } });
    try {
      const data = await this.deps.api.getTushareStatus();
      this.patch({ tushare: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ tushare: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 过滤口径三端点重查（divergence/gaps 需 code；accuracy 为窗口全源口径不带 code） */
  private async loadQuality(): Promise<void> {
    await Promise.all([this.loadDivergence(), this.loadAccuracy(), this.loadGaps()]);
  }

  private async loadDivergence(): Promise<void> {
    const { code, range } = this.current.filter;
    if (!code) {
      this.patch({ divergence: { ...idle } });
      return;
    }
    this.patch({ divergence: { ...this.current.divergence, loading: true, error: null } });
    try {
      const data = await this.deps.api.getQualityDivergence({ code, ...range });
      this.patch({ divergence: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ divergence: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  private async loadAccuracy(): Promise<void> {
    const { range } = this.current.filter;
    this.patch({ accuracy: { ...this.current.accuracy, loading: true, error: null } });
    try {
      const data = await this.deps.api.getSourceAccuracy({ ...range });
      this.patch({ accuracy: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ accuracy: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  private async loadGaps(): Promise<void> {
    const { code, range } = this.current.filter;
    if (!code) {
      this.patch({ gaps: { ...idle } });
      return;
    }
    this.patch({ gaps: { ...this.current.gaps, loading: true, error: null } });
    try {
      const data = await this.deps.api.getQualityGaps({ code, ...range });
      this.patch({ gaps: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ gaps: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 过滤变更即重查（04-quality L2 filter-bar 交互） */
  async setFilter(patch: Partial<Pick<QualityFilterState, 'code' | 'range'>>): Promise<void> {
    this.patch({ filter: { ...this.current.filter, ...patch } });
    await this.loadQuality();
  }

  /** 视图切换为客户端状态（overlay 复用 divergence 数据渲染），不触发重查 */
  setView(view: QualityView): void {
    this.patch({ filter: { ...this.current.filter, view } });
  }

  async retryDivergence(): Promise<void> {
    await this.loadDivergence();
  }
  async retryAccuracy(): Promise<void> {
    await this.loadAccuracy();
  }
  async retryGaps(): Promise<void> {
    await this.loadGaps();
  }
  async retryTushare(): Promise<void> {
    await this.loadTushare();
  }
}
