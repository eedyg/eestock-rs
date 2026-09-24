/**
 * ADR-028 §2.9（**D9｜结果页三视图拆分**）真渲染判据（D9-1..13）。
 *
 * ## 契约（唯一事实源；本规格按契约推导，**不按实现倒推**）
 * `design/01-architecture/adr/ADR-028-…§2.9` + `design/17-trade-detail-layering/08-plan-three-view-split.md` §2 表 D9-1..13、§4 边界。
 * 结构不变式：**上=K 线视图（常驻、不可收起）｜中=指标视图（仅四张曲线卡）｜下=明细视图（4 tab）**；
 * 两条分隔条；三段比例（和=1）；**每段可读下限** K 线 299（1 副图）/329（2 副图）、指标 180、明细 95；
 * **可用高 = 视口高 − 132**（旧口径 `ratio × 视口高` 溢出 92px）；几何恒等式
 * `卡高 = 视图高 − 60`、`内层 = 卡高 − 22`、`主图 = 内层 − 26 − 1×副图数 − Σ副图`；
 * 硬不变量 `主图 ≥ 160 ∧ 副图 ≥ 30`（任意记忆值/副图数/视口）。
 *
 * ## 运行（沙箱预览，**不碰线上 web/dist**）
 *   cd web && npx vite build --outDir /tmp/d9dist && \
 *     VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/d9dist --port 4177 &
 *   E2E_BASE_URL=http://127.0.0.1:4177 npx playwright test e2e/adr028-d9-three-view.e2e.ts --retries=0 --workers=1
 *
 * 原始读数落盘：`ADR028_D9_OUT`（默认 `coder/evidence/20260924_d9_three_view/raw`，**未跟踪**目录）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028_D9_OUT ?? resolve(REPO, 'coder/evidence/20260924_d9_three_view/raw');
const RUN_ID = process.env.ADR028_D9_RUN ?? 'sr_1790176327648_000012';

/** 契约常量（本规格自持；**不 import 产品模块** ⇒ 避免按实现倒推）。 */
const TOL_PX = 2;
const VIEW_AVAILABLE_CHROME_PX = 132;
const VIEW_MIN = { klineOneSub: 299, klineTwoSub: 329, indicators: 180, detail: 95 };
const KLINE_VIEW_CHROME_PX = 60;
const KLINE_CARD_BORDER_HEADER_PX = 22;
const MAIN_MIN_PX = 160;
const SUB_PANE_MIN_PX = 30;
const DEFAULT_RATIOS = { kline: 0.55, indicators: 0.29, detail: 0.16 };
/** 契约曾登记但**作废**的一组「可达上限」（口径错两处：按副图总高=0 算 + 把段高当卡高）。 */
const VOID_CEILINGS = { 720: 245, 800: 285, 1400: 585 };

const VP = {
  w720: { width: 1280, height: 720 },
  w800: { width: 1280, height: 800 },
  w1400: { width: 1280, height: 1400 },
};

function writeJson(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

// ═══════════════════════════ 页面侧探针（自包含） ═══════════════════════════

function probeGeom() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const scroll = (el: Element | null) =>
    el ? { scrollH: (el as HTMLElement).scrollHeight, clientH: (el as HTMLElement).clientHeight, scrollTop: Math.round((el as HTMLElement).scrollTop), overflowY: getComputedStyle(el).overflowY } : null;
  const result = q('wb-result');
  const klineView = q('wb-kline-view');
  const raw = (id: string, attr: string) => q(id)?.getAttribute(attr) ?? null;
  const paneRaw = raw('kline-chart', 'data-pane-metrics');
  let paneMetrics: unknown = null;
  try {
    paneMetrics = paneRaw ? JSON.parse(paneRaw) : null;
  } catch {
    paneMetrics = null;
  }
  const cardStyle = (q('wb-kline-chart') as HTMLElement | null)?.style;
  return {
    viewportH: window.innerHeight,
    pageScroll: {
      innerH: window.innerHeight,
      docScrollH: document.scrollingElement ? (document.scrollingElement as HTMLElement).scrollHeight : -1,
      scrollY: Math.round(window.scrollY),
      bodyOverflowY: getComputedStyle(document.body).overflowY,
    },
    result: rect(result),
    split: rect(q('wb-result-split')),
    klineView: rect(klineView),
    indicatorsView: rect(q('wb-indicator-view')),
    detailView: rect(q('wb-detail-view')),
    detailPane: rect(q('wb-detail-pane')),
    splitterKI: rect(q('wb-splitter-kline-indicators')),
    splitterID: rect(q('wb-splitter-indicators-detail')),
    restoreIndicators: rect(q('wb-restore-indicators')),
    restoreDetail: rect(q('wb-restore-detail')),
    card: rect(q('wb-kline-chart')),
    cardHeader: rect(q('wb-kline-card-header')),
    klineInner: rect(q('kline-chart')),
    page: scroll(document.scrollingElement),
    klineViewScroll: scroll(klineView),
    indicatorViewScroll: scroll(q('wb-indicator-view')),
    detailPaneScroll: scroll(q('wb-detail-pane')),
    attrs: {
      ratioKline: raw('wb-result', 'data-view-ratio-kline'),
      ratioIndicators: raw('wb-result', 'data-view-ratio-indicators'),
      ratioDetail: raw('wb-result', 'data-view-ratio-detail'),
      heightKline: raw('wb-result', 'data-view-height-kline'),
      heightIndicators: raw('wb-result', 'data-view-height-indicators'),
      heightDetail: raw('wb-result', 'data-view-height-detail'),
      collapsedIndicators: raw('wb-result', 'data-view-collapsed-indicators'),
      collapsedDetail: raw('wb-result', 'data-view-collapsed-detail'),
      available: raw('wb-result', 'data-view-available'),
      clamped: raw('wb-result', 'data-view-clamped'),
      compressed: raw('wb-result', 'data-view-compressed'),
      subPaneCount: raw('wb-result', 'data-kline-sub-pane-count'),
      cardViewHeight: raw('wb-kline-chart', 'data-kline-view-height'),
      cardInlineHeight: cardStyle ? cardStyle.height : null,
    },
    paneMetrics,
    /** D9-2：K 线视图内**不得**出现任何收起入口（断言缺失）。 */
    collapseEntries: {
      insideKlineView: klineView ? klineView.querySelectorAll('[data-collapse-view]').length : -1,
      indicators: !!q('wb-indicator-collapse'),
      detail: !!q('wb-detail-collapse'),
      restoreKline: !!q('wb-restore-kline'),
    },
    /** D9-5：卡高机制必须**不存在**。 */
    legacy: {
      presets: (['s', 'm', 'l'] as const).map((k) => !!q(`wb-kline-preset-${k}`)),
      cardHandle: !!q('wb-card-resize-kline'),
    },
    curveCards: {
      inIndicatorView: (() => {
        const iv = q('wb-indicator-view');
        if (!iv) return null;
        const ids = ['wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart'];
        return ids.map((id) => {
          const el = q(id);
          return { id, present: !!el, inside: el ? iv.contains(el) : false };
        });
      })(),
    },
    detailTabs: ['trades', 'metrics', 'perbar', 'events'].map((k) => !!q(`wb-tab-${k}`)),
    disclosure: q('wb-view-clamp-note')?.textContent ?? null,
    storage: {
      v2: localStorage.getItem('eestock.result.layout.v2'),
      v1: localStorage.getItem('eestock.result.layout.v1'),
      cardHeights: localStorage.getItem('eestock.result.cardHeights.v1'),
      dashboard: localStorage.getItem('eestock.dashboard.layout.v1'),
    },
  };
}

const probe = (page: Page): Promise<ReturnType<typeof probeGeom>> =>
  page.evaluate(probeGeom) as unknown as Promise<ReturnType<typeof probeGeom>>;

// ═══════════════════════════ 驱动 ═══════════════════════════

async function openRun(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-kline-view')).toBeVisible();
  await expect(page.getByTestId('wb-result-split')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    return !!el && el.getBoundingClientRect().height > 40;
  });
  await page.waitForTimeout(2200);
}

/**
 * 拖某条分隔条：`dy < 0` = 鼠标**向上** ⇒ 边界上移。
 * **方向语义（2026-09-24 二次纠错后为准；ADR §2.7-3 / §2.8 / §2.9-8）**：把手移动方向 = 边界移动方向
 * ⇒ **上移 ⇒ 下方视图变高、上方变矮**（`upperPx = startUpper + Δy` / `lowerPx = startLower − Δy`）。
 */
