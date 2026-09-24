import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@/api/client';
import type { Bar, Period } from '@/api/types';
import { DEFAULT_KLINE_VIEWPORT_BARS, paginationBatchForPeriod } from '@/features/dashboard/feed';
import {
  MAX_INITIAL_PAGES,
  SERVER_KLINE_MAX_LIMIT,
  ScopedKlineFeed,
  SCOPED_VIEWPORT_BARS,
} from './ScopedKlineFeed';

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

  it('无配置输入 → 视口固定 SCOPED_VIEWPORT_BARS=120（不读配置；与看板默认同构，主图 fitBarSpace 目标=可见 120 根）', () => {
    const feed = makeFeed(poolApi(fullPool()));
    expect(SCOPED_VIEWPORT_BARS).toBe(120);
    expect(feed.viewportBars).toBe(SCOPED_VIEWPORT_BARS);
    expect(feed.viewportBars).toBe(DEFAULT_KLINE_VIEWPORT_BARS);
  });

  it('loadBefore 默认批量 = paginationBatchForPeriod(period)（1m=500，不再按视口折算）', async () => {
    const api = poolApi(fullPool());
    const fromSec = BASE / 1000;
    const feed = new ScopedKlineFeed({ api, code: '518880', period: '1m', fromTs: fromSec, toTs: fromSec + 5 * 60, buffer: 2 });
    await feed.loadInitial();
    await feed.loadBefore();
    expect(paginationBatchForPeriod('1m')).toBe(500);
    expect(api.getKline).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: '518880', period: '1m', limit: 500 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 服务端单页上限（MAX_LIMIT=1000）下的初始装载分页
//
// 复现（用户实测：结果页 K 线本应从 2026-01-01 开始，实际最早只到 2026-07-08）：
//   真身 `crates/web/src/dto.rs: MAX_LIMIT = 1000` + `crates/web/src/rest.rs: q.limit.clamp(1, MAX_LIMIT)`
//   ⇒ 结果页把整段区间当 `limit` 一次拉（M15 × 266 天 ⇒ 25539）时**只回最新 1000 根**，
//     且旧 `hasMore = fetched.length >= needBars` 在夹取下恒假 ⇒ 向前分页被一并堵死。
// 本组判据在**修复前必红**（红读数见 coder/evidence/20260924_kline_history_fix/）。
// ─────────────────────────────────────────────────────────────────────────────

/** 模拟服务端 `/api/kline`：按 `before` 排他游标返回最近 `limit` 根，**并按服务端上限夹取**。 */
function clampedApi(poolTsMs: number[], serverMax = SERVER_KLINE_MAX_LIMIT): ApiClient {
  const getKline = vi.fn(async (q: { before?: string; limit?: number }) => {
    const beforeMs = q.before ? Date.parse(q.before) : Infinity;
    const eff = Math.min(q.limit ?? 500, serverMax);
    return poolTsMs
      .filter((t) => t < beforeMs)
      .slice(-eff)
      .map((t) => makeBar(t));
  });
  return { getKline } as unknown as ApiClient;
}

/** 1m bar 池：k ∈ [loMin, hiMin] 分钟。 */
function minutePool(loMin: number, hiMin: number): number[] {
  const out: number[] = [];
  for (let k = loMin; k <= hiMin; k++) out.push(BASE + k * MIN);
  return out;
}

/** 区间 feed（1m；开仓/平仓以分钟为单位给出；buffer 0 = 结果页口径）。 */
function rangeFeed(api: ApiClient, fromMin: number, toMin: number, pageSize?: number): ScopedKlineFeed {
  return new ScopedKlineFeed({
    api,
    code: '518880',
    period: '1m',
    fromTs: (BASE + fromMin * MIN) / 1000,
    toTs: (BASE + toMin * MIN) / 1000,
    buffer: 0,
    ...(pageSize != null ? { pageSize } : {}),
  });
}

describe('ScopedKlineFeed（服务端单页上限 MAX_LIMIT=1000 ⇒ 初始装载必须自行向前分页）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('初始装载自行分页直到覆盖区间起点（请求量不得超过服务端单页上限），且 hasMore=true', async () => {
    const api = clampedApi(minutePool(0, 5000));
    // 区间 [BASE+3000min, BASE+5000min] ⇒ needBars = 2000 + 0 + 3 = 2003 > 1000（触发服务端夹取）
    const feed = rangeFeed(api, 3000, 5000);
    await feed.loadInitial();

    // ① 单次请求不得超服务端单页上限（超了只会被夹取，拿不到更多）
    const calls = (api.getKline as unknown as { mock: { calls: Array<[{ limit: number }]> } }).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [q] of calls) expect(q.limit).toBeLessThanOrEqual(SERVER_KLINE_MAX_LIMIT);

    // ② 区间左端必须被覆盖：bars[0] == from_ts（旧实现：夹取后只回最新 1000 根 ⇒ bars[0] = from+1001min）
    expect(Date.parse(feed.bars[0]!.ts)).toBe(BASE + 3000 * MIN);
    expect(Date.parse(feed.bars[feed.bars.length - 1]!.ts)).toBe(BASE + 5000 * MIN);
    expect(feed.bars.length).toBe(2001);

    // ③ hasMore 必须为 true（左侧仍有更早历史）。旧实现 `fetched.length >= needBars`（1000 >= 2003）恒假
    //    ⇒ hasMore=false ⇒ loadBefore 首行 return 0 ⇒ 向左拖/滚永不取更早历史。
    expect(feed.hasMore).toBe(true);
    expect(feed.historyCovered).toBe(true);
    expect(feed.historyCapNote).toBeNull();
  });

  it('覆盖区间起点后，连续 loadBefore() 仍能把更早页并入并逐页前移 bars[0]', async () => {
    const api = clampedApi(minutePool(0, 5000));
    const feed = rangeFeed(api, 3000, 5000, 500);
    await feed.loadInitial();
    const first = Date.parse(feed.bars[0]!.ts);

    expect(await feed.loadBefore()).toBe(500);
    expect(Date.parse(feed.bars[0]!.ts)).toBe(first - 500 * MIN);
    expect(await feed.loadBefore()).toBe(500);
    expect(Date.parse(feed.bars[0]!.ts)).toBe(first - 1000 * MIN);

    const ts = feed.bars.map((b) => Date.parse(b.ts));
    expect(ts).toEqual([...ts].sort((a, b) => a - b)); // 升序
    expect(new Set(ts).size).toBe(ts.length); // 无重复
    expect(feed.hasMore).toBe(true); // 每页取满 ⇒ 左侧仍有历史
  });

  it('触顶（请求次数上限）且仍未覆盖区间起点 ⇒ 必须显式披露，禁静默截断', async () => {
    const api = clampedApi(minutePool(0, 25000));
    // 区间 [BASE+1000min, BASE+25000min] ⇒ 需要 24003 根 ≫ 20 页 × 1000 根 ⇒ 必然触顶
    const feed = rangeFeed(api, 1000, 25000);
    await feed.loadInitial();

    const calls = (api.getKline as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(calls.length).toBe(MAX_INITIAL_PAGES);
    // 已取回 k∈[6001, 25000]（20 页 × 1000 根，最新在前）
    expect(Date.parse(feed.bars[0]!.ts)).toBe(BASE + (25000 - MAX_INITIAL_PAGES * SERVER_KLINE_MAX_LIMIT + 1) * MIN);
    expect(feed.historyCovered).toBe(false);
    expect(feed.historyCapNote).toEqual(expect.stringContaining('触顶'));
    expect(feed.hasMore).toBe(true);
  });
});

