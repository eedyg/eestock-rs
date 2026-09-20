/**
 * **临时取证规格源码留档**（本波 coder 车道；运行时放在 `web/e2e/zz-marker-race-inject.e2e.ts`，跑完即删）。
 *
 * 目的：验证 ADR-028 D4.1 买卖标记在**两种提交次序**下都出现（次序无关修复的判据 a/b）：
 *  ① `/fills` 先落定（把 `/api/kline` 推迟 INJ_KLINE_MS）⇒ `data-marker-overlays` == 已加载成交笔数；
 *  ② K 线先落定（把 `/fills` 推迟 INJ_FILLS_MS）⇒ 同上。
 *
 * 注入手段 = tester 的最小注入（`page.route` 延迟，**不改生产代码**；
 * 取证：`tester/evidence/20260920_t4_flaky_rootcause/report.md` §3.3）。
 * 证据：DOM 属性 `data-marker-overlays` + 真图表 store `getOverlays({name:'fillDot'})` + 截图 + 请求到达次序。
 *
 * 运行（两种次序**分开**跑；同一次同时注入两者会互相抵消）：
 *   cd web && cp ../coder/evidence/20260920_marker_race_fix/raw/probe_source_zz_marker_race_inject.e2e.ts e2e/zz-marker-race-inject.e2e.ts
 *   E2E_BASE_URL=http://localhost:8081 INJ_KLINE_MS=1500 MARKER_RACE_OUT=<dir> \
 *     npx playwright test e2e/zz-marker-race-inject.e2e.ts -g "次序①" --workers=1 --retries=0 --reporter=list
 *   E2E_BASE_URL=http://localhost:8081 INJ_FILLS_MS=1500 MARKER_RACE_OUT=<dir> \
 *     npx playwright test e2e/zz-marker-race-inject.e2e.ts -g "次序②" --workers=1 --retries=0 --reporter=list
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.MARKER_RACE_OUT ?? resolve(REPO, 'coder/evidence/20260920_marker_race_fix/raw/probe');
const RUN_A = process.env.MARKER_RACE_RUN ?? 'sr_1789865219068_000001';
const INJ_KLINE_MS = Number(process.env.INJ_KLINE_MS ?? '0');
const INJ_FILLS_MS = Number(process.env.INJ_FILLS_MS ?? '0');

const PAGE_CAPTURE = `
  (() => {
    const w = window;
    w.__wbCharts = [];
    const orig = Map.prototype.set;
    Map.prototype.set = function (k, v) {
      try {
        if (v && typeof v === 'object' && typeof v.convertToPixel === 'function' && typeof v.getDataList === 'function') {
          w.__wbCharts.push(v);
        }
      } catch {}
      return orig.call(this, k, v);
    };
  })();
`;

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

/** 页面上屏的图表真身状态（与冻结规格 `chartReadyState` 同口径的独立复算）。 */
async function chartState(page: Page) {
  const dataLens = await page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    return (w.__wbCharts ?? []).map((c) => {
      try {
        return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length;
      } catch {
        return -1;
      }
    });
  });
  const dots = await page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return { ok: false, total: 0, dot: 0, labels: [] as string[], names: [] as string[] };
    const chart = cands[0]!;
    const all = (chart['getOverlays'] as () => Array<Record<string, unknown>>)();
    const named = (chart['getOverlays'] as (f: { name: string }) => Array<Record<string, unknown>>).call(chart, {
      name: 'fillDot',
    });
    return {
      ok: true,
      total: all.length,
      dot: named.length,
      labels: named.slice(0, 3).map((o) => String((o['extendData'] as Record<string, unknown> | undefined)?.['label'] ?? '')),
      names: Array.from(new Set(all.map((o) => String(o['name'] ?? '')))),
    };
  });
  const markers = (await page.getByTestId('kline-chart').getAttribute('data-marker-overlays')) ?? '';
  const fillsNote = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  return { maxDataLen: dataLens.reduce((a, b) => Math.max(a, b), 0), markers, fillsNote, store: dots };
}

function expectedMarkerCount(fillsNote: string): number {
  if (fillsNote.includes('加载中')) return 0;
  if (fillsNote.includes('未记录')) return 0;
  const m = /已加载\s*(\d+)\s*\/\s*共\s*\d+/.exec(fillsNote);
  if (!m) throw new Error(`wb-fills-note 文案无法解析：${fillsNote}`);
  return Number(m[1]);
}

/** run 级成交明细请求（结果页标记的事实源）在响应到达序列里的第一条。 */
function firstFillRun(arrivals: Array<{ url: string; at: number }>) {
  return arrivals.find((a) => /\/api\/workbench\/runs\/[^/]+\/fills/.test(a.url));
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  await page.getByTestId(`wb-run-select-${runId}`).click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
}

