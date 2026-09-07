import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { BacktestRunDto, BacktestSubmitReq, BacktestSubmitResp } from '@/api/types';
import { createMockClient } from '@/api/mock';
import { BacktestStore, gridGroups } from './store';

function fakeWs() {
  const handlers = new Map<string, Set<(msg: unknown) => void>>();
  return {
    handlers,
    subscribe: vi.fn((topic: string, h: (msg: unknown) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    emit(topic: string, msg: unknown) {
      handlers.get(topic)?.forEach((h) => h(msg));
    },
  } as unknown as WsClient & { emit: (t: string, m: unknown) => void };
}

function mkStore() {
  const api = createMockClient({ now: new Date('2026-09-04T07:00:00Z') });
  const ws = fakeWs();
  const store = new BacktestStore({ api, ws });
  return { api: api as ApiClient, ws, store };
}

describe('BacktestStore（页面⑤状态机）', () => {
  let s: ReturnType<typeof mkStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    s = mkStore();
  });

  it('init 载入 strategies + runs，并订阅 WS 主题 backtest', async () => {
    await s.store.init();
    expect(s.store.state.strategies.data).toHaveLength(7);
    expect(s.store.state.runs.data!.length).toBeGreaterThanOrEqual(4);
    expect(s.ws.subscribe).toHaveBeenCalledWith('backtest', expect.any(Function));
  });

  it('WS backtest_progress 按 run_id 落到 progressMap（覆盖 REST 进度）', async () => {
    await s.store.init();
    expect(s.store.state.progressMap[12]).toBeUndefined();
    s.ws.emit('backtest', { type: 'backtest_progress', run_id: 12, pct: 80, bar_ts: '2026-09-04T02:00:00Z' });
    expect(s.store.state.progressMap[12]).toEqual({ pct: 80, currentTs: '2026-09-04T02:00:00Z' });
  });

  it('WS progress 未到 100 仅推进度不重捞；到 100 重捞单 run 合并回 runs（行状态翻 done、不改其它行）', async () => {
    await s.store.init();
    expect(s.store.state.runs.data!.find((r) => r.id === 12)!.status).toBe('running');
    const getRunSpy = vi.spyOn(s.api, 'getRun');
    // 未到 100：仅推进度，不重捞（WS 完成信号驱动局部刷新，非全列表轮询）
    s.ws.emit('backtest', { type: 'backtest_progress', run_id: 12, pct: 80, bar_ts: '2026-09-04T02:00:00Z' });
    expect(getRunSpy).not.toHaveBeenCalled();
    expect(s.store.state.runs.data!.find((r) => r.id === 12)!.status).toBe('running');
    // 到 100：触发该 run 详情重捞并合并回 runs
    const running12 = s.store.state.runs.data!.find((r) => r.id === 12)!;
    const done12: BacktestRunDto = { ...running12, status: 'done', progress: 100, finished_at: '2026-09-04T02:00:00Z' };
    getRunSpy.mockResolvedValue(done12);
    s.ws.emit('backtest', { type: 'backtest_progress', run_id: 12, pct: 100, bar_ts: '2026-09-04T02:00:00Z' });
    await vi.waitFor(() => expect(s.store.state.runs.data!.find((r) => r.id === 12)!.status).toBe('done'));
    expect(getRunSpy).toHaveBeenCalledWith(12);
    // 其它 run 保持不变
    expect(s.store.state.runs.data!.find((r) => r.id === 11)!.status).toBe('done');
    expect(s.store.state.runs.data!.find((r) => r.id === 13)!.status).toBe('pending');
    expect(s.store.state.runs.data!.find((r) => r.id === 14)!.status).toBe('failed');
  });

  it('selectRun 载入详情并置 resultView=single、清 compare', async () => {
    await s.store.init();
    await s.store.submit({ strategyId: 'dual_ma', params: { fast: 5, slow: 20 }, code: '518880', period: '1d', fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 } });
    const runId = s.store.state.runs.data!.find((r) => r.status === 'done')!.id;
    await s.store.selectRun(runId);
    expect(s.store.state.resultView).toBe('single');
    expect(s.store.state.selectedRunId).toBe(runId);
    expect(s.store.state.runDetail.data?.id).toBe(runId);
    expect(s.store.state.runDetail.data?.metrics).toBeDefined();
  });

  it('toggleCompare 达 2 次 → compare 视图 + 数据；退选 <2 → 回 single', async () => {
    await s.store.init();
    // 种子仅 1 个 done run；先提交单 run 造出第 2 个 done
    await s.store.submit({ strategyId: 'dual_ma', params: { fast: 5, slow: 20 }, code: '518880', period: '1d', fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 } });
    const doneIds = s.store.state.runs.data!.filter((r) => r.status === 'done').map((r) => r.id);
    expect(doneIds.length).toBeGreaterThanOrEqual(2);
    s.store.toggleCompare(doneIds[0]!);
    expect(s.store.state.resultView).toBe('single'); // 仅 1 次不进 compare
    s.store.toggleCompare(doneIds[1]!);
    expect(s.store.state.resultView).toBe('compare');
    await vi.waitFor(() => expect(s.store.state.compare.data).toHaveLength(2));
    s.store.toggleCompare(doneIds[1]!); // 退选 1 → 回 single
    expect(s.store.state.resultView).toBe('single');
  });

  it('submit 单 run → resultView=single + refreshRuns + 载入详情', async () => {
    await s.store.init();
    const before = s.store.state.runs.data!.length;
    await s.store.submit({ strategyId: 'ma_rsi', params: { fast: 5, slow: 20 }, code: '518880', period: '1d', fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 } });
    expect(s.store.state.runs.data!.length).toBe(before + 1);
    expect(s.store.state.resultView).toBe('single');
    expect(s.store.state.selectedRunId).toBeGreaterThan(0);
  });

  it('submit 网格 → resultView=grid-rank + 任务组入列', async () => {
    await s.store.init();
    await s.store.submit({ strategyId: 'dual_ma', params: { fast: '3:9:2', slow: 20 }, code: '518880', period: '1d', fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 } });
    expect(s.store.state.resultView).toBe('grid-rank');
    const groups = gridGroups(s.store.state.runs.data!);
    expect(groups.length).toBeGreaterThan(0);
    const latest = groups.find((g) => g.runs.length >= 4)!;
    expect(latest.runs.length).toBeGreaterThanOrEqual(4);
  });

  it('submit 失败 → submitError 置位（错误内联）', async () => {
    await s.store.init();
    vi.spyOn(s.api, 'submitRun').mockRejectedValueOnce(new Error('HTTP 400'));
    await s.store.submit({ strategyId: 'dual_ma', params: {}, code: '518880', period: '1d', fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 } });
    expect(s.store.state.submitError).toContain('HTTP 400');
  });

  it('submit 进行中再次 submit → 仅 1 次 POST（in-flight 去重，防御 dblclick）', async () => {
    await s.store.init();
    const submitRunSpy = vi.spyOn(s.api, 'submitRun');
    let release!: (r: BacktestSubmitResp) => void;
    submitRunSpy.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    const req: BacktestSubmitReq = { strategyId: 'dual_ma', params: { fast: 5, slow: 20 }, code: '518880', period: '1d', fee: { ratePct: 0.025, minFee: 5, slippageBp: 2 } };
    const first = s.store.submit(req);
    // 提交进行中（submitting=true），模拟 dblclick 第二次 submit
    expect(s.store.state.submitting).toBe(true);
    await s.store.submit(req);
    expect(submitRunSpy).toHaveBeenCalledTimes(1); // 仅 1 次 POST
    expect(s.store.state.submitting).toBe(true);   // 仍处于提交中
    release!({ run_id: 999 });
    await first;
    expect(s.store.state.submitting).toBe(false);  // 完成后清除标志
    expect(submitRunSpy).toHaveBeenCalledTimes(1); // 依然只 1 次
  });

  it('分页：loadRuns 首屏 limit=100；loadMoreRuns 追加下一页并翻转 hasMore', async () => {
    // 注入 120 个 run，验证分页首屏与追加（mock listRuns 按 created_at DESC, id DESC 排序）。
    const seeds: BacktestRunDto[] = Array.from({ length: 120 }, (_, i) => ({
      id: 100 + i,
      code: '518880',
      period: 'D1',
      strategy_id: 'dual_ma',
      params: {},
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
      status: i % 2 ? 'running' : 'done',
      progress: i % 2 ? 50 : 100,
      current_ts: null,
      created_at: new Date(2026, 8, 4, 0, i % 60).toISOString(),
      finished_at: i % 2 ? '2026-09-04T02:00:00Z' : null,
      error: null,
      group_id: null,
    }));
    const api = createMockClient({
      now: new Date('2026-09-04T07:00:00Z'),
      backtestRuns: seeds,
    });
    const ws = fakeWs();
    const store = new BacktestStore({ api: api as ApiClient, ws });
    const listRunsSpy = vi.spyOn(api, 'listRuns');

    await store.init();
    expect(listRunsSpy).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(store.state.runs.data!.length).toBe(100);
    expect(store.state.hasMore).toBe(true);

    await store.loadMoreRuns();
    expect(listRunsSpy).toHaveBeenLastCalledWith({ limit: 100, offset: 100 });
    expect(store.state.runs.data!.length).toBe(120);
    expect(store.state.hasMore).toBe(false);

    // 已到末尾：再 loadMore 不应重复拉取。
    const callsBefore = listRunsSpy.mock.calls.length;
    await store.loadMoreRuns();
    expect(listRunsSpy.mock.calls.length).toBe(callsBefore);
  });

  it('deleteRun 删除 run 并从列表/选中结果区移除', async () => {
    await s.store.init();
    const doneId = s.store.state.runs.data!.find((r) => r.status === 'done')!.id;
    await s.store.selectRun(doneId);
    expect(s.store.state.selectedRunId).toBe(doneId);
    await s.store.deleteRun(doneId);
    expect(s.store.state.runs.data!.some((r) => r.id === doneId)).toBe(false);
    expect(s.store.state.selectedRunId).toBeNull();
    expect(s.store.state.runDetail.data).toBeNull();
  });

  it('deleteRun 不存在 → rethrow（调用方显示错误，不清列表）', async () => {
    await s.store.init();
    const before = s.store.state.runs.data!.length;
    await expect(s.store.deleteRun(999999)).rejects.toBeTruthy();
    expect(s.store.state.runs.data!.length).toBe(before);
  });
});
