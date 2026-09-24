/**
 * ADR-028 §2.7（**D7｜明细上下分层 + 跳转不动下栏**）—— 真渲染判据（本波新建）。
 *
 * 事实源：`design/01-architecture/adr/ADR-028-…§2.7 / §4 第 9 条`＋
 *        `design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md` §2 表 **D7-1..D7-5**
 *        （含 2026-09-23 裁决：D7-4④ **按视口分档**——强档「整卡可见 ∧ 下栏 40% 并立」/弱档「卡顶或主图顶对齐
 *        ∧ 蜡烛主图可见面积 ≥80% ∧ 与下栏零重叠」）。
 *
 * 判据（用户可见效果：滚动量 / 视口内可见性 / 计算样式 / 容器高，不得只断言元素存在）：
 *  - D7-1 `wb-chart-pane` 与 `wb-detail-pane` 均为 `overflow:auto` 的独立滚动容器；**页面无滚动**；
 *  - D7-2 四块（L1/L2、逐 bar、事件日志 + 既有 8 项绩效）**都在下栏**；`wb-detail-tabs` 默认「回合与逐笔」；
 *        切 tab 不改上栏状态；
 *  - D7-3 下栏默认 **40% 视口高**（±2px）；分隔条拖拽改变比例（clamp [0.15,0.85]）；折叠 ⇒ 上栏占满 +
 *        键盘可恢复入口；刷新后比例保持。**方向语义（2026-09-24 契约补齐）**：分隔条位于下栏**上沿** ⇒
 *        鼠标**向上 ⇒ 下栏变高 / 向下 ⇒ 下栏变矮**（位移 1:1）——本条目的拖拽方向已按契约翻正，
 *        两向判据见 `adr028-d8-splitter-direction.e2e.ts`；**卡片把手方向相反**（下沿），禁止互相套用；
 *  - D7-4 L1 与 L2 各一次跳转：①`window.scrollY` 不变 ②下栏 `scrollTop` 不变 ③下栏内目标行仍在其容器视口内
 *        ④K 线卡「可见」（按视口分档：见下）；
 *  - D7-5 跳转后 D4.1 高亮仍生效（`data-highlight-active=true` + 3s 回常态）。
 *
 * **强/弱档阈值（实测标定，2026-09-23）**：几何为 `上栏可用 = 0.6·H − 120`（H = 视口高）⇒ 整卡（520）可见
 * 需 `H ≥ 1067`；实测扫描（`raw/threshold_calibration.json`，脚本 `raw/calibrate_d7_threshold.mjs`）：
 * 1045/1050/1055/1060 ✗、1065 ✓（±1px 容差）、1070+ ✓（严格）⇒ 取 **1070** 为强档阈值
 * （`ADR028_D7_STRONG_MIN_H` 可覆盖）。强档用例用 1280×1400（用户真实视口级别）。
 *
 * 运行：
 *   cd web && E2E_BASE_URL=http://127.0.0.1:4175 timeout 900 \
 *     npx playwright test e2e/adr028-d7-detail-split.e2e.ts --reporter=list --retries=0 --workers=1
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028_D7_OUT ?? resolve(REPO, 'coder/evidence/20260923_result_d6d7/raw/d7');
const RUN_ID = process.env.ADR028_D7_RUN ?? 'sr_1789832517800_000006';

const DEFAULT_DETAIL_RATIO = 0.4;
const DETAIL_RATIO_MIN = 0.15;
const DETAIL_RATIO_MAX = 0.85;
const DETAIL_RATIO_TOL_PX = 2;
/** 弱档视口（playwright 默认 device 级别；整卡装不下 ⇒ 走弱档判据）。 */
const WEAK_VIEWPORT = { width: 1280, height: 800 };
/** 强档视口（≥ 实测阈值 1070；用户真实视口级别）。 */
const STRONG_VIEWPORT = { width: 1280, height: 1400 };
/** **实测标定**的强档阈值（见文件头；可用 env 覆盖）。 */
const STRONG_MIN_H = Number(process.env.ADR028_D7_STRONG_MIN_H ?? 1070);

