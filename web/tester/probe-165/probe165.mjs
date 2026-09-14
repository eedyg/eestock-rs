/**
 * 只读根因探针 165：klinecharts 10.0.3 MA 在 candle_pane 不渲染 / 不在 getIndicators()
 * 运行：cd web && node tester/probe-165/probe165.mjs
 * 输出：tester/probe-165/evidence165.json（原始证据）+ stdout 摘要
 * 约束：0 写请求、不改仓库源码、临时端口、进程自收尾。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '../..');
const KC = path.join(WEB, 'node_modules/klinecharts/dist/index.esm.js');
const PORT = 18165;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#111;color:#ddd;font:12px monospace}
.box{width:900px;height:520px;position:relative}
</style></head><body><div id="root"></div>
<script>
window.process = { env: { NODE_ENV: 'production' } };
window.__draws={texts:[],strokes:0,fills:0};
const _ft=CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText=function(t,x,y){try{window.__draws.texts.push(String(t))}catch(e){}return _ft.apply(this,arguments)};
const _st=CanvasRenderingContext2D.prototype.stroke;
CanvasRenderingContext2D.prototype.stroke=function(){window.__draws.strokes++;return _st.apply(this,arguments)};
</script>
<script type="module">
window.__kcErr = null;
try { const m = await import('/klinecharts.js'); window.kc = m; window.__ready = true; }
catch (e) { window.__kcErr = String(e && e.stack || e); }
</script></body></html>`;

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/index')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    if (req.url === '/klinecharts.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(fs.readFileSync(KC, 'utf8'));
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => consoleMsgs.push({ type: 'pageerror', text: String(e) }));

const server = await serve();
await page.goto(`http://127.0.0.1:${PORT}/`);
try { await page.waitForFunction('window.__ready === true', null, { timeout: 15000 }); }
catch (e) { console.log('WAIT FAIL', String(e.message)); console.log('console:', JSON.stringify(consoleMsgs)); console.log('kcErr:', await page.evaluate('window.__kcErr')); await browser.close(); await new Promise(r=>server.close(r)); process.exit(1); }

const PROTECTED_NAMES = ['MA_'];

const result = await page.evaluate(async () => {
  const kc = window.kc;
  const out = [];
  let seq = 0;
  const mkBars = (n) => {
    const bars = [];
    for (let i = 0; i < n; i++) {
      const base = 100 + Math.sin(i / 7) * 5 + i * 0.1;
      bars.push({ timestamp: 1700000000000 + i * 86400000, open: base, high: base + 2, low: base - 2, close: base + (i % 3) - 1, volume: 1000 + i });
    }
    return bars;
  };
  const snap = (chart) => (chart.getIndicators() || []).map((i) => ({ name: i.name, paneId: i.paneId, id: i.id, calcParams: i.calcParams }));

  async function run(name, steps, opts = {}) {
    const box = document.createElement('div');
    box.className = 'box';
    box.id = 'box' + (seq++);
    document.getElementById('root').appendChild(box);
    const chart = kc.init(box);
    const bars = mkBars(120);
    const log = [];
    const before = window.__draws.texts.length;
    let flushed = false; const pending = [];
    chart.setDataLoader({ getBars: ({ callback }) => { if (opts.deferData && !flushed) { pending.push(callback); } else { callback(bars, false); } } });
    chart.setSymbol({ ticker: 'T', pricePrecision: 2, volumePrecision: 0 });
    chart.setPeriod({ span: 1, type: 'day' });
    if (opts.dataBefore !== false) { chart.resetData(); await new Promise((r) => setTimeout(r, 60)); }
    for (const s of steps) {
      const [arg, stack] = s;
      let ret, err = null;
      try { ret = chart.createIndicator(arg, stack); } catch (e) { err = String(e); }
      log.push({ call: JSON.stringify(arg) + ' isStack=' + stack, ret, err, indicators: snap(chart), canvases: box.querySelectorAll('canvas').length });
    }
    if (opts.dataAfter) { flushed = true; pending.forEach((cb) => cb(bars, false)); chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false) }); chart.resetData(); await new Promise((r) => setTimeout(r, 80)); }
    if (opts.gridRemoveFirst) {
      chart.removeIndicator({ name: 'MA' });
      const ret = chart.createIndicator({ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false);
      log.push({ call: 'grid-effect:removeIndicator({name:MA})+createIndicator', ret, err: null, indicators: snap(chart), canvases: box.querySelectorAll('canvas').length });
    }
    await new Promise((r) => setTimeout(r, 250));
    const texts = window.__draws.texts.slice(before);
    out.push({ scenario: name, steps: log, finalIndicators: snap(chart), canvasCount: box.querySelectorAll('canvas').length,
      drawnTexts: texts.filter((t) => /MA5|MA10|MA20|BOLL|EMA|VOL|MA60/.test(t)).slice(0, 12), drawnTextCount: texts.length,
      strokes: window.__draws.strokes });
    kc.dispose(chart);
    box.remove();
  }

  // A/B/C 单独
  await run('A: MA alone on candle_pane(isStack=false)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false]]);
  await run('B: EMA alone on candle_pane(isStack=false)', [[{ name: 'EMA', calcParams: [12, 26], paneId: 'candle_pane' }, false]]);
  await run('C: BOLL alone on candle_pane(isStack=false)', [[{ name: 'BOLL', paneId: 'candle_pane' }, false]]);
  // D/E/F/G 成对与顺序
  await run('D: MA then EMA (both candle_pane,false)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false], [{ name: 'EMA', calcParams: [12, 26], paneId: 'candle_pane' }, false]]);
  await run('E: EMA then MA (both candle_pane,false)', [[{ name: 'EMA', calcParams: [12, 26], paneId: 'candle_pane' }, false], [{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false]]);
  await run('F: MA then BOLL (both candle_pane,false)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false], [{ name: 'BOLL', paneId: 'candle_pane' }, false]]);
  await run('G: BOLL then MA (both candle_pane,false)', [[{ name: 'BOLL', paneId: 'candle_pane' }, false], [{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false]]);
  // H/I 应用真实顺序（MA 主图 + 其它 isStack 副图）
  const appTail = [['VOL', true], ['MACD', true], ['KDJ', true], ['BOLL', true]];
  await run('H: app order MA(candle_pane,false) then VOL/MACD/KDJ/BOLL(isStack=true)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false], ...appTail]);
  await run('I: app order reversed (副图先，MA 最后)', [...appTail.map((s) => [s[0], s[1]]), [{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false]]);
  await run('J: MA alone with isStack=true (no paneId)', [['MA', true]]);
  await run('K: MA duplicate twice (same name/calcParams, candle_pane,false)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false], [{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false]]);
  await run('L: MA(candle_pane,false) with isStack=true', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, true]]);
  // M: 数据在 MA 之后到达（grid 真实时序：setDataLoader 异步 → 期间先建 MA）
  await run('M: MA created BEFORE data arrives (grid timing)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false]], { dataBefore: false, dataAfter: true, deferData: true });
  await run('N: MA by string name (built-in defaults, candle_pane)', [[{ name: 'MA', paneId: 'candle_pane' }, false]]);
  await run('P: MA(candle_pane,false) then EMA(candle_pane,isStack=true)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false], [{ name: 'EMA', calcParams: [12, 26], paneId: 'candle_pane' }, true]]);
  await run('Q: MA(candle_pane,false) then EMA(candle_pane,false) then MA again', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false], [{ name: 'EMA', calcParams: [12, 26], paneId: 'candle_pane' }, false], [{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false]]);
  await run('R: MA(candle_pane,false) then EMA(string name, no paneId, isStack omitted)', [[{ name: 'MA', calcParams: [5, 10, 20], paneId: 'candle_pane' }, false], [{ name: 'EMA', paneId: 'candle_pane' }]]);
  // O: grid effect 真实次序（removeIndicator({name:MA}) + create）
  await run('O: MA alone + grid-effect removeIndicator({name:MA}) then create', [], { gridRemoveFirst: true });
  return out;
});

const payload = { ts: new Date().toISOString(), klinechartsVersion: JSON.parse(fs.readFileSync(path.join(WEB, 'node_modules/klinecharts/package.json'), 'utf8')).version, consoleMsgs, scenarios: result };
fs.writeFileSync(path.join(__dirname, 'evidence165.json'), JSON.stringify(payload, null, 2));

for (const s of result) {
  const last = s.steps[s.steps.length - 1] || {};
  console.log('\n=== ' + s.scenario);
  console.log('  final indicators: ' + JSON.stringify(s.finalIndicators));
  console.log('  canvases=' + s.canvasCount + ' drawnTexts=' + JSON.stringify(s.drawnTexts));
  for (const st of s.steps) console.log('   step ret=' + JSON.stringify(st.ret) + ' err=' + st.err + ' ind=' + JSON.stringify(st.indicators.map((i) => i.name + '@' + i.paneId)));
}
console.log('\nconsole msgs:', JSON.stringify(consoleMsgs));

await browser.close();
await new Promise((r) => server.close(r));
console.log('\nDONE; evidence -> tester/probe-165/evidence165.json');
process.exit(0);
