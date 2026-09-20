/**
 * ADR-028 §2.4c（D4.2）「结果页视图缩放 + K 线副图指标可选」——**tester 独立终验规格**。
 *
 * 独立性纪律（与实现方 `adr028-d5-resize-indicators.e2e.ts` 的区别）：
 *  1. **不复用实现方的读数/截图/断言**：全部判据在本规格自建探针上重算（几何用 `getBoundingClientRect`
 *     + klinecharts 真身只读 API `getIndicators()/getPaneOptions()/getSize(paneId)`）；
 *  2. **不作「文本存在即通过」的弱断言**：每一条「跟随/复位/保持」都用**像素**或**真身结构**
 *     （pane 集合、指标名集合）作答，并落盘前后读数；
 *  3. **隔离性用两种独立口径**：① `localStorage` 键**增量**（注入看板哨兵键作对照，断言其逐字节不变）；
 *     ② 网络写入监控（非 GET 的 `/api/config/*` 请求数必须为 0 —— 看板配置的权威通道是服务端）；
 *  4. **反假绿**：本规格对变异构建（固定 svg 高度 / 指标切换重建实例 / 单图 PAD 回退 10）必须红。
 *
 * 真身：`E2E_BASE_URL`（默认 `:8081` 主机进程静态托管 `web/dist`）。
 * 运行（单规格 / 单 worker / timeout 前缀 / 不起 vite preview）：
 *   cd web && E2E_BASE_URL=http://localhost:8081 timeout 900 \
 *     npx playwright test e2e/adr028-d5-result-resize-tester-verify.e2e.ts --reporter=list --retries=0 --workers=1
 * 产物：`ADR028_RV_OUT`（默认 `tester/evidence/20260920_result_resize_verify/raw`）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028_RV_OUT ?? resolve(REPO, 'tester/evidence/20260920_result_resize_verify/raw');
/** 目标 run：518880 / M5（与四规格同源，便于跨波比对）。 */
const RUN_ID = process.env.ADR028_RV_RUN ?? 'sr_1789832517800_000006';
/** 统一 PAD 口径（口径事实源 = `web/src/features/workbench/curveGeometry.ts`；本规格**独立硬编码**作对照）。 */
const CURVE_W = 1000;
const CURVE_PAD = 8;
const CURVE_PLOT_W = CURVE_W - 2 * CURVE_PAD;
/** 曲线顶点坐标精度（`lineFrom` 用 `toFixed(1)`）⇒ 允许 ±0.05 解析残差。 */
const X_ROUND_TOL = 0.06;
/** 可缩放卡片（testid / data 后缀 / 标签）。 */
const RESIZABLE = [
  { card: 'wb-kline-chart', key: 'kline', label: 'K线' },
  { card: 'wb-aggregate-chart', key: 'aggregate', label: '聚合分' },
  { card: 'wb-slot-chart', key: 'slot', label: '各策略评分' },
  { card: 'wb-equity-chart', key: 'equity', label: '净值+回撤' },
  { card: 'wb-position-chart', key: 'position', label: '持仓比率' },
] as const;
const CURVE_KEYS = ['aggregate', 'slot', 'equity', 'position'] as const;
/** 表格类（不做高度拖拽）。 */
const TABLES = ['wb-round-trips-table', 'wb-perbar-table', 'wb-event-log'] as const;
/** 结果页独立配置 key（口径事实源 = `resultChartConfig.ts`；用于「增量只有这一个键」的断言）。 */
const RESULT_KEY = 'eestock.wb.result.chartConfig.v1';
/** 注入的**看板哨兵键**（对照：任何实现方读写都会改动它们）。 */
const SENTINEL_KEYS: Array<[string, string]> = [
  ['eestock.dashboard.layout.v1', JSON.stringify({ view: 'grid2x3', sentinel: 1 })],
  [
    'eestock.dashboard.indicators.v1',
    JSON.stringify({ ma: false, vol: false, macd: true, kdj: true, boll: true, dcap: true }),
  ],
];

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

const H = (v: unknown): number => Number(v);

// ═══════════════════════════ 页面侧探针（自包含；只读） ═══════════════════════════

/** 只读捕获 klinecharts 真身实例（拦截 `Map.prototype.set`，与 tester v2 探针同法；不改生产代码）。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { convertToPixel?: unknown; setBarSpace?: unknown } | null;
    if (
      o != null &&
      typeof o === 'object' &&
      typeof o['convertToPixel'] === 'function' &&
      typeof o['setBarSpace'] === 'function'
    ) {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}

/** 卡片 / 把手 / 内层图几何 + 宽度类把手扫描。 */
function probeCards() {
  const round = (v: number) => Math.round(v * 100) / 100;
  const rectOf = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
  };
  const cards: Record<string, unknown> = {};
  for (const r of [
    { card: 'wb-kline-chart', key: 'kline' },
    { card: 'wb-aggregate-chart', key: 'aggregate' },
    { card: 'wb-slot-chart', key: 'slot' },
    { card: 'wb-equity-chart', key: 'equity' },
    { card: 'wb-position-chart', key: 'position' },
  ]) {
    const id = r.card;
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    const svg = el?.querySelector('svg') ?? null;
    const inner = el?.querySelector('[data-testid="kline-chart"]') ?? null;
    const handles = el ? Array.from(el.querySelectorAll('[data-card-resize]')) : [];
    cards[r.key] = {
      present: !!el,
      rect: rectOf(el),
      inlineHeight: el?.style.height || null,
      inlineWidth: el?.style.width || null,
      inlineFlexShrink: el?.style.flexShrink || null,
      dataResizable: el?.getAttribute('data-resizable') ?? null,
      svg: svg ? { rect: rectOf(svg), cls: svg.getAttribute('class'), viewBox: svg.getAttribute('viewBox') } : null,
      /** K 线内层 klinecharts 容器（其余卡片为 null）。 */
      klineInner: inner ? rectOf(inner) : null,
      handleCount: handles.length,
      handle: handles[0]
        ? {
            id: handles[0].getAttribute('data-card-resize'),
            testid: handles[0].getAttribute('data-testid'),
            rect: rectOf(handles[0]),
            cursor: (handles[0] as HTMLElement).style.cursor || getComputedStyle(handles[0]).cursor,
          }
        : null,
    };
  }
  /** 宽度类缩放把手（ew/col/w/e-resize）——「只做高度」的反面证据。
   *  注意：klinecharts **自带** 的 Y 轴/画布控件也有横向光标（库内建，非本波引入）⇒ 单独归类。 */
  const widthCursors: Array<{
    testid: string | null;
    cursor: string;
    tag: string;
    cls: string;
    inKlineEngine: boolean;
    inResizableCard: boolean;
  }> = [];
  const root = document.querySelector('[data-testid="wb-result"]') as HTMLElement | null;
  if (root) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const c = getComputedStyle(el).cursor;
      if (c === 'ew-resize' || c === 'col-resize' || c === 'w-resize' || c === 'e-resize') {
        widthCursors.push({
          testid: el.getAttribute('data-testid'),
          cursor: c,
          tag: el.tagName,
          cls: (el.getAttribute('class') ?? '').slice(0, 120),
          inKlineEngine: el.closest('[data-testid="kline-chart"]') != null,
          inResizableCard: el.closest('[data-resizable]') != null,
        });
      }
    }
  }
  return {
    cards,
    widthCursors,
    resultRect: rectOf(root),
    resultScrollTop: root?.scrollTop ?? null,
  };
}

