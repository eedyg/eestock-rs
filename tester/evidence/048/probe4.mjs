import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:18081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2000);
const out = await page.evaluate(() => {
  const charts = window.__CHARTS__ ?? [];
  const live = charts.filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = live[live.length - 1];
  const dcapPane = c.getIndicators().find((i) => i.name === 'DCAP').paneId;
  const dom = c.getDom(dcapPane);
  const y0 = c.convertToPixel({ value: 0 }, { paneId: dcapPane }).y;
  const size = c.getSize(dcapPane);
  const canvases = Array.from(dom.querySelectorAll('canvas')).map((cv) => {
    const r = cv.getBoundingClientRect();
    return { w: cv.width, h: cv.height, cssW: r.width, cssH: r.height, top: r.top, left: r.left };
  });
  let pixelStats = null;
  try {
    const cv = dom.querySelector('canvas');
    const scaleY = cv.height / size.height;
    const row = Math.round(y0 * scaleY);
    const ctx = cv.getContext('2d');
    const rowScan = [];
    for (let yy = Math.max(0, row-6); yy <= Math.min(cv.height-1, row+6); yy++) {
      const im2 = ctx.getImageData(0, yy, cv.width, 1).data;
      let cnt = 0; const samples=[];
      for (let x = 0; x < cv.width; x++) {
        const r = im2[x*4], g = im2[x*4+1], b = im2[x*4+2], a = im2[x*4+3];
        if (a > 0 && Math.abs(r-118)<45 && Math.abs(g-128)<45 && Math.abs(b-143)<45) { cnt++; if (samples.length<6) samples.push({x,r,g,b,a}); }
      }
      rowScan.push({ y: yy, grayCount: cnt, samples });
    }
    // 该行横向跑长（虚线检测）
    const row2 = ctx.getImageData(0, row, cv.width, 1).data;
    const seq = [];
    for (let x = 0; x < cv.width; x++) seq.push(row2[x*4+3] > 0 ? 1 : 0);
    let runs = 0; for (let i=1;i<seq.length;i++) if (seq[i]!==seq[i-1]) runs++;
    pixelStats = { y0, sizeH: size.height, canvasH: cv.height, scaleY, row, rowScan, transitionRuns: runs };
  } catch (e) { pixelStats = String(e); }
  return { chartId: c.id, dcapPane, y0, canvases, pixelStats };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
