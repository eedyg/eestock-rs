/**
 * ADR-028 §2.6（**D6｜K 线卡尺寸与主视图优先分配**）—— 真渲染判据（本波新建）。
 *
 * 事实源：`design/01-architecture/adr/ADR-028-…§2.6 / §4 第 8 条`＋
 *        `design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md` §2 表 **D6-1..D6-7**
 *        （含 2026-09-23「有效下限」裁决修正）＋ §4 边界。
 *
 * 判据（每条必须是**用户可见效果**：高度 / 计算样式 / 真身 pane 尺寸，不得只断言元素存在）：
 *  - D6-1 无记忆值时 `wb-kline-chart` 高 == 520；
 *  - D6-2 预设 S/M/L ⇒ 260/420/560（受 min/max 夹取）；
 *  - D6-3 默认 520 态：蜡烛 pane ≥320 ∧ 副图合计 ≤120 ∧ 卡头 ≤48；
 *  - D6-4 拖到**有效下限** ⇒ 卡高 ≥200 ∧ 主图 ≥160 ∧ 副图 ≥30；**引擎 pane 分隔条**越界同样 clamp；
 *  - D6-5 把手可命中带 ≥12px ∧ **悬停前后计算样式 background-color 变化且非全透明**；
 *  - D6-6 拖 +N ⇒ 卡高与 klinecharts 容器高**双变化**；刷新保持；双击标题复位 520；
 *  - D6-7 高度写**结果页独立 key**（`eestock.result.cardHeights.v1`）；不碰看板 key / 旧 key。
 *
 * 真身读数一律取 **klinecharts 实例**（`getSize(paneId)` / `getPaneOptions()`，经 `Map.prototype.set` 捕获），
 * 页面 `data-*`（`data-kline-pane-height` / `data-card-header-height`）仅作交叉校验。
 *
 * 运行（沙箱预览，**不碰线上 web/dist**）：
 *   cd web && E2E_BASE_URL=http://127.0.0.1:4174 timeout 900 \
 *     npx playwright test e2e/adr028-d6-kline-size.e2e.ts --reporter=list --retries=0 --workers=1
 * 原始读数落盘：`ADR028_D6_OUT`（默认 `coder/evidence/20260923_result_d6d7/raw/d6`）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028_D6_OUT ?? resolve(REPO, 'coder/evidence/20260923_result_d6d7/raw/d6');
const RUN_ID = process.env.ADR028_D6_RUN ?? 'sr_1789832517800_000006';

// ── 契约常量（ADR-028 §2.6；测试内自持，**不 import 产品模块**，避免「按实现倒推」）──
const DEFAULT_CARD_PX = 520;
const CARD_MIN_PX = 200;
const CARD_MAX_DELTA = 200; // max = 视口高 − 200
const PRESETS = { s: 260, m: 420, l: 560 } as const;
const CANDLE_MIN_PX = 160;
const SUB_PANE_MIN_PX = 30;
const SUB_PANE_TOTAL_MAX_PX = 120;
const CANDLE_PREFERRED_MIN_PX = 320;
const HEADER_MAX_PX = 48;
const HANDLE_MIN_PX = 12;
const X_AXIS_PX = 26;
const SEP_PX = 1;
/** 卡片自身边框占用（上/下各 1px；真身实测：卡 237 − 卡头 20 − klinecharts 容器 215 = 2）。 */
const CARD_BORDER_PX = 2;
const RESULT_KEY = 'eestock.result.cardHeights.v1';
const LEGACY_KEY = 'eestock.wb.result.chartConfig.v1';
const DASHBOARD_KEY = 'eestock.dashboard.layout.v1';

