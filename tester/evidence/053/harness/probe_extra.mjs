/**
 * 诊断车道（tester 阶段 1）probe3 —— 补测：
 *  (a) 1m→15m 周期切换的布局重置（另一组周期）；
 *  (b) ADR-020 手动缩放（真实 wheel）后「不 remount 原地切换」是否保持手动视口（fit 不重算）。
 */
import fs from 'node:fs';
import { chromium, installRoutes, openPage, dragSeparator, writeJson } from '/tmp/diag53/lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18097';
const OUT = process.env.OUT ?? '/tmp/diag53/probe_extra.json';
const out = { base: BASE, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], klineUrls: [], wsFrames: [], checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const SNAP = () => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  if (!c) return { error: 'no chart' };
  const g = (fn) => { try { return fn(); } catch { return null; } };
  const inds = (c.getIndicators() ?? []).map((i) => ({ name: i.name, paneId: i.paneId }));
  return {
    inits: A?.inits ?? -1,
    panes: (c.getPaneOptions() ?? []).map((p) => {
      let domH = null; try { domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { /* ignore */ }
      return { id: p.id, optH: p.height, domH, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
    }),
    period: g(() => c.getPeriod()), symbol: g(() => c.getSymbol()),
    bs: g(() => c.getBarSpace()), vr: g(() => c.getVisibleRange()),
    dataLen: (c.getDataList?.() ?? []).length,
    lastTs: (c.getDataList?.() ?? []).slice(-1)[0]?.timestamp ?? null,
    fitAttr: document.querySelector('[data-testid="kline-chart"]')?.getAttribute('data-viewport-fit') ?? null,
  };
};
const heights = (s) => Object.fromEntries((s.panes ?? []).filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.domH]));
const diffs = (a, b) => { const ha = heights(a), hb = heights(b), o = {}; for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) { const x = ha[k], y = hb[k]; o[k] = { before: x ?? null, after: y ?? null, delta: x != null && y != null ? +(y - x).toFixed(2) : null }; } return o; };
const within1 = (d) => { const e = Object.entries(d); return e.length > 0 && e.every(([, v]) => v.delta != null && Math.abs(v.delta) <= 1); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });
page.on('request', (r) => { if (r.url().includes('/api/kline')) out.klineUrls.push(r.url().replace(BASE, '')); });
await installRoutes(page, out, BASE);
const snap = () => page.evaluate(SNAP);
await openPage(page, BASE);
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);

// ── (a) 1m → 15m ──
await page.getByRole('button', { name: '1m', exact: true }).click();
await page.waitForTimeout(3000);
await dragSeparator(page, 0, -150);
await dragSeparator(page, 1, -40);
const a0 = await snap();
await page.getByRole('button', { name: '15m', exact: true }).click();
await page.waitForTimeout(3000);
const a1 = await snap();
out.switch_1m_to_15m = {
  heightsBefore: heights(a0), heightsAfter: heights(a1), diffs: diffs(a0, a1), within1px: within1(diffs(a0, a1)),
  initsBefore: a0.inits, initsAfter: a1.inits, remount: a1.inits > a0.inits,
  dataReset: a0.lastTs !== a1.lastTs || a0.dataLen !== a1.dataLen,
  data: { lenBefore: a0.dataLen, lenAfter: a1.dataLen, lastBefore: a0.lastTs, lastAfter: a1.lastTs },
};
check('1m→15m：pane 高度被重置', !within1(out.switch_1m_to_15m.diffs), out.switch_1m_to_15m.diffs);
check('1m→15m：整图 remount', out.switch_1m_to_15m.remount, { before: a0.inits, after: a1.inits });
check('1m→15m：数据确实重置', out.switch_1m_to_15m.dataReset, out.switch_1m_to_15m.data);

// ── (b) ADR-020：真实 wheel 手动缩放 → 不 remount 原地切换 ──
const box = await page.locator('[data-testid="kline-chart"]').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -900);
await page.waitForTimeout(900);
const z0 = await snap();
out.manual_zoom = { bsBefore: a1.bs, bsAfterWheel: z0.bs, visibleBefore: a1.vr ? a1.vr.to - a1.vr.from : null, visibleAfterWheel: z0.vr ? z0.vr.to - z0.vr.from : null, fitAttr: z0.fitAttr };
check('真实 wheel 改变了 barSpace（手动视口态）', z0.bs?.bar !== a1.bs?.bar, out.manual_zoom);

// 不 remount 原地切换到 1h（自定义 loader，不调用 fitBarSpace）
await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TARGET = { code: '161226', period: '1h', kc: { type: 'hour', span: 1 } };
  window.__TARGET__ = TARGET;
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const loader = {
    getBars: async ({ callback }) => {
      const r = await fetch(`/api/kline?code=${TARGET.code}&period=${TARGET.period}&limit=120`);
      const j = await r.json();
      callback(j.bars.map((b) => ({ timestamp: Date.parse(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, turnover: b.amount })), { forward: false, backward: false });
    },
    subscribeBar: () => {}, unsubscribeBar: () => {},
  };
  c.setDataLoader(loader); c.setSymbol({ ticker: TARGET.code, pricePrecision: 3, volumePrecision: 0 }); c.setPeriod(TARGET.kc); c.resetData();
  await sleep(1800);
});
const z1 = await snap();
out.manual_zoom.afterNoRemountSwitch = { bs: z1.bs, visible: z1.vr ? z1.vr.to - z1.vr.from : null, fitAttr: z1.fitAttr, heights: heights(z1), inits: z1.inits, symbol: z1.symbol, period: z1.period };
out.manual_zoom.switchKeptManualViewport = z1.bs?.bar === z0.bs?.bar;
check('不 remount 切换后手动 barSpace 被保持（fit 不重算）', out.manual_zoom.switchKeptManualViewport, out.manual_zoom);

out.pageErrors = pageErrors;
writeJson(OUT, out);
const pass = out.checks.filter((c) => c.ok).length;
console.log(`checks: ${pass}/${out.checks.length} passed`);
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} :: ${JSON.stringify(c.detail).slice(0, 400)}`);
console.log('switch_1m_to_15m:', JSON.stringify(out.switch_1m_to_15m, null, 1));
console.log('manual_zoom:', JSON.stringify(out.manual_zoom, null, 1));
console.log('klineUrls:', JSON.stringify(out.klineUrls));
console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 10)));
console.log('OUT=' + OUT);
await browser.close();
