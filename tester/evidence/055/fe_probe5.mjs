/**
 * 只读诊断（tester 053）probe5：半开/静默失联的 WS —— 客户端是否察觉？是否重连？
 * 并检验「切 Tab（分时↔K线）」是否能救活实时流（对照：HTTP 重载能补上数据）。
 */
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.js';
const { chromium } = pw;
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18099';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await ctx.newPage();
let opens = 0, closes = 0;
page.on('websocket', (ws) => { opens++; log('WS OPEN #' + opens, ws.url()); ws.on('close', () => { closes++; log('WS CLOSE #' + closes); }); ws.on('framereceived', (f) => { const s = String(f.payload); if (s.includes('"type":"bar"')) barFrames.push({ t: Date.now(), s }); }); });
const barFrames = [];
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="kline-chart"]').waitFor({ state: 'visible', timeout: 30000 });
await page.waitForTimeout(1500);
await page.locator('[data-region="toolbar"]').getByRole('button', { name: '1m', exact: true }).click();
await page.waitForTimeout(1500);
const pill = () => page.evaluate(() => {
  const t = document.querySelector('header[data-region="topbar"]')?.textContent ?? '';
  return /WS 连接中|WS 断开/.test(t) ? t.match(/WS [^…]*…?/)?.[0] : '(无 WS 异常 pill = 显示已连接)';
});
const state = async (tag) => log(`${tag} pill=${await pill()} barFrames=${barFrames.length} ` +
  `marker=${await page.locator('[data-realtime-marker]').count() ? await page.locator('[data-realtime-marker]').innerText() : null}`);

log('=== 1) 正常态 ===');
const t0 = Date.now();
while (barFrames.length < 2 && Date.now() - t0 < 100000) await page.waitForTimeout(1000);
await state('正常');

log('=== 2) 离线 12s → 在线 ===');
await ctx.setOffline(true); await page.waitForTimeout(12000); await ctx.setOffline(false);
log('network back online');

log('=== 3) 恢复后观察 100s（是否重连/是否有帧）===');
const t1 = Date.now();
while (Date.now() - t1 < 100000) { await state('恢复中'); await page.waitForTimeout(10000); }

log('=== 4) 切 Tab：分时 → K线（切周期/标的 之外的另一条 UI 路径）===');
await page.locator('[data-region="toolbar"]').getByRole('button', { name: '分时', exact: true }).click();
await page.waitForTimeout(3000);
await page.locator('[data-region="toolbar"]').getByRole('button', { name: 'K线', exact: true }).click();
await page.waitForTimeout(3000);
const t2 = Date.now();
while (Date.now() - t2 < 60000) { await state('切Tab后'); await page.waitForTimeout(10000); }
log(`TOTAL: websocket opens=${opens} closes=${closes} barFrames=${barFrames.length}`);
for (const b of barFrames) log('  BAR', new Date(b.t).toISOString().slice(11, 23), JSON.parse(b.s).bar?.ts);
await page.screenshot({ path: '/tmp/kl_diag/logs/probe5_final.png' });
await browser.close();
