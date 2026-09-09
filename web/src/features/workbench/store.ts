import type {
  StrategyCatalogEntry,
  SymbolSnapshot,
  WorkbenchCompareItem,
  WorkbenchPresetConfigInput,
  WorkbenchPresetRow,
  WorkbenchRunConfig,
  WorkbenchRunResult,
  WorkbenchRunView,
  WorkbenchSubmitReq,
} from '@/api/types';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';

export interface AsyncSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const idle = <T>(): AsyncSlice<T> => ({ data: null, loading: false, error: null });

/** compare 勾选题上限（ADR §13.5 多任务 compare；任务书 ≤4）。 */
export const MAX_COMPARE = 4;

interface ProgressInfo {
  progress: number; // 0..1（WS 原生口径；组件渲染 ×100）
  barTs: string | null;
}

export interface WorkbenchState {
  catalog: AsyncSlice<StrategyCatalogEntry[]>;
  presets: AsyncSlice<WorkbenchPresetRow[]>;
  /** 标的下拉数据源（GET /api/symbols；仅 enabled 可选）。 */
  symbols: AsyncSlice<SymbolSnapshot[]>;
  runs: AsyncSlice<WorkbenchRunView[]>;
  /** 分页：列表是否还有更多（返回条数 == limit）。 */
  hasMore: boolean;
  loadingMore: boolean;
  selectedRunId: string | null;
  result: AsyncSlice<WorkbenchRunResult>;
  compareIds: string[];
  compare: AsyncSlice<WorkbenchCompareItem[]>;
  view: 'single' | 'compare';
  /** WS strategy_run_progress 增量（run_id → {progress,barTs}），覆盖 REST 进度。 */
  progressMap: Record<string, ProgressInfo>;
  submitting: boolean;
  submitError: string | null;
}

type WsLike = Pick<WsClient, 'subscribe'>;

/** 工作台 WS 帧载荷（{type:"strategy_run_progress", run_id, progress 0..1, bar_ts}）。 */
interface StrategyRunProgressMsg {
  type?: string;
  run_id?: string;
  progress?: number;
  bar_ts?: string | null;
}

/**
 * 页面⑪ 回测工作台状态机（12-strategy-system / P3b；§1.8）。
 * 数据流：catalog GET /api/strategies + presets GET /api/workbench/presets +
 * runs GET /api/workbench/runs（分页）；选中结果 GET …/result；对比 POST …/compare；
 * WS `strategy_run_progress`（topic=strategy_run）引擎 observer 事件驱动进度 → progressMap。
 * 与 BacktestStore 同模式（外部 store + useSyncExternalStore）。
 */
export class WorkbenchStore {
  private current: WorkbenchState = {
    catalog: { data: null, loading: true, error: null },
    presets: { data: null, loading: true, error: null },
    symbols: { data: null, loading: true, error: null },
    runs: { data: null, loading: true, error: null },
    hasMore: false,
    loadingMore: false,
    selectedRunId: null,
    result: idle(),
    compareIds: [],
    compare: idle(),
    view: 'single',
    progressMap: {},
    submitting: false,
    submitError: null,
  };
  /** 分页单页 limit（与后端默认一致；条数==limit 即还有更多）。 */
  private runLimit = 100;
  private runNextOffset = 0;
  private listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(private deps: { api: ApiClient; ws: WsLike }) {}

  get state(): WorkbenchState {
    return this.current;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): WorkbenchState => this.current;

  private patch(p: Partial<WorkbenchState>) {
    if (this.disposed) return;
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    if (this.unsubs.length === 0) {
      this.unsubs.push(
        this.deps.ws.subscribe('strategy_run', (msg) => this.onProgress(msg as StrategyRunProgressMsg)),
      );
    }
    await Promise.all([this.loadCatalog(), this.loadPresets(), this.loadSymbols(), this.loadRuns()]);
  }

