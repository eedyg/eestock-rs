import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:18081';
const OUT = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/048';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
await page.waitForTimeout(2200);
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(1800);
async function crop(tag) {
  const info = await page.evaluate(() => {
    const charts = window.__CHARTS__ ?? [];
    const live = charts.filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
    const c = live[live.length - 1];
    const ind = c.getIndicators().find((i) => i.name === 'DCAP');
    const paneId = ind.paneId;
    const y0 = c.convertToPixel({ value: 0 }, { paneId }).y;
    const r = c.getDom(paneId).getBoundingClientRect();
    return { left: r.left, top: r.top + y0, w: r.width, h: r.height, y0 };
  });
  await page.screenshot({ path: `${OUT}/crop-${tag}.png`, clip: { x: info.left, y: Math.max(0, info.top - 10), width: info.w, height: 21 } });
  console.log(tag, 'y0=', info.y0);
}
await crop('zero-real');
const up = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
await page.evaluate((closes) => {
  const c = (window.__CHARTS__ ?? []).filter((x) => { try { return (x.getPaneOptions() ?? []).length > 0; } catch { return false; } }).slice(-1)[0];
  const bars = closes.map((close, i) => ({ timestamp: 1700000000000 + i * 60000, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1000 + i }));
  c.setDataLoader({ getBars: async ({ callback }) => callback(bars, { forward: false, backward: false }), subscribeBar() {}, unsubscribeBar() {} });
}, up);
await page.waitForTimeout(900); await crop('zero-all-positive');
const mixed = Array.from({ length: 220 }, (_, i) => (i < 110 ? 200 - i * 0.6 : 134 + (i - 110) * 0.6));
await page.evaluate((closes) => {
  const c = (window.__CHARTS__ ?? []).filter((x) => { try { return (x.getPaneOptions() ?? []).length > 0; } catch { return false; } }).slice(-1)[0];
  const bars = closes.map((close, i) => ({ timestamp: 1700000000000 + i * 60000, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1000 + i }));
  c.setDataLoader({ getBars: async ({ callback }) => callback(bars, { forward: false, backward: false }), subscribeBar() {}, unsubscribeBar() {} });
}, mixed);
await page.waitForTimeout(900); await crop('zero-cross-zero');
const short = Array.from({ length: 5 }, (_, i) => 100 + i * 0.5);
await page.evaluate((closes) => {
  const c = (window.__CHARTS__ ?? []).filter((x) => { try { return (x.getPaneOptions() ?? []).length > 0; } catch { return false; } }).slice(-1)[0];
  const bars = closes.map((close, i) => ({ timestamp: 1700000000000 + i * 60000, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1000 + i }));
  c.setDataLoader({ getBars: async ({ callback }) => callback(bars, { forward: false, backward: false }), subscribeBar() {}, unsubscribeBar() {} });
}, short);
await page.waitForTimeout(900); await crop('zero-insufficient');
await page.screenshot({ path: `${OUT}/zero-insufficient-fullpane.png`, clip: await page.evaluate(() => { const c = (window.__CHARTS__ ?? []).filter((x)=>{try{return (x.getPaneOptions()??[]).length>0;}catch{return false;}}).slice(-1)[0]; const p=c.getIndicators().find(i=>i.name==='DCAP').paneId; const r=c.getDom(p).getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:r.height}; }) });
await browser.close();
