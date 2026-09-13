import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.mjs';
import fs from 'fs';
const BASE = 'http://127.0.0.1:8081';
const OUT = '/tmp/lane049/evidence';
const ZERO = [118, 128, 143];
const log = []; const reqs = []; let page; const R = {};
const note = s => { log.push(s); console.log('[*]', s); };

const GEOM = () => {
  const mc = document.querySelector('[data-region="main-chart"]');
  const mcr = mc.getBoundingClientRect();
  const anchor = document.querySelector('[data-region="sub-chart"]');
  const acs = getComputedStyle(anchor); const ar = anchor.getBoundingClientRect();
  const root = mc.querySelector('div[style*="overflow: hidden"]');
  const kids = [...root.children].map(e => {
    const r = e.getBoundingClientRect();
    return { tag: e.tagName, y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width),
      bg: getComputedStyle(e).backgroundColor, hasNsResize: !!e.querySelector('[style*="ns-resize"]') };
  });
  const lineCandidates = [];
  for (const el of mc.querySelectorAll('*')) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const bt = parseFloat(cs.borderTopWidth) || 0; const bb = parseFloat(cs.borderBottomWidth) || 0;
    const bgA = cs.backgroundColor;
    const bgVisible = bgA && bgA !== 'rgba(0, 0, 0, 0)' && bgA !== 'transparent';
    const thinFull = r.width >= mcr.width * 0.95 && r.height <= 3 && r.height >= 0.4 && bgVisible;
    const borderLine = r.width >= mcr.width * 0.95 && (bt > 0 || bb > 0);
    if (!thinFull && !borderLine) continue;
    const hasDrag = !!el.querySelector('[style*="ns-resize"]');
    const isKc = hasDrag || bgA === 'rgb(221, 221, 221)';
    lineCandidates.push({ cls: String(el.className).slice(0, 50), y: Math.round(r.y * 100) / 100, h: Math.round(r.height * 100) / 100,
      w: Math.round(r.width), bg: bgA, borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
      borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomStyle, thinFull, borderLine, nsResizeChild: hasDrag, isKcSeparator: isKc,
      kind: thinFull ? 'thin-full-width' : 'border-on-element' });
  }
  return { mcr: { x: Math.round(mcr.x), y: Math.round(mcr.y), w: Math.round(mcr.width), h: Math.round(mcr.height) },
    anchor: { cls: String(anchor.className), y: Math.round(ar.y), h: Math.round(ar.height),
      borderTopWidth: acs.borderTopWidth, borderTopStyle: acs.borderTopStyle, borderTopColor: acs.borderTopColor, bg: acs.backgroundColor },
    kids, panes: kids.filter(k => k.h > 30 && k.w > 100), seps: kids.filter(k => k.h <= 3),
    candidates: lineCandidates,
    strays: lineCandidates.filter(c => !c.isKcSeparator) };
};

// per-pane pixel scan: returns per-canvas color histogram (restricted to x in [xLo,xHi]) and zero-color line rows w/ dash geometry
const SCAN = ({ xLo, xHi, ZERO }) => {
  const near = (a, b, c, t, tol) => Math.abs(a - t[0]) <= tol && Math.abs(b - t[1]) <= tol && Math.abs(c - t[2]) <= tol;
  const root = document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
  const out = [];
  for (const el of root.querySelectorAll('canvas')) {
    const cr = el.getBoundingClientRect();
    const w = el.width, h = el.height;
    const x0 = Math.max(0, Math.floor(w * xLo)), x1 = Math.min(w, Math.ceil(w * xHi));
    const ctx = el.getContext('2d'); const img = ctx.getImageData(0, 0, w, h).data;
    const map = new Map(); const zeroRow = new Map();
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4; const a = img[i + 3];
      if (a < 150) continue;
      const key = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      let rec = map.get(key); if (!rec) { rec = { hex: '#' + [img[i], img[i + 1], img[i + 2]].map(v => v.toString(16).padStart(2, '0')).join(''), n: 0, minRow: y, maxRow: y }; map.set(key, rec); }
      rec.n++; if (y < rec.minRow) rec.minRow = y; if (y > rec.maxRow) rec.maxRow = y;
      if (near(img[i], img[i + 1], img[i + 2], ZERO, 6)) zeroRow.set(y, (zeroRow.get(y) || 0) + 1);
    }
    const span = x1 - x0;
    // line-like rows for zero color: >=30% of scanned width AND reach near right edge
    const rows = [...zeroRow.entries()].filter(([, n]) => n >= span * 0.30).sort((a, b) => b[1] - a[1]).map(([y, n]) => ({ row: y, n, frac: Math.round(1000 * n / span) / 1000 }));
    let dash = null;
    if (rows.length) {
      const yc = rows[0].row;
      const mask = [];
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          const y = yc + dy; if (y < 0 || y >= h) continue;
          const i = (y * w + x) * 4;
          if (img[i + 3] > 0 && near(img[i], img[i + 1], img[i + 2], ZERO, 90)) on = 1;
        }
        mask.push(on);
      }
      const runs = []; let cur = mask[0], len = 1;
      for (let x = 1; x < w; x++) { if (mask[x] === cur) len++; else { runs.push([cur, len]); cur = mask[x]; len = 1; } }
      runs.push([cur, len]);
      const ons = runs.filter(r => r[0] === 1).map(r => r[1]).sort((a, b) => a - b);
      const offs = runs.filter(r => r[0] === 0).map(r => r[1]).slice(1, -1).sort((a, b) => a - b);
      const med = a => a.length ? a[Math.floor(a.length / 2)] : null;
      dash = { medOn: med(ons), medOff: med(offs), onRuns: ons.slice(0, 8), onFrac: Math.round(1000 * mask.reduce((a, b) => a + b, 0) / w) / 1000 };
    }
    out.push({ rect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) }, scannedX: [x0, x1], topColors: [...map.values()].sort((a, b) => b.n - a.n).slice(0, 12).map(c => ({ hex: c.hex, n: c.n, minRow: c.minRow, maxRow: c.maxRow })), zeroLineRows: rows, dash });
  }
  return out;
};

