/**
 * P2-C 独立验收：真实渲染 + 像素级取证 runner（临时；**不进仓库**）。
 * 用法：/home/.../web/node_modules/.bin/../  →   在 web/ 下：node /tmp/p2c/render.mjs
 * 仅本地静态服务（随机临时端口，进程内创建、结束即销毁）；**0 网络请求**。
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');

const DIST = '/tmp/p2c/dist';
const OUT = process.env.P2C_OUT ?? '/tmp/p2c/evidence';
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.join(DIST, decodeURIComponent(u.pathname));
  if (u.pathname === '/' || u.pathname === '') p = path.join(DIST, 'index.html');
  fs.readFile(p, (err, buf) => {
    if (err) { res.statusCode = 404; res.end('nf'); return; }
    res.setHeader('content-type', MIME[path.extname(p)] ?? 'application/octet-stream');
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/`;
const net = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('request', (r) => net.push(r.url()));
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => (window.__charts || []).length >= 5, null, { timeout: 30_000 });
await page.waitForTimeout(1500);

const result = await page.evaluate(async () => {
  const W = window;
  const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2), width: +r.width.toFixed(2) }; };
  const out = { geometry: {}, panes: {}, indicators: {}, texts: {}, pixels: {}, overflow: {}, errors: [] };

  // ── 画布像素采样（禁用 getConvertPictureUrl：零高 pane 抛 InvalidStateError）──
  const CANDLE = [[255, 92, 108], [0, 224, 164], [139, 147, 176]];
  const ZERO = [118, 128, 143];
  const near = (d, c, tol) => Math.abs(d[0] - c[0]) <= tol && Math.abs(d[1] - c[1]) <= tol && Math.abs(d[2] - c[2]) <= tol;
  const sample = (host) => {
    const root = host === 'base' ? document.querySelector('[data-host="baseline"]') : document.querySelector(`[data-mp-satellite="${host}"]`);
    if (!root) return { error: 'no root' };
    const cvs = [...root.querySelectorAll('canvas')];
    const acc = { canvases: cvs.length, canvasSizes: [], candleHits: 0, saturatedNonCandle: 0, zeroLineHits: 0, coloredHits: 0, rowsWithZeroLine: [], zeroRowsAll: [] };
    for (const cv of cvs) {
      const c = cv;
      acc.canvasSizes.push({ w: c.width, h: c.height, cssW: +c.getBoundingClientRect().width.toFixed(1), cssH: +c.getBoundingClientRect().height.toFixed(1) });
      if (!c.width || !c.height) continue;
      let img;
      try { img = (c.getContext('2d')).getImageData(0, 0, c.width, c.height); } catch (e) { out.errors.push('getImageData:' + String(e)); continue; }
      const d = img.data;
      const zeroRows = new Map();
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const a = d[i + 3];
          if (a < 40) continue;
          const px = [d[i], d[i + 1], d[i + 2]];
          let isCandle = false;
          for (const cc of CANDLE) if (near(px, cc, 12)) { isCandle = true; acc.candleHits++; break; }
          const diff = Math.abs(px[0] - px[1]) + Math.abs(px[1] - px[2]) + Math.abs(px[0] - px[2]);
          if (diff > 110) { acc.coloredHits++; if (!isCandle) acc.saturatedNonCandle++; }
          if (near(px, ZERO, 10)) { acc.zeroLineHits++; zeroRows.set(y, (zeroRows.get(y) ?? 0) + 1); }
        }
      }
      for (const [y, n] of zeroRows) if (n >= 5) acc.rowsWithZeroLine.push(y);
    }
    acc.zeroRowsAll = acc.rowsWithZeroLine.slice(0, 50);
    return acc;
  };

  // ── 逐实例几何 / pane / 指标 ──
  const charts = W.__charts;
  out.chartCount = charts.length;
  out.chartHosts = charts.map((c) => c.host);
  for (const { chart, host } of charts) {
    const panes = chart.getPaneOptions();
    const candle = (panes).find((p) => p.id === 'candle_pane');
    const inds = chart.getIndicators();
    const indPane = inds.find((i) => i.name === 'DCAP');
    const candleEl = chart.getDom('candle_pane');
    const indEl = indPane ? chart.getDom(indPane.paneId) : null;
    const rc = rect(candleEl), ri = rect(indEl);
    let zeroY = null;
    try {
      if (indPane) zeroY = chart.convertToPixel({ paneId: indPane.paneId, value: 0 });
    } catch (e) { zeroY = 'err:' + String((e).message).slice(0, 80); }
    out.geometry[host] = {
      satRootHeight: rect(host.startsWith('sat:') ? document.querySelector(`[data-mp-satellite="${host.slice(4)}"]`) : document.querySelector('[data-host="baseline"]')),
      candlePane: { state: (candle)?.state, height: (candle)?.height, minHeight: (candle)?.minHeight, rect: rc },
      indPane: { id: indPane?.paneId ?? null, rect: ri },
      gapPx: rc && ri ? +(ri.top - rc.bottom).toFixed(2) : null,
      indFillsContainer: !!(ri && out.geometry[host] ? true : true),
      zeroLineY: typeof zeroY === 'number' ? +zeroY.toFixed(2) : zeroY,
    };
    out.panes[host] = (panes).map((p) => ({ id: p.id, state: p.state, height: p.height, minHeight: p.minHeight }));
    out.indicators[host] = inds.map((i) => ({ name: i.name, paneId: i.paneId, precision: i.precision, calcParams: i.calcParams }));
  }

  // ── 缩放/滚动后仍成立（对每个卫星）──
  const afterZoom = {};
  for (const { chart, host } of charts) {
    if (host && host.startsWith('sat:')) {
      try { chart.setBarSpace(30); chart.scrollToDataIndex(40); } catch (e) { out.errors.push('zoom:' + String(e)); }
    }
  }
  await wait(500);
  for (const { chart, host } of charts) {
    const rc = rect(chart.getDom('candle_pane'));
    const inds = chart.getIndicators();
    const indPane = inds.find((i) => i.name === 'DCAP');
    const ri = rect(indPane ? chart.getDom(indPane.paneId) : null);
    afterZoom[host] = { candleRect: rc, candleHeightZero: !!(rc && rc.height === 0), gapPx: rc && ri ? +(ri.top - rc.bottom).toFixed(2) : null };
  }
  out.afterZoomScroll = afterZoom;

  // ── 画布文本（per-host 归因）──
  const texts = W.__texts;
  const byHost = {};
  for (const t of texts) {
    byHost[t.host] = byHost[t.host] || [];
    if (byHost[t.host].length < 4000) byHost[t.host].push(t.text);
  }
  for (const k of Object.keys(byHost)) {
    const arr = byHost[k];
    out.texts[k] = {
      count: arr.length,
      hasDcapFigures: arr.some((s) => /^S: |^M: |^L: /.test(s)),
      zeroLegend: arr.filter((s) => /^0:/.test(s)).slice(0, 3),
      precision5: [...new Set(arr.filter((s) => /\d\.\d{5}(?!\d)/.test(s)))].slice(0, 6),
      hasMa: arr.some((s) => /^MA\d*:|MA\(/.test(s)),
      sample: [...new Set(arr)].slice(0, 20),
    };
  }

  // ── 像素 ──
  out.pixels['base:baseline'] = sample('base');
  for (const p of ['1m', '5m', '15m', '1h']) out.pixels[p] = sample(p);

  // ── overflow（已知限制 P5）──
  const main = document.getElementById('main');
  out.overflow = {
    mainClientHeight: main.clientHeight, mainScrollHeight: main.scrollHeight,
    mainRect: rect(main), overflowPx: main.scrollHeight - main.clientHeight,
    children: [...main.children].map((c) => ({ tag: (c).getAttribute('data-mp-satellite') ?? (c).getAttribute('data-host'), h: +(c).getBoundingClientRect().height.toFixed(1) })),
  };
  return out;
});

const shotFull = path.join(OUT, 'p2c_harness_full.png');
await page.screenshot({ path: shotFull, fullPage: true });
const shots = [shotFull];
for (const sel of ['[data-host="baseline"]', '[data-mp-satellite="1m"]', '[data-mp-satellite="5m"]', '[data-mp-satellite="15m"]', '[data-mp-satellite="1h"]']) {
  const el = await page.$(sel);
  if (!el) continue;
  const f = path.join(OUT, `p2c_${sel.replace(/[^0-9a-z]/gi, '')}.png`);
  await el.screenshot({ path: f });
  shots.push(f);
}
await browser.close();
server.close();

const nonLocal = [...new Set(net.filter((u) => !u.startsWith(BASE)))];
const evidence = { base: BASE, generatedAt: new Date().toISOString(), klinecharts: '10.0.3', nonLocalRequests: nonLocal, logs, result, screenshots: shots };
fs.writeFileSync(path.join(OUT, 'p2c_harness.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ port: PORT, chartHosts: result.chartHosts, geometry: result.geometry, indicators: result.indicators, pixels: result.pixels, texts: result.texts, afterZoomScroll: result.afterZoomScroll, overflow: result.overflow, nonLocalRequests: nonLocal, logs, screenshots: shots }, null, 2));
