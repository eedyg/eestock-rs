/**
 * ADR-028 §2.4c（D4.2）「结果页视图缩放 + K 线副图指标可选」——**实现方真渲染规格**（本波新建）。
 *
 * 与 tester 冻结规格的分工（**不修改**它们）：
 *  - `adr028-window-sync` / `adr028-axis-align-probe` / `adr028-features-verify` / `adr028-resize-probe`
 *    是**回归门**（本波必须仍全绿）；
 *  - 本规格只负责**本波新增行为**的真渲染断言：
 *    ① 副图指标可选（入口 + 真身 getIndicators + 切换 + **已拖过的 pane 高度保持** + 持久化）；
 *    ② K 线卡下边缘拖拽（卡片与内层图表跟随）+ 双击标题复位；
 *    ③ 曲线卡下边缘拖拽（**svg 随容器**）+ 双击标题复位；
 *    ④ 表格类**不做**高度拖拽（保持整页滚动）；
 *    ⑤ 高度缩放后「同一根 bar 跨图配对」仍 ≤2px，且统一 PAD 后跨视图 userX 差 ≤0.1 user unit。
 *
 * 真身：`:8081`（主机进程 `eestock-app`，`static_dir=./web/dist`，产物 = `dist/assets/index-*.js`）。
 * 运行（单规格、单 worker、带 timeout）：
 *   cd web && E2E_BASE_URL=http://localhost:8081 timeout 900 \
 *     npx playwright test e2e/adr028-d5-resize-indicators.e2e.ts --reporter=list --retries=0 --workers=1
 * 产物落盘：`ADR028_D5_OUT`（默认 `coder/evidence/20260920_result_resize/raw`）。
 *
 * 反假绿（变异反证，必须红）：
 *   - M1：把某张曲线卡 svg 改回固定 `h-40`（`resize ? resize.svgClass('h-40 w-full') : …` → 恒 'h-40 w-full'）
 *     ⇒ ②/③ 的「内层图跟随」断言红；
 *   - M2：`KlineResultChart` 的 `indicators` 改回硬编码 `DASHBOARD_DEFAULTS.indicators`
 *     ⇒ ① 的切换/持久化断言红。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028_D5_OUT ?? resolve(REPO, 'coder/evidence/20260920_result_resize/raw');
const RUN_ID = process.env.ADR028_D5_RUN ?? 'sr_1789832517800_000006';
const BAR_SECONDS = 300;
const PAIR_TOL_SEC = Math.max(60, Math.round(BAR_SECONDS / 2));
const ALIGN_TOL_PX = 2;

/**
 * **本规格的契约修订（2026-09-23，D6/D7 批次；逐条给推导，非按实现倒推）**：
 *  1. **默认卡高 256 → 520**（ADR-028 §2.6 第 1 项；D6-1）⇒ D5-B 的「默认高 256（h-64）」「复位 256」
 *     与「内层 194」断言全部改按新默认（520 / `inline 520px`）；
 *  2. **卡高上限 = 视口高 − 200**（§2.6 第 2 项）⇒ 视口 720 时 max = 520 = 默认值，「拖 +150」无增长空间，
 *     故本规格显式把视口抬到 **1280×900**（max = 700，+150 可达）；
 *  3. **指标勾选收进浮层**（§2.6 第 5 项：卡头 ≤48px）⇒ 断言 `wb-indicator-toggles` 前须先开
 *     `wb-indicator-menu`（多选语义与既有 testid 不变）；
 *  4. **页面级滚动移除**（§2.7 第 1 项）⇒ 滚动复位/读数从 `wb-result` 改为**上栏 `wb-chart-pane`**；
 *  5. **卡片高度记忆改结果页独立 key**（§2.6 第 3 项 + D6-7）⇒ 断言只看渲染高度（不锁 key 名）。
 */
test.use({ viewport: { width: 1280, height: 900 } });
/** 统一 PAD（user units）后跨视图同一根 bar 的 userX 差判据（1 user unit ≈ 0.62px @666px 卡宽）。 */
const CROSS_VIEW_TOL_USER = 0.1;
const CURVE_W = 1000;
const CURVE_PAD = 8;

