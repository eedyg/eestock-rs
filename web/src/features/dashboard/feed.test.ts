import { describe, it, expect, vi } from 'vitest';
import {
  KlineDataFeed,
  paginationBatchForPeriod,
  PAGINATION_BATCH,
  DEFAULT_KLINE_VIEWPORT_BARS,
  MIN_KLINE_VIEWPORT_BARS,
  MAX_KLINE_VIEWPORT_BARS,
  TIMESHARE_1M_BARS,
} from './feed';
import type { ApiClient } from '@/api/client';
import type { Period } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';

const ALL_PERIODS: Period[] = ['1m', '5m', '15m', '1h', '1d', '1w', '1mo'];

function fakeApi(getKline = vi.fn(async () => [])): ApiClient {
  return { getKline } as unknown as ApiClient;
}
const ws = { subscribe: vi.fn(() => () => {}) } as unknown as WsClient;

describe('feed 视口常量（ADR-020 §2.2：默认 120 根 / 区间 30–600）', () => {
  it('DEFAULT=120、MIN=30、MAX=600，且 MAX < 后端 MAX_LIMIT(1000)（截断路径不可达）', () => {
    expect(DEFAULT_KLINE_VIEWPORT_BARS).toBe(120);
    expect(MIN_KLINE_VIEWPORT_BARS).toBe(30);
    expect(MAX_KLINE_VIEWPORT_BARS).toBe(600);
    expect(DEFAULT_KLINE_VIEWPORT_BARS).toBeGreaterThanOrEqual(MIN_KLINE_VIEWPORT_BARS);
    expect(DEFAULT_KLINE_VIEWPORT_BARS).toBeLessThanOrEqual(MAX_KLINE_VIEWPORT_BARS);
    expect(MAX_KLINE_VIEWPORT_BARS).toBeLessThan(1000);
  });

  it('TIMESHARE_1M_BARS=500 ≥ 一个交易日 1m 上限 241（分时=当日全时段；与视口配置解耦）', () => {
    expect(TIMESHARE_1M_BARS).toBe(500);
    expect(TIMESHARE_1M_BARS).toBeGreaterThanOrEqual(241);
    expect(TIMESHARE_1M_BARS).not.toBe(DEFAULT_KLINE_VIEWPORT_BARS);
    expect(TIMESHARE_1M_BARS).toBeLessThanOrEqual(1000); // ≤ 后端 MAX_LIMIT，不被截断
  });
});

describe('feed 视口与周期解耦（R3：pageSize = viewportBars，与 period 无关）', () => {
  it('viewportBars=200 → 1m/15m/1d 初始 limit 全为 200（不再按每日 bar 数折算）', async () => {
    for (const period of ['1m', '15m', '1d'] as const) {
      const api = fakeApi();
      const feed = new KlineDataFeed({ api, ws, code: '518880', period, viewportBars: 200 });
      await feed.loadInitial();
      expect(api.getKline).toHaveBeenCalledWith({ code: '518880', period, limit: 200 });
      feed.dispose();
    }
  });

  it('缺省 viewportBars → 120（DEFAULT_KLINE_VIEWPORT_BARS），任意周期同值', async () => {
    for (const period of ALL_PERIODS) {
      const api = fakeApi();
      const feed = new KlineDataFeed({ api, ws, code: '518880', period });
      expect(feed.viewportBars).toBe(DEFAULT_KLINE_VIEWPORT_BARS);
      await feed.loadInitial();
      expect(api.getKline).toHaveBeenCalledWith({ code: '518880', period, limit: 120 });
      feed.dispose();
    }
  });

  it('viewportBars getter：配置值生效 / 缺省兜底 120', () => {
    const configured = new KlineDataFeed({ api: fakeApi(), ws, code: '518880', period: '15m', viewportBars: 600 });
    expect(configured.viewportBars).toBe(600);
    configured.dispose();

    const defaulted = new KlineDataFeed({ api: fakeApi(), ws, code: '518880', period: '15m' });
    expect(defaulted.viewportBars).toBe(DEFAULT_KLINE_VIEWPORT_BARS);
    defaulted.dispose();
  });

  it('显式 pageSize 仍优先于 viewportBars（测试/特化场景保留覆盖）', async () => {
    const api = fakeApi();
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '15m', viewportBars: 200, pageSize: 34 });
    await feed.loadInitial();
    expect(api.getKline).toHaveBeenCalledWith({ code: '518880', period: '15m', limit: 34 });
    // getter 仍报配置视口（供 fitBarSpace 铺满目标使用）
    expect(feed.viewportBars).toBe(200);
    feed.dispose();
  });

  it('深翻用 PAGINATION_BATCH（与视口解耦，不受 viewportBars 影响）', async () => {
    const bar = (i: number) => ({
      ts: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
      open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1,
    });
    // 首屏返回满视口（120 根）→ hasMore=true（同 KlineDataFeed 分页口径）
    const api = fakeApi(vi.fn(async (q: { before?: string }) => (q.before ? [] : Array.from({ length: 120 }, (_, i) => bar(i)))));
    const feed = new KlineDataFeed({ api, ws, code: '518880', period: '1m', viewportBars: 120 });
    await feed.loadInitial();
    expect(feed.hasMore).toBe(true);
    await feed.loadBefore();
    expect(api.getKline).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: paginationBatchForPeriod('1m') }),
    );
    expect(paginationBatchForPeriod('1m')).toBe(500);
    feed.dispose();
  });
});

describe('feed paginationBatchForPeriod（分页批量，视口解耦后保留不动）', () => {
  it('各周期批量取值正确（约定定稿）', () => {
    expect(paginationBatchForPeriod('1m')).toBe(500);
    expect(paginationBatchForPeriod('5m')).toBe(300);
    expect(paginationBatchForPeriod('15m')).toBe(220);
    expect(paginationBatchForPeriod('1h')).toBe(120);
    expect(paginationBatchForPeriod('1d')).toBe(250);
    expect(paginationBatchForPeriod('1w')).toBe(150);
    expect(paginationBatchForPeriod('1mo')).toBe(80);
  });

  it('PAGINATION_BATCH 与 paginationBatchForPeriod 一致（无双重事实源）', () => {
    for (const p of ALL_PERIODS) {
      expect(PAGINATION_BATCH[p]).toBe(paginationBatchForPeriod(p));
    }
  });

  it('批量 ≤ MAX_LIMIT(1000)（深翻不被后端截断，F2 路径不可达）', () => {
    for (const p of ALL_PERIODS) {
      expect(paginationBatchForPeriod(p)).toBeLessThanOrEqual(1000);
    }
  });
});
