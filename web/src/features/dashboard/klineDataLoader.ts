import type { KLineData } from 'klinecharts';
import type { Bar } from '@/api/types';
import { toKcData } from './chartCommon';

export type KcLoadType = 'init' | 'forward';

/** feed 最小结构面：KlineChart 承接/测试注入只用到这些成员，避免强依赖整个 KlineDataFeed。 */
export interface KlineDataFeedLike {
  bars: Bar[];
  hasMore: boolean;
  loadInitial(): Promise<void>;
  loadBefore(): Promise<number>;
}

export interface LoadBarsResult {
  bars: KLineData[];
  forward: boolean;
}

/**
 * klinecharts DataLoader.getBars 的数据准备纯函数。
 *
 * 正确契约（GREEN）：
 *   - init：回调**全量** feed.bars（升序），forward=feed.hasMore，并调用一次 onInit（用于横向铺满 fitBarSpace）。
 *   - forward：先 await feed.loadBefore()（更早分页前插到 feed.bars 前），然后**只回调「比之前已渲染最左 ts 更早」
 *     的新增 delta**（升序，即 Date.parse(b.ts) < Date.parse(prevFirstTs) 的那些 bar），forward=feed.hasMore。
 *     绝不可再回传已渲染部分。若 loadBefore 无新增（无更早数据/并发被吞），则回调空数组 + forward=feed.hasMore
 *     （引擎据此停拉）。
 *
 * 为什么只看 delta：klinecharts StoreImp._addData 对 forward 做 `data.concat(_dataList)` 且**不按 timestamp 去重**；
 * 若回传整段 feed.bars（含已渲染 bar），每翻一页都叠加一遍 → 重复按页数平方级增长（即本 bug 根因）。
 */
export async function loadBarsForKc(
  feed: KlineDataFeedLike,
  type: KcLoadType,
  onInit?: (() => void) | null,
  toKc: (bar: Bar) => KLineData = toKcData,
): Promise<LoadBarsResult> {
  if (type === 'forward') {
    const prevFirstTs = feed.bars[0]?.ts; // 之前已渲染（最左）bar 的 ts，loadBefore 前的 feed.bars[0]
    await feed.loadBefore();
    // 只回传比 prevFirstTs 更早的新增 delta（升序）；loadBefore 仅前插更早页，故 ts<prevFirstTs 均为本次新增
    const delta = prevFirstTs
      ? feed.bars.filter((b) => Date.parse(b.ts) < Date.parse(prevFirstTs)).map(toKc)
      : [];
    return { bars: delta, forward: feed.hasMore };
  }
  await feed.loadInitial();
  onInit?.();
  return { bars: feed.bars.map(toKc), forward: feed.hasMore };
}
