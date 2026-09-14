/**
 * 只读诊断（tester 053）probe3：
 *  Phase A：不作任何交互，观测 followLatest（回到最新 按钮）是否自发翻转 + 新 bar 是否可见追加。
 *  Phase B：网络离线 ~12s 再恢复 → 检验 WS 重连后是否重新订阅、bar 是否恢复。
 *  Phase C：恢复后继续观测。
 */
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.js';
const { chromium } = pw;

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18099';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await ctx.newPage();
const sent = [], recv = [];
page.on('websocket', (ws) => {
  log('WS OPEN', ws.url());
  ws.on('framesent', (f) => { sent.push({ t: Date.now(), s: String(f.payload) }); });
  ws.on('framereceived', (f) => { recv.push({ t: Date.now(), s: String(f.payload) }); });
  ws.on('close', () => log('WS CLOSE'));
});
page.on('pageerror', (e) => log('PAGEERR', String(e).slice(0, 150)));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const chart = page.locator('[data-testid="kline-chart"]');
await chart.waitFor({ state: 'visible', timeout: 30000 });
await page.waitForTimeout(2500);
const periodBtn = page.locator('[data-region="toolbar"]').getByRole('button', { name: '1m', exact: true });
await periodBtn.click();
await page.waitForTimeout(3000);

const backBtn = page.locator('[data-region="toolbar"]').getByRole('button', { name: '回到最新', exact: true });
const snap = async () => {
  const followDisabled = await backBtn.isDisabled();
  const s = await page.evaluate(() => {
    const marker = document.querySelector('[data-realtime-marker]');
    const el = document.querySelector('[data-testid="kline-chart"]');
    const cs = Array.from(el.querySelectorAll('canvas'));
    return {
      marker: marker ? marker.textContent : null,
      markerLeft: marker ? Math.round(marker.getBoundingClientRect().left) : null,
      chartW: Math.round(el.getBoundingClientRect().width),
      hash: cs.map((c) => c.toDataURL().slice(-20)).join('|'),
    };
  });
  return { ...s, followDisabled, bars: recv.filter((r) => r.s.includes('"type":"bar"')).length };
};

const tick = async (phase, t0) => {
  const s = await snap();
  const last = recv.filter((r) => r.s.includes('"type":"bar"')).at(-1);
  const lb = last ? JSON.parse(last.s) : null;
  log(`${phase} T+${((Date.now() - t0) / 1000).toFixed(0)}s 回到最新disabled(follow=${s.followDisabled}) ` +
      `marker=${JSON.stringify(s.marker)} x=${s.markerLeft}/${s.chartW} barsRecv=${s.bars}` +
      (lb ? ` lastBarTs=${lb.bar?.ts}` : ''));
  return s;
};

log('### Phase A: 无任何交互（观察 followLatest 是否自发翻转）');
const tA = Date.now();
while ((Date.now() - tA) / 1000 < 95) { await tick('A', tA); await page.waitForTimeout(4000); }

log('### Phase B: 离线 12s → 在线（检验重连后是否重新 subscribe）');
await ctx.setOffline(true);
await page.waitForTimeout(12000);
await ctx.setOffline(false);
const tB = Date.now();
for (let i = 0; i < 8; i++) { await tick('B', tB); await page.waitForTimeout(4000); }

log('### Phase C: 恢复后再观测 70s');
const tC = Date.now();
while ((Date.now() - tC) / 1000 < 70) { await tick('C', tC); await page.waitForTimeout(4000); }

log('=== SENT frames (subscribe/unsubscribe 时序) ===');
for (const s of sent) log('  ', new Date(s.t).toISOString().slice(11, 23), s.s.slice(0, 140));
log('=== BAR frames ===');
for (const r of recv.filter((x) => x.s.includes('"type":"bar"'))) log('  ', new Date(r.t).toISOString().slice(11, 23), r.s.slice(0, 170));
await page.screenshot({ path: '/tmp/kl_diag/logs/probe3_final.png' });
await browser.close();
