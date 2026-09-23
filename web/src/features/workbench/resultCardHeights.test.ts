/**
 * D6（ADR-028 §2.6 / 计划 `07-plan-result-height-and-detail-split.md` §2 表 D6-1/D6-2/D6-4/D6-7 + §4 边界）
 * —— **纯函数与记忆层**判据。
 *
 * 判据推导（不得按实现倒推）：
 *  - D6-1 默认卡高 520（无记忆值时）；
 *  - D6-2 预设 S/M/L = 260/420/560（受 min/max 夹取）；
 *  - D6-3 主图/副图分配：520 卡高 ⇒ candle ≥320 ∧ 副图合计 ≤120；小卡高态 ⇒ candle ≥160 ∧ 副图 ≥30；
 *  - D6-4 **有效下限** = max(200, 卡头实高 + 分隔1 + x轴26 + 160 + 副图有效下限30×N)（2026-09-23 裁决口径）；
 *  - D6-7 记忆写入**结果页独立 key**；**不得**读写看板 key（`eestock.dashboard.layout.v1`）。
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_HEIGHT_PRESETS,
  CARD_HEIGHT_STORAGE_KEY,
  CARD_MIN_PX,
  DASHBOARD_LAYOUT_KEY,
  DEFAULT_KLINE_PX,
  KLINE_AXIS_PX,
  KLINE_CANDLE_MIN_PX,
  LEGACY_RESULT_CHART_CONFIG_KEY,
  PANE_SEPARATOR_PX,
  SUB_PANE_DEFAULT_PX,
  SUB_PANE_MIN_PX,
  SUB_PANE_TOTAL_MAX_PX,
  cardBoundsFor,
  clampCardPx,
  effectiveMinCardPx,
  planKlinePanes,
  readCardHeight,
  resolveCardPx,
  writeCardHeight,
  type CardHeightStorage,
} from './resultCardHeights';

/** 内存 storage 适配器（DI；不碰真 `localStorage`）。 */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  const storage: CardHeightStorage = {
    getItem: (k) => {
      calls.push(`get:${k}`);
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem: (k, v) => {
      calls.push(`set:${k}`);
      map.set(k, v);
    },
    removeItem: (k) => {
      calls.push(`del:${k}`);
      map.delete(k);
    },
  };
  return { storage, map, calls };
}

describe('D6-1/D6-2 默认值与预设（契约常量）', () => {
  it('默认卡高 = 520px；名义下限 = 200px', () => {
    expect(DEFAULT_KLINE_PX).toBe(520);
    expect(CARD_MIN_PX).toBe(200);
  });

  it('预设 S/M/L = 260 / 420 / 560', () => {
    expect(CARD_HEIGHT_PRESETS).toEqual({ s: 260, m: 420, l: 560 });
  });

  it('几何常量 = 真身读数（x 轴 26 / 分隔 1 / 副图默认 100 / 副图合计上限 120 / 主图硬下限 160）', () => {
    expect(KLINE_AXIS_PX).toBe(26);
    expect(PANE_SEPARATOR_PX).toBe(1);
    expect(SUB_PANE_DEFAULT_PX).toBe(100);
    expect(SUB_PANE_TOTAL_MAX_PX).toBe(120);
    expect(KLINE_CANDLE_MIN_PX).toBe(160);
    expect(SUB_PANE_MIN_PX).toBe(30);
  });

  it('预设值经夹取：S=260 在 [有效下限, max] 内不动；视口极小时按 max 夹取', () => {
    const bounds = cardBoundsFor({ viewportH: 800, headerPx: 24, subPaneCount: 1 });
    expect(clampCardPx(CARD_HEIGHT_PRESETS.s, bounds)).toBe(260);
    expect(clampCardPx(CARD_HEIGHT_PRESETS.m, bounds)).toBe(420);
    expect(clampCardPx(CARD_HEIGHT_PRESETS.l, bounds)).toBe(560);
    // 视口 700 ⇒ max = 500 ⇒ L 被夹到 500
    const small = cardBoundsFor({ viewportH: 700, headerPx: 24, subPaneCount: 1 });
    expect(clampCardPx(CARD_HEIGHT_PRESETS.l, small)).toBe(500);
  });
});

