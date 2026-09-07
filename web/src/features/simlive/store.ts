import type {
  SimBacktestCompare,
  SimOrder,
  SimSessionDetail,
  SimSessionListEntry,
  SimStateDto,
  SimStrategiesDto,
} from '@/api/types';
import type { ApiClient } from '@/api/client';
import type { SimLiveTab } from '@/layouts/SimLiveGrid';

export interface AsyncSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const idle = <T>(): AsyncSlice<T> => ({ data: null, loading: false, error: null });

export interface SimLiveState {
  activeTab: SimLiveTab;
  current: AsyncSlice<SimStateDto>;
  strategies: AsyncSlice<SimStrategiesDto>;
  orders: AsyncSlice<SimOrder[]>;
  sessions: AsyncSlice<SimSessionListEntry[]>;
  selectedSession: AsyncSlice<SimSessionDetail>;
  backtestCompare: AsyncSlice<SimBacktestCompare>;
  /** 动作进行中（用于按钮禁用态）。 */
  starting: boolean;
  stopping: boolean;
  togglingTrading: boolean;
  togglingMcp: boolean;
  placing: boolean;
  /** 最近一次动作错误（actionError；region 内联提示）。 */
  actionError: string | null;
}

/**
 * 页面⑨ 模拟实盘状态机（业务/交互；图表库无关）。
 * 数据流：current GET /api/sim-live/state + strategies GET /api/sim-live/strategies + orders GET /api/sim-live/orders；
 * 历史：sessions GET /api/sim-live/sessions + 详情 GET /api/sim-live/sessions/{id} + 「回测一下」POST .../backtest-compare；
 * 动作：start/stop 会话、统一交易开关 POST /trading、MCP 开关 POST /mcp-toggle、下/撤单。
 * 与 MCP 共享同一 SimLiveService（后端）；前端以「当前运行会话」为默认目标。 */
export class SimLiveStore {
  private current: SimLiveState = {
    activeTab: 'current',
    current: { data: null, loading: true, error: null },
    strategies: { data: null, loading: true, error: null },
    orders: { data: null, loading: true, error: null },
    sessions: { data: null, loading: true, error: null },
    selectedSession: idle(),
    backtestCompare: idle(),
    starting: false,
    stopping: false,
    togglingTrading: false,
    togglingMcp: false,
    placing: false,
    actionError: null,
  };
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(private deps: { api: ApiClient }, initialTab: SimLiveTab = 'current') {
    // #history 深链：构造时由 SimLivePage 读 location.hash 传入初始 Tab。
    this.current = { ...this.current, activeTab: initialTab };
  }

  get state(): SimLiveState {
    return this.current;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): SimLiveState => this.current;

  private patch(p: Partial<SimLiveState>) {
    if (this.disposed) return;
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    await Promise.all([this.loadCurrent(), this.loadStrategies(), this.loadOrders(), this.loadSessions()]);
  }

  /** 会话状态聚合 + 策略评估 + 订单（当前会话）。 */
  async refreshCurrent(): Promise<void> {
    await Promise.all([this.loadCurrent(), this.loadStrategies(), this.loadOrders()]);
  }

