import { BACKTEST_DEFAULTS, type ResultView } from '@/layouts/BacktestGrid';
import type {
  BacktestRunDto,
  BacktestStrategyDto,
  BacktestSubmitReq,
} from '@/api/types';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';

export interface AsyncSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const idle = <T>(): AsyncSlice<T> => ({ data: null, loading: false, error: null });

interface ProgressInfo {
  pct: number;
  currentTs: string | null;
}

export interface BacktestState {
  strategies: AsyncSlice<BacktestStrategyDto[]>;
  runs: AsyncSlice<BacktestRunDto[]>;
  selectedRunId: number | null;
  runDetail: AsyncSlice<BacktestRunDto>;
  compareIds: number[];
  compare: AsyncSlice<BacktestRunDto[]>;
  resultView: ResultView;
  /** WS backtest_progress 增量（run_id → {pct,currentTs}），覆盖 REST 进度。 */
  progressMap: Record<number, ProgressInfo>;
  submitting: boolean;
  submitError: string | null;
}

type WsLike = Pick<WsClient, 'subscribe'>;

/** 回测 WS 帧载荷（{type:"backtest_progress", run_id, pct, bar_ts}）。 */
interface BacktestProgressMsg {
  type?: string;
  run_id?: number;
  pct?: number;
  bar_ts?: string | null;
}

/**
 * 页面⑤ 回测工作台状态机（图表库无关）。
 * 数据流：strategies GET /api/backtest/strategies + runs GET /api/backtest/runs；
 * 选中 run 详情 GET /api/backtest/runs/{id}；对比 GET /api/backtest/compare?ids=；
 * WS `backtest_progress`（topic=backtest）实时推进度 → progressMap。
 */
export class BacktestStore {
  private current: BacktestState = {
    strategies: { data: null, loading: true, error: null },
    runs: { data: null, loading: true, error: null },
    selectedRunId: null,
    runDetail: idle(),
    compareIds: [],
    compare: idle(),
    resultView: 'single',
    progressMap: {},
    submitting: false,
    submitError: null,
  };
  private listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(private deps: { api: ApiClient; ws: WsLike }) {}

  get state(): BacktestState {
    return this.current;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): BacktestState => this.current;

  private patch(p: Partial<BacktestState>) {
    if (this.disposed) return;
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    if (this.unsubs.length === 0) {
      this.unsubs.push(
        this.deps.ws.subscribe('backtest', (msg) => this.onProgress(msg as BacktestProgressMsg)),
      );
    }
    await Promise.all([this.loadStrategies(), this.loadRuns()]);
  }

  /** WS 进度回调节点：按 run_id 落到 progressMap（覆盖 REST 进度），不重推全列表。
   *  完成信号（pct>=100）驱动该 run 详情重捞，把行状态翻为终态并结果可点，无需整页 reload。 */
  private onProgress(msg: BacktestProgressMsg): void {
    if (typeof msg.run_id !== 'number') return;
    const pct = msg.pct ?? 0;
    this.patch({
      progressMap: {
        ...this.current.progressMap,
        [msg.run_id]: { pct, currentTs: msg.bar_ts ?? null },
      },
    });
    if (pct >= 100) void this.refreshRunInList(msg.run_id);
  }

  /** WS 完成信号驱动：重捞单个 run（GET /api/backtest/runs/{id}）并合并回 runs 列表。
   *  仅更新该行终态（done/failed）+ 结果可点，其它行保持不变；重捞失败保留现有行（下次信号/重试兜底）。 */
  private async refreshRunInList(id: number): Promise<void> {
    const cur = (this.current.runs.data ?? []).find((r) => r.id === id);
    if (cur && (cur.status === 'done' || cur.status === 'failed')) return;
    try {
      const data = await this.deps.api.getRun(id);
      const runs = (this.current.runs.data ?? []).map((r) => (r.id === id ? data : r));
      this.patch({ runs: { ...this.current.runs, data: runs } });
    } catch {
      // 单 run 重捞失败：保留当前行（列表快照兜底）
    }
  }

