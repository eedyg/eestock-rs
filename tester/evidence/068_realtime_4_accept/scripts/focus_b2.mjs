/** 068 聚焦 (b)：先把「最新 bar 像素 x > 容器宽」作为硬前置条件造出来，再注入新 bar 看提示 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = '/tmp/acc4x/out';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const reqs = [];
p.on('request', (r) => reqs.push(r.method() + ' ' + r.url()));
await p.route('**/api/**', async (r) => {
  if (r.request().method() !== 'GET') return r.abort();
  const u = new URL(r.request().url());
  try { await r.fulfill({ response: await r.fetch({ url: 'http://127.0.0.1:8081' + u.pathname + u.search }) }); }
  catch { await r.fulfill({ status: 599, body: '' }); }
});
await p.goto('http://127.0.0.1:18441/?code=518880&period=15m&bars=120', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0, null, { timeout: 30000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(800);
const snap = () => p.evaluate(() => {
  const H = window.__H__; const c = window.__ACC__.charts.find(Boolean);
  const r = c.getVisibleRange();
  const el = document.querySelector('[data-testid="kline-chart"]');
  const lt = H.lastBar()?.ts;
  let px = null;
  try { const q = c.convertToPixel({ timestamp: Date.parse(lt) }, { paneId: 'candle_pane' }); px = q ? Math.round(q.x) : null; } catch { px = 'ERR'; }
  return { follow: H.follow(), len: H.dataLen(), rt: H.rtCount(), last: lt, xLast: px, width: el.clientWidth,
    range: { from: r.from, to: r.to, realFrom: r.realFrom, realTo: r.realTo },
    fit: el.getAttribute('data-viewport-fit'), hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') };
});
const box = await p.locator('[data-testid="kline-chart"] canvas').first().boundingBox();
const trace = [{ step: 'start', ...(await snap()) }];
// 放大（3 步）+ 向右拖拽（看更早的 bar）⇒ 最新 bar 被推到右缘之外
await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
for (let i = 0; i < 3; i++) { await p.mouse.wheel(0, -400); await sleep(300); }
let s = await snap();
for (let i = 0; i < 6 && !(typeof s.xLast === 'number' && s.xLast > s.width); i++) {
  const y = box.y + box.height * 0.4;
  await p.mouse.move(box.x + box.width * 0.2, y);
  await p.mouse.down();
  for (let k = 1; k <= 12; k++) { await p.mouse.move(box.x + box.width * 0.2 + k * 30, y); await sleep(12); }
  await p.mouse.up();
  await sleep(350);
  s = await snap(); trace.push({ step: 'drag' + (i + 1), ...s });
}
const pre = await snap();
const out = { trace, preconditionOffViewport: typeof pre.xLast === 'number' && pre.xLast > pre.width, pre };
const inj = await p.evaluate(async () => {
  const H = window.__H__;
  const last = H.bars().at(-1);
  const nb = { ...last, ts: new Date(Date.parse(last.ts) + 15 * 60 * 1000).toISOString(), close: Number(last.close) + 0.5 };
  const before = { len: H.dataLen(), rt: H.rtCount(), hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') };
  H.inject({ type: 'bar', code: '518880', period: '15m', bar: nb });
  await new Promise(r => setTimeout(r, 1200));
  return { before, after: { len: H.dataLen(), rt: H.rtCount(), last: H.lastBar()?.ts, hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') } };
});
out.injected = inj;
await sleep(600);
const post = await snap();
out.post = post;
out.hintVisible = await p.locator('[data-testid="kline-new-data-hint"]').isVisible().catch(() => false);
out.hintText = await p.locator('[data-testid="kline-new-data-hint"]').textContent().catch(() => null);
await p.screenshot({ path: OUT + '/07_hint_offscreen.png' });
if (out.hintVisible) {
  await p.locator('[data-testid="kline-new-data-hint"]').click();
  await sleep(1200);
  const ac = await snap();
  out.afterClick = ac;
  out.hintGoneAfterClick = !ac.hint;
  out.jumpedToLatest = typeof ac.xLast === 'number' && ac.xLast <= ac.width;
  out.followAfterClick = ac.follow;
  await p.screenshot({ path: OUT + '/08_after_click_offscreen.png' });
}
out.nonGet = reqs.filter(u => !u.startsWith('GET')).length;
out.klineRequests = reqs.filter(u => u.includes('/api/kline'));
fs.writeFileSync(OUT + '/focus_b2.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ preconditionOffViewport: out.preconditionOffViewport, pre: out.pre, injected: out.injected, post: out.post, hintVisible: out.hintVisible, hintText: out.hintText, afterClick: out.afterClick, hintGoneAfterClick: out.hintGoneAfterClick, jumpedToLatest: out.jumpedToLatest, trace: out.trace.map(t => ({ step: t.step, xLast: t.xLast, width: t.width, range: t.range, follow: t.follow })) }, null, 1));
await b.close();
