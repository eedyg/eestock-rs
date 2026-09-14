// P0.1-C independent acceptance: real klinecharts 10.0.3 rendering in headless Chromium.
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.js';
const { chromium } = pw;
import fs from 'node:fs';

const H = '/tmp/p01c/harness';
const OUT = '/tmp/p01c/evidence';
fs.mkdirSync(OUT, { recursive: true });

const RED = '#FF2D2D';   // MA overlay lines
const BLUE = '#1B6DFF';  // EMA overlay lines
const MA_STYLES = { lines: [{ color: RED }, { color: RED }, { color: RED }, { color: RED }] };
const EMA_STYLES = { lines: [{ color: BLUE }, { color: BLUE }] };

const bars = [];
{
  let p = 100;
  for (let i = 0; i < 160; i++) {
    const o = p;
    p = p + Math.sin(i / 7) * 1.6 + Math.cos(i / 3) * 0.8;
    bars.push({
      timestamp: Date.UTC(2026, 0, 1) + i * 86400000,
      open: o, high: Math.max(o, p) + 0.9, low: Math.min(o, p) - 0.9, close: p,
      volume: 1000 + (i % 13) * 50,
    });
  }
}

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#101418"><div id="root"></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
await page.setContent(pageHtml);
await page.addScriptTag({ path: `${H}/klinecharts.js` });
await page.addScriptTag({ path: `${H}/overlayEntry.js` });
await page.addScriptTag({ path: `${H}/overlayEntry_false.js` }); // global: OverlayEntryFalse
await page.addScriptTag({ path: `${H}/dcap.js` });               // global: DcapMod

await page.evaluate(`
  window.__bars = ${JSON.stringify(bars)};
  window.__warn = [];
  for (const k of ['warn','error','log','info','debug']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { window.__warn.push(k + ': ' + a.map(x => String(x)).join(' ')); orig(...a); };
  }
  window.__mk = () => {
    const el = document.createElement('div');
    el.style.cssText = 'width:900px;height:420px';
    document.getElementById('root').appendChild(el);
    const chart = klinecharts.init(el);
    chart.setDataLoader({ getBars: (params) => { params.callback(window.__bars, false); } });
    chart.setSymbol({ ticker: 'TEST', pricePrecision: 3, volumePrecision: 0 });
    chart.setPeriod({ span: 1, type: 'day' });
    return { el, chart };
  };
  window.__settle = () => new Promise((res) => setTimeout(res, 350));
  window.__hex = (n) => '#' + n.toString(16).padStart(6, '0');
  // returns per-canvas counts of exact-target-colour pixels (max-channel distance <= tol)
  window.__pix = (el, targets) => {
    const tg = Object.entries(targets).map(([k, v]) => {
      const n = parseInt(v.slice(1), 16);
      return [k, [(n >> 16) & 255, (n >> 8) & 255, n & 255]];
    });
    const out = [];
    for (const c of el.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const counts = {}; for (const [k] of tg) counts[k] = 0;
      const map = new Map(); let total = 0;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i+1], B = d[i+2], a = d[i+3]; total++;
        if (a > 0) { const key = (R << 16) | (G << 8) | B; map.set(key, (map.get(key) || 0) + 1); }
        for (const [k, [tr, tg2, tb]] of tg) {
          if (Math.abs(R-tr)<=tol0 && Math.abs(G-tg2)<=tol0 && Math.abs(B-tb)<=tol0) counts[k]++;
        }
      }
      const top = [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
        .map(([k,v]) => ({ color: window.__hex(k), n: v }));
      const nonBg = total - (top[0] ? top[0].n : 0);
      out.push({ css: Math.round(r.width)+'x'+Math.round(r.height), px: c.width+'x'+c.height, counts, nonBg, total, topColors: top });
    }
    return out;
  };
  window.tol0 = 28;
  window.__names = (chart, filter) => chart.getIndicators(filter).map((i) => i.name);
`);

const TARGETS = { maRed: RED, emaBlue: BLUE, dcapZero: '#76808F' };
const results = {};
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); };
const reduce = (pix) => pix.map(p => ({ px: p.px, nonBg: p.nonBg, ...p.counts, top: p.topColors.slice(0,4) }));

