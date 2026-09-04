import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourcesStore } from './store';
import { stubApi } from '@/test/apiStub';
import type { ApiClient } from '@/api/client';
import type { SourcesHealth } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';

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

const HEALTH: SourcesHealth = {
  window_secs: 3600,
  sources: [
    {
      source: 'tencent_ifzq', window_secs: 3600, attempts: 60, successes: 60,
      success_rate: 1, p50_ms: 180, p95_ms: 320, circuit_state: 'closed',
      status: 'healthy', last_error: null, last_event_ts: '2026-09-04T02:23:00Z',
    },
    {
      source: 'tencent_qt', window_secs: 3600, attempts: 12, successes: 3,
      success_rate: 0.25, p50_ms: null, p95_ms: null, circuit_state: 'open',
      status: 'circuit_open',
      last_error: { err_kind: 'http', ts: '2026-09-04T02:18:00Z', code: null },
      last_event_ts: '2026-09-04T02:18:00Z',
    },
  ],
};

describe('SourcesStore（页面②状态机）', () => {
  let api: ApiClient;
  let ws: ReturnType<typeof fakeWs>;
  beforeEach(() => {
    vi.clearAllMocks();
    ws = fakeWs();
    api = stubApi({
      getSourcesHealth: vi.fn(async () => HEALTH),
    });
  });

  it('init：先载符号选定默认标的，再并发加载（health/gaps/alerts）→ ready；订阅 WS source_health', async () => {
    const store = new SourcesStore({ api, ws });
    expect(store.state.health.loading).toBe(true);
    await store.init();
    expect(store.state.health.data?.sources).toHaveLength(2);
    expect(store.state.health.loading).toBe(false);
    expect(store.state.health.error).toBeNull();
    // 方案 A：缺口摘要走 getQualityGaps（单标的），符号表选定默认标的
    expect(api.getSymbols).toHaveBeenCalled();
    expect(store.state.selectedCode).toBeTruthy();
    expect(api.getQualityGaps).toHaveBeenCalled();
    expect(store.state.gaps.data?.code).toBe(store.state.selectedCode);
    expect(api.getAlerts).toHaveBeenCalledWith(10);
    expect(ws.subscribe).toHaveBeenCalledWith('source_health', expect.any(Function));
    store.dispose();
  });

  it('selectCode：切换标的重查缺口摘要（getQualityGaps 带新 code）', async () => {
    const store = new SourcesStore({ api, ws });
    await store.init();
    const first = store.state.selectedCode;
    expect(first).toBeTruthy();
    const before = vi.mocked(api.getQualityGaps).mock.calls.length;
    // 选下一个标的（mock 符号表至少有 2 个）
    const code2 = store.state.symbols.data![1]!.code;
    store.selectCode(code2);
    await vi.waitFor(() =>
      expect(vi.mocked(api.getQualityGaps).mock.calls.length).toBeGreaterThan(before),
    );
    expect(store.state.selectedCode).toBe(code2);
    const lastCall = vi.mocked(api.getQualityGaps).mock.calls.at(-1)![0]!;
    expect(lastCall.code).toBe(code2);
    expect(lastCall.from).toBeTruthy();
    expect(lastCall.to).toBeTruthy();
    store.dispose();
  });

  it('health 加载失败 → error 态；retry 恢复', async () => {
    const store = new SourcesStore({ api, ws });
    (api.getSourcesHealth as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('net'));
    await store.init();
    expect(store.state.health.error).toBeTruthy();
    expect(store.state.health.data).toBeNull();
    await store.refreshHealth();
    expect(store.state.health.error).toBeNull();
    expect(store.state.health.data).not.toBeNull();
    store.dispose();
  });

  it('点卡展开 detail-panel：加载 metrics/events/divergence；折叠清空', async () => {
    const store = new SourcesStore({ api, ws });
    await store.init();
    store.selectSource('tencent_qt');
    expect(store.state.selected).toBe('tencent_qt');
    await vi.waitFor(() => expect(store.state.detail?.events.data?.length).toBeGreaterThan(0));
    expect(api.getSourceMetrics).toHaveBeenCalledWith('tencent_qt', '1h');
    expect(api.getSourceEvents).toHaveBeenCalledWith('tencent_qt', 50);
    expect(api.getSourceDivergence).toHaveBeenCalledWith('tencent_qt', '1h');
    expect(api.getSourceRateLimits).toHaveBeenCalledWith('tencent_qt', '1h');
    expect(store.state.detail?.rateLimits.data).toHaveProperty('http429');
    store.selectSource(null);
    expect(store.state.selected).toBeNull();
    expect(store.state.detail).toBeNull();
    store.dispose();
  });

  it('范围切换重查 metrics/divergence（events 不重查）', async () => {
    const store = new SourcesStore({ api, ws });
    await store.init();
    store.selectSource('tencent_qt');
    await vi.waitFor(() => expect(store.state.detail?.metrics.data).not.toBeNull());
    vi.clearAllMocks();
    store.setDetailRange('3d');
    expect(store.state.detailRange).toBe('3d');
    await vi.waitFor(() => expect(api.getSourceMetrics).toHaveBeenCalledWith('tencent_qt', '3d'));
    expect(api.getSourceDivergence).toHaveBeenCalledWith('tencent_qt', '3d');
    expect(api.getSourceRateLimits).toHaveBeenCalledWith('tencent_qt', '3d');
    expect(api.getSourceEvents).not.toHaveBeenCalled();
    store.dispose();
  });

  it('WS health 推送 → 重拉健康；状态迁移源记入 flashes（卡片闪烁）', async () => {
    const store = new SourcesStore({ api, ws });
    await store.init();
    expect(store.state.flashes).toEqual({});
    const changed: SourcesHealth = {
      ...HEALTH,
      sources: [HEALTH.sources[0]!, { ...HEALTH.sources[1]!, status: 'healthy', circuit_state: 'closed' }],
    };
    (api.getSourcesHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce(changed);
    ws.emit('source_health', { type: 'health' });
    await vi.waitFor(() => expect(store.state.health.data?.sources[1]!.status).toBe('healthy'));
    expect(store.state.flashes['tencent_qt']).toBeGreaterThan(0);
    expect(store.state.flashes['tencent_ifzq']).toBeUndefined();
    store.dispose();
  });

  it('resetCircuit：调 POST reset → 复位后重拉健康；resetting 标志往返', async () => {
    const store = new SourcesStore({ api, ws });
    await store.init();
    const p = store.resetCircuit('tencent_qt');
    expect(store.state.resetting['tencent_qt']).toBe(true);
    await p;
    expect(api.resetSource).toHaveBeenCalledWith('tencent_qt');
    expect(store.state.resetting['tencent_qt']).toBe(false);
    expect(api.getSourcesHealth).toHaveBeenCalledTimes(2); // init + 复位后重拉
    store.dispose();
  });

  it('resetCircuit 失败 → resetErrors 记录且 resetting 复位', async () => {
    (api.resetSource as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const store = new SourcesStore({ api, ws });
    await store.init();
    await store.resetCircuit('tencent_qt');
    expect(store.state.resetting['tencent_qt']).toBe(false);
    expect(store.state.resetErrors['tencent_qt']).toBeTruthy();
    store.dispose();
  });

  it('dispose 后 WS 推送不再触发', async () => {
    const store = new SourcesStore({ api, ws });
    await store.init();
    store.dispose();
    vi.clearAllMocks();
    ws.emit('source_health', { type: 'health' });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getSourcesHealth).not.toHaveBeenCalled();
  });
});