function writeJson(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

// ═══════════════════════ 页面侧探针（自包含） ═══════════════════════

function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { scrollToDataIndex?: unknown; setBarSpace?: unknown; convertToPixel?: unknown } | null;
    if (
      o != null &&
      typeof o === 'object' &&
      typeof o['scrollToDataIndex'] === 'function' &&
      typeof o['setBarSpace'] === 'function' &&
      typeof o['convertToPixel'] === 'function'
    ) {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}

/** 卡片/把手/指标入口几何 + K 线真身 pane 布局（一次读全，供各相位断言）。 */
function probeDom() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const cards: Record<string, unknown> = {};
  for (const id of ['wb-kline-chart', 'wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart']) {
    const el = q(id);
    const svg = el?.querySelector('svg') ?? null;
    cards[id] = {
      present: !!el,
      rect: rect(el),
      inlineHeight: el?.style.height || null,
      inlineFlexShrink: el?.style.flexShrink || null,
      dataResizable: el?.getAttribute('data-resizable') ?? null,
      svg: svg ? { rect: rect(svg), className: svg.getAttribute('class') } : null,
      handle: !!el?.querySelector(`[data-card-resize]`),
      title: !!el?.querySelector(`[data-card-title]`),
    };
  }
  const klineInner = q('kline-chart');
  const toggles: Array<Record<string, unknown>> = [];
  for (const b of Array.from(document.querySelectorAll('[data-indicator]'))) {
    toggles.push({
      key: b.getAttribute('data-indicator'),
      testid: b.getAttribute('data-testid'),
      text: (b.textContent ?? '').trim(),
      pressed: b.getAttribute('aria-pressed'),
    });
  }
  const tableAnchors: Record<string, unknown> = {};
  for (const id of ['wb-round-trips-table', 'wb-perbar-table', 'wb-event-log']) {
    const el = q(id);
    tableAnchors[id] = {
      present: !!el,
      rect: rect(el),
      handles: el ? el.querySelectorAll('[data-card-resize]').length : 0,
      inlineHeight: el?.style.height || null,
      clientHeight: el?.clientHeight ?? null,
      scrollHeight: el?.scrollHeight ?? null,
    };
  }
  // K 线真身 pane 布局（经捕获的实例）
  interface ChartLike {
    getDataList?: () => unknown[];
    getSize?: () => { width: number; height: number } | null;
    getPaneOptions?: () => Array<Record<string, unknown>>;
    getIndicators?: () => Array<Record<string, unknown>>;
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
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
  const target = klineInner?.getBoundingClientRect().width ?? 0;
  const chosen =
    withData.length > 0
      ? withData.reduce((a, b) => (Math.abs(a.width - target) <= Math.abs(b.width - target) ? a : b))
      : null;
  let panes: Array<Record<string, unknown>> = [];
  let indicators: Array<Record<string, unknown>> = [];
  if (chosen) {
    try {
      panes = (chosen.c.getPaneOptions?.() ?? []).map((p) => ({
        id: p['id'],
        height: p['height'],
        minHeight: p['minHeight'],
        dragEnabled: p['dragEnabled'],
      }));
    } catch {
      /* ignore */
    }
    try {
      indicators = (chosen.c.getIndicators?.() ?? []).map((i) => ({
        name: i['name'],
        paneId: i['paneId'],
      }));
    } catch {
      /* ignore */
    }
  }
  // 副图 pane 真身高度 = DOM 里没有 canvas 的兄弟（分隔条）之外、pane 层中「非 candle 的含 canvas 块」
  let paneDoms: Array<{ h: number; canvas: number }> = [];
  if (klineInner) {
    let host: HTMLElement = klineInner;
    for (let d = 0; d < 3; d++) {
      const kids = Array.from(host.children);
      const withCanvas = kids.filter((k) => k.querySelectorAll('canvas').length > 0);
      const noCanvas = kids.filter((k) => k.querySelectorAll('canvas').length === 0);
      if (withCanvas.length >= 2 && noCanvas.length >= 1) break;
      const next = withCanvas[0] as HTMLElement | undefined;
      if (!next || kids.length === 0) break;
      host = next;
    }
    paneDoms = Array.from(host.children).map((el) => ({
      h: Math.round(el.getBoundingClientRect().height),
      canvas: el.querySelectorAll('canvas').length,
    }));
  }
  return {
    cards,
    klineInner: rect(klineInner),
    toggles,
    tableAnchors,
    panes,
    indicators,
    paneDoms,
    resultScrollTop: q('wb-result')?.scrollTop ?? null,
  };
}

/** K 线真身：可见 bar 的屏幕像素 x（含容器 left 偏移）。 */
function probeKline() {
  interface ChartLike {
    getDataList?: () => Array<{ timestamp: number }>;
    getVisibleRange?: () => { from: number; to: number };
    getBarSpace?: () => { bar: number };
    getSize?: () => { width: number } | null;
    convertToPixel?: (p: { timestamp: number }, f?: { paneId?: string }) => { x?: number } | undefined;
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const chartDiv = document.querySelector('[data-testid="kline-chart"]');
  const container = chartDiv?.getBoundingClientRect() ?? null;
  const cands = (w.__wbCharts ?? []).map((chart) => {
    let n = -1;
    let width = -1;
    try {
      n = (chart.getDataList?.() ?? []).length;
      width = chart.getSize?.()?.width ?? -1;
    } catch {
      /* ignore */
    }
    return { chart, n, width };
  });
  const withData = cands.filter((c) => c.n > 0);
  const chosen =
    withData.length > 0
      ? withData.reduce((a, b) =>
          Math.abs(a.width - (container?.width ?? 0)) <= Math.abs(b.width - (container?.width ?? 0)) ? a : b,
        )
      : null;
  if (!chosen || !container) return { ok: false, container: null, ts: [] as number[], xAbs: [] as number[] };
  const chart = chosen.chart;
  const list = chart.getDataList!();
  const range = chart.getVisibleRange!();
  const left = container.left;
  const last = list.length - 1;
  const fromIdx = Math.max(0, Math.min(last, Math.round(range.from)));
  const toIdx = Math.max(fromIdx, Math.min(last, Math.round(range.to)));
  const ts: number[] = [];
  const xAbs: number[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const ms = list[i]!.timestamp;
    let px: number | null = null;
    try {
      const p = chart.convertToPixel!({ timestamp: ms }, { paneId: 'candle_pane' });
      px = typeof p?.x === 'number' ? p.x : null;
    } catch {
      px = null;
    }
    ts.push(Math.floor(ms / 1000));
    xAbs.push(px == null ? Number.NaN : px + left);
  }
  return { ok: true, container: { left, width: container.width }, ts, xAbs, barSpace: chart.getBarSpace?.()?.bar ?? null };
}

/** 曲线视图：polyline 渲染顶点（user units + 屏幕 x）。 */
function probeCurve(arg: { testid: string; polyTestId: string | null }) {
  const host = document.querySelector(`[data-testid="${arg.testid}"]`);
  const svg = host?.querySelector('svg') as SVGSVGElement | null;
  if (!host || !svg) return { present: false, userX: [] as number[], screenX: [] as Array<number | null> };
  const ctm = svg.getScreenCTM();
  const pt = svg.createSVGPoint();
  const pick = arg.polyTestId
    ? Array.from(svg.querySelectorAll(`polyline[data-testid="${arg.polyTestId}"]`))
    : Array.from(svg.querySelectorAll('polyline'));
  const poly = pick[0];
  if (!poly) return { present: true, userX: [] as number[], screenX: [] as Array<number | null> };
  const userX = (poly.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => Number(t.split(',')[0]))
    .filter((v) => Number.isFinite(v));
  const screenX = userX.map((x) => {
    if (!ctm) return null;
    pt.x = x;
    pt.y = 0;
    return pt.matrixTransform(ctm).x;
  });
  return {
    present: true,
    ctm: ctm ? { a: ctm.a, d: ctm.d, e: ctm.e, f: ctm.f } : null,
    nUserX: userX.length,
    nScreenX: screenX.filter((v) => v != null).length,
    polyCount: pick.length,
    userX,
    screenX,
    firstUserX: userX[0] ?? null,
    lastUserX: userX[userX.length - 1] ?? null,
  };
}

/** 水平分隔线命中点（宽 > 100 且高 ≤ 10 且 inline cursor = ns-resize；**在 kline-chart 内部**，
 *  故不会命中卡片缩放把手）。 */
function probeSeparator() {
  const root = document.querySelector('[data-testid="kline-chart"]');
  if (!root) return null;
  const cands = Array.from(root.querySelectorAll('div')).filter((d) => {
    const he = d as HTMLElement;
    const r = he.getBoundingClientRect();
    return he.style.cursor === 'ns-resize' && r.width > 100 && r.height <= 10;
  });
  if (cands.length === 0) return null;
  const r = (cands[0] as HTMLElement).getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), count: cands.length };
}