describe('D6-4 有效下限（2026-09-23 裁决口径）', () => {
  it('= max(200, 卡头 + 卡边框2 + 1 + 26 + 160 + 30×副图数)', () => {
    // 卡边框 2px 为真身实测补项（卡 237 − 卡头 20 − klinecharts 容器 215 = 2）：缺它则下限处主图 158 < 160
    expect(effectiveMinCardPx({ headerPx: 24, subPaneCount: 1 })).toBe(243);
    expect(effectiveMinCardPx({ headerPx: 24, subPaneCount: 2 })).toBe(273);
    expect(effectiveMinCardPx({ headerPx: 48, subPaneCount: 1 })).toBe(267);
    // 无副图时不含副图下限（24 + 2 + 1 + 26 + 160 = 213）
    expect(effectiveMinCardPx({ headerPx: 24, subPaneCount: 0 })).toBe(213);
  });

  it('名义下限 200 永远兜底（卡头极小/无副图也不例外）', () => {
    expect(effectiveMinCardPx({ headerPx: 0, subPaneCount: 0 })).toBe(200);
    expect(effectiveMinCardPx({ headerPx: -5, subPaneCount: 0 })).toBe(200);
  });

  it('max = 视口高 − 200；视口过小时 max 不低于有效下限（下限优先）', () => {
    expect(cardBoundsFor({ viewportH: 800, headerPx: 24, subPaneCount: 1 })).toEqual({ min: 243, max: 600 });
    expect(cardBoundsFor({ viewportH: 400, headerPx: 24, subPaneCount: 1 })).toEqual({ min: 243, max: 243 });
  });
});

describe('D6-3 主图/副图分配（planKlinePanes）', () => {
  it('默认 520 卡（卡头 24 ⇒ 容器 496，1 个副图）：主图 ≥320 ∧ 副图合计 ≤120', () => {
    const plan = planKlinePanes({ containerPx: 496, subPaneCount: 1 });
    expect(plan.subPaneTotalPx).toBeLessThanOrEqual(SUB_PANE_TOTAL_MAX_PX);
    expect(plan.candlePx).toBeGreaterThanOrEqual(320);
    expect(plan.candlePx).toBe(496 - KLINE_AXIS_PX - PANE_SEPARATOR_PX - SUB_PANE_DEFAULT_PX);
    expect(plan.subPanePx).toBe(SUB_PANE_DEFAULT_PX);
    expect(plan.clamped).toBe(false);
  });

  it('多副图（2 个）合计仍 ≤120，且主图仍 ≥320', () => {
    const plan = planKlinePanes({ containerPx: 496 - 1, subPaneCount: 2 });
    expect(plan.subPaneTotalPx).toBe(SUB_PANE_TOTAL_MAX_PX);
    expect(plan.subPanePx).toBe(60);
    expect(plan.candlePx).toBeGreaterThanOrEqual(320);
  });

  it('小卡高态（S=260 ⇒ 容器 236）：主图 ≥160 ∧ 副图 ≥30（余量优先给副图）', () => {
    const plan = planKlinePanes({ containerPx: 236, subPaneCount: 1 });
    expect(plan.candlePx).toBe(KLINE_CANDLE_MIN_PX);
    expect(plan.subPanePx).toBe(49);
    expect(plan.subPanePx).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
  });

  it('卡高 = 有效下限（含卡边框：卡 239 ⇒ 容器 217）：主图 = 160 ∧ 副图 = 30（两侧都不越界）', () => {
    const plan = planKlinePanes({ containerPx: 243 - 24 - 2, subPaneCount: 1 });
    expect(plan.candlePx).toBe(KLINE_CANDLE_MIN_PX);
    expect(plan.subPanePx).toBe(SUB_PANE_MIN_PX);
  });

  it('容器小到不可行（低于有效下限）：如实返回 + clamped=true（禁静默返回 NaN/0）', () => {
    const plan = planKlinePanes({ containerPx: 150, subPaneCount: 1 });
    expect(plan.clamped).toBe(true);
    expect(plan.subPanePx).toBe(SUB_PANE_MIN_PX);
    expect(plan.candlePx).toBe(150 - KLINE_AXIS_PX - PANE_SEPARATOR_PX - SUB_PANE_MIN_PX);
    expect(Number.isFinite(plan.candlePx)).toBe(true);
  });

  it('无副图：主图吃满容器（减 x 轴）', () => {
    const plan = planKlinePanes({ containerPx: 300, subPaneCount: 0 });
    expect(plan.candlePx).toBe(300 - KLINE_AXIS_PX);
    expect(plan.subPanePx).toBe(0);
    expect(plan.subPaneTotalPx).toBe(0);
  });

  it('非法容器（NaN/负）：不产出 NaN，按 0 可用高如实披露', () => {
    const plan = planKlinePanes({ containerPx: Number.NaN, subPaneCount: 1 });
    expect(Number.isFinite(plan.candlePx)).toBe(true);
    expect(plan.candlePx).toBe(0);
    expect(plan.clamped).toBe(true);
  });
});