  async loadCurrent(): Promise<void> {
    this.patch({ current: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getSimState();
      this.patch({ current: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ current: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async loadStrategies(): Promise<void> {
    this.patch({ strategies: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getSimStrategies();
      this.patch({ strategies: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ strategies: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async loadOrders(): Promise<void> {
    this.patch({ orders: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getSimOrders();
      this.patch({ orders: { data: data.orders, loading: false, error: null } });
    } catch (e) {
      this.patch({ orders: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async loadSessions(): Promise<void> {
    this.patch({ sessions: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getSimSessions();
      this.patch({ sessions: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ sessions: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  setTab(tab: SimLiveTab): void {
    this.patch({ activeTab: tab });
    // 历史 Tab 首次进入即拉列表（幂等；已结束时会话列表随 stop 更新）。
    if (tab === 'history' && this.current.sessions.data == null) void this.loadSessions();
  }

  /** 统一交易开关（POST /api/sim-live/trading）；成功后乐观更新当前态。 */
  async toggleTrading(enabled: boolean): Promise<void> {
    if (this.current.togglingTrading) return;
    this.patch({ togglingTrading: true, actionError: null });
    try {
      const resp = await this.deps.api.toggleSimTrading({ enabled });
      const cur = this.current.current.data;
      if (cur) this.patch({ current: { ...this.current.current, data: { ...cur, trading_enabled: resp.trading_enabled } } });
    } catch (e) {
      this.patch({ actionError: (e as Error).message });
    } finally {
      this.patch({ togglingTrading: false });
    }
  }

  /** MCP sim_* 服务快捷开关（POST /api/sim-live/mcp-toggle；与 MCP 共享同一服务）。 */
  async toggleMcp(enabled: boolean): Promise<void> {
    if (this.current.togglingMcp) return;
    this.patch({ togglingMcp: true, actionError: null });
    try {
      const resp = await this.deps.api.toggleSimMcp({ enabled });
      const cur = this.current.current.data;
      if (cur) this.patch({ current: { ...this.current.current, data: { ...cur, mcp_enabled: resp.mcp_enabled } } });
    } catch (e) {
      this.patch({ actionError: (e as Error).message });
    } finally {
      this.patch({ togglingMcp: false });
    }
  }

  /** 开会话（POST /api/sim-live/start-session）。 */
  async startSession(params: { name: string; period: string; cash_init?: number }): Promise<void> {
    if (this.current.starting) return;
    this.patch({ starting: true, actionError: null });
    try {
      await this.deps.api.startSimSession(params);
      await this.refreshCurrent();
      // 新会话开始 → 历史无变化，但订单/持仓清空。
    } catch (e) {
      this.patch({ actionError: (e as Error).message });
    } finally {
      this.patch({ starting: false });
    }
  }

  /** 停会话（POST /api/sim-live/stop-session）；默认当前会话。 */
  async stopSession(id?: string): Promise<void> {
    if (this.current.stopping) return;
    this.patch({ stopping: true, actionError: null });
    try {
      await this.deps.api.stopSimSession({ session_id: id });
      await this.refreshCurrent();
      void this.loadSessions();
    } catch (e) {
      this.patch({ actionError: (e as Error).message });
    } finally {
      this.patch({ stopping: false });
    }
  }

  /** 下模拟单（POST /api/sim-live/place-order）。 */
  async placeOrder(params: { code: string; side: 'buy' | 'sell'; qty: number; price: number; limit_price?: number }): Promise<void> {
    if (this.current.placing) return;
    this.patch({ placing: true, actionError: null });
    try {
      await this.deps.api.placeSimOrder({ ...params, source: 'web' });
      await this.refreshCurrent();
    } catch (e) {
      this.patch({ actionError: (e as Error).message });
    } finally {
      this.patch({ placing: false });
    }
  }

  /** 撤单（POST /api/sim-live/cancel-order）。 */
  async cancelOrder(orderId: string): Promise<void> {
    this.patch({ actionError: null });
    const sid = this.current.current.data?.session?.id;
    try {
      await this.deps.api.cancelSimOrder({ session_id: sid ?? '', order_id: orderId });
      await this.loadOrders();
    } catch (e) {
      this.patch({ actionError: (e as Error).message });
    }
  }

  /** 历史会话详请（GET /api/sim-live/sessions/{id}）。 */
  async selectSession(id: string): Promise<void> {
    this.patch({ selectedSession: { data: null, loading: true, error: null }, backtestCompare: idle() });
    try {
      const data = await this.deps.api.getSimSession(id);
      this.patch({ selectedSession: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ selectedSession: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 「回测一下」对比（POST /api/sim-live/sessions/{id}/backtest-compare）。 */
  async runBacktestCompare(id: string): Promise<void> {
    this.patch({ backtestCompare: { data: null, loading: true, error: null }, actionError: null });
    try {
      const data = await this.deps.api.runSimBacktestCompare(id);
      this.patch({ backtestCompare: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ backtestCompare: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
