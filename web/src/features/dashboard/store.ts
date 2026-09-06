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

  /** 读 URL `?code=` 深链参数（不存在 → null）。批1c C1b：支持打开/刷新按 URL code 选中。 */
  private readUrlCode(): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('code');
  }

  /**
   * 初选解析优先级：URL `?code=`（存在且在 symbols 中）> 现有 selected（重试保留）> 默认首只。
   * C1b：URL 带 code 且已注册 → 选中该只；URL code 不存在（未注册/停用）→ 回退默认首只；无 code → 默认首只。
   */
  private resolveInitialSelected(symbols: SymbolSnapshot[], urlCode: string | null): string | null {
    if (urlCode && symbols.some((s) => s.code === urlCode)) return urlCode;
    if (symbols.some((s) => s.code === this.current.selected)) return this.current.selected;
    return symbols[0]?.code ?? null;
  }

  async init(): Promise<void> {
    this.patch({ symbolsStatus: 'loading' });
    if (this.unsubs.length === 0) {
      this.unsubs.push(
        this.deps.ws.subscribe('quote', (msg: WsMessage) => {
          if (msg.type !== 'quote' || typeof msg.code !== 'string') return;
          // K1 容错归一化：服务端新契约已对齐 camelCase（changePct），此处兼容历史帧/其他源
          // 的 snake_case change_pct，并回退 0 防空值触发 toFixed 崩溃（与 REST 客户端一致）。
          const changePct = ((msg.change_pct ?? msg.changePct) ?? 0) as number;
          const symbols = this.current.symbols.map((s) =>
            s.code === msg.code
              ? { ...s, last: msg.last as number, changePct }
              : s,
          );
          this.patch({ symbols });
        }),
      );
    }
    try {
      const symbols = await this.deps.api.getSymbols();
      const selected = this.resolveInitialSelected(symbols, this.readUrlCode());
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

  /** 看板收藏（Wave 3 页面①）：星标切换——乐观更新收藏标注 + 调 api.starSymbol/unstarSymbol，失败回滚并 rethrow。
   *  仅更新 favorite/favoriteSort 字段（list 顺序保持 getSymbols 后端口径），收藏置顶展示由 SymbolList 分区负责（不擅动宫格）。 */
  async toggleFavorite(code: string): Promise<void> {
    const prev = this.current.symbols;
    const target = prev.find((s) => s.code === code);
    if (!target) return;
    const isFav = target.favorite === true;
    if (isFav) {
      const next = prev.map((s) =>
        s.code === code ? { ...s, favorite: false, favoriteSort: null } : s,
      );
      this.patch({ symbols: next });
      try {
        await this.deps.api.unstarSymbol(code);
      } catch (e) {
        this.patch({ symbols: prev });
        throw e;
      }
    } else {
      const maxSort = prev
        .filter((s) => s.favorite === true)
        .reduce((m, s) => Math.max(m, s.favoriteSort ?? 0), 0);
      const next = prev.map((s) =>
        s.code === code ? { ...s, favorite: true, favoriteSort: maxSort + 1 } : s,
      );
      this.patch({ symbols: next });
      try {
        await this.deps.api.starSymbol(code);
      } catch (e) {
        this.patch({ symbols: prev });
        throw e;
      }
    }
  }

  /** 看板收藏：批量重排（乐观更新 favoriteSort + 调 api.reorderFavorites），失败回滚并 rethrow。 */
  async reorderFavorites(codes: string[]): Promise<void> {
    const prev = this.current.symbols;
    const order = new Map(codes.map((c, i) => [c, i + 1]));
    const next = prev.map((s) =>
      s.favorite === true && order.has(s.code)
        ? { ...s, favoriteSort: order.get(s.code)! }
        : s,
    );
    this.patch({ symbols: next });
    try {
      await this.deps.api.reorderFavorites(codes);
    } catch (e) {
      this.patch({ symbols: prev });
      throw e;
    }
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
