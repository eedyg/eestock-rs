import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:18081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
await page.waitForTimeout(2500);
const before = await page.evaluate(() => (window.__CHARTS__ ?? []).length);
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2000);
const out = await page.evaluate(() => {
  const charts = window.__CHARTS__ ?? [];
  const live = charts.filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = live[live.length - 1];
  if (!c) return { charts: charts.length, live: 0 };
  const panes = c.getPaneOptions();
  const inds = c.getIndicators().map((i) => ({
    name: i.name, paneId: i.paneId, yAxisId: i.yAxisId, precision: i.precision,
    figKeys: (i.figures ?? []).map((f) => f.key),
    resultLen: Array.isArray(i.result) ? i.result.length : null,
    last: Array.isArray(i.result) ? i.result[i.result.length - 1] : null,
    visible: i.visible,
  }));
  const yAxes = {};
  for (const p of panes) {
    try { yAxes[p.id] = c.getYAxes({ paneId: p.id }).map((a) => ({ id: a.id, name: a.name, range: a.getRange(), y0: a.convertToPixel(0) })); }
    catch (e) { yAxes[p.id] = String(e); }
  }
  const dcapPane = inds.find((i) => i.name === 'DCAP')?.paneId;
  const conv = dcapPane ? {
    y0: c.convertToPixel({ value: 0 }, { paneId: dcapPane }),
    size: c.getSize(dcapPane),
    domRect: (() => { const d = c.getDom(dcapPane); const r = d.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }; })(),
  } : null;
  return { charts: charts.length, live: live.length, chartId: c.id, panes, inds, yAxes, dcapPane, conv, dpr: window.devicePixelRatio };
});
console.log('charts before click:', before);
console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: '/tmp/accept/recon-dcap.png' });
await browser.close();
