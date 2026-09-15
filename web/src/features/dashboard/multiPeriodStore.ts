import type { ApiClient } from '@/api/client';
import type { MultiPeriodConfigDto, Period } from '@/api/types';

/**
 * 多周期指标同显运行态（`design/15-multi-period/02-spec.md` §1「multiPeriodStore（新）」）。
 * 与既有 `DashboardStore` 并列（`useSyncExternalStore` 绑定）；**不持有数据流**（每实例 `KlineDataFeed`
 * 由 P2 的容器负责），故本 store 不订阅 WS、不发起任何 K 线请求（T11 关闭态零副作用）。
 *
 * 口径：`enabled=false` ⇒ 行为与现状完全一致（单实例、单周期；ADR-022 口径 5 + 02-spec §7.5）。
 * `syncDegraded` / `lastSpanDiffMinutes` 为 T8bis 降级口径的**可观测字段占位**（P2/P3 写入 UI/日志）。
 */
export interface MultiPeriodState {
  /** 多周期开关（默认 false ⇒ 关闭态与现状逐字节等价）。 */
  enabled: boolean;
  /** `[基准, ...卫星]`；关闭态默认单基准。 */
  periods: string[];
  /** 每实例高度 px（键必须与 `periods` 一一对应；02-spec §6）。 */
  heights: Record<string, number>;
  /** 卫星继承的指标集合（首版 `["dcap"]`；口径 5/7）。 */
  indicators: string[];
  /** T8bis：同步降级（「对齐受限」）标志；无同步 ⇒ false。 */
  syncDegraded: boolean;
  /**
   * P3-D-2 可观测：最近一次降级的**跟随者周期**（正常 null）。
   * **base 作为 follower 降级时此处即基准周期** —— 角标仍只渲染在卫星 pane（已知限制），
   * 但降级必须能从 store/stats 读出（严禁静默虚假对齐）。
   */
  syncDegradedPeriod: string | null;
  /** T8bis：最近一次对齐跨度差（分钟）；无记录 ⇒ null（不得伪造 0）。 */
  lastSpanDiffMinutes: number | null;
  /** P3 可观测（02-spec §9）：成功对齐广播次数（`syncApplied`）。 */
  syncApplied: number;
  /** P3 可观测（02-spec §9）：重入抑制/程序化回传被丢弃的事件数（`syncSuppressed`）。 */
  syncSuppressed: number;
  // 说明（P5.5）：基准周期口径（`basePeriodOverridden` / `basePeriodSource`）**不再存于本快照**。
  // 它需要同时比较 `periods[0]` 与**工具栏/状态周期 `state.period`**（02-spec §2.1 专项裁定 2026-09-15），
  // 而 `state.period` 属 `DashboardStore`（本 store 不持该数据流）。存快照会让「被覆盖」永远为 true、
  // `[data-mp-base-override]` 徽标永不消失 ⇒ §2.1 的一致态无法达成。故改为**在读处**由 `resolveBasePeriod`
  // 用调用方传入的 `toolbarPeriod` 现算（单一权威、无静默不一致）。
}

/**
 * 基准周期口径推导（纯函数，用户裁决 A + 02-spec §2.1 专项裁定 2026-09-15）：
 * 仅当「启用 **且** 确实存在卫星（`periods.length > 1`）**且** `periods[0] !== toolbarPeriod`」时，
 * 基准周期才由配置 `periods[0]` 覆盖（`source='config'`，显式可观测）；否则沿用工具栏/状态周期。
 *
 * **必须比较 `periods[0]` 与 `state.period`**：否则选择器「同时写 `periods[0]` 与 `state.period`」后覆盖态仍为 true，
 * 徽标永不消失、§2.1 的可观测不一致永远无法消除（P5.5-A 红测试发现的缺陷）。
 * 单周期配置（`length === 1`）下不存在多周期视图 ⇒ 「启用」不得静默改写用户选的 K 线周期。
 */
export function basePeriodDerivation(
  enabled: boolean,
  periods: readonly string[],
  toolbarPeriod: Period,
): { basePeriodOverridden: boolean; basePeriodSource: 'config' | 'toolbar' } {
  const basePeriodOverridden = enabled && periods.length > 1 && periods[0] !== toolbarPeriod;
  return { basePeriodOverridden, basePeriodSource: basePeriodOverridden ? 'config' : 'toolbar' };
}

/** 解析基准（K 线）周期：仅当「启用且存在卫星且 `periods[0] !== state.period`」时 = `periods[0]`，
 *  否则 = 工具栏/状态周期（`state.period`）。 */
export function resolveBasePeriod(
  state: Pick<MultiPeriodState, 'enabled' | 'periods'>,
  toolbarPeriod: Period,
): { period: Period; source: 'config' | 'toolbar'; overridden: boolean } {
  const { basePeriodOverridden, basePeriodSource } = basePeriodDerivation(
    state.enabled,
    state.periods,
    toolbarPeriod,
  );
  return {
    period: (basePeriodOverridden ? (state.periods[0] as Period) : toolbarPeriod),
    source: basePeriodSource,
    overridden: basePeriodOverridden,
  };
}

