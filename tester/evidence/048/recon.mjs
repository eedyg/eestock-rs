import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const charts = window.__CHARTS__ ?? [];
  const main = document.querySelector('[data-region="main-chart"]');
  const anchor = document.querySelector('[data-region="sub-chart"]');
  const mr = main?.getBoundingClientRect();
  const acs = anchor ? getComputedStyle(anchor) : null;
  const ar = anchor?.getBoundingClientRect();
  const chartInfo = charts.map((c) => {
    let panes = [];
    try { panes = c.getPaneOptions() ?? []; } catch (e) { panes = [{ error: String(e) }]; }
    let inds = [];
    try { inds = c.getIndicators().map((i) => ({ name: i.name, paneId: i.paneId })); } catch (e) { inds = [{ error: String(e) }]; }
    let sep = null;
    try { sep = c.getSeparatorPanes ? c.getSeparatorPanes().size : null; } catch (e) { sep = String(e); }
    return { id: c.id, panes, inds, separators: sep };
  });
  return {
    chartCount: charts.length,
    chartInfo,
    main: mr ? { h: mr.height, w: mr.width, top: mr.top } : null,
    anchor: anchor && acs && ar
      ? {
          classes: anchor.className,
          borderTopWidth: acs.borderTopWidth,
          borderTopStyle: acs.borderTopStyle,
          borderTopColor: acs.borderTopColor,
          background: acs.backgroundColor,
          h: ar.height,
          w: ar.width,
          topInMain: ar.top - mr.top,
        }
      : null,
    kcHostChildren: Array.from(document.querySelector('[k-line-chart-id]')?.firstElementChild?.children ?? []).map((el) => ({
      cursor: el.firstElementChild?.style?.cursor,
      bg: getComputedStyle(el).backgroundColor,
      top: el.getBoundingClientRect().top - mr.top,
      h: el.getBoundingClientRect().height,
    })),
  };
});
console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: '/tmp/accept/recon.png', fullPage: false });
await browser.close();
