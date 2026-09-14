import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
p.on('console', m => { if (m.type()==='error') console.log('CONSOLE-ERR', m.text().slice(0,200)); });
await p.route('**/api/**', async (r) => { const u = new URL(r.request().url()); try { await r.fulfill({ response: await r.fetch({ url: 'http://127.0.0.1:8081' + u.pathname + u.search }) }); } catch (e) { await r.fulfill({ status: 599, body: '' }); } });
await p.goto('http://127.0.0.1:18441/?code=518880&period=15m&bars=120', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0, null, { timeout: 30000 });
await new Promise(r=>setTimeout(r,800));
const geom = await p.evaluate(() => {
  const el = document.querySelector('[data-viewport-fit]');
  const r = el.getBoundingClientRect();
  const ch = window.__ACC__.charts.find(Boolean);
  return { fitAttr: el.getAttribute('data-viewport-fit'), rect: [Math.round(r.width), Math.round(r.height)], range: ch.getVisibleRange(), follow: window.__H__.follow() };
});
console.log('GEOM', JSON.stringify(geom));
const box = await p.locator('[data-testid="kline-chart"] canvas').first().boundingBox();
console.log('canvasBox', JSON.stringify(box));
// 真实拖拽平移（mousedown + move + up，落在蜡烛区中部）
await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
await p.mouse.down();
for (let i = 1; i <= 12; i++) { await p.mouse.move(box.x + box.width * 0.6 - i * 20, box.y + box.height * 0.4); await new Promise(r=>setTimeout(r,15)); }
await p.mouse.up();
await new Promise(r=>setTimeout(r,600));
console.log('AFTER-PAN', JSON.stringify(await p.evaluate(() => ({ r: window.__ACC__.charts.find(Boolean).getVisibleRange(), follow: window.__H__.follow() }))));
// 真实滚轮缩放
await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
await p.mouse.wheel(0, -500);
await new Promise(r=>setTimeout(r,500));
console.log('AFTER-WHEEL', JSON.stringify(await p.evaluate(() => ({ r: window.__ACC__.charts.find(Boolean).getVisibleRange(), follow: window.__H__.follow() }))));
// 原始 WS：真实 subscribe 帧 + 记录入站帧
const wsRes = await p.evaluate(() => new Promise((res) => {
  const out = { msgs: [], errors: [] };
  const s = new WebSocket('ws://127.0.0.1:8081/ws');
  s.onopen = () => s.send(JSON.stringify({ type: 'subscribe', topic: 'bar', code: '518880', period: '15m' }));
  s.onmessage = (e) => { if (out.msgs.length < 5) out.msgs.push(String(e.data).slice(0, 300)); };
  s.onerror = (e) => out.errors.push(String(e));
  setTimeout(() => { try { s.close(); } catch {} res({ ...out, count: out.msgs.length }); }, 8000);
}));
console.log('RAWW-S', JSON.stringify(wsRes, null, 1).slice(0, 1500));
await b.close();
