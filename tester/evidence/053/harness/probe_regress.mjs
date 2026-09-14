/**
 * 诊断车道（tester 阶段 1）probe2 —— 回归风险面（ADR-020 视口 / WS / overlay / warmup 取数 / 备选回放）。
 * 真实 klinecharts@10.0.3 + 真实 KlineChart/DashboardPage；临时端口 18097 只读代理线上 8081。
 */
import fs from 'node:fs';
import { chromium, installRoutes, openPage, dragSeparator, readLog, writeJson } from '/tmp/diag53/lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18097';
const OUT = process.env.OUT ?? '/tmp/diag53/probe_regress.json';
const EV = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/053';
fs.mkdirSync(EV, { recursive: true });

const out = { base: BASE, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], klineUrls: [], wsFrames: [], checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const SNAP = () => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  if (!c) return { error: 'no chart' };
  const g = (fn) => { try { return fn(); } catch { return null; } };
  const inds = (c.getIndicators() ?? []).map((i) => ({ name: i.name, paneId: i.paneId }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let domH = null;
    try { domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { /* ignore */ }
    return { id: p.id, optH: p.height, domH, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
  });
  const dom = document.querySelector('[data-testid="kline-chart"]');
  return {
    inits: A?.inits ?? -1,
    logLen: A?.log?.length ?? -1,
    panes, symbol: g(() => c.getSymbol()), period: g(() => c.getPeriod()),
    vr: g(() => c.getVisibleRange()), bs: g(() => c.getBarSpace()), offsetRight: g(() => c.getOffsetRightDistance()),
    dataLen: (c.getDataList?.() ?? []).length,
    fitAttr: dom?.getAttribute('data-viewport-fit') ?? null,
    overlayCount: g(() => (c.getOverlays() ?? []).length),
  };
};
const heights = (s) => Object.fromEntries((s.panes ?? []).filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.domH]));
const diffs = (a, b) => {
  const ha = heights(a), hb = heights(b), o = {};
  for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) { const x = ha[k], y = hb[k]; o[k] = { before: x ?? null, after: y ?? null, delta: x != null && y != null ? +(y - x).toFixed(2) : null }; }
  return o;
};
const visibleBars = (s) => (s.vr ? s.vr.to - s.vr.from : null);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });
page.on('request', (r) => { if (r.url().includes('/api/kline')) out.klineUrls.push({ t: Date.now(), url: r.url().replace(BASE, '') }); });
page.on('websocket', (ws) => {
  const rec = { url: ws.url(), sent: [], received: 0 };
  ws.on('framesent', (f) => rec.sent.push(String(f.payload).slice(0, 200)));
  ws.on('framereceived', () => { rec.received++; });
  out.wsFrames.push(rec);
});
await installRoutes(page, out, BASE);
const snap = () => page.evaluate(SNAP);
await openPage(page, BASE);

// ── E1. warmup 取数口径：DCAP 关 → limit 应为 120；开 → viewport 120 + (n_l + m − 1) ──
out.warmup = {};
out.warmup.dcapOffUrls = out.klineUrls.slice();
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
out.warmup.dcapOnUrls = out.klineUrls.slice(out.warmup.dcapOffUrls.length);
// 读线上 dcap 参数以核对算式
const cfg = await page.evaluate(async () => (await (await fetch('/api/config/dcap')).json()));
const kcfg = await page.evaluate(async () => (await (await fetch('/api/config/kline')).json()));
out.warmup.onlineDcap = cfg; out.warmup.onlineKline = kcfg;
const expectWarmupLimit = kcfg.viewport_bars + (cfg.n_l + cfg.m - 1);
out.warmup.expectedOn = expectWarmupLimit;
out.warmup.expectedOff = kcfg.viewport_bars;
out.warmup.observedOff = (out.warmup.dcapOffUrls.at(-1)?.url.match(/limit=(\d+)/) ?? [])[1];
out.warmup.observedOn = (out.warmup.dcapOnUrls.at(-1)?.url.match(/limit=(\d+)/) ?? [])[1];
check('warmup：DCAP 关时取数 limit = viewport_bars(120)', String(out.warmup.observedOff) === String(out.warmup.expectedOff), out.warmup);
check('warmup：DCAP 开时取数 limit = viewport + (n_l+m−1)', String(out.warmup.observedOn) === String(out.warmup.expectedOn), out.warmup);

// 拖高 VOL/DCAP
await dragSeparator(page, 0, -150);
await dragSeparator(page, 1, -40);
const r0 = await snap();