// ═══════════════════════ 编排 ═══════════════════════

async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await openIndicatorMenu(page); // 契约修订 3：勾选在浮层内
  await page.waitForTimeout(2500);
  await resetScroll(page);
}

/** 刷新后重新选中 run（页面不记忆选中态）并等落定。 */
async function reselectRun(page: Page, runId: string): Promise<void> {
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await page.waitForTimeout(2500);
  await resetScroll(page);
}

/** 滚动复位：**上栏**才是滚动容器（§2.7 第 1 项：页面级滚动已移除）⇒ 上栏与页面双复位。 */
async function resetScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="wb-chart-pane"]') as HTMLElement | null;
    if (pane) pane.scrollTop = 0;
    const el = document.querySelector('[data-testid="wb-result"]') as HTMLElement | null;
    if (el) el.scrollTop = 0;
  });
}

/** 打开指标浮层（§2.6 第 5 项：勾选收进浮层，保留多选与 testid）。 */
async function openIndicatorMenu(page: Page): Promise<void> {
  const menu = page.getByTestId('wb-indicator-menu');
  if ((await menu.count()) === 0) return;
  const pressed = await menu.getAttribute('aria-expanded');
  if (pressed !== 'true') await menu.click();
  await expect(page.getByTestId('wb-indicator-toggles')).toBeVisible();
}

