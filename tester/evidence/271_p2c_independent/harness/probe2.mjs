/**
 * P2-C 独立验收 · 第二轮：布局时序诊断 + 像素/零线取证（临时；不进仓库）。
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');
const DIST = '/tmp/p2c/dist';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
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

const R = await page.evaluate(async () => {
  const W = window;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) }; };
  const out = { domDump: {}, beforeResize: {}, afterResize: {}, pixels: {}, tickVsZero: {}, texts: {} };
  const chartFor = (p) => W.__charts.find((c) => c.host === 'sat:' + p).chart;

  // ── DOM 转储（sat:1m 图表子树，含 pane 包装层）──
  const c1 = chartFor('1m');
  const rootEl = c1.getDom();
  const dump = (el, depth, acc) => {
    if (depth > 4 || !el) return;
    for (const ch of el.children) {
      const tag = ch.tagName.toLowerCase();
      const cls = (ch.getAttribute('class') || '').slice(0, 60);
      acc.push('  '.repeat(depth) + `${tag}.${cls} ${JSON.stringify(rect(ch))} data-pane=${ch.getAttribute('data-pane-id') ?? '-'}`);
      dump(ch, depth + 1, acc);
    }
  };
  const acc = [];
  acc.push(`chartRoot=${JSON.stringify(rect(rootEl))} clientH=${rootEl.clientHeight} offsetH=${rootEl.offsetHeight}`);
  dump(rootEl, 0, acc);
  out.domDump['sat:1m'] = acc;

  const candleR = (p) => rect(chartFor(p).getDom('candle_pane'));
  const indR = (p) => { const c = chartFor(p); const i = c.getIndicators().find((x) => x.name === 'DCAP'); return i ? rect(c.getDom(i.paneId)) : null; };
  for (const p of ['1m', '5m', '15m', '1h']) out.beforeResize[p] = { root: rect(rootEl), candle: candleR(p), ind: indR(p) };

  // ── 显式 resize（模拟容器高度就绪后的重排；用于判别「布局时序伪影」vs「实现缺陷」）──
  for (const p of ['1m', '5m', '15m', '1h']) { try { chartFor(p).resize(); } catch { /* ignore */ } }
  await wait(800);
  for (const p of ['1m', '5m', '15m', '1h']) {
    const cr = candleR(p), ir = indR(p);
    const rootH = rect(chartFor(p).getDom()).h;
    out.afterResize[p] = { chartRootH: rootH, candle: cr, ind: ir, gapPx: cr && ir ? +(ir.top - cr.bottom).toFixed(1) : null, indRatio: ir && rootH ? +(ir.h / rootH).toFixed(3) : null };
  }

  // ── 逐实例像素采样（含零线颜色 #76808F 与 0 参考线行）──
  const CANDLE = [[255, 92, 108], [0, 224, 164], [139, 147, 176]];
  const ZERO = [118, 128, 143];
  const near = (d, c, tol) => Math.abs(d[0] - c[0]) <= tol && Math.abs(d[1] - c[1]) <= tol && Math.abs(d[2] - c[2]) <= tol;
  const sampleHost = (sel) => {
    const root = document.querySelector(sel);
    if (!root) return { error: 'no root' };
    const cvs = [...root.querySelectorAll('canvas')];
    const acc2 = { canvases: cvs.map((c) => ({ w: c.width, h: c.height })), candleHits: 0, coloredHits: 0, saturatedNonCandle: 0, zeroLineHits: 0, zeroRows: [] };
    for (const c of cvs) {
      if (!c.width || !c.height) continue;
      const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const d = img.data;
      const rows = new Map();
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] < 40) continue;
        const px = [d[i], d[i + 1], d[i + 2]];
        let isC = false;
        for (const cc of CANDLE) if (near(px, cc, 12)) { isC = true; acc2.candleHits++; break; }
        const diff = Math.abs(px[0] - px[1]) + Math.abs(px[1] - px[2]) + Math.abs(px[0] - px[2]);
        if (diff > 110) { acc2.coloredHits++; if (!isC) acc2.saturatedNonCandle++; }
        if (near(px, ZERO, 10)) { acc2.zeroLineHits++; rows.set(y, (rows.get(y) ?? 0) + 1); }
      }
      for (const [y, n] of rows) if (n >= 8) acc2.zeroRows.push(y);
    }
    acc2.zeroRowsUnique = [...new Set(acc2.zeroRows)].sort((a, b) => a - b).slice(0, 12);
    return acc2;
  };
  out.pixels['base'] = sampleHost('[data-host="baseline"]');
  for (const p of ['1m', '5m', '15m', '1h']) out.pixels[p] = sampleHost(`[data-mp-satellite="${p}"]`);

  // ── y == y(0)：0 参考线像素行 vs Y 轴刻度文本 '0.00000' 的基线 y ──
  const texts = W.__texts.filter((t) => t.y != null);
  for (const host of ['base', '1m', '5m', '15m', '1h']) {
    const key = host === 'base' ? 'base:baseline' : 'sat:' + host;
    const arr = texts.filter((t) => t.host === key);
    const zeroTicks = arr.filter((t) => /^0(\.0+)?$/.test(t.text.trim()));
    const p5 = [...new Set(arr.filter((t) => /\d\.\d{5}(?!\d)/.test(t.text)).map((t) => t.text))].slice(0, 6);
    const zeroLegends = [...new Set(arr.filter((t) => /^0:/.test(t.text)).map((t) => t.text))].slice(0, 3);
    out.tickVsZero[host] = {
      zeroTickTexts: zeroTicks.slice(0, 4).map((t) => ({ text: t.text, y: +t.y.toFixed(1) })),
      precision5Samples: p5, zeroLineLegends: zeroLegends,
      dcapFigureTitles: [...new Set(arr.filter((t) => /^[SML]: /.test(t.text)).map((t) => t.text))].slice(0, 6),
      maTitles: [...new Set(arr.filter((t) => /^MA/.test(t.text)).map((t) => t.text))].slice(0, 4),
      total: arr.length,
    };
  }
  return out;
});

await page.screenshot({ path: '/tmp/p2c/evidence/p2c_after_resize.png', fullPage: true });
const perHostShot = {};
for (const s of ['[data-host="baseline"]', '[data-mp-satellite="1m"]', '[data-mp-satellite="15m"]']) {
  const el = await page.$(s);
  if (!el) continue;
  const f = '/tmp/p2c/evidence/p2c2_' + s.replace(/[^0-9a-z]/gi, '') + '.png';
  await el.screenshot({ path: f }); perHostShot[s] = f;
}
await browser.close(); server.close();
const nonLocal = [...new Set(net.filter((u) => !u.startsWith(base)))];
const ev = { port: PORT, nonLocalRequests: nonLocal, logs, result: R, shots: perHostShot };
fs.writeFileSync('/tmp/p2c/evidence/p2c_probe2.json', JSON.stringify(ev, null, 2));
console.log(JSON.stringify(ev, null, 2));