  async loadSymbols(): Promise<void> {
    try {
      const data = await this.deps.api.getSymbols();
      this.patch({ symbols: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ symbols: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** WS 进度回调节点：按 run_id 落 progressMap；progress>=1（完成信号）驱动该 run 重捞翻终态。
   *  失败 run 无终态帧——行状态靠 selectRun/手动刷新兜底（与回测同口径）。 */
  private onProgress(msg: StrategyRunProgressMsg): void {
    if (typeof msg.run_id !== 'string' || msg.run_id === '') return;
    const progress = msg.progress ?? 0;
    this.patch({
      progressMap: {
        ...this.current.progressMap,
        [msg.run_id]: { progress, barTs: msg.bar_ts ?? null },
      },
    });
    if (progress >= 1) void this.refreshRunInList(msg.run_id);
  }

  /** 完成信号驱动：重捞单个 run 合并回列表；若当前选中则一并重捞结果。 */
  private async refreshRunInList(id: string): Promise<void> {
    const cur = (this.current.runs.data ?? []).find((r) => r.id === id);
    if (cur && cur.status !== 'queued' && cur.status !== 'running') return;
    try {
      const data = await this.deps.api.getWorkbenchRun(id);
      const runs = (this.current.runs.data ?? []).map((r) => (r.id === id ? data : r));
      this.patch({ runs: { ...this.current.runs, data: runs } });
      if (this.current.selectedRunId === id && data.status === 'succeeded') {
        await this.loadResult(id);
      }
    } catch {
      // 单 run 重捞失败：保留当前行（下次信号/重试兜底）
    }
  }

  async loadCatalog(): Promise<void> {
    this.patch({ catalog: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getStrategyCatalog();
      this.patch({ catalog: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ catalog: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async loadPresets(): Promise<void> {
    try {
      const data = await this.deps.api.listWorkbenchPresets();
      this.patch({ presets: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ presets: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async loadRuns(): Promise<void> {
    this.patch({ runs: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.listWorkbenchRuns({ limit: this.runLimit, offset: 0 });
      this.runNextOffset = data.length;
      this.patch({
        runs: { data, loading: false, error: null },
        hasMore: data.length === this.runLimit,
        loadingMore: false,
      });
    } catch (e) {
      this.patch({ runs: { data: null, loading: false, error: (e as Error).message }, loadingMore: false });
    }
  }

  async loadMoreRuns(): Promise<void> {
    if (this.current.runs.loading || this.current.loadingMore || !this.current.hasMore) return;
    this.patch({ loadingMore: true });
    try {
      const data = await this.deps.api.listWorkbenchRuns({ limit: this.runLimit, offset: this.runNextOffset });
      const cur = this.current.runs.data ?? [];
      this.runNextOffset += data.length;
      this.patch({
        runs: { data: [...cur, ...data], loading: false, error: null },
        hasMore: data.length === this.runLimit,
        loadingMore: false,
      });
    } catch (e) {
      this.patch({ loadingMore: false, runs: { ...this.current.runs, error: (e as Error).message } });
    }
  }

  async refreshRuns(): Promise<void> {
    try {
      const data = await this.deps.api.listWorkbenchRuns({ limit: this.runLimit, offset: 0 });
      this.runNextOffset = data.length;
      this.patch({
        runs: { data, loading: false, error: null },
        hasMore: data.length === this.runLimit,
      });
    } catch (e) {
      this.patch({ runs: { ...this.current.runs, error: (e as Error).message } });
    }
  }

  /** 点选 run：succeeded → 载入结果；其它状态 → 清结果区（失败 run 的 error 由列表行/详情头展示）。 */
  async selectRun(id: string): Promise<void> {
    this.patch({ selectedRunId: id, compareIds: [], view: 'single' });
    const row = (this.current.runs.data ?? []).find((r) => r.id === id);
    if (row?.status === 'succeeded') {
      await this.loadResult(id);
    } else {
      this.patch({ result: idle() });
    }
  }

  async loadResult(id: string): Promise<void> {
    this.patch({ result: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getWorkbenchResult(id);
      this.patch({ result: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ result: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 取消（queued/running）：返回的 canceled 行合并回列表；409/404 向调用方传播（组件友好提示）。 */
  async cancelRun(id: string): Promise<void> {
    const view = await this.deps.api.cancelWorkbenchRun(id);
    const runs = (this.current.runs.data ?? []).map((r) => (r.id === id ? view : r));
    this.patch({ runs: { ...this.current.runs, data: runs } });
  }

  /** compare 勾选（仅 succeeded 行有入口；上限 MAX_COMPARE 截断；≥2 进 compare 视图）。 */
  toggleCompare(id: string): void {
    const set = new Set(this.current.compareIds);
    if (set.has(id)) set.delete(id);
    else if (set.size < MAX_COMPARE) set.add(id);
    else return; // 超上限忽略
    const compareIds = [...set];
    if (compareIds.length >= 2) {
      this.patch({ compareIds, view: 'compare', selectedRunId: null });
      void this.refreshCompare();
    } else {
      this.patch({ compareIds, view: 'single' });
    }
  }

  async refreshCompare(): Promise<void> {
    const ids = this.current.compareIds;
    if (ids.length < 2) {
      this.patch({ compare: { data: null, loading: false, error: null } });
      return;
    }
    this.patch({ compare: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.compareWorkbenchRuns(ids);
      this.patch({ compare: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ compare: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  setView(view: 'single' | 'compare'): void {
    this.patch({ view });
    if (view === 'compare') void this.refreshCompare();
  }

  /** 提交 ensemble 运行：201 → 列表刷新 + 选中新 run（结果载入）；400/404 错误文案落 submitError。
   *  in-flight 去重（防御 dblclick 双 POST；按钮已禁用，store 层兜底）。 */
  async submit(req: WorkbenchSubmitReq): Promise<void> {
    if (this.current.submitting) return;
    this.patch({ submitting: true, submitError: null });
    try {
      const run = await this.deps.api.submitWorkbenchRun(req);
      await this.refreshRuns();
      await this.selectRun(run.id);
    } catch (e) {
      this.patch({ submitError: (e as Error).message });
    } finally {
      this.patch({ submitting: false });
    }
  }

  // ── 组合预设（ADR §13.5；与 sim-live 共用下拉的数据源）──

  async createPreset(name: string, config: WorkbenchPresetConfigInput): Promise<void> {
    await this.deps.api.createWorkbenchPreset({ name, config });
    await this.loadPresets();
  }

  /** 重命名预设（PUT 同 config；409 撞名向调用方传播）。 */
  async renamePreset(id: string, name: string): Promise<void> {
    const cur = (this.current.presets.data ?? []).find((p) => p.id === id);
    if (!cur) return;
    await this.deps.api.updateWorkbenchPreset(id, { name, config: cur.config });
    await this.loadPresets();
  }

  /** 就地更新预设（PUT name+config；MINOR-2 表单偏离预设后「保存」复用本通道；409 撞名向调用方传播）。 */
  async updatePreset(id: string, name: string, config: WorkbenchPresetConfigInput): Promise<void> {
    await this.deps.api.updateWorkbenchPreset(id, { name, config });
    await this.loadPresets();
  }

  async deletePreset(id: string): Promise<void> {
    await this.deps.api.deleteWorkbenchPreset(id);
    await this.loadPresets();
  }

  /** 应用预设：返回钉住 config（组件合并 symbol/period/from/to 后填表单/提交）。 */
  async applyPreset(id: string): Promise<WorkbenchRunConfig> {
    return this.deps.api.applyWorkbenchPreset(id);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}
