/** 165 补验：项 2（非跟随态视口不变 + 有新数据提示点击跳最新）+ 项 3（幂等）。harness 用仓库真实模块，proxy 到线上 8081（只 GET）。 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = '/tmp/livecheck-165/out';
const HARNESS = 'http://127.0.0.1:18465/';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const p = await ctx.newPage();
const reqs = []; const nonGet = [];
p.on('request', (r) => { reqs.push({ m: r.method(), u: r.url() }); if (r.method() !== 'GET') nonGet.push(r.method() + ' ' + r.url()); });
await p.route('**/api/**', async (r) => {
  if (r.request().method() !== 'GET') return r.abort();
  const u = new URL(r.request().url());
  try { await r.fulfill({ response: await r.fetch({ url: 'http://127.0.0.1:8081' + u.pathname + u.search }) }); }
  catch { await r.fulfill({ status: 599, body: '' }); }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SNAP = () => {
  const H = window.__H__; const c = (window.__ACC__?.charts ?? []).find(Boolean);
  let range = null; try { range = c?.getVisibleRange?.() ?? null; } catch (e) { range = 'ERR:' + String(e); }
  const keyOf = () => H.bars().map((x) => x.ts + '|' + x.close).join(',');
  const cv = document.querySelector('[data-testid="kline-chart"] canvas');
  const sum = (s) => { let h = 0; for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ':' + h; };
  return {
    dataLen: H.dataLen(), rtCount: H.rtCount(), follow: H.follow(), stats: H.stats(), last: H.lastBar()?.ts ?? null,
    barsDigest: sum(keyOf()), canvasSig: cv ? sum(cv.toDataURL()) : null,
    range: range && typeof range === 'object' ? { from: range.from, to: range.to, realFrom: range.realFrom, realTo: range.realTo } : range,
    domHint: !!document.querySelector('[data-testid="kline-new-data-hint"]'),
  };
};
await p.goto(HARNESS + '?code=518880&period=15m&bars=120', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0, null, { timeout: 30000 });
await sleep(800);
const R = { initial: await p.evaluate(SNAP) };
const box = await p.locator('[data-testid="kline-chart"] canvas').first().boundingBox();
await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
await p.mouse.down();
for (let i = 1; i <= 12; i++) { await p.mouse.move(box.x + box.width * 0.6 - i * 20, box.y + box.height * 0.4); await sleep(15); }
await p.mouse.up(); await sleep(400);
R.afterPan = await p.evaluate(SNAP);
await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
await p.mouse.wheel(0, -500); await sleep(500);
R.afterZoom = await p.evaluate(SNAP);
// (a) 真实兜底取数前后视口逐字不变
await p.evaluate(() => window.__H__.pollNow()); await sleep(900);
R.fb1 = await p.evaluate(SNAP);
R.fb1.rangeIdentical = JSON.stringify(R.afterZoom.range) === JSON.stringify(R.fb1.range);
// (c1) 幂等：连续两次兜底取数
await p.evaluate(() => window.__H__.pollNow()); await sleep(900);
R.fb2 = await p.evaluate(SNAP);
R.idempotentRealPoll = { len: [R.fb1.dataLen, R.fb2.dataLen], rt: [R.fb1.rtCount, R.fb2.rtCount], digestSame: R.fb1.barsDigest === R.fb2.barsDigest, canvasSame: R.fb1.canvasSig === R.fb2.canvasSig };
// (b)+(c2/c3) 注入新 bar（视口外）⇒ 提示；点击跳最新；重放两次幂等
R.inject = await p.evaluate(async () => {
  const H = window.__H__; const last = H.bars().at(-1); const periodMs = 15 * 60 * 1000;
  const mk = (ts, close) => ({ type: 'bar', code: '518880', period: '15m', bar: { ts, open: last.open, high: last.high, low: last.low, close, volume: last.volume, amount: last.amount } });
  const out = {};
  const b0 = { len: H.dataLen(), rt: H.rtCount() };
  H.inject(mk(last.ts, last.close)); out.replayExisting = { before: b0, after: { len: H.dataLen(), rt: H.rtCount() } };
  const nextTs = new Date(Date.parse(last.ts) + periodMs).toISOString();
  const b1 = { len: H.dataLen(), rt: H.rtCount(), hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') };
  H.inject(mk(nextTs, Number(last.close) + 0.5)); await new Promise((r) => setTimeout(r, 900));
  out.injectNew = { before: b1, after: { len: H.dataLen(), rt: H.rtCount(), last: H.lastBar()?.ts, hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') } };
  const b2 = { len: H.dataLen(), rt: H.rtCount() };
  H.inject(mk(nextTs, Number(last.close) + 0.5)); H.inject(mk(nextTs, Number(last.close) + 0.5)); await new Promise((r) => setTimeout(r, 600));
  out.replayNewTwice = { before: b2, after: { len: H.dataLen(), rt: H.rtCount() }, appendedTwice: H.dataLen() - b2.len, reEmitted: H.rtCount() - b2.rt };
  return out;
});
await sleep(500);
const afterNew = await p.evaluate(SNAP);
const hn = p.locator('[data-testid="kline-new-data-hint"]');
const hintVisible = await hn.isVisible().catch(() => false);
let afterClick = null;
if (hintVisible) { await hn.click(); await sleep(900); afterClick = await p.evaluate(SNAP); }
R.b_hint = { rangeBeforeNewBar: R.afterZoom.range, rangeAfterNewBar: afterNew.range, viewportUnchangedWhenHintShown: JSON.stringify(R.afterZoom.range) === JSON.stringify(afterNew.range), hintVisible, hintText: hintVisible ? await hn.textContent() : null, afterClickRange: afterClick?.range ?? null, afterClickFollow: afterClick?.follow ?? null, hintGoneAfterClick: afterClick ? !afterClick.domHint : null, jumpedToLatest: afterClick ? afterClick.last === afterNew.last : null };
R.nonGet = nonGet; R.fallbackShapeCount = reqs.filter((r) => r.u.includes('/api/kline') && !r.u.includes('before=')).length;
await p.screenshot({ path: OUT + '/harness_hint.png' });
fs.writeFileSync(OUT + '/harness.json', JSON.stringify(R, null, 2));
console.log(JSON.stringify({ a: { rangeIdentical: R.fb1.rangeIdentical, before: R.afterZoom.range, after: R.fb1.range, followBefore: R.afterZoom.follow, followAfter: R.fb1.follow }, idem: R.idempotentRealPoll, inject: R.inject, b: R.b_hint, nonGet }, null, 1));
await b.close();