/** 真鼠标拖拽：定位把手/分隔线中心 → down → 分步 move（每步 25ms，> 引擎节流）→ up。 */
async function dragBy(page: Page, at: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const steps = Math.max(6, Math.min(20, Math.round(Math.abs(dy) / 12)));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(at.x, at.y + Math.round((dy * i) / steps));
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

async function dragCardBy(page: Page, cardId: string, dy: number): Promise<void> {
  const locator = page.locator(`[data-card-resize="${cardId}"]`).first();
  // ⚠ 结果页是**滚动容器**：把手若落在容器可视区之外（被裁）则 mousedown 命中不到别的东西
  //   ⇒ 必须先滚入可视区（实测：聚合卡 204px 高、K 线卡已拖到 406px 时，把手 y≈759 超出面板下沿）。
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const box = await locator.boundingBox();
  expect(box, `${cardId} 卡片的拖拽把手必须存在且可见`).not.toBeNull();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const y = Math.round(box!.y + box!.height / 2);
  expect(y, `${cardId} 把手落点必须在视口内（y=${y}）`).toBeGreaterThan(0);
  expect(y).toBeLessThan(vp.height);
  await dragBy(page, { x: Math.round(box!.x + box!.width / 2), y }, dy);
}

/** 共享窗口（`wb-window-state` 的实测值）；`source=full` ⇒ 不带窗口参数。 */
async function readWindow(page: Page): Promise<{ from: number | null; to: number | null; source: string | null }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-window-state"]');
    const src = el?.getAttribute('data-source') ?? null;
    const f = Number(el?.getAttribute('data-from-ts'));
    const t = Number(el?.getAttribute('data-to-ts'));
    return { from: Number.isFinite(f) ? f : null, to: Number.isFinite(t) ? t : null, source: src };
  });
}

async function fetchCurveTs(
  page: Page,
  runId: string,
  kind: string,
  from?: number | null,
  to?: number | null,
) {
  const q = new URLSearchParams({ kind, k: '2000' });
  if (from != null && to != null) {
    q.set('from_ts', String(from));
    q.set('to_ts', String(to));
  }
  const resp = await page.request.get(`/api/workbench/runs/${runId}/curve?${q.toString()}`);
  if (!resp.ok()) return { ok: false, ts: [] as number[], status: resp.status() };
  const j = (await resp.json()) as { points?: Array<{ ts?: number } | [number, number]> };
  const ts = (j.points ?? [])
    .map((p) => (Array.isArray(p) ? Number(p[0]) : Number(p?.ts)))
    .filter((v) => Number.isFinite(v));
  return { ok: true, ts, status: 200 };
}