function writeJson(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

// ═══════════════════════ 页面侧探针（自包含） ═══════════════════════

/** klinecharts 实例捕获（沿用 `adr028-d5-resize-indicators.e2e.ts` 约定）。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { pitch?: unknown; setBarSpace?: unknown; convertToPixel?: unknown } | null;
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

/** 一次读全：卡片几何 + 真身 pane 尺寸/选项 + 把手 + localStorage。 */
function probeDom() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  interface ChartLike {
    getDataList?: () => Array<{ timestamp: number }>;
    getSize?: (paneId?: string, position?: string) => { width?: number; height?: number } | null;
    getPaneOptions?: (id?: string) => unknown;
    getIndicators?: () => Array<Record<string, unknown>>;
  }
  const card = q('wb-kline-chart');
  const klineInner = q('kline-chart');
  const handle = q('wb-card-resize-kline');
  const header = card?.querySelector('[data-testid="wb-kline-card-header"]') as HTMLElement | null;
  // 真身：选「容器宽度与 kline 内层最接近 且 getDataList 非空」的实例
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const target = klineInner ? klineInner.getBoundingClientRect().width : 0;
  const cands = (w.__wbCharts ?? []).map((c) => {
    let n = -1;
    let width = -1;
    try {
      n = (c.getDataList?.() ?? []).length;
      width = c.getSize?.()?.width ?? -1;
    } catch {
      /* ignore */
    }
    return { c, n, width };
  });
  const withData = cands.filter((x) => x.n > 0);
  const chosen =
    withData.length > 0
      ? withData.reduce((a, b) => (Math.abs(a.width - target) <= Math.abs(b.width - target) ? a : b))
      : null;
  let paneOpts: Array<{ id: string; height: number; minHeight: number; dragEnabled: boolean }> = [];
  const paneSizes: Record<string, number | null> = {};
  if (chosen) {
    try {
      const raw = chosen.c.getPaneOptions?.();
      const arr = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      paneOpts = arr.map((p) => ({
        id: String(p['id']),
        height: Number(p['height']),
        minHeight: Number(p['minHeight']),
        dragEnabled: Boolean(p['dragEnabled']),
      }));
    } catch {
      /* ignore */
    }
    for (const p of paneOpts) {
      try {
        paneSizes[p.id] = chosen.c.getSize?.(p.id)?.height ?? null;
      } catch {
        paneSizes[p.id] = null;
      }
    }
  }
  const subPaneIds = paneOpts.map((p) => p.id).filter((id) => id !== 'candle_pane' && id !== 'x_axis_pane');
  const subSizes = subPaneIds.map((id) => paneSizes[id]);
  const subTotal =
    subSizes.length > 0 && subSizes.every((v) => typeof v === 'number')
      ? subSizes.reduce((a, b) => (a as number) + (b as number), 0 as number)
      : null;

  let ls: Record<string, string | null> = {};
  try {
    ls = {
      'eestock.result.cardHeights.v1': localStorage.getItem('eestock.result.cardHeights.v1'),
      'eestock.wb.result.chartConfig.v1': localStorage.getItem('eestock.wb.result.chartConfig.v1'),
      'eestock.dashboard.layout.v1': localStorage.getItem('eestock.dashboard.layout.v1'),
    };
  } catch {
    /* ignore */
  }

  return {
    card: {
      rect: rect(card),
      inlineHeight: card?.style.height || null,
      dataCardHeaderHeight: card?.getAttribute('data-card-header-height') ?? null,
      dataKlinePaneHeight: card?.getAttribute('data-kline-pane-height') ?? null,
      attrHeaderPx: header ? Math.round(header.getBoundingClientRect().height) : null,
    },
    klineInner: rect(klineInner),
    headerH: header ? header.getBoundingClientRect().height : null,
    panes: paneOpts,
    paneSizes,
    subPaneIds,
    subTotal,
    candleH: paneSizes['candle_pane'] ?? null,
    xAxisH: paneSizes['x_axis_pane'] ?? null,
    handle: handle
      ? {
          rect: rect(handle),
          cursor: getComputedStyle(handle).cursor,
          zIndex: getComputedStyle(handle).zIndex,
          bg: getComputedStyle(handle).backgroundColor,
        }
      : null,
    storage: ls,
    docScroll: {
      scrollY: window.scrollY,
      scrollingElScrollHeight: document.scrollingElement?.scrollHeight ?? null,
      innerHeight: window.innerHeight,
    },
  };
}

/** 把手命中带扫描：卡底向上逐像素 `elementFromPoint` 判定命中把手的最长连续带。 */
function handleBandScan() {
  const card = document.querySelector('[data-testid="wb-kline-chart"]') as HTMLElement | null;
  const handle = document.querySelector('[data-testid="wb-card-resize-kline"]') as HTMLElement | null;
  if (!card || !handle) return { ok: false, bandPx: 0, rows: [] as Array<{ dy: number; hit: string }> };
  const r = card.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const rows: Array<{ dy: number; hit: string }> = [];
  let band = 0;
  let maxBand = 0;
  for (let y = Math.round(r.bottom - 24); y <= Math.round(r.bottom + 2); y++) {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const closest = el?.closest('[data-card-resize]') as HTMLElement | null;
    const hit = closest === handle ? 'handle' : el ? `${el.tagName}${el.dataset['testid'] ? `[${el.dataset['testid']}]` : ''}` : 'none';
    rows.push({ dy: y - Math.round(r.bottom), hit });
    if (hit === 'handle') {
      band += 1;
      maxBand = Math.max(maxBand, band);
    } else {
      band = 0;
    }
  }
  return { ok: true, bandPx: maxBand, rows };
}

