/**
 * 临时取证规格（tester，单次波次；跑完即删，源码归档到
 *  `tester/evidence/20260920_marker_race_verify/raw/probe_source_zz_order_independence.e2e.ts`）。
 *
 * 目的：**独立**复验「买卖标记竞态丢失」修复的次序无关性 —— 用 tester 自己的注入手段
 * （`page.route` 分别推迟 `/api/kline` 或 `run 级 /fills`），验证两种提交次序下标记**都能出现**：
 *   ① `data-marker-overlays` == `wb-fills-note` 的已加载成交笔数（DOM 口径）
 *   ② 真图表 store `getOverlays({name:'fillDot'})` 数量 == 同一期望（store 口径）
 *   ③ 每个 fillDot 的渲染位置（convertToPixel + stackIndex）处**确有该笔颜色（买 #ff5c6c / 卖 #00e0a4）
 *      的 canvas 墨迹**（像素口径，逐笔）
 *   ④ 历史红断言（T4「跳转后目标笔几何必须可测」）在同一注入下复跑
 *
 * 运行（单车道）：
 *   cd web && timeout 300 env E2E_BASE_URL=http://localhost:8081 ZZ_INJ=kline ZZ_OUT=<dir> \
 *     npx playwright test e2e/zz-tester-order-independence.e2e.ts --workers=1 --retries=0 --reporter=list
 *   （ZZ_INJ=fills 为反序）
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.env.ZZ_OUT ?? '/tmp/zz-order';
const INJ = process.env.ZZ_INJ ?? 'none';
const INJ_MS = Number(process.env.ZZ_INJ_MS ?? '1500');
const RUN_A = process.env.ZZ_RUN ?? 'sr_1789865219068_000001';
const RT_A = Number(process.env.ZZ_RT ?? '1');
const FILL_A = Number(process.env.ZZ_FILL_A ?? '42');
const FILL_B = Number(process.env.ZZ_FILL_B ?? '43');

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

const PAGE_CAPTURE = `
  (() => {
    const w = window;
    w.__zzCharts = [];
    const orig = Map.prototype.set;
    Map.prototype.set = function (k, v) {
      try {
        if (v && typeof v === 'object' && typeof v.convertToPixel === 'function' && typeof v.getDataList === 'function') {
          w.__zzCharts.push(v);
        }
      } catch {}
      return orig.call(this, k, v);
    };
  })();
`;

/** 期望标记数（与冻结规格同口径：note 文案解析，无法解析 ⇒ 显式抛错）。 */
function wantFromNote(note: string): number {
  if (note.includes('加载中') || note.includes('未记录')) return 0;
  const m = /已加载\s*(\d+)\s*\/\s*共\s*(\d+)/.exec(note);
  if (!m) throw new Error(`wb-fills-note 文案无法解析：${note}`);
  return Number(m[1]);
}