/** 就近配对（单调一对一）：曲线顶点 ts → K 线可见 bar 的 ts。 */
function pairByNearest(kTs: number[], cTs: number[], tol: number) {
  const pairs: Array<{ i: number; j: number }> = [];
  let j = 0;
  let prev = -1;
  for (let i = 0; i < cTs.length; i++) {
    const t = cTs[i]!;
    while (j + 1 < kTs.length && Math.abs(kTs[j + 1]! - t) <= Math.abs(kTs[j]! - t)) j += 1;
    if (j < prev) continue;
    if (Math.abs(kTs[j]! - t) > tol) continue;
    pairs.push({ i, j });
    prev = j;
  }
  return pairs;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** 单视图对齐测量：锚定（去线性漂移）后的绝对残差 + 归一化到 984px 参考宽的残差。 */
function measureAlign(args: { kTs: number[]; kX: number[]; cTs: number[]; cScreenX: Array<number | null> }) {
  const pairs = pairByNearest(args.kTs, args.cTs, PAIR_TOL_SEC);
  const rows = pairs
    .map((p) => ({ j: p.j, r: (args.cScreenX[p.i] ?? Number.NaN) - args.kX[p.j]! }))
    .filter((x) => Number.isFinite(x.r));
  if (rows.length < 3) return { pairs: rows.length, maxAbsAnchored: null as number | null, maxAbs984: null as number | null };
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const jFirst = first.j;
  const jSpan = last.j - jFirst || 1;
  const spanK = Math.abs(args.kX[last.j]! - args.kX[jFirst]!);
  let maxAbsAnchored = 0;
  let maxAbs984 = 0;
  for (const row of rows) {
    const f = (row.j - jFirst) / jSpan;
    const anchor = first.r + (last.r - first.r) * f;
    const resid = row.r - anchor;
    maxAbsAnchored = Math.max(maxAbsAnchored, Math.abs(resid));
    maxAbs984 = Math.max(maxAbs984, spanK > 0 ? Math.abs(resid) * (984 / spanK) : Math.abs(resid));
  }
  return { pairs: rows.length, maxAbsAnchored: round2(maxAbsAnchored), maxAbs984: round2(maxAbs984) };
}

const VIEWS = [
  { testid: 'wb-aggregate-chart', kind: 'per_bar', poly: null as string | null },
  { testid: 'wb-slot-chart', kind: 'per_bar', poly: null },
  { testid: 'wb-equity-chart', kind: 'net_value', poly: 'equity-line' },
  { testid: 'wb-position-chart', kind: 'position', poly: 'position-line' },
];

// ═══════════════════════ ① 副图指标可选 ═══════════════════════

test('D5-A 副图指标可选：入口在结果页 K 线卡内 / 真身驱动 / 已拖过的 pane 高度在切换后保持 / 刷新保持', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(installChartCapture);
  await openRunSettled(page, RUN_ID);

  const base = await page.evaluate(probeDom);
  writeJson('d5a_base_dom', base);

  // ① 入口存在且默认与 DASHBOARD_DEFAULTS 同构（vol 开、ma 开、其余关）
  expect(base.toggles.length, '六枚指标开关必须渲染在结果页').toBe(6);
  const byKey = Object.fromEntries(base.toggles.map((t) => [String(t['key']), String(t['pressed'])]));
  expect(byKey['vol'], '默认 vol 开（DASHBOARD_DEFAULTS）').toBe('true');
  expect(byKey['ma']).toBe('true');
  expect(byKey['macd']).toBe('false');
  expect(byKey['kdj']).toBe('false');
  expect(byKey['boll']).toBe('false');
  expect(byKey['dcap']).toBe('false');
  expect(
    base.toggles.every((t) => String(t['testid']).startsWith('wb-indicator-toggle-')),
    '每枚开关必须有稳定 testid（真渲染可点可断言）',
  ).toBe(true);

  // ② 真身：MA 叠主图 + VOL 副图；无 MACD
  const names0 = (base.indicators as Array<{ name: string }>).map((i) => i.name).sort();
  expect(names0, '真身指标 = MA + VOL（默认）').toEqual(['MA', 'VOL']);

  // ③ 用户先把 VOL 副图拖高（klinecharts 内建分隔线；上拖 = 放大 bottom pane）
  await resetScroll(page);
  const sep = await page.evaluate(probeSeparator);
  expect(sep, 'K 线副图分隔线必须可命中（宽 > 100 且 cursor = ns-resize）').not.toBeNull();
  await dragBy(page, { x: sep!.x, y: sep!.y }, -40);
  const afterDrag = await page.evaluate(probeDom);
  writeJson('d5a_after_sep_drag', { panes: afterDrag.panes, paneDoms: afterDrag.paneDoms });
  const volPaneAfterDrag = (afterDrag.panes as Array<{ id: string; height: number }>).find((p) =>
    /indicator_pane/.test(p.id),
  );
  expect(volPaneAfterDrag, 'VOL 副图 pane 必须存在').toBeTruthy();
  expect(volPaneAfterDrag!.height, '上拖 40px ⇒ VOL pane 高度必须变大').toBeGreaterThan(100);

  // ④ 切换副图指标（开 MACD）：副图变化 **且已拖过的 VOL pane 高度保持**
  await page.getByTestId('wb-indicator-toggle-macd').click();
  await page.waitForTimeout(600);
  const afterMacd = await page.evaluate(probeDom);
  writeJson('d5a_after_macd_on', { panes: afterMacd.panes, indicators: afterMacd.indicators });
  const names1 = (afterMacd.indicators as Array<{ name: string }>).map((i) => i.name).sort();
  expect(names1, '开 MACD ⇒ 真身出现 MACD（副图变化）').toContain('MACD');
  expect(names1, '开 MACD 不得连带移除 VOL').toContain('VOL');
  const panesAfterMacd = (afterMacd.panes as Array<{ id: string; height: number }>).filter((p) => /indicator_pane/.test(p.id));
  expect(
    panesAfterMacd.some((p) => p.height === volPaneAfterDrag!.height),
    `用户拖过的 pane 高度必须保持（拖后=${volPaneAfterDrag!.height}，切换后 pane 高度=${JSON.stringify(panesAfterMacd.map((p) => p.height))}）`,
  ).toBe(true);

  // ⑤ VOL → MACD（关 VOL）：副图数量/内容变化，不得残留空 pane
  await page.getByTestId('wb-indicator-toggle-vol').click();
  await page.waitForTimeout(600);
  const afterVolOff = await page.evaluate(probeDom);
  const names2 = (afterVolOff.indicators as Array<{ name: string }>).map((i) => i.name).sort();
  expect(names2, '关 VOL ⇒ 真身不再有 VOL').toEqual(['MA', 'MACD']);
  const panes2 = (afterVolOff.panes as Array<{ id: string; height: number }>).filter((p) => /indicator_pane/.test(p.id));
  expect(panes2.length, '副图 pane 数 == 副图指标数（禁残留空 pane）').toBe(1);

  // ⑥ 持久化：刷新后指标选择保持（结果页独立 key；仅本机浏览器有效）
  await page.reload();
  await reselectRun(page, RUN_ID);
  await openIndicatorMenu(page);
  const afterReload = await page.evaluate(probeDom);
  const pressed = Object.fromEntries(afterReload.toggles.map((t) => [String(t['key']), String(t['pressed'])]));
  expect(pressed['vol'], '刷新后 vol 仍关（结果页独立 key 持久化）').toBe('false');
  expect(pressed['macd'], '刷新后 macd 仍开').toBe('true');
  const names3 = (afterReload.indicators as Array<{ name: string }>).map((i) => i.name).sort();
  expect(names3, '刷新后真身与选择一致').toEqual(['MA', 'MACD']);
});

