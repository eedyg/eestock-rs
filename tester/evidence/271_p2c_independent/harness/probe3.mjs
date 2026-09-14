/** P2-C 独立验收 · 第三轮：逐 pane 指标归属 + 逐 pane 像素（临时；不进仓库）。 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');
const DIST = '/tmp/p2c/dist';
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.join(DIST, decodeURIComponent(u.pathname));
  if (u.pathname === '/') p = path.join(DIST, 'index.html');
  fs.readFile(p, (e, b) => { if (e) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('content-type', MIME[path.extname(p)] ?? 'application/octet-stream'); res.end(b); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}/`;
const net = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('request', (r) => net.push(r.url()));
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => (window.__charts || []).length >= 5, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(() => {
  const W = window;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) }; };
  const UP = [255, 92, 108], DOWN = [0, 224, 164], ZERO = [118, 128, 143], AXIS = [139, 147, 176];
  const near = (d, c, tol) => Math.abs(d[0] - c[0]) <= tol && Math.abs(d[1] - c[1]) <= tol && Math.abs(d[2] - c[2]) <= tol;
  const samplePane = (chart, paneId) => {
    const el = chart.getDom(paneId);
    if (!el) return { error: 'no pane dom' };
    const acc = { rect: rect(el), canvases: [], upHits: 0, downHits: 0, axisHits: 0, zeroHits: 0, coloredHits: 0, zeroRows: [] };
    for (const c of el.querySelectorAll('canvas')) {
      acc.canvases.push({ w: c.width, h: c.height });
      if (!c.width || !c.height) continue;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const rows = new Map();
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] < 40) continue;
        const px = [d[i], d[i + 1], d[i + 2]];
        const diff = Math.abs(px[0] - px[1]) + Math.abs(px[1] - px[2]) + Math.abs(px[0] - px[2]);
        if (diff > 110) acc.coloredHits++;
        if (near(px, UP, 20)) acc.upHits++;
        else if (near(px, DOWN, 20)) acc.downHits++;
        else if (near(px, ZERO, 8)) { acc.zeroHits++; rows.set(y, (rows.get(y) ?? 0) + 1); }
        else if (near(px, AXIS, 8)) acc.axisHits++;
      }
      for (const [y, n] of rows) if (n >= 8) acc.zeroRows.push(y);
    }
    acc.zeroRows = [...new Set(acc.zeroRows)].sort((a, b) => a - b).slice(0, 10);
    return acc;
  };
  const out = {};
  out.__queriesByPeriod = (W.__queries || []).reduce((m, q) => { const k = q.period; m[k] = m[k] || []; m[k].push({ limit: q.limit, before: q.before }); return m; }, {});
  out.__paneDetail = (() => {
    const rec = W.__charts.find((c) => c.host === 'sat:1m');
    const paneId = (rec.chart.getIndicators().find((i) => i.name === 'DCAP') || {}).paneId;
    const el = rec.chart.getDom(paneId);
    const canvases = [];
    for (const c of el.querySelectorAll('canvas')) {
      const d = c.width && c.height ? c.getContext('2d').getImageData(0, 0, c.width, c.height).data : null;
      const rows = new Map();
      let z = 0;
      if (d) for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] < 40) continue;
        if (Math.abs(d[i] - 118) <= 8 && Math.abs(d[i + 1] - 128) <= 8 && Math.abs(d[i + 2] - 143) <= 8) { z++; rows.set(y, (rows.get(y) ?? 0) + 1); }
      }
      canvases.push({ w: c.width, h: c.height, zeroPixels: z, zeroRows: [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([y, n]) => ({ y, n })) });
    }
    const txts = W.__texts.filter((t) => t.host === 'sat:1m').filter((t) => /0\.0|^[SML]: |^0:/.test(t.text)).map((t) => ({ text: t.text, x: t.x, y: t.y, bl: t.baseline, font: t.font }));
    return { paneId, canvases, texts: txts };
  })();
  for (const { chart, host } of W.__charts) {
    const panes = chart.getPaneOptions();
    const inds = chart.getIndicators();
    out[host] = {
      panes: panes.map((p) => ({ id: p.id, state: p.state, height: p.height, minHeight: p.minHeight, rect: rect(chart.getDom(p.id)) })),
      indicators: inds.map((i) => ({ name: i.name, paneId: i.paneId, precision: i.precision })),
      paneIds: [...new Set(inds.map((i) => i.paneId))],
      perPane: Object.fromEntries(panes.map((p) => [p.id, samplePane(chart, p.id)])),
      // 指标归属聚合：MA 落哪个 pane、DCAP 落哪个 pane、DCAP pane 是否非零高
      dcapPane: (inds.find((i) => i.name === 'DCAP') || {}).paneId ?? null,
      maPane: (inds.find((i) => i.name === 'MA') || {}).paneId ?? null,
    };
  }
  return out;
});
await browser.close(); server.close();
const nonLocal = [...new Set(net.filter((u) => !u.startsWith(base)))];
fs.writeFileSync('/tmp/p2c/evidence/p2c_probe3.json', JSON.stringify({ port: PORT, nonLocalRequests: nonLocal, logs, result: R }, null, 2));
console.log(JSON.stringify({ port: PORT, nonLocalRequests: nonLocal, logs, result: R }, null, 2));