/** 四张曲线：svg 几何 + 绘制顶点（user units）+ 视口映射 + 卡片/宽度读数。 */
function probeCurves() {
  const round = (v: number) => Math.round(v * 100) / 100;
  const rectOf = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
  };
  const pairs: Array<[string, string]> = [
    ['aggregate', 'wb-aggregate-chart'],
    ['slot', 'wb-slot-chart'],
    ['equity', 'wb-equity-chart'],
    ['position', 'wb-position-chart'],
  ];
  const out: Record<string, unknown> = {};
  for (const [key, testid] of pairs) {
    const card = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    const svg = card?.querySelector('svg') as SVGSVGElement | null;
    if (!card || !svg) {
      out[key] = { present: false };
      continue;
    }
    const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number);
    const polys = Array.from(svg.querySelectorAll('polyline'));
    // 取顶点最多的 polyline = 主序列（聚合分：总分；各策略：首条已开策略；净值：净值线；持仓：position_ratio）
    let best: SVGPolylineElement | null = null;
    let bestN = -1;
    for (const p of polys) {
      const n = ((p.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean)).length;
      if (n > bestN) {
        bestN = n;
        best = p;
      }
    }
    const xs: number[] = [];
    const ys: number[] = [];
    if (best) {
      for (const tok of (best!.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean)) {
        const [x, y] = tok.split(',').map(Number);
        if (Number.isFinite(x)) xs.push(x as number);
        if (Number.isFinite(y)) ys.push(y as number);
      }
    }
    const svgRect = svg.getBoundingClientRect();
    /** 每个 vertex 的**屏幕** x（含视口映射；用于「渲染位置」独立读数）。 */
    const ctm = svg.getScreenCTM();
    const pt = svg.createSVGPoint();
    const screenX = xs.map((x) => {
      if (!ctm) return null;
      pt.x = x;
      pt.y = 0;
      return round(pt.matrixTransform(ctm).x);
    });
    out[key] = {
      present: true,
      polyCount: polys.length,
      n: xs.length,
      first: xs[0] ?? null,
      last: xs[xs.length - 1] ?? null,
      yFirst: ys[0] ?? null,
      yLast: ys[ys.length - 1] ?? null,
      head: xs.slice(0, 5),
      tail: xs.slice(-5),
      svg: { rect: rectOf(svg), vb, vbW: vb[2] ?? null, cls: svg.getAttribute('class') },
      card: {
        rect: rectOf(card),
        inlineHeight: card.style.height || null,
        inlineWidth: card.style.width || null,
        flexShrink: card.style.flexShrink || null,
        dataResizable: card.getAttribute('data-resizable'),
      },
      /** px per user unit（用于把 user-unit 偏差换算成屏上 px）。 */
      pxPerUser: svgRect.width > 0 && vb[2] ? round(vb[2]! / svgRect.width) : null,
      screenX,
      xs,
    };
  }
  return out;
}

