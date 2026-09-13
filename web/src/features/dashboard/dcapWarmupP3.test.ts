/**
 * dcap 取数 warmup —— 单测（T10 口径）
 *
 * 本文件位置：`web/src/features/dashboard/dcapWarmupP3.test.ts`
 * 契约：`design/14-dcap-indicator/02-spec.md` §6「取数 warmup」/ §8 裁决 19；`03-test-plan.md` T10
 *  - 开 DCAP：初始取数 `limit = viewport_bars + (n_l + m − 1)`，多取部分仅供计算、不上图
 *    （视口最左那根已有 dcap 值，否则永远缺一段）；
 *  - 未开 DCAP：`limit = viewport_bars`（ADR-020 既有口径不变）。
 * 运行：cd web && npx vitest run src/features/dashboard/dcapWarmupP3.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { KlineDataFeed } from './feed';
import type { ApiClient } from '@/api/client';
import type { Bar } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { DEFAULT_DCAP_PARAMS, dcapWarmupBars } from '@/features/indicators/dcapIndicator';

const ws = { subscribe: vi.fn(() => () => {}) } as unknown as WsClient;

function bars(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1,
  }));
}

function fakeApi(len = 0): ApiClient {
  return { getKline: vi.fn(async () => bars(len)) } as unknown as ApiClient;
}

describe('KlineDataFeed.warmupBars（limit = viewport_bars + (n_l+m−1)）', () => {
  it('warmupBars=62（默认 n_l=60,m=3）→ 初始 limit = viewportBars + 62', async () => {
    const api = fakeApi(182);
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', viewportBars: 120, warmupBars: 62 });
    expect(feed.initialLimit).toBe(182);
    await feed.loadInitial();
    expect(api.getKline).toHaveBeenCalledWith({ code: '518880', period: '15m', limit: 182 });
    // 多取的 62 根在 feed 数据里（供指标计算），视口仍只显示 viewportBars 根（barSpace 由 viewportBars 决定）
    expect(feed.bars).toHaveLength(182);
    expect(feed.viewportBars).toBe(120);
    feed.dispose();
  });

  it('缺省 warmupBars → limit = viewportBars（ADR-020 口径不变；未开 DCAP 不浪费取数）', async () => {
    const api = fakeApi(120);
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', viewportBars: 120 });
    expect(feed.initialLimit).toBe(120);
    await feed.loadInitial();
    expect(api.getKline).toHaveBeenCalledWith({ code: '518880', period: '15m', limit: 120 });
    feed.dispose();
  });

  it('warmupBars=n_l+m−1（上界 250+60−1=309）→ limit = 视口 + 309', async () => {
    const api = fakeApi(0);
    const warmup = dcapWarmupBars({ ...DEFAULT_DCAP_PARAMS, n_l: 250, m: 60 });
    expect(warmup).toBe(309);
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '1d', viewportBars: 120, warmupBars: warmup });
    await feed.loadInitial();
    expect(api.getKline).toHaveBeenCalledWith({ code: '518880', period: '1d', limit: 429 });
    feed.dispose();
  });

  it('非法 warmup（负/小数/NaN）→ 归一到 0，绝不产生非法 limit', () => {
    const api = fakeApi();
    expect(new KlineDataFeed({ api, ws, code: 'x', period: '15m', viewportBars: 120, warmupBars: -5 }).initialLimit).toBe(120);
    expect(new KlineDataFeed({ api, ws, code: 'x', period: '15m', viewportBars: 120, warmupBars: 62.9 }).initialLimit).toBe(182);
    expect(new KlineDataFeed({ api, ws, code: 'x', period: '15m', viewportBars: 120, warmupBars: NaN }).initialLimit).toBe(120);
  });

  it('hasMore 以 warmup 后的实际请求量判定（取满 182 → 仍有更早数据）', async () => {
    const api = fakeApi(182);
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', viewportBars: 120, warmupBars: 62 });
    await feed.loadInitial();
    expect(feed.hasMore).toBe(true);
    feed.dispose();
  });
});
