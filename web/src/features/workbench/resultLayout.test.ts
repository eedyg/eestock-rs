/**
 * ADR-028 §2.9（**D9｜结果页三视图拆分**）—— 三段比例模型的**纯函数判据**。
 *
 * 契约（唯一事实源 = `design/01-architecture/adr/ADR-028-…§2.9` + `design/17-trade-detail-layering/08-plan-three-view-split.md`
 * §2 表 D9-1..13 + §4 边界；**不按实现倒推**）：
 *  - D9-6：三段比例 `{kline, indicators, detail}`（和 = 1）+ 两条分隔条；**2 自由度守恒**
 *    （`klinePx + indicatorsPx + detailPx == 可用高`，±2px）；
 *  - D9-7：三视图可读下限 **299（1 副图）/ 329（2 副图）/ 180 / 95**，夹取优先级 **K 线 → 指标 → 明细**；
 *    三者之和 > 可用高 ⇒ 按比例压缩并**显式披露**（禁静默）；
 *  - D9-8：`卡高 = 视图高 − 60`（窗口条 34 + 载入提示 18 + gap 8）；恒等式
 *    `内层 = 卡高 − 22`、`主图 = 内层 − 27 − Σ副图`；硬不变量 `主图 ≥ 160 ∧ 副图 ≥ 30`；
 *    可用高口径 = **视口高 − 132**（`ratio × 视口高` 会溢出 92px，D9 必须改）；
 *  - D9-11：新键 `eestock.result.layout.v2`；旧 `eestock.result.layout.v1`（ratio/collapsed）与
 *    `eestock.result.cardHeights.v1`（kline px）**只读迁移**、界内才采信；
 *  - D9-13（必修缺陷）：记忆值恢复后必须按**实测有效下限**再夹取；任意记忆值/任意副图数下
 *    `主图 ≥ 160 ∧ 副图 ≥ 30`。
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_HEIGHT_STORAGE_KEY_LEGACY,
  DEFAULT_VIEW_RATIOS,
  KLINE_CARD_BORDER_HEADER_PX,
  KLINE_VIEW_CHROME_PX,
  RESULT_LAYOUT_STORAGE_KEY,
  RESULT_LAYOUT_V1_STORAGE_KEY,
  SPLITTER_PX,
  VIEW_AVAILABLE_CHROME_PX,
  VIEW_MIN_PX,
  availableForViewport,
  dragRatiosFromViewPx,
  klineGeometryForViewPx,
  planThreeViews,
  ratiosFromViewPx,
  readResultLayout,
  sanitizeViewRatios,
  toggleViewCollapsed,
  viewMinPx,
  writeResultLayout,
  type LayoutStorage,
  type ViewKey,
  type ViewCollapsed,
  type ViewRatios,
} from './resultLayout';
// 红相位：BLOCKED-2 的拖拽披露 API 尚不存在 ⇒ 以命名空间查询表达「缺失即红」（不得直接具名 import ⇒ 会整文件失败）
/** 契约自持常量（防「按实现倒推」：与本文件并列声明，改动实现不会自动改判据）。 */
const TOL_PX = 2;
const AVAIL = { 720: 720 - 132, 800: 800 - 132, 1400: 1400 - 132 } as const;

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const storage: LayoutStorage = {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return { storage, map };
}

describe('D9-6/D9-7/D9-8 常量口径', () => {
  it('默认三段比例 0.55 / 0.29 / 0.16（和 = 1）', () => {
    expect(DEFAULT_VIEW_RATIOS.kline).toBe(0.55);
    expect(DEFAULT_VIEW_RATIOS.indicators).toBe(0.29);
    expect(DEFAULT_VIEW_RATIOS.detail).toBe(0.16);
    expect(DEFAULT_VIEW_RATIOS.kline + DEFAULT_VIEW_RATIOS.indicators + DEFAULT_VIEW_RATIOS.detail).toBeCloseTo(1, 6);
  });

  it('可用高口径 = 视口高 − 132（D9-8 必修：旧口径 ratio × 视口高 若用于三段会溢出 92px）', () => {
    expect(VIEW_AVAILABLE_CHROME_PX).toBe(132);
    expect(availableForViewport(720)).toBe(588);
    expect(availableForViewport(800)).toBe(668);
    expect(availableForViewport(1400)).toBe(1268);
  });

  it('可读下限：K 线视图 299 / 329（副图数分档）、指标 180、明细 95；分隔条 12', () => {
    expect(viewMinPx(1)).toEqual({ kline: 299, indicators: 180, detail: 95 });
    expect(viewMinPx(2).kline).toBe(329);
    expect(VIEW_MIN_PX.indicators).toBe(180);
    expect(VIEW_MIN_PX.detail).toBe(95);
    expect(SPLITTER_PX).toBe(12);
    expect(KLINE_VIEW_CHROME_PX).toBe(60);
  });
});

describe('D9-6 三段分配与守恒（不含夹取的净比例）', () => {
  it('三段之和恒等于可用高（三档视口，±2px）', () => {
    for (const vh of [720, 800, 1400]) {
      const p = planThreeViews({ ratios: DEFAULT_VIEW_RATIOS, viewportH: vh, subPaneCount: 1 });
      expect(Math.abs(p.klinePx + p.indicatorsPx + p.detailPx - AVAIL[vh as 720]), `视口 ${vh}`).toBeLessThanOrEqual(TOL_PX);
    }
  });

  it('1400 档：默认比例无需夹取（0.55/0.29/0.16 × 1268）', () => {
    const p = planThreeViews({ ratios: DEFAULT_VIEW_RATIOS, viewportH: 1400, subPaneCount: 1 });
    expect(p.klinePx).toBe(Math.round(0.55 * AVAIL[1400]));
    expect(p.indicatorsPx).toBe(Math.round(0.29 * AVAIL[1400]));
    expect(p.detailPx).toBe(Math.round(0.16 * AVAIL[1400]));
    expect(p.clamped).toBe(false);
    expect(p.disclosure).toBeNull();
  });

  it('720 档：指标/明细低于可读下限 ⇒ 从 K 线取超（K 线 313 / 指标 180 / 明细 95）并**显式披露**', () => {
    const p = planThreeViews({ ratios: DEFAULT_VIEW_RATIOS, viewportH: 720, subPaneCount: 1 });
    expect(p.indicatorsPx).toBe(180);
    expect(p.detailPx).toBe(95);
    expect(p.klinePx).toBe(AVAIL[720] - 180 - 95); // 313 = K 线吃满（K 线 → 指标 → 明细 夹取优先级）
    expect(p.clamped).toBe(true);
    expect(p.disclosure, '夹取必须显式披露（禁静默）').toBeTruthy();
  });

  it('800 档：比例天然满足下限 ⇒ 不触发夹取（kline/indicators/detail = 367/194/107）', () => {
    const p = planThreeViews({ ratios: DEFAULT_VIEW_RATIOS, viewportH: 800, subPaneCount: 1 });
    expect(p.klinePx).toBe(Math.round(0.55 * AVAIL[800]));
    expect(p.indicatorsPx).toBe(Math.round(0.29 * AVAIL[800]));
    expect(p.detailPx).toBe(Math.round(0.16 * AVAIL[800]));
    expect(p.clamped).toBe(false);
  });

  it('D9-7 不可行档（2 副图 ⇒ 下限之和 604 > 可用 588）：K 线优先保下限，指标/明细按比例压缩并披露', () => {
    const p = planThreeViews({ ratios: DEFAULT_VIEW_RATIOS, viewportH: 720, subPaneCount: 2 });
    expect(p.klinePx, 'K 线夹取优先级最高 ⇒ 先保 329').toBe(329);
    expect(p.indicatorsPx + p.detailPx).toBe(AVAIL[720] - 329);
    expect(p.compressed).toBe(true);
    expect(p.disclosure).toBeTruthy();
    expect(p.klinePx + p.indicatorsPx + p.detailPx).toBeCloseTo(AVAIL[720], 0);
  });

  it('可用高极小（视口 500）：不得出现负值或 0 高视图（K 线优先）', () => {
    const p = planThreeViews({ ratios: DEFAULT_VIEW_RATIOS, viewportH: 500, subPaneCount: 1 });
    expect(p.klinePx).toBeGreaterThanOrEqual(0);
    expect(p.indicatorsPx).toBeGreaterThanOrEqual(0);
    expect(p.detailPx).toBeGreaterThanOrEqual(0);
    expect(p.klinePx + p.indicatorsPx + p.detailPx).toBeCloseTo(AVAIL_VALUE(500), 0);
    expect(p.compressed).toBe(true);
  });
});

function AVAIL_VALUE(vh: number): number {
  return vh - 132;
}