  async loadStrategies(): Promise<void> {
    this.patch({ strategies: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getStrategies();
      this.patch({ strategies: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ strategies: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async loadRuns(): Promise<void> {
    this.patch({ runs: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.listRuns();
      this.patch({ runs: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ runs: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  async refreshRuns(): Promise<void> {
    try {
      const data = await this.deps.api.listRuns();
      this.patch({ runs: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ runs: { ...this.current.runs, error: (e as Error).message } });
    }
  }

  /** 点已完成任务：载入结果区（单次视图）；清 compare 退出对比。 */
  async selectRun(id: number): Promise<void> {
    this.patch({ selectedRunId: id, compareIds: [], resultView: 'single' });
    await this.loadRunDetail(id);
  }

  async loadRunDetail(id: number): Promise<void> {
    this.patch({ runDetail: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.getRun(id);
      // WS 可能已给出该 run 较新进度；详情以 GET 为主（status/progress 覆盖）
      this.patch({ runDetail: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ runDetail: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 删除回测 run：DELETE /api/backtest/runs/{id}；成功后从列表移除，若选中则清结果区，compare 剔除。 */
  async deleteRun(id: number): Promise<void> {
    await this.deps.api.deleteRun(id);
    const runs = (this.current.runs.data ?? []).filter((r) => r.id !== id);
    const compareIds = this.current.compareIds.filter((cid) => cid !== id);
    const patch: Partial<BacktestState> = {
      runs: { ...this.current.runs, data: runs },
      compareIds,
    };
    if (compareIds.length < BACKTEST_DEFAULTS.compareMin) patch.resultView = 'single';
    if (this.current.selectedRunId === id) {
      patch.selectedRunId = null;
      patch.runDetail = idle();
    }
    this.patch(patch);
  }

  /** 勾选 2-N 次对比（仅已完成 run 入口可触发）；≥compareMin 进 compare-view，<2 回单次。 */
  toggleCompare(id: number): void {
    const set = new Set(this.current.compareIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const compareIds = [...set];
    if (compareIds.length >= BACKTEST_DEFAULTS.compareMin) {
      this.patch({ compareIds, resultView: 'compare', selectedRunId: null });
      void this.refreshCompare();
    } else {
      // 退出对比视图；保留勾选记录（不足 2 时不进 compare）
      this.patch({ compareIds, resultView: 'single' });
    }
  }

  async refreshCompare(): Promise<void> {
    const ids = this.current.compareIds;
    if (ids.length < BACKTEST_DEFAULTS.compareMin) {
      this.patch({ compare: { data: null, loading: false, error: null } });
      return;
    }
    this.patch({ compare: { data: null, loading: true, error: null } });
    try {
      const data = await this.deps.api.compare(ids);
      this.patch({ compare: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ compare: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  /** 视图切换（compare-view 退单次 / grid-rank 点行进单次详情由 selectRun 处理）。 */
  setResultView(view: ResultView): void {
    this.patch({ resultView: view });
    if (view === 'compare') void this.refreshCompare();
  }

  /** 提交回测/网格：POST /api/backtest/runs；网格→任务组排行视图；单 run→载入其详情。
   *  in-flight 去重：提交进行中再次提交被忽略（防御 dblclick 发 2 POST；按钮已禁用但 store 层兜底）。 */
  async submit(req: BacktestSubmitReq): Promise<void> {
    if (this.current.submitting) return;
    this.patch({ submitting: true, submitError: null });
    try {
      const resp = await this.deps.api.submitRun(req);
      await this.refreshRuns();
      if (resp.group_id != null) {
        this.patch({ resultView: 'grid-rank', selectedRunId: null, compareIds: [] });
      } else if (resp.run_id != null) {
        this.patch({ resultView: 'single', compareIds: [] });
        await this.selectRun(resp.run_id);
      }
    } catch (e) {
      this.patch({ submitError: (e as Error).message });
    } finally {
      this.patch({ submitting: false });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}

/** 从 run 列表中划出网格任务组（group_id 非空；按 group_id 聚合，参数组合=其 params）。 */
export function gridGroups(runs: BacktestRunDto[]): Array<{ groupId: string; runs: BacktestRunDto[] }> {
  const byGroup = new Map<string, BacktestRunDto[]>();
  for (const r of runs) {
    if (!r.group_id) continue;
    const list = byGroup.get(r.group_id) ?? [];
    list.push(r);
    byGroup.set(r.group_id, list);
  }
  return [...byGroup.entries()]
    .map(([groupId, groupRuns]) => ({ groupId, runs: groupRuns }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
}
