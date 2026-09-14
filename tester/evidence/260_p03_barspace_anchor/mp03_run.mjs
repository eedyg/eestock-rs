// P0.3 driver: temp static server (temp port) + read-only proxy to live backend GET /api/kline + Playwright real render
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');

const HERE = '/tmp/mp_p03/tester/evidence/260_p03_barspace_anchor';
const KC = '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/umd/klinecharts.min.js';
const BACKEND = 'http://127.0.0.1:8081';
const PORT = 18731 + (process.pid % 500);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') { res.writeHead(405); res.end('read-only proxy: only GET'); return; }
    const pr = http.request(BACKEND + req.url, { method: 'GET', headers: { host: '127.0.0.1:8081' } }, (b) => {
      res.writeHead(b.statusCode, { 'content-type': b.headers['content-type'] || 'application/json' }); b.pipe(res);
    });
    pr.on('error', (e) => { res.writeHead(502); res.end('proxy error ' + e.message); }); pr.end(); return;
  }
  const file = u.pathname === '/klinecharts.js' ? KC : path.join(HERE, u.pathname === '/' ? 'mp03.html' : u.pathname.replace(/^\//, ''));
  try { const buf = fs.readFileSync(file); res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(buf); }
  catch { res.writeHead(404); res.end('nf ' + u.pathname); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1120, height: 1150 } });
const msgs = [];
page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => msgs.push(`[pageerror] ${e.message}`));
page.on('request', r => { if (r.method() !== 'GET') msgs.push(`[NON-GET ${r.method()}] ${r.url()}`); });
await page.goto(`http://127.0.0.1:${PORT}/mp03.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const out = { meta: {}, combos: [], extra: {} };
out.meta = { ts: new Date().toISOString(), backend: BACKEND, code: '518880', page: `http://127.0.0.1:${PORT}/mp03.html`,
  klinechartsBundleSha256: process.env.KC_SHA || null, buckets: await page.evaluate(() => window.__measuredBuckets(['1m', '5m', '15m', '1h', '1d', '1w'])) };

const COMBOS = [['1m', '5m'], ['1m', '15m'], ['1m', '1h'], ['1d', '1w']];
const EXTRA_COMBOS = [['1h', '1w'], ['1m', '1d'], ['1m', '1w']];
const BASE_BS = [1, 2, 5, 8, 20, 50];

async function runCombo(bp, sp, satMax, screenshotTag) {
  await page.evaluate(([b, s, m]) => window.__init(b, s, m), [bp, sp, satMax]);
  const rows = [];
  for (const bs of BASE_BS) {
    const info = await page.evaluate((v) => window.__windowInfo(v), bs);
    const nominal = await page.evaluate((v) => window.__sync(v), bs);
    const densityApplied = await page.evaluate(([v, m]) => window.__sync(v, { mul: m }), [bs, info.densityMul]);
    const densityInt = await page.evaluate(([v, m]) => window.__sync(v, { mul: m }, { rounding: 'int' }), [bs, info.densityMul]);
    const nominalMirror = await page.evaluate((v) => window.__sync(v, null, { mirrorOffset: true }), bs);
    const densityMirror = await page.evaluate(([v, m]) => window.__sync(v, { mul: m }, { mirrorOffset: true }), [bs, info.densityMul]);
    const densityMirrorInt = await page.evaluate(([v, m]) => window.__sync(v, { mul: m }, { mirrorOffset: true, rounding: 'int' }), [bs, info.densityMul]);
    rows.push({ baseBs: bs, info, nominal, densityApplied, densityInt, nominalMirror, densityMirror, densityMirrorInt });
  }
  if (screenshotTag) await page.screenshot({ path: path.join(HERE, `shot_${bp}_${sp}_bs8.png`) });
  console.log(`combo ${bp}|${sp} done`);
  return { basePeriod: bp, satPeriod: sp, satMax, rows };
}

for (const [bp, sp] of COMBOS) out.combos.push(await runCombo(bp, sp, sp === '1w' ? 2000000 : 20000, true));
for (const [bp, sp] of EXTRA_COMBOS) out.combos.push(await runCombo(bp, sp, sp === '1w' ? 2000000 : 20000, true));

// multiplier scan: empirically required satellite barSpace per combo / base barSpace
out.scans = [];
for (const [bp, sp, lo, hi] of [['1m','5m',0.5,1.5],['1m','15m',0.5,1.5],['1m','1h',0.4,1.4],['1d','1w',0.4,1.3],['1h','1w',0.4,1.3],['1m','1d',0.1,1.1],['1m','1w',0.05,1.05]]) {
  await page.evaluate(([b, s]) => window.__init(b, s, 2000000), [bp, sp]);
  const rows = [];
  for (const bs of [1, 5, 8, 20, 50]) rows.push(await page.evaluate(([v, l, h]) => window.__scan(v, l, h, 12, false), [bs, lo, hi]));
  const rowsM = [];
  for (const bs of [1, 5, 8, 20, 50]) rowsM.push(await page.evaluate(([v, l, h]) => window.__scan(v, l, h, 12, true), [bs, lo, hi]));
  out.scans.push({ basePeriod: bp, satPeriod: sp, loopFactors: [lo, hi], steps: 12, rows, rowsMirrorOffset: rowsM });
  console.log(`scan ${bp}|${sp} done`);
  await page.screenshot({ path: path.join(HERE, `shot_scan_${bp}_${sp}.png`) });
}

out.extra.limitClamp = await page.evaluate(() => window.__limitClamp());
out.extra.isolation = await page.evaluate(() => window.__isolation());
out.extra.sweep1w = await page.evaluate(() => window.__satSweep('1w', 2000000));
out.extra.sweep1d = await page.evaluate(() => window.__satSweep('1d', 2000000));
out.extra.stability = await page.evaluate(() => window.__stability(20, 8, 400));

// satellite candle pane minimized (route-② shape) vs normal: anchor must not move
out.extra.satCandleMinimizedVsNormal = [];
for (const [bp, sp] of [['1d', '1w'], ['1m', '15m']]) {
  await page.evaluate(([b, s]) => window.__init(b, s, 2000000, { satCandleMinimized: true }), [bp, sp]);
  const min = await page.evaluate(([v, m]) => window.__sync(v, { mul: m }, { rounding: 'int' }), [8, 1]);
  await page.screenshot({ path: path.join(HERE, `shot_${bp}_${sp}_sat_minimized_bs8.png`) });
  await page.evaluate(([b, s]) => window.__init(b, s, 2000000, { satCandleMinimized: false }), [bp, sp]);
  const nor = await page.evaluate(([v, m]) => window.__sync(v, { mul: m }, { rounding: 'int' }), [8, 1]);
  out.extra.satCandleMinimizedVsNormal.push({ base: bp, sat: sp, minimized: min, normal: nor });
}
await page.screenshot({ path: path.join(HERE, 'shot_last_state.png'), fullPage: true });

out.console = msgs;
out.meta.nonGetRequests = msgs.filter(m => m.startsWith('[NON-GET')).length;
fs.writeFileSync(path.join(HERE, 'p03_result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ pageerrors: msgs.filter(m => m.includes('pageerror')), nonGet: out.meta.nonGetRequests }));
await browser.close();
server.close();