/** 服务端默认（GET /api/config/multi_period 无键/坏值时后端兜底；此处为前端初始态，同构）。
 *  02-spec §2：关闭 + 单基准 + 基准高度 420 + `["dcap"]`。 */
export const DEFAULT_MULTI_PERIOD_CONFIG: MultiPeriodConfigDto = {
  enabled: false,
  periods: ['1m'],
  heights: { '1m': 420 },
  indicators: ['dcap'],
};

/** 由服务端配置 DTO 派生运行态（运行态字段复位：无同步 ⇒ 非降级 + 无跨度差记录）。 */
function toState(cfg: MultiPeriodConfigDto): MultiPeriodState {
  return {
    enabled: cfg.enabled,
    periods: [...cfg.periods],
    heights: { ...cfg.heights },
    indicators: [...cfg.indicators],
    syncDegraded: false,
    syncDegradedPeriod: null,
    lastSpanDiffMinutes: null,
    syncApplied: 0,
    syncSuppressed: 0,
  };
}

/**
 * 多周期运行态 store。`load()` 镜像服务端配置（读失败保持默认关闭，不阻塞看板）；
 * `setEnabled()` 为**同步**乐观更新（服务端读写由 DashboardPage 的开关 handler 负责，
 * 照既有 MA/dcap 乐观更新 + 失败回滚写法）；关闭时运行态归零（T11 零残留）。
 */
export class MultiPeriodStore {
  private current: MultiPeriodState = toState(DEFAULT_MULTI_PERIOD_CONFIG);
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(private deps: { api: ApiClient }) {}

  /** 当前状态（快照对象在 patch 时整体替换，引用在两次变更间稳定）。 */
  get state(): MultiPeriodState {
    return this.current;
  }

  // useSyncExternalStore 绑定（箭头属性保证引用稳定）
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MultiPeriodState => this.current;

  private patch(p: Partial<MultiPeriodState>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  /** GET /api/config/multi_period 读并使当前态镜像服务端（读失败保持默认关闭，不抛穿到页面）。 */
  async load(): Promise<void> {
    const getMultiPeriodConfig = this.deps.api.getMultiPeriodConfig;
    if (typeof getMultiPeriodConfig !== 'function') return;
    try {
      const cfg = await getMultiPeriodConfig.call(this.deps.api);
      if (this.disposed || !cfg) return;
      this.patch(toState(cfg));
    } catch {
      // 读取失败（瞬态/后端不可用）：保持默认关闭（不阻塞看板）
    }
  }

  /** 乐观更新开关（同步）。关闭 ⇒ 运行态归零（T11 零残留）；开启（P2 起建实例）本轮仍单图。 */
  setEnabled(enabled: boolean): void {
    if (enabled) this.patch({ enabled: true });
    else
      this.patch({
        enabled: false,
        syncDegraded: false,
        syncDegradedPeriod: null,
        lastSpanDiffMinutes: null,
        syncApplied: 0,
        syncSuppressed: 0,
      });
  }

  /**
   * 同步统计镜像（P3 可观测，02-spec §9；`ChartSyncGroup.stats` → store）：**只镜像可观测字段**，
   * 不驱动任何同步行为（同步原语在 `chartSyncGroup.ts`，本 store 不持数据流）。
   * 值未变化的调用**不 patch**（滚动期间避免无谓的 store 通知/页面重渲染）。
   */
  applySyncStats(stats: {
    applied?: number;
    suppressed?: number;
    degraded: boolean;
    degradedPeriod: string | null;
    lastSpanDiffMinutes: number | null;
  }): void {
    const next = {
      syncDegraded: stats.degraded,
      syncDegradedPeriod: stats.degraded ? (stats.degradedPeriod ?? null) : null,
      lastSpanDiffMinutes: stats.lastSpanDiffMinutes,
      syncApplied: stats.applied ?? this.current.syncApplied,
      syncSuppressed: stats.suppressed ?? this.current.syncSuppressed,
    };
    if (
      next.syncDegraded === this.current.syncDegraded &&
      next.syncDegradedPeriod === this.current.syncDegradedPeriod &&
      next.lastSpanDiffMinutes === this.current.lastSpanDiffMinutes &&
      next.syncApplied === this.current.syncApplied &&
      next.syncSuppressed === this.current.syncSuppressed
    ) {
      return;
    }
    this.patch(next);
  }

  /** 服务端回显 / 失败回滚入口（DashboardPage 乐观更新用）。 */
  applyServerConfig(cfg: MultiPeriodConfigDto): void {
    this.patch(toState(cfg));
  }

  /**
   * 布局高度乐观写（P5；T9）：只替换 `heights`，**不动** `enabled`/`periods`/`indicators`
   * （拖拽持久化不得重置任何其它配置字段；切周期/切标的/保存 dcap 均不得重置高度）。
   * 页面路径：乐观 `setHeights(拖后全表)` → `PUT /api/config/multi_period` → 成功 `applyServerConfig(回显)`
   * / 失败 `applyServerConfig(拖前快照)`（回滚）。
   */
  setHeights(heights: Record<string, number>): void {
    this.patch({ heights: { ...heights } });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
