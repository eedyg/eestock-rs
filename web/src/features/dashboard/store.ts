import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import type { GridMode, Period, SymbolSnapshot } from '@/api/types';
import type { ApiClient } from '@/api/client';
import type { WsClient, WsMessage } from '@/ws/WsClient';

export type SymbolsStatus = 'loading' | 'ready' | 'error';

export interface DashboardState {
  symbols: SymbolSnapshot[];
  symbolsStatus: SymbolsStatus;
  selected: string | null;
  period: Period;
  gridMode: GridMode;
  followLatest: boolean; // 手动缩放/平移后 false（定稿 1c：不强拉）
  search: string;
}

type WsLike = Pick<WsClient, 'subscribe'>;

/**
 * 页面①状态机（图表库无关）：标的集合/选中/周期/宫格/跟随/搜索 + WS quote 增量。
 * 组件经 useSyncExternalStore 绑定；bar 数据流在 KlineDataFeed（feed.ts）。
 */
export class DashboardStore {
  private current: DashboardState = {
    symbols: [],
    symbolsStatus: 'loading',
    selected: null,
    period: DASHBOARD_DEFAULTS.period,
    gridMode: DASHBOARD_DEFAULTS.view,
    followLatest: true,
    search: '',
  };
  private listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(private deps: { api: ApiClient; ws: WsLike }) {}

  /** 当前状态（快照对象在 patch 时整体替换，引用在两次变更间稳定） */
  get state(): DashboardState {
    return this.current;
  }

  // useSyncExternalStore 绑定（箭头属性保证引用稳定）
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): DashboardState => this.current;

  get filteredSymbols(): SymbolSnapshot[] {
    const q = this.current.search.trim().toLowerCase();
    if (!q) return this.current.symbols;
    return this.current.symbols.filter(
      (s) => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
    );
  }

  private patch(p: Partial<DashboardState>) {
    if (this.disposed) return;
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    this.patch({ symbolsStatus: 'loading' });
    if (this.unsubs.length === 0) {
      this.unsubs.push(
        this.deps.ws.subscribe('quote', (msg: WsMessage) => {
          if (msg.type !== 'quote' || typeof msg.code !== 'string') return;
          const symbols = this.current.symbols.map((s) =>
            s.code === msg.code
              ? { ...s, last: msg.last as number, changePct: msg.changePct as number }
              : s,
          );
          this.patch({ symbols });
        }),
      );
    }
    try {
      const symbols = await this.deps.api.getSymbols();
      const selected = symbols.some((s) => s.code === this.current.selected)
        ? this.current.selected
        : (symbols[0]?.code ?? null);
      this.patch({ symbols, symbolsStatus: 'ready', selected });
    } catch {
      this.patch({ symbolsStatus: 'error' });
    }
  }

  selectSymbol(code: string): void {
    // 换标的重置跟随（新图从最新开始）
    this.patch({ selected: code, followLatest: true });
  }

  setPeriod(period: Period): void {
    this.patch({ period });
  }

  setGridMode(gridMode: GridMode): void {
    // 宫格切换不丢状态：仅切视图，周期/选中/搜索保留
    this.patch({ gridMode });
  }

  setSearch(search: string): void {
    this.patch({ search });
  }

  noteManualZoom(): void {
    this.patch({ followLatest: false });
  }

  backToLatest(): void {
    this.patch({ followLatest: true });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.listeners.clear();
  }
}
