import { describe, it, expect, vi } from 'vitest';
import { createMockClient } from '@/api/mock';
import { SimLiveStore } from './store';

function makeStore() {
  const api = createMockClient();
  const store = new SimLiveStore({ api });
  return { api, store };
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
