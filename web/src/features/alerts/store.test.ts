import { describe, it, expect, vi } from 'vitest';
import type { WsMessage } from '@/ws/WsClient';
import { stubApi } from '@/test/apiStub';
import type { AlertEventItem } from '@/api/types';
import { AlertsStore } from './store';

/** fake ws：捕获 subscribe handler，测试侧 emit 推送帧 */
function fakeWs() {
  const handlers = new Map<string, Set<(m: WsMessage) => void>>();
  return {
    handlers,
    subscribe: vi.fn((topic: string, h: (m: WsMessage) => void) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => {
        handlers.get(topic)!.delete(h);
      };
    }),
    emit(topic: string, msg: WsMessage) {
      handlers.get(topic)?.forEach((h) => h(msg));
    },
  };
}

function ev(id: number, over: Partial<AlertEventItem> = {}): AlertEventItem {
  return {
    id,
    rule_id: 'source_success_rate',
    level: 'warning',
    source: 'tencent_qt',
    message: `告警${id}`,
    status: 'triggered',
    fire_count: 1,
    first_fired_at: '2026-09-07T02:00:00Z',
    last_fired_at: '2026-09-07T02:00:00Z',
    acked_at: null,
    resolved_at: null,
    ...over,
  };
}

describe('AlertsStore（页面⑦ 状态机）', () => {
  it('init 加载列表+规则；默认过滤=今日（from 携带）', async () => {
    const api = stubApi();
    const ws = fakeWs();
    const store = new AlertsStore({ api, ws, now: () => new Date('2026-09-07T05:00:00+08:00') });
    await store.init();
    const s = store.state;
    expect(s.list.loading).toBe(false);
    expect(s.list.error).toBeNull();
    expect(s.list.data!.length).toBeGreaterThan(0);
    expect(s.rules.data).toHaveLength(4);
    // 默认今日：from = 本地日界
    expect(api.getAlertEvents).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.stringContaining('2026-09-06T16:00:00') }),
    );
    // WS 订阅 alert topic
    expect(ws.subscribe).toHaveBeenCalledWith('alert', expect.any(Function));
    store.dispose();
  });

  it('过滤变更即重查（级别/时间范围/来源）', async () => {
    const api = stubApi();
    const store = new AlertsStore({ api, ws: fakeWs(), now: () => new Date('2026-09-07T05:00:00+08:00') });
    await store.init();
    vi.mocked(api.getAlertEvents).mockClear();

    await store.setFilter({ level: 'critical' });
    expect(api.getAlertEvents).toHaveBeenCalledWith(expect.objectContaining({ level: 'critical' }));

    await store.setFilter({ range: 'all' });
    const last = vi.mocked(api.getAlertEvents).mock.calls.at(-1)![0];
    expect(last.from).toBeUndefined();

    await store.setFilter({ source: 'tencent_qt' });
    expect(vi.mocked(api.getAlertEvents).mock.calls.at(-1)![0].source).toBe('tencent_qt');
    store.dispose();
  });

  it('ack：调用 API 并就地把条目更新为已确认（确认时刻持久化）', async () => {
    const api = stubApi();
    const store = new AlertsStore({ api, ws: fakeWs() });
    await store.init();
    const target = store.state.list.data!.find((a) => a.status === 'triggered')!;
    await store.ack(target.id);
    expect(api.ackAlert).toHaveBeenCalledWith(target.id);
    const after = store.state.list.data!.find((a) => a.id === target.id)!;
    expect(after.status).toBe('acked');
    expect(after.acked_at).not.toBeNull();
    store.dispose();
  });

  it('updateRule：PATCH 后规则就地更新（阈值/开关/静默热生效口径）', async () => {
    const api = stubApi();
    const store = new AlertsStore({ api, ws: fakeWs() });
    await store.init();
    await store.updateRule('symbol_gap_rate', { threshold: 10, silence_minutes: 45 });
    expect(api.patchAlertRule).toHaveBeenCalledWith('symbol_gap_rate', { threshold: 10, silence_minutes: 45 });
    const r = store.state.rules.data!.find((x) => x.id === 'symbol_gap_rate')!;
    expect(r.threshold).toBe(10);
    expect(r.silence_minutes).toBe(45);
    store.dispose();
  });

  it('WS alert 推送：新事件入列表头部；同 id 替换（续触发计数/状态翻转）', async () => {
    const api = stubApi();
    const ws = fakeWs();
    const store = new AlertsStore({ api, ws });
    await store.init();
    const before = store.state.list.data!.length;

    ws.emit('alert', { type: 'alert', ...ev(9001, { level: 'critical', source: 'collector', message: '采集停摆' }) });
    let list = store.state.list.data!;
    expect(list.length).toBe(before + 1);
    expect(list[0]!.id).toBe(9001);

    // 同 id 续触发：替换不新增，计数推进
    ws.emit('alert', { type: 'alert', ...ev(9001, { level: 'critical', source: 'collector', fire_count: 2 }) });
    list = store.state.list.data!;
    expect(list.length).toBe(before + 1);
    expect(list.find((a) => a.id === 9001)!.fire_count).toBe(2);
    store.dispose();
  });

  it('WS 推送按当前过滤收纳：级别不匹配的新事件不入列', async () => {
    const api = stubApi();
    const ws = fakeWs();
    const store = new AlertsStore({ api, ws });
    await store.init();
    await store.setFilter({ level: 'critical' });
    vi.mocked(api.getAlertEvents).mockResolvedValue([]);
    await store.setFilter({ source: null });

    const before = store.state.list.data!.length;
    ws.emit('alert', { type: 'alert', ...ev(9002, { level: 'warning' }) });
    expect(store.state.list.data!.length).toBe(before);
    ws.emit('alert', { type: 'alert', ...ev(9003, { level: 'critical', source: 'collector' }) });
    expect(store.state.list.data!.some((a) => a.id === 9003)).toBe(true);
    store.dispose();
  });

  it('列表加载失败 → error 态；重试恢复', async () => {
    const api = stubApi();
    vi.mocked(api.getAlertEvents).mockRejectedValueOnce(new Error('db down'));
    const store = new AlertsStore({ api, ws: fakeWs() });
    await store.init();
    expect(store.state.list.error).toContain('db down');
    await store.loadList();
    expect(store.state.list.error).toBeNull();
    expect(store.state.list.data!.length).toBeGreaterThan(0);
    store.dispose();
  });

  it('dispose 后 WS 推送不再入列', async () => {
    const api = stubApi();
    const ws = fakeWs();
    const store = new AlertsStore({ api, ws });
    await store.init();
    store.dispose();
    const before = store.state.list.data!.length;
    ws.emit('alert', { type: 'alert', ...ev(9004) });
    expect(store.state.list.data!.length).toBe(before);
    expect(ws.handlers.get('alert')?.size ?? 0).toBe(0);
  });
});