/** klinecharts 实例捕获（与 `adr028-d6-kline-size.e2e.ts` 同法；D7-4④ 需读真身 candle pane 高）。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { setBarSpace?: unknown; convertToPixel?: unknown } | null;
    if (
      o != null &&
      typeof o === 'object' &&
      typeof o['setBarSpace'] === 'function' &&
      typeof o['convertToPixel'] === 'function'
    ) {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}
/** 弱档：蜡烛主图可见面积占比下限（ADR-028 §2.7 第 6 项弱档判据）。 */
const CANDLE_VISIBLE_MIN_RATIO = 0.8;

function writeJson(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

// ═══════════════════════ 页面侧探针（自包含；模块级常量必须内联） ═══════════════════════

function probeLayout() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  };
  const info = (el: HTMLElement | null) =>
    el == null
      ? null
      : {
          rect: rect(el),
          overflowY: getComputedStyle(el).overflowY,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
  const result = q('wb-result');
  const chartPane = q('wb-chart-pane');
  const splitter = q('wb-pane-splitter');
  const detailPane = q('wb-detail-pane');
  const klineCard = q('wb-kline-chart');
  const klineInner = q('kline-chart');
  let layoutStorage: string | null = null;
  try {
    layoutStorage = localStorage.getItem('eestock.result.layout.v1');
  } catch {
    /* ignore */
  }
  // 真身 pane 尺寸（蜡烛主图可见面积用）
  interface ChartLike {
    getSize?: (paneId?: string) => { height?: number } | null;
    getDataList?: () => unknown[];
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const cands = (w.__wbCharts ?? []).filter((c) => {
    try {
      return (c.getDataList?.() ?? []).length > 0;
    } catch {
      return false;
    }
  });
  const chosen = cands[0] ?? null;
  let candleH: number | null = null;
  try {
    candleH = chosen?.getSize?.('candle_pane')?.height ?? null;
  } catch {
    candleH = null;
  }
  const tabButtons = Array.from(document.querySelectorAll('[data-testid^="wb-tab-"]')).map((el) => ({
    testid: el.getAttribute('data-testid'),
    label: (el.textContent ?? '').trim(),
    selected: el.getAttribute('aria-selected') ?? '',
  }));
  return {
    viewportH: window.innerHeight,
    scrollY: window.scrollY,
    docScrollHeight: document.scrollingElement?.scrollHeight ?? null,
    docClientHeight: document.scrollingElement?.clientHeight ?? null,
    result: info(result),
    chartPane: info(chartPane),
    detailPane: info(detailPane),
    splitter: splitter ? { rect: rect(splitter), cursor: getComputedStyle(splitter).cursor, role: splitter.getAttribute('role') } : null,
    klineCard: rect(klineCard),
    klineInner: rect(klineInner),
    candleH,
    collapsed: result?.getAttribute('data-pane-collapsed') ?? null,
    ratio: result?.getAttribute('data-pane-ratio') ?? null,
    layoutStorage,
    tabButtons,
    blocks: {
      roundTrips: (() => {
        const el = q('wb-round-trips-table');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inChart: chartPane?.contains(el) ?? false } : null;
      })(),
      perBar: (() => {
        const el = q('wb-perbar-table');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inChart: chartPane?.contains(el) ?? false } : null;
      })(),
      eventLog: (() => {
        const el = q('wb-event-log');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inChart: chartPane?.contains(el) ?? false } : null;
      })(),
      metrics: (() => {
        const el = q('wb-metrics-table');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inChart: chartPane?.contains(el) ?? false } : null;
      })(),
      audit: (() => {
        const el = q('wb-audit-summary');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inChart: chartPane?.contains(el) ?? false } : null;
      })(),
    },
    highlight: {
      note: (() => {
        const el = q('wb-jump-highlight-note');
        return el ? { state: el.getAttribute('data-state'), text: (el.textContent ?? '').trim() } : null;
      })(),
      chartAttr: q('kline-chart')?.getAttribute('data-highlight-active') ?? null,
    },
  };
}

