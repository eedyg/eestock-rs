import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import { ScopedKlineFeed } from './ScopedKlineFeed';

const MIN = 60 * 1000;
/** 基准时刻（Unix 毫秒，整分钟边界），作为开仓时刻。 */
const BASE = 1_700_000_000_000;

function makeBar(tsMs: number, close = 10): Bar {
  return {
    ts: new Date(tsMs).toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    amount: close,
  };
}

/** 排他 before 游标 mock：返回池中 strictly before 的最近 limit 根（模拟后端分页语义）。 */
function poolApi(poolTsMs: number[]): ApiClient {
  const getKline = vi.fn(
    async ({ before, limit = 500 }: { before?: string; limit?: number }) => {
      const beforeMs = before ? Date.parse(before) : Infinity;
      const eligible = poolTsMs.filter((t) => t < beforeMs);
      return eligible.slice(-limit).map((t) => makeBar(t));
    },
  );
  return { getKline } as unknown as ApiClient;
}

/** 构造一个 1m 区间 feed：开仓=fromSec，平仓=fromSec+5min，buffer=2（便于计算窗口）。 */
function makeFeed(api: ApiClient, opts: { buffer?: number; pageSize?: number } = {}) {
  const fromSec = BASE / 1000;
  const toSec = fromSec + 5 * 60;
  return new ScopedKlineFeed({
    api,
    code: '518880',
    period: '1m' as Period,
    fromTs: fromSec,
    toTs: toSec,
    buffer: opts.buffer ?? 2,
    pageSize: opts.pageSize ?? 6,
  });
}

/** 完整数据池：k ∈ [-20, 12] 分钟的 bar，覆盖区间前后并留出可继续向前分页的历史。 */
function fullPool(): number[] {
  const out: number[] = [];
  for (let k = -20; k <= 12; k++) out.push(BASE + k * MIN);
  return out;
}

describe('ScopedKlineFeed（区间 K 线 feed——向前分页拉取更早历史）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loadInitial 取「区间 + 前后 buffer」窗口并过滤到闭区间，hasMore 起始 true（左还可拉）', async () => {
    const api = poolApi(fullPool());
    const feed = makeFeed(api);
    await feed.loadInitial();

    // 初始 before = toTs + step*(buffer+1)（平仓后 buffer 根再往下一根的排他上界）
    const beforeMs = BASE + 5 * MIN + (2 + 1) * MIN;
    // needBars = ceil(span/step) + 2*buffer + 3 = 5 + 4 + 3
    const needBars = 12;
    expect(api.getKline).toHaveBeenCalledWith({
      code: '518880',
      period: '1m',
      before: new Date(beforeMs).toISOString(),
      limit: needBars,
    });

    // 区间 [from-buffer, to+buffer] = k∈[-2, 7]，升序
    const ts = feed.bars.map((b) => Date.parse(b.ts));
    expect(ts).toEqual([-2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map((k) => BASE + k * MIN));
    expect(feed.status).toBe('ready');
    // 初始取满窗口 → 认为左侧还有历史可拉
    expect(feed.hasMore).toBe(true);
  });

  it('loadBefore 以最左 bar 的 ts 作为 before 游标拉更早 bar，去重前插并返回新增条数', async () => {
    const api = poolApi(fullPool());
    const feed = makeFeed(api, { pageSize: 6 });
    await feed.loadInitial();
    const beforeFirstTs = feed.bars[0]!.ts; // k=-2

    const added = await feed.loadBefore();

    // 游标 = 当前最左 bar ts（排他上界），limit = pageSize
    expect(api.getKline).toHaveBeenLastCalledWith({
      code: '518880',
      period: '1m',
      before: beforeFirstTs,
      limit: 6,
    });
    // 拉取 k∈[-8,-3]，去重前插（新增 6 根）
    expect(added).toBe(6);
    const ts = feed.bars.map((b) => Date.parse(b.ts));
    expect(ts).toEqual(Array.from({ length: 16 }, (_, i) => BASE + (i - 8) * MIN));
    // 每根 ts 唯一（无重复前插）
    expect(new Set(ts).size).toBe(ts.length);
  });

  it('loadBefore 分段前插直到历史尽头：older < pageSize 时置 hasMore=false；尽头返回 0', async () => {
    const api = poolApi(fullPool());
    const feed = makeFeed(api, { pageSize: 6 });
    await feed.loadInitial();
    expect(feed.hasMore).toBe(true);

    // 第 1~3 次各拉 6 根（k=-8..-3, -14..-9, -20..-15），仍 hasMore=true
    for (const expected of [6, 6, 6]) {
      expect(await feed.loadBefore()).toBe(expected);
    }
    expect(feed.hasMore).toBe(true);

    // 第 4 次：已到数据池最早（k=-20），返回 0，hasMore=false
    expect(await feed.loadBefore()).toBe(0);
    expect(feed.hasMore).toBe(false);
    // 已全部拉取 k∈[-20,7]
    const ts = feed.bars.map((b) => Date.parse(b.ts));
    expect(ts).toEqual(Array.from({ length: 28 }, (_, i) => BASE + (i - 20) * MIN));
  });

  it('loadBefore 去重：接口返回含已渲染 bar 时仅前插 fresh 部分，不产生重复 ts', async () => {
    // 数据池 k∈[-6, 7]；首屏窗口 k∈[-2,7]
    await (async () => {
      const api = poolApi(fullPool());
      const feed = makeFeed(api, { pageSize: 6 });
      await feed.loadInitial();

      // 手写 getKline 模拟「带重叠」返回：k=-7..-2（含已渲染的 -2）
      api.getKline = vi.fn(async () => {
        return [-7, -6, -5, -4, -3, -2].map((k) => makeBar(BASE + k * MIN));
      }) as unknown as ApiClient['getKline'];

      const added = await feed.loadBefore();
      expect(added).toBe(5); // -7..-3 共 5 根 fresh；-2 已渲染，去重
      const ts = feed.bars.map((b) => Date.parse(b.ts));
      const sorted = [...ts].sort((a, b) => a - b);
      expect(ts).toEqual(sorted); // 保持升序
      expect(new Set(ts).size).toBe(ts.length); // 无重复
      expect(ts[0]).toBe(BASE - 7 * MIN);
    })();
  });

  it('loadBefore 空区间或无 hasMore 时直接返回 0，不调用接口', async () => {
    const api = poolApi([]);
    const feed = makeFeed(api);
    await feed.loadInitial();
    // 空区间 → status=empty, hasMore=false（fetched 0 >= needBars 为 false）
    expect(feed.status).toBe('empty');
    expect(feed.hasMore).toBe(false);
    expect(await feed.loadBefore()).toBe(0);
    // 仅初始一次调用，loadBefore 未走网络
    expect(api.getKline).toHaveBeenCalledTimes(1);
  });

  it('loadInitial 幂等：重复调用复用同一 Promise，不重复取数', async () => {
    const api = poolApi(fullPool());
    const feed = makeFeed(api);
    await feed.loadInitial();
    await feed.loadInitial();
    expect(api.getKline).toHaveBeenCalledTimes(1);
  });
});