async function state(page: Page) {
  const dataLens = await page.evaluate(() => {
    const w = window as unknown as { __zzCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    return (w.__zzCharts ?? []).map((c) => {
      try {
        return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length;
      } catch {
        return -1;
      }
    });
  });
  return {
    maxDataLen: dataLens.reduce((a, b) => Math.max(a, b), 0),
    markers: (await page.getByTestId('kline-chart').getAttribute('data-marker-overlays')) ?? '',
    note: (await page.getByTestId('wb-fills-note').textContent()) ?? '',
  };
}

/** 真图表 store 内的 fillDot（点 + 锚点价/ts/颜色/堆叠序 + 渲染位置）。
 *  像素采样在此函数内完成（同一次 evaluate 里合成所有 canvas 后逐笔取色）。 */
async function storeAndPixels(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __zzCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__zzCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return { ok: false, names: [] as string[], dots: [], pixel: { inkMedian: 0, dotsWithInk: 0, readErrors: [] as string[] } };
    const chart = cands[0]!;
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    const names = ((chart['getOverlays'] as () => Array<Record<string, unknown>>)() ?? []).map((o) => String(o['name']));

    // ── canvas 合成网格（CSS px 口径；DPR=1）──
    const kl = document.querySelector('[data-testid="kline-chart"]') as HTMLElement;
    const kr = kl.getBoundingClientRect();
    const W = Math.round(kr.width);
    const H = Math.round(kr.height);
    const grid = new Uint8Array(W * H); // 0=空 1=买色 2=卖色
    const readErrors: string[] = [];
    const near = (r: number, g: number, b: number, t: readonly number[]) =>
      Math.abs(r - t[0]!) <= 45 && Math.abs(g - t[1]!) <= 45 && Math.abs(b - t[2]!) <= 45;
    const BUY = [0xff, 0x5c, 0x6c];
    const SELL = [0x00, 0xe0, 0xa4];
    for (const c of Array.from(kl.querySelectorAll('canvas'))) {
      const cr = c.getBoundingClientRect();
      const ox = Math.round(cr.x - kr.x);
      const oy = Math.round(cr.y - kr.y);
      let data: Uint8ClampedArray;
      try {
        data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      } catch (e) {
        readErrors.push(String(e));
        continue;
      }
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (data[i + 3]! < 200) continue;
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          let v = 0;
          if (near(r, g, b, BUY)) v = 1;
          else if (near(r, g, b, SELL)) v = 2;
          if (v === 0) continue;
          const gx = x + ox;
          const gy = y + oy;
          if (gx >= 0 && gx < W && gy >= 0 && gy < H) grid[gy * W + gx] = v;
        }
      }
    }

    const dots = all.map((o) => {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp?: number; value?: number }>;
      const ts = Number(pts[0]?.timestamp ?? 0);
      const price = Number(pts[0]?.value ?? 0);
      const stack = Number(ext['stackIndex'] ?? 0);
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: ts, value: price },
        { paneId: 'candle_pane' },
      );
      const x = Number(p.x ?? NaN);
      const y = Number(p.y ?? NaN) + stack * 12;
      const expectColor = String(ext['color'] ?? '');
      const want = expectColor === '#ff5c6c' ? 1 : expectColor === '#00e0a4' ? 2 : 0;
      let ink = 0;
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          const gx = Math.round(x) + dx;
          const gy = Math.round(y) + dy;
          if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
          if (want !== 0 && grid[gy * W + gx] === want) ink += 1;
        }
      }
      // 视窗内判据：K 线只渲染**当前视窗**内的 bar ⇒ 视窗外的成交点本就不该有墨迹
      // （run A：174 根全览窗默认只显示末 120 根 ⇒ 最早 20 笔落在视窗左侧之外）。
      const inView = x >= 1 && x <= W - 2 && y >= 1 && y <= H - 2;
      return {
        fillKey: String(ext['fillKey'] ?? ''),
        label: String(ext['label'] ?? ''),
        color: expectColor,
        ts,
        price,
        stack,
        x,
        y,
        inView,
        ink,
      };
    });
    const inks = dots.map((d) => d.ink).sort((a, b) => a - b);
    const viewDots = dots.filter((d) => d.inView);
    return {
      ok: true,
      names,
      pane: { W, H, canvases: kl.querySelectorAll('canvas').length },
      dots,
      pixel: {
        inkMin: inks[0] ?? 0,
        inkMedian: inks.length ? inks[Math.floor(inks.length / 2)]! : 0,
        dotsWithInk: inks.filter((v) => v >= 3).length,
        dotsInView: viewDots.length,
        dotsInViewWithInk: viewDots.filter((d) => d.ink >= 3).length,
        inkMinInView: viewDots.length ? Math.min(...viewDots.map((d) => d.ink)) : 0,
        readErrors,
      },
    };
  });
}

/** 历史红断言口径：跳转后目标笔几何可测（按 ts+price 定位；读 convertToPixel）。 */
async function geomByFill(page: Page, targets: Array<{ ts: number; price: number }>) {
  return page.evaluate((want) => {
    const w = window as unknown as { __zzCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__zzCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return {};
    const chart = cands[0]!;
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    const out: Record<string, unknown> = {};
    for (const o of all) {
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const hit = (want as Array<{ ts: number; price: number }>).find(
        (t) => Math.abs(pts[0]!.timestamp - t.ts * 1000) < 1000 && Math.abs(pts[0]!.value - t.price) < 1e-9,
      );
      if (!hit) continue;
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
        { paneId: 'candle_pane' },
      );
      out[`${hit.ts}:${hit.price}`] = { x: Number(p.x ?? NaN), y: Number(p.y ?? NaN) };
    }
    return out as never;
  }, targets) as Promise<Record<string, { x: number; y: number }>>;
}

async function shotKline(page: Page, name: string): Promise<unknown> {
  const box = await page.getByTestId('kline-chart').boundingBox();
  if (!box) return { name, clip: null };
  const vp = page.viewportSize()!;
  const clip = {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width: Math.max(1, Math.min(Math.round(box.width), vp.width - Math.max(0, Math.round(box.x)))),
    height: Math.max(1, Math.min(Math.round(box.height), vp.height - Math.max(0, Math.round(box.y)))),
  };
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: resolve(OUT, name), clip });
  return { name, clip };
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(PAGE_CAPTURE);
  if (INJ === 'kline') {
    await page.route('**/api/kline*', async (route) => {
      await new Promise((r) => setTimeout(r, INJ_MS));
      await route.continue();
    });
  } else if (INJ === 'fills') {
    // 只推迟 **run 级** /fills（标记事实源）；不碰 round-trips 切片。
    await page.route('**/api/workbench/runs/*/fills*', async (route) => {
      await new Promise((r) => setTimeout(r, INJ_MS));
      await route.continue();
    });
  }
});

