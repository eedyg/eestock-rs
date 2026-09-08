import { describe, it, expect, vi } from 'vitest';
import { createMockClient } from '@/api/mock';
import type { SimStateDto } from '@/api/types';
import { SimLiveStore } from './store';

function makeStore() {
  const api = createMockClient();
  const store = new SimLiveStore({ api });
  return { api, store };
}

/** 空态模拟实盘（未运行会话；getSimState 首次/无数据时后端响应）。 */
function emptySimState(): SimStateDto {
  return { active: false, session: null, account: null, positions: [], pnl: null, trading_enabled: false, mcp_enabled: true };
}

/** 可控 resolve 的 getSimState mock：测试「拉取中」的中间态。 */
function deferredGetSimState(api: ReturnType<typeof createMockClient>) {
  let resolve!: (d: SimStateDto) => void;
  const promise = new Promise<SimStateDto>((r) => { resolve = r; });
  vi.spyOn(api, 'getSimState').mockReturnValueOnce(promise);
  return { promise, resolve };
}

describe('SimLiveStore.startSession（配置标的/策略 → body 透传 stock_set/strategy_set）', () => {
  it('选标的+选策略 → startSimSession 收到 stock_set/strategy_set', async () => {
    const { api, store } = makeStore();
    const spy = vi.spyOn(api, 'startSimSession');
    await store.startSession({
      name: 't',
      period: 'M1',
      cash_init: 200_000,
      stock_set: ['518880', '513310'],
      strategy_set: ['dual_ma', 'macd'],
    });
    expect(spy).toHaveBeenCalledWith({
      name: 't',
      period: 'M1',
      cash_init: 200_000,
      stock_set: ['518880', '513310'],
      strategy_set: ['dual_ma', 'macd'],
    });
  });

  it('缺省不配置 → startSimSession 不带 stock_set/strategy_set（后端兜底）', async () => {
    const { api, store } = makeStore();
    const spy = vi.spyOn(api, 'startSimSession');
    await store.startSession({ name: 't', period: 'M1' });
    expect(spy).toHaveBeenCalledWith({ name: 't', period: 'M1' });
  });
});

describe('SimLiveStore.refreshCurrent（静默/后台刷新：轮询不整页刷新、不滚回顶部）', () => {
  it('已有 data 时 refreshCurrent 不置 data=null、不置 loading=true，拉取后原位更新 data', async () => {
    const { api, store } = makeStore();
    await store.init();
    const before = store.state.current.data;
    expect(before).not.toBeNull();

    const { resolve } = deferredGetSimState(api);
    const p = store.refreshCurrent();
    // 拉取未完成：原位保留旧 data（不能 null），loading 保持普通态（不能 true）。
    expect(store.state.current.data).not.toBeNull();
    expect(store.state.current.data).toEqual(before);
    expect(store.state.current.loading).toBe(false);

    resolve({ ...before!, trading_enabled: false, mcp_enabled: false });
    await p;
    expect(store.state.current.loading).toBe(false);
    expect(store.state.current.data).toEqual(expect.objectContaining({ trading_enabled: false, mcp_enabled: false }));
  });

  it('首次/无 data（init）→ 骨架 loading=true；数据到位后 loading=false', async () => {
    const { api, store } = makeStore();
    const { resolve } = deferredGetSimState(api);
    const p = store.init();
    expect(store.state.current.data).toBeNull();
    expect(store.state.current.loading).toBe(true);
    resolve(emptySimState());
    await p;
    expect(store.state.current.loading).toBe(false);
    expect(store.state.current.data).not.toBeNull();
  });

  it('静默刷新失败 → 保留原位 data（不清空）、loading 不闪 true，仅设 error', async () => {
    const { api, store } = makeStore();
    await store.init();
    const before = store.state.current.data;
    vi.spyOn(api, 'getSimState').mockRejectedValueOnce(new Error('boom'));
    await store.refreshCurrent();
    expect(store.state.current.data).toEqual(before);
    expect(store.state.current.data).not.toBeNull();
    expect(store.state.current.loading).toBe(false);
    expect(store.state.current.error).toBe('boom');
  });
});