// ═══════════════════════ ②③④ 卡片缩放 ═══════════════════════

test('D5-B 卡片上下缩放：K 线卡（内层图表跟随）/ 曲线卡（svg 随容器）/ 双击复位 / 刷新保持 / 表格无把手', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(installChartCapture);
  await openRunSettled(page, RUN_ID);

  const before = await page.evaluate(probeDom);
  writeJson('d5b_before', before);
  const kCard0 = (before.cards['wb-kline-chart'] as { rect: { h: number } }).rect;
  const kInner0 = before.klineInner as { h: number } | null;
  const agg0 = before.cards['wb-aggregate-chart'] as { rect: { h: number }; svg: { rect: { h: number } } };
  const pos0 = before.cards['wb-position-chart'] as { rect: { h: number }; svg: { rect: { h: number } } };
  // 契约修订 1：默认卡高 520（原 256）
  expect(kCard0.h, 'K 线卡默认高 520（ADR-028 §2.6 第 1 项）').toBe(520);
  expect(agg0.svg.rect.h, '聚合卡 svg 默认固定高（h-40 = 160）').toBe(160);

  // ① K 线卡下边缘拖高 150px ⇒ 卡片与内层图表**同时**跟随
  await resetScroll(page);
  await dragCardBy(page, 'kline', 150);
  const afterK = await page.evaluate(probeDom);
  writeJson('d5b_after_kline_drag', afterK);
  const kCard1 = (afterK.cards['wb-kline-chart'] as { rect: { h: number }; inlineHeight: string | null }).rect;
  const kInner1 = afterK.klineInner as { h: number } | null;
  expect(kCard1.h, `拖 +150 ⇒ 卡片高度跟随（${kCard0.h} → ?）`).toBeGreaterThanOrEqual(520 + 150 - 4);
  expect(kInner1!.h, 'K 线内层图表必须跟随卡片（min-h-0 flex-1）').toBeGreaterThanOrEqual(kInner0!.h + 150 - 8);
  expect((afterK.cards['wb-kline-chart'] as { inlineFlexShrink: string }).inlineFlexShrink, '受控高度必须 shrink-0').toBe('0');

  // ② 曲线卡（聚合，svg 原本固定 h-40）拖高 60px ⇒ **svg 高度跟随**
  await resetScroll(page);
  const aggCardTop = (afterK.cards['wb-aggregate-chart'] as { rect: { y: number } }).rect.y;
  if (aggCardTop > 620) await page.evaluate(() => window.scrollTo(0, 0));
  await dragCardBy(page, 'aggregate', 60);
  const afterAgg = await page.evaluate(probeDom);
  writeJson('d5b_after_aggregate_drag', afterAgg);
  const agg1 = afterAgg.cards['wb-aggregate-chart'] as {
    rect: { h: number };
    svg: { rect: { h: number }; className: string };
    inlineHeight: string | null;
  };
  expect(agg1.rect.h, '聚合卡高度跟随拖拽').toBeGreaterThanOrEqual(agg0.rect.h + 60 - 6);
  expect(
    agg1.svg.rect.h,
    `曲线卡 svg 必须随容器（拖前 ${agg0.svg.rect.h} → 拖后 ${agg1.svg.rect.h}）`,
  ).toBeGreaterThanOrEqual(agg0.svg.rect.h + 40);
  expect(agg1.svg.className, '受控高度下 svg 用 h-full（去掉固定 h-40）').toContain('h-full');

  // ③ 持仓比率卡（含口径说明行，另一个 PAD 变更图）拖高 60px ⇒ svg 跟随
  await page.getByTestId('wb-position-chart').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await dragCardBy(page, 'position', 60);
  const afterPos = await page.evaluate(probeDom);
  writeJson('d5b_after_position_drag', afterPos);
  const pos1 = afterPos.cards['wb-position-chart'] as { rect: { h: number }; svg: { rect: { h: number } } };
  expect(pos1.svg.rect.h, `持仓卡 svg 必须随容器（${pos0.svg.rect.h} → ${pos1.svg.rect.h}）`).toBeGreaterThanOrEqual(
    pos0.svg.rect.h + 40,
  );

  // ④ 表格类不做高度拖拽（保持整页滚动；无把手、无 inline 高度）
  // 默认 Tab = 交易明细 ⇒ 该相位只有回合表在场（逐bar/事件日志在各自 Tab 内检查）
  for (const id of ['wb-round-trips-table']) {
    const anchor = (afterPos.tableAnchors as Record<string, Record<string, unknown>>)[id]!;
    expect(anchor['present'], `${id} 必须存在（本相位锚点）`).toBe(true);
    expect(anchor['handles'], `${id} 不得有高度拖拽把手（裁定：表格类不参与拖高）`).toBe(0);
    expect(anchor['inlineHeight'], `${id} 不得被写入 inline 高度`).toBeNull();
  }
  // 事件日志/逐bar 两个 Tab 同样无把手（切 Tab 会触发滚动，读完复位）
  for (const tab of ['perbar', 'events']) {
    await page.getByTestId(`wb-tab-${tab}`).click();
    await page.waitForTimeout(500);
    const dom = await page.evaluate(probeDom);
    const anchor = (dom.tableAnchors as Record<string, Record<string, unknown>>)[
      tab === 'perbar' ? 'wb-perbar-table' : 'wb-event-log'
    ]!;
    expect(anchor['present'], `${tab} Tab 表格锚点必须存在`).toBe(true);
    expect(anchor['handles'], `${tab} 表格不得有高度拖拽把手`).toBe(0);
    expect(anchor['inlineHeight'], `${tab} 表格不得被写入 inline 高度`).toBeNull();
    await resetScroll(page);
  }
  await page.getByTestId('wb-tab-trades').click();
  await page.waitForTimeout(400);

  // ⑤ 双击标题复位（K 线卡 + 聚合卡）
  await resetScroll(page);
  await page.getByTestId('wb-card-title-kline').dblclick();
  await page.waitForTimeout(400);
  const afterResetK = await page.evaluate(probeDom);
  // 契约修订 1：复位到默认 520（原 256）；inline 高度**恒**存在（卡高由 D6-1 的 520 常量给定，不再靠类名）
  expect((afterResetK.cards['wb-kline-chart'] as { rect: { h: number } }).rect.h, '双击 K 线卡标题 ⇒ 复位 520').toBe(520);
  expect((afterResetK.cards['wb-kline-chart'] as { inlineHeight: string | null }).inlineHeight).toBe('520px');
  await page.getByTestId('wb-card-title-aggregate').dblclick();
  await page.waitForTimeout(400);
  const afterResetAgg = await page.evaluate(probeDom);
  const aggR = afterResetAgg.cards['wb-aggregate-chart'] as { rect: { h: number }; svg: { rect: { h: number }; className: string } };
  expect(aggR.rect.h, '双击聚合卡标题 ⇒ 复位到默认卡高').toBe(agg0.rect.h);
  expect(aggR.svg.rect.h, '复位后 svg 回默认固定高').toBe(agg0.svg.rect.h);
  expect(aggR.svg.className).toContain('h-40');

  // ⑥ 刷新保持：重设高度 → reload → 高度与 svg 跟随均保持
  await dragCardBy(page, 'kline', 120);
  const beforeReload = await page.evaluate(probeDom);
  writeJson('d5b_before_reload', beforeReload);
  const kH = (beforeReload.cards['wb-kline-chart'] as { rect: { h: number } }).rect.h;
  await page.reload();
  await reselectRun(page, RUN_ID);
  const afterReload = await page.evaluate(probeDom);
  writeJson('d5b_after_reload', afterReload);
  const kHR = (afterReload.cards['wb-kline-chart'] as { rect: { h: number } }).rect.h;
  expect(Math.abs(kHR - kH), `刷新后 K 线卡高度保持（${kH} → ${kHR}）`).toBeLessThanOrEqual(2);
  const kInnerR = afterReload.klineInner as { h: number };
  expect(kInnerR.h, '刷新后内层图表仍随容器（粘性高度）').toBeGreaterThan(kInner0!.h + 60);
});

