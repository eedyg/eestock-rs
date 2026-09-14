/** 068 聚焦：(b) 有新数据提示（缩放至最新 bar 屏外）+ (c) 幂等（字段完整帧重放） */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = '/tmp/acc4x/out';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const reqs = [];
p.on('request', (r) => { reqs.push(r.method() + ' ' + r.url()); });
await p.route('**/api/**', async (r) => {
  if (r.request().method() !== 'GET') { await r.abort(); return; }
  const u = new URL(r.request().url());
  try { await r.fulfill({ response: await r.fetch({ url: 'http://127.0.0.1:8081' + u.pathname + u.search }) }); }
  catch { await r.fulfill({ status: 599, body: '' }); }
});
await p.goto('http://127.0.0.1:18441/?code=518880&period=15m&bars=120', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0, null, { timeout: 30000 });
await new Promise(r => setTimeout(r, 800));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const snap = () => p.evaluate(() => {
  const H = window.__H__; const c = window.__ACC__.charts.find(Boolean);
  const r = c.getVisibleRange();
  const w = document.querySelector('[data-testid="kline-chart"]').clientWidth;
  return { follow: H.follow(), len: H.dataLen(), rt: H.rtCount(), last: H.lastBar()?.ts,
    xLast: (() => { try { const px = c.convertToPixel({ timestamp: H.lastBar()?.ts }, { paneId: 'candle_pane' }); return px ? Math.round(px.x) : null; } catch { return 'ERR'; } })(),
    width: w, range: { from: r.from, to: r.to, realFrom: r.realFrom, realTo: r.realTo },
    hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') };
});
// 放大（不平移）：鼠标停在右侧，让最新 bar 跑到屏外
const box = await p.locator('[data-testid="kline-chart"] canvas').first().boundingBox();
await p.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.4);
for (let i = 0; i < 3; i++) { await p.mouse.wheel(0, -500); await sleep(350); }
await sleep(400);
const zoomed = await snap();
const result = { zoomed, steps: [] };

// (b) 前置条件：最新 bar 像素 x 必须 > 容器宽（屏外）
result.preconditionOk = zoomed.xLast !== null && zoomed.xLast > zoomed.width;
// 注入新 bar（字段完整 = 线上真实 bar 展开 + 新 ts）
const injected = await p.evaluate(async () => {
  const H = window.__H__;
  const last = H.bars().at(-1);
  const nextTs = new Date(Date.parse(last.ts) + 15 * 60 * 1000).toISOString();
  const newBar = { ...last, ts: nextTs, close: Number(last.close) + 0.5 };
  const before = { len: H.dataLen(), rt: H.rtCount(), hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') };
  H.inject({ type: 'bar', code: '518880', period: '15m', bar: newBar });
  await new Promise(r => setTimeout(r, 1000));
  return { before, after: { len: H.dataLen(), rt: H.rtCount(), last: H.lastBar()?.ts, hint: !!document.querySelector('[data-testid="kline-new-data-hint"]') } };
});
await sleep(600);
const afterNew = await snap();
result.afterNew = afterNew;
result.injected = injected;
result.hintVisible = await p.locator('[data-testid="kline-new-data-hint"]').isVisible().catch(() => false);
await p.screenshot({ path: OUT + '/05_hint_new_bar.png' });
if (result.hintVisible) {
  await p.locator('[data-testid="kline-new-data-hint"]').click();
  await sleep(1000);
  const afterClick = await snap();
  result.afterClick = afterClick;
  result.hintGoneAfterClick = !afterClick.hint;
  result.jumpedToLatest = afterClick.xLast !== null && afterClick.xLast <= afterClick.width;
  await p.screenshot({ path: OUT + '/06_after_click.png' });
}
// (c) 幂等：字段完整帧重放
result.idempotency = await p.evaluate(async () => {
  const H = window.__H__;
  const barsKey = () => H.bars().map(x => `${x.ts}|${x.open}|${x.high}|${x.low}|${x.close}|${x.volume}|${x.amount}`).join(';');
  const out = {};
  // 1) 真实顺序 HTTP 兜底两次（同一窗口重复取回）
  const l0 = H.dataLen(), r0 = H.rtCount(); const k0 = barsKey();
  await H.pollNow(); await H.pollNow();
  await new Promise(r => setTimeout(r, 900));
  out.realPollTwice = { len: [l0, H.dataLen()], rt: [r0, H.rtCount()], digestSame: k0 === barsKey() };
  // 2) 重放「已存在且字段完整」的最后一根（同 ts 同 OHLCV+amount）⇒ 应 ignore（不写、不 emit）
  const last = H.bars().at(-1);
  const l1 = H.dataLen(), r1 = H.rtCount(); const k1 = barsKey();
  H.inject({ type: 'bar', code: '518880', period: '15m', bar: { ...last } });
  await new Promise(r => setTimeout(r, 500));
  out.replayFullExistingBar = { len: [l1, H.dataLen()], rt: [r1, H.rtCount()], digestSame: k1 === barsKey() };
  // 3) 同一根「新 ts」bar 连发 3 次 ⇒ 只追加 1 根、只 emit 1 次
  const l2 = H.dataLen(), r2 = H.rtCount();
  const nb = { ...last, ts: new Date(Date.parse(last.ts) + 15 * 60 * 1000).toISOString(), close: Number(last.close) + 1 };
  H.inject({ type: 'bar', code: '518880', period: '15m', bar: nb });
  H.inject({ type: 'bar', code: '518880', period: '15m', bar: nb });
  H.inject({ type: 'bar', code: '518880', period: '15m', bar: nb });
  await new Promise(r => setTimeout(r, 700));
  out.sameNewBarThrice = { appended: H.dataLen() - l2, emitted: H.rtCount() - r2, len: H.dataLen(), rt: H.rtCount() };
  return out;
});
result.stats = await p.evaluate(() => window.__H__.stats());
result.requests = reqs.filter(u => u.includes('/api/kline'));
result.nonGet = reqs.filter(u => !u.startsWith('GET')).length;
fs.writeFileSync(OUT + '/focus_bc.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
await b.close();