/** 目标元素相对**指定滚动容器**是否在其视口内（含 1px 容差）。 */
function scopedVisibility(arg: { rowTestId: string; paneTestId: string }) {
  const row = document.querySelector(`[data-testid="${arg.rowTestId}"]`) as HTMLElement | null;
  const pane = document.querySelector(`[data-testid="${arg.paneTestId}"]`) as HTMLElement | null;
  if (!row || !pane) return { found: !!row, pane: !!pane, visible: false, rowTop: null, paneTop: null, paneBottom: null };
  const r = row.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  return {
    found: true,
    pane: true,
    visible: r.top >= p.top - 1 && r.bottom <= p.bottom + 1,
    rowTop: Math.round(r.top),
    rowBottom: Math.round(r.bottom),
    paneTop: Math.round(p.top),
    paneBottom: Math.round(p.bottom),
  };
}

/** D7-4④（弱档/强档共用的几何测量）：卡与主图在上栏视口内的可见性 + 与下栏的重叠。 */
function jumpVisibility() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const chartPane = q('wb-chart-pane');
  const detailPane = q('wb-detail-pane');
  const card = q('wb-kline-chart');
  const inner = q('kline-chart');
  if (!chartPane || !card || !inner) return null;
  const p = chartPane.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const i = inner.getBoundingClientRect();
  const d = detailPane?.getBoundingClientRect() ?? null;
  interface ChartLike {
    getSize?: (paneId?: string) => { height?: number } | null;
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  let candleH: number | null = null;
  try {
    candleH = (w.__wbCharts ?? [])[0]?.getSize?.('candle_pane')?.height ?? null;
  } catch {
    candleH = null;
  }
  const candleTop = i.top; // klinecharts pane 自上而下排布 ⇒ 蜡烛 pane 顶 = 容器顶
  const candleBottom = candleH != null ? i.top + candleH : null;
  const visible = candleBottom != null ? Math.max(0, Math.min(candleBottom, p.bottom) - Math.max(candleTop, p.top)) : null;
  return {
    paneTop: Math.round(p.top),
    paneBottom: Math.round(p.bottom),
    cardTop: Math.round(c.top),
    cardBottom: Math.round(c.bottom),
    cardFullyVisible: c.top >= p.top - 1 && c.bottom <= p.bottom + 1,
    innerTop: Math.round(i.top),
    candleH,
    candleVisiblePx: visible == null ? null : Math.round(visible),
    candleVisibleRatio: visible == null || candleH == null || candleH <= 0 ? null : Number((visible / candleH).toFixed(3)),
    cardTopAligned: Math.abs(c.top - p.top) <= 2,
    candleTopAligned: Math.abs(i.top - p.top) <= 2,
    // 与下栏的**视觉**重叠须先按上栏裁剪卡区（卡布局盒可超出上栏，被 `overflow:auto` 裁掉）
    overlapDetailPx:
      d == null
        ? null
        : Math.max(0, Math.round(Math.min(c.bottom, p.bottom, d.bottom) - Math.max(c.top, p.top, d.top))),
    detailTop: d == null ? null : Math.round(d.top),
  };
}

// ═══════════════════════ 驱动 ═══════════════════════

async function openRun(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.addInitScript(installChartCapture);
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-detail-pane')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    return !!el && el.getBoundingClientRect().height > 40;
  });
  await page.waitForTimeout(2500);
}

async function reselect(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.getByTestId(`wb-run-select-${runId}`).click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await page.waitForTimeout(1500);
}

async function dragSplitter(page: Page, dy: number): Promise<void> {
  const box = await page.getByTestId('wb-pane-splitter').boundingBox();
  expect(box, '分隔条必须可命中').not.toBeNull();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / 6);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** 展开 L2 并让目标行就位（跳转判据的前置条件；**不改**下栏滚动后再度量）。 */
async function prepareL2(page: Page, rtSeq = 1): Promise<void> {
  await page.getByTestId(`wb-rt-detail-${rtSeq}`).click();
  await expect(page.getByTestId(`wb-l2-row-${rtSeq}-0`)).toBeVisible();
  await page.waitForTimeout(300);
}