// ═══════════════════════ ⑤ 缩放后的对齐回归 ═══════════════════════

test('D5-C 高度缩放后对齐：同一根 bar 跨图配对 ≤2px；统一 PAD 后跨视图 userX 差 ≤0.1 user unit', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(installChartCapture);
  await openRunSettled(page, RUN_ID);

  // 拖高 K 线卡（480 档：与 tester 探针同档）+ 聚合卡（+150）
  await resetScroll(page);
  await dragCardBy(page, 'kline', 224);
  await dragCardBy(page, 'aggregate', 150);
  await page.waitForTimeout(1500);
  const dom = await page.evaluate(probeDom);
  writeJson('d5c_resized_dom', dom);

  const kline = await page.evaluate(probeKline);
  // 曲线取数口径与冻结规格一致：**窗口化**（默认态 `source=kline`）⇒ 点数 ≈ 可见 bar 数，配对无歧义
  const win = await readWindow(page);
  const perView: Array<Record<string, unknown>> = [];
  const userXByView: Record<string, number[]> = {};
  for (const v of VIEWS) {
    const api = await fetchCurveTs(page, RUN_ID, v.kind, win.from, win.to);
    const curve = await page.evaluate(probeCurve, { testid: v.testid, polyTestId: v.poly });
    const cScreenX = (curve as { screenX: Array<number | null> }).screenX;
    const userX = (curve as { userX: number[] }).userX;
    userXByView[v.testid] = userX;
    const m = kline.ok
      ? measureAlign({ kTs: kline.ts, kX: kline.xAbs, cTs: api.ts, cScreenX })
      : { pairs: 0, maxAbsAnchored: null, maxAbs984: null };
    perView.push({
      testid: v.testid,
      apiOk: api.ok,
      nApiTs: api.ts.length,
      ctm: (curve as { ctm?: unknown }).ctm ?? null,
      polyCount: (curve as { polyCount?: number }).polyCount ?? null,
      nUserX: (curve as { nUserX?: number }).nUserX ?? null,
      nScreenX: (curve as { nScreenX?: number }).nScreenX ?? null,
      ...m,
      firstUserX: (curve as { firstUserX?: number }).firstUserX,
      lastUserX: (curve as { lastUserX?: number }).lastUserX,
    });
  }
  // 跨视图同一根 bar（同索引逐点）的 userX 差
  const agg = userXByView['wb-aggregate-chart']!;
  const crossViewMax: Record<string, number | null> = {};
  for (const v of VIEWS) {
    const other = userXByView[v.testid]!;
    if (v.testid === 'wb-aggregate-chart' || other.length === 0 || agg.length === 0) {
      crossViewMax[v.testid] = null;
      continue;
    }
    const n = Math.min(agg.length, other.length);
    let mx = 0;
    for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(agg[i]! - other[i]!));
    crossViewMax[v.testid] = round2(mx);
  }
  writeJson('d5c_align', {
    klineOk: kline.ok,
    klineBarSpace: kline.barSpace,
    visible: kline.ts.length,
    klineTsHead: kline.ts.slice(0, 3),
    klineXHead: kline.xAbs.slice(0, 3).map(round2),
    perView,
    crossViewMaxUserX: crossViewMax,
  });

  // 判据 ① 同一根 bar 跨图配对偏差 ≤2px（锚定残差 + 归一化 984）
  for (const row of perView) {
    expect(row['pairs'], `${String(row['testid'])}：配对点数必须 > 0`).toBeGreaterThan(0);
    expect(
      Number(row['maxAbsAnchored']),
      `${String(row['testid'])}：拖高后同一根 bar 配对残差必须 ≤ ${ALIGN_TOL_PX}px（锚定去漂移）`,
    ).toBeLessThanOrEqual(ALIGN_TOL_PX);
    expect(
      Number(row['maxAbs984']),
      `${String(row['testid'])}：拖高后归一化 984px 残差必须 ≤ ${ALIGN_TOL_PX}px`,
    ).toBeLessThanOrEqual(ALIGN_TOL_PX);
  }
  // 判据 ② 统一 PAD=8 后跨视图 userX 差 ≤0.1 user unit（修复前净值/持仓恒差 2.0 = 1.244px）
  for (const v of VIEWS) {
    const mx = crossViewMax[v.testid];
    if (v.testid === 'wb-aggregate-chart') continue;
    expect(mx, `${v.testid}：跨视图 userX 差必须可算`).not.toBeNull();
    expect(
      Number(mx),
      `${v.testid}：统一 PAD 后跨视图同一 bar 的 userX 差必须 ≤ ${CROSS_VIEW_TOL_USER}（修复前 2.0）`,
    ).toBeLessThanOrEqual(CROSS_VIEW_TOL_USER);
  }
  // 曲线 plot 边界 = PAD / W − PAD（统一后四图一致）
  for (const row of perView) {
    expect(row['firstUserX'], `${String(row['testid'])}：plot 左边界必须 = CURVE_PAD`).toBe(CURVE_PAD);
    expect(row['lastUserX'], `${String(row['testid'])}：plot 右边界必须 = CURVE_W − CURVE_PAD`).toBe(CURVE_W - CURVE_PAD);
  }
});
