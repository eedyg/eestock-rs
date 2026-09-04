import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '@/api/client';
import type { QualityDivergenceResponse } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { QualityStore, defaultRange, cstDateStr } from './store';

const NOW = new Date('2026-09-04T05:42:00Z'); // 2026-09-04 13:42 CST

function divergenceOf(code: string): QualityDivergenceResponse {
  return {
    code, from: '2026-08-29', to: '2026-09-04', threshold_pct: 0.5,
    summary: { compared_bars: 2, divergent_bars: 1, divergence_rate: 0.5, consistency_rate: 0.5, max_deviation_pct: 1.52 },
    rows: [
      { ts: '2026-09-02T02:41:00Z', raw_close: 2.468, accurate_close: 2.431, deviation_pct: 1.52, raw_source: 'sina_jsonp' },
    ],
  };
}

describe('defaultRange / cstDateStr（CST 日界，与浏览器时区无关）', () => {
  it('默认范围 = 近 7 个自然日（CST），to=今日', () => {
    expect(cstDateStr(NOW)).toBe('2026-09-04');
    // UTC 深夜仍属 CST 次日
    expect(cstDateStr(new Date('2026-09-04T16:30:00Z'))).toBe('2026-09-05');
    expect(defaultRange(NOW)).toEqual({ from: '2026-08-29', to: '2026-09-04' });
  });
});

describe('QualityStore（页面④：过滤变更即重查；四区独立三态）', () => {
  function makeStore(over: Partial<ApiClient> = {}) {
    const api = stubApi({
      getQualityDivergence: vi.fn(async (q: { code: string }) => divergenceOf(q.code)),
      ...over,
    });
    const store = new QualityStore({ api, now: () => NOW });
    return { api, store };
  }

  it('init：加载标的+ tushare 状态，默认选中首标的后按默认范围重查三端点', async () => {
    const { api, store } = makeStore();
    await store.init();
    const st = store.state;
    expect(st.filter.code).toBe('518880'); // mock 首标的
    expect(st.filter.range).toEqual({ from: '2026-08-29', to: '2026-09-04' });
    expect(st.filter.view).toBe('table');
    expect(api.getQualityDivergence).toHaveBeenCalledWith(
      expect.objectContaining({ code: '518880', from: '2026-08-29', to: '2026-09-04' }),
    );
    expect(api.getQualityGaps).toHaveBeenCalledWith(
      expect.objectContaining({ code: '518880' }),
    );
    // source-accuracy 不带 code（全源全标的窗口口径）
    const accCall = vi.mocked(api.getSourceAccuracy).mock.calls[0]![0]!;
    expect(accCall).not.toHaveProperty('code');
    expect(api.getTushareStatus).toHaveBeenCalled();
    expect(st.divergence.data?.summary.compared_bars).toBe(2);
    expect(st.tushare.data?.quota_remaining).toBeNull();
  });

  it('标的切换 → divergence/gaps 携带新 code 重查；accuracy 亦随窗口重查', async () => {
    const { api, store } = makeStore();
    await store.init();
    vi.mocked(api.getQualityDivergence).mockClear();
    vi.mocked(api.getSourceAccuracy).mockClear();
    await store.setFilter({ code: '513310' });
    expect(api.getQualityDivergence).toHaveBeenCalledWith(expect.objectContaining({ code: '513310' }));
    expect(api.getQualityGaps).toHaveBeenCalledWith(expect.objectContaining({ code: '513310' }));
    expect(api.getSourceAccuracy).toHaveBeenCalled();
    expect(store.state.divergence.data?.code).toBe('513310');
  });

  it('日期范围变更 → 三端点按新范围重查', async () => {
    const { api, store } = makeStore();
    await store.init();
    vi.mocked(api.getQualityDivergence).mockClear();
    await store.setFilter({ range: { from: '2026-09-01', to: '2026-09-03' } });
    expect(api.getQualityDivergence).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-09-01', to: '2026-09-03' }),
    );
    expect(api.getQualityGaps).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-09-01', to: '2026-09-03' }),
    );
    expect(api.getSourceAccuracy).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-09-01', to: '2026-09-03' }),
    );
  });

  it('视图切换为客户端状态：view=overlay 不触发重查', async () => {
    const { api, store } = makeStore();
    await store.init();
    vi.mocked(api.getQualityDivergence).mockClear();
    store.setView('overlay');
    expect(store.state.filter.view).toBe('overlay');
    expect(api.getQualityDivergence).not.toHaveBeenCalled();
  });

  it('错误三态：divergence 失败仅影响本区；retry 重拉', async () => {
    const { api, store } = makeStore({
      getQualityDivergence: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await store.init();
    expect(store.state.divergence.error).toBe('boom');
    expect(store.state.divergence.loading).toBe(false);
    // 其余区不受影响
    expect(store.state.tushare.error).toBeNull();
    vi.mocked(api.getQualityDivergence).mockImplementation(async (q) => divergenceOf(q.code));
    await store.retryDivergence();
    expect(store.state.divergence.error).toBeNull();
    expect(store.state.divergence.data?.code).toBe('518880');
  });

  it('无可用标的（symbols 空）：divergence/gaps 不发请求，落空态', async () => {
    const api = stubApi({ getSymbols: vi.fn(async () => []) });
    const store = new QualityStore({ api, now: () => NOW });
    await store.init();
    expect(store.state.filter.code).toBeNull();
    expect(api.getQualityDivergence).not.toHaveBeenCalled();
    expect(store.state.divergence.loading).toBe(false);
    expect(store.state.divergence.data).toBeNull();
  });
});