async function shotKline(page: Page, name: string) {
  const box = await page.getByTestId('wb-kline-chart').boundingBox();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  if (!box) return null;
  const clip = {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width: Math.max(1, Math.min(Math.round(box.width), vp.width - Math.max(0, Math.round(box.x)))),
    height: Math.max(1, Math.min(Math.round(box.height), vp.height - Math.max(0, Math.round(box.y)))),
  };
  await page.screenshot({ path: resolve(OUT, name), clip });
  return clip;
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(PAGE_CAPTURE);
  if (INJ_KLINE_MS > 0) {
    await page.route('**/api/kline*', async (route) => {
      await new Promise((r) => setTimeout(r, INJ_KLINE_MS));
      await route.continue();
    });
  }
  if (INJ_FILLS_MS > 0) {
    // run 级成交明细（结果页标记的事实源：`/api/workbench/runs/<id>/fills`）。
    await page.route('**/api/workbench/runs/*/fills*', async (route) => {
      await new Promise((r) => setTimeout(r, INJ_FILLS_MS));
      await route.continue();
    });
  }
});

test('次序①：/fills 先落定（/api/kline 延迟 INJ_KLINE_MS）⇒ 每笔成交标记仍然出现', async ({ page }) => {
  const arrivals: Array<{ url: string; at: number }> = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/kline') || u.includes('/fills')) arrivals.push({ url: u, at: Date.now() });
  });
  await openRun(page, RUN_A);

  await expect
    .poll(async () => {
      const s = await chartState(page);
      const want = expectedMarkerCount(s.fillsNote);
      return s.markers === String(want) && want > 0 ? 'OK' : `MISMATCH markers=${s.markers} want=${want} note=${s.fillsNote}`;
    }, { timeout: 15_000, intervals: [100], message: '标记必须在 K 线数据后到时重建（次序无关）' })
    .toBe('OK');

  const s = await chartState(page);
  const want = expectedMarkerCount(s.fillsNote);
  const klineFirst = arrivals.find((a) => a.url.includes('/api/kline'));
  const fillsFirst = firstFillRun(arrivals);
  const orderDeltaMs = klineFirst && fillsFirst ? klineFirst.at - fillsFirst.at : null;
  const clip = await shotKline(page, 'order_kline_delayed.png');
  writeJson('order_kline_delayed', { inject: { INJ_KLINE_MS, INJ_FILLS_MS }, want, state: s, orderDeltaMs, arrivals: arrivals.slice(0, 6), clip });

  expect(s.maxDataLen, 'K 线数据必须到位').toBeGreaterThan(0);
  expect(orderDeltaMs, '/api/kline 必须真的晚于 /fills 落定（注入生效）').toBeGreaterThan(500);
  expect(Number(s.markers), 'data-marker-overlays == 已加载成交笔数').toBe(want);
  expect(s.store.dot, '真图表 store 内 fillDot 数 == 成交笔数').toBe(want);
  expect(s.store.labels.length, '标记携带价格×股数标签').toBeGreaterThan(0);
});

test('次序②：K 线先落定（/fills 延迟 INJ_FILLS_MS）⇒ 每笔成交标记仍然出现', async ({ page }) => {
  const arrivals: Array<{ url: string; at: number }> = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/kline') || u.includes('/fills')) arrivals.push({ url: u, at: Date.now() });
  });
  await openRun(page, RUN_A);

  await expect
    .poll(async () => {
      const s = await chartState(page);
      const want = expectedMarkerCount(s.fillsNote);
      return s.markers === String(want) && want > 0 ? 'OK' : `MISMATCH markers=${s.markers} want=${want} note=${s.fillsNote}`;
    }, { timeout: 15_000, intervals: [100], message: '标记必须在成交明细后到时重建（次序无关）' })
    .toBe('OK');

  const s = await chartState(page);
  const want = expectedMarkerCount(s.fillsNote);
  const klineFirst = arrivals.find((a) => a.url.includes('/api/kline'));
  const fillsFirst = firstFillRun(arrivals);
  const orderDeltaMs = klineFirst && fillsFirst ? klineFirst.at - fillsFirst.at : null;
  const clip = await shotKline(page, 'order_fills_delayed.png');
  writeJson('order_fills_delayed', { inject: { INJ_KLINE_MS, INJ_FILLS_MS }, want, state: s, orderDeltaMs, arrivals: arrivals.slice(0, 6), clip });

  expect(orderDeltaMs, '/fills 必须真的晚于 /api/kline 落定（注入生效）').toBeLessThan(-500);
  expect(Number(s.markers), 'data-marker-overlays == 已加载成交笔数').toBe(want);
  expect(s.store.dot, '真图表 store 内 fillDot 数 == 成交笔数').toBe(want);
});
