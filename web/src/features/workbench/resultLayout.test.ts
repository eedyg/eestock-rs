/**
 * D7（ADR-028 §2.7 / 计划 §2 表 D7-1/D7-3 + §4 边界）—— 下栏**分层布局**的纯函数判据。
 *
 * 判据推导：
 *  - D7-3：下栏默认 **40% 视口高**；分隔条拖拽改变比例；**折叠后上栏占满**；比例**记忆**；
 *  - §4：比例 clamp 到 **[0.15, 0.85]**（可测常量），不得把任一侧压到 0；折叠后展开恢复原比例；
 *    坏数据回默认（不得 NaN/0）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DETAIL_RATIO,
  DETAIL_RATIO_MAX,
  DETAIL_RATIO_MIN,
  DETAIL_UPPER_MIN_PX,
  RESULT_LAYOUT_STORAGE_KEY,
  clampRatio,
  detailPxForRatio,
  layoutForViewport,
  readResultLayout,
  ratioForDetailPx,
  toggleCollapsed,
  writeResultLayout,
  type LayoutStorage,
} from './resultLayout';

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const storage: LayoutStorage = {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return { storage, map };
}

describe('D7-3 比例常量与 clamp', () => {
  it('默认 40% 视口高；clamp 区间 [0.15, 0.85]', () => {
    expect(DEFAULT_DETAIL_RATIO).toBe(0.4);
    expect(DETAIL_RATIO_MIN).toBe(0.15);
    expect(DETAIL_RATIO_MAX).toBe(0.85);
  });

  it('clampRatio：越界夹取、坏数据回默认（不得 NaN）', () => {
    expect(clampRatio(0.05)).toBe(DETAIL_RATIO_MIN);
    expect(clampRatio(0.95)).toBe(DETAIL_RATIO_MAX);
    expect(clampRatio(0.4)).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_DETAIL_RATIO);
    expect(clampRatio('0.5')).toBe(DEFAULT_DETAIL_RATIO);
    expect(clampRatio(null)).toBe(DEFAULT_DETAIL_RATIO);
  });
});

describe('D7-3 比例 ↔ px（注入视口高）', () => {
  it('默认 40% 视口高（800 ⇒ 320px）', () => {
    expect(detailPxForRatio({ ratio: DEFAULT_DETAIL_RATIO, viewportH: 800 })).toBe(320);
    expect(detailPxForRatio({ ratio: 0.5, viewportH: 1000 })).toBe(500);
  });

  it('px → 比例（反解）与 clamp 一致', () => {
    expect(ratioForDetailPx({ detailPx: 320, viewportH: 800 })).toBe(0.4);
    expect(ratioForDetailPx({ detailPx: 10, viewportH: 800 })).toBe(DETAIL_RATIO_MIN);
    expect(ratioForDetailPx({ detailPx: 790, viewportH: 800 })).toBe(DETAIL_RATIO_MAX);
    expect(ratioForDetailPx({ detailPx: Number.NaN, viewportH: 800 })).toBe(DEFAULT_DETAIL_RATIO);
  });

  it('上栏保底：下栏不得把上栏压到 DETAIL_UPPER_MIN_PX 以下', () => {
    expect(DETAIL_UPPER_MIN_PX).toBeGreaterThanOrEqual(160);
    expect(
      detailPxForRatio({ ratio: 0.85, viewportH: 800, availablePx: 600, upperMinPx: DETAIL_UPPER_MIN_PX }),
    ).toBe(600 - DETAIL_UPPER_MIN_PX);
  });

  it('可用高极小时下栏不消失也不为负', () => {
    const px = detailPxForRatio({ ratio: 0.4, viewportH: 800, availablePx: 100, upperMinPx: DETAIL_UPPER_MIN_PX });
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThanOrEqual(100);
  });
});

describe('D7-3 折叠与记忆', () => {
  it('折叠/展开切换（纯函数，幂等语义）', () => {
    expect(toggleCollapsed(false)).toBe(true);
    expect(toggleCollapsed(true)).toBe(false);
  });

  it('折叠态：下栏 px = 0（上栏占满），但比例记忆保留（展开恢复）', () => {
    const layout = { ratio: 0.62, collapsed: true };
    expect(layoutForViewport({ layout, viewportH: 800, availablePx: 600 })).toMatchObject({
      detailPx: 0,
      chartPx: 600,
      collapsed: true,
    });
    const expanded = { ratio: layout.ratio, collapsed: false };
    expect(layoutForViewport({ layout: expanded, viewportH: 800 }).detailPx).toBe(496);
    // 与上栏保底同时作用时：比例仍是恢复值，px 受上栏保底夹取
    expect(
      layoutForViewport({ layout: expanded, viewportH: 800, availablePx: 600 }).detailPx,
    ).toBe(600 - DETAIL_UPPER_MIN_PX);
  });

  it('记忆 roundtrip（结果页独立 key）+ 坏数据回默认', () => {
    expect(RESULT_LAYOUT_STORAGE_KEY).toBe('eestock.result.layout.v1');
    const { storage, map } = fakeStorage();
    writeResultLayout({ ratio: 0.5, collapsed: true }, storage);
    expect(JSON.parse(map.get(RESULT_LAYOUT_STORAGE_KEY) as string)).toEqual({ ratio: 0.5, collapsed: true });
    expect(readResultLayout(storage)).toEqual({ ratio: 0.5, collapsed: true });

    const bad = fakeStorage({ [RESULT_LAYOUT_STORAGE_KEY]: '{oops' });
    expect(readResultLayout(bad.storage)).toEqual({ ratio: DEFAULT_DETAIL_RATIO, collapsed: false });
    const nan = fakeStorage({ [RESULT_LAYOUT_STORAGE_KEY]: '{"ratio":null,"collapsed":"yes"}' });
    expect(readResultLayout(nan.storage)).toEqual({ ratio: DEFAULT_DETAIL_RATIO, collapsed: false });
    const oob = fakeStorage({ [RESULT_LAYOUT_STORAGE_KEY]: '{"ratio":9,"collapsed":true}' });
    expect(readResultLayout(oob.storage)).toEqual({ ratio: DETAIL_RATIO_MAX, collapsed: true });
    expect(readResultLayout(null)).toEqual({ ratio: DEFAULT_DETAIL_RATIO, collapsed: false });
  });
});
