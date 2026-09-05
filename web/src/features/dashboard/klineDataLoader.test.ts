import { describe, it, expect, vi } from 'vitest';
import type { KLineData } from 'klinecharts';
import type { Bar } from '@/api/types';
import { loadBarsForKc, type KlineDataFeedLike } from './klineDataLoader';

const MIN = 60 * 1000;
function iso(n: number): string {
  return new Date(n * MIN).toISOString();
}
function bar(tsN: number, close = 1): Bar {
  const ts = iso(tsN);
  return { ts, open: close, high: close, low: close, close, volume: 1, amount: close };
}

/**
 * 假 feed：模拟 KlineDataFeed 的 init/loadBefore 分页语义（升序 bars、去重前插更早页）。
 * allTs 为升序的「分钟序号」数据池；pageSize 为每页 bar 数。初始加载最新一页（最大 ts 的页），
 * loadBefore 每次回退一页并前插。
 */
function makeFakeFeed(allTs: number[], pageSize: number): KlineDataFeedLike {
  let start = Math.max(0, allTs.length - pageSize); // 初始加载最新一页（升序窗口起点）
  // 内部可变状态，避免对象字面量自引用导致的 TS 循环类型/初始化问题
  const state = { bars: allTs.slice(start).map((t) => bar(t)), hasMore: start > 0 };
  return {
    get bars() {
      return state.bars;
    },
    get hasMore() {
      return state.hasMore;
    },
    loadInitial: vi.fn(async () => {
      state.bars = allTs.slice(start).map((t) => bar(t));
      state.hasMore = start > 0;
    }),
    loadBefore: vi.fn(async () => {
      if (!state.hasMore || state.bars.length === 0) return 0;
      const newStart = Math.max(0, start - pageSize);
      const older = allTs.slice(newStart, start).map((t) => bar(t));
      const existing = new Set(state.bars.map((b) => b.ts));
      const fresh = older.filter((b) => !existing.has(b.ts));
      if (fresh.length) state.bars = [...fresh, ...state.bars];
      if (older.length < pageSize) state.hasMore = false;
      start = newStart;
      return fresh.length;
    }),
  };
}

describe('klineDataLoader（K 线图「循环/重复 bar」修复——forward 只回调增量，杜绝 klinecharts 非查重 concat 叠重复）', () => {
  it('forward 只回调增量：引擎非查重 concat 后 engineList 无重复 ts（RED→GREEN 核心）', async () => {
    // 数据池 ts 0..19，pageSize=5 → init 载入最新 5 根 [15..19]，两次 forward 各载入更早 5 根。
    const feed = makeFakeFeed([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 5);
    // 模拟 klinecharts StoreImp._addData 的 forward 行为：直接 concat，**不按 timestamp 去重**（这正是引擎行为）。
    let engineList: KLineData[] = [];
    const engineAccept = (data: KLineData[]) => {
      engineList = engineList.concat(data);
    };

    for (const type of ['init', 'forward', 'forward'] as const) {
      const { bars } = await loadBarsForKc(feed, type);
      engineAccept(bars);
    }

    const uniqueTs = new Set(engineList.map((d) => d.timestamp));
    // 正向契约下最终应为 15 根（init 5 + 两次 forward 各 5 增量），且 ts 全部唯一
    expect(engineList.length).toBe(15);
    expect(uniqueTs.size).toBe(engineList.length);
  });

  it('init 回调全量 feed.bars（升序）并各触发一次 onInit', async () => {
    const feed = makeFakeFeed([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    const onInit = vi.fn();
    const { bars, forward } = await loadBarsForKc(feed, 'init', onInit);
    // 初始加载最新一页 = ts [5..9]，全量、升序
    expect(bars.map((b) => b.timestamp)).toEqual([5, 6, 7, 8, 9].map((n) => n * MIN));
    expect(forward).toBe(true);
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  it('forward 无新增 delta 时回调空数组，forward 反映 feed.hasMore（引擎据此停拉）', async () => {
    // 数据池仅一页 → 初始 hasMore=false，loadBefore 直接返回 0，无可回退
    const feed = makeFakeFeed([0, 1, 2, 3, 4], 5);
    await loadBarsForKc(feed, 'init');
    const { bars, forward } = await loadBarsForKc(feed, 'forward');
    expect(bars).toEqual([]);
    expect(forward).toBe(false);
  });
});