// ---------------------------------------------------------------- S1 trap
results.s1 = await page.evaluate(`(async () => {
  const RED_SPEC = { name: 'MA', calcParams: [5,10,20], paneId: 'candle_pane', styles: ${JSON.stringify(MA_STYLES)} };
  const BLUE_SPEC = { name: 'EMA', calcParams: [12,26], paneId: 'candle_pane', styles: ${JSON.stringify(EMA_STYLES)} };
  const r = {};
  const T = ${JSON.stringify(TARGETS)};

  // --- A) A(false) -> B(false) : the trap
  window.__warn.length = 0;
  const t = window.__mk(); await window.__settle();
  r.dataListLen = t.chart.getDataList().length;
  const idA = t.chart.createIndicator(RED_SPEC, false); await window.__settle();
  r.trapStageA = { returnedId: idA, idIsTruthy: !!idA,
    candlePaneNames: window.__names(t.chart, { paneId: 'candle_pane' }), allNames: window.__names(t.chart, {}) };
  r.trapStageAPix = window.__pix(t.el, T);
  window.__warn.length = 0;
  const idB = t.chart.createIndicator(BLUE_SPEC, false); await window.__settle();
  r.trapStageB = { returnedId: idB, idIsTruthy: !!idB,
    candlePaneNames: window.__names(t.chart, { paneId: 'candle_pane' }), allNames: window.__names(t.chart, {}),
    warningsDuringB: window.__warn.slice(), warningCount: window.__warn.length };
  r.trapStageBPix = window.__pix(t.el, T);
  r.trapCanvasCount = t.el.querySelectorAll('canvas').length;

  // --- B) counterexample A(false) -> B(true)
  const c = window.__mk(); await window.__settle();
  const idA2 = c.chart.createIndicator(RED_SPEC, false); await window.__settle();
  const idB2 = c.chart.createIndicator(BLUE_SPEC, true); await window.__settle();
  r.counter = { idA2, idB2, candlePaneNames: window.__names(c.chart, { paneId: 'candle_pane' }), allNames: window.__names(c.chart, {}) };
  r.counterPix = window.__pix(c.el, T);
  return r;
})()`);
await shot('s1_trap_and_counterexample');

// ---------------------------------------------------------------- S2 entry (real code)
results.s2 = await page.evaluate(`(async () => {
  const RED_SPEC = { name: 'MA', calcParams: [5,10,20], paneId: 'candle_pane', styles: ${JSON.stringify(MA_STYLES)} };
  const BLUE_SPEC = { name: 'EMA', calcParams: [12,26], paneId: 'candle_pane', styles: ${JSON.stringify(EMA_STYLES)} };
  const T = ${JSON.stringify(TARGETS)};
  const r = {};
  window.__warn.length = 0;
  const t = window.__mk(); await window.__settle();
  OverlayEntry.addOverlayIndicator(t.chart, RED_SPEC, 'MA'); await window.__settle();
  r.afterMA = window.__names(t.chart, { paneId: 'candle_pane' });
  OverlayEntry.addOverlayIndicator(t.chart, BLUE_SPEC, 'EMA'); await window.__settle();
  r.afterOverlay = window.__names(t.chart, { paneId: 'candle_pane' });
  r.maNonNull = t.chart.getIndicators({ name: 'MA' }).length > 0;
  r.emaNonNull = t.chart.getIndicators({ name: 'EMA' }).length > 0;
  r.coexist = r.maNonNull && r.emaNonNull;
  r.pix = window.__pix(t.el, T);
  r.warnings = window.__warn.slice();
  r.canvasCount = t.el.querySelectorAll('canvas').length;
  OverlayEntry.addOverlayIndicator(t.chart, RED_SPEC, 'MA'); await window.__settle();
  r.afterDoubleMA = window.__names(t.chart, { paneId: 'candle_pane' });
  return r;
})()`);
await shot('s2_entry_coexist');

// ---------------------------------------------------------------- S3 stub throw
results.s3 = await page.evaluate(`(async () => {
  const calls = [];
  const stub = {
    removeIndicator: (f) => { calls.push(['removeIndicator', JSON.stringify(f)]); },
    createIndicator: (s, isStack) => { calls.push(['createIndicator', JSON.stringify(s), String(isStack)]); return 'MA_stub1'; },
    getIndicators: (f) => { calls.push(['getIndicators', JSON.stringify(f)]); return []; },
  };
  const out = { threw: false, message: null, messageHasName: false };
  try { OverlayEntry.addOverlayIndicator(stub, { name: 'MA', calcParams: [5,10,20], paneId: 'candle_pane' }, 'MA'); }
  catch (e) { out.threw = true; out.message = String(e && e.message); out.messageHasName = /MA/.test(out.message); }
  out.calls = calls;
  // also verify the real "silently overridden" case: getIndicators returns only OTHER name (non-empty but not ours)
  const stub2 = { removeIndicator(){}, createIndicator(){ return 'x1'; }, getIndicators(){ return [{ name: 'EMA' }]; } };
  const out2 = { threw: false };
  try { OverlayEntry.addOverlayIndicator(stub2, { name: 'MA', paneId: 'candle_pane' }, 'MA'); } catch (e) { out2.threw = true; out2.message = String(e && e.message); }
  out.onlyOtherNameCase = out2;
  return out;
})()`);