/** D7-4 公共判据（L1/L2 各一次）：①②③ + ④（分档）。 */
async function runJumpChecks(page: Page, args: { jumpTestId: string; rowTestId: string; tier: 'strong' | 'weak'; tag: string }) {
  // 前置：把目标行**在下栏内**摆到容器顶下方 80px 处（sticky tab 条之下列）
  //  ⇒ 同时满足「下栏 scrollTop 非零（判据有鉴别力）」与「目标行原本可见」（D7-4③ 的前置）
  await page.evaluate((rowId) => {
    const pane = document.querySelector('[data-testid="wb-detail-pane"]') as HTMLElement | null;
    const row = document.querySelector(`[data-testid="${rowId}"]`) as HTMLElement | null;
    if (!pane || !row) return;
    const pr = pane.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    pane.scrollTop = Math.max(0, pane.scrollTop + (rr.top - pr.top) - 80);
  }, args.rowTestId);
  await page.waitForTimeout(250);
  const jump = page.getByTestId(args.jumpTestId);
  await jump.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const before = await page.evaluate(probeLayout);
  expect(before.detailPane!.scrollTop, '前置条件：下栏必须已滚动（否则「不变」无鉴别力）').toBeGreaterThan(0);
  const rowBefore = await page.evaluate(scopedVisibility, { rowTestId: args.rowTestId, paneTestId: 'wb-detail-pane' });
  expect(rowBefore.visible, `前置条件：${args.rowTestId} 必须原本就在下栏视口内`).toBe(true);
  const visBefore = await page.evaluate(jumpVisibility);

  await jump.click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(probeLayout);
  const rowAfter = await page.evaluate(scopedVisibility, { rowTestId: args.rowTestId, paneTestId: 'wb-detail-pane' });
  const visAfter = await page.evaluate(jumpVisibility);
  writeJson(`d7_${args.tag}`, { tier: args.tier, before, after, rowBefore, rowAfter, visBefore, visAfter });

  // ①②③（分档无关）
  expect(after.scrollY, 'D7-4① 跳转后 window.scrollY 不变').toBe(before.scrollY);
  expect(after.detailPane!.scrollTop, 'D7-4② 跳转后下栏 scrollTop 不变（B1-1 完全不动）').toBe(before.detailPane!.scrollTop);
  expect(rowAfter.visible, 'D7-4③ 跳转后目标行仍在下栏容器视口内').toBe(true);
  // ④ 分档
  if (args.tier === 'strong') {
    expect(visAfter!.cardFullyVisible, `D7-4④（强档：视口 ${after.viewportH} ≥ ${STRONG_MIN_H}）整卡必须完整可见`).toBe(true);
    const expectedDetail = Math.round(after.viewportH * DEFAULT_DETAIL_RATIO);
    expect(
      Math.abs(after.detailPane!.rect!.h - expectedDetail),
      `D7-4④（强档）下栏 40% 视口高必须并立（期望 ${expectedDetail}±${DETAIL_RATIO_TOL_PX}，实读 ${after.detailPane!.rect!.h}）`,
    ).toBeLessThanOrEqual(DETAIL_RATIO_TOL_PX);
    expect(after.viewportH).toBeGreaterThanOrEqual(STRONG_MIN_H);
  } else {
    expect(
      visAfter!.cardFullyVisible || visAfter!.cardTopAligned || visAfter!.candleTopAligned,
      `D7-4④（弱档）卡顶或蜡烛主图顶必须与上栏视口顶对齐（卡顶 ${visAfter!.cardTop} / 主图顶 ${visAfter!.innerTop} / 上栏顶 ${visAfter!.paneTop}）`,
    ).toBe(true);
    expect(
      visAfter!.candleVisibleRatio!,
      `D7-4④（弱档）蜡烛主图在上栏内的可见面积占比 ≥${CANDLE_VISIBLE_MIN_RATIO}（实测 ${visAfter!.candleVisibleRatio}，${visAfter!.candleVisiblePx}/${visAfter!.candleH}px）`,
    ).toBeGreaterThanOrEqual(CANDLE_VISIBLE_MIN_RATIO);
    expect(visAfter!.overlapDetailPx, 'D7-4④（弱档）K 线卡与下栏零重叠').toBeLessThanOrEqual(1);
  }
  return { before, after, visAfter };
}

// ═══════════════════════ 判据 ═══════════════════════