/** 引擎 pane 分隔条（DOM：宽度≈卡宽、高≈7、cursor=ns-resize 的层）。 */
function findPaneSeparator() {
  const klineInner = document.querySelector('[data-testid="kline-chart"]');
  const host = (klineInner?.querySelector('div') as HTMLElement | null) ?? (klineInner as HTMLElement | null);
  if (!host) return null;
  const all = Array.from(host.querySelectorAll('div')) as HTMLElement[];
  const cands = all
    .map((el) => ({ el, r: el.getBoundingClientRect(), cursor: getComputedStyle(el).cursor }))
    .filter((x) => x.cursor === 'ns-resize' && x.r.height >= 4 && x.r.height <= 12 && x.r.width > 100);
  if (cands.length === 0) return null;
  const { el, r } = cands[0]!;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), el };
}

// ═══════════════════════ 驱动 ═══════════════════════

async function openRun(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-kline-chart')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    return !!el && el.getBoundingClientRect().height > 40;
  });
  await page.waitForTimeout(2500); // K 线/曲线取数（既定约定，非断言）
}

/**
 * 把手可达性前置（**物理约束**，见报告 §残留）：
 * 默认下栏 = 40% 视口高 ⇒ 上栏可用高（900 ⇒ ≈436px）**小于卡高 520** ⇒ 卡底 12px 把手落在上栏
 * 可视区之外（`elementFromPoint` 命中下栏），真鼠标拖拽会「什么都没发生」。
 * 故与把手交互前先收起下栏（产品既有能力：`wb-detail-collapse`）⇒ 上栏占满、整卡可见。
 */
async function ensureCardFullyVisible(page: Page): Promise<void> {
  const collapse = page.getByTestId('wb-detail-collapse');
  if ((await collapse.count()) > 0) {
    await collapse.click();
    await page.waitForTimeout(250);
  }
}

async function reselect(page: Page, runId: string = RUN_ID): Promise<void> {
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await select.click();
  await expect(page.getByTestId('wb-kline-chart')).toBeVisible();
  await page.waitForTimeout(1500);
}

/** 打开指标浮层（卡头瘦身后指标勾选在浮层内）。 */
async function openIndicatorMenu(page: Page): Promise<void> {
  const menu = page.getByTestId('wb-indicator-menu');
  if ((await menu.count()) === 0) return;
  await menu.click();
  await expect(page.getByTestId('wb-indicator-toggles')).toBeVisible();
}

/**
 * 拖卡片把手（dy > 0 = 变高）。
 * 指针终点**夹在视口内**（越出视口的 CDP 鼠标事件不可靠 ⇒ 会静默「什么都没发生」）。
 * 分段移动保证 mousemove 连续（真身拖拽路径）。
 */