async function park() { await page.mouse.move(5, 5); await page.waitForTimeout(900); }
async function snap(name) {
  await park();
  const g = await page.evaluate(GEOM);
  g.canvasScans = await page.evaluate(SCAN, { xLo: 0.55, xHi: 0.99, ZERO });
  g.canvasScansFull = await page.evaluate(SCAN, { xLo: 0.0, xHi: 1.0, ZERO });
  fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(g, null, 1));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  return g;
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
page = await ctx.newPage();
page.on('request', r => reqs.push({ m: r.method(), u: r.url() }));
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// ---- issue1: default ----
let g = await snap('p2-default');
R.default = { anchor: g.anchor, panes: g.panes, seps: g.seps, strays: g.strays, candidates: g.candidates };
note(`default: panes=${g.panes.length}(${g.panes.map(p => p.h)}) seps=${g.seps.length} strays=${g.strays.length} anchor.borderTopWidth=${g.anchor.borderTopWidth}`);

// ---- issue1: drag separator up 150 ----
const sep0 = g.seps[0];
if (sep0) {
  const x = g.mcr.x + Math.round(g.mcr.w * 0.5);
  await page.mouse.move(x, sep0.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x, sep0.y - 150 * i / 12);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  g = await snap('p2-dragged');
  R.dragged = { anchor: g.anchor, panes: g.panes, seps: g.seps, strays: g.strays, candidates: g.candidates };
  note(`dragged: panes=${g.panes.map(p => p.h)} seps=${g.seps.map(s => s.y)} strays=${g.strays.length}`);
}

// ---- issue1 reverse control: inject pre-fix border-t on anchor ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.evaluate(() => { document.querySelector('[data-region="sub-chart"]').style.borderTop = '1px solid #e5e7eb'; });
g = await snap('p2-injected-default');
R.injected_default = { anchor: g.anchor, panes: g.panes, seps: g.seps, strays: g.strays, candidates: g.candidates };
note(`injected(default): strays=${g.strays.length} -> ${JSON.stringify(g.strays.map(s => ({ y: s.y, kind: s.kind, bt: s.borderTop, cls: s.cls })))}`);
const injSep = g.seps[0];
if (injSep) {
  const x = g.mcr.x + Math.round(g.mcr.w * 0.5);
  await page.mouse.move(x, injSep.y); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x, injSep.y - 150 * i / 12);
  await page.mouse.up(); await page.waitForTimeout(1200);
  g = await snap('p2-injected-dragged');
  R.injected_dragged = { panes: g.panes, seps: g.seps, strays: g.strays, candidates: g.candidates };
  note(`injected(dragged): seps=${g.seps.map(s => s.y)} strays=${JSON.stringify(g.strays.map(s => ({ y: s.y, kind: s.kind, cls: s.cls })))}`);
}

