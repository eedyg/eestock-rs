/**
 * 只读诊断（tester 053）probe4：几何测量 —— 新 bar（实时标记 x）到底在不在可见绘图区内？
 *   A 段：默认跟随态（followLatest=true，无交互）收到新 bar 后测量。
 *   B 段：手动缩放/平移（followLatest=false）后再收到新 bar 后测量。
 * 产出：容器/画布 rect、data-viewport-fit（barSpace/可见根数）、rt.x 相对画布左边、是否越界。
 */
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.js';
const { chromium } = pw;

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18099';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const recv = [];
page.on('websocket', (ws) => ws.on('framereceived', (f) => recv.push({ t: Date.now(), s: String(f.payload) })));

const geom = () => page.evaluate(() => {
  const el = document.querySelector('[data-testid="kline-chart"]');
  const r = el.getBoundingClientRect();
  const cs = Array.from(el.querySelectorAll('canvas'));
  const main = cs.find((c) => c.width > 200 && c.height > 300);
  const mr = main ? main.getBoundingClientRect() : null;
  const marker = document.querySelector('[data-realtime-marker]');
  const mk = marker ? marker.getBoundingClientRect() : null;
  return {
    container: { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) },
    mainCanvas: mr ? { left: Math.round(mr.left), right: Math.round(mr.right), w: Math.round(mr.width), pxW: main.width } : null,
    fit: el.getAttribute('data-viewport-fit'),
    marker: marker ? mk.textContent : null,
    markerLeft: mk ? Math.round(mk.left) : null,
    // 相对主画布左边缘的 x（= 引擎 convertToPixel 口径 +2px）
    rtX: mk && mr ? Math.round(mk.left - mr.left) : null,
  };
});

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="kline-chart"]').waitFor({ state: 'visible', timeout: 30000 });
await page.waitForTimeout(2000);
await page.locator('[data-region="toolbar"]').getByRole('button', { name: '1m', exact: true }).click();
await page.waitForTimeout(2000);

const backBtn = page.locator('[data-region="toolbar"]').getByRole('button', { name: '回到最新', exact: true });
const lastBar = () => {
  const r = recv.filter((x) => x.s.includes('"type":"bar"')).at(-1);
  return r ? JSON.parse(r.s) : null;
};
const barCount = () => recv.filter((x) => x.s.includes('"type":"bar"')).length;
const waitPush = async (afterCount, ms = 100000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (barCount() > afterCount) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

log('### A 段：跟随态（无交互）');
log('A 等待首帧…', await waitPush(0));
await page.waitForTimeout(1500);
log('A 收到 bar:', JSON.stringify(lastBar()?.bar?.ts), 'follow(回到最新 disabled)=', await backBtn.isDisabled());
log('A 几何:', JSON.stringify(await geom()));
await page.screenshot({ path: '/tmp/kl_diag/logs/probe4_A_follow.png' });

const box = await page.locator('[data-testid="kline-chart"]').boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.keyboard.down('Control');
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
await page.keyboard.up('Control');
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
await page.mouse.down();
for (let i = 0; i < 30; i++) { await page.mouse.move(box.x + box.width * 0.2 + i * 20, box.y + box.height * 0.5); await page.waitForTimeout(6); }
await page.mouse.up();
await page.waitForTimeout(1200);

log('### B 段：手动缩放/平移后（followLatest=false）');
log('B 等待缩放后的新 bar 帧…', await waitPush(barCount()));
await page.waitForTimeout(1500);
log('B 收到 bar:', JSON.stringify(lastBar()?.bar?.ts), 'follow(回到最新 enabled)=', await backBtn.isEnabled());
const gB = await geom();
log('B 几何:', JSON.stringify(gB));
await page.screenshot({ path: '/tmp/kl_diag/logs/probe4_B_manual.png' });

log('### B2：点「回到最新」后（scrollToRealTime 是否把新 bar 带回可见区）');
await backBtn.click();
await page.waitForTimeout(1500);
log('B2 几何:', JSON.stringify(await geom()));
await page.screenshot({ path: '/tmp/kl_diag/logs/probe4_B2_back.png' });

log('=== bar frames ===');
for (const r of recv.filter((x) => x.s.includes('"type":"bar"'))) log('  ', new Date(r.t).toISOString().slice(11, 23), r.s.slice(0, 170));
await browser.close();
