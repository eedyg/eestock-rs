/**
 * 只读诊断（tester 053）probe2：手动缩放/平移（followLatest=false）后，新 bar 是否仍「追加」但不可见？
 * 采样：marker 文本/left px、容器宽、canvas 指纹、可见蜡烛列数（像素扫描）。
 */
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.js';
const { chromium } = pw;

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18099';
const DUR_S = Number(process.argv[2] ?? 200);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const recv = [];
page.on('websocket', (ws) => ws.on('framereceived', (f) => recv.push({ t: Date.now(), s: String(f.payload) })));
page.on('pageerror', (e) => log('PAGEERR', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE-ERR', m.text().slice(0, 200)); });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const chart = page.locator('[data-testid="kline-chart"]');
await chart.waitFor({ state: 'visible', timeout: 30000 });
await page.waitForTimeout(2500);
const periodBtn = page.locator('[data-region="toolbar"]').getByRole('button', { name: '1m', exact: true });
await periodBtn.click();
await page.waitForTimeout(2500);

const snap = () => page.evaluate(() => {
  const marker = document.querySelector('[data-realtime-marker]');
  const el = document.querySelector('[data-testid="kline-chart"]');
  const cs = Array.from(el.querySelectorAll('canvas'));
  const main = cs.find((c) => c.width > 200 && c.height > 300);
  let cols = -1;
  if (main) {
    const ctx = main.getContext('2d');
    const img = ctx.getImageData(0, 0, main.width, main.height).data;
    const y0 = Math.floor(main.height * 0.15), y1 = Math.floor(main.height * 0.8);
    cols = 0; let inCol = false;
    for (let x = 0; x < Math.floor(main.width * 0.95); x++) {
      let has = false;
      for (let y = y0; y < y1; y += 2) {
        const i = (y * main.width + x) * 4;
        if (img[i] > 90 || img[i + 1] > 90 || img[i + 2] > 90) { has = true; break; }
      }
      if (has && !inCol) { cols++; inCol = true; } else if (!has) inCol = false;
    }
  }
  return {
    marker: marker ? marker.textContent : null,
    markerLeft: marker ? Math.round(marker.getBoundingClientRect().left) : null,
    chartW: Math.round(el.getBoundingClientRect().width),
    candles: cols,
    hash: cs.map((c) => c.toDataURL().slice(-20)).join('|'),
  };
});

const backBtn = page.locator('[data-region="toolbar"]').getByRole('button', { name: '回到最新', exact: true });
log('before manual zoom: followLatest disabled(回到最新 disabled)=', await backBtn.isDisabled());

// —— 手动缩放 + 平移（user gesture）——
const box = await chart.boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.keyboard.down('Control');
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
await page.keyboard.up('Control');
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
await page.mouse.down();
for (let i = 0; i < 30; i++) { await page.mouse.move(box.x + box.width * 0.2 + i * 20, box.y + box.height * 0.5); await page.waitForTimeout(6); }
await page.mouse.up();
await page.waitForTimeout(1500);
log('after manual zoom/pan: 回到最新 enabled=', await backBtn.isEnabled(), '(true ⇒ followLatest=false)');

const t0 = Date.now();
let prev = null;
while ((Date.now() - t0) / 1000 < DUR_S) {
  const s = await snap();
  const bf = recv.filter((r) => r.s.includes('"type":"bar"'));
  const last = bf.length ? JSON.parse(bf[bf.length - 1].s) : null;
  const canvasChanged = prev ? prev.hash !== s.hash : null;
  const markerChanged = prev ? prev.marker !== s.marker : null;
  log(`T+${((Date.now() - t0) / 1000).toFixed(0)}s marker=${JSON.stringify(s.marker)} markerLeftPx=${s.markerLeft}/${s.chartW} ` +
      `candles=${s.candles} canvasChanged=${canvasChanged} markerChanged=${markerChanged} barsRecv=${bf.length}` +
      (last ? ` lastBarTs=${last.bar?.ts} close=${last.bar?.close}` : ''));
  prev = s;
  await page.waitForTimeout(4000);
}
await page.screenshot({ path: '/tmp/kl_diag/logs/probe2_final.png' });
log('=== BAR FRAMES ===');
for (const r of recv.filter((x) => x.s.includes('"type":"bar"'))) log('  ', new Date(r.t).toISOString().slice(11, 23), r.s.slice(0, 200));
await browser.close();
