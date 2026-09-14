import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');

const here = path.dirname(new URL(import.meta.url).pathname);
const url = 'file://' + path.join(here, 'harness.html');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 20000 });
const result = await page.evaluate(() => window.__RESULT);
await page.screenshot({ path: path.join(here, 'harness_render.png') });
// also save the chart-only PNG
let pic = null; try { pic = await page.evaluate(() => window.__CHART && window.__CHART.getConvertPictureUrl(false, 'png')); } catch (e) { console.error('chart png failed:', e.message); }
if (pic && pic.startsWith('data:image/png;base64,')) {
  fs.writeFileSync(path.join(here, 'chart_only.png'), Buffer.from(pic.split(',')[1], 'base64'));
}
const out = { url, console: consoleMsgs, result };
fs.writeFileSync(path.join(here, 'harness_result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ picLen: result && result.picLen, errors: result && result.errors, consoleTail: consoleMsgs.slice(-5) }, null, 2));
await browser.close();
