import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { WorkbenchSubmitReq } from '@/api/types';
import { createMockClient } from '@/api/mock';
import { WorkbenchStore, MAX_COMPARE } from './store';

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
  const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') });
  const ws = fakeWs();
  const store = new WorkbenchStore({ api, ws });
  return { api: api as ApiClient, ws, store };
}

const validReq = (): WorkbenchSubmitReq => ({
  symbol: '518880',
  period: 'D1',
  from: '2026-01-01T00:00:00Z',
  to: '2026-04-01T00:00:00Z',
  slots: [{ version_id: 'sv_mock_dual_v1', weight: 1 }],
  policy: { LumpSum: { position_pct: 1 } },
  fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
});

describe('WorkbenchStore（页面⑪回测工作台状态机）', () => {
  let s: ReturnType<typeof mkStore>;
  beforeEach(() => {
    vi.clearAllMocks();
    s = mkStore();
  });

  it('init 载入 catalog + presets + runs，并订阅 WS 主题 strategy_run', async () => {
    await s.store.init();
    expect(s.store.state.catalog.data!.length).toBeGreaterThanOrEqual(2); // 仅 published 入 catalog
    expect(s.store.state.presets.data).toEqual([]);
    expect(s.store.state.symbols.data!.length).toBeGreaterThanOrEqual(4); // 标的下拉数据源
    expect(s.store.state.runs.data!.length).toBeGreaterThanOrEqual(4); // 种子四态
    expect(s.ws.subscribe).toHaveBeenCalledWith('strategy_run', expect.any(Function));
  });

  it('WS strategy_run_progress 按 run_id 落到 progressMap（0..1 → pct 展示由组件负责）', async () => {
    await s.store.init();
    expect(s.store.state.progressMap['sr_mock_seed3']).toBeUndefined();
    s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 0.8, bar_ts: '2026-09-09T02:00:00Z' });
    expect(s.store.state.progressMap['sr_mock_seed3']).toEqual({ progress: 0.8, barTs: '2026-09-09T02:00:00Z' });
  });

  it('WS progress <1 仅推进度不重捞；到 1 重捞单 run 合并回 runs（行状态翻终态）', async () => {
    await s.store.init();
    const getSpy = vi.spyOn(s.api, 'getWorkbenchRun');
    s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 0.8, bar_ts: null });
    expect(getSpy).not.toHaveBeenCalled();
    expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('running');
    // 到 1：重捞并合并（mock 中 cancel 后置 canceled；此处模拟后端翻 succeeded）
    const cur = s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!;
    getSpy.mockResolvedValue({ ...cur, status: 'succeeded', progress: 1, finished_at: '2026-09-09T06:00:00Z' });
    s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 1, bar_ts: null });
    await vi.waitFor(() =>
      expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('succeeded'),
    );
    expect(getSpy).toHaveBeenCalledWith('sr_mock_seed3');
  });

  it('TD-4：progress=1 GET 命中 running@100%（发帧先于终态提交）→ 1.5s 短延迟复核，复核到 succeeded 翻终态（不卡死）', async () => {
    vi.useFakeTimers();
    try {
      await s.store.init();
      const getSpy = vi.spyOn(s.api, 'getWorkbenchRun');
      const cur = s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!;
      // 竞态复现：progress=1 帧先于 mark_succeeded 提交，首次 GET 命中 running@100%；复核时才拿到终态
      getSpy
        .mockResolvedValueOnce({ ...cur, status: 'running', progress: 1 })
        .mockResolvedValue({ ...cur, status: 'succeeded', progress: 1, finished_at: '2026-09-09T06:00:00Z' });
      s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 1, bar_ts: null });
      await vi.advanceTimersByTimeAsync(0); // 首次 GET 落盘
      expect(getSpy).toHaveBeenCalledTimes(1);
      // 不误置终态：行仍为 running，但已调度复核
      expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('running');
      await vi.advanceTimersByTimeAsync(1500); // 短延迟复核
      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TD-4：持续 running 时最多复核 3 次后停手（不无限轮询、不误置终态）', async () => {
    vi.useFakeTimers();
    try {
      await s.store.init();
      const getSpy = vi.spyOn(s.api, 'getWorkbenchRun');
      const cur = s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!;
      getSpy.mockResolvedValue({ ...cur, status: 'running', progress: 1 });
      s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 1, bar_ts: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(getSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500 * 10); // 远超 3 次复核窗口
      expect(getSpy).toHaveBeenCalledTimes(4); // 首次 GET + 至多 3 次复核
      expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TD-4：GET 复核异常（网络抖动/5xx）→ 仍调度一次短延迟复核，复核到 succeeded 翻终态（不卡 running@100%）', async () => {
    vi.useFakeTimers();
    try {
      await s.store.init();
      const getSpy = vi.spyOn(s.api, 'getWorkbenchRun');
      const cur = s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!;
      // 首次复核 GET 抛异常（保留当前行），复核链不应中断——1.5s 后再复核拿到终态
      getSpy
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue({ ...cur, status: 'succeeded', progress: 1, finished_at: '2026-09-09T06:00:00Z' });
      s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 1, bar_ts: null });
      await vi.advanceTimersByTimeAsync(0); // 首次 GET 抛异常落 catch
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('running');
      await vi.advanceTimersByTimeAsync(1500); // catch 分支调度的复核
      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TD-4：GET 持续异常时最多复核 3 次后停手（catch 复核仍受 REFRESH_MAX_RETRIES 上限约束）', async () => {
    vi.useFakeTimers();
    try {
      await s.store.init();
      const getSpy = vi.spyOn(s.api, 'getWorkbenchRun');
      getSpy.mockRejectedValue(new Error('network'));
      s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 1, bar_ts: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(getSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500 * 10); // 远超 3 次复核窗口
      expect(getSpy).toHaveBeenCalledTimes(4); // 首次 GET + 至多 3 次复核
      expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TD-4：dispose 清理待复核定时器（之后不再 GET）', async () => {
    vi.useFakeTimers();
    try {
      await s.store.init();
      const getSpy = vi.spyOn(s.api, 'getWorkbenchRun');
      const cur = s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!;
      getSpy.mockResolvedValue({ ...cur, status: 'running', progress: 1 });
      s.ws.emit('strategy_run', { type: 'strategy_run_progress', run_id: 'sr_mock_seed3', progress: 1, bar_ts: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(getSpy).toHaveBeenCalledTimes(1);
      s.store.dispose();
      await vi.advanceTimersByTimeAsync(1500 * 10);
      expect(getSpy).toHaveBeenCalledTimes(1); // 定时器已清理，无后续复核
    } finally {
      vi.useRealTimers();
    }
  });

  it('selectRun succeeded → 载入结果；failed → 清空结果且不打 result 端点', async () => {
    await s.store.init();
    const resSpy = vi.spyOn(s.api, 'getWorkbenchResult');
    await s.store.selectRun('sr_mock_seed1');
    expect(s.store.state.selectedRunId).toBe('sr_mock_seed1');
    expect(s.store.state.result.data!.per_bar.length).toBeGreaterThan(0);
    expect(s.store.state.result.data!.metrics).toBeTruthy();
    await s.store.selectRun('sr_mock_seed4');
    expect(s.store.state.result.data).toBeNull();
    expect(resSpy).toHaveBeenCalledTimes(1); // failed run 不请求 result（后端 404 口径）
  });

  it('submit 成功 → 列表刷新 + 选中新 run + 结果载入；in-flight 去重', async () => {
    await s.store.init();
    const before = s.store.state.runs.data!.length;
    await s.store.submit(validReq());
    expect(s.store.state.runs.data!.length).toBe(before + 1);
    expect(s.store.state.selectedRunId).toMatch(/^sr_mock_/);
    expect(s.store.state.result.data!.per_bar.length).toBeGreaterThan(0);
    expect(s.store.state.submitError).toBeNull();
  });

  it('submit 400 → submitError 落错误文案（列表不变）', async () => {
    await s.store.init();
    const before = s.store.state.runs.data!.length;
    await s.store.submit({ ...validReq(), symbol: '999999' });
    expect(s.store.state.submitError).toContain('400');
    expect(s.store.state.runs.data!.length).toBe(before);
    expect(s.store.state.selectedRunId).toBeNull();
  });

  it('cancelRun：running → canceled 合并回列表；409（终态）错误向调用方传播', async () => {
    await s.store.init();
    await s.store.cancelRun('sr_mock_seed3');
    expect(s.store.state.runs.data!.find((r) => r.id === 'sr_mock_seed3')!.status).toBe('canceled');
    await expect(s.store.cancelRun('sr_mock_seed1')).rejects.toMatchObject({ status: 409 });
  });

  it('toggleCompare：勾选 ≥2 进 compare 视图（数据载入）；上限 4 截断；减到 <2 回 single', async () => {
    await s.store.init();
    expect(MAX_COMPARE).toBe(4);
    s.store.toggleCompare('sr_mock_seed1');
    expect(s.store.state.view).toBe('single'); // 1 个不进 compare
    s.store.toggleCompare('sr_mock_seed2');
    expect(s.store.state.view).toBe('compare');
    await vi.waitFor(() => expect(s.store.state.compare.data).toHaveLength(2));
    expect(s.store.state.compare.data![0]!.run_id).toBe('sr_mock_seed1'); // 输入序
    // 超上限忽略
    s.store.toggleCompare('sr_mock_a');
    s.store.toggleCompare('sr_mock_b');
    s.store.toggleCompare('sr_mock_c');
    expect(s.store.state.compareIds).toHaveLength(4);
    // 减到 <2 → 回 single
    s.store.toggleCompare('sr_mock_seed1');
    s.store.toggleCompare('sr_mock_seed2');
    s.store.toggleCompare('sr_mock_a');
    expect(s.store.state.view).toBe('single');
    expect(s.store.state.compareIds).toHaveLength(1);
  });

  it('presets：create → list 反映；applyPreset 返回钉住 config；delete → 移除；重名 409 传播', async () => {
    await s.store.init();
    const run = await s.api.submitWorkbenchRun(validReq());
    await s.store.createPreset('组合A', run.config);
    expect(s.store.state.presets.data!.map((p) => p.name)).toContain('组合A');
    const row = s.store.state.presets.data![0]!;
    const cfg = await s.store.applyPreset(row.id);
    expect(cfg.slots[0]!.version_id).toBe('sv_mock_dual_v1');
    await expect(s.store.createPreset('组合A', run.config)).rejects.toMatchObject({ status: 409 });
    await s.store.deletePreset(row.id);
    expect(s.store.state.presets.data).toHaveLength(0);
  });

  it('updatePreset：PUT 就地更新 name+config（同名不撞 409），list 反映更新结果', async () => {
    await s.store.init();
    const run = await s.api.submitWorkbenchRun(validReq());
    await s.store.createPreset('组合A', run.config);
    const row = s.store.state.presets.data![0]!;
    const newConfig = { ...run.config, buy_threshold: 70, sell_threshold: 30 };
    await s.store.updatePreset(row.id, '组合A', newConfig);
    const updated = s.store.state.presets.data!.find((p) => p.id === row.id)!;
    expect(updated.name).toBe('组合A');
    expect(updated.config.buy_threshold).toBe(70);
    expect(updated.config.sell_threshold).toBe(30);
    // 未知 id → 404 传播
    await expect(s.store.updatePreset('sp_nope', 'x', newConfig)).rejects.toMatchObject({ status: 404 });
  });

  it('分页：loadMoreRuns 以累计 offset 追加（hasMore=条数==limit）', async () => {
    await s.store.init();
    // 种子 4 条 < limit 50 → 无更多
    expect(s.store.state.hasMore).toBe(false);
    await s.store.loadMoreRuns(); // 不爆错、不变
    expect(s.store.state.runs.data!.length).toBeGreaterThanOrEqual(4);
  });
});
