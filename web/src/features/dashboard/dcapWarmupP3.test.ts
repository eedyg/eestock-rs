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

/** 按请求 `limit` 返回相应根数的 api（**升序** ts：以 `before` 游标为右端向前 1 分钟一根，
 *  便于断言「前插更早 bar」——与真实 `GET /api/kline` 的升序口径一致）。 */
function windowApi() {
  const getKline = vi.fn(async (req: { limit: number; before?: string }) => {
    const end = req.before ? Date.parse(req.before) : Date.UTC(2026, 0, 5, 0, 0);
    return Array.from({ length: req.limit }, (_, i) => ({
      ts: new Date(end - (req.limit - i) * 60_000).toISOString(),
      open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1,
    })) as Bar[];
  });
  return { api: { getKline } as unknown as ApiClient, getKline };
}

/**
 * 热更新 warmup（dcap 参数保存路径）——**不得重建 feed**：
 * 图表侧靠 `chart.resetData()` 原地重载既有 + 新补的 bar（pane 布局/视口不受影响）。
 * 口径：目标加载窗口 = `viewportBars + warmup`；warmup 增大时按**差额**以已加载最左 ts 为游标向前补取。
 */
describe('KlineDataFeed.setWarmupBars（dcap 参数保存：向前补取差额，不重建 feed）', () => {
  it('warmup 增大（62→122）→ 补取差额 60 根并前插：窗口 182→242，返回 true', async () => {
    const { api, getKline } = windowApi();
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', viewportBars: 120, warmupBars: 62 });
    await feed.loadInitial();
    expect(feed.bars).toHaveLength(182);
    const firstTs = feed.bars[0]!.ts;

    expect(await feed.setWarmupBars(122)).toBe(true);

    // 关键口径：窗口 = viewportBars + warmup = 120 + 122 = 242；差额以最左已加载 bar 为排他游标
    expect(getKline).toHaveBeenLastCalledWith({ code: '518880', period: '15m', before: firstTs, limit: 60 });
    expect(feed.bars).toHaveLength(242);
    expect(feed.initialLimit).toBe(242);
    // 新 bar 必须**前插**（更早时间），既有 bar 一根不少（不重建、不丢历史）
    expect(Date.parse(feed.bars[0]!.ts)).toBeLessThan(Date.parse(firstTs));
    expect(feed.bars.at(-1)!.ts).toBe(new Date(Date.UTC(2026, 0, 4, 23, 59)).toISOString());
  });

  it('warmup 减小 / 不变 → 不取数（返回 false），仅更新字段（供后续分页/重载用）', async () => {
    const { api, getKline } = windowApi();
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', viewportBars: 120, warmupBars: 62 });
    await feed.loadInitial();
    expect(getKline).toHaveBeenCalledTimes(1);

    expect(await feed.setWarmupBars(62)).toBe(false); // 不变
    expect(await feed.setWarmupBars(0)).toBe(false); // 减小（DCAP 关：ADR-020 口径）
    expect(getKline).toHaveBeenCalledTimes(1); // 未多发一次取数
    expect(feed.initialLimit).toBe(120);
    expect(feed.bars).toHaveLength(182); // 既有数据保持（多余 warmup 不上图，无损）
  });

  it('尚未加载数据（bars 空）→ 只更新字段不取数；随后 loadInitial 用新 warmup', async () => {
    const { api, getKline } = windowApi();
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', viewportBars: 120 });
    expect(await feed.setWarmupBars(62)).toBe(false);
    expect(getKline).not.toHaveBeenCalled();
    await feed.loadInitial();
    expect(getKline).toHaveBeenCalledWith({ code: '518880', period: '15m', limit: 182 });
  });

  it('补取失败 → 不抛错（返回 false），既有数据保持（滚左时会自然补齐）', async () => {
    const getKline = vi
      .fn()
      .mockResolvedValueOnce(bars(182) as never)
      .mockRejectedValueOnce(new Error('network') as never);
    const feed = new KlineDataFeed({
      api: { getKline } as unknown as ApiClient,
      ws,
      code: '518880',
      period: '15m',
      viewportBars: 120,
      warmupBars: 62,
    });
    await feed.loadInitial();
    await expect(feed.setWarmupBars(122)).resolves.toBe(false);
    expect(feed.bars).toHaveLength(182);
  });
});
