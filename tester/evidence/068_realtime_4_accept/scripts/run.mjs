/**
 * 068 独立验收驱动（只读）：harness 打向线上 8081（GET + WS 订阅）；线上 served bundle 也只读加载。
 * 浏览器侧对任何非 GET 请求 abort 并记录 ⇒ 结构上保证「线上零写请求」。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';

const LIVE = 'http://127.0.0.1:8081';
const HARNESS = 'http://127.0.0.1:18441/';
const OUT = '/tmp/acc4x/out';
fs.mkdirSync(OUT, { recursive: true });
const R = { harness: {}, realPage: {}, requests: [] };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

function wire(page, tag, mode) {
  page.on('request', (r) => {
    R.requests.push({ tag, mode, method: r.method(), url: r.url() });
    if (r.method() !== 'GET') R.nonGet = (R.nonGet ?? 0) + 1;
  });
  page.on('console', (m) => { if (m.type() === 'error') (R[tag].consoleErrors ??= []).push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => (R[tag].pageErrors ??= []).push(String(e).slice(0, 300)));
  page.route('**/api/**', async (route) => {
    const rq = route.request();
    if (rq.method() !== 'GET') { (R.blockedWrites ??= []).push({ tag, method: rq.method(), url: rq.url() }); return route.abort(); }
    if (mode === 'proxy') {
      const u = new URL(rq.url());
      try { await route.fulfill({ response: await route.fetch({ url: LIVE + u.pathname + u.search }) }); }
      catch (e) { await route.fulfill({ status: 599, body: String(e) }); }
    } else return route.continue();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAP = () => {
  const H = window.__H__;
  const c = (window.__ACC__?.charts ?? []).find(Boolean);
  let range = null;
  try { range = c?.getVisibleRange?.() ?? null; } catch (e) { range = 'ERR:' + String(e); }
  const keyOf = () => H.bars().map((b) => b.ts + '|' + b.close).join(',');
  const cv = document.querySelector('[data-testid="kline-chart"] canvas');
  let canvasSig = null;
  try { canvasSig = cv ? crypto_checksum(cv.toDataURL()) : null; } catch (e) { canvasSig = 'ERR:' + String(e); }
  function crypto_checksum(s) { let h = 0; for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ':' + h; }
  return {
    dataLen: H.dataLen(), rtCount: H.rtCount(), status: H.status(), conns: H.conns(), follow: H.follow(),
    stats: H.stats(), last: H.lastBar()?.ts ?? null, barsKeyLen: keyOf().length,
    barsDigest: crypto_checksum(keyOf()), canvasSig,
    range: range && typeof range === 'object'
      ? { from: range.from, to: range.to, realFrom: range.realFrom, realTo: range.realTo } : range,
    domHint: !!document.querySelector('[data-testid="kline-new-data-hint"]'),
    viewportFit: document.querySelector('[data-viewport-fit]')?.getAttribute('data-viewport-fit') ?? null,
  };
};

// ── A. harness（仓库真实模块，含 Tailwind 布局）打线上 8081 ──
const page = await ctx.newPage();
wire(page, 'harness', 'proxy');
await page.goto(HARNESS + '?code=518880&period=15m&bars=120', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0, null, { timeout: 30000 });
await sleep(800);
const snap = () => page.evaluate(SNAP);
R.harness.initial = await snap();
await page.screenshot({ path: OUT + '/01_harness_initial.png' });

// ── (a) 非跟随态：真实手势（拖拽平移 + 滚轮缩放）→ 视口不被强拉 ──
const cv = page.locator('[data-testid="kline-chart"] canvas').first();
const box = await cv.boundingBox();
await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(box.x + box.width * 0.6 - i * 20, box.y + box.height * 0.4); await sleep(15); }
await page.mouse.up();
await sleep(400);
const afterPan = await snap();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
await page.mouse.wheel(0, -500);
await sleep(500);
const afterZoom = await snap();
R.harness.a_gestures = { afterPan: { range: afterPan.range, follow: afterPan.follow }, afterZoom: { range: afterZoom.range, follow: afterZoom.follow } };

// 真实数据更新（真实 GET /api/kline 兜底增量）两次 ⇒ 视口逐字不变 + 幂等
await page.evaluate(() => window.__H__.pollNow());
await sleep(900);
const fb1 = await snap();
await page.evaluate(() => window.__H__.pollNow());
await sleep(900);
const fb2 = await snap();
R.harness.a_viewportInvariance = {
  rangeBeforeUpdate: afterZoom.range, rangeAfterRealDataUpdate: fb1.range,
  rangeIdentical: JSON.stringify(afterZoom.range) === JSON.stringify(fb1.range),
  followBefore: afterZoom.follow, followAfterRealDataUpdate: fb1.follow,
  realtimeStatsAfterUpdate: fb1.stats,
};
R.harness.c_realFetchIdempotency = {
  len: [fb1.dataLen, fb2.dataLen], rtCount: [fb1.rtCount, fb2.rtCount],
  barsDigest: [fb1.barsDigest, fb2.barsDigest], canvasSig: [fb1.canvasSig, fb2.canvasSig],
  lenStable: fb1.dataLen === fb2.dataLen, digestStable: fb1.barsDigest === fb2.barsDigest,
  noReEmit: fb1.rtCount === fb2.rtCount, canvasStable: fb1.canvasSig === fb2.canvasSig,
};
await page.screenshot({ path: OUT + '/02_after_gesture_fallback.png' });

// ── (b)+(c) 真实 bar 帧形状注入（帧 schema 见 WsClient.ts L5；数值取自线上真实 GET 的最后一根） ──
const injectRes = await page.evaluate(async () => {
  const H = window.__H__;
  const last = H.bars().at(-1);
  const periodMs = 15 * 60 * 1000;
  const mk = (ts, close) => ({ type: 'bar', code: '518880', period: '15m', bar: { ts, open: last.open, high: last.high, low: last.low, close, volume: last.volume } });
  const out = {};
  // c1: 重放「已存在且同值」的最后一根 ⇒ 不追加/不重复 emit
  const b0 = { len: H.dataLen(), rt: H.rtCount() };
  H.inject(mk(last.ts, last.close));
  out.replayExisting = { before: b0, after: { len: H.dataLen(), rt: H.rtCount() } };
  // c2: 注入一根「新 ts」bar（视口已被手动平移/缩放 ⇒ 落在视口外）
  const nextTs = new Date(Date.parse(last.ts) + periodMs).toISOString();
  const b1 = { len: H.dataLen(), rt: H.rtCount(), hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') };
  H.inject(mk(nextTs, Number(last.close) + 0.5));
  await new Promise((r) => setTimeout(r, 900));
  out.injectNew = { before: b1, after: { len: H.dataLen(), rt: H.rtCount(), last: H.lastBar()?.ts, hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') } };
  // c3: 再重放同一根新 bar 两次 ⇒ 幂等（不重复追加/不重复 emit）
  const b2 = { len: H.dataLen(), rt: H.rtCount() };
  H.inject(mk(nextTs, Number(last.close) + 0.5));
  H.inject(mk(nextTs, Number(last.close) + 0.5));
  await new Promise((r) => setTimeout(r, 600));
  out.replayNewTwice = { before: b2, after: { len: H.dataLen(), rt: H.rtCount() }, appendedTwice: H.dataLen() - b2.len, reEmitted: H.rtCount() - b2.rt };
  return out;
});
await sleep(500);
const afterNewBar = await snap();
const hint = page.locator('[data-testid="kline-new-data-hint"]');
const hintVisible = await hint.isVisible().catch(() => false);
let afterClick = null;
if (hintVisible) { await hint.click(); await sleep(900); afterClick = await snap(); }
R.harness.b_hint = {
  inject: injectRes, rangeBeforeNewBar: afterZoom.range, rangeAfterNewBar: afterNewBar.range,
  viewportUnchangedWhenHintShown: JSON.stringify(afterZoom.range) === JSON.stringify(afterNewBar.range),
  hintVisible, afterClickRange: afterClick?.range ?? null, afterClickFollow: afterClick?.follow ?? null,
  hintGoneAfterClick: afterClick ? !afterClick.domHint : null,
  jumpedToLatest: afterClick ? afterClick.last === afterNewBar.last : null,
};
await page.screenshot({ path: OUT + '/03_hint.png' });

// ── (d) 宫格限流：2×2（4 图同标同周期）并发兜底 ⇒ 同 key HTTP 次数 ≤ 图数 ──
const mark = R.requests.length;
const grid = await page.evaluate(() => window.__H__.grid2x2());
await sleep(1200);
const gridReqs = R.requests.slice(mark).filter((r) => r.url.includes('/api/kline') && !r.url.includes('before='));
R.harness.d_grid2x2 = { images: 4, returned: grid, klineHttpRequests: gridReqs.length, urls: gridReqs.map((r) => r.url.replace(/^.*\/api/, '/api')), withinImageLimit: gridReqs.length <= 4 };
const mark2 = R.requests.length;
const multi = await page.evaluate(() => window.__H__.multiPoll());
await sleep(1500);
const mReqs = R.requests.slice(mark2).filter((r) => r.url.includes('/api/kline') && !r.url.includes('before='));
R.harness.d_multi6 = { images: 6, returned: multi, klineHttpRequests: mReqs.length, withinImageLimit: mReqs.length <= 6 };
R.harness.final = await snap();
R.harness.framesRecorded = await page.evaluate(() => window.__H__.frames.length);
await page.close();

// ── B. 线上 served bundle 真实页面（只读；写请求被 abort） ──
const p2 = await ctx.newPage();
wire(p2, 'realPage', 'passthrough');
await p2.goto(LIVE + '/', { waitUntil: 'domcontentloaded' });
await p2.waitForFunction(() => document.querySelector('[data-viewport-fit]') !== null, null, { timeout: 25000 }).catch(() => {});
await sleep(2500);
R.realPage.served = await p2.evaluate(() => ({
  title: document.title,
  scripts: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')),
  css: [...document.querySelectorAll('link[rel=stylesheet]')].map((s) => s.getAttribute('href')),
  viewportFit: document.querySelector('[data-viewport-fit]')?.getAttribute('data-viewport-fit') ?? null,
  canvasCount: document.querySelectorAll('canvas').length,
  hasRoot: !!document.getElementById('root')?.children.length,
}));
await p2.screenshot({ path: OUT + '/04_live_page.png' });
await p2.close();

await browser.close();
R.nonGet = R.nonGet ?? 0;
R.writeSummary = {
  totalRequests: R.requests.length, nonGet: R.nonGet, blockedWrites: (R.blockedWrites ?? []).length,
  klineRequests: R.requests.filter((r) => r.url.includes('/api/kline')).length,
  nonGetKlineFallbackShape: R.requests.filter((r) => r.url.includes('/api/kline') && !r.url.includes('before=')).length,
  uniqueUrlShapes: [...new Set(R.requests.map((r) => r.method + ' ' + r.url.replace(/^https?:\/\/[^/]+/, '').replace(/limit=\d+/, 'limit=N').replace(/before=[^&]+/, 'before=X')))].sort(),
};
fs.writeFileSync(OUT + '/result.json', JSON.stringify(R, null, 2));
console.log(JSON.stringify({
  write: R.writeSummary,
  a: R.harness.a_viewportInvariance, gestures: R.harness.a_gestures,
  c: { realFetch: R.harness.c_realFetchIdempotency, inject: R.harness.b_hint.inject },
  b: { visible: R.harness.b_hint.hintVisible, unchanged: R.harness.b_hint.viewportUnchangedWhenHintShown, gone: R.harness.b_hint.hintGoneAfterClick, jumped: R.harness.b_hint.jumpedToLatest },
  d: { grid2x2: R.harness.d_grid2x2, multi6: R.harness.d_multi6 },
  real: R.realPage.served, framesRecorded: R.harness.framesRecorded,
}, null, 1));