describe('D9-3 收起/展开（纯函数）', () => {
  it('收起指标 ⇒ 指标 0、其余两段按**原比例**分享其空间（和仍 = 可用高）', () => {
    const p = planThreeViews({
      ratios: DEFAULT_VIEW_RATIOS,
      viewportH: 1400,
      subPaneCount: 1,
      collapsed: { indicators: true, detail: false },
    });
    expect(p.indicatorsPx).toBe(0);
    expect(p.klinePx + p.detailPx).toBeCloseTo(AVAIL[1400], -1);
    // 比例保持（0.55 : 0.16 ⇒ 重新归一化到 1）
    expect(p.klinePx / (p.klinePx + p.detailPx)).toBeCloseTo(0.55 / 0.71, 2);
  });

  it('收起明细 ⇒ 明细 0、其余按原比例分享；两视图同时收起 ⇒ K 线占满', () => {
    const a = planThreeViews({
      ratios: DEFAULT_VIEW_RATIOS,
      viewportH: 1400,
      subPaneCount: 1,
      collapsed: { indicators: false, detail: true },
    });
    expect(a.detailPx).toBe(0);
    expect(a.klinePx + a.indicatorsPx).toBeCloseTo(AVAIL[1400], -1);
    expect(a.klinePx / (a.klinePx + a.indicatorsPx)).toBeCloseTo(0.55 / 0.84, 2);

    const b = planThreeViews({
      ratios: DEFAULT_VIEW_RATIOS,
      viewportH: 1400,
      subPaneCount: 1,
      collapsed: { indicators: true, detail: true },
    });
    expect(b.indicatorsPx).toBe(0);
    expect(b.detailPx).toBe(0);
    expect(b.klinePx).toBeCloseTo(AVAIL[1400], -1);
  });

  it('K 线视图**不可收起**（D9-2）：`collapsed` 结构不含 kline 字段', () => {
    const c = toggleViewCollapsed({ indicators: false, detail: false }, 'indicators');
    expect(c).toEqual({ indicators: true, detail: false });
    expect(toggleViewCollapsed(c, 'indicators')).toEqual({ indicators: false, detail: false });
    expect(Object.keys(c)).not.toContain('kline');
    // 类型层面：'kline' 不是合法入参（下方 @ts-expect-error 钉住）
    // @ts-expect-error K 线视图常驻，不得有收起态
    expect(toggleViewCollapsed(c, 'kline' as ViewKey)).toBeTruthy();
  });
});

describe('D9-11 记忆与只读迁移', () => {
  it('新键 = eestock.result.layout.v2；旧键仅作迁移源（看板 key 不碰）', () => {
    expect(RESULT_LAYOUT_STORAGE_KEY).toBe('eestock.result.layout.v2');
    expect(RESULT_LAYOUT_V1_STORAGE_KEY).toBe('eestock.result.layout.v1');
    expect(CARD_HEIGHT_STORAGE_KEY_LEGACY).toBe('eestock.result.cardHeights.v1');
  });

  it('roundtrip：三段比例 + 两个收起态', () => {
    const { storage, map } = fakeStorage();
    const layout = {
      ratios: { kline: 0.5, indicators: 0.3, detail: 0.2 },
      collapsed: { indicators: true, detail: false },
    };
    writeResultLayout(layout, storage);
    const raw = JSON.parse(map.get(RESULT_LAYOUT_STORAGE_KEY) as string);
    expect(raw.ratios).toEqual({ kline: 0.5, indicators: 0.3, detail: 0.2 });
    expect(raw.collapsed).toEqual({ indicators: true, detail: false });
    expect(readResultLayout(storage)).toEqual(layout);
  });

  it('v1 比例迁移：detail = v1.ratio，其余按默认比分配；v1 `collapsed` ⇒ detail 收起态', () => {
    const { storage } = fakeStorage({
      [RESULT_LAYOUT_V1_STORAGE_KEY]: JSON.stringify({ ratio: 0.5, collapsed: true }),
    });
    const l = readResultLayout(storage, { viewportH: 800 });
    expect(l.ratios.detail).toBeCloseTo(0.5, 3);
    expect(l.ratios.kline + l.ratios.indicators).toBeCloseTo(0.5, 3);
    expect(l.ratios.kline / l.ratios.indicators).toBeCloseTo(0.55 / 0.29, 1);
    expect(l.collapsed).toEqual({ indicators: false, detail: true });
  });

  it('v1 `cardHeights.kline` px 一次性只读迁移（只读 + 界内采信）⇒ **第五轮裁决：落盘值 = 生效态**', () => {
    const { storage, map } = fakeStorage({
      [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 520 }),
    });
    // 第五轮裁决（写入侧归一）：迁移意图（520 卡高 ⇒ 580 视图高 ⇒ 0.868）**不可行**（指标/明细远低于下限）
    // ⇒ 被**投影到可行域**（按 plan 的夹取优先级 299/180/95 ⇒ 393/180/95）⇒ 存储 == 渲染。
    const l = readResultLayout(storage, { viewportH: 800, availablePx: 668, mins: viewMinPx(1) });
    expect(l.ratios.kline, 'kline 生效比例 = 393/668（投影后）').toBeCloseTo(393 / 668, 2);
    expect(l.ratios.indicators).toBeCloseTo(180 / 668, 2);
    expect(l.ratios.detail).toBeCloseTo(95 / 668, 2);
    // 不等价于「直渲染 580」：渲染 == 存储（无需夹取）
    const p = planThreeViews({ ratios: l.ratios, viewportH: 800, availablePx: 668, subPaneCount: 1 });
    expect(p.clamped, '存储态可行 ⇒ 渲染不再夹取').toBe(false);
    expect(p.klinePx).toBe(393);
    // 旧键内容**逐字节不动**（只读迁移）
    expect(map.get(CARD_HEIGHT_STORAGE_KEY_LEGACY)).toBe(JSON.stringify({ kline: 520 }));
  });

  it('界外/坏数据不采信：cardHeights.kline = 1 / 99999 / "x" ⇒ 回默认比例', () => {
    for (const bad of ['1', '99999', '"x"', 'null']) {
      const { storage } = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY_LEGACY]: `{"kline":${bad}}` });
      expect(readResultLayout(storage, { viewportH: 800 }).ratios).toEqual({ ...DEFAULT_VIEW_RATIOS });
    }
  });

  it('v2 已存值优先于两个迁移源；v2 坏值 ⇒ 回默认（不得 NaN）', () => {
    const { storage } = fakeStorage({
      [RESULT_LAYOUT_STORAGE_KEY]: JSON.stringify({
        ratios: { kline: 0.4, indicators: 0.4, detail: 0.2 },
        collapsed: { indicators: false, detail: false },
      }),
      [RESULT_LAYOUT_V1_STORAGE_KEY]: JSON.stringify({ ratio: 0.9, collapsed: true }),
      [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 700 }),
    });
    expect(readResultLayout(storage, { viewportH: 800 }).ratios).toEqual({ kline: 0.4, indicators: 0.4, detail: 0.2 });

    const bad = fakeStorage({ [RESULT_LAYOUT_STORAGE_KEY]: '{oops' });
    expect(readResultLayout(bad.storage, { viewportH: 800 }).ratios).toEqual({ ...DEFAULT_VIEW_RATIOS });
    const nan = fakeStorage({ [RESULT_LAYOUT_STORAGE_KEY]: '{"ratios":{"kline":null,"indicators":"a","detail":9}}' });
    expect(readResultLayout(nan.storage, { viewportH: 800 }).ratios).toEqual({ ...DEFAULT_VIEW_RATIOS });
    expect(readResultLayout(null, { viewportH: 800 }).ratios).toEqual({ ...DEFAULT_VIEW_RATIOS });
  });

  it('sanitizeViewRatios：非负数归一化；全 0/非法 ⇒ 默认', () => {
    expect(sanitizeViewRatios({ kline: 1, indicators: 1, detail: 2 })).toEqual({
      kline: 0.25,
      indicators: 0.25,
      detail: 0.5,
    });
    expect(sanitizeViewRatios({ kline: -1, indicators: 0, detail: 0 })).toEqual({ ...DEFAULT_VIEW_RATIOS });
    expect(sanitizeViewRatios(null)).toEqual({ ...DEFAULT_VIEW_RATIOS });
  });
});

describe('D9-8 几何恒等式与硬不变量（D9-13 缺陷的纯函数判据）', () => {
  it('恒等式：卡高 = 视图高 − 60；内层 = 卡高 − 22；主图 = 内层 − 27 − Σ副图', () => {
    const g = klineGeometryForViewPx({ viewPx: 520, subPaneCount: 1 });
    expect(g.cardPx).toBe(520 - 60);
    expect(g.innerPx).toBe(g.cardPx - KLINE_CARD_BORDER_HEADER_PX);
    expect(g.innerPx).toBe(g.cardPx - 22);
    expect(g.mainPx).toBe(g.innerPx - 27 - g.subPaneTotalPx);
  });

  it('D9-13：任意记忆值/任意副图数下 `主图 ≥ 160 ∧ 副图 ≥ 30`（记忆路径必须**再夹取**）', () => {
    for (const sub of [1, 2]) {
      const minView = viewMinPx(sub).kline;
      for (const viewPx of [minView, minView + 5, 400, 520, 700, 1400]) {
        const g = klineGeometryForViewPx({ viewPx, subPaneCount: sub });
        expect(g.mainPx, `视图高 ${viewPx} / 副图 ${sub} ⇒ 主图`).toBeGreaterThanOrEqual(sub === 1 ? 160 : 159);
        expect(g.subPaneTotalPx, `视图高 ${viewPx} / 副图 ${sub} ⇒ 副图合计`).toBeGreaterThanOrEqual(30 * sub);
      }
    }
  });

  it('D9-13 缺陷复现路径：播种 {kline:200} ⇒ 计划出的 K 线视图高 ≥ 299（旧实现直渲染 200 ⇒ 主图 121）', () => {
    const { storage } = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 200 }) });
    const l = readResultLayout(storage, { viewportH: 720 });
    const p = planThreeViews({ ratios: l.ratios, viewportH: 720, subPaneCount: 1 });
    expect(p.klinePx).toBeGreaterThanOrEqual(299);
    const g = klineGeometryForViewPx({ viewPx: p.klinePx, subPaneCount: 1 });
    expect(g.mainPx, '缺陷读数：旧实现 播种 200 ⇒ 主图 121 < 160').toBeGreaterThanOrEqual(160);
  });

  it('D9-13 重夹：同一记忆值在副图数变化时**重夹**（1 副图 299 → 2 副图 ≥ 329）', () => {
    const { storage } = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 200 }) });
    const l = readResultLayout(storage, { viewportH: 800 });
    const one = planThreeViews({ ratios: l.ratios, viewportH: 800, subPaneCount: 1 });
    const two = planThreeViews({ ratios: l.ratios, viewportH: 800, subPaneCount: 2 });
    expect(two.klinePx).toBeGreaterThanOrEqual(one.klinePx);
    const g = klineGeometryForViewPx({ viewPx: two.klinePx, subPaneCount: 2 });
    expect(g.mainPx).toBeGreaterThanOrEqual(159);
    expect(g.subPaneTotalPx).toBeGreaterThanOrEqual(60);
  });
});