describe('D6-1/D6-4 坏数据净化（禁止把坏值当 0/NaN）', () => {
  const bounds = { min: 243, max: 600 };

  it('无记忆（null/undefined）⇒ 默认 520', () => {
    expect(resolveCardPx(null, bounds)).toBe(520);
    expect(resolveCardPx(undefined, bounds)).toBe(520);
  });

  it('不可解析（字符串/NaN/Infinity/对象）⇒ 默认 520', () => {
    expect(resolveCardPx('496', bounds)).toBe(520);
    expect(resolveCardPx(Number.NaN, bounds)).toBe(520);
    expect(resolveCardPx(Number.POSITIVE_INFINITY, bounds)).toBe(520);
    expect(resolveCardPx({}, bounds)).toBe(520);
  });

  it('越界（< 名义下限或超上界）⇒ 按计划 §4 用**默认 520** 再按 min/max 夹取；合法值取整', () => {
    expect(resolveCardPx(10, bounds)).toBe(520);
    expect(resolveCardPx(99999, bounds)).toBe(520);
    expect(resolveCardPx(420.4, bounds)).toBe(420);
    // 默认值本身被 bounds 夹取时（视口极小的 max / 有效下限高于 520）
    expect(resolveCardPx(null, { min: 243, max: 250 })).toBe(250);
    expect(resolveCardPx(null, { min: 600, max: 900 })).toBe(600);
  });

  it('clampCardPx 对非法入参返回 null（调用方回默认，不得落 0 高）', () => {
    expect(clampCardPx(Number.NaN, bounds)).toBeNull();
    expect(clampCardPx(Number.NaN, bounds)).not.toBe(0);
  });
});

describe('D6-7 记忆隔离（结果页独立 key；禁读写看板 key）', () => {
  it('key 常量 = 结果页独立 key，且与看板 key 不同名', () => {
    expect(CARD_HEIGHT_STORAGE_KEY).toBe('eestock.result.cardHeights.v1');
    expect(CARD_HEIGHT_STORAGE_KEY).not.toBe(DASHBOARD_LAYOUT_KEY);
    expect(DASHBOARD_LAYOUT_KEY).toBe('eestock.dashboard.layout.v1');
  });

  it('写入/读回（roundtrip）；写 null ⇒ 清除该卡记忆', () => {
    const { storage, map } = fakeStorage();
    writeCardHeight('kline', 420, storage);
    expect(readCardHeight('kline', storage)).toBe(420);
    expect(JSON.parse(map.get(CARD_HEIGHT_STORAGE_KEY) as string)).toEqual({ kline: 420 });
    writeCardHeight('kline', null, storage);
    expect(readCardHeight('kline', storage)).toBeNull();
  });

  it('只写结果页 key：绝不读写看板 key，也不写旧 key', () => {
    const { storage, calls, map } = fakeStorage({ [DASHBOARD_LAYOUT_KEY]: '{"grid":"2x3"}' });
    writeCardHeight('kline', 520, storage);
    writeCardHeight('equity', 380, storage);
    expect(calls.filter((c) => c.includes(DASHBOARD_LAYOUT_KEY))).toEqual([]);
    expect(calls.filter((c) => c.includes(LEGACY_RESULT_CHART_CONFIG_KEY) && c.startsWith('set:'))).toEqual([]);
    expect(map.get(DASHBOARD_LAYOUT_KEY)).toBe('{"grid":"2x3"}');
  });

  it('坏 JSON / 坏形状 / 越界记忆值一律不得变成 0/NaN', () => {
    const bad = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY]: '{oops' });
    expect(readCardHeight('kline', bad.storage)).toBeNull();
    const shape = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY]: '{"kline":{"px":300}}' });
    expect(readCardHeight('kline', shape.storage)).toBeNull();
    const nan = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY]: '{"kline":null}' });
    expect(readCardHeight('kline', nan.storage)).toBeNull();
    const neg = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY]: '{"kline":-3}' });
    expect(readCardHeight('kline', neg.storage)).toBeNull();
  });

  it('旧 key 迁移：旧结果页 key 里的 cardHeights 被采信并回写新 key（旧 key 内容不动）', () => {
    const legacy = JSON.stringify({
      indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
      cardHeights: { kline: 496, aggregate: null, slot: null, equity: null, position: null },
    });
    const { storage, map } = fakeStorage({ [LEGACY_RESULT_CHART_CONFIG_KEY]: legacy });
    expect(readCardHeight('kline', storage)).toBe(496);
    // 迁移后新 key 已就位（后续读取不再依赖旧 key）⇒ 独立 key 是唯一真源
    expect(JSON.parse(map.get(CARD_HEIGHT_STORAGE_KEY) as string)).toMatchObject({ kline: 496 });
    expect(map.get(LEGACY_RESULT_CHART_CONFIG_KEY)).toBe(legacy);
  });

  it('storage 缺位（隐私模式/无 localStorage）⇒ 读 null / 写不抛', () => {
    expect(readCardHeight('kline', null)).toBeNull();
    expect(() => writeCardHeight('kline', 520, null)).not.toThrow();
  });
});