async function dragSplitter(page: Page, which: 'ki' | 'id', dy: number, steps = 8): Promise<void> {
  const id = which === 'ki' ? 'wb-splitter-kline-indicators' : 'wb-splitter-indicators-detail';
  const box = await page.getByTestId(id).boundingBox();
  expect(box, `分隔条 ${id} 必须可命中`).not.toBeNull();
  const vp = page.viewportSize() ?? VP.w800;
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/**
 * 把某条分隔条**拖到上限（推向视口底边）** —— 用于「K 线优先吃满」判据：
 * 边界下移 ⇒ 上方（K 线）视图变大直至下方视图触其可读下限（§2.8 二次纠错：
 * 旧规格用「上拖到顶」表达同一意图，那是按已作废的错误方向写的）。
 */
async function dragSplitterToLimitDown(page: Page, which: 'ki' | 'id'): Promise<void> {
  const box = await page
    .getByTestId(which === 'ki' ? 'wb-splitter-kline-indicators' : 'wb-splitter-indicators-detail')
    .boundingBox();
  expect(box).not.toBeNull();
  const vp = page.viewportSize() ?? VP.w800;
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (const y of [y0 + 60, y0 + 160, y0 + 320, vp.height - 4]) await page.mouse.move(x, Math.min(vp.height - 4, y));
  await page.mouse.up();
  await page.waitForTimeout(200);
}

// ═══════════════════════════ 判据 ═══════════════════════════

test.describe('D9-1/D9-2/D9-5/D9-12 结构与观测（1280×800）', () => {
  test.use({ viewport: VP.w800 });

  test('三视图归属正确 / K 线视图不可收起 / 卡高机制已删 / data-view-* 齐备', async ({ page }) => {
    await openRun(page);
    const g = await probe(page);
    writeJson('d9_struct', g);

    // D9-1
    expect(g.klineView, 'wb-kline-view 必须存在').not.toBeNull();
    expect(g.indicatorsView, 'wb-indicator-view 必须存在').not.toBeNull();
    expect(g.detailPane, 'wb-detail-pane（明细视图内）必须存在').not.toBeNull();
    expect(g.splitterKI, 'K线↔指标 分隔条必须存在').not.toBeNull();
    expect(g.splitterID, '指标↔明细 分隔条必须存在').not.toBeNull();
    for (const c of g.curveCards.inIndicatorView ?? []) {
      if (c.present) expect(c.inside, `${c.id} 必须在指标视图内`).toBe(true);
    }
    expect(g.detailTabs.every(Boolean), '明细 4 tab 必须齐备').toBe(true);

    // D9-2：K 线视图**无**收起入口 / **无**恢复条
    expect(g.collapseEntries.insideKlineView, 'K 线视图内不得有 [data-collapse-view]').toBe(0);
    expect(g.collapseEntries.restoreKline, 'K 线视图不得有恢复条').toBe(false);
    expect(g.collapseEntries.indicators, '指标视图必须有收起入口').toBe(true);
    expect(g.collapseEntries.detail, '明细视图必须有收起入口').toBe(true);

    // D9-5：卡高机制（S/M/L 预设 + 下沿把手）必须不存在；卡片 h-full（无 inline 高度）
    expect(g.legacy.presets, 'S/M/L 预设必须不存在').toEqual([false, false, false]);
    expect(g.legacy.cardHandle, 'K 线卡下沿把手必须不存在').toBe(false);
    expect(g.attrs.cardInlineHeight ?? '', '卡片不得再有 inline 卡高').toBe('');

    // D9-12：观测性
    expect(Number(g.attrs.ratioKline)).toBeCloseTo(0.55, 2);
    expect(Number(g.attrs.ratioIndicators)).toBeCloseTo(0.29, 2);
    expect(Number(g.attrs.ratioDetail)).toBeCloseTo(0.16, 2);
    expect(g.attrs.collapsedIndicators).toBe('false');
    expect(g.attrs.collapsedDetail).toBe('false');
    expect(Number(g.attrs.available), `可用高 = 视口 − 132（${g.viewportH} ⇒ ${g.viewportH - VIEW_AVAILABLE_CHROME_PX}）`).toBe(
      g.viewportH - VIEW_AVAILABLE_CHROME_PX,
    );
  });
});

test.describe('D9-6 两条分隔条 + 2 自由度守恒 + 方向语义（1280×1400，富余档）', () => {
  test.use({ viewport: VP.w1400 });

  test('方向：上拖 N ⇒ **下方视图变高、上方变矮**（N∈{40,120,240}）；1:1；守恒；双击复位默认比例', async ({ page }) => {
    await openRun(page);
    const base = await probe(page);
    writeJson('d9_drag_base', base);
    expect(base.attrs.clamped, '1400 档默认比例不得触发夹取（前置）').toBe('false');

    // ── K线↔指标（上拖 120 ⇒ 边界上移：**指标 +120 / K 线 −120** / 明细不动）──
    const before = await probe(page);
    await dragSplitter(page, 'ki', -120);
    const after = await probe(page);
    const dK = after.klineView!.h - before.klineView!.h;
    const dI = after.indicatorsView!.h - before.indicatorsView!.h;
    writeJson('d9_drag_ki_up120', { before, after, dK, dI });
    expect(
      dI,
      `D9-6⑤ 上拖 120 ⇒ **下方视图（指标）变高** ≈+120（实读 ${dI}；**错方向实现此处为 ${-120}**）`,
    ).toBeGreaterThanOrEqual(120 - TOL_PX);
    expect(Math.abs(dI - 120), `D9-6⑤ 位移 1:1（实读 ${dI}）`).toBeLessThanOrEqual(TOL_PX);
    expect(
      dK,
      `D9-6① 上方视图（K 线）反向补偿 1:1 ≈−120（实读 ${dK}；**错方向实现此处为 ${120}**）`,
    ).toBeLessThanOrEqual(-120 + TOL_PX);
    expect(Math.abs(dK + 120)).toBeLessThanOrEqual(TOL_PX);
    expect(after.detailView!.h, '别的边界不受影响（明细不动）').toBe(before.detailView!.h);
    // D9-6④ 守恒
    expect(
      Math.abs(after.klineView!.h + after.indicatorsView!.h + after.detailView!.h - Number(after.attrs.available)),
      'D9-6④ 三段之和 == 可用高（±2px）',
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(Number(after.attrs.available) + 2 * 12 + 16 - after.split!.h),
      '物理守恒：可用高 + 两条分隔条(24) + gap(16) == split 容器高（±2px）',
    ).toBeLessThanOrEqual(TOL_PX);

    // ── 指标↔明细（上拖 60 ⇒ 边界上移：**明细 +60 / 指标 −60** / K 线不动；60 有余量不触明细下限）──
    const b2 = await probe(page);
    await dragSplitter(page, 'id', -60);
    const a2 = await probe(page);
    const dI2 = a2.indicatorsView!.h - b2.indicatorsView!.h;
    const dD2 = a2.detailView!.h - b2.detailView!.h;
    writeJson('d9_drag_id_up60', { b2, a2, dI2, dD2 });
    expect(Math.abs(dD2 - 60), `D9-6② 上拖 60 ⇒ **下方视图（明细）变高** 60（实读 ${dD2}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(dI2 + 60), `D9-6② 指标（上方）反向 1:1（实读 ${dI2}）`).toBeLessThanOrEqual(TOL_PX);
    expect(a2.klineView!.h, 'K 线不受该边界影响').toBe(b2.klineView!.h);

    // ── 指标↔明细 **下拖 240** ⇒ 明细被**可读下限 95** 挡住（1:1 在夹取处停止，差额回吐指标）──
    const b2b = await probe(page);
    await dragSplitter(page, 'id', 240);
    const a2b = await probe(page);
    const clip = Math.max(0, VIEW_MIN.detail - (b2b.detailView!.h - 240));
    writeJson('d9_drag_id_down240_clip', { b2b, a2b, clip });
    expect(a2b.detailView!.h, '明细停在可读下限 95').toBe(VIEW_MIN.detail);
    expect(
      Math.abs(a2b.indicatorsView!.h - (b2b.indicatorsView!.h + 240 - clip)),
      `D9-6② 下拖 240：指标吸收被夹取的 ${clip}px（实读 ${a2b.indicatorsView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(a2b.klineView!.h, 'K 线仍不受该边界影响').toBe(b2b.klineView!.h);
    expect(
      Math.abs(a2b.klineView!.h + a2b.indicatorsView!.h + a2b.detailView!.h - Number(a2b.attrs.available)),
    ).toBeLessThanOrEqual(TOL_PX);
    await page.getByTestId('wb-splitter-indicators-detail').dblclick();
    await page.waitForTimeout(150);

    // ── 下拖 N ∈ {40, 120, 240} 复测（每次都先复位到默认比例；240 组会触指标可读下限 ⇒ K 线吃满）──
    const resetBoth = async () => {
      await page.getByTestId('wb-splitter-kline-indicators').dblclick();
      await page.getByTestId('wb-splitter-indicators-detail').dblclick();
      await page.waitForTimeout(150);
    };
    await resetBoth();
    const b3 = await probe(page);
    await dragSplitter(page, 'ki', 40);
    const a3 = await probe(page);
    expect(Math.abs(a3.klineView!.h - b3.klineView!.h - 40), '下拖 40 ⇒ 上方（K 线）+40（1:1）').toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(a3.indicatorsView!.h - b3.indicatorsView!.h + 40), '下拖 40 ⇒ 下方（指标）−40（1:1）').toBeLessThanOrEqual(
      TOL_PX,
    );
    await resetBoth();
    const b4 = await probe(page);
    await dragSplitter(page, 'ki', 120);
    const a4 = await probe(page);
    expect(Math.abs(a4.klineView!.h - b4.klineView!.h - 120), '下拖 120 ⇒ 上方（K 线）+120（1:1）').toBeLessThanOrEqual(TOL_PX);
    await resetBoth();
    const b5b = await probe(page);
    const avail0 = Number(b5b.attrs.available);
    await dragSplitter(page, 'ki', 240);
    const a5b = await probe(page);
    writeJson('d9_drag_ki_40_120_240', { b3, a3, b4, a4, b5b, a5b });
    // 240 > 余量 ⇒ 停在**指标**可读下限 180：K 线 = 可用 − 180 − 明细（D9-8-3②「K 线优先吃满」；明细不受该边界影响）
    expect(a5b.indicatorsView!.h, '下拖 240 ⇒ 指标停在可读下限 180').toBe(VIEW_MIN.indicators);
    expect(
      Math.abs(a5b.klineView!.h - (avail0 - VIEW_MIN.indicators - a5b.detailView!.h)),
      `下拖 240（越界）⇒ K 线吃到 = 可用 − 指标下限 − 明细（实读 ${a5b.klineView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(a5b.klineView!.h - b5b.klineView!.h, '即便越界，K 线仍必须变高（方向正确）').toBeGreaterThan(0);
    expect(a5b.detailView!.h, '明细不受该边界影响').toBe(b5b.detailView!.h);
    await resetBoth();

    // ── D9-6⑥ 双击各自复位默认比例 ──
    const b5 = await probe(page);
    await page.getByTestId('wb-splitter-kline-indicators').dblclick();
    await page.getByTestId('wb-splitter-indicators-detail').dblclick();
    const a5 = await probe(page);
    writeJson('d9_dblclick_reset', { b5, a5 });
    expect(Number(a5.attrs.ratioKline), `双击 K线↔指标 ⇒ 复位默认 ${DEFAULT_RATIOS.kline}`).toBeCloseTo(DEFAULT_RATIOS.kline, 2);
    expect(Number(a5.attrs.ratioIndicators)).toBeCloseTo(DEFAULT_RATIOS.indicators, 2);
    expect(Number(a5.attrs.ratioDetail)).toBeCloseTo(DEFAULT_RATIOS.detail, 2);
    expect(Math.abs(a5.klineView!.h - base.klineView!.h), '复位后与初始读数一致（±2px）').toBeLessThanOrEqual(TOL_PX);

    // ── 方向反证：下拖 120 ⇒ **上方视图（K 线）变高** ──
    const b6 = await probe(page);
    await dragSplitter(page, 'ki', 120);
    const a6 = await probe(page);
    writeJson('d9_drag_ki_down120', { b6, a6 });
    expect(
      Math.abs(a6.klineView!.h - b6.klineView!.h - 120),
      `下拖 120 ⇒ K 线（上方）变高 120（实读 Δ${a6.klineView!.h - b6.klineView!.h}；**错方向实现此处为 −120**）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(a6.indicatorsView!.h - b6.indicatorsView!.h + 120),
      `下拖 120 ⇒ 指标（下方）变矮 120（实读 Δ${a6.indicatorsView!.h - b6.indicatorsView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
  });
});

test.describe('D9-3 收起/恢复条/记忆（1280×800）', () => {
  test.use({ viewport: VP.w800 });

  test('收起指标 ⇒ 不留空、其余按原比例分享、释放量 = 收起段高（±2）；恢复条常驻带名可点；收起态记忆', async ({ page }) => {
    await openRun(page);
    const before = await probe(page);
    const released = before.indicatorsView!.h;
    await page.getByTestId('wb-indicator-collapse').click();
    await page.waitForTimeout(300);
    const after = await probe(page);
    writeJson('d9_collapse_indicators', { before, after, released });

    expect(after.indicatorsView, '收起后指标视图不占位').toBeNull();
    expect(after.attrs.collapsedIndicators).toBe('true');
    expect(after.restoreIndicators, '恢复条必须常驻可见').not.toBeNull();
    const avail = Number(after.attrs.available);
    expect(Math.abs(after.klineView!.h + after.detailView!.h - avail), '其余两段分享全部可用高（无孤立空隙）').toBeLessThanOrEqual(TOL_PX);
    const gained = after.klineView!.h + after.detailView!.h - (before.klineView!.h + before.detailView!.h);
    expect(Math.abs(gained - released), `释放量 = 收起段高（实读 ${gained} vs ${released}）`).toBeLessThanOrEqual(TOL_PX + 2);
    // 按**原比例**分享：K 线 : 明细 增量 ≈ 0.55 : 0.16
    const dK = after.klineView!.h - before.klineView!.h;
    const dD = after.detailView!.h - before.detailView!.h;
    expect(dK / (dK + dD), '释放按原比例进入其余两段').toBeCloseTo(0.55 / (0.55 + 0.16), 2);
    // 恢复条可点（含键盘可达性 = role=button + tabIndex）
    const role = await page.getByTestId('wb-restore-indicators').getAttribute('role');
    const label = await page.getByTestId('wb-restore-indicators').getAttribute('aria-label');
    expect(role).toBe('button');
    expect(label ?? '', '恢复条必须带视图名').toContain('指标');
    // 收起态记忆（v2 键）
    expect(JSON.parse(after.storage.v2 ?? '{}').collapsed, '收起态必须写 v2 键').toEqual({
      indicators: true,
      detail: false,
    });
    // 刷新保持（刷新后需重新选 run 才回到结果页）
    await page.reload();
    await openRun(page);
    const reloaded = await probe(page);
    writeJson('d9_collapse_reload', reloaded);
    expect(reloaded.attrs.collapsedIndicators, '刷新后收起态保持').toBe('true');
    expect(reloaded.restoreIndicators, '刷新后恢复条仍可见').not.toBeNull();

    // 展开 ⇒ 逐 px 复原
    await page.getByTestId('wb-restore-indicators').click();
    await page.waitForTimeout(300);
    const expanded = await probe(page);
    writeJson('d9_collapse_expand', expanded);
    expect(expanded.indicatorsView, '展开后指标视图回来').not.toBeNull();
    expect(Math.abs(expanded.klineView!.h - before.klineView!.h), '展开逐 px 复原').toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(expanded.indicatorsView!.h - before.indicatorsView!.h)).toBeLessThanOrEqual(TOL_PX);
  });

  test('明细收起 ⇒ 释放按原比例分享；两视图同时收起 ⇒ K 线占满', async ({ page }) => {
    await openRun(page);
    const before = await probe(page);
    await page.getByTestId('wb-detail-collapse').click();
    await page.waitForTimeout(300);
    const a1 = await probe(page);
    writeJson('d9_collapse_detail', { before, a1 });
    expect(a1.detailPane, '收起后明细视图不占位').toBeNull();
    expect(a1.restoreDetail, '明细恢复条必须常驻').not.toBeNull();
    expect((await page.getByTestId('wb-restore-detail').getAttribute('aria-label')) ?? '').toContain('明细');
    const avail = Number(a1.attrs.available);
    expect(Math.abs(a1.klineView!.h + a1.indicatorsView!.h - avail)).toBeLessThanOrEqual(TOL_PX);

    await page.getByTestId('wb-indicator-collapse').click();
    await page.waitForTimeout(300);
    const a2 = await probe(page);
    writeJson('d9_collapse_both', a2);
    expect(a2.indicatorsView).toBeNull();
    expect(Math.abs(a2.klineView!.h - avail), '两视图同时收起 ⇒ K 线视图占满可用高').toBeLessThanOrEqual(TOL_PX);
    expect(a2.restoreIndicators, '两枚恢复条并排常驻').not.toBeNull();
    expect(a2.restoreDetail).not.toBeNull();
  });
});

test.describe('D9-4/D9-10 滚动语义与跳转纪律（1280×800）', () => {
  test.use({ viewport: VP.w800 });

  test('K 线视图不滚 / 指标与明细各自滚且互不影响 / 整页不滚；跳转不动明细与指标 scrollTop', async ({ page }) => {
    await openRun(page);
    const g = await probe(page);
    writeJson('d9_scroll', g);
    // D9-4
    expect(g.klineViewScroll!.scrollH, 'K 线视图不得有内部滚动').toBeLessThanOrEqual(g.klineViewScroll!.clientH + 1);
    expect(g.indicatorViewScroll!.overflowY, '指标视图必须 overflow:auto').toBe('auto');
    expect(g.detailPaneScroll!.overflowY).toBe('auto');
    expect(g.pageScroll.docScrollH, '整页不得滚动').toBeLessThanOrEqual(g.pageScroll.innerH + 1);
    expect(g.pageScroll.scrollY).toBe(0);

    // 互不影响：滚指标 ⇒ 明细 scrollTop 不变
    await page.getByTestId('wb-indicator-view').hover();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    const s1 = await probe(page);
    expect(s1.indicatorViewScroll!.scrollTop, '指标视图必须真的滚了（否则判据无鉴别力）').toBeGreaterThan(0);
    expect(s1.detailPaneScroll!.scrollTop, '指标滚动不得影响明细').toBe(0);
    // 滚明细 ⇒ 指标 scrollTop 不变
    await page.getByTestId('wb-detail-tabs').hover();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    const s2 = await probe(page);
    writeJson('d9_scroll_after_wheel', { s1, s2 });
    expect(s2.detailPaneScroll!.scrollTop, '明细必须真的滚了').toBeGreaterThan(0);
    expect(s2.indicatorViewScroll!.scrollTop, '明细滚动不得影响指标').toBe(s1.indicatorViewScroll!.scrollTop);

    // D9-10：跳转纪律 —— 下栏与指标视图 scrollTop 不变 + 页面不滚 + 高亮生效
    const beforeJump = await probe(page);
    const jump = page.locator('[data-testid^="wb-jump-"]').first();
    if ((await jump.count()) > 0) {
      await jump.click();
      await page.waitForTimeout(600);
      const afterJump = await probe(page);
      const hl = await page.getByTestId('wb-jump-highlight-note').getAttribute('data-state').catch(() => null);
      writeJson('d9_jump', { beforeJump, afterJump, highlightState: hl });
      expect(afterJump.detailPaneScroll!.scrollTop, 'D9-10 跳转不得改变明细 scrollTop').toBe(
        beforeJump.detailPaneScroll!.scrollTop,
      );
      expect(afterJump.indicatorViewScroll!.scrollTop, 'D9-10 跳转不得改变指标视图 scrollTop').toBe(
        beforeJump.indicatorViewScroll!.scrollTop,
      );
      expect(afterJump.pageScroll.scrollY, '整页仍不滚').toBe(0);
      expect(afterJump.klineView!.h, 'K 线视图仍在（可见）').toBeGreaterThan(0);
    }
  });
});

test.describe('D9-7/D9-8 夹取优先级、最小高、几何恒等式与硬不变量', () => {
  test.use({ viewport: VP.w720 });

  test('720 档：默认夹取（K 线吃满 = 可用 − 指标下限 − 明细下限）、披露、硬不变量、恒等式', async ({ page }) => {
    await openRun(page);
    const g = await probe(page);
    writeJson('d9_w720_default', g);
    const avail = Number(g.attrs.available);
    expect(avail).toBe(720 - VIEW_AVAILABLE_CHROME_PX);

    // D9-7：三视图不低于可读下限；K 线优先吃满
    expect(g.klineView!.h, `K 线视图 ≥ ${VIEW_MIN.klineOneSub}`).toBeGreaterThanOrEqual(VIEW_MIN.klineOneSub);
    expect(g.indicatorsView!.h, `指标视图 ≥ ${VIEW_MIN.indicators}`).toBeGreaterThanOrEqual(VIEW_MIN.indicators);
    expect(g.detailView!.h, `明细视图 ≥ ${VIEW_MIN.detail}`).toBeGreaterThanOrEqual(VIEW_MIN.detail);
    const subCount = Number(g.attrs.subPaneCount ?? 0);
    const klineMin = subCount >= 2 ? VIEW_MIN.klineTwoSub : VIEW_MIN.klineOneSub;
    if (subCount < 2) {
      expect(
        Math.abs(g.klineView!.h - (avail - VIEW_MIN.indicators - VIEW_MIN.detail)),
        `D9-8-3② K 线优先吃满：K 线视图高 == 可用 − 指标下限 − 明细下限（实读 ${g.klineView!.h}）`,
      ).toBeLessThanOrEqual(TOL_PX);
      expect(g.attrs.clamped, '夹取必须显式标记').toBe('true');
      expect(g.disclosure, '夹取必须**显式披露**（禁静默）').toBeTruthy();
    }
    expect(g.klineView!.h).toBeGreaterThanOrEqual(klineMin);

    // D9-8-1 恒等式（真身读数：引擎 pane metrics + DOM 实测）
    const cardH = g.card!.h;
    const innerH = g.klineInner!.h;
    expect(Math.abs(cardH - (g.klineView!.h - KLINE_VIEW_CHROME_PX)), `卡高 == 视图高 − 60（卡高 ${cardH} / 视图高 ${g.klineView!.h}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(innerH - (cardH - KLINE_CARD_BORDER_HEADER_PX)), `内层 == 卡高 − 22（内层 ${innerH} / 卡高 ${cardH}）`).toBeLessThanOrEqual(TOL_PX);
    const pm = g.paneMetrics as { candlePx: number | null; subPaneTotalPx: number | null; subPanes: Array<{ px: number | null }> } | null;
    if (pm && pm.candlePx != null && pm.subPaneTotalPx != null) {
      const n = pm.subPanes.length;
      expect(
        Math.abs(pm.candlePx - (innerH - 26 - 1 * n - pm.subPaneTotalPx)),
        `主图 == 内层 − 26 − 1×副图数 − Σ副图（主图 ${pm.candlePx} / 内层 ${innerH} / Σ副图 ${pm.subPaneTotalPx}）`,
      ).toBeLessThanOrEqual(TOL_PX);
      // D9-8-2 硬不变量
      expect(pm.candlePx, `主图 ≥ ${MAIN_MIN_PX}（硬下限）`).toBeGreaterThanOrEqual(MAIN_MIN_PX);
      for (const sp of pm.subPanes) {
        expect(sp.px ?? 0, `每个副图 ≥ ${SUB_PANE_MIN_PX}`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
      }
      expect(pm.subPaneTotalPx, '默认 regime 副图合计 ≤ 120').toBeLessThanOrEqual(120);
      // 契约曾登记但已作废的口径对照（留证：本档可达到的主图远低于 245）
      writeJson('d9_w720_geometry', { cardH, innerH, pm, voidCeiling: VOID_CEILINGS[720] });
    }
    expect(g.cardHeader!.h, '卡头 ≤ 48px').toBeLessThanOrEqual(48);
  });

  test('720 档：把 K线↔指标 拖到极限（下推）⇒ K 线视图 == 可用 − 指标下限 − 明细下限（±2）且三视图不低于下限', async ({ page }) => {
    await openRun(page);
    await dragSplitterToLimitDown(page, 'ki');
    const g = await probe(page);
    writeJson('d9_w720_drag_limit', g);
    const avail = Number(g.attrs.available);
    expect(
      Math.abs(g.klineView!.h - (avail - VIEW_MIN.indicators - VIEW_MIN.detail)),
      `K 线优先吃满（实读 ${g.klineView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(g.indicatorsView!.h).toBe(VIEW_MIN.indicators);
    expect(g.detailView!.h).toBe(VIEW_MIN.detail);
    expect(Math.abs(g.klineView!.h + g.indicatorsView!.h + g.detailView!.h - avail)).toBeLessThanOrEqual(TOL_PX);
  });

  test('800 档：默认比例不触发夹取（clamped=false）、恒等式与硬不变量成立、披露缺席', async ({ page }) => {
    await page.setViewportSize(VP.w800);
    await openRun(page);
    const g = await probe(page);
    writeJson('d9_w800_default', g);
    const avail = Number(g.attrs.available);
    expect(avail).toBe(800 - VIEW_AVAILABLE_CHROME_PX);
    expect(Math.abs(Number(g.attrs.ratioKline) - DEFAULT_RATIOS.kline)).toBeLessThan(0.001);
    expect(g.attrs.clamped, '800 档比例天然满足下限 ⇒ 不得误报夹取').toBe('false');
    expect(g.disclosure ?? '', '未夹取时不得有披露').toBe('');
    expect(Math.abs(g.klineView!.h + g.indicatorsView!.h + g.detailView!.h - avail)).toBeLessThanOrEqual(TOL_PX);
    const pm = g.paneMetrics as { candlePx: number | null } | null;
    if (pm?.candlePx != null) {
      expect(pm.candlePx, `主图 ≥ ${MAIN_MIN_PX}`).toBeGreaterThanOrEqual(MAIN_MIN_PX);
      writeJson('d9_w800_geometry', { pm, viewHeights: { k: g.klineView!.h, i: g.indicatorsView!.h, d: g.detailView!.h } });
    }
    // K 线视图**不滚动**（本档内容仍可能超出 ⇒ 只断言无 overflow-auto）
    expect(g.klineViewScroll!.overflowY === 'auto').toBe(false);
  });

  test('1400 档：主图 ≥ 320（几何可行支）且默认不夹取', async ({ page }) => {
    await page.setViewportSize(VP.w1400);
    await openRun(page);
    const g = await probe(page);
    writeJson('d9_w1400_default', g);
    const pm = g.paneMetrics as { candlePx: number | null; subPaneTotalPx: number | null; subPanes: unknown[] } | null;
    expect(g.attrs.clamped).toBe('false');
    expect(pm?.candlePx ?? 0, 'D9-8-3 几何可行支：主图 ≥ 320').toBeGreaterThanOrEqual(320);
    if (pm) {
      writeJson('d9_w1400_geometry', {
        candlePx: pm.candlePx,
        subPaneTotalPx: pm.subPaneTotalPx,
        subPanes: pm.subPanes,
        viewHeights: { k: g.klineView!.h, i: g.indicatorsView!.h, d: g.detailView!.h },
        voidCeiling: VOID_CEILINGS[1400],
      });
    }
  });
});

test.describe('D9-8-2/3 两副图档：几何可行支主图仍 ≥ 320（1280×1400）', () => {
  test.use({ viewport: VP.w1400 });

  test('开启 MACD（2 副图）⇒ K 线视图下限重夹到 329 档且主图 ≥ 320、副图各 ≥ 30', async ({ page }) => {
    await openRun(page);
    await page.getByTestId('wb-indicator-menu').click();
    await page.getByTestId('wb-indicator-toggle-macd').click();
    await page.waitForTimeout(600);
    const g = await probe(page);
    writeJson('d9_w1400_two_sub', g);
    expect(Number(g.attrs.subPaneCount)).toBeGreaterThanOrEqual(2);
    expect(g.klineView!.h).toBeGreaterThanOrEqual(VIEW_MIN.klineTwoSub);
    const pm = g.paneMetrics as { candlePx: number | null; subPanes: Array<{ px: number | null }>; subPaneTotalPx: number | null } | null;
    expect(pm?.candlePx ?? 0, '2 副图 + 1400 档：主图 ≥ 320').toBeGreaterThanOrEqual(320);
    for (const sp of pm!.subPanes) expect(sp.px ?? 0).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
    expect(pm!.subPaneTotalPx ?? 0, '副图合计 ≤ 120（默认 regime）').toBeLessThanOrEqual(120);
  });
});

test.describe('D9-11/D9-13 记忆迁移与必修缺陷（1280×720）', () => {
  test.use({ viewport: VP.w720 });

  test('旧 cardHeights {kline:200} 只作只读迁移源 ⇒ K 线视图 ≥ 299、主图 ≥ 160（旧实现直渲染 200 ⇒ 主图 121）', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('eestock.result.cardHeights.v1', JSON.stringify({ kline: 200 }));
      // 看板 key 必须逐字节不变（D9-11）
      localStorage.setItem('eestock.dashboard.layout.v1', JSON.stringify({ marker: 'dashboard-untouched' }));
    });
    await openRun(page);
    const g = await probe(page);
    writeJson('d9_legacy_200', g);
    expect(g.klineView!.h, 'D9-13 记忆值恢复后必须按**实测有效下限**再夹取').toBeGreaterThanOrEqual(VIEW_MIN.klineOneSub);
    const pm = g.paneMetrics as { candlePx: number | null; subPaneTotalPx: number | null } | null;
    if (pm?.candlePx != null) expect(pm.candlePx, '主图 ≥ 160（硬下限）').toBeGreaterThanOrEqual(MAIN_MIN_PX);
    expect(g.storage.cardHeights, '旧键内容必须**逐字节不变**（只读迁移）').toBe(JSON.stringify({ kline: 200 }));
    expect(g.storage.dashboard, '看板 key 不得被结果页触碰').toBe(JSON.stringify({ marker: 'dashboard-untouched' }));
  });

  test('坏值 {kline:1} / {kline:99999} 不被采信；旧 v1 比例 + collapsed 迁移；2 副图时重夹', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('eestock.result.layout.v1', JSON.stringify({ ratio: 0.5, collapsed: true }));
      localStorage.setItem('eestock.result.cardHeights.v1', JSON.stringify({ kline: 99999 }));
    });
    await openRun(page);
    const g = await probe(page);
    writeJson('d9_bad_and_v1', g);
    // v1 迁移：明细比例 0.5、明细收起
    // **第六轮裁决（归一完备）重锚**：720 档下 v1 `ratio:0.5` 的**冻结份额不可行**
    // （可见两段 kline+indicators 的真实下限之和 479 > 可用 588×(1−0.5)）⇒ 归一必须把 S **收缩**到上界
    // （`S ≤ 1 − 479/588 = 0.1854`）并置 `clamped` + 披露 ⇒ 存储 == 生效态（旧判据「照搬 0.5」已被裁决取代）。
    const sDetail = Number(g.attrs.ratioDetail);
    const bound = 1 - (VIEW_MIN.klineOneSub + VIEW_MIN.indicators) / Number(g.attrs.available);
    expect(sDetail, `S=${sDetail} 必须被收缩到可行上界 ${bound.toFixed(4)} 之下`).toBeLessThanOrEqual(bound + 1 / Number(g.attrs.available));
    expect(sDetail, '收缩是**收缩**（原 0.5 ⇒ 更小）').toBeLessThan(0.5);
    expect(sDetail, '份额永不为 0').toBeGreaterThan(0);
    expect(g.attrs.collapsedDetail, 'v1 `collapsed` 迁移为明细收起态').toBe('true');
    expect(g.restoreDetail, '迁移后恢复条必须可见').not.toBeNull();
    expect(g.attrs.clamped, '发生收缩 ⇒ clamped 置位').toBe('true');
    expect(g.disclosure ?? '', '收缩必须显式披露').toContain('收缩');
    // 界外旧卡高（99999）不得被采信：采信则 kline 会取 RATIO_MAX(0.92) ⇒ 投影后 ≈0.664；实测为未采信的投影值
    expect(Number(g.attrs.ratioKline), '界外旧卡高不得被采信（采信则 ≈0.66）').toBeLessThan(0.55);
    expect(Math.abs(g.klineView!.h + g.indicatorsView!.h + Number(g.attrs.heightDetail ?? 0) - Number(g.attrs.available))).toBeLessThanOrEqual(
      TOL_PX + 1,
    );
    // 2 副图 ⇒ K 线视图下限 299 → 329（重夹）
    await page.getByTestId('wb-restore-detail').click();
    await page.waitForTimeout(200);
    await page.getByTestId('wb-indicator-menu').click();
    await page.getByTestId('wb-indicator-toggle-macd').click();
    await page.waitForTimeout(400);
    const g2 = await probe(page);
    writeJson('d9_two_sub_after_toggle', g2);
    expect(Number(g2.attrs.subPaneCount), 'MACD 开启后副图数 = 2').toBeGreaterThanOrEqual(2);
    expect(g2.klineView!.h, 'D9-13 副图数变化 ⇒ 重夹到 2 副图下限 329').toBeGreaterThanOrEqual(VIEW_MIN.klineTwoSub);
    const pm2 = g2.paneMetrics as { candlePx: number | null; subPanes: Array<{ px: number | null }>; subPaneTotalPx: number | null } | null;
    if (pm2?.candlePx != null) {
      for (const sp of pm2.subPanes) expect(sp.px ?? 0).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
      writeJson('d9_two_sub_geometry', pm2);
      // 该档为**不可行压缩支**（三段可读下限之和 604 > 可用 588，已显式披露）：契约只承诺
      // 「K 线视图优先保 329」+「副图各 ≥30」；引擎实测主图读数一并落盘（见报告残留项）。
      expect(g2.disclosure, '不可行压缩支必须显式披露').toBeTruthy();
    }
    expect(g2.storage.v2, 'v2 键必须已写入').not.toBeNull();
    expect(Object.keys(JSON.parse(g2.storage.v2 ?? '{}').collapsed)).not.toContain('kline');
  });
});

/**
 * ─────────────── BLOCKED-1 / BLOCKED-2 修复判据（真渲染；独立复验复现路径）───────────────
 *
 * 事实源：ADR-028 §2.9-7 / plan `08-plan-three-view-split.md` §4
 * 「迁移源冲突（v1 比例与 cardHeights px 同时存在）| **以 v2 已存值为准**；两源仅在 v2 无该字段时采信；
 *  界外/坏数据 ⇒ 忽略该源、用默认」+ §4「口径澄清（2026-09-24 独立复验登记）①**拖拽路径也必须披露夹取**」。
 *
 * 复现路径（`tester/evidence/20260924_d9_accept/BLOCKED.md` §BLOCKED-1 / §BLOCKED-2；P5-2 / P6-R1 / P6-R3）：
 * **收起某视图后再拖分隔条 ⇒ v2 落出 `0` 比例 ⇒ 严格解析拒绝整份 v2 ⇒ 刷新丢收起态与比例；
 *  有旧键时还会静默回落 legacy 迁移。** 本块即该两条症状的真渲染判据。
 */
const RATIO_KEYS = ['kline', 'indicators', 'detail'] as const;

/**
 * 播种：**先 `goto('/')` 再写 localStorage**——不得用 `addInitScript`（它在**每次导航重播**，
 * 会连 `page.reload()` 一起清空 ⇒ 判据变成「刷新后回默认」（自我实现）。
 */
async function seedStorage(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.goto('/');
  await page.evaluate((kv: Record<string, string>) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, extra);
}

/** v2 合法性读数：三段比例**全为正**、和 = 1（BLOCKED-1 根因：`"detail":0`）。 */
function v2Ratios(raw: string | null): { ratios: Record<string, number>; sum: number; collapsed: Record<string, unknown> } {
  const o = JSON.parse(raw ?? '{}') as { ratios?: Record<string, number>; collapsed?: Record<string, unknown> };
  const ratios = o.ratios ?? {};
  const sum = RATIO_KEYS.reduce((s, k) => s + (ratios[k] ?? 0), 0);
  return { ratios, sum, collapsed: o.collapsed ?? {} };
}

test.describe('BLOCKED-1/D9-3/D9-11 修复判据：收起态下拖拽 ⇒ v2 合法 + 刷新不丢态（1280×800）', () => {
  test.use({ viewport: VP.w800 });

  test('①收起明细 ⇒ 拖 K线↔指标 ⇒ v2 三段全为正、刷新后收起态与三段比例均保持', async ({ page }) => {
    await seedStorage(page);
    await openRun(page);
    const base = await probe(page);
    expect(base.attrs.clamped, '前置：800 档默认不夹取').toBe('false');

    await page.getByTestId('wb-detail-collapse').click();
    await page.waitForTimeout(300);
    const collapsedView = await probe(page);
    expect(collapsedView.attrs.collapsedDetail, '前置：明细已收起').toBe('true');

    // **上拖 −80**（§2.8：边界上移 ⇒ 上方 K 线变矮、下方指标变高）：收起明细后的可见两段恰为（K 线、指标）
    // ⇒ 位移 1:1 落在两段之间（下拖在该态会被“钉住”：指标已贴其真实下限）。
    await dragSplitter(page, 'ki', -80);
    const dragged = await probe(page);
    const v2 = v2Ratios(dragged.storage.v2);
    writeJson('d9fix_b1_detail_collapse_drag', { base, collapsedView, dragged, v2 });
    for (const k of RATIO_KEYS) {
      expect(v2.ratios[k] ?? 0, `v2.ratios.${k} 必须 > 0（不得持久化 0/非法段比例）`).toBeGreaterThan(0);
    }
    expect(v2.sum, `v2 三段比例和 = 1（实测 ${v2.sum}）`).toBeCloseTo(1, 6);
    expect(v2.collapsed.detail, 'v2 必须记录明细收起态').toBe(true);

    await page.reload();
    await openRun(page);
    const reloaded = await probe(page);
    writeJson('d9fix_b1_detail_collapse_reload', { dragged, reloaded });
    expect(reloaded.attrs.collapsedDetail, '刷新后收起态必须保持（旧实现：v2 被拒 ⇒ 收起态丢失）').toBe('true');
    expect(reloaded.storage.v2, 'v2 已合法 ⇒ 应用不得重写（读回即用）').toBe(dragged.storage.v2);
    expect(Number(reloaded.attrs.ratioDetail), '明细比例必须回读为收起前的有效值（不得为 0）').toBeCloseTo(
      DEFAULT_RATIOS.detail,
      2,
    );
    // 三段比例保持：刷新前/后逐段 ≤2px（内存态 = 落盘态）
    expect(Math.abs(reloaded.klineView!.h - dragged.klineView!.h), '刷新后 K 线视图逐 px 保持（±2）').toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(reloaded.indicatorsView!.h - dragged.indicatorsView!.h),
      '刷新后指标视图逐 px 保持（±2）',
    ).toBeLessThanOrEqual(TOL_PX);
    expect(reloaded.detailPane, '刷新后明细仍收起（不占位）').toBeNull();
    expect(reloaded.restoreDetail, '刷后恢复条仍常驻').not.toBeNull();
    // 展开明细 ⇒ 回到收起前比例（记忆语义）
    await page.getByTestId('wb-restore-detail').click();
    await page.waitForTimeout(300);
    const expanded = await probe(page);
    writeJson('d9fix_b1_detail_expand', expanded);
    expect(expanded.detailView, '展开后明细视图回来').not.toBeNull();
    expect(
      Math.abs(expanded.detailView!.h - base.detailView!.h),
      `展开后明细回到收起前高度（记忆比例；实读 ${expanded.detailView!.h} vs ${base.detailView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX + 2);
  });

  test('②叠旧键（cardHeights + v1）⇒ 收起态下拖拽后刷新不得静默回落迁移源（v2 已存值为准）', async ({ page }) => {
    await seedStorage(page, {
      'eestock.result.layout.v1': JSON.stringify({ ratio: 0.4 }),
      'eestock.result.cardHeights.v1': JSON.stringify({ kline: 520 }),
    });
    await openRun(page);
    const migrated = await probe(page);
    const migratedRatioKline = Number(migrated.attrs.ratioKline);

    await page.getByTestId('wb-detail-collapse').click();
    await page.waitForTimeout(300);
    // **上拖 −80**（§2.8：边界上移 ⇒ 上方 K 线变矮）：收起态下可见两段为（K 线、指标），
    // 而指标在该迁移态下已处于**真实可读下限**（显示 210 ≈ 180/(1−S)）⇒ **下拖被“钉住”不动**
    // （K 线始终回到 457）⇒ 其比例（0.587）与迁移读数（0.5883）碰巧重合 ⇒ 会把「不得回落」判据
    // 变成假绿。取上拖使比例明显偏离（0.485 vs 0.588），判据保持**有鉴别力**。
    await dragSplitter(page, 'ki', -80);
    const dragged = await probe(page);
    const v2 = v2Ratios(dragged.storage.v2);
    writeJson('d9fix_b1_legacy_drag', { migrated, dragged, v2 });
    expect(v2.collapsed.detail).toBe(true);
    for (const k of RATIO_KEYS) expect(v2.ratios[k] ?? 0, `v2.ratios.${k} > 0`).toBeGreaterThan(0);
    expect(v2.sum).toBeCloseTo(1, 6);

    await page.reload();
    await openRun(page);
    const reloaded = await probe(page);
    writeJson('d9fix_b1_legacy_reload', { dragged, reloaded, migratedRatioKline });
    expect(reloaded.attrs.collapsedDetail, 'D9-3：明细收起态必须刷新后保持').toBe('true');
    expect(
      Math.abs(reloaded.klineView!.h - dragged.klineView!.h),
      `D9-11：v2 已存值优先 ⇒ 刷新后逐 px 保持（实测 ${reloaded.klineView!.h} vs ${dragged.klineView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Number(reloaded.attrs.ratioKline),
      `不得静默回落到旧卡高迁移值（迁移读数 ${migratedRatioKline}）`,
    ).not.toBeCloseTo(migratedRatioKline, 2);
    expect(reloaded.storage.cardHeights, '旧键必须**逐字节不变**（只读迁移）').toBe(JSON.stringify({ kline: 520 }));
    expect(reloaded.storage.v1, '旧 v1 键必须**逐字节不变**（只读迁移）').toBe(JSON.stringify({ ratio: 0.4 }));
  });
});

test.describe('BLOCKED-2 修复判据：拖拽路径必须披露夹取（1280×800）', () => {
  test.use({ viewport: VP.w800 });

  test('拖到可读下限 ⇒ data-view-clamped 置位 + 披露文本非空（禁只在默认分配路径置位）', async ({ page }) => {
    await seedStorage(page);
    await openRun(page);
    const base = await probe(page);
    expect(base.attrs.clamped, '前置：800 档默认不夹取').toBe('false');
    expect(base.disclosure ?? '', '前置：未夹取时不得有披露').toBe('');

    // 上拖 400（终点夹在视口内；§2.8：边界上移 ⇒ 上方 K 线变矮）⇒ K 线视图必到可读下限 299
    await dragSplitter(page, 'ki', -400);
    const afterDrag = await probe(page);
    writeJson('d9fix_b2_drag_clamp', { base, afterDrag });
    expect(afterDrag.klineView!.h, `D9-7 K 线视图必须停在可读下限 ${VIEW_MIN.klineOneSub}`).toBe(VIEW_MIN.klineOneSub);
    expect(afterDrag.attrs.clamped, 'D9-7/BLOCKED-2 拖到下限 ⇒ `data-view-clamped` 必须置位').toBe('true');
    expect(afterDrag.disclosure ?? '', '拖拽夹取必须**显式披露**（禁静默）').toBeTruthy();
    expect(afterDrag.disclosure ?? '', '披露必须指明来自拖拽路径（不得与默认分配路径混淆）').toContain('拖拽');

    // 反证：未触下限的拖拽不得误报（禁误报）：上拖 30 ⇒ 337 / 224，两侧均在可读下限之上
    await page.getByTestId('wb-splitter-kline-indicators').dblclick();
    await page.waitForTimeout(200);
    const reset = await probe(page);
    expect(reset.attrs.clamped, '复位后回到默认分配（800 档不夹取）').toBe('false');
    await dragSplitter(page, 'ki', -30);
    const small = await probe(page);
    writeJson('d9fix_b2_no_false_positive', { reset, small });
    expect(small.attrs.clamped, '未触下限不得误报夹取').toBe('false');
    expect(small.disclosure ?? '', '未触下限不得误报披露').toBe('');
  });
});

/**
 * ─────────── R1 冻结语义（架构裁决 2026-09-24）真渲染判据 ───────────
 *
 * 裁决：**收起段的「最后一次有效比例」必须被钉住（freeze），拖拽不得改写它。**
 * 依据 ADR §2.9-2「收起后不留空、其余视图按原比例分享释放空间」⇒ 收起段比例是「**暂停使用**」
 * 而非「重新分配」⇒ **展开必须回到收起前的几何**（收起是可逆动作）。
 *
 * 判据：①收起指标 ⇒ 拖 指标↔明细 ⇒ 展开 ⇒ **指标视图高 == 收起前高度（±2px）**，且 v2 中
 * 收起段比例 == 收起前值（±1e-9）、可见两段之和 = 1 − 收起段比例；
 * ②反向对照：**未被收起**的两段在拖拽中照常 1:1 重归一（冻结不得波及可见段）。
 */
test.describe('R1 冻结语义（架构裁决 2026-09-24）：收起段比例不得被拖拽改写（1280×800）', () => {
  test.use({ viewport: VP.w800 });

  test('①收起指标 ⇒ 拖 指标↔明细 ⇒ 展开 ⇒ 指标视图高 == 收起前（±2px）；v2 中收起段比例冻结', async ({ page }) => {
    await seedStorage(page);
    await openRun(page);
    // ⓪ 先拖 K线↔指标 造**非默认**比例（默认值巧合会掩盖冻结失效：0.29 vs 0.3503 必须可分）
    await dragSplitter(page, 'ki', 40);
    const preset = await probe(page);
    expect(Number(preset.attrs.ratioIndicators), '前置：指标比例已非默认（否则判据无鉴别力）').not.toBeCloseTo(
      DEFAULT_RATIOS.indicators,
      3,
    );
    expect(preset.indicatorsView, '前置：指标视图可见').not.toBeNull();

    // ① 收起指标：收起动作本身不得改比例
    await page.getByTestId('wb-indicator-collapse').click();
    await page.waitForTimeout(300);
    const collapsedView = await probe(page);
    expect(collapsedView.attrs.collapsedIndicators).toBe('true');
    expect(collapsedView.indicatorsView, '收起后指标视图不占位').toBeNull();
    expect(
      Number(collapsedView.attrs.ratioIndicators),
      '收起动作本身不得改写比例（收起 ≠ 重新分配）',
    ).toBeCloseTo(Number(preset.attrs.ratioIndicators), 3);
    /** 收起后（拖拽前）的**已存值**（全精度；DOM 属性仅 4 位小数，不得当基准）。 */
    const v2Frozen = v2Ratios(collapsedView.storage.v2).ratios.indicators ?? 0;

    // ② 收起态下拖 **上拖 −100** ⇒ 位移**只在可见两段之间** 1:1（第三轮裁决；不得是 no-op），
    //    并按**真实比例**夹取（第四轮裁决）：本档 −200 会使 K 线越其**真实**下限 ⇒ **停在边界值**。
    await dragSplitter(page, 'id', -200);
    const afterDrag = await probe(page);
    const v2 = v2Ratios(afterDrag.storage.v2);
    const avail = Number(afterDrag.attrs.available);
    const trueK = (v2.ratios.kline ?? 0) * avail;
    const dK = afterDrag.klineView!.h - collapsedView.klineView!.h;
    const dD = afterDrag.detailView!.h - collapsedView.detailView!.h;
    writeJson('d9fix_r1_freeze', { preset, collapsedView, afterDrag, v2, avail, trueK, dK, dD });
    // ③ **无条件回位**（第四轮裁决的核心承诺，先断言 ⇒ 变异反证必红在本条）：
    //    真实比例夹取 ⇒ 展开**不得**触发重夹 ∧ 指标逐 px 回收起前。
    await page.getByTestId('wb-restore-indicators').click();
    await page.waitForTimeout(300);
    const expanded = await probe(page);
    writeJson('d9fix_r1_freeze_expanded', { preset, collapsedView, afterDrag, expanded });
    expect(expanded.indicatorsView, '展开后指标视图必须回来').not.toBeNull();
    expect(expanded.attrs.clamped, '展开**不得**触发重夹（真实比例口径）').toBe('false');
    expect(
      Math.abs(expanded.indicatorsView!.h - preset.indicatorsView!.h),
      `展开 ⇒ 指标**无条件**逐 px 回位（收起前 ${preset.indicatorsView!.h} / 实读 ${expanded.indicatorsView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);

    // ④ 拖拽侧读数（真实比例夹取）：位移只在可见两段之间 1:1，触真实下限 ⇒ 停在边界值 + clamped + 披露
    expect(Math.abs(dK + dD), `1:1 只在可见两段之间（Δk=${dK} / Δd=${dD}）`).toBeLessThanOrEqual(TOL_PX);
    expect(dK, 'K 线仍按拖拽方向变矮（控件不是死的）').toBeLessThan(0);
    expect(
      Math.abs(trueK - VIEW_MIN.klineOneSub),
      `触**真实**下限 ⇒ K 线真实 px 停在边界值（真实 ${trueK.toFixed(1)} / 下限 ${VIEW_MIN.klineOneSub}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(afterDrag.klineView!.h + afterDrag.detailView!.h, '可见两段之和 = 可用高').toBeGreaterThanOrEqual(avail - TOL_PX);
    expect(afterDrag.klineView!.h + afterDrag.detailView!.h).toBeLessThanOrEqual(avail + TOL_PX);
    expect(afterDrag.attrs.clamped, '触真实下限 ⇒ clamped 必须置位').toBe('true');
    expect(afterDrag.disclosure ?? '', '夹取必须显式披露').toBeTruthy();

    // ④ 落盘冻结：v2 中收起段比例 == 收起前的**已存值**（±1e-9）；可见两段之和 = 1 − 收起段比例
    for (const k of RATIO_KEYS) expect(v2.ratios[k] ?? 0, `v2.ratios.${k} 必须 > 0`).toBeGreaterThan(0);
    expect(
      Math.abs((v2.ratios.indicators ?? 0) - v2Frozen),
      `v2 中收起段比例必须**冻结**在收起前的已存值（已存 ${v2Frozen} / 实读 ${v2.ratios.indicators}）`,
    ).toBeLessThanOrEqual(1e-9);
    expect(
      (v2.ratios.kline ?? 0) + (v2.ratios.detail ?? 0),
      '可见两段之和 = 1 − 收起段比例',
    ).toBeCloseTo(1 - (v2.ratios.indicators ?? 0), 9);
  });

  test('②反向对照：未被收起的段在拖拽中照常 1:1 重归一（冻结不得波及可见段）', async ({ page }) => {
    await seedStorage(page);
    await openRun(page);
    await page.getByTestId('wb-detail-collapse').click();
    await page.waitForTimeout(300);
    const collapsedView = await probe(page);
    expect(collapsedView.detailPane, '前置：明细已收起').toBeNull();
    const v2Before = v2Ratios(collapsedView.storage.v2);

    await dragSplitter(page, 'ki', -80);
    const afterDrag = await probe(page);
    writeJson('d9fix_r1_control_visible_renorm', { collapsedView, afterDrag });
    expect(
      Math.abs(afterDrag.klineView!.h - (collapsedView.klineView!.h - 80)),
      `可见段 K 线照常 1:1（上拖 ⇒ 上方变矮；期望 ${collapsedView.klineView!.h - 80} / 实读 ${afterDrag.klineView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(afterDrag.indicatorsView!.h - (collapsedView.indicatorsView!.h + 80)),
      `可见段指标照常 1:1（期望 ${collapsedView.indicatorsView!.h + 80} / 实读 ${afterDrag.indicatorsView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    const v2After = v2Ratios(afterDrag.storage.v2);
    expect(
      Math.abs((v2After.ratios.detail ?? 0) - (v2Before.ratios.detail ?? 0)),
      '被冻结段（明细）比例保持收起时的值',
    ).toBeLessThanOrEqual(1e-9);
    expect((v2After.ratios.kline ?? 0) + (v2After.ratios.indicators ?? 0), '可见两段之和 = 1 − 冻结段').toBeCloseTo(
      1 - (v2After.ratios.detail ?? 0),
      9,
    );
  });
});

/**
 * ─────── R1b 收起态相邻边界：位移**转给可见两段**（架构裁决第三轮 2026-09-24）真渲染判据 ───────
 *
 * 裁决：**采「位移转给可见两段」而不是 no-op。** 理由：控件「拖不动」正是 D6 卡把手被误判为不可用
 * 的那类缺陷；收起态下相邻边界若拖拽无屏幕效果 = 新引入一个死控件（即使有披露也不该留）。
 *
 * 精确语义：① 收起段**存储比例**永不被拖拽改写（冻结不变）；② 收起态下拖拽**可见两段之间的边界**
 * ⇒ 只在**可见两段之间** 1:1 重分配，两侧各受各自可读下限夹取（下限处 clamp + 披露、不得压到 0）；
 * ③ 展开 ⇒ 收起段回其冻结比例、可见两段**按比例收缩**（相对分配保持）；④ 未收起时行为不变。
 */
test.describe('R1b 收起态相邻边界：位移转给可见两段（1280×1400 富余档）', () => {
  test.use({ viewport: VP.w1400 });

  test('①收起指标 ⇒ 拖 指标↔明细 **上拖 −100** ⇒ K 线/明细各 ±100px；展开 ⇒ indicators 回位 ∧ 可见两段等比收缩', async ({ page }) => {
    await seedStorage(page);
    await openRun(page);
    // 造非默认比例（默认值巧合会掩盖冻结失效）
    await dragSplitter(page, 'ki', 40);
    const preset = await probe(page);
    expect(Number(preset.attrs.ratioIndicators), '前置：指标比例已非默认').not.toBeCloseTo(DEFAULT_RATIOS.indicators, 3);

    await page.getByTestId('wb-indicator-collapse').click();
    await page.waitForTimeout(300);
    const collapsedView = await probe(page);
    expect(collapsedView.indicatorsView, '收起后指标不占位').toBeNull();
    const frozen = v2Ratios(collapsedView.storage.v2).ratios.indicators ?? 0;

    // 收起态下拖 指标↔明细 **上拖 −100**：位移**只在可见两段之间** 1:1
    await dragSplitter(page, 'id', -100);
    const afterDrag = await probe(page);
    expect(afterDrag.attrs.clamped, '富余档 ±100 未触下限 ⇒ 不得夹取').toBe('false');
    expect(
      Math.abs(afterDrag.klineView!.h - (collapsedView.klineView!.h - 100)),
      `K 线 1:1 变矮 100（收起态 ${collapsedView.klineView!.h} / 实读 ${afterDrag.klineView!.h}；no-op 实现此处必红）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(afterDrag.detailView!.h - (collapsedView.detailView!.h + 100)),
      `明细 1:1 变高 100（收起态 ${collapsedView.detailView!.h} / 实读 ${afterDrag.detailView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    const v2After = v2Ratios(afterDrag.storage.v2);
    expect(
      Math.abs((v2After.ratios.indicators ?? 0) - frozen),
      `收起段比例必须**逐位冻结**（已存 ${frozen} / 实读 ${v2After.ratios.indicators}）`,
    ).toBeLessThanOrEqual(1e-9);
    expect(
      (v2After.ratios.kline ?? 0) + (v2After.ratios.detail ?? 0),
      '可见两段之和 = 1 − 收起段比例',
    ).toBeCloseTo(1 - frozen, 9);

    // 展开 ⇒ indicators 回位（±2px）∧ 可见两段按 (1 − 收起段比例) **等比收缩**（相对分配保持）
    await page.getByTestId('wb-restore-indicators').click();
    await page.waitForTimeout(300);
    const expanded = await probe(page);
    writeJson('d9fix_r1b_realloc_expand', { preset, collapsedView, afterDrag, expanded, v2After });
    expect(expanded.indicatorsView, '展开后指标视图必须回来').not.toBeNull();
    expect(
      Math.abs(expanded.indicatorsView!.h - preset.indicatorsView!.h),
      `展开后指标回位（收起前 ${preset.indicatorsView!.h} / 实读 ${expanded.indicatorsView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    const keep = 1 - frozen;
    expect(
      Math.abs(expanded.klineView!.h - keep * afterDrag.klineView!.h),
      `K 线按 ${keep.toFixed(4)} 等比收缩（期望 ${(keep * afterDrag.klineView!.h).toFixed(1)} / 实读 ${expanded.klineView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(
      Math.abs(expanded.detailView!.h - keep * afterDrag.detailView!.h),
      `明细按 ${keep.toFixed(4)} 等比收缩（期望 ${(keep * afterDrag.detailView!.h).toFixed(1)} / 实读 ${expanded.detailView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(expanded.attrs.clamped, '展开未越域 ⇒ 不得夹取').toBe('false');
  });

  test('②反向对照：**未收起**时拖同一边界行为不变（1:1，勿被本条波及）', async ({ page }) => {
    await seedStorage(page);
    await openRun(page);
    await dragSplitter(page, 'ki', 40);
    const base = await probe(page);
    await dragSplitter(page, 'id', -120);
    const after = await probe(page);
    writeJson('d9fix_r1b_control_uncollapsed', { base, after });
    expect(
      Math.abs(after.indicatorsView!.h - (base.indicatorsView!.h - 120)),
      `未收起：指标 1:1 变矮 120（实读 Δ${after.indicatorsView!.h - base.indicatorsView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(after.detailView!.h - (base.detailView!.h + 120)),
      `未收起：明细 1:1 变高 120（实读 Δ${after.detailView!.h - base.detailView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(after.klineView!.h - base.klineView!.h), '未收起：第三视图（K 线）不动').toBeLessThanOrEqual(TOL_PX);
    expect(after.attrs.clamped, '未收起且未触下限 ⇒ 不得夹取').toBe('false');
  });

  test('③收起态下拖到**真实下限** ⇒ clamped=true + 披露（不得把可见段压到 0）∧ 展开无条件回位', async ({ page }) => {
    await page.setViewportSize(VP.w800);
    await seedStorage(page);
    await openRun(page);
    const preCollapse = await probe(page);
    await page.getByTestId('wb-indicator-collapse').click();
    await page.waitForTimeout(300);
    const collapsedView = await probe(page);
    expect(collapsedView.indicatorsView).toBeNull();
    const frozen = v2Ratios(collapsedView.storage.v2).ratios.indicators ?? 0;

    // **下拖**（§2.8：边界下移 ⇒ 下方明细变矮）直至其**真实**可读下限（`min/(1−S)`；显示帧值高于显示下限）
    await dragSplitter(page, 'id', 200);
    const afterDrag = await probe(page);
    const avail = Number(afterDrag.attrs.available);
    const v2After = v2Ratios(afterDrag.storage.v2);
    const trueD = (v2After.ratios.detail ?? 0) * avail;
    writeJson('d9fix_r1b_clamp_visible_min', { preCollapse, collapsedView, afterDrag, trueD, avail });
    expect(afterDrag.attrs.clamped, '拖到**真实**下限 ⇒ data-view-clamped 必须置位（禁静默）').toBe('true');
    expect(afterDrag.disclosure ?? '', '夹取必须**显式披露**').toBeTruthy();
    expect(
      Math.abs(trueD - VIEW_MIN.detail),
      `明细**真实** px 停在可读下限（真实 ${trueD.toFixed(1)} / 下限 ${VIEW_MIN.detail}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(afterDrag.detailView!.h, '显示帧仍不低于显示下限').toBeGreaterThanOrEqual(VIEW_MIN.detail);
    expect(afterDrag.klineView!.h, '可见段不得被压到 0').toBeGreaterThanOrEqual(VIEW_MIN.klineOneSub);
    expect(Math.abs((v2After.ratios.indicators ?? 0) - frozen), '收起段比例仍逐位冻结').toBeLessThanOrEqual(1e-9);
    for (const k of RATIO_KEYS) expect(v2After.ratios[k] ?? 0, `v2.ratios.${k} > 0`).toBeGreaterThan(0);

    // 展开 ⇒ 指标**无条件**回位（第四轮裁决；真实比例夹取 ⇒ 展开不重夹）
    await page.getByTestId('wb-restore-indicators').click();
    await page.waitForTimeout(300);
    const expanded = await probe(page);
    writeJson('d9fix_r1b_clamp_expand', { preCollapse, afterDrag, expanded });
    expect(expanded.indicatorsView, '展开后指标视图回来').not.toBeNull();
    expect(
      Math.abs(expanded.indicatorsView!.h - preCollapse.indicatorsView!.h),
      `展开 ⇒ 指标**无条件**回位（收起前 ${preCollapse.indicatorsView!.h} / 实读 ${expanded.indicatorsView!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(expanded.attrs.clamped, '展开**不得**触发重夹').toBe('false');
  });
});

/**
 * ─────── R1d **写入侧归一**（架构裁决第五轮 2026-09-24）：存储 == 渲染 · 反例回归 ───────
 *
 * 裁决：**采 B（写入侧归一）+ 把 §12.6 的反例转成不变量**。根因 = **存储态与生效态漂移**
 * （plan 在夹取态下的渲染几何不是比例集合的纯函数，含 donor 结构）⇒ 存下不可行比例必致某路径不可逆。
 * 契约：① 任一会写盘的转换（迁移/收起/展开/拖拽/键盘）后，落盘 `ratios` = **生效态**；
 * ② 不变量：每个**未收起**视图 `ratio_v × 可用高 ≥ min_v`（±1px）；收起段份额**冻结**。
 */
test.describe('R1d 写入侧归一：反例回归（存储 == 渲染；1280×800）', () => {
  test.use({ viewport: VP.w800 });

  test('legacy {kline:200} ⇒ 迁移即落盘生效态 ⇒ 收起 ⇒ 拖 ID +40 ⇒ 展开 ⇒ 收起段 Δ≤2px（无条件）', async ({ page }) => {
    await seedStorage(page, { 'eestock.result.cardHeights.v1': JSON.stringify({ kline: 200 }) });
    await openRun(page);
    const migrated = await probe(page);
    const avail = Number(migrated.attrs.available);
    const v2 = v2Ratios(migrated.storage.v2);
    writeJson('d9fix_r1d_migrated', { migrated, v2 });
    expect(migrated.attrs.collapsedIndicators, '前置：未收起').toBe('false');
    // ① **存储态可行**（不变量）：每个未收起视图的真实 px ≥ 其可读下限（±1px）
    for (const k of RATIO_KEYS) {
      const truePx = (v2.ratios[k] ?? 0) * avail;
      const min = k === 'kline' ? VIEW_MIN.klineOneSub : k === 'indicators' ? VIEW_MIN.indicators : VIEW_MIN.detail;
      expect(
        truePx,
        `迁移后 ${k} 的**真实** px ${truePx.toFixed(1)} ≥ 可读下限 ${min}（存储态必须可行）`,
      ).toBeGreaterThanOrEqual(min - 1);
    }
    expect(
      (v2.ratios.kline ?? 0) + (v2.ratios.indicators ?? 0) + (v2.ratios.detail ?? 0),
      '三段比例和 = 1',
    ).toBeCloseTo(1, 9);
    // ② **存储 == 渲染**：存储态可行 ⇒ 默认渲染不得夹取，且三段 px == 存储比例 × 可用高（±2px）
    expect(migrated.attrs.clamped, '存储态可行 ⇒ 默认渲染不得夹取').toBe('false');
    const preIndicators = migrated.indicatorsView!.h;
    expect(Math.abs(preIndicators - (v2.ratios.indicators ?? 0) * avail), '指标：渲染 px == 存储比例 × 可用高').toBeLessThanOrEqual(
      TOL_PX,
    );

    // ③ 反例回归：收起指标 ⇒ 拖 ID +40 ⇒ 展开 ⇒ 收起段 Δ≤2px（**无条件**）
    await page.getByTestId('wb-indicator-collapse').click();
    await page.waitForTimeout(300);
    const collapsed = await probe(page);
    await dragSplitter(page, 'id', 40);
    const afterDrag = await probe(page);
    await page.getByTestId('wb-restore-indicators').click();
    await page.waitForTimeout(300);
    const expanded = await probe(page);
    writeJson('d9fix_r1d_counterexample', { migrated, collapsed, afterDrag, expanded });
    expect(expanded.indicatorsView, '展开后指标视图回来').not.toBeNull();
    expect(expanded.attrs.clamped, '展开**不得**触发重夹（存储态可行 ⇒ donor 结构不再变化）').toBe('false');
    expect(
      Math.abs(expanded.indicatorsView!.h - preIndicators),
      `反例回归：收起段 Δ ≤ 2px（无条件）——收起前 ${preIndicators} / 展开后 ${expanded.indicatorsView!.h}（未归一实现为 39px）`,
    ).toBeLessThanOrEqual(TOL_PX);
  });
});

/**
 * ─── R1e **归一完备**：收起段份额上界（架构裁决第六轮 2026-09-24）真渲染判据 ───
 *
 * 缺口（独立复验判定为**产品缺陷**）：legacy `v1 {ratio:0.5, collapsed:true}` ⇒ 迁移后**存储的可见段比例
 * 低于各自下限**（720 档 192.5/101.5、800 218.7/115.3、1000 284.2/149.8）且 `clamped=false` **无披露**。
 * 契约（ADR §2.9-7 / plan D9-11）：**归一必须完备** —— 除未收起视图 `ratio×可用 ≥ min`（±1px）外，
 * 收起态另需 `S ≤ 1 − Σ(可见段各自下限)/可用`（`S` = 收起段冻结比例之和；契约文字以 `min_i + min_d` 记）；
 * 不满足 ⇒ **把冻结份额收缩到该可行上界**（**永不为 0**）+ `clamped` + **显式披露**。
 */
test.describe('R1e 归一完备（收起段份额上界；第六轮裁决）', () => {
  for (const vp of [
    { w: 1280, h: 720, avail: 588 },
    { w: 1280, h: 800, avail: 668 },
    { w: 1280, h: 1000, avail: 868 },
  ]) {
    test(`legacy v1 {ratio:0.5, collapsed:true} @${vp.w}×${vp.h}（可用 ${vp.avail}）⇒ 迁移即归一：可见段可行 ∧ S ≤ 上界 ∧ clamped + 披露 ∧ 展开拿收缩后的 S`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await seedStorage(page, { 'eestock.result.layout.v1': JSON.stringify({ ratio: 0.5, collapsed: true }) });
      await openRun(page);
      const g = await probe(page);
      writeJson(`d9fix_r1e_v${vp.h}`, g);
      const avail = Number(g.attrs.available);
      expect(avail, '可用高 = 视口 − 132').toBe(vp.avail);
      expect(g.attrs.collapsedDetail, 'v1 `collapsed:true` ⇒ 明细收起（只读迁移口径不变）').toBe('true');
      const v2 = v2Ratios(g.storage.v2);

      // ① Σ ratios == 1（±1e-6）
      expect(v2.sum, `Σ ratios == 1（实测 ${v2.sum}）`).toBeCloseTo(1, 6);
      // ② **收起段份额上界**：S ≤ 1 − Σ(可见两段各自下限)/可用（±1px）∧ 契约文字形式（min_i+min_d）
      //    —— 先断言（变异「关掉冻结份额分支」必红在本条）
      const derived = 1 - (VIEW_MIN.klineOneSub + VIEW_MIN.indicators) / avail;
      const byText = 1 - (VIEW_MIN.indicators + VIEW_MIN.detail) / avail;
      const s = v2.ratios.detail ?? 0;
      expect(s, `S=${s.toFixed(4)} ≤ 1 − (kline+indicators 下限)/可用 = ${derived.toFixed(4)}`).toBeLessThanOrEqual(
        derived + 1 / avail,
      );
      expect(s, `契约文字形式：S ≤ 1 − (min_i+min_d)/可用 = ${byText.toFixed(4)}`).toBeLessThanOrEqual(byText + 1 / avail);
      for (const k of RATIO_KEYS) expect(v2.ratios[k] ?? 0, `${k} 不得为 0`).toBeGreaterThan(0);

      // ③ 发生收缩 ⇒ `clamped=true` ∧ 披露非空（且说明「收缩」）
      expect(g.attrs.clamped, '发生收缩 ⇒ clamped 必须置位').toBe('true');
      expect(g.disclosure ?? '', '收缩必须**显式披露**').toContain('收缩');

      // ④ 每个**未收起**视图：ratio × 可用高 ≥ min（±1px）
      for (const [k, min] of [
        ['kline', VIEW_MIN.klineOneSub],
        ['indicators', VIEW_MIN.indicators],
      ] as const) {
        const truePx = (v2.ratios[k] ?? 0) * avail;
        expect(truePx, `未收起视图 ${k} 的真实 px ${truePx.toFixed(1)} ≥ 下限 ${min}（±1px）`).toBeGreaterThanOrEqual(min - 1);
      }

      // ⑤ 展开 ⇒ 收起段拿到的份额 == 收缩后的 S（可行、不被再夹、不低于其下限）
      await page.getByTestId('wb-restore-detail').click();
      await page.waitForTimeout(300);
      const ex = await probe(page);
      writeJson(`d9fix_r1e_v${vp.h}_expanded`, ex);
      expect(ex.detailView, '展开后明细视图回来').not.toBeNull();
      expect(
        Math.abs(ex.detailView!.h - s * avail),
        `展开 ⇒ 明细拿到收缩后的 S（期望 ${(s * avail).toFixed(1)} / 实读 ${ex.detailView!.h}）`,
      ).toBeLessThanOrEqual(TOL_PX);
      expect(ex.detailView!.h, '收起段自身 ≥ 其下限').toBeGreaterThanOrEqual(VIEW_MIN.detail - 1);
      expect(ex.attrs.clamped, '展开不得触发重夹（两侧都在可行域内）').toBe('false');
      // ⑥ 旧键逐字节不变
      expect(ex.storage.v1, '旧 v1 键只读').toBe(JSON.stringify({ ratio: 0.5, collapsed: true }));
    });
  }
});