// ---- issue2 shapes ----
async function dcapOn() { await page.getByRole('button', { name: 'DCAP', exact: true }).click(); await page.waitForTimeout(3500); }
async function shape(name, setup) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5500);
  const before = reqs.length;
  if (setup) await setup();
  await dcapOn();
  const g = await snap(name);
  const kline = reqs.slice(before).filter(r => r.u.includes('/api/kline')).map(r => r.m + ' ' + r.u.replace(BASE, ''));
  const dcapPane = { ...g.panes[g.panes.length - 1] };
  R[name] = { panes: g.panes, seps: g.seps, strays: g.strays, anchor: g.anchor, dcapPane, canvasScans: g.canvasScans, canvasScansFull: g.canvasScansFull, klineRequests: kline };
  const first = g.canvasScans.find(c => c.zeroLineRows.length);
  note(`${name}: panes=${g.panes.map(p => p.h)} seps=${g.seps.length} strays=${g.strays.length} kline=${JSON.stringify(kline)}`);
  note(`   zero-line rows: ${JSON.stringify(g.canvasScans.map(c => c.zeroLineRows))}`);
  note(`   topColors(DCAP pane): ${JSON.stringify((g.canvasScans[g.canvasScans.length - 2] || {}).topColors)}`);
  note(`   dash: ${JSON.stringify((g.canvasScans.find(c => c.dash) || {}).dash)}`);
  return g;
}

await shape('p2-s1-15m-518880');
await shape('p2-s2-1m-518880', async () => { await page.getByRole('button', { name: '1m', exact: true }).click(); await page.waitForTimeout(2500); });
await shape('p2-s3-day-518880', async () => { await page.getByRole('button', { name: '日', exact: true }).click(); await page.waitForTimeout(2500); });
await shape('p2-s4-15m-161226', async () => { await page.getByText('161226', { exact: true }).click(); await page.waitForTimeout(2500); });

// ---- issue2 negative control: DCAP off in same layout ----
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5500);
g = await snap('p2-s5-dcap-off');
R['p2-s5-dcap-off'] = { panes: g.panes, seps: g.seps, strays: g.strays, canvasScans: g.canvasScans, zeroAny: g.canvasScans.map(c => c.zeroLineRows) };
note(`dcap-off: panes=${g.panes.length} zeroRows=${JSON.stringify(g.canvasScans.map(c => c.zeroLineRows))}`);

// ---- issue2 crosshair confound doc: mouse inside chart ----
await dcapOn();
await page.mouse.move(900, 500); await page.waitForTimeout(900);
const cross = await page.evaluate(SCAN, { xLo: 0.55, xHi: 0.99, ZERO });
R['p2-s6-mouse-inside'] = { note: 'crosshair visible', canvasScans: cross };
note(`mouse-inside: zeroRows=${JSON.stringify(cross.map(c => c.zeroLineRows))} dash=${JSON.stringify(cross.map(c => c.dash))}`);
await page.screenshot({ path: `${OUT}/p2-s6-mouse-inside.png` });

// ---- issue2 reverse: inject dashed line at wrong y in DCAP pane ----
const dcapCanvases = await page.evaluate(() => {
  const root = document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
  return [...root.querySelectorAll('canvas')].map(c => { const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
});
await page.evaluate(({ canvases }) => {
  const root = document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
  const tgt = [...root.querySelectorAll('canvas')].filter(c => { const r = c.getBoundingClientRect(); return Math.round(r.height) === canvases.h && Math.round(r.width) === canvases.w && Math.round(r.y) === canvases.y; })[0];
  const ctx = tgt.getContext('2d');
  const row = Math.round(tgt.height * 0.75);
  ctx.save(); ctx.strokeStyle = '#76808F'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, row + 0.5); ctx.lineTo(tgt.width, row + 0.5); ctx.stroke(); ctx.restore();
  window.__INJ__ = { row, h: tgt.height };
}, { canvases: dcapCanvases[dcapCanvases.length - 2] });
const inj = await page.evaluate(() => window.__INJ__);
const injScan = await page.evaluate(SCAN, { xLo: 0.55, xHi: 0.99, ZERO });
R['p2-s7-injected-zero'] = { injected: inj, canvasScans: injScan };
note(`issue2 reverse: injected at canvas row ${JSON.stringify(inj)}; detected rows=${JSON.stringify(injScan.map(c => c.zeroLineRows))}`);
await page.screenshot({ path: `${OUT}/p2-s7-injected-zero.png` });

const nonGet = reqs.filter(r => r.m !== 'GET');
R.requests = { total: reqs.length, nonGet: nonGet.map(r => r.m + ' ' + r.u), delta: nonGet.length };
note(`requests: total=${reqs.length} nonGET=${nonGet.length}`);
fs.writeFileSync(`${OUT}/probe2-record.json`, JSON.stringify(R, null, 1));
fs.writeFileSync(`${OUT}/probe2-log.txt`, log.join('\n'));
await browser.close();
console.log('DONE');
