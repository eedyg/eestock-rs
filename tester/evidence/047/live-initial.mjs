/**
 * 线上 8081 **只读、零交互** 取证（问题① 初始态）：只 GET，不点击不拖拽不改状态。
 * 产出：截图 + 主图区「全宽水平线」像素行扫描（证明存在两条线：klinecharts 分隔线 + sub-chart 锚点 border）。
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const { chromium } = await import(pathToFileURL(resolve(WEB, 'node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const reqs = [];
await page.route('**/*', async (route, req) => {
  reqs.push(`${req.method()} ${req.url()}`);
  if (req.method() !== 'GET') return route.abort();
  return route.continue();
});
await page.goto('http://localhost:8081/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-region="main-chart"] canvas', { timeout: 30000 });
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const main = document.querySelector('[data-region="main-chart"]');
  const sub = document.querySelector('[data-region="sub-chart"]');
  const host = document.querySelector('[k-line-chart-id]');
  const kc = host?.firstElementChild;
  const mr = main.getBoundingClientRect();
  const cs = getComputedStyle(sub);
  const seps = [];
  for (const el of Array.from(kc.children)) {
    const w = el.firstElementChild;
    if (w && w.style.cursor === 'ns-resize') {
      const r = el.getBoundingClientRect();
      seps.push({ topInMain: +(r.top - mr.top).toFixed(2), h: r.height, bg: getComputedStyle(el).backgroundColor });
    }
  }
  const dcapBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'DCAP');
  return {
    mainChart: { top: mr.top, h: mr.height, w: mr.width },
    subAnchor: {
      topInMain: +(sub.getBoundingClientRect().top - mr.top).toFixed(2),
      h: sub.getBoundingClientRect().height,
      borderTop: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
      classList: sub.className,
    },
    klinechartsSeparators: seps,
    dcapToggleAriaPressed: dcapBtn ? dcapBtn.getAttribute('aria-pressed') : null,
    klinechartsInnerHtmlHead: kc ? kc.outerHTML.slice(0, 260) : null,
  };
});
await page.screenshot({ path: '/tmp/dcap_sep01/live-initial.png' });
const methods = [...new Set(reqs.map((r) => r.split(' ')[0]))];
writeFileSync('/tmp/dcap_sep01/live-initial.json', JSON.stringify({ info, methods }, null, 2));
console.log(JSON.stringify({ info, methods }, null, 2));
await browser.close();
