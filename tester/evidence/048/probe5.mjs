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
  const cv = dom.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const y0 = c.convertToPixel({ value: 0 }, { paneId: dcapPane }).y;
  const row = Math.round(y0);
  const im = ctx.getImageData(0, row, cv.width, 1).data;
  const hist = {};
  for (let x = 0; x < cv.width; x++) {
    const r = im[x*4], g = im[x*4+1], b = im[x*4+2], a = im[x*4+3];
    const key = `${r},${g},${b},${a}`;
    hist[key] = (hist[key] ?? 0) + 1;
  }
  const top = Object.entries(hist).sort((a,b)=>b[1]-a[1]).slice(0, 15);
  // 虚线周期：找 gray 像素的 x 位置（#76808F）
  const grayXs = [];
  for (let x = 0; x < cv.width; x++) {
    const r = im[x*4], g = im[x*4+1], b = im[x*4+2], a = im[x*4+3];
    if (Math.abs(r-118)<25 && Math.abs(g-128)<25 && Math.abs(b-143)<25 && a>150) grayXs.push(x);
  }
  const gaps = []; for (let i=1;i<grayXs.length;i++) gaps.push(grayXs[i]-grayXs[i-1]);
  const gapHist = {}; for (const gg of gaps) gapHist[gg]=(gapHist[gg]??0)+1;
  return { dcapPane, y0, row, canvasW: cv.width, canvasH: cv.height, topColors: top, grayPixelCount: grayXs.length, grayFirstXs: grayXs.slice(0,20), gapHist };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
