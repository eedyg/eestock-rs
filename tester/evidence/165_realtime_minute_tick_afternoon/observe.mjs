/**
 * 165 补验：真实交易时段的分钟兜底节拍（只读）。
 * 线上 served bundle 真实页面（http://127.0.0.1:8081/），浏览器侧任何非 GET 一律 abort。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const LIVE = 'http://127.0.0.1:8081';
const OUT = '/tmp/livecheck-165/out';
fs.mkdirSync(OUT, { recursive: true });
const DUR_MS = 175_000;

const reqs = [];
const nonGet = [];
const blockedWrites = [];
const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('request', (r) => {
  const e = { method: r.method(), url: r.url(), t: Date.now() };
  reqs.push(e);
  if (r.method() !== 'GET') nonGet.push(e);
});
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
await page.route('**/api/**', async (route) => {
  if (route.request().method() !== 'GET') {
    blockedWrites.push({ method: route.request().method(), url: route.request().url() });
    return route.abort();
  }
  return route.continue();
});

await page.goto(LIVE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('[data-viewport-fit]') !== null, null, { timeout: 25000 }).catch(() => {});
const t0 = Date.now();
await page.waitForTimeout(1500);
const viewportFit = await page.evaluate(() => document.querySelector('[data-viewport-fit]')?.getAttribute('data-viewport-fit') ?? null);
const title = await page.title();
await page.screenshot({ path: OUT + '/live_page.png' });
const mark = reqs.length;
await page.waitForTimeout(DUR_MS);
const win = reqs.slice(mark);
const hidden = await page.evaluate(() => document.visibilityState);

const parse = (u) => { try { const x = new URL(u); return { path: x.pathname, q: Object.fromEntries(x.searchParams) }; } catch { return { path: u, q: {} }; } };
const fb = win.filter((r) => r.method === 'GET' && r.url.includes('/api/kline') && !r.url.includes('before=') && parse(r.url).q.limit === '5')
  .map((r) => ({ t: r.t, rel: r.t - t0, ...parse(r.url) }));
const allKline = win.filter((r) => r.url.includes('/api/kline')).map((r) => ({ t: r.t, url: r.url.replace(/^https?:\/\/[^/]+/, '') }));

const out = {
  startedAtLocal: new Date(t0).toString(),
  shanghai: new Date(t0 + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' +08',
  durationSec: Math.round(DUR_MS / 1000),
  visibilityState: hidden,
  title, viewportFit,
  nonGetTotal: nonGet.length,
  blockedWrites,
  consoleErrors, pageErrors,
  fallbackCount: fb.length,
  fallback: fb.map((x) => ({ rel: Math.round(x.rel / 1000), iso: new Date(x.t).toISOString(), code: x.q.code, period: x.q.period, limit: x.q.limit, hasBefore: 'before' in x.q })),
  fallbackRawTs: fb.map((x) => x.t),
  allKlineCount: allKline.length,
  methodsSeen: [...new Set(reqs.map((r) => r.method))],
};
fs.writeFileSync(OUT + '/observe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
await browser.close();
