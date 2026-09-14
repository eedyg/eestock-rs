import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');

const here = path.dirname(new URL(import.meta.url).pathname);
const url = 'file://' + path.join(here, 'p7.html');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1600 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 60000 });
const result = await page.evaluate(() => window.__RESULT);
await page.screenshot({ path: path.join(here, 'p7_full.png'), fullPage: true });
let pic = null; try { pic = await page.evaluate(() => { const c = window.__CHART; return null; }); } catch (e) {}
const out = { url, console: consoleMsgs, result };
fs.writeFileSync(path.join(here, 'p7_result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ version: result && result.version, errors: result && result.errors, consoleTail: consoleMsgs.slice(-8) }, null, 2));
await browser.close();