/** K 线真身：指标集合 / pane 集合与高度 / 数据 / 分隔条命中点 / pane DOM 高度。 */
function probeKlineTruth() {
  interface ChartLike {
    getDataList?: () => Array<{ timestamp: number }>;
    getSize?: (paneId?: string) => { width: number; height: number } | null;
    getPaneOptions?: () => Array<Record<string, unknown>>;
    getIndicators?: () => Array<Record<string, unknown>>;
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  const inner = document.querySelector('[data-testid="kline-chart"]') as HTMLElement | null;
  const target = inner ? inner.getBoundingClientRect().width : 0;
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
  const chosen =
    withData.length > 0
      ? withData.reduce((a, b) => (Math.abs(a.width - target) <= Math.abs(b.width - target) ? a : b))
      : null;
  const res: {
    ok: boolean;
    instanceCount: number;
    dataLen: number | null;
    indicators: Array<{ name: unknown; paneId: unknown; visible: unknown }>;
    paneCount: number | null;
    panes: Array<Record<string, unknown>>;
    sizes: Array<{ paneId: string; w: number; h: number }>;
    paneDomHeights: Array<{ h: number; canvas: number }>;
    separator: { x: number; y: number; count: number } | null;
    chartRect: { x: number; y: number; w: number; h: number } | null;
  } = {
    ok: !!chosen,
    instanceCount: cands.length,
    dataLen: chosen ? chosen.n : null,
    indicators: [],
    paneCount: null,
    panes: [],
    sizes: [],
    paneDomHeights: [],
    separator: null,
    chartRect: null,
  };
  if (inner) {
    const r = inner.getBoundingClientRect();
    res.chartRect = { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
  }
  if (chosen) {
    const c = chosen.c;
    try {
      res.indicators = (c.getIndicators?.() ?? []).map((i) => ({
        name: i['name'],
        paneId: i['paneId'],
        visible: i['visible'],
      }));
    } catch {
      /* ignore */
    }
    try {
      const opts = c.getPaneOptions?.() ?? [];
      const arr = Array.isArray(opts) ? opts : [opts];
      res.paneCount = arr.length;
      res.panes = arr.map((p) => ({
        id: p['id'],
        height: p['height'],
        minHeight: p['minHeight'],
        dragEnabled: p['dragEnabled'],
      }));
    } catch {
      /* ignore */
    }
    const paneIds = new Set<string>(['candle_pane']);
    for (const i of res.indicators) if (typeof i.paneId === 'string') paneIds.add(i.paneId);
    for (const id of paneIds) {
      try {
        const s = c.getSize?.(id);
        if (s) res.sizes.push({ paneId: id, w: round(s.width), h: round(s.height) });
      } catch {
        /* ignore */
      }
    }
  }
  // pane DOM 高度（真身 API 之外的独立口径：含 canvas 的兄弟块）
  if (inner) {
    let host: HTMLElement = inner;
    for (let d = 0; d < 4; d++) {
      const kids = Array.from(host.children) as HTMLElement[];
      const withCanvas = kids.filter((k) => k.querySelectorAll('canvas').length > 0);
      const noCanvas = kids.filter((k) => k.querySelectorAll('canvas').length === 0);
      if (withCanvas.length >= 2 && noCanvas.length >= 1) break;
      const next = withCanvas[0];
      if (!next || kids.length === 0) break;
      host = next;
    }
    res.paneDomHeights = Array.from(host.children).map((el) => ({
      h: round(el.getBoundingClientRect().height),
      canvas: el.querySelectorAll('canvas').length,
    }));
  }
  // 分隔条命中点：**限定在 kline-chart 内**（故不会命中卡片缩放把手）
  if (inner) {
    const cands2 = Array.from(inner.querySelectorAll<HTMLElement>('div')).filter((d) => {
      const r = d.getBoundingClientRect();
      return d.style.cursor === 'ns-resize' && r.width > 100 && r.height <= 10;
    });
    if (cands2.length > 0) {
      const boxes = cands2.map((el) => el.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      const r = boxes[0]!;
      res.separator = {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        count: cands2.length,
        yList: boxes.map((b) => Math.round(b.top)),
      } as never;
    }
  }
  return res;
}

/** 表格类：把手 / inline 高度 / data-resizable（含 3 层祖先）+ ns-resize 光标扫描。 */
function probeTables() {
  const round = (v: number) => Math.round(v * 100) / 100;
  const out: Record<string, unknown> = {};
  for (const id of ['wb-round-trips-table', 'wb-perbar-table', 'wb-event-log']) {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    let ancestorHandles = 0;
    let ancestorInlineHeight: string | null = null;
    let ancestorResizable: string | null = null;
    let cur: HTMLElement | null = el;
    for (let i = 0; i < 3 && cur; i++) {
      ancestorHandles += cur.querySelectorAll('[data-card-resize]').length;
      if (cur.style.height) ancestorInlineHeight = cur.style.height;
      if (cur.getAttribute('data-resizable')) ancestorResizable = cur.getAttribute('data-resizable');
      cur = cur.parentElement;
    }
    const r = el?.getBoundingClientRect();
    out[id] = {
      present: !!el,
      handles: ancestorHandles,
      inlineHeight: el?.style.height || null,
      ancestorInlineHeight,
      ancestorResizable,
      dataResizableSelf: el?.getAttribute('data-resizable') ?? null,
      nsResizeCursors: el
        ? Array.from(el.querySelectorAll<HTMLElement>('*')).filter((c) => getComputedStyle(c).cursor === 'ns-resize')
            .length
        : -1,
      rect: r ? { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) } : null,
      clientHeight: el?.clientHeight ?? null,
      scrollHeight: el?.scrollHeight ?? null,
    };
  }
  return out;
}

/** 指标勾选入口 + 勾选态。 */
function probeToggles() {
  const scope = document.querySelector('[data-testid="wb-indicator-toggles"]');
  const list = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="wb-indicator-toggle-"]'));
  return {
    scopePresent: !!scope,
    count: list.length,
    items: list.map((b) => ({
      key: b.getAttribute('data-testid')!.replace('wb-indicator-toggle-', ''),
      text: (b.textContent ?? '').trim(),
      pressed: b.getAttribute('aria-pressed'),
      inScope: scope != null && scope.contains(b),
    })),
  };
}

function probeStorage() {
  const keys = Object.keys(localStorage).sort();
  const raw: Record<string, string> = {};
  for (const k of keys) raw[k] = localStorage.getItem(k) ?? '';
  return { keys, raw };
}

// ═══════════════════════════ 编排 ═══════════════════════════

async function seedOnce(page: Page): Promise<void> {
  // 首次导航前清空 localStorage 并注入**看板哨兵键**（对照）；sessionStorage 标记 ⇒ 仅首次执行
  await page.addInitScript((sentinel: Array<[string, string]>) => {
    try {
      if (!sessionStorage.getItem('rv_seeded')) {
        localStorage.clear();
        for (const [k, v] of sentinel) localStorage.setItem(k, v);
        sessionStorage.setItem('rv_seeded', '1');
      }
    } catch {
      /* ignore */
    }
  }, SENTINEL_KEYS);
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${runId}`);
  await expect(sel, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-kline-chart')).toBeVisible();
  await expect(page.getByTestId('wb-aggregate-chart')).toBeVisible();
  await page.waitForTimeout(3000);
}

/** 真鼠标拖拽：把手中心 mousedown → mousemove(dy) → mouseup。 */
async function dragHandleBy(page: Page, testid: string, dy: number): Promise<void> {
  const h = page.getByTestId(testid);
  await h.scrollIntoViewIfNeeded();
  const box = await h.boundingBox();
  if (!box) throw new Error(`no boundingBox for ${testid}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dy, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/** 真鼠标拖拽（可控 dx/dy）：用于「只做高度」的行为反证（横向拖不得改宽度）。 */
async function dragHandleByXY(page: Page, testid: string, dx: number, dy: number): Promise<void> {
  const h = page.getByTestId(testid);
  await h.scrollIntoViewIfNeeded();
  const box = await h.boundingBox();
  if (!box) throw new Error(`no boundingBox for ${testid}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

async function dragAt(page: Page, x: number, y: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}

const names = (t: { indicators: Array<{ name: unknown }> }) => t.indicators.map((i) => String(i.name)).sort();
const sizeOf = (t: { sizes: Array<{ paneId: string; h: number }> }, paneId: unknown) =>
  t.sizes.find((s) => s.paneId === paneId)?.h ?? null;
/** **副图** pane 集合（klinecharts v10：pane 集合含 `candle_pane` 与独立 `x_axis_pane`，二者非副图）。 */
const subPanes = (t: { indicators: Array<{ paneId: unknown }> }) =>
  Array.from(new Set(t.indicators.map((i) => String(i.paneId)).filter((p) => p !== 'candle_pane'))).sort();
/** 非副图 pane（主图 + x 轴）。 */
const basePaneIds = ['candle_pane', 'x_axis_pane'];

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('RV-1 指标选择入口 + 切换真身 + 配置隔离（localStorage 增量 / 看板哨兵键 / 网络写入）', async ({ page }) => {
  const writes: string[] = [];
  const configReqs: string[] = [];
  page.on('request', (r) => {
    const m = r.method();
    if (m !== 'GET' && m !== 'HEAD') writes.push(`${m} ${r.url()}`);
    if (r.url().includes('/api/config/')) configReqs.push(`${m} ${r.url()}`);
  });
  await seedOnce(page);
  await page.addInitScript(installChartCapture);
  await openRun(page, RUN_ID);

  const toggles0 = await page.evaluate(probeToggles);
  const truth0 = await page.evaluate(probeKlineTruth);
  const storage0 = await page.evaluate(probeStorage);

  await page.getByTestId('wb-indicator-toggle-vol').click();
  await page.waitForTimeout(700);
  const truth1 = await page.evaluate(probeKlineTruth);
  const toggles1 = await page.evaluate(probeToggles);

  await page.getByTestId('wb-indicator-toggle-macd').click();
  await page.waitForTimeout(900);
  const truth2 = await page.evaluate(probeKlineTruth);

  await page.getByTestId('wb-indicator-toggle-kdj').click();
  await page.waitForTimeout(900);
  const truth3 = await page.evaluate(probeKlineTruth);
  const toggles3 = await page.evaluate(probeToggles);
  const storage3 = await page.evaluate(probeStorage);

  writeJson('rv1_indicators_isolation', {
    toggles0,
    toggles1,
    toggles3,
    names0: names(truth0),
    names1: names(truth1),
    names2: names(truth2),
    names3: names(truth3),
    paneCount0: truth0.paneCount,
    paneCount1: truth1.paneCount,
    paneCount2: truth2.paneCount,
    paneCount3: truth3.paneCount,
    panes2: truth2.panes,
    storage0,
    storage3,
    writes,
    configReqs,
  });

  // ① 入口存在且 6 枚（都在结果页 K 线卡内）
  expect(toggles0.scopePresent, '结果页 K 线卡必须有指标勾选入口').toBe(true);
  expect(toggles0.count, '指标勾选入口枚数 = 名单长度 6').toBe(6);
  expect(
    toggles0.items.every((i) => i.inScope),
    '6 枚按钮必须都在结果页入口容器内',
  ).toBe(true);
  // ② 默认 = DASHBOARD_DEFAULTS（vol 开）且**未读**注入的看板哨兵键（macd/kdj=true）
  expect(toggles0.items.find((i) => i.key === 'vol')?.pressed, '默认 vol 开').toBe('true');
  expect(toggles0.items.find((i) => i.key === 'macd')?.pressed, '默认 macd 关').toBe('false');
  expect(toggles0.items.find((i) => i.key === 'kdj')?.pressed, '默认 kdj 关').toBe('false');
  expect(names(truth0), '默认真身 = MA + VOL').toEqual(['MA', 'VOL']);
  expect(subPanes(truth0), '默认副图 pane 集合 = [VOL 的 pane]（klinecharts v10 pane 数含 candle/x_axis）').toEqual([
    String(truth0.indicators.find((i) => String(i.name) === 'VOL')?.paneId),
  ]);
  // ③ 切换 ⇒ 真身变化
  expect(toggles1.items.find((i) => i.key === 'vol')?.pressed, '点击后 vol 关').toBe('false');
  expect(names(truth1), 'VOL 关 ⇒ 真身无 VOL').toEqual(['MA']);
  expect(subPanes(truth1), '关掉唯一副图 ⇒ 副图 pane 集合为空').toEqual([]);
  expect(names(truth2), 'MACD 开 ⇒ 真身含 MACD').toEqual(['MA', 'MACD']);
  expect(names(truth3), 'KDJ 开 ⇒ 真身含 KDJ').toEqual(['KDJ', 'MA', 'MACD']);
  expect(subPanes(truth2).length, 'MACD 单独占 1 个副图 pane').toBe(1);
  expect(subPanes(truth3).length, 'MACD + KDJ = 2 个副图 pane').toBe(2);
  // ④ 隔离性（localStorage 增量 + 哨兵键逐字节不变）
  expect(
    storage0.keys.filter((k) => !SENTINEL_KEYS.map(([s0]) => s0).includes(k)),
    '未操作前不得写入任何存储键（惰性写入，无副作用）',
  ).toEqual([]);
  const sentinelNames = SENTINEL_KEYS.map(([k]) => k);
  expect(
    storage3.keys.filter((k) => !sentinelNames.includes(k)),
    'localStorage 增量必须只有结果页这一个 key',
  ).toEqual([RESULT_KEY]);
  for (const [k, v] of SENTINEL_KEYS) {
    expect(storage3.raw[k], `看板哨兵键 ${k} 必须逐字节不变`).toBe(v);
  }
  const parsed = JSON.parse(storage3.raw[RESULT_KEY]!) as { indicators: Record<string, boolean> };
  expect(parsed.indicators['vol'], '落盘 vol=false').toBe(false);
  expect(parsed.indicators['macd'], '落盘 macd=true').toBe(true);
  expect(parsed.indicators['kdj'], '落盘 kdj=true').toBe(true);
  // ⑤ 隔离性（网络写入：看板配置的权威通道是服务端，结果页不得写）
  expect(
    writes.filter((u) => u.includes('/api/config/')),
    '结果页指标/高度操作不得产生任何对看板配置端点的写请求',
  ).toEqual([]);
});

test('RV-2 K 线卡拖高 + 双击复位 + 副图 pane 高度在指标切换后保持 + 无残留 pane', async ({ page }) => {
  await seedOnce(page);
  await page.addInitScript(installChartCapture);
  await openRun(page, RUN_ID);

  const cards0 = await page.evaluate(probeCards);
  const truth0 = await page.evaluate(probeKlineTruth);
  const volPaneId = truth0.indicators.find((i) => String(i.name) === 'VOL')?.paneId;
  const volH0 = sizeOf(truth0, volPaneId);

  // ① 拖 VOL 副图分隔条（真鼠标）⇒ 副图高度必须变化（证明「已拖过」）
  const sep = truth0.separator;
  expect(sep, 'klinecharts 分隔条必须可定位（VOL 副图存在）').not.toBeNull();
  await dragAt(page, sep!.x, sep!.y, 40);
  const truth1 = await page.evaluate(probeKlineTruth);
  const volH1 = sizeOf(truth1, volPaneId);

  // ② 拖 K 线卡下边缘 +150
  const klineH0 = H(cards0.cards['kline'].rect.h);
  const innerH0 = H(cards0.cards['kline'].klineInner?.h);
  await dragHandleBy(page, 'wb-card-resize-kline', 150);
  const cards1 = await page.evaluate(probeCards);
  const truth1b = await page.evaluate(probeKlineTruth);
  const klineH1 = H(cards1.cards['kline'].rect.h);
  const innerH1 = H(cards1.cards['kline'].klineInner?.h);
  const volH1b = sizeOf(truth1b, volPaneId);

  // ③ MACD 开（副图切换）⇒ 已拖高度的 VOL pane 必须保持（基线 = 卡片拖高之后、切换之前）
  await page.getByTestId('wb-indicator-toggle-macd').click();
  await page.waitForTimeout(1400);
  const truth2 = await page.evaluate(probeKlineTruth);
  const volH2 = sizeOf(truth2, volPaneId);
  const macdPaneId = truth2.indicators.find((i) => String(i.name) === 'MACD')?.paneId;
  const macdH2 = sizeOf(truth2, macdPaneId);

  // ④ 双击 K 线卡标题 ⇒ 复位
  await page.getByTestId('wb-card-title-kline').dblclick();
  await page.waitForTimeout(700);
  const cards2 = await page.evaluate(probeCards);
  const klineH2 = H(cards2.cards['kline'].rect.h);
  const innerH2 = H(cards2.cards['kline'].klineInner?.h);

  // ⑤ 关掉全部副图指标（MACD 关、VOL 关）⇒ 无残留空 pane
  await page.getByTestId('wb-indicator-toggle-macd').click();
  await page.waitForTimeout(900);
  await page.getByTestId('wb-indicator-toggle-vol').click();
  await page.waitForTimeout(1400);
  const truth3 = await page.evaluate(probeKlineTruth);
  const cards3 = await page.evaluate(probeCards);

  writeJson('rv2_kline_resize_pane', {
    sepBefore: sep,
    volPaneId,
    volH0,
    volH1,
    volH1b,
    volH2,
    macdPaneId,
    macdH2,
    klineH0,
    klineH1,
    klineH2,
    innerH0,
    innerH1,
    innerH2,
    card0: cards0.cards['kline'],
    card1: cards1.cards['kline'],
    card2: cards2.cards['kline'],
    card3: cards3.cards['kline'],
    sizes0: truth0.sizes,
    sizes1: truth1.sizes,
    sizes2: truth2.sizes,
    sizes3: truth3.sizes,
    sepCount3: truth3.separator?.count ?? 0,
    subPanes0: subPanes(truth0),
    subPanes2: subPanes(truth2),
    subPanes3: subPanes(truth3),
    paneIds3: truth3.panes.map((p) => String(p.id)),
    indicators3: names(truth3),
    paneCount3: truth3.paneCount,
    paneDomHeights3: truth3.paneDomHeights,
  });

  // ① 分隔条拖拽真实生效（副图高度可读且相对默认值变化 ≥ 20px）
  expect(volH0, '默认 VOL pane 高度必须可读').not.toBeNull();
  expect(volH1, '拖后 VOL pane 高度必须可读').not.toBeNull();
  expect(
    Math.abs(H(volH1) - H(volH0)),
    `真鼠标拖分隔条必须改变副图高度（${volH0} → ${volH1}）`,
  ).toBeGreaterThanOrEqual(20);
  // ② 卡片拖高 ⇒ 卡片与内层图表同时跟随（+150）
  expect(klineH1 - klineH0, `K 线卡高度必须 +150（实测 ${klineH0}→${klineH1}）`).toBeGreaterThanOrEqual(145);
  expect(klineH1 - klineH0, '增量不得超出拖拽量').toBeLessThanOrEqual(155);
  expect(innerH1 - innerH0, `内层 klinecharts 容器必须跟随（实测 ${innerH0}→${innerH1}）`).toBeGreaterThanOrEqual(145);
  expect(innerH1 - innerH0).toBeLessThanOrEqual(155);
  // ③ 双击标题 ⇒ 复位到默认 256 / 内层 194
  expect(Math.abs(klineH2 - klineH0), `双击标题后卡片必须复位到默认（${klineH0} → ${klineH2}）`).toBeLessThanOrEqual(1);
  expect(cards2.cards['kline'].inlineHeight, '复位后不得残留 inline 高度').toBeNull();
  expect(Math.abs(innerH2 - innerH0), '复位后内层高度回到默认').toBeLessThanOrEqual(1);
  // ④ 副图切换后 pane 高度保持
  expect(volH1b, '切换前 VOL pane 高度必须可读').not.toBeNull();
  expect(
    Math.abs(H(volH2) - H(volH1b)),
    `指标切换后已拖高度的 VOL pane 必须保持（切换前 ${volH1b} / 切换后 ${volH2}）`,
  ).toBeLessThanOrEqual(2);
  expect(H(volH2), 'VOL pane 高度不得被重置回默认').not.toBe(H(volH0));
  expect(macdPaneId, 'MACD 必须新建独立 pane').toBeTruthy();
  expect(macdPaneId, 'MACD pane ≠ VOL pane').not.toBe(volPaneId);
  expect(H(macdH2), 'MACD pane 高度必须可读').toBeGreaterThan(0);
  expect(subPanes(truth2).length, 'MACD 打开后副图 pane 数 = 2（VOL + MACD）').toBe(2);
  // ⑤ 关掉全部副图 ⇒ 无残留空 pane（真身 pane 数 + DOM 分隔条数双口径）
  expect(subPanes(truth3), '关闭全部副图指标后不得残留任何副图 pane（空 pane 即在此变红）').toEqual([]);
  expect(
    (truth3.panes.map((p) => String(p.id)).filter((id) => !basePaneIds.includes(id))).join(','),
    'pane 集合须只剩主图 + x 轴',
  ).toBe('');
  expect(names(truth3), '关闭全部副图后真身只剩 MA').toEqual(['MA']);
  expect(truth3.separator?.count ?? 0, '无残留空 pane ⇒ DOM 中不得再有分隔条').toBe(0);
});

test('RV-3 曲线卡拖高（聚合分 / 净值+回撤）+ 双击复位 + 只做高度（宽度与 x 几何不变）', async ({ page }) => {
  await seedOnce(page);
  await page.addInitScript(installChartCapture);
  await openRun(page, RUN_ID);
  await page.waitForTimeout(1500);

  const results: Record<string, unknown> = {};
  for (const key of ['aggregate', 'equity'] as const) {
    const curve0 = (await page.evaluate(probeCurves))[key] as Record<string, unknown>;
    const card0 = curve0.card as Record<string, unknown>;
    const svg0 = curve0.svg as Record<string, unknown>;
    const svgRect0 = svg0.rect as Record<string, number>;
    const cardRect0 = card0.rect as Record<string, number>;

    await dragHandleBy(page, `wb-card-resize-${key}`, 60);
    const curve1 = (await page.evaluate(probeCurves))[key] as Record<string, unknown>;
    const card1 = curve1.card as Record<string, unknown>;
    const svg1 = curve1.svg as Record<string, unknown>;
    const svgRect1 = svg1.rect as Record<string, number>;
    const cardRect1 = card1.rect as Record<string, number>;

    await page.getByTestId(`wb-card-title-${key}`).dblclick();
    await page.waitForTimeout(700);
    const curve2 = (await page.evaluate(probeCurves))[key] as Record<string, unknown>;
    const card2 = curve2.card as Record<string, unknown>;
    const svg2 = curve2.svg as Record<string, unknown>;
    const svgRect2 = svg2.rect as Record<string, number>;
    const cardRect2 = card2.rect as Record<string, number>;

    results[key] = {
      card0,
      card1,
      card2,
      svg0: svg0,
      svg1: svg1,
      svg2: svg2,
      cardRect: [cardRect0.h, cardRect1.h, cardRect2.h],
      svgRect: [svgRect0.h, svgRect1.h, svgRect2.h],
      svgW: [svgRect0.w, svgRect1.w, svgRect2.w],
      cardW: [cardRect0.w, cardRect1.w, cardRect2.w],
      xsEqual: JSON.stringify(curve1.xs) === JSON.stringify(curve0.xs),
      xsEqualAfterReset: JSON.stringify(curve2.xs) === JSON.stringify(curve0.xs),
    };

    // ① 拖高 ⇒ 卡片与 svg 同步变高（内层不再固定 h-40/h-52）
    expect(cardRect1.h - cardRect0.h, `[${key}] 卡片高度必须 +60（实测 ${cardRect0.h}→${cardRect1.h}）`).toBeGreaterThanOrEqual(
      55,
    );
    expect(cardRect1.h - cardRect0.h).toBeLessThanOrEqual(65);
    expect(
      svgRect1.h - svgRect0.h,
      `[${key}] svg 高度必须随容器（实测 ${svgRect0.h}→${svgRect1.h}）——固定高度即在此变红`,
    ).toBeGreaterThanOrEqual(55);
    expect(String(svg1.cls), `[${key}] 受控态 svg 类名须为跟随容器`).toContain('h-full');
    expect(String(svg0.cls), `[${key}] 默认态 svg 类名须仍为固定高度（未被无条件改写）`).toMatch(/h-(40|36|52)/);
    // ② 只做高度：宽度 / viewBox / 顶点 userX 全不变
    expect(Math.abs(cardRect1.w - cardRect0.w), `[${key}] 卡片宽度不得变化`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(svgRect1.w - svgRect0.w), `[${key}] svg 宽度不得变化`).toBeLessThanOrEqual(0.5);
    expect(svg1.viewBox, `[${key}] viewBox 不得变化（x 映射未动）`).toBe(svg0.viewBox);
    expect(JSON.stringify(curve1.xs), `[${key}] 顶点 userX 必须逐点不变（只做高度）`).toBe(JSON.stringify(curve0.xs));
    expect(card1.inlineWidth, `[${key}] 不得写 inline 宽度`).toBeNull();
    // ③ 双击标题 ⇒ 复位到默认
    expect(Math.abs(cardRect2.h - cardRect0.h), `[${key}] 双击后卡片高度必须复位（实测 ${cardRect2.h}）`).toBeLessThanOrEqual(1);
    expect(Math.abs(svgRect2.h - svgRect0.h), `[${key}] 双击后 svg 高度必须复位`).toBeLessThanOrEqual(1);
    expect(card2.inlineHeight, `[${key}] 复位后不得残留 inline 高度`).toBeNull();
    expect(String(svg2.cls), `[${key}] 复位后 svg 类名回到默认固定高度`).toBe(String(svg0.cls));
  }

  // ④ 只做高度：结果页内不得存在宽度类缩放把手（ew/col/w/e-resize）；把手必须是下边缘细条
  const cards = await page.evaluate(probeCards);
  const handles: Array<Record<string, unknown>> = [];
  for (const r of [
    { card: 'wb-aggregate-chart', key: 'aggregate' },
    { card: 'wb-slot-chart', key: 'slot' },
    { card: 'wb-equity-chart', key: 'equity' },
    { card: 'wb-position-chart', key: 'position' },
  ]) {
    const c = cards.cards[r.key] as Record<string, unknown>;
    const h = c.handle as Record<string, unknown> | null;
    const cr = c.rect as Record<string, number>;
    const hr = h?.rect as Record<string, number> | undefined;
    handles.push({
      card: r.key,
      count: H(c.handleCount),
      h: hr?.h ?? -1,
      w: hr?.w ?? -1,
      cursor: String(h?.cursor),
      bottomGap: hr && cr ? Math.round((cr.y + cr.h - (hr.y + hr.h)) * 100) / 100 : -1,
      cardW: cr?.w ?? -1,
      dataResizable: c.dataResizable,
    });
  }
  // ⑤ 只做高度（**行为**反证）：在把手横向拖 +80px 不得改变卡片与 svg 宽度（也不得改高度）
  const aggBefore = (await page.evaluate(probeCurves))['aggregate'] as Record<string, unknown>;
  await dragHandleByXY(page, 'wb-card-resize-aggregate', 80, 0);
  const aggAfter = (await page.evaluate(probeCurves))['aggregate'] as Record<string, unknown>;
  const wRect = (c: Record<string, unknown>) => ({
    card: (c.card as { rect: Record<string, number> }).rect,
    svg: (c.svg as { rect: Record<string, number> }).rect,
    xs: c.xs,
  });
  const wr0 = wRect(aggBefore);
  const wr1 = wRect(aggAfter);
  const horizontalDrag = {
    cardWidth: [wr0.card.w, wr1.card.w],
    svgWidth: [wr0.svg.w, wr1.svg.w],
    cardHeight: [wr0.card.h, wr1.card.h],
    svgViewBox: [(aggBefore.svg as { viewBox: string }).viewBox, (aggAfter.svg as { viewBox: string }).viewBox],
    xsEqual: JSON.stringify(wr0.xs) === JSON.stringify(wr1.xs),
    inlineWidth: (aggAfter.card as { inlineWidth: string | null }).inlineWidth,
  };
  expect(Math.abs(horizontalDrag.cardWidth[1]! - horizontalDrag.cardWidth[0]!), '横向拖把手不得改变卡片宽度').toBeLessThanOrEqual(
    0.5,
  );
  expect(Math.abs(horizontalDrag.svgWidth[1]! - horizontalDrag.svgWidth[0]!), '横向拖把手不得改变 svg 宽度').toBeLessThanOrEqual(
    0.5,
  );
  expect(Math.abs(horizontalDrag.cardHeight[1]! - horizontalDrag.cardHeight[0]!), '横向拖（dy=0）不得改变高度').toBeLessThanOrEqual(
    1,
  );
  expect(horizontalDrag.xsEqual, '横向拖后顶点 userX 必须逐点不变').toBe(true);
  expect(horizontalDrag.inlineWidth, '不得写 inline 宽度').toBeNull();

  writeJson('rv3_curve_resize', { results, handles, widthCursors: cards.widthCursors, horizontalDrag });

  expect(
    cards.widthCursors.filter((c) => !c.inKlineEngine),
    '本波不得引入任何宽度类（ew/col/w/e-resize）缩放把手（klinecharts 内建控件另行记录）',
  ).toEqual([]);
  expect(
    cards.widthCursors.filter((c) => c.inResizableCard && !c.inKlineEngine),
    '五张可缩放卡内不得有宽度类光标元素',
  ).toEqual([]);
  for (const h of handles) {
    expect(h.count, `[${h.card}] 恰好 1 个高度把手（下边缘）`).toBe(1);
    expect(H(h.h), `[${h.card}] 把手高度须为下边缘细条（≤8px）`).toBeLessThanOrEqual(8);
    expect(h.cursor, `[${h.card}] 把手光标须为 ns-resize（纵向）`).toBe('ns-resize');
    expect(Math.abs(H(h.bottomGap)), `[${h.card}] 把手须贴在卡片下边缘`).toBeLessThanOrEqual(1);
    expect(Math.abs(H(h.w) - H(h.cardW)), `[${h.card}] 把手横向铺满卡片（下边缘整条）`).toBeLessThanOrEqual(2);
  }
});

test('RV-4 表格类无高度把手 / 无 inline 高度；PAD 单源（运行期）与跨视图同一 bar 偏差', async ({ page }) => {
  await seedOnce(page);
  await page.addInitScript(installChartCapture);
  await openRun(page, RUN_ID);
  await page.waitForTimeout(1200);

  // ── 表格类：三个 tab 逐个挂载并探测
  const tables: Record<string, unknown> = {};
  for (const [tab, id] of [
    ['trades', 'wb-round-trips-table'],
    ['perbar', 'wb-perbar-table'],
    ['events', 'wb-event-log'],
  ] as Array<[string, string]>) {
    await page.getByTestId(`wb-tab-${tab}`).click();
    await page.waitForTimeout(1400);
    const probe = await page.evaluate(probeTables);
    tables[`${tab}:${id}`] = probe[id];
  }

  // ── PAD / 跨视图偏差（渲染顶点为准）
  await page.getByTestId('wb-tab-trades').click();
  await page.waitForTimeout(900);
  const curves = await page.evaluate(probeCurves);
  const padRuntime = CURVE_KEYS.map((k) => {
    const c = curves[k] as Record<string, unknown>;
    const svg = c.svg as Record<string, unknown>;
    const n = H(c.n);
    const xs = c.xs as number[];
    // 顶点序 = bar 序的独立校验：x_j 必须精确落在 PAD + j*plotW/(n-1)（1 位小数容差）
    const step = n > 1 ? CURVE_PLOT_W / (n - 1) : 0;
    let mappingResidualMax = 0;
    for (let j = 0; j < xs.length; j++) {
      mappingResidualMax = Math.max(mappingResidualMax, Math.abs(xs[j]! - (CURVE_PAD + j * step)));
    }
    return {
      key: k,
      n,
      first: c.first,
      last: c.last,
      vbW: svg.vbW ?? null,
      pxPerUser: c.pxPerUser,
      mappingResidualMax: Math.round(mappingResidualMax * 1000) / 1000,
    };
  });
  // 跨视图同一 bar（逐顶点）userX 偏差
  const crossView: Array<Record<string, unknown>> = [];
  for (let a = 0; a < CURVE_KEYS.length; a++) {
    for (let b = a + 1; b < CURVE_KEYS.length; b++) {
      const A = curves[CURVE_KEYS[a]!] as Record<string, unknown>;
      const B = curves[CURVE_KEYS[b]!] as Record<string, unknown>;
      const xsA = A.xs as number[];
      const xsB = B.xs as number[];
      const n = Math.min(xsA.length, xsB.length);
      let maxUser = 0;
      let argJ = -1;
      for (let j = 0; j < n; j++) {
        const d = Math.abs(xsA[j]! - xsB[j]!);
        if (d > maxUser) {
          maxUser = d;
          argJ = j;
        }
      }
      crossView.push({
        pair: `${CURVE_KEYS[a]}-${CURVE_KEYS[b]}`,
        paired: n,
        maxUserDelta: Math.round(maxUser * 1000) / 1000,
        argJ,
        pxDeltaOnA: Math.round((maxUser / H(A.pxPerUser)) * 1000) / 1000,
        pxDeltaOnB: Math.round((maxUser / H(B.pxPerUser)) * 1000) / 1000,
      });
    }
  }
  const meta = Object.fromEntries(
    CURVE_KEYS.map((k) => {
      const c = curves[k] as Record<string, unknown>;
      return [k, { svg: c.svg, card: c.card, pxPerUser: c.pxPerUser, polyCount: c.polyCount }];
    }),
  );
  writeJson('rv4_tables_pad', { tables, padRuntime, crossView, meta });

  for (const [key, t] of Object.entries(tables)) {
    const tt = t as Record<string, unknown>;
    expect(tt.present, `${key} 必须存在`).toBe(true);
    expect(tt.handles, `${key} 不得有高度把手`).toBe(0);
    expect(tt.inlineHeight, `${key} 不得有 inline 高度`).toBeNull();
    expect(tt.ancestorInlineHeight, `${key} 祖先 3 层内不得有 inline 高度`).toBeNull();
    expect(tt.ancestorResizable, `${key} 祖先不得被标记为可缩放卡`).toBeNull();
    expect(tt.nsResizeCursors, `${key} 内不得有 ns-resize 把手`).toBe(0);
  }
  // 运行期：四张曲线的绘图区首末顶点必须精确落在 PAD=8 / W−PAD=992（口径单源的运行期证据）
  for (const p of padRuntime) {
    expect(H(p.first), `[${p.key}] 首顶点 userX 必须 = ${CURVE_PAD}（实测 ${p.first}）`).toBe(CURVE_PAD);
    expect(H(p.last), `[${p.key}] 末顶点 userX 必须 = ${CURVE_W - CURVE_PAD}（实测 ${p.last}）`).toBe(CURVE_W - CURVE_PAD);
    expect(H(p.mappingResidualMax), `[${p.key}] 顶点须按 bar 序等距（容差 ${X_ROUND_TOL}）`).toBeLessThanOrEqual(
      X_ROUND_TOL,
    );
  }
  expect(
    padRuntime.map((p) => H(p.n)).every((n) => n === H(padRuntime[0]!.n)),
    `四张曲线顶点数须一致（同一窗口 ⇒ 逐顶点可比）：${JSON.stringify(padRuntime.map((p) => p.n))}`,
  ).toBe(true);
  for (const c of crossView) {
    expect(H(c.maxUserDelta), `[${c.pair}] 跨视图同一 bar 偏差须 ≤ 0.1 user unit（实测 ${c.maxUserDelta}）`).toBeLessThanOrEqual(
      0.1,
    );
    expect(
      Math.min(H(c.pxDeltaOnA), H(c.pxDeltaOnB)),
      `[${c.pair}] 跨视图偏差须 ≤ 0.1px（实测 ${c.pxDeltaOnA}px / ${c.pxDeltaOnB}px）`,
    ).toBeLessThanOrEqual(0.1);
  }
});

test('RV-5 持久化：刷新后卡片高度与指标选择保持（且 localStorage 仍只有结果页一个键）', async ({ page }) => {
  await seedOnce(page);
  await page.addInitScript(installChartCapture);
  await openRun(page, RUN_ID);
  const cards0 = await page.evaluate(probeCards);
  const before = H(cards0.cards['kline'].rect.h);

  await dragHandleBy(page, 'wb-card-resize-kline', 120);
  await page.getByTestId('wb-indicator-toggle-macd').click();
  await page.waitForTimeout(1000);
  const cards1 = await page.evaluate(probeCards);
  const after = H(cards1.cards['kline'].rect.h);
  const storage1 = await page.evaluate(probeStorage);
  const toggles1 = await page.evaluate(probeToggles);
  const truth1 = await page.evaluate(probeKlineTruth);

  // 刷新（同一浏览器/同一 origin ⇒ localStorage 保留）
  await page.reload();
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  await page.getByTestId(`wb-run-select-${RUN_ID}`).click();
  await expect(page.getByTestId('wb-kline-chart')).toBeVisible();
  await page.waitForTimeout(3000);
  const cards2 = await page.evaluate(probeCards);
  const toggles2 = await page.evaluate(probeToggles);
  const truth2 = await page.evaluate(probeKlineTruth);
  const storage2 = await page.evaluate(probeStorage);

  writeJson('rv5_persistence', {
    before,
    after,
    afterReload: H(cards2.cards['kline'].rect.h),
    storage1,
    storage2,
    toggles1,
    toggles2,
    names1: names(truth1),
    names2: names(truth2),
  });

  expect(after - before, `K 线卡拖高须生效（${before}→${after}）`).toBeGreaterThanOrEqual(115);
  expect(toggles1.items.find((i) => i.key === 'macd')?.pressed, '切换后 macd 开').toBe('true');
  // 刷新后
  expect(Math.abs(H(cards2.cards['kline'].rect.h) - after), `刷新后卡片高度必须保持 ${after}`).toBeLessThanOrEqual(1);
  expect(toggles2.items.find((i) => i.key === 'macd')?.pressed, '刷新后 macd 选择保持').toBe('true');
  expect(toggles2.items.find((i) => i.key === 'vol')?.pressed, '刷新后 vol 默认保持开启').toBe('true');
  const names2 = names(truth2);
  expect(names2.includes('MACD'), `刷新后真身必须含 MACD（实测 ${JSON.stringify(names2)}）`).toBe(true);
  // 键数仍只有「结果页 key + 注入哨兵键」
  const sentinelNames = SENTINEL_KEYS.map(([k]) => k);
  expect(storage2.keys.filter((k) => !sentinelNames.includes(k)), '刷新后 localStorage 仍只有结果页一个键').toEqual([
    RESULT_KEY,
  ]);
  for (const [k, v] of SENTINEL_KEYS) {
    expect(storage2.raw[k], `刷新后看板哨兵键 ${k} 仍须逐字节不变`).toBe(v);
  }
});

test('RV-6 隔离性（跨页对照）：结果页改动不得影响看板指标会话态，看板亦不得新增存储键', async ({ page }) => {
  await seedOnce(page);
  await page.addInitScript(installChartCapture);
  await openRun(page, RUN_ID);
  // 结果页：开 MACD、关 VOL（与看板默认相反）
  await page.getByTestId('wb-indicator-toggle-macd').click();
  await page.getByTestId('wb-indicator-toggle-vol').click();
  await page.waitForTimeout(900);
  const resultToggles = await page.evaluate(probeToggles);
  const truthResult = await page.evaluate(probeKlineTruth);
  const storageAfterResult = await page.evaluate(probeStorage);

  // 切到看板页（同一浏览器上下文、同一 origin）
  await page.goto('/');
  await expect(page.locator('[data-region="toolbar"]')).toBeVisible();
  await page.waitForTimeout(2500);
  const dash = await page.evaluate(() => {
    const scope = document.querySelector('[data-region="toolbar"]');
    const btns = Array.from(document.querySelectorAll<HTMLElement>('[data-indicator]')).map((b) => ({
      key: b.getAttribute('data-indicator'),
      pressed: b.getAttribute('aria-pressed'),
      inToolbar: scope != null && scope.contains(b),
    }));
    return { btns, lsKeys: Object.keys(localStorage).sort(), toolbarCount: scope ? scope.querySelectorAll('[data-indicator]').length : -1 };
  });
  const storageAfterDash = await page.evaluate(probeStorage);
  writeJson('rv6_dashboard_isolation', { resultToggles, namesResult: names(truthResult), storageAfterResult, dash, storageAfterDash });

  expect(resultToggles.items.find((i) => i.key === 'macd')?.pressed, '结果页 macd=开').toBe('true');
  expect(resultToggles.items.find((i) => i.key === 'vol')?.pressed, '结果页 vol=关').toBe('false');
  // 看板默认（DASHBOARD_DEFAULTS：ma/vol 开，其余关）——不得被结果页状态覆盖
  expect(dash.toolbarCount, '看板工具条必须渲染同一套 6 枚指标入口').toBe(6);
  expect(dash.btns.every((b) => b.inToolbar), '看板的指标按钮必须渲染在工具条内').toBe(true);
  expect(dash.btns.find((b) => b.key === 'vol')?.pressed, '看板 vol 必须仍为默认开（未被结果页改动覆盖）').toBe('true');
  expect(dash.btns.find((b) => b.key === 'macd')?.pressed, '看板 macd 必须仍为默认关').toBe('false');
  // 看板侧不得新增任何存储键
  expect(
    storageAfterDash.keys.filter((k) => !SENTINEL_KEYS.map(([s0]) => s0).includes(k)),
    '看板页不得新增存储键（结果页配置不被看板读写）',
  ).toEqual([RESULT_KEY]);
});
