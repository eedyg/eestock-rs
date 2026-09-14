// P0.3 density-anchored driver (temp port + read-only proxy + real render)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');
const HERE = '/tmp/mp_p03/tester/evidence/260_p03_barspace_anchor';
const KC = '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/umd/klinecharts.min.js';
const PORT = 19500 + (process.pid % 300);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') { res.writeHead(405); res.end('read-only'); return; }
    const pr = http.request('http://127.0.0.1:8081' + req.url, { method: 'GET' }, (b) => { res.writeHead(b.statusCode, { 'content-type': b.headers['content-type'] || 'application/json' }); b.pipe(res); });
    pr.on('error', (e) => { res.writeHead(502); res.end(String(e)); }); pr.end(); return;
  }
  const f = u.pathname === '/klinecharts.js' ? KC : path.join(HERE, u.pathname === '/' ? 'mp03.html' : u.pathname.slice(1));
  try { res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(fs.readFileSync(f)); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1120, height: 1150 } });
const msgs = [];
page.on('pageerror', e => msgs.push('[pageerror] ' + e.message));
page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`));
page.on('request', r => { if (r.method() !== 'GET') msgs.push('[NON-GET ' + r.method() + '] ' + r.url()); });
await page.goto(`http://127.0.0.1:${PORT}/mp03.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const periods = ['1m', '5m', '15m', '1h', '1d', '1w'];
const out = { meta: { ts: new Date().toISOString(), code: '518880', proxy: `http://127.0.0.1:${PORT} -> http://127.0.0.1:8081`, kc: KC,
  klinechartsVersion: '10.0.3', bundleSha256: process.env.KC_SHA || null }, densities: {}, combos: [], ceilings: [] };
out.densities.d400 = await page.evaluate(([ps]) => window.__dDensity(ps, 400), [periods]);
out.densities.d120 = await page.evaluate(([ps]) => window.__dDensity(ps, 120), [periods]);

const MIN = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440, '1w': 10080 };
const COMBOS = [['1m', '5m'], ['1m', '15m'], ['1m', '1h'], ['1d', '1w'], ['1h', '1w'], ['1m', '1d'], ['1m', '1w']];

for (const [bp, sp] of COMBOS) {
  const satMax = 2000000;
  await page.evaluate(([b, s, m]) => window.__dInit(b, s, m), [bp, sp, satMax]);
  const ratioK8 = await page.evaluate(() => window.__dRatio(8));
  const ratioK16 = await page.evaluate(() => window.__dRatio(16));
  let mulD400 = ratioK8.D, mulD120 = ratioK16.D, mulSource = 'median-over-windows';
  if (mulD400 == null) { mulD400 = MIN[sp] / MIN[bp]; mulD120 = mulD400; mulSource = 'nominal-fallback(no coverage overlap)'; }
  const rows = [];
  for (const bs of [1, 5, 8, 20, 50]) {
    const nominal = await page.evaluate(([v, m]) => window.__dRound(v, m), [bs, MIN[sp] / MIN[bp]]);
    const dens400 = await page.evaluate(([v, m]) => window.__dRound(v, m), [bs, mulD400]);
    const dens400m = await page.evaluate(([v, m]) => window.__dRound(v, m, true), [bs, mulD400]);
    const dens400mi = await page.evaluate(([v, m]) => window.__dRound(v, m, true, 'int'), [bs, mulD400]);
    const dens120m = await page.evaluate(([v, m]) => window.__dRound(v, m, true), [bs, mulD120]);
    // local scan +/-25% around density multiplier, mirror on
    const scan = [];
    for (let k = -5; k <= 5; k++) {
      const m = mulD400 * (1 + k * 0.05);
      const r = await page.evaluate(([v, mm]) => window.__dRound(v, mm, true), [bs, m]);
      scan.push({ f: 1 + k * 0.05, mul: m, satBs: r.satBsRequested, errInSatBars: r.errInSatBars, errMin: r.errMin, satIdxSpan: r.sat.idxSpan });
    }
    const best = scan.reduce((a, b) => Math.abs(b.errInSatBars) < Math.abs(a.errInSatBars) ? b : a);
    rows.push({ baseBs: bs, nominal, dens400, dens400m, dens400mi, dens120m, scan, bestScan: best });
  }
  out.combos.push({ basePeriod: bp, satPeriod: sp, satMax, mulSource, mulDensityK8: mulD400, mulDensityK16: mulD120, ratioK8, ratioK16, nominalMul: MIN[sp] / MIN[bp], rows });
  console.log(`density combo ${bp}|${sp} mul400=${mulD400.toFixed(3)} mul120=${mulD120.toFixed(3)}`);
  if ((bp === '1d' && sp === '1w') || (bp === '1m' && sp === '15m')) {
    await page.evaluate(([v, m]) => window.__dRound(v, m, true), [8, mulD400]);
    await page.screenshot({ path: path.join(HERE, `shot_density_${bp}_${sp}_bs8.png`) });
  }
}
for (const p of ['1w', '1d', '1h', '15m']) out.ceilings.push(await page.evaluate(([sp]) => window.__dCeiling(sp, 2000000, 1), [p]));

await page.screenshot({ path: path.join(HERE, 'shot_ceiling_last.png'), fullPage: true });
out.console = msgs;
out.meta.nonGetRequests = msgs.filter(m => m.startsWith('[NON-GET')).length;
fs.writeFileSync(path.join(HERE, 'p03_density_result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ pageerrors: msgs.filter(m => m.includes('pageerror')) }));
await browser.close(); server.close();