test.describe('D7-1/D7-2/D7-3 + D7-4 弱档（视口 1280×800 < 阈值）', () => {
  test.use({ viewport: WEAK_VIEWPORT });

  test('D7-1/D7-3：分层成立（两个独立滚动容器 + 页面无滚动）；下栏默认 40% 视口高；可拖拽/折叠/记忆', async ({
    page,
  }) => {
    await openRun(page);
    const p0 = await page.evaluate(probeLayout);
    writeJson('d7_t1_default', p0);

    expect(p0.chartPane, '上栏 wb-chart-pane 必须存在').not.toBeNull();
    expect(p0.detailPane, '下栏 wb-detail-pane 必须存在').not.toBeNull();
    expect(p0.chartPane!.overflowY, `D7-1 上栏必须自身滚动（computed ${p0.chartPane!.overflowY}）`).toBe('auto');
    expect(p0.detailPane!.overflowY, `D7-1 下栏必须自身滚动（computed ${p0.detailPane!.overflowY}）`).toBe('auto');
    expect(p0.chartPane!.scrollHeight, 'D7-1 上栏内容必须高于容器（否则「收敛到上栏」无从谈起）').toBeGreaterThan(
      p0.chartPane!.clientHeight + 1,
    );
    expect(p0.result!.overflowY, 'D7-1 页面级 wb-result 不得再是滚动容器').not.toBe('auto');
    expect(
      p0.docScrollHeight!,
      `D7-1 页面不得滚动（scrollHeight ${p0.docScrollHeight} ≤ innerHeight ${p0.viewportH}）`,
    ).toBeLessThanOrEqual(p0.viewportH + 1);
    expect(p0.scrollY, 'D7-1 页面 scrollY = 0').toBe(0);

    const expectedDetail = Math.round(p0.viewportH * DEFAULT_DETAIL_RATIO);
    expect(
      p0.detailPane!.rect!.h,
      `D7-3 下栏默认 40% 视口高（期望 ${expectedDetail}±${DETAIL_RATIO_TOL_PX}，实读 ${p0.detailPane!.rect!.h}）`,
    ).toBeGreaterThanOrEqual(expectedDetail - DETAIL_RATIO_TOL_PX);
    expect(p0.detailPane!.rect!.h).toBeLessThanOrEqual(expectedDetail + DETAIL_RATIO_TOL_PX);
    expect(p0.splitter, 'D7-3 分隔条必须存在且可拖拽（role=separator）').not.toBeNull();
    expect(p0.splitter!.role).toBe('separator');

    // 拖拽分隔条 ⇒ 比例变化（并验证 clamp）
    // ── 方向语义重锚（2026-09-24 契约补齐；**按契约推导，不按实现输出倒推**）────────────────
    // 旧契约缺口：ADR §2.7-3 原文只写「可拖拽」、**从未写方向**，本条曾写 `dragSplitter(page, 90)`
    //   （`dy > 0` = 鼠标**向下**）却断言「下栏变高」⇒ 与「分隔条位于下栏**上沿**」的几何相反，
    //   把错实现（`detailPx = startDetail + Δy`）当正确固定了下来。
    // 新契约：分隔条在下栏**上沿** ⇒ 向上（Δy < 0）⇒ 下栏**变高**；向下（Δy > 0）⇒ 下栏**变矮**。
    // 选择：**保留「变高/变矮」文案与 clamp 覆盖，只把拖拽方向翻正**（两处一起翻：
    //   `+90` → `−90`，`−4000` → `+4000`）——改动最小、原判据意图（先上限 clamp 再下限 clamp）不变；
    //   方向本身的正反两向判据见专门规格 `adr028-d8-splitter-direction.e2e.ts`（D8）。
    const beforeRatio = Number(p0.ratio);
    await dragSplitter(page, -90);
    const dragged = await page.evaluate(probeLayout);
    writeJson('d7_t1_splitter', { before: p0, dragged });
    expect(dragged.detailPane!.rect!.h, 'D7-3 上拖 −90 ⇒ 下栏变高').toBeGreaterThan(p0.detailPane!.rect!.h + 60);
    expect(dragged.chartPane!.rect!.h, 'D7-3 上栏相应变矮').toBeLessThan(p0.chartPane!.rect!.h - 60);
    expect(Number(dragged.ratio), 'D7-3 data-pane-ratio 必须随拖拽变化').toBeGreaterThan(beforeRatio);
    expect(Number(dragged.ratio), 'D7-3 比例上限 0.85').toBeLessThanOrEqual(DETAIL_RATIO_MAX);
    await dragSplitter(page, 4000);
    const lowClamp = await page.evaluate(probeLayout);
    writeJson('d7_t1_low_clamp', lowClamp);
    expect(Number(lowClamp.ratio), `D7-3 比例下限 ${DETAIL_RATIO_MIN}（实读 ${lowClamp.ratio}）`).toBeGreaterThanOrEqual(
      DETAIL_RATIO_MIN,
    );
    expect(Number(lowClamp.ratio)).toBeLessThanOrEqual(DETAIL_RATIO_MIN + 0.02);

    // 折叠 ⇒ 上栏占满 + 键盘可恢复入口；展开 ⇒ 比例记忆恢复
    const ratioBeforeCollapse = Number(lowClamp.ratio);
    await page.getByTestId('wb-detail-collapse').click();
    await page.waitForTimeout(250);
    const collapsed = await page.evaluate(probeLayout);
    writeJson('d7_t1_collapsed', collapsed);
    expect(collapsed.collapsed, 'D7-3 折叠态必须可观测（data-pane-collapsed=true）').toBe('true');
    expect(collapsed.detailPane, 'D7-3 折叠后下栏不占位').toBeNull();
    expect(
      collapsed.chartPane!.rect!.h,
      `D7-3 折叠后上栏占满（${collapsed.chartPane!.rect!.h} > 折叠前 ${lowClamp.chartPane!.rect!.h}）`,
    ).toBeGreaterThan(lowClamp.chartPane!.rect!.h);
    const expand = page.getByTestId('wb-detail-expand');
    await expect(expand, 'D7-3 折叠后必须保留可恢复入口').toBeVisible();
    await expand.focus();
    await expect(expand, 'D7-3 恢复入口必须键盘可达').toBeFocused();
    await expand.click();
    await page.waitForTimeout(250);
    const expanded = await page.evaluate(probeLayout);
    writeJson('d7_t1_restored', expanded);
    expect(Number(expanded.ratio), 'D7-3 展开后比例记忆恢复').toBeCloseTo(ratioBeforeCollapse, 2);

    // 刷新 ⇒ 比例保持（结果页独立 key）
    const keptRatio = Number(expanded.ratio);
    await page.reload();
    await reselect(page);
    const afterReload = await page.evaluate(probeLayout);
    writeJson('d7_t1_after_reload', { keptRatio, afterReload });
    expect(Number(afterReload.ratio), 'D7-3 刷新后比例保持').toBeCloseTo(keptRatio, 2);
  });

  test('D7-2：四块都在下栏；默认 tab = 回合与逐笔；切 tab 不改上栏状态', async ({ page }) => {
    await openRun(page);
    const p0 = await page.evaluate(probeLayout);
    writeJson('d7_t2_blocks', p0);

    expect(p0.tabButtons.length, 'wb-detail-tabs 必须有多枚 tab').toBeGreaterThanOrEqual(3);
    const selected = p0.tabButtons.filter((t) => t.selected === 'true');
    expect(selected.length, 'D7-2 默认恰一个 tab 选中').toBe(1);
    expect(selected[0]!.testid, 'D7-2 默认 tab = 回合与逐笔（wb-tab-trades）').toBe('wb-tab-trades');

    expect(p0.blocks.roundTrips, 'D7-2 L1 回合表必须存在').not.toBeNull();
    expect(p0.blocks.roundTrips!.inDetail, 'D7-2 L1 回合表必须在**下栏**内').toBe(true);
    expect(p0.blocks.roundTrips!.inChart, 'D7-2 L1 回合表不得留在上栏').toBe(false);
    expect(p0.blocks.audit?.inDetail, 'D7-2 审计摘要必须在下栏内').toBe(true);

    const upperBefore = { card: p0.klineCard, ratio: p0.ratio };
    for (const key of ['perbar', 'events', 'metrics'] as const) {
      await page.getByTestId(`wb-tab-${key}`).click();
      await page.waitForTimeout(300);
      const p = await page.evaluate(probeLayout);
      if (key === 'perbar') {
        expect(p.blocks.perBar, 'D7-2 逐 bar 明细必须存在').not.toBeNull();
        expect(p.blocks.perBar!.inDetail, 'D7-2 逐 bar 明细必须在**下栏**内').toBe(true);
        expect(p.blocks.perBar!.inChart, 'D7-2 逐 bar 明细不得留在上栏').toBe(false);
      }
      if (key === 'events') {
        expect(p.blocks.eventLog, 'D7-2 事件日志必须存在').not.toBeNull();
        expect(p.blocks.eventLog!.inDetail, 'D7-2 事件日志必须在**下栏**内').toBe(true);
        expect(p.blocks.eventLog!.inChart, 'D7-2 事件日志不得留在上栏').toBe(false);
      }
      if (key === 'metrics') {
        expect(p.blocks.metrics, '既有 8 项绩效不得丢失（禁静默有损）').not.toBeNull();
        expect(p.blocks.metrics!.inDetail, '8 项绩效必须在**下栏**内').toBe(true);
      }
      expect(p.klineCard!.h, 'D7-2 切 tab 不得改变上栏 K 线卡高').toBe(upperBefore.card!.h);
      expect(Number(p.ratio), 'D7-2 切 tab 不得改变上下比例').toBeCloseTo(Number(upperBefore.ratio), 3);
    }

    await page.getByTestId('wb-tab-trades').click();
    await page.waitForTimeout(300);
    const back = await page.evaluate(probeLayout);
    expect(back.blocks.roundTrips!.inDetail, 'D7-2 回到默认 tab 后 L1 仍在下栏').toBe(true);

    await prepareL2(page);
    const l2InDetail = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="wb-l2-row-1-0"]');
      const pane = document.querySelector('[data-testid="wb-detail-pane"]');
      return !!row && !!pane && pane.contains(row);
    });
    expect(l2InDetail, 'D7-2 L2 逐笔明细必须在**下栏**内').toBe(true);
  });

  test('D7-4/D7-5（弱档）：L1/L2 跳转不动下栏；K 线可见（卡顶/主图顶对齐 + 主图可见 ≥80% + 与下栏零重叠）；高亮仍生效', async ({
    page,
  }) => {
    await openRun(page);
    await prepareL2(page);

    const l2 = await runJumpChecks(page, { jumpTestId: 'wb-l2-jump-1-0', rowTestId: 'wb-l2-row-1-0', tier: 'weak', tag: 't3_l2_jump' });
    expect(l2.visAfter!.cardFullyVisible, '字面读数：弱档整卡不可见（供复核）').toBe(false);
    // D7-5 高亮仍生效
    expect(l2.after.highlight.note?.state, 'D7-5 高亮状态必须 ok（不得因分层丢失）').toBe('ok');
    expect(l2.after.highlight.chartAttr, 'D7-5 K 线实例必须处于高亮激活态').toBe('true');

    await runJumpChecks(page, { jumpTestId: 'wb-rt-jump-1', rowTestId: 'wb-rt-row-1', tier: 'weak', tag: 't3_l1_jump' });

    // D7-5 高亮 3s 回常态
    await expect
      .poll(async () => (await page.evaluate(probeLayout)).highlight.chartAttr, { timeout: 6000, intervals: [500] })
      .toBe('false');
  });
});

test.describe('D7-4④ 强档（视口 1280×1400 ≥ 实测阈值；整卡可见 ∧ 下栏 40% 并立）', () => {
  test.use({ viewport: STRONG_VIEWPORT });

  test('强档：L2 与 L1 跳转后整卡完整可见，且下栏仍为 40% 视口高', async ({ page }) => {
    await openRun(page);
    const p0 = await page.evaluate(probeLayout);
    expect(p0.viewportH, '强档视口必须 ≥ 实测阈值').toBeGreaterThanOrEqual(STRONG_MIN_H);
    const expectedDetail = Math.round(p0.viewportH * DEFAULT_DETAIL_RATIO);
    expect(Math.abs(p0.detailPane!.rect!.h - expectedDetail)).toBeLessThanOrEqual(DETAIL_RATIO_TOL_PX);

    await prepareL2(page);
    await runJumpChecks(page, { jumpTestId: 'wb-l2-jump-1-0', rowTestId: 'wb-l2-row-1-0', tier: 'strong', tag: 't4_l2_jump_strong' });
    await runJumpChecks(page, { jumpTestId: 'wb-rt-jump-1', rowTestId: 'wb-rt-row-1', tier: 'strong', tag: 't4_l1_jump_strong' });
  });
});