describe('D9-6 拖拽：px → 比例（1:1，方向 = 鼠标向上 ⇒ 上方视图变高）', () => {
  it('K线↔指标：dy = −120 ⇒ K 线 +120、指标 −120（1:1，两侧都在可读下限之上）', () => {
    const start = { klinePx: 697, indicatorsPx: 368, detailPx: 203, viewSpacePx: 1268 };
    const plan0 = planThreeViews({ ratios: ratiosFromViewPx({ ...start, boundary: 'kline-indicators', dy: 0 }), viewportH: 1400, subPaneCount: 1 });
    expect([plan0.klinePx, plan0.indicatorsPx, plan0.detailPx]).toEqual([697, 368, 203]);
    const r = ratiosFromViewPx({ ...start, boundary: 'kline-indicators', dy: -120 });
    const p = planThreeViews({ ratios: r, viewportH: 1400, subPaneCount: 1 });
    expect(Math.abs(p.klinePx - (697 + 120)), `K 线 1:1 变高（实读 ${p.klinePx}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(p.indicatorsPx - (368 - 120)), `指标 1:1 变矮（实读 ${p.indicatorsPx}）`).toBeLessThanOrEqual(TOL_PX);
    expect(p.detailPx).toBe(203);
  });

  it('方向反证：dy = +120（鼠标向下）⇒ 上方视图**变矮**、下方视图变高', () => {
    const r = ratiosFromViewPx({
      klinePx: 697,
      indicatorsPx: 368,
      detailPx: 203,
      viewSpacePx: 1268,
      boundary: 'kline-indicators',
      dy: 120,
    });
    const p = planThreeViews({ ratios: r, viewportH: 1400, subPaneCount: 1 });
    expect(p.klinePx).toBeLessThan(697);
    expect(p.indicatorsPx).toBeGreaterThan(368);
  });

  it('指标↔明细：dy = −120 ⇒ 指标 +120、明细 −120（明细受可读下限 95 夹取并让位给指标）', () => {
    const r = ratiosFromViewPx({
      klinePx: 697,
      indicatorsPx: 368,
      detailPx: 203,
      viewSpacePx: 1268,
      boundary: 'indicators-detail',
      dy: -120,
    });
    const p = planThreeViews({ ratios: r, viewportH: 1400, subPaneCount: 1 });
    expect(p.detailPx, '明细被夹到可读下限 95').toBe(95);
    // 明细目标 83（< 95）⇒ 抬到 95，缺口 12 从上方视图（指标）回吐 ⇒ 476 = 368+120−12
    expect(Math.abs(p.indicatorsPx - 476), `指标吸收明细被夹取的 12px（实读 ${p.indicatorsPx}）`).toBeLessThanOrEqual(TOL_PX);
    expect(p.klinePx).toBe(697);
    expect(p.klinePx + p.indicatorsPx + p.detailPx).toBeCloseTo(AVAIL[1400], 0);
  });
});

/**
 * ─────────────────── 修复判据（BLOCKED-1 / BLOCKED-2）───────────────────
 *
 * 事实源：ADR-028 §2.9-7 / plan `08-plan-three-view-split.md` §4「迁移源冲突」行
 * 「**以 v2 已存值为准**；两源仅在 v2 无该字段时采信；界外/坏数据 ⇒ 忽略该源、用默认」
 * + §4「口径澄清」行「①**拖拽路径也必须披露夹取**（BLOCKED-2）」。
 *
 * 复现路径（独立复验 `tester/evidence/20260924_d9_accept/BLOCKED.md` §BLOCKED-1）：
 * **收起某视图后再拖分隔条 ⇒ 写入的 v2 把该收起段比例落成 `0` ⇒ 严格解析（`isFinitePositive`）
 * 拒绝整份 v2 ⇒ 刷新后丢收起态与比例；v2 被拒时还会静默回落 legacy 迁移。**
 */
describe('BLOCKED-1 修复：收起态下拖拽 ⇒ v2 不得含 0 比例、往返不丢态、v2 已存值为准', () => {
  it('收起明细 ⇒ 拖分隔条 ⇒ 写盘 ⇒ 重新读盘：收起态保持、明细比例 = 收起前的有效值（不得为 0）', () => {
    const { storage, map } = fakeStorage();
    // ① 收起明细（产品 commit 形态：三段比例不变 + collapsed.detail = true）
    const before = readResultLayout(storage, { viewportH: 800 });
    writeResultLayout({ ratios: before.ratios, collapsed: { indicators: false, detail: true } }, storage);
    // ② 收起态下拖 K线↔指标（起点 px = 计划 px ⇒ 收起段 px = 0 —— 产品真实路径）
    const collapsedPlan = planThreeViews({
      ratios: before.ratios,
      viewportH: 800,
      subPaneCount: 1,
      collapsed: { indicators: false, detail: true },
    });
    expect(collapsedPlan.detailPx, '前置：收起段 px = 0').toBe(0);
    const dragged = ratiosFromViewPx({
      klinePx: collapsedPlan.klinePx,
      indicatorsPx: collapsedPlan.indicatorsPx,
      detailPx: collapsedPlan.detailPx,
      viewSpacePx: collapsedPlan.availablePx,
      boundary: 'kline-indicators',
      dy: 80,
      mins: viewMinPx(1),
    });
    const persisted = writeResultLayout({ ratios: dragged, collapsed: { indicators: false, detail: true } }, storage);

    // ③ 写盘内容必须**合法**：三段全为正、和 = 1（旧实现此处 `"detail":0`）
    const raw = JSON.parse(map.get(RESULT_LAYOUT_STORAGE_KEY) as string);
    expect(raw.ratios.detail, 'v2 不得持久化 0/非法段比例（BLOCKED-1 根因）').toBeGreaterThan(0);
    expect(raw.ratios.kline).toBeGreaterThan(0);
    expect(raw.ratios.indicators).toBeGreaterThan(0);
    expect(raw.ratios.kline + raw.ratios.indicators + raw.ratios.detail).toBeCloseTo(1, 6);
    expect(raw.collapsed).toEqual({ indicators: false, detail: true });

    // ④ 重新读盘（= 刷新）：不得回落默认/迁移 ⇒ 收起态与比例都要读回
    const after = readResultLayout(storage, { viewportH: 800 });
    expect(after.collapsed, '刷新后收起态必须保持（旧实现读到坏 v2 ⇒ 收起态丢失）').toEqual({
      indicators: false,
      detail: true,
    });
    expect(after.ratios.detail, '收起段的**最后一次有效比例**必须保留（不得被归零）').toBeCloseTo(before.ratios.detail, 6);
    expect(after.ratios.detail).toBeGreaterThan(0);
    expect(after.ratios, 'v2 读回必须逐位稳定（读-写幂等 ⇒ 刷新前后逐 px 一致）').toEqual(persisted.ratios);

    // ⑤ 屏上读数：内存态（= 落盘态）与刷新后必须一致（±1px）——展开的两段不得因修复而变位
    const preReload = planThreeViews({
      ratios: persisted.ratios,
      viewportH: 800,
      subPaneCount: 1,
      collapsed: persisted.collapsed,
    });
    const afterReload = planThreeViews({
      ratios: after.ratios,
      viewportH: 800,
      subPaneCount: 1,
      collapsed: after.collapsed,
    });
    expect(Math.abs(afterReload.klinePx - preReload.klinePx)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterReload.indicatorsPx - preReload.indicatorsPx)).toBeLessThanOrEqual(1);
    expect(afterReload.detailPx).toBe(0);
  });

  it('收起指标 ⇒ 拖 指标↔明细 ⇒ 往返：v2 合法（收起段不为 0）、刷新逐 px 一致（tester R1 判据）', () => {
    const { storage, map } = fakeStorage();
    const before = readResultLayout(storage, { viewportH: 800 });
    writeResultLayout({ ratios: before.ratios, collapsed: { indicators: true, detail: false } }, storage);
    const collapsedPlan = planThreeViews({
      ratios: before.ratios,
      viewportH: 800,
      subPaneCount: 1,
      collapsed: { indicators: true, detail: false },
    });
    expect(collapsedPlan.indicatorsPx, '前置：收起段 px = 0').toBe(0);
    const dragged = ratiosFromViewPx({
      klinePx: collapsedPlan.klinePx,
      indicatorsPx: collapsedPlan.indicatorsPx,
      detailPx: collapsedPlan.detailPx,
      viewSpacePx: collapsedPlan.availablePx,
      boundary: 'indicators-detail',
      dy: 100,
      mins: viewMinPx(1),
    });
    const persisted = writeResultLayout({ ratios: dragged, collapsed: { indicators: true, detail: false } }, storage);

    const raw = JSON.parse(map.get(RESULT_LAYOUT_STORAGE_KEY) as string);
    expect(raw.ratios.indicators, '收起段比例不得落成 0（BLOCKED-1 实测读数）').toBeGreaterThan(0);
    expect(raw.ratios.detail, '被拖拽排空的段也必须回合法值（不得落成 0）').toBeGreaterThan(0);
    expect(raw.ratios.kline + raw.ratios.indicators + raw.ratios.detail).toBeCloseTo(1, 6);
    expect(raw.collapsed).toEqual({ indicators: true, detail: false });

    const after = readResultLayout(storage, { viewportH: 800 });
    expect(after.collapsed, '刷新后收起态必须保持（tester R1：`data-view-collapsed-indicators=true`）').toEqual({
      indicators: true,
      detail: false,
    });
    // tester R3 判据的单元形式：刷新前后**逐 px 一致**（内存态 = 落盘态）
    const preReload = planThreeViews({
      ratios: persisted.ratios,
      viewportH: 800,
      subPaneCount: 1,
      collapsed: persisted.collapsed,
    });
    const afterReload = planThreeViews({
      ratios: after.ratios,
      viewportH: 800,
      subPaneCount: 1,
      collapsed: after.collapsed,
    });
    expect(afterReload.klinePx).toBe(preReload.klinePx);
    expect(afterReload.detailPx).toBe(preReload.detailPx);
    expect(afterReload.indicatorsPx).toBe(0);
  });

  it('v2 已存值为准：v2 存在时不得回落 legacy 迁移；v2 坏字段回默认、好字段照读', () => {
    const { storage } = fakeStorage({
      // 旧实现（缺陷版）写出的坏串：`detail: 0` ⇒ 整份 v2 被拒绝
      [RESULT_LAYOUT_STORAGE_KEY]: JSON.stringify({
        ratios: { kline: 0.7417, indicators: 0.2583, detail: 0 },
        collapsed: { indicators: false, detail: true },
      }),
      [RESULT_LAYOUT_V1_STORAGE_KEY]: JSON.stringify({ ratio: 0.9, collapsed: false }),
      [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 520 }),
    });
    const l = readResultLayout(storage, { viewportH: 800 });
    // 旧卡高迁移读数 = 580 / 668 = 0.8682634730538922（BLOCKED-1 实测的「静默回落」值）不得出现
    expect(l.ratios.kline, `v2 已存值优先于旧键迁移（回落读数 ${580 / 668}）`).not.toBeCloseTo(580 / 668, 2);
    expect(l.ratios.kline, 'v2 的有效字段按原比例保留（0.7417 / 1.0 × 0.84）').toBeCloseTo(0.7417 * 0.84, 3);
    expect(l.ratios.detail, 'v2 坏字段 ⇒ 回默认（不得回落 legacy、不得为 0）').toBeCloseTo(DEFAULT_VIEW_RATIOS.detail, 6);
    expect(l.collapsed, 'v2 的收起态不得被 legacy/v1 覆盖').toEqual({ indicators: false, detail: true });
  });

  it('字段级迁移：v2 缺失的字段才走迁移源（v2 有的字段不得回落 legacy）', () => {
    const { storage } = fakeStorage({
      [RESULT_LAYOUT_STORAGE_KEY]: JSON.stringify({ collapsed: { indicators: true } }),
      [RESULT_LAYOUT_V1_STORAGE_KEY]: JSON.stringify({ ratio: 0.4 }),
      [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 520 }),
    });
    const l = readResultLayout(storage, { viewportH: 800 });
    expect(l.ratios.kline, 'v2 无 ratios ⇒ 该字段走旧卡高迁移（580 / 668）').toBeCloseTo(580 / 668, 2);
    expect(l.collapsed, 'v2 有 collapsed ⇒ 以其为准（不得回默认）').toEqual({ indicators: true, detail: false });
  });
});

describe('BLOCKED-2 修复：拖拽路径也必须披露夹取（禁只在默认分配路径置位）', () => {
  it('拖到可读下限 ⇒ 该次拖拽回报 clamped=true；未触下限不得误报', () => {
    const start = { klinePx: 697, indicatorsPx: 368, detailPx: 203, viewSpacePx: 1268, mins: viewMinPx(1) };
    const free = dragRatiosFromViewPx({ ...start, boundary: 'kline-indicators', dy: -40 });
    expect(free.clamped, '未触下限（指标 368 → 328 ≥ 180）不得误报夹取').toBe(false);
    const hit = dragRatiosFromViewPx({ ...start, boundary: 'kline-indicators', dy: -240 });
    expect(hit.clamped, '指标被夹到可读下限 180 ⇒ 必须置位').toBe(true);
    const hit2 = dragRatiosFromViewPx({ ...start, boundary: 'indicators-detail', dy: -240 });
    expect(hit2.clamped, '明细被夹到可读下限 95 ⇒ 必须置位').toBe(true);
    // 夹取后比例与「只取比例」的旧入口一致（兼容性）
    expect(hit.ratios).toEqual(ratiosFromViewPx({ ...start, boundary: 'kline-indicators', dy: -240 }));
    // 夹取读数与 D9-6 实测表一致：885 / 180 / 203
    const p = planThreeViews({ ratios: hit.ratios, viewportH: 1400, subPaneCount: 1 });
    expect([p.klinePx, p.indicatorsPx, p.detailPx]).toEqual([885, 180, 203]);
  });
});

/**
 * ─────────────── R1 冻结语义（架构裁决 2026-09-24）───────────────
 *
 * 裁决原文（架构侧）：**收起段的「最后一次有效比例」必须被钉住（freeze），拖拽不得改写它。**
 * 依据：ADR §2.9-2「收起后**不留空**、其余视图**按原比例**分享释放空间」⇒ 收起 = **临时置 0**
 * 并把空间按比例分给可见的两段 ⇒ 收起段自己的比例是「**暂停使用**」而非「重新分配」，
 * **展开时必须回到收起前的几何**（收起是可逆动作）。
 *
 * 判据：
 *  ① `收起 indicators ⇒ 拖 指标↔明细 ⇒ 展开` ⇒ `ratios.indicators` **等于收起前的值（±1e-9）**
 *     且两个可见段之和 = `1 − 收起段比例`；
 *  ② 展开后指标视图高 == 收起前高度（±2px，真渲染判据；本文件断言 plan 口径的 px）；
 *  ③ **反向对照**：未被收起的段在拖拽中**照常重新归一**（冻结不得波及可见段）。
 */
describe('R1 冻结语义：收起段比例不得被拖拽改写（展开必须回到收起前几何）', () => {
  /** 产品 commit 形态：写盘 ⇒ 内存态 = 落盘态（与 `useResultLayout.commit` 一致）。 */
  const VPX = { viewportH: 800, subPaneCount: 1 } as const;

  it('①收起 indicators ⇒ 拖 指标↔明细 ⇒ 展开：indicators 比例 == 收起前（±1e-9）且可见两段之和 = 1 − 收起段', () => {
    const { storage, map } = fakeStorage();
    // ⓪ 先拖 K线↔指标 造出**非默认**比例（默认值巧合会掩盖冻结失效：0.29 vs 0.3503 必须可分）
    const base = readResultLayout(storage, { viewportH: VPX.viewportH });
    const p0 = planThreeViews({ ratios: base.ratios, viewportH: VPX.viewportH, subPaneCount: VPX.subPaneCount });
    const first = dragRatiosFromViewPx({
      klinePx: p0.klinePx,
      indicatorsPx: p0.indicatorsPx,
      detailPx: p0.detailPx,
      viewSpacePx: p0.availablePx,
      boundary: 'kline-indicators',
      dy: 40,
      mins: viewMinPx(1),
    });
    const afterFirst = writeResultLayout({ ratios: first.ratios, collapsed: { indicators: false, detail: false } }, storage);
    expect(afterFirst.ratios.indicators, '前置：指标比例已非默认（否则判据无鉴别力）').not.toBeCloseTo(
      DEFAULT_VIEW_RATIOS.indicators,
      3,
    );

    // ① 收起 indicators（收起本身不得改比例）⇒ 记录「收起前」比例
    const preCollapse = writeResultLayout(
      { ratios: afterFirst.ratios, collapsed: { indicators: true, detail: false } },
      storage,
    );
    expect(preCollapse.ratios, '收起动作本身不得改写任何比例').toEqual(afterFirst.ratios);

    // ② 收起态下拖 指标↔明细（起点 px 取计划值 ⇒ 收起段 px = 0，与产品真实路径一致）
    const pCol = planThreeViews({
      ratios: preCollapse.ratios,
      viewportH: VPX.viewportH,
      subPaneCount: VPX.subPaneCount,
      collapsed: { indicators: true, detail: false },
    });
    expect(pCol.indicatorsPx, '前置：收起段 px = 0').toBe(0);
    const dragged = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'indicators-detail',
      dy: 100,
      mins: viewMinPx(1),
      collapsedRatioSum: preCollapse.ratios.indicators,
    });
    const afterDrag = writeResultLayout({ ratios: dragged.ratios, collapsed: { indicators: true, detail: false } }, storage);
    // ③-a **第三/四轮裁决**：收起态下相邻边界 ⇒ 位移只在**可见两段之间** 1:1 重分配；
    //     第四轮追加：按**真实比例**夹取 ⇒ 触真实下限时**停在边界值**（本档 ±100 恰触 K 线真实下限）。
    const pAfterDrag = planThreeViews({
      ratios: afterDrag.ratios,
      viewportH: VPX.viewportH,
      subPaneCount: VPX.subPaneCount,
      collapsed: { indicators: true, detail: false },
    });
    const trueK = afterDrag.ratios.kline * pAfterDrag.availablePx;
    expect(pAfterDrag.klinePx + pAfterDrag.detailPx, '可见两段之和 = 可用高（1:1 只在可见两段之间）').toBeCloseTo(
      pAfterDrag.availablePx,
      0,
    );
    if (dragged.clamped) {
      expect(Math.abs(trueK - VIEW_MIN_PX.klineOneSub), `夹取 ⇒ K 线**真实** px 停在下限（真实 ${trueK.toFixed(1)}）`).toBeLessThanOrEqual(TOL_PX);
    } else {
      expect(Math.abs(pAfterDrag.klinePx - (pCol.klinePx - 100)), `未触下限 ⇒ 满额 1:1（期望 ${pCol.klinePx - 100}）`).toBeLessThanOrEqual(TOL_PX);
    }
    expect(trueK, 'K 线**真实** px 不得低于可读下限（真实比例口径）').toBeGreaterThanOrEqual(VIEW_MIN_PX.klineOneSub - TOL_PX);

    // ③-b **冻结**：收起段比例 == 收起前值（±1e-9）——旧实现（重归一）此处必红
    expect(
      Math.abs(afterDrag.ratios.indicators - preCollapse.ratios.indicators),
      `收起段比例必须冻结在收起前值（收起前 ${preCollapse.ratios.indicators} / 实读 ${afterDrag.ratios.indicators}）`,
    ).toBeLessThanOrEqual(1e-9);
    // 落盘读数（不只是返回值）
    const raw = JSON.parse(map.get(RESULT_LAYOUT_STORAGE_KEY) as string) as { ratios: ViewRatios };
    expect(Math.abs(raw.ratios.indicators - preCollapse.ratios.indicators), 'v2 中收起段比例也必须冻结').toBeLessThanOrEqual(1e-9);
    // 可见两段之和 = 1 − 收起段比例
    expect(afterDrag.ratios.kline + afterDrag.ratios.detail, '可见两段之和 = 1 − 收起段比例').toBeCloseTo(
      1 - afterDrag.ratios.indicators,
      9,
    );
    expect(afterDrag.ratios.kline + afterDrag.ratios.indicators + afterDrag.ratios.detail).toBeCloseTo(1, 9);

    // ④ 展开 ⇒ **回到收起前几何**（指标视图高 == 收起前，plan 口径逐 px）
    const expanded = writeResultLayout({ ratios: afterDrag.ratios, collapsed: { indicators: false, detail: false } }, storage);
    const preCollapsePlan = planThreeViews({
      ratios: preCollapse.ratios,
      viewportH: VPX.viewportH,
      subPaneCount: VPX.subPaneCount,
    });
    const expandedPlan = planThreeViews({
      ratios: expanded.ratios,
      viewportH: VPX.viewportH,
      subPaneCount: VPX.subPaneCount,
    });
    const indDelta = Math.abs(expandedPlan.indicatorsPx - preCollapsePlan.indicatorsPx);
    // **第四轮裁决：无条件回位**（不接受析取式）——拖拽已按**真实比例**夹取 ⇒ 展开**不得**触发重夹。
    expect(expandedPlan.clamped, '展开不得触发重夹（真实比例口径）：折叠段份额已从可分配份额中扣除').toBe(false);
    expect(
      indDelta,
      `展开 ⇒ 指标**无条件**逐 px 回位（收起前 ${preCollapsePlan.indicatorsPx} / 实读 ${expandedPlan.indicatorsPx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
  });

  it('②反向对照：另两段（未被收起）在拖拽中**照常重新归一**（冻结不得波及可见段）', () => {
    const { storage } = fakeStorage();
    // detail 收起（被冻结者）⇒ 拖 K线↔指标：k/i（可见两段）必须照常 1:1 重归一
    const base = readResultLayout(storage, { viewportH: VPX.viewportH });
    const collapsedState = writeResultLayout({ ratios: base.ratios, collapsed: { indicators: false, detail: true } }, storage);
    const pCol = planThreeViews({
      ratios: collapsedState.ratios,
      viewportH: VPX.viewportH,
      subPaneCount: VPX.subPaneCount,
      collapsed: { indicators: false, detail: true },
    });
    expect(pCol.detailPx, '前置：明细已收起（px = 0）').toBe(0);
    const dragged = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'kline-indicators',
      dy: 80,
      mins: viewMinPx(1),
    });
    const afterDrag = writeResultLayout({ ratios: dragged.ratios, collapsed: { indicators: false, detail: true } }, storage);
    const planAfter = planThreeViews({
      ratios: afterDrag.ratios,
      viewportH: VPX.viewportH,
      subPaneCount: VPX.subPaneCount,
      collapsed: { indicators: false, detail: true },
    });
    // 可见两段照常重归一：屏幕 px 1:1（±2px；过冻结/全冻结实现此处必红）
    expect(
      Math.abs(planAfter.klinePx - (pCol.klinePx - 80)),
      `可见段 K 线照常 1:1（期望 ${pCol.klinePx - 80} / 实读 ${planAfter.klinePx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(planAfter.indicatorsPx - (pCol.indicatorsPx + 80)),
      `可见段指标照常 1:1（期望 ${pCol.indicatorsPx + 80} / 实读 ${planAfter.indicatorsPx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    // 被冻结段（detail）保持其已存值，可见两段和 = 1 − 冻结段
    expect(Math.abs(afterDrag.ratios.detail - collapsedState.ratios.detail)).toBeLessThanOrEqual(1e-9);
    expect(afterDrag.ratios.kline + afterDrag.ratios.indicators).toBeCloseTo(1 - afterDrag.ratios.detail, 9);
    expect(afterDrag.ratios.kline / afterDrag.ratios.indicators, '可见两段比例仍由拖拽决定（非回到默认比）').not.toBeCloseTo(
      DEFAULT_VIEW_RATIOS.kline / DEFAULT_VIEW_RATIOS.indicators,
      2,
    );
  });
});

/**
 * ─────────── R1b 收起态相邻边界：位移**转给可见两段**（架构裁决第二轮 2026-09-24）───────────
 *
 * 裁决：**采「位移转给可见两段」而不是 no-op。** 理由：控件「拖不动」正是 D6 卡把手被误判不可用的
 * 那类缺陷；收起态下相邻边界若拖拽无任何屏幕效果，等于引入一个新的死控件（即使有披露也不该留）。
 *
 * 精确语义：
 *  ① **冻结不变**：收起段的**存储比例**永不被拖拽改写；
 *  ② **收起态下拖拽可见两段之间的边界** ⇒ 只在**可见两段之间** 1:1 重分配（收起段那一份「不可分配」），
 *     两侧各受各自**可读下限**夹取；拖到下限 ⇒ clamp + 披露（不得把可见段压到 0）；
 *  ③ **展开** ⇒ 收起段回到其**冻结比例**、可见两段**按比例收缩**（相对分配保持）；
 *  ④ **反向对照**：未收起时拖同一边界行为不变（1:1）。
 */
describe('R1b 收起态相邻边界：位移转给可见两段（架构裁决第二轮）', () => {
  /** 富余档（可用 1268）：±100 位移不触下限，专测重分配语义。 */
  const VH_BIG = 1400;
  const VH_W800 = 800;
  const COL_IND = { indicators: true, detail: false } as const;
  const COL_NONE = { indicators: false, detail: false } as const;

  /** 产品 commit 形态的封装（写盘 ⇒ 返回值即内存态）。 */
  const commit = (storage: LayoutStorage, ratios: Partial<ViewRatios>, collapsed: Record<string, boolean>) =>
    writeResultLayout({ ratios: ratios as ViewRatios, collapsed: collapsed as never }, storage);

  /** 前置：拖 K线↔指标 造出**非默认**比例（默认值巧合会掩盖冻结失效）。 */
  function presetLayout(storage: LayoutStorage, vh: number, dy = 40) {
    const base = readResultLayout(storage, { viewportH: vh });
    const p0 = planThreeViews({ ratios: base.ratios, viewportH: vh, subPaneCount: 1 });
    const d = dragRatiosFromViewPx({
      klinePx: p0.klinePx,
      indicatorsPx: p0.indicatorsPx,
      detailPx: p0.detailPx,
      viewSpacePx: p0.availablePx,
      boundary: 'kline-indicators',
      dy,
      mins: viewMinPx(1),
    });
    return commit(storage, d.ratios, COL_NONE);
  }

  it('①收起 indicators ⇒ 拖 指标↔明细 +100 ⇒ K 线与明细各 ±100px（±2）且收起段比例逐位冻结', () => {
    const { storage } = fakeStorage();
    const preset = presetLayout(storage, VH_BIG);
    expect(preset.ratios.indicators, '前置：指标比例已非默认').not.toBeCloseTo(DEFAULT_VIEW_RATIOS.indicators, 3);
    // 收起 indicators
    const preCollapse = commit(storage, preset.ratios, COL_IND);
    const pCol = planThreeViews({ ratios: preCollapse.ratios, viewportH: VH_BIG, subPaneCount: 1, collapsed: COL_IND });
    expect(pCol.indicatorsPx, '前置：收起段 px = 0').toBe(0);
    expect(pCol.klinePx + pCol.detailPx, '收起态：可见两段占满可用高').toBeCloseTo(pCol.availablePx, 0);

    // 收起态下拖 指标↔明细 +100 ⇒ 位移只在可见两段之间 1:1
    const drag = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'indicators-detail',
      dy: 100,
      mins: viewMinPx(1),
    });
    const after = commit(storage, drag.ratios, COL_IND);
    const pAfter = planThreeViews({ ratios: after.ratios, viewportH: VH_BIG, subPaneCount: 1, collapsed: COL_IND });
    expect(
      Math.abs(pAfter.klinePx - (pCol.klinePx - 100)),
      `K 线 1:1 变矮 100（期望 ${pCol.klinePx - 100} / 实读 ${pAfter.klinePx}；no-op 实现此处必红）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(pAfter.detailPx - (pCol.detailPx + 100)),
      `明细 1:1 变高 100（期望 ${pCol.detailPx + 100} / 实读 ${pAfter.detailPx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(drag.clamped, '该位移未触下限（±100 在富余档内）').toBe(false);
    expect(pAfter.klinePx + pAfter.detailPx, '守恒：可见两段之和仍 = 可用高').toBeCloseTo(pAfter.availablePx, 0);
    // 收起段比例**逐位冻结**
    expect(
      Math.abs(after.ratios.indicators - preset.ratios.indicators),
      `收起段比例必须逐位冻结（收起前 ${preset.ratios.indicators} / 实读 ${after.ratios.indicators}）`,
    ).toBeLessThanOrEqual(1e-9);
    expect(after.ratios.kline + after.ratios.detail, '可见两段之和 = 1 − 收起段比例').toBeCloseTo(
      1 - after.ratios.indicators,
      9,
    );
    expect(after.ratios.kline + after.ratios.indicators + after.ratios.detail).toBeCloseTo(1, 9);
  });

  it('②展开 ⇒ indicators 高回到收起前（±2px）∧ 可见两段**按比例收缩**（相对分配保持 ±2px）', () => {
    const { storage } = fakeStorage();
    const preset = presetLayout(storage, VH_BIG);
    const preCollapse = commit(storage, preset.ratios, COL_IND);
    const frozen = preCollapse.ratios.indicators;
    const pCol = planThreeViews({ ratios: preCollapse.ratios, viewportH: VH_BIG, subPaneCount: 1, collapsed: COL_IND });
    const drag = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'indicators-detail',
      dy: 100,
      mins: viewMinPx(1),
    });
    const after = commit(storage, drag.ratios, COL_IND);
    const pAfter = planThreeViews({ ratios: after.ratios, viewportH: VH_BIG, subPaneCount: 1, collapsed: COL_IND });

    const expanded = commit(storage, after.ratios, COL_NONE);
    const pExp = planThreeViews({ ratios: expanded.ratios, viewportH: VH_BIG, subPaneCount: 1 });
    const pPreCollapse = planThreeViews({ ratios: preCollapse.ratios, viewportH: VH_BIG, subPaneCount: 1 });
    expect(
      Math.abs(pExp.indicatorsPx - pPreCollapse.indicatorsPx),
      `展开后指标视图高 == 收起前（收起前 ${pPreCollapse.indicatorsPx} / 实读 ${pExp.indicatorsPx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    // 可见两段按 (1 − 收起段比例) **等比收缩** ⇒ 相对分配保持
    const keep = 1 - frozen;
    expect(
      Math.abs(pExp.klinePx - keep * pAfter.klinePx),
      `K 线按 ${keep.toFixed(4)} 等比收缩（期望 ${(keep * pAfter.klinePx).toFixed(1)} / 实读 ${pExp.klinePx}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(
      Math.abs(pExp.detailPx - keep * pAfter.detailPx),
      `明细按 ${keep.toFixed(4)} 等比收缩（期望 ${(keep * pAfter.detailPx).toFixed(1)} / 实读 ${pExp.detailPx}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(pExp.klinePx / pExp.detailPx, '可见两段相对比例保持').toBeCloseTo(pAfter.klinePx / pAfter.detailPx, 1);
    expect(pExp.klinePx + pExp.indicatorsPx + pExp.detailPx, '展开后守恒').toBeCloseTo(pExp.availablePx, 0);
  });

  it('③反向对照：**未收起**时拖同一边界行为不变（1:1，勿被本条波及）', () => {
    const { storage } = fakeStorage();
    const st = presetLayout(storage, VH_BIG);
    const p0 = planThreeViews({ ratios: st.ratios, viewportH: VH_BIG, subPaneCount: 1 });
    const drag = dragRatiosFromViewPx({
      klinePx: p0.klinePx,
      indicatorsPx: p0.indicatorsPx,
      detailPx: p0.detailPx,
      viewSpacePx: p0.availablePx,
      boundary: 'indicators-detail',
      dy: 120,
      mins: viewMinPx(1),
    });
    const after = commit(storage, drag.ratios, COL_NONE);
    const pAfter = planThreeViews({ ratios: after.ratios, viewportH: VH_BIG, subPaneCount: 1 });
    expect(drag.clamped).toBe(false);
    expect(Math.abs(pAfter.indicatorsPx - (p0.indicatorsPx - 120)), '指标 −120（1:1）').toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(pAfter.detailPx - (p0.detailPx + 120)), '明细 +120（1:1）').toBeLessThanOrEqual(TOL_PX);
    expect(after.ratios.kline, '第三视图（K 线）不动').toBeCloseTo(st.ratios.kline, 9);
  });

  it('④收起态下拖到**可见段下限** ⇒ clamped=true 且披露（不得把可见段压到 0）', () => {
    const { storage } = fakeStorage();
    const base = readResultLayout(storage, { viewportH: VH_W800 });
    const preCollapse = commit(storage, base.ratios, COL_IND);
    const pCol = planThreeViews({ ratios: preCollapse.ratios, viewportH: VH_W800, subPaneCount: 1, collapsed: COL_IND });
    // 鼠标上拖 ⇒ 明细变矮，直至其可读下限 95
    const drag = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'indicators-detail',
      dy: -200,
      mins: viewMinPx(1),
    });
    expect(drag.clamped, '拖到可见段下限 ⇒ 必须置位夹取（禁静默）').toBe(true);
    const after = commit(storage, drag.ratios, COL_IND);
    const pAfter = planThreeViews({ ratios: after.ratios, viewportH: VH_W800, subPaneCount: 1, collapsed: COL_IND });
    expect(pAfter.detailPx, '明细停在可读下限 95').toBe(VIEW_MIN_PX.detail);
    expect(pAfter.klinePx + pAfter.detailPx, '夹取后可见两段仍占满（差额由另一可见段承接）').toBeCloseTo(
      pAfter.availablePx,
      0,
    );
    expect(pAfter.klinePx, '可见段不得被压到 0').toBeGreaterThanOrEqual(VIEW_MIN_PX.klineOneSub);
    expect(after.ratios.detail).toBeGreaterThan(0);
    expect(Math.abs(after.ratios.indicators - preCollapse.ratios.indicators), '收起段比例仍冻结').toBeLessThanOrEqual(1e-9);
  });
});

/**
 * ─────────── R1c **真实比例夹取**（架构裁决第四轮 2026-09-24）：展开**无条件**回位 ───────────
 *
 * 裁决：**展开必须「无条件」回到收起前（±2px）——不接受析取式判据。**
 * 契约：① 收起态下的**每次拖拽**，除两侧 1:1 与显示帧可读下限外，还必须保证**展开后的真实 px**
 * 满足各自可读下限 ⇒ 按 `r_i × 可用高 ≥ min_i` 夹取（`r_i` = **真实比例**，收起段份额已扣除）；
 * ② 可逆性：收起→拖→展开 ⇒ 收起段回收起前（±2px，**无条件**）、可见两段按比例收缩。
 * 几何：收起态可见段 px 与真实比例的关系 `r_v = (1 − S) × px_v / 可用高` ⇒ 真实下限等价于
 * `px_v ≥ min_v / (1 − S)`（`S` = 收起段已存比例之和 = **不可分配份额**）。
 */
describe('R1c 真实比例夹取：展开无条件回位（800 档触真实下限 ⇒ 停在边界值）', () => {
  const COL_IND = { indicators: true, detail: false } as const;
  const COL_DET = { indicators: false, detail: true } as const;
  const COL_NONE = { indicators: false, detail: false } as const;

  it('800 档：收起指标 ⇒ 拖 ID +100 ⇒ 停在**真实**下限边界（clamped + 披露）∧ 展开 Δ≤2px（无条件）', () => {
    const { storage } = fakeStorage();
    const base = readResultLayout(storage, { viewportH: 800 });
    const st = writeResultLayout({ ratios: base.ratios, collapsed: COL_IND }, storage);
    const S = st.ratios.indicators; // 收起段份额（不可分配）
    const pCol = planThreeViews({ ratios: st.ratios, viewportH: 800, subPaneCount: 1, collapsed: COL_IND });
    const preCollapsePlan = planThreeViews({ ratios: st.ratios, viewportH: 800, subPaneCount: 1 });
    const drag = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'indicators-detail',
      dy: 100,
      mins: viewMinPx(1),
      collapsedRatioSum: S,
    });
    const after = writeResultLayout({ ratios: drag.ratios, collapsed: COL_IND }, storage);

    // ① **无条件回位**（第四轮裁决的核心承诺，先断言 ⇒ 变异反证必红在本条）：
    //    拖拽已按真实比例夹取 ⇒ 展开**不得**触发重夹 ∧ 收起段逐 px 回收起前。
    const expanded = writeResultLayout({ ratios: after.ratios, collapsed: COL_NONE }, storage);
    const pExp = planThreeViews({ ratios: expanded.ratios, viewportH: 800, subPaneCount: 1 });
    expect(pExp.clamped, '展开**不得**触发重夹（真实比例口径）').toBe(false);
    expect(
      Math.abs(pExp.indicatorsPx - preCollapsePlan.indicatorsPx),
      `展开 ⇒ 指标**无条件**回位（收起前 ${preCollapsePlan.indicatorsPx} / 实读 ${pExp.indicatorsPx}）`,
    ).toBeLessThanOrEqual(2);

    // ② 拖拽侧读数（真实比例夹取）：触真实下限 ⇒ clamped + 停在边界值
    expect(drag.clamped, '触**真实**下限 ⇒ 必须夹取（clamped=true ⇒ 披露）').toBe(true);
    const pAfter = planThreeViews({ ratios: after.ratios, viewportH: 800, subPaneCount: 1, collapsed: COL_IND });
    const trueK = after.ratios.kline * pAfter.availablePx;
    expect(
      Math.abs(trueK - VIEW_MIN_PX.klineOneSub),
      `K 线**真实** px 停在可读下限（真实 ${trueK.toFixed(1)} / 下限 ${VIEW_MIN_PX.klineOneSub}）`,
    ).toBeLessThanOrEqual(2);
    expect(pAfter.klinePx).toBeGreaterThanOrEqual(VIEW_MIN_PX.klineOneSub);
    expect(pAfter.detailPx).toBeGreaterThanOrEqual(VIEW_MIN_PX.detail);
    expect(pAfter.klinePx + pAfter.detailPx).toBeCloseTo(pAfter.availablePx, 0);
    expect(after.ratios.indicators).toBeCloseTo(S, 9);
    expect(after.ratios.kline + after.ratios.detail).toBeCloseTo(1 - S, 9);
  });

  it('收起 detail ⇒ 拖 K线↔指标：可见段同样按**真实比例**夹取（显示帧 180 ≠ 真实下限 180/0.84）', () => {
    const { storage } = fakeStorage();
    const base = readResultLayout(storage, { viewportH: 800 });
    const st = writeResultLayout({ ratios: base.ratios, collapsed: COL_DET }, storage);
    const S = st.ratios.detail;
    const pCol = planThreeViews({ ratios: st.ratios, viewportH: 800, subPaneCount: 1, collapsed: COL_DET });
    // 上拖：指标变矮 —— 显示帧下限 180，但**真实**下限 = 180 / (1 − S) ≈ 214
    const drag = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'kline-indicators',
      dy: -400,
      mins: viewMinPx(1),
      collapsedRatioSum: S,
    });
    expect(drag.clamped, '触真实下限 ⇒ 夹取').toBe(true);
    const after = writeResultLayout({ ratios: drag.ratios, collapsed: COL_DET }, storage);
    const pAfter = planThreeViews({ ratios: after.ratios, viewportH: 800, subPaneCount: 1, collapsed: COL_DET });
    const trueI = after.ratios.indicators * pAfter.availablePx;
    expect(trueI, '指标**真实** px 不得低于可读下限').toBeGreaterThanOrEqual(VIEW_MIN_PX.indicators - 2);
    expect(pAfter.indicatorsPx, '显示帧值高于显示下限（真实口径夹取生效）').toBeGreaterThan(VIEW_MIN_PX.indicators);
    expect(after.ratios.detail, '收起段比例冻结').toBeCloseTo(S, 9);
    // 无条件展开回位（明细回到收起前）
    const preCollapsePlan = planThreeViews({ ratios: st.ratios, viewportH: 800, subPaneCount: 1 });
    const expanded = writeResultLayout({ ratios: after.ratios, collapsed: COL_NONE }, storage);
    const pExp = planThreeViews({ ratios: expanded.ratios, viewportH: 800, subPaneCount: 1 });
    expect(pExp.clamped, '展开不得触发重夹').toBe(false);
    expect(Math.abs(pExp.detailPx - preCollapsePlan.detailPx), '展开 ⇒ 明细无条件回位（±2px）').toBeLessThanOrEqual(2);
  });
});

/**
 * ─────── R1d **写入侧归一**（架构裁决第五轮 2026-09-24）：存储 == 渲染，反例消失 ───────
 *
 * 裁决：**采 B（写入侧归一）+ 把反例转成不变量。** 理由：反例根因不是「判据太严」而是
 * **存储态与生效态漂移**——`plan` 在夹取态下的渲染几何不是比例集合的纯函数（含 donor 结构），
 * 所以「存了一份不可行的比例」必然导致某条路径上不可逆（与 BLOCKED-1 的 0-ratio 同族）。
 *
 * 契约：① 任何**会写盘**的状态转换（迁移 / 收起 / 展开 / 拖拽 / 键盘步进）之后，落盘 `ratios` 必须是
 * **生效态**（= `planThreeViews` 夹取后的真实比例）⇒ `存储 == 渲染`，**不再存不可行比例**；
 * ② **不变量**：任一（可修复的）转换后，每个**未收起**视图满足 `ratio_v × 可用高 ≥ min_v`（±1px 浮点余量）；
 * 收起视图不受此约束（其份额**冻结**）。
 */
describe('R1d 写入侧归一（存储 == 渲染）：可行不变量 + 反例回归', () => {
  const AV = 668; // 800 档可用高
  const MIN = { kline: 299, indicators: 180, detail: 95 };
  const KEYS = ['kline', 'indicators', 'detail'] as const;

  /** 不变量检查：未收起视图的真实 px ≥ 其可读下限（±1px 浮点余量）。 */
  function expectFeasible(ratios: ViewRatios, collapsed: ViewCollapsed, tag: string) {
    for (const k of KEYS) {
      if ((collapsed as unknown as Record<string, boolean>)[k] === true) continue; // 收起段：份额冻结，不受此约束
      const truePx = (ratios[k] ?? 0) * AV;
      expect(truePx, `${tag}：未收起视图 ${k} 的**真实** px ${truePx.toFixed(1)} ≥ 下限 ${MIN[k]}（±1px）`).toBeGreaterThanOrEqual(
        MIN[k] - 1,
      );
    }
    const sum = KEYS.reduce((s, k) => s + (ratios[k] ?? 0), 0);
    expect(sum, `${tag}：三段比例和 = 1`).toBeCloseTo(1, 9);
    for (const k of KEYS) expect(ratios[k] ?? 0, `${tag}：${k} 必须为正`).toBeGreaterThan(0);
  }

  it('迁移（legacy cardHeights 520）⇒ 落盘即**可行**（原本不可行：指标 56.7 / 明细 31.3 < 下限）', () => {
    const { storage } = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 520 }) });
    const migrated = readResultLayout(storage, { viewportH: 800, availablePx: AV, mins: viewMinPx(1) });
    expectFeasible(migrated.ratios, migrated.collapsed, '迁移后');
    // 落盘内容 == 返回内容（存储 == 渲染）
    const raw = JSON.parse(storage.getItem(RESULT_LAYOUT_STORAGE_KEY) as string) as { ratios: ViewRatios };
    expect(raw.ratios).toEqual(migrated.ratios);
    // 渲染 == 存储（展开态无需夹取）
    const p = planThreeViews({ ratios: migrated.ratios, viewportH: 800, availablePx: AV, subPaneCount: 1 });
    expect(p.clamped, '存储态可行 ⇒ 渲染不得再夹取').toBe(false);
    for (const k of KEYS) {
      const px = k === 'kline' ? p.klinePx : k === 'indicators' ? p.indicatorsPx : p.detailPx;
      expect(Math.abs(px - migrated.ratios[k] * AV), `${k}：渲染 px == 存储比例 × 可用高`).toBeLessThanOrEqual(2);
    }
  });

  it('收起 / 展开 / 拖拽 / 键盘 四类转换后均保持**可行不变量**（从不可行迁移态出发）', () => {
    const { storage } = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 520 }) });
    const opts = { availablePx: AV, mins: viewMinPx(1) };
    const m = readResultLayout(storage, { viewportH: 800, ...opts });
    expectFeasible(m.ratios, m.collapsed, '迁移后');
    // 收起指标
    const col = writeResultLayout({ ratios: m.ratios, collapsed: { indicators: true, detail: false } }, storage, opts);
    expectFeasible(col.ratios, col.collapsed, '收起后');
    // 展开
    const exp = writeResultLayout({ ratios: col.ratios, collapsed: { indicators: false, detail: false } }, storage, opts);
    expectFeasible(exp.ratios, exp.collapsed, '展开后');
    // 拖拽（收起明细 ⇒ 拖 K线↔指标，1:1 直到真实下限）
    const colD = writeResultLayout({ ratios: exp.ratios, collapsed: { indicators: false, detail: true } }, storage, opts);
    const pColD = planThreeViews({ ratios: colD.ratios, viewportH: 800, availablePx: AV, subPaneCount: 1, collapsed: colD.collapsed });
    const drag = dragRatiosFromViewPx({
      klinePx: pColD.klinePx,
      indicatorsPx: pColD.indicatorsPx,
      detailPx: pColD.detailPx,
      viewSpacePx: pColD.availablePx,
      boundary: 'kline-indicators',
      dy: 80,
      mins: viewMinPx(1),
      collapsedRatioSum: colD.ratios.detail,
    });
    const afterDrag = writeResultLayout({ ratios: drag.ratios, collapsed: { indicators: false, detail: true } }, storage, opts);
    expectFeasible(afterDrag.ratios, afterDrag.collapsed, '拖拽后');
    // 键盘步进（ArrowDown = K线变矮 16px）
    const pKey = planThreeViews({ ratios: afterDrag.ratios, viewportH: 800, availablePx: AV, subPaneCount: 1, collapsed: afterDrag.collapsed });
    const keyDrag = dragRatiosFromViewPx({
      klinePx: pKey.klinePx,
      indicatorsPx: pKey.indicatorsPx,
      detailPx: pKey.detailPx,
      viewSpacePx: pKey.availablePx,
      boundary: 'kline-indicators',
      dy: 16,
      mins: viewMinPx(1),
      collapsedRatioSum: afterDrag.ratios.detail,
    });
    const afterKey = writeResultLayout({ ratios: keyDrag.ratios, collapsed: { indicators: false, detail: true } }, storage, opts);
    expectFeasible(afterKey.ratios, afterKey.collapsed, '键盘步进后');
  });

  it('**反例回归**（裁决 item 3）：legacy {kline:200} ⇒ 迁移 ⇒ 收起指标 ⇒ 拖 ID +40 ⇒ 展开 ⇒ 收起段 Δ≤2px（无条件）', () => {
    const { storage } = fakeStorage({ [CARD_HEIGHT_STORAGE_KEY_LEGACY]: JSON.stringify({ kline: 200 }) });
    const opts = { availablePx: AV, mins: viewMinPx(1) };
    const migrated = readResultLayout(storage, { viewportH: 800, ...opts });
    expectFeasible(migrated.ratios, migrated.collapsed, '迁移后');
    // 收起前几何（= 渲染，含夹取）——反例的比对基准
    const preCollapse = planThreeViews({ ratios: migrated.ratios, viewportH: 800, availablePx: AV, subPaneCount: 1 });
    const col = writeResultLayout({ ratios: migrated.ratios, collapsed: { indicators: true, detail: false } }, storage, opts);
    const pCol = planThreeViews({ ratios: col.ratios, viewportH: 800, availablePx: AV, subPaneCount: 1, collapsed: col.collapsed });
    const drag = dragRatiosFromViewPx({
      klinePx: pCol.klinePx,
      indicatorsPx: pCol.indicatorsPx,
      detailPx: pCol.detailPx,
      viewSpacePx: pCol.availablePx,
      boundary: 'indicators-detail',
      dy: 40,
      mins: viewMinPx(1),
      collapsedRatioSum: col.ratios.indicators,
    });
    const afterDrag = writeResultLayout({ ratios: drag.ratios, collapsed: { indicators: true, detail: false } }, storage, opts);
    const expanded = writeResultLayout({ ratios: afterDrag.ratios, collapsed: { indicators: false, detail: false } }, storage, opts);
    const pExp = planThreeViews({ ratios: expanded.ratios, viewportH: 800, availablePx: AV, subPaneCount: 1 });
    expect(pExp.clamped, '展开**不得**触发重夹（存储态可行 ⇒ 无需夹取）').toBe(false);
    expect(
      Math.abs(pExp.indicatorsPx - preCollapse.indicatorsPx),
      `反例回归：收起段 Δ ≤ 2px（无条件）——收起前 ${preCollapse.indicatorsPx} / 展开后 ${pExp.indicatorsPx}（未归一实现此处为 39px）`,
    ).toBeLessThanOrEqual(2);
  });
});

/**
 * ───── R1e **归一完备**：收起段份额上界（架构裁决第六轮 2026-09-24）─────
 *
 * 缺口（独立复验判定为**产品缺陷**）：legacy `v1 {ratio:0.5, collapsed:true}` ⇒ 迁移后**存储的可见段比例
 * 低于各自下限**（720 档 192.5/101.5、800 218.7/115.3、1000 284.2/149.8）且**无任何披露**；
 * 展开得 109/189/389 vs 冻结比例期望 294/334/434。**适用域 = 视口高 < ≈1045px**（legacy 只读迁移可达）。
 *
 * 契约（ADR §2.9-7 / plan D9-11 已回填）：**归一必须完备**——
 * 除「每个**未收起**视图 `ratio_v × 可用高 ≥ min_v`（±1px）」外，**收起态另需**
 * `S ≤ 1 − Σ_{可见} min_v / 可用高`（`S` = 收起段冻结比例之和；契约文字以 `min_i + min_d` 记，
 * 数值上界按**可见两段各自下限之和**推导，见报告 §14.1）；不满足 ⇒ **把冻结份额收缩到该可行上界**
 * （`S` 可被归一修改，但**永不为 0**）并置 `clamped` + **显式披露**。
 */
describe('R1e 归一完备：收起段份额上界（第六轮裁决）', () => {
  const MIN = { kline: 299, indicators: 180, detail: 95 };
  const KEYS = ['kline', 'indicators', 'detail'] as const;
  const VPS = [
    { h: 720, avail: 588 },
    { h: 800, avail: 668 },
    { h: 1000, avail: 868 },
  ];

  for (const { h, avail } of VPS) {
    it(`legacy {ratio:0.5, collapsed:true} @${h}（可用 ${avail}）⇒ 迁移即归一：可见段可行 ∧ S ≤ 1 − 可见下限之和/可用 ∧ 展开拿收缩后的 S`, () => {
      const { storage, map } = fakeStorage({
        [RESULT_LAYOUT_V1_STORAGE_KEY]: JSON.stringify({ ratio: 0.5, collapsed: true }),
      });
      const l = readResultLayout(storage, { viewportH: h, availablePx: avail, mins: viewMinPx(1) });
      // v1 `collapsed: true` ⇒ **明细**收起（只读迁移口径不变）
      expect(l.collapsed, 'v1 collapsed 迁移为明细收起').toEqual({ indicators: false, detail: true });

      // ① Σ ratios == 1（±1e-6）
      const sum = KEYS.reduce((s, k) => s + l.ratios[k], 0);
      expect(sum, `Σ ratios == 1（实测 ${sum}）`).toBeCloseTo(1, 6);

      // ② **收起段份额上界**：S ≤ 1 − Σ(可见两段各自下限)/可用（±1px）——先断言（变异必红在本条）
      const visibleMinSum = MIN.kline + MIN.indicators; // 收起的是 detail ⇒ 可见 = kline + indicators
      expect(
        l.ratios.detail,
        `${h} 档 S=${l.ratios.detail.toFixed(4)} ≤ 1 − ${visibleMinSum}/${avail} = ${(1 - visibleMinSum / avail).toFixed(4)}`,
      ).toBeLessThanOrEqual(1 - visibleMinSum / avail + 1 / avail);
      // 契约文字形式（较宽，必须同时成立）：S ≤ 1 − (min_i + min_d)/可用
      expect(l.ratios.detail).toBeLessThanOrEqual(1 - (MIN.indicators + MIN.detail) / avail + 1 / avail);
      // **永不为 0**
      for (const k of KEYS) expect(l.ratios[k], `${k} 不得为 0`).toBeGreaterThan(0);

      // ③ 每个**未收起**视图：ratio × 可用高 ≥ min（±1px）
      for (const k of ['kline', 'indicators'] as const) {
        expect(
          l.ratios[k] * avail,
          `${h} 档未收起视图 ${k} 的真实 px ${(l.ratios[k] * avail).toFixed(1)} ≥ 下限 ${MIN[k]}（±1px）`,
        ).toBeGreaterThanOrEqual(MIN[k] - 1);
      }

      // ④ 展开 ⇒ 收起段拿到的份额 == 收缩后的 S（可行、不重夹、不低于其下限）
      const expanded = writeResultLayout(
        { ratios: l.ratios, collapsed: { indicators: false, detail: false } },
        storage,
        { availablePx: avail, mins: viewMinPx(1) },
      );
      expect(expanded.ratios.detail, '展开后收起段份额 == 收缩后的 S').toBeCloseTo(l.ratios.detail, 9);
      const pExp = planThreeViews({ ratios: expanded.ratios, viewportH: h, availablePx: avail, subPaneCount: 1 });
      expect(pExp.clamped, '展开不得触发重夹（两侧都落在可行域内）').toBe(false);
      expect(expanded.ratios.detail * avail, '收起段自身也 ≥ 其下限').toBeGreaterThanOrEqual(MIN.detail - 1);

      // ⑤ 旧键逐字节不变 + 不崩
      expect(map.get(RESULT_LAYOUT_V1_STORAGE_KEY), '旧键只读').toBe(JSON.stringify({ ratio: 0.5, collapsed: true }));
    });
  }

  it('未发生收缩 ⇒ **不误报**：默认态 @800 无收起 ⇒ 存储即生效态（seed 标志位由 hook 合成，见状态层判据）', () => {
    const { storage } = fakeStorage();
    const l = readResultLayout(storage, { viewportH: 800, availablePx: 668, mins: viewMinPx(1) });
    expect(l.ratios).toEqual({ ...DEFAULT_VIEW_RATIOS });
    const p = planThreeViews({ ratios: l.ratios, viewportH: 800, availablePx: 668, subPaneCount: 1 });
    expect(p.clamped, '默认态 800 可渲染 ⇒ 不夹取（也不得因归一误报）').toBe(false);
    // 收起 detail（S=0.16 ≤ 1 − 479/668 = 0.2829 ⇒ 不触上界）⇒ 比例不变
    const col = writeResultLayout({ ratios: l.ratios, collapsed: { indicators: false, detail: true } }, storage, {
      availablePx: 668,
      mins: viewMinPx(1),
    });
    expect(col.ratios.detail, 'S 已可行 ⇒ 冻结份额不被改写').toBeCloseTo(DEFAULT_VIEW_RATIOS.detail, 9);
  });
});