test(`次序无关：/api/kline 与 /fills 的提交次序（注入 ${INJ} +${INJ_MS}ms）下标记都要出现`, async ({ page }) => {
  const t0 = Date.now();
  const events: Array<{ url: string; at: number }> = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/kline') || /\/api\/workbench\/runs\/[^/]+\/fills/.test(u)) {
      events.push({ url: u, at: Date.now() - t0 });
    }
  });

  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${RUN_A}`);
  await expect(sel).toBeVisible();
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();

  // ① 图表数据就绪
  await expect
    .poll(async () => (await state(page)).maxDataLen, { timeout: 20_000, intervals: [100], message: 'dataList 非空' })
    .toBeGreaterThan(0);

  // ② 成交明细**落定**（已加载 == 共 N，且 N>0；「加载中…」不算落定），且标记 DOM 口径一致
  await expect
    .poll(
      async () => {
        const s = await state(page);
        const m = /已加载\s*(\d+)\s*\/\s*共\s*(\d+)/.exec(s.note);
        if (!m) return `NOT_SETTLED note=${s.note}`;
        if (Number(m[1]) !== Number(m[2]) || Number(m[2]) === 0) return `NOT_FULL ${m[1]}/${m[2]}`;
        const want = Number(m[1]);
        return s.markers === String(want) ? 'OK' : `MISMATCH data-marker-overlays=${s.markers} want=${want} note=${s.note}`;
      },
      { timeout: 20_000, intervals: [100], message: '成交明细落定后每笔成交必须已建成 fillDot（次序无关）' },
    )
    .toBe('OK');

  const s1 = await state(page);
  const want = wantFromNote(s1.note);
  const sp = (await storeAndPixels(page)) as unknown as {
    ok: boolean;
    names: string[];
    pane?: { W: number; H: number; canvases: number };
    dots: Array<{ fillKey: string; label: string; color: string; ink: number; inView: boolean; x: number; y: number }>;
    pixel: {
      inkMin: number;
      inkMedian: number;
      dotsWithInk: number;
      dotsInView: number;
      dotsInViewWithInk: number;
      inkMinInView: number;
      readErrors: string[];
    };
  };
  const shot = await shotKline(page, `markers_${INJ}.png`);

  // ③ 跳转（历史红断言口径）
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  const fillsResp = await (
    await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`)
  ).json();
  const fA = fillsResp.fills[FILL_A] as { ts: number; price: number };
  const fB = fillsResp.fills[FILL_B] as { ts: number; price: number };
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await expect
    .poll(async () => page.getByTestId('kline-chart').getAttribute('data-highlight-active'), {
      timeout: 6_000,
      intervals: [120],
      message: '跳转后高亮必须生效',
    })
    .toBe('true');
  const geom = await geomByFill(page, [
    { ts: fA.ts, price: fA.price },
    { ts: fB.ts, price: fB.price },
  ]);
  const gA = geom[`${fA.ts}:${fA.price}`];
  const gB = geom[`${fB.ts}:${fB.price}`];
  const shotJump = await shotKline(page, `jump_${INJ}.png`);

  const klineEvents = events.filter((e) => e.url.includes('/api/kline'));
  const fillEvents = events.filter((e) => /\/workbench\/runs\/[^/]+\/fills/.test(e.url));
  const firstKline = klineEvents[0]?.at ?? null;
  const firstRunFills = fillEvents[0]?.at ?? null;
  const result = {
    inj: INJ,
    injMs: INJ_MS,
    run: RUN_A,
    state: s1,
    want,
    markers: s1.markers,
    storeOk: sp.ok,
    storeNames: sp.names,
    storeDotCount: sp.dots.length,
    pane: sp.pane,
    dotInk: sp.dots.map((d) => ({ fillKey: d.fillKey, label: d.label, color: d.color, ink: d.ink, inView: d.inView, x: d.x, y: d.y })),
    pixel: sp.pixel,
    firstKlineAtMs: firstKline,
    firstRunFillsAtMs: firstRunFills,
    orderDeltaMs: firstKline != null && firstRunFills != null ? firstKline - firstRunFills : null,
    events,
    geomTargets: { keyA: Object.keys(geom), gA, gB },
    shots: { markers: shot, jump: shotJump },
  };
  writeJson(`order_${INJ}`, result);

  expect(s1.markers, `DOM：data-marker-overlays == 已加载成交笔数（note=${s1.note}）`).toBe(String(want));
  expect(want, '注入下成交笔数必须真实非零（否则用例无区分力）').toBeGreaterThan(0);
  expect(sp.ok, '必须捕获真图表实例').toBe(true);
  expect(sp.dots.length, 'store：每笔成交一个 fillDot').toBe(want);
  expect(sp.dots.length, 'store 计数须与 DOM 属性同源一致').toBe(Number(s1.markers));
  expect(sp.pixel.dotsInView, '像素判据必须覆盖足量视窗内标记（否则无区分力）').toBeGreaterThanOrEqual(20);
  expect(
    sp.pixel.dotsInViewWithInk,
    '像素：**每个视窗内** fillDot 位置须有该笔颜色墨迹（买 #ff5c6c / 卖 #00e0a4，±5px 盒内 ≥3px）',
  ).toBe(sp.pixel.dotsInView);
  expect(gA != null && gB != null, '跳转后目标笔几何必须可测（历史红断言口径）').toBe(true);
});