// ── E2. ADR-020：手动缩放后切 period（现行 UI 路径 = remount 会重算 fit） ──
// 手动缩放（wheel）= onZoom → manualAdjusted=true
const box = await page.locator('[data-testid="kline-chart"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(800);
const z0 = await snap();
out.zoom = { before: { bs: r0.bs, visible: visibleBars(r0), fit: r0.fitAttr }, afterZoom: { bs: z0.bs, visible: visibleBars(z0), fit: z0.fitAttr } };
check('手动 wheel 改变了 barSpace（进入手动视口态）', z0.bs?.bar !== r0.bs?.bar, { before: r0.bs, afterZoom: z0.bs, fitBefore: r0.fitAttr, fitAfter: z0.fitAttr });

await page.getByRole('button', { name: '1h', exact: true }).click();
await page.waitForTimeout(3000);
const z1 = await snap();
out.zoom.afterPeriodSwitch_uiRemount = { bs: z1.bs, visible: visibleBars(z1), fit: z1.fitAttr, heights: heights(z1), inits: z1.inits };
check('ADR-020：UI 切 period（remount）后 barSpace 被重算回 fit（可见 ≈ viewport_bars）', z1.bs?.bar !== z0.bs?.bar || z1.fitAttr !== z0.fitAttr, out.zoom);

// ── E3. 备选方案 D：remount 后按「指标名→pane」回放 setPaneOptions（异步等待确认） ──
// 先切回 15m 并拖高，记录「记忆高度」
await page.getByRole('button', { name: '15m', exact: true }).click();
await page.waitForTimeout(3000);
await dragSeparator(page, 0, -150);
await dragSeparator(page, 1, -40);
const d0 = await snap();
const memo = heights(d0);
// 触发 remount（切 1h）
await page.getByRole('button', { name: '1h', exact: true }).click();
await page.waitForTimeout(3000);
const d1 = await snap();
// 回放
await page.evaluate((mem) => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const inds = c.getIndicators() ?? [];
  const paneOf = (name) => (inds.find((i) => i.name === name) ?? {}).paneId;
  for (const [key, h] of Object.entries(mem)) {
    if (key === 'MA' || key === 'candle') continue; // 弹性主图不设
    for (const name of key.split('+')) {
      const pid = paneOf(name);
      if (pid && h != null) c.setPaneOptions({ id: pid, height: h });
    }
  }
}, memo);
await page.waitForTimeout(800);
const d2 = await snap();
out.replay = {
  memo, before: heights(d0), afterRemount: heights(d1), afterReplay: heights(d2),
  idsBeforeRemount: Object.fromEntries(d0.panes.filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.id])),
  idsAfterRemount: Object.fromEntries(d1.panes.filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.id])),
  replayDiffVsBefore: diffs(d0, d2),
};
check('备选 D：remount 后回放 setPaneOptions 能把高度恢复到 ±1px', Object.entries(out.replay.replayDiffVsBefore).every(([k, v]) => k === 'MA' || (v.delta != null && Math.abs(v.delta) <= 1)), out.replay.replayDiffVsBefore);
check('备选 D 固有缺陷：pane id 在 remount 后全部更换', JSON.stringify(out.replay.idsBeforeRemount) !== JSON.stringify(out.replay.idsAfterRemount), out.replay.idsAfterRemount);

// ── E4. overlay 在「不 remount 原地切换」下是否残留（真实 overlay） ──
await page.evaluate(() => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const d = c.getDataList?.() ?? [];
  const mid = d[Math.floor(d.length / 2)];
  c.createOverlay({ name: 'simpleAnnotation', paneId: 'candle_pane', lock: true, points: [{ timestamp: mid.timestamp, value: mid.close }], extendData: 'B' });
  c.createOverlay({ name: 'simpleTag', paneId: 'candle_pane', lock: true, points: [{ value: mid.close }], extendData: 'old-run-line' });
});
await page.waitForTimeout(500);
const o0 = await snap();
out.overlay = { before: o0.overlayCount };
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
  await sleep(1500);
});
const o1 = await snap();
out.overlay.noRemountSwitchAfter = o1.overlayCount;
check('overlay：不 remount 原地切换后旧 overlay 仍残留（需显式清理）', o1.overlayCount >= o0.overlayCount && o0.overlayCount > 0, out.overlay);

// ── E5. ADR-020：不 remount 路径下手动缩放标记保持（fit 不重算） ──
const bsBefore = (await snap()).bs;
await page.evaluate(async () => {
  // 用真实 wheel 触发 onZoom（manualAdjusted=true）
  const el = document.querySelector('[data-testid="kline-chart"] canvas');
  const r = el.getBoundingClientRect();
  const ev = (type, dy) => el.dispatchEvent(new WheelEvent(type, { deltaY: dy, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  ev('wheel', -600);
  await new Promise((res) => setTimeout(res, 400));
});
await page.waitForTimeout(600);
const m0 = await snap();
await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  c.setSymbol({ ticker: '518880', pricePrecision: 3, volumePrecision: 0 });
  c.setPeriod({ type: 'minute', span: 15 });
  c.resetData();
  await sleep(1500);
});
const m1 = await snap();
out.manualNoRemount = { beforeBs: bsBefore, afterZoomBs: m0.bs, afterSwitchBs: m1.bs, zoomChanged: m0.bs?.bar !== bsBefore?.bar, switchKeptZoom: m1.bs?.bar === m0.bs?.bar };

// ── E6. fit 属性观测性 ──
out.fitAttrs = { r0: r0.fitAttr, z1: z1.fitAttr, m1: m1.fitAttr };

out.wsSent = out.wsFrames.flatMap((w) => w.sent);
out.pageErrors = pageErrors;
writeJson(OUT, out);

const pass = out.checks.filter((c) => c.ok).length;
console.log(`checks: ${pass}/${out.checks.length} passed`);
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} :: ${JSON.stringify(c.detail).slice(0, 300)}`);
console.log('warmup:', JSON.stringify(out.warmup, null, 1));
console.log('zoom:', JSON.stringify(out.zoom, null, 1));
console.log('replay:', JSON.stringify(out.replay, null, 1).slice(0, 2500));
console.log('overlay:', JSON.stringify(out.overlay));
console.log('manualNoRemount:', JSON.stringify(out.manualNoRemount));
console.log('wsSent:', JSON.stringify(out.wsSent));
console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 10)));
console.log('OUT=' + OUT);
await browser.close();
