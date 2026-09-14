/**
 * 只读诊断（tester 053）：真实浏览器观测「WS 帧 → K 线图是否追加新 bar」。
 * 目标实例：临时端口 18099（只读库连接）。不改仓库文件；脚本与产物都在 /tmp。
 * 用法：node /tmp/kl_diag/fe_probe.mjs [seconds]
 */
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.js';
const { chromium } = pw;

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18099';
const DUR_S = Number(process.argv[2] ?? 200);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });

const sent = [];
const recv = [];
page.on('websocket', (ws) => {
  log('WS OPEN', ws.url());
  ws.on('framesent', (f) => { const s = String(f.payload); sent.push({ t: Date.now(), s }); log('WS SENT', s.slice(0, 160)); });
  ws.on('framereceived', (f) => { const s = String(f.payload); recv.push({ t: Date.now(), s }); log('WS RECV', s.slice(0, 220)); });
  ws.on('close', () => log('WS CLOSE'));
});
page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE-ERR', m.text().slice(0, 200)); });
page.on('pageerror', (e) => log('PAGEERR', String(e).slice(0, 200)));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const chart = page.locator('[data-testid="kline-chart"]');
await chart.waitFor({ state: 'visible', timeout: 30000 });
await page.waitForTimeout(2500);

// 选中标的 + 周期（只做导航点击，无写操作）
const code = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
log('selected symbol =', code);
const periodBtn = page.locator('[data-region="toolbar"]').getByRole('button', { name: '1m', exact: true });
await periodBtn.click();
await page.waitForTimeout(2500);
log('period=1m active =', await periodBtn.getAttribute('aria-pressed'));

const klineBars = () => page.evaluate(() => {
  // 从图上的实时标记 + canvas 指纹观测「是否发生追加/更新」
  const marker = document.querySelector('[data-realtime-marker]');
  const cs = Array.from(document.querySelectorAll('[data-testid="kline-chart"] canvas'));
  const hashes = cs.map((c) => c.toDataURL().length + ':' + c.toDataURL().slice(-24));
  return {
    marker: marker ? marker.textContent : null,
    canvases: cs.length,
    hash: hashes.join('|'),
  };
});

const t0 = Date.now();
let prev = null;
while ((Date.now() - t0) / 1000 < DUR_S) {
  const snap = await klineBars();
  const same = prev && prev.hash === snap.hash;
  const barRecv = recv.filter((r) => r.s.includes('"type":"bar"'));
  const lastBar = barRecv.length ? JSON.parse(barRecv[barRecv.length - 1].s) : null;
  log(`T+${((Date.now() - t0) / 1000).toFixed(0)}s marker=${JSON.stringify(snap.marker)} canvases=${snap.canvases} ` +
      `hashChanged=${prev ? !same : 'n/a'} barsRecv=${barRecv.length} ` +
      (lastBar ? `lastBarTs=${lastBar.bar?.ts} close=${lastBar.bar?.close} code=${lastBar.code} period=${lastBar.period}` : ''));
  prev = snap;
  await page.waitForTimeout(5000);
}

log('=== SUMMARY ===');
log('sent frames:', sent.length);
for (const s of sent) log('  SENT', s.s.slice(0, 200));
log('recv frames:', recv.length, 'of which bar:', recv.filter((r) => r.s.includes('"type":"bar"')).length);
for (const r of recv) log('  RECV', new Date(r.t).toISOString().slice(11, 23), r.s.slice(0, 220));
await page.screenshot({ path: '/tmp/kl_diag/logs/fe_probe_final.png' });
await browser.close();