async function dragHandle(page: Page, dy: number): Promise<void> {
  const handle = page.getByTestId('wb-card-resize-kline');
  const box = await handle.boundingBox();
  expect(box, '把手必须可命中（boundingBox 非空）').not.toBeNull();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

// ═══════════════════════ 判据 ═══════════════════════

// 视口口径（契约推导）：`max = 视口高 − 200`（ADR-028 §2.6 第 2 项）⇒ 要验证允许的预设组 S/M/L
// 与「拖 +N 双变化」，视口高必须 > 760（否则 520 即等于 max，向上增长无空间）。
// playwright 项目默认 device 视口 1280×720 会把这组判据全部压成常量，故本规格显式抬到 1280×900。
test.use({ viewport: { width: 1280, height: 900 } });

test.describe('ADR-028 D6（真渲染）', () => {
  test('D6-1/D6-3/D6-5：默认 520 ⇒ 主图 ≥320 ∧ 副图合计 ≤120 ∧ 卡头 ≤48；把手 ≥12px 且悬停可见', async ({
    page,
  }) => {
    await page.addInitScript(installChartCapture);
    await openRun(page);

    const p0 = await page.evaluate(probeDom);
    expect(p0.card.rect, 'K 线卡必须存在').not.toBeNull();
    // D6-1：默认卡高 520
    expect(p0.card.rect!.h, `D6-1 默认卡高（实读 ${p0.card.rect!.h}）`).toBe(DEFAULT_CARD_PX);
    // D6-3：卡头 ≤48
    expect(p0.headerH, `D6-3 卡头高（实读 ${p0.headerH}）`).not.toBeNull();
    expect(p0.headerH!, `D6-3 卡头 ≤${HEADER_MAX_PX}（实读 ${p0.headerH}）`).toBeLessThanOrEqual(HEADER_MAX_PX);
    // D6-3：主图 ≥320（真身 pane 高）
    expect(p0.candleH, 'D6-3 蜡烛 pane 高必须可读（真身 getSize）').not.toBeNull();
    expect(p0.candleH!, `D6-3 蜡烛主图 ≥${CANDLE_PREFERRED_MIN_PX}（实读 ${p0.candleH}）`).toBeGreaterThanOrEqual(
      CANDLE_PREFERRED_MIN_PX,
    );
    // D6-3：副图合计 ≤120
    expect(p0.subTotal, 'D6-3 副图合计必须可读').not.toBeNull();
    expect(p0.subTotal!, `D6-3 副图合计 ≤${SUB_PANE_TOTAL_MAX_PX}（实读 ${p0.subTotal}）`).toBeLessThanOrEqual(
      SUB_PANE_TOTAL_MAX_PX,
    );
    // 观测性存在性（`data-kline-pane-height` 为辅助回查；**判据以真身 getSize 读数为准**）
    expect(Number(p0.card.dataKlinePaneHeight), '观测性 data-kline-pane-height 必须存在且为正').toBeGreaterThan(0);

    // D6-5：把手可命中带 ≥12px（先收起下栏 ⇒ 整卡可见、把手可命中；物理约束见 ensureCardFullyVisible）
    await ensureCardFullyVisible(page);
    const band = await page.evaluate(handleBandScan);
    expect(band.ok, '把手与卡片必须存在').toBe(true);
    expect(band.bandPx, `D6-5 把手连续可命中带（逐像素扫描，实读 ${band.bandPx}px）`).toBeGreaterThanOrEqual(
      HANDLE_MIN_PX,
    );
    const before = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-testid="wb-card-resize-kline"]') as Element).backgroundColor,
    );
    await page.getByTestId('wb-card-resize-kline').hover();
    await page.waitForTimeout(150);
    const after = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-testid="wb-card-resize-kline"]') as Element).backgroundColor,
    );
    writeJson('d6_t1_default_and_handle', { p0, band, handleHover: { before, after } });
    expect(after, `D6-5 悬停后计算样式必须变化（前 ${before}）`).not.toBe(before);
    const alpha = (c: string): number => {
      const m = c.match(/rgba?\(([^)]+)\)/) ?? c.match(/color\(srgb ([^)]+)\)/);
      if (!m) return c === 'transparent' ? 0 : 1;
      const parts = m[1]!.split(/[\s,/]+/).filter((s) => s.length > 0);
      // color(srgb r g b / a) 与 rgba(r,g,b,a) 两种序列化都取最后一段（无 alpha ⇒ 1）
      if (c.startsWith('color(')) return parts.length >= 4 ? Number(parts[3]) : 1;
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    expect(alpha(after), `D6-5 悬停后不得全透明（${after}）`).toBeGreaterThan(0);
    expect(alpha(before), `D6-5 默认必须透明（否则「变化」无意义）（${before}）`).toBe(0);
  });

  test('D6-2/D6-6：预设 S/M/L；拖拽双变化；刷新保持；双击标题复位 520', async ({ page }) => {
    await page.addInitScript(installChartCapture);
    await openRun(page);

    // D6-2 三个预设
    const presetReads: Record<string, number> = {};
    for (const key of ['s', 'm', 'l'] as const) {
      await page.getByTestId(`wb-kline-preset-${key}`).click();
      await page.waitForTimeout(200);
      const p = await page.evaluate(probeDom);
      presetReads[key] = p.card.rect!.h;
      expect(p.card.rect!.h, `D6-2 预设 ${key} ⇒ ${PRESETS[key]}px（实读 ${p.card.rect!.h}）`).toBe(PRESETS[key]);
      // 小卡高态判据（S=260）：主图 ≥160 ∧ 副图 ≥30
      if (key === 's') {
        expect(p.candleH!, `D6-3 小卡高态主图 ≥${CANDLE_MIN_PX}（实读 ${p.candleH}）`).toBeGreaterThanOrEqual(
          CANDLE_MIN_PX,
        );
        const subH = p.subPaneIds.length > 0 ? p.paneSizes[p.subPaneIds[0]!] : null;
        expect(subH, 'D6-3 小卡高态副图必须仍可见').not.toBeNull();
        expect(subH!, `D6-3 小卡高态副图 ≥${SUB_PANE_MIN_PX}（实读 ${subH}）`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
      }
    }

    // 复位到默认，再拖 +N：卡高与内层容器高双变化
    await ensureCardFullyVisible(page);
    await page.getByTestId('wb-card-title-kline').dblclick();
    await page.waitForTimeout(250);
    const base = await page.evaluate(probeDom);
    expect(base.card.rect!.h, 'D6-6 双击复位必须回默认 520').toBe(DEFAULT_CARD_PX);
    await dragHandle(page, 140);
    const dragged = await page.evaluate(probeDom);
    writeJson('d6_t2_presets_drag', { presetReads, base, dragged });
    expect(dragged.card.rect!.h, `D6-6 拖 +140 ⇒ 卡高变化（${base.card.rect!.h} → ${dragged.card.rect!.h}）`).toBeGreaterThan(
      base.card.rect!.h + 100,
    );
    expect(
      dragged.klineInner!.h,
      `D6-6 klinecharts 容器高同步变化（${base.klineInner!.h} → ${dragged.klineInner!.h}）`,
    ).toBeGreaterThan(base.klineInner!.h + 100);
    const deltaCard = dragged.card.rect!.h - base.card.rect!.h;
    const deltaInner = dragged.klineInner!.h - base.klineInner!.h;
    expect(Math.abs(deltaCard - deltaInner), `D6-6 双变化增量一致（卡 ${deltaCard} / 内层 ${deltaInner}）`).toBeLessThanOrEqual(2);

    // 持久化：刷新后保持
    const kept = dragged.card.rect!.h;
    await page.reload();
    await reselect(page);
    const afterReload = await page.evaluate(probeDom);
    writeJson('d6_t2_after_reload', { kept, afterReload });
    expect(Math.abs(afterReload.card.rect!.h - kept), `D6-6 刷新后保持（期望 ${kept}，实读 ${afterReload.card.rect!.h}）`).toBeLessThanOrEqual(2);

    // 双击标题复位 520
    await page.getByTestId('wb-card-title-kline').dblclick();
    await page.waitForTimeout(250);
    const reset = await page.evaluate(probeDom);
    expect(reset.card.rect!.h, 'D6-6 双击标题复位到 520').toBe(DEFAULT_CARD_PX);
  });

  test('D6-4：拖到有效下限 ⇒ 卡高 ≥200 ∧ 主图 ≥160 ∧ 副图 ≥30；引擎 pane 分隔条越界 clamp', async ({
    page,
  }) => {
    await page.addInitScript(installChartCapture);
    await openRun(page);

    // 名义下限 200（常量）+ 有效下限 = max(200, 卡头实高 + 1 + 26 + 160 + 30×副图数)
    const p0 = await page.evaluate(probeDom);
    const headerPx = Math.round(p0.headerH as number);
    const subCount = p0.subPaneIds.length;
    const expectedMin = Math.max(
      CARD_MIN_PX,
      Math.ceil(headerPx) + CARD_BORDER_PX + SEP_PX + X_AXIS_PX + CANDLE_MIN_PX + SUB_PANE_MIN_PX * subCount,
    );

    // ① 卡片拖拽路径：向上拖 600px（远越界）⇒ 停在有效下限
    await ensureCardFullyVisible(page);
    await page.getByTestId('wb-card-title-kline').dblclick();
    await page.waitForTimeout(250);
    await dragHandle(page, -600);
    const clamped = await page.evaluate(probeDom);
    writeJson('d6_t3_card_clamp', { p0, headerPx, subCount, expectedMin, clamped });
    expect(clamped.card.rect!.h, `D6-4 卡高 ≥名义下限 ${CARD_MIN_PX}（实读 ${clamped.card.rect!.h}）`).toBeGreaterThanOrEqual(
      CARD_MIN_PX,
    );
    expect(
      clamped.card.rect!.h,
      `D6-4 越界拖拽必须停在有效下限附近（期望 ≈${expectedMin}，实读 ${clamped.card.rect!.h}）`,
    ).toBeLessThanOrEqual(expectedMin + 4);
    expect(
      clamped.candleH!,
      `D6-4 主图硬下限 ≥${CANDLE_MIN_PX}（实读 ${clamped.candleH}）`,
    ).toBeGreaterThanOrEqual(CANDLE_MIN_PX);
    const subH1 = subCount > 0 ? clamped.paneSizes[clamped.subPaneIds[0]!] : null;
    expect(subH1!, `D6-4 副图有效下限 ≥${SUB_PANE_MIN_PX}（实读 ${subH1}）`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);

    // ② 引擎 pane 分隔条路径：复原到默认 520 后向上拖分隔条 300px（远越界）⇒ 主图仍 ≥160
    await page.getByTestId('wb-card-title-kline').dblclick();
    await page.waitForTimeout(300);
    const sep = await page.evaluate(findPaneSeparator);
    expect(sep, '引擎 pane 分隔条必须存在（cursor=ns-resize 的窄条）').not.toBeNull();
    const beforeSep = await page.evaluate(probeDom);
    const cardHBefore = beforeSep.card.rect!.h;
    await page.mouse.move(sep!.x, sep!.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(sep!.x, sep!.y - (300 * i) / 8);
    await page.mouse.move(sep!.x, sep!.y - 300);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const afterSep = await page.evaluate(probeDom);
    writeJson('d6_t3_engine_separator_clamp', { sep, beforeSep, afterSep });
    expect(
      afterSep.card.rect!.h,
      `D6-4 引擎分隔条不得改变卡高（${cardHBefore} → ${afterSep.card.rect!.h}，ADR §2.6-7：只在固定卡高内重分配）`,
    ).toBe(cardHBefore);
    expect(
      afterSep.candleH!,
      `D6-4 引擎分隔条越界 ⇒ clamp 到主图硬下限（实读 ${afterSep.candleH}）`,
    ).toBeGreaterThanOrEqual(CANDLE_MIN_PX);
  });

  test('D6-7：高度写结果页独立 key；不碰看板 key 与旧 key', async ({ page }) => {
    await page.addInitScript(installChartCapture);
    await openRun(page);

    // 预置旧 key（模拟历史记忆）与看板 key（哨兵），验证互不干扰
    await page.evaluate(
      ([legacy, dash]) => {
        localStorage.setItem(
          legacy!,
          JSON.stringify({
            indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
            cardHeights: { kline: 333, aggregate: null, slot: null, equity: null, position: null },
          }),
        );
        localStorage.setItem(dash!, JSON.stringify({ sentinel: 'dashboard' }));
      },
      [LEGACY_KEY, DASHBOARD_KEY],
    );
    await page.reload();
    await reselect(page);

    await page.getByTestId('wb-kline-preset-m').click();
    await page.waitForTimeout(250);
    const after = await page.evaluate(probeDom);
    writeJson('d6_t4_storage_isolation', { after });
    expect(after.card.rect!.h, '预设 M ⇒ 420').toBe(PRESETS.m);
    // 结果页独立 key 必须真有该高度
    const own = JSON.parse(after.storage[RESULT_KEY] ?? '{}') as Record<string, unknown>;
    expect(own['kline'], `D6-7 高度必须落在 ${RESULT_KEY}（实读 ${after.storage[RESULT_KEY]}）`).toBe(PRESETS.m);
    // 看板 key 不得被触碰
    expect(after.storage[DASHBOARD_KEY], 'D6-7 看板 key 不得被改写').toBe(JSON.stringify({ sentinel: 'dashboard' }));
    // 旧 key 的 cardHeights 不得被当作写入目标（迁移只读）
    const legacyObj = JSON.parse(after.storage[LEGACY_KEY] ?? '{}') as { cardHeights?: Record<string, unknown> };
    expect(legacyObj.cardHeights?.['kline'], 'D6-7 旧 key 不得被改写（迁移为只读）').toBe(333);
  });
});
