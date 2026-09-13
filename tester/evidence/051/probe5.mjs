/**
 * 诊断车道（tester 阶段 1）probe5 —— 路径 B（整图 remount）的**完整调用序列**取证。
 * 只跑一个场景：DCAP 开 → 拖高 → 保存 m（warmup = n_l+m−1 变化）→ 记录 init 次数与全量调用序列
 * （probe3 的 logTail 只留 30 条，setDataLoader 落在窗口外 ⇒ 本条补全）。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
const { chromium } = require('@playwright/test');
const BASE = process.env.BASE ?? 'http://127.0.0.1:18085';
const out = { base: BASE };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const puts = [];
await page.route('**/*', async (route, req) => {
  if (req.method() === 'GET') return route.continue();
  if (req.method() === 'PUT' && req.url().includes('/api/config/dcap')) {
    puts.push(req.postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: req.postData() ?? '' });
  }
  return route.abort();
});
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 40000 });
await page.waitForTimeout(4000);
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2200);
const snap = () => page.evaluate(() => {
  const cs = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = cs[cs.length - 1];
  return {
    inits: window.__KC_INITS__, logLen: window.__KC_LOG__.length,
    panes: c.getPaneOptions().map((p) => { let dom = null; try { dom = +c.getDom(p.id).getBoundingClientRect().height.toFixed(1); } catch {} return { id: p.id, optH: p.height, domH: dom, ind: c.getIndicators({ paneId: p.id }).map((i) => i.name).join('+') }; }),
  };
});
const before = await snap();
await page.getByRole('button', { name: 'DCAP 配置' }).click();
await page.waitForSelector('[data-dcap-editor]');
await page.fill('[data-testid="dcap-input-m"]', '5');
await page.locator('[data-dcap-editor] button:has-text("保存")').click();
await page.waitForTimeout(3000);
const after = await snap();
const seq = await page.evaluate((from) => (window.__KC_LOG__ ?? []).slice(from).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 90) })), before.logLen);
out.before = before; out.after = after; out.seq = seq; out.puts = puts;
out.putInterceptedOnly = { putCount: puts.length, upstreamWrites: 0 };
fs.writeFileSync('/tmp/diag51/probe5.json', JSON.stringify(out, null, 1));
console.log('inits', before.inits, '→', after.inits);
console.log('panes before:', JSON.stringify(before.panes));
console.log('panes after :', JSON.stringify(after.panes));
console.log('seq:', JSON.stringify(seq));
console.log('puts:', JSON.stringify(puts));
await browser.close();
