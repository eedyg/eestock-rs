import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
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
});