// ---------------------------------------------------------------- S4 reverse: mutated entry = createIndicator(spec, false)
results.s4 = await page.evaluate(`(async () => {
  const RED_SPEC = { name: 'MA', calcParams: [5,10,20], paneId: 'candle_pane', styles: ${JSON.stringify(MA_STYLES)} };
  const BLUE_SPEC = { name: 'EMA', calcParams: [12,26], paneId: 'candle_pane', styles: ${JSON.stringify(EMA_STYLES)} };
  const T = ${JSON.stringify(TARGETS)};
  const r = {};
  const t = window.__mk(); await window.__settle();
  OverlayEntryFalse.addOverlayIndicator(t.chart, RED_SPEC, 'MA'); await window.__settle();
  r.afterMA = window.__names(t.chart, { paneId: 'candle_pane' });
  r.pixMA = window.__pix(t.el, T);
  let threw = null;
  try { OverlayEntryFalse.addOverlayIndicator(t.chart, BLUE_SPEC, 'EMA'); } catch (e) { threw = String(e && e.message); }
  await window.__settle();
  r.afterOverlay = window.__names(t.chart, { paneId: 'candle_pane' });
  r.maAfterOverlay = t.chart.getIndicators({ name: 'MA' }).length;
  r.emaAfterOverlay = t.chart.getIndicators({ name: 'EMA' }).length;
  r.coexist = r.maAfterOverlay > 0 && r.emaAfterOverlay > 0;
  r.throwFromEntry = threw;
  r.pixAfter = window.__pix(t.el, T);
  return r;
})()`);
await shot('s4_mutated_entry_false');

// ---------------------------------------------------------------- S5 regression: MA main + DCAP subchart
results.s5 = await page.evaluate(`(async () => {
  const T = ${JSON.stringify(TARGETS)};
  const r = {};
  DcapMod.ensureDcapIndicatorRegistered();
  const t = window.__mk(); await window.__settle();
  OverlayEntry.addOverlayIndicator(t.chart, { name: 'MA', calcParams: [5,10,20], paneId: 'candle_pane', styles: ${JSON.stringify(MA_STYLES)} }, 'MA');
  await window.__settle();
  const pixMain = window.__pix(t.el, T);
  r.mainPane = { names: window.__names(t.chart, { paneId: 'candle_pane' }), pix: pixMain };
  const idDcap = t.chart.createIndicator({ name: 'DCAP', calcParams: DcapMod.dcapCalcParams(DcapMod.DEFAULT_DCAP_PARAMS), paneId: 'dcap_pane' }, true);
  await window.__settle();
  const inds = t.chart.getIndicators({ name: 'DCAP' });
  r.dcap = {
    returnedId: idDcap, nonNull: inds.length > 0,
    precision: inds[0] ? inds[0].precision : null,
    figureKeys: inds[0] ? inds[0].figures.map((f) => f.key) : null,
    figureTitles: inds[0] ? inds[0].figures.map((f) => f.title) : null,
    zeroStyle: inds[0] && inds[0].figures.find((f) => f.key === 'zero') ? (inds[0].figures.find((f) => f.key === 'zero').style || null) : null,
    paneIdOfInstance: inds[0] ? inds[0].paneId : null,
    candleStillThere: window.__names(t.chart, { paneId: 'candle_pane' }),
  };
  r.panesPix = window.__pix(t.el, T);
  const tmpl = DcapMod.DCAP_INDICATOR_TEMPLATE;
  const params = DcapMod.dcapCalcParams(DcapMod.DEFAULT_DCAP_PARAMS);
  const out = tmpl.calc(window.__bars, { calcParams: params, figures: tmpl.figures });
  r.dcap.calcSamples = { first: out[0], mid: out[140], last: out[159],
    nullCount: out.filter(v => v.s === null).length, zeroAll: out.every(v => v.zero === 0) };
  return r;
})()`);
await shot('s5_regression_ma_dcap');

await browser.close();
for (const k of Object.keys(results)) {
  if (results[k]?.pix) results[k].pix = reduce(results[k].pix);
  if (results[k]?.trapStageAPix) results[k].trapStageAPix = reduce(results[k].trapStageAPix);
  if (results[k]?.trapStageBPix) results[k].trapStageBPix = reduce(results[k].trapStageBPix);
  if (results[k]?.counterPix) results[k].counterPix = reduce(results[k].counterPix);
  if (results[k]?.pixMA) results[k].pixMA = reduce(results[k].pixMA);
  if (results[k]?.pixAfter) results[k].pixAfter = reduce(results[k].pixAfter);
  if (results[k]?.panesPix) results[k].panesPix = reduce(results[k].panesPix);
  if (results[k]?.mainPane?.pix) results[k].mainPane.pix = reduce(results[k].mainPane.pix);
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
