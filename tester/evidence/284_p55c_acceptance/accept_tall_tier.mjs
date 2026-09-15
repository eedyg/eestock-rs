/** 补充：真渲染「高可用」档（1600×1400 ⇒ 可用 >1200，越域路径）—— pane Σ==可用、无溢出、无 pageerror。 */
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('@playwright/test');
let cfg = { enabled: true, periods: ['1m', '5m', '15m', '1h'], heights: { '1m': 615, '5m': 358, '15m': 180, '1h': 180 }, indicators: ['dcap'] };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1400 } });
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.route('**/api/config/multi_period', (r) => r.request().method() === 'GET' ? r.fulfill({ status: 200, json: cfg }) : r.fulfill({ status: 200, json: JSON.parse(r.request().postData() ?? '{}') }));
await p.goto('http://127.0.0.1:5392', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('[data-region="symbol-list"] button', { timeout: 30000 });
await p.waitForTimeout(3500);
const g = await p.evaluate(() => {
  const stack = document.querySelector('[data-mp-stack]');
  const panes = Array.from(document.querySelectorAll('[data-mp-pane]'));
  const wrap = stack?.parentElement;
  return {
    tier: innerHeight, panes: panes.length,
    sum: panes.reduce((a, e) => a + Number(e.getAttribute('data-mp-pane-height') || 0), 0),
    stackClient: stack?.clientHeight, stackScroll: stack?.scrollHeight, wrapH: wrap?.clientHeight,
    stackOverflow: stack ? stack.scrollHeight - stack.clientHeight : null,
    docOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    satCanvas: document.querySelectorAll('[data-mp-satellite] canvas').length,
  };
});
console.log('TALL', JSON.stringify(g), 'pageerrors=', JSON.stringify(errs));
await p.screenshot({ path: '/tmp/p55c_evidence/R_tall_1400.png' });
await b.close();
process.exitCode = g.sum > 0 && g.stackOverflow === 0 && g.docOverflow <= 2 && errs.length === 0 && g.satCanvas > 0 ? 0 : 1;
