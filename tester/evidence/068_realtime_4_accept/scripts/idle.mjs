import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const rec = [];
function wire(page, tag, proxy) {
  page.on('request', r => { rec.push({ tag, method: r.method(), url: r.url(), t: Date.now() }); if (r.method() !== 'GET') (globalThis.nonGet ??= []).push(tag + ' ' + r.method()); });
  page.route('**/api/**', async (rt) => {
    if (rt.request().method() !== 'GET') return rt.abort();
    if (!proxy) return rt.continue();
    const u = new URL(rt.request().url());
    try { await rt.fulfill({ response: await rt.fetch({ url: 'http://127.0.0.1:8081' + u.pathname + u.search }) }); } catch { await rt.fulfill({ status: 599, body: '' }); }
  });
}
const h = await ctx.newPage(); wire(h, 'harness', true);
await h.goto('http://127.0.0.1:18441/?code=518880&period=15m&bars=120', { waitUntil: 'domcontentloaded' });
await h.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0, null, { timeout: 30000 });
const l = await ctx.newPage(); wire(l, 'liveServed', false);
await l.goto('http://127.0.0.1:8081/', { waitUntil: 'domcontentloaded' });
await l.waitForFunction(() => document.querySelector('[data-viewport-fit]') !== null, null, { timeout: 25000 }).catch(() => {});
const t0 = Date.now();
// 摆到非跟随态（真实手势），确认 idle 期间不产生兜底取数
const box = await h.locator('[data-testid="kline-chart"] canvas').first().boundingBox();
await h.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
await h.mouse.down(); for (let i = 1; i <= 8; i++) { await h.mouse.move(box.x + box.width * 0.6 + i * 25, box.y + box.height * 0.4); await new Promise(r => setTimeout(r, 12)); } await h.mouse.up();
const mark = rec.length;
await new Promise(r => setTimeout(r, 70000));
const idle = rec.slice(mark);
const out = {
  idleSeconds: Math.round((Date.now() - t0) / 1000),
  harnessFollow: await h.evaluate(() => window.__H__.follow()),
  harnessStatus: await h.evaluate(() => window.__H__.status()),
  harnessConns: await h.evaluate(() => window.__H__.conns()),
  harnessStats: await h.evaluate(() => window.__H__.stats()),
  harnessFrames: await h.evaluate(() => window.__H__.frames.length),
  idleRequests: idle.map(x => x.tag + ' ' + x.method + ' ' + x.url.replace(/^https?:\/\/[^/]+/, '')),
  idleFallbackNoBefore: idle.filter(x => x.url.includes('/api/kline') && !x.url.includes('before=')).length,
  idleAnyKline: idle.filter(x => x.url.includes('/api/kline')).length,
  nonGet: rec.filter(x => x.method !== 'GET').length,
  sessionNow: await h.evaluate(() => { const d = new Date(); const t = new Date(d.getTime() + 8 * 3600000); const m = t.getUTCHours() * 60 + t.getUTCMinutes(); const day = t.getUTCDay(); return { shanghai: String(t.getUTCHours()).padStart(2,'0') + ':' + String(t.getUTCMinutes()).padStart(2,'0'), day, session: day===0||day===6 ? 'closed' : (m < 570 ? 'preopen' : m < 690 ? 'trading' : m < 780 ? 'lunch' : m < 900 ? 'trading' : 'closed') }; }),
  livePageViewportFit: await l.evaluate(() => document.querySelector('[data-viewport-fit]')?.getAttribute('data-viewport-fit') ?? null),
};
fs.writeFileSync('/tmp/acc4x/out/idle.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
await b.close();
