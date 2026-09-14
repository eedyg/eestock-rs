/**
 * 诊断车道（tester 阶段 1）probe4 —— 触发点依赖面：viewportBars（配置读取/focus 重读）变化是否也会
 * 重建 feed ⇒ 整图 remount ⇒ 布局重置（与 period/code 同一类）。只读代理线上 8081；/api/config/kline 的
 * GET 在浏览器侧被替换为受控值（不发往后端），用来制造 viewport_bars 变化。
 */
import fs from 'node:fs';
import { chromium, openPage, dragSeparator, writeJson } from '/tmp/diag53/lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18097';
const OUT = process.env.OUT ?? '/tmp/diag53/probe_viewport.json';
const out = { base: BASE, t0: new Date().toISOString(), scenarios: {}, checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const SNAP = () => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  if (!c) return { error: 'no chart' };
  const inds = (c.getIndicators() ?? []).map((i) => ({ name: i.name, paneId: i.paneId }));
  return {
    inits: A?.inits ?? -1,
    panes: (c.getPaneOptions() ?? []).map((p) => {
      let domH = null; try { domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { /* ignore */ }
      return { id: p.id, optH: p.height, domH, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
    }),
    bs: (() => { try { return c.getBarSpace(); } catch { return null; } })(),
    fitAttr: document.querySelector('[data-testid="kline-chart"]')?.getAttribute('data-viewport-fit') ?? null,
  };
};
const heights = (s) => Object.fromEntries((s.panes ?? []).filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.domH]));
const diffs = (a, b) => { const ha = heights(a), hb = heights(b), o = {}; for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) { const x = ha[k], y = hb[k]; o[k] = { before: x ?? null, after: y ?? null, delta: x != null && y != null ? +(y - x).toFixed(2) : null }; } return o; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
// 受控 /api/config/kline：首次 120（mount），之后 200（模拟 focus 重读拿到新配置）
let klineCfgCalls = 0;
await page.route('**/api/config/kline', async (route, req) => {
  if (req.method() !== 'GET') { out.nonGetOther = (out.nonGetOther ?? []).concat(`${req.method()} ${req.url()}`); await route.abort(); return; }
  klineCfgCalls++;
  const v = klineCfgCalls === 1 ? 120 : 200;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ viewport_bars: v }) });
});
// 其余非 GET 一律拦截；GET 继续（会被代理到 8081 只读）
await page.route('**/*', async (route, req) => {
  const m = req.method();
  if (m === 'GET' || req.url().includes('/api/config/kline')) { await route.fallback().catch(() => route.continue()); return; }
  out.nonGetOther = (out.nonGetOther ?? []).concat(`${m} ${req.url()}`);
  await route.abort();
});
const snap = () => page.evaluate(SNAP);
await openPage(page, BASE);
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
await dragSeparator(page, 0, -150);
await dragSeparator(page, 1, -40);
const v0 = await snap();
out.scenarios.before = { heights: heights(v0), inits: v0.inits, bs: v0.bs, fitAttr: v0.fitAttr, klineCfgCalls };

// 模拟 window focus 重读配置（返回 200 ≠ 120）
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForTimeout(3500);
const v1 = await snap();
out.scenarios.afterFocusReread = { heights: heights(v1), ids: Object.fromEntries(v1.panes.filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.id])), inits: v1.inits, bs: v1.bs, fitAttr: v1.fitAttr, klineCfgCalls };
out.diffs = diffs(v0, v1);
out.remount = v1.inits > v0.inits;
check('viewportBars 变化（focus 重读拿到新配置）也触发整图 remount', out.remount, { initsBefore: v0.inits, initsAfter: v1.inits, klineCfgCalls });
check('viewportBars 变化导致 pane 高度被重置', Object.values(out.diffs).some((d) => d.delta != null && Math.abs(d.delta) > 1), out.diffs);
check('新 viewportBars 生效（fit 属性变 200）', (v1.fitAttr ?? '').includes('"bars":200'), { before: v0.fitAttr, after: v1.fitAttr });

out.pageErrors = pageErrors;
writeJson(OUT, out);
const pass = out.checks.filter((c) => c.ok).length;
console.log(`checks: ${pass}/${out.checks.length} passed`);
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} :: ${JSON.stringify(c.detail).slice(0, 400)}`);
console.log('scenarios:', JSON.stringify(out.scenarios, null, 1));
console.log('diffs:', JSON.stringify(out.diffs));
console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 10)));
console.log('OUT=' + OUT);
await browser.close();
