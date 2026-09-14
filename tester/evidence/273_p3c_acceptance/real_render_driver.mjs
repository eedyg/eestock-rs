import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');

const PORT = process.env.P3C_PORT || '18321';
const outDir = process.env.P3C_OUT || '/tmp/p3c-harness/out';
fs.mkdirSync(outDir, { recursive: true });
const url = `http://127.0.0.1:${PORT}/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
const requests = [];
page.on('request', (r) => requests.push(r.url()));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 180000 });
const result = await page.evaluate(() => window.__RESULT);
await page.screenshot({ path: path.join(outDir, 'p3c_harness.png'), fullPage: true });
await browser.close();

const nonLocal = [...new Set(requests.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}`) && !u.startsWith('data:')))];
const evidence = { url, version: result.version, errors: result.errors, console: consoleMsgs, networkNonLocal: nonLocal, scenarios: result.scenarios, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, 'p3c_harness.json'), JSON.stringify(evidence, null, 2));

console.log('klinecharts', result.version);
console.log('errors', JSON.stringify(result.errors));
console.log('non-local requests', JSON.stringify(nonLocal));
for (const [k, v] of Object.entries(result.scenarios)) {
  const flat = JSON.stringify(v);
  console.log(`\n== ${k} ==\n${JSON.stringify(v, null, 1)}`);
}
process.exitCode = result.errors.length === 0 && nonLocal.length === 0 ? 0 : 1;
