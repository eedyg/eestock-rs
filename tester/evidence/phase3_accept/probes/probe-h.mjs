/**
 * 阶段 3 独立验收（tester 自建）—— 受控真渲染 harness 探针。
 * 真实 KlineChart + 真实 klinecharts@10.0.3，feed/overlays/参数由测试注入（可控构造）。
 * 覆盖：overlay 跨 feed 切换的创建/清理、B/S marker overlay 锚定、DCAP 数据不足断线、
 *       上一轮修复（参数变化 overrideIndicator、不重建 pane）。
 */
import { chromium } from '/tmp/acc3/lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18095';
const OUT = process.env.OUT ?? '/tmp/acc3/probe-h.json';
const out = { base: BASE, t0: new Date().toISOString(), checks: [], scenarios: {} };
const check = (n, ok, d) => { out.checks.push({ name: n, ok: !!ok, detail: d }); };

function mkBars(prefix, startIso, n, base, stepMs, step) {
  const t0 = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => {
    const close = +(base + i * step).toFixed(4);
    return { ts: new Date(t0 + i * stepMs).toISOString(), open: close - 0.01, high: close + 0.02, low: close - 0.02, close, volume: 1000 + i, amount: (1000 + i) * close };
  });
}
const barsA = mkBars('A', '2024-01-01T00:00:00Z', 80, 10, 900000, 0.05);
const barsB = mkBars('B', '2024-03-01T00:00:00Z', 70, 200, 3600000, 0.2);
const barsFew = mkBars('F', '2024-05-01T00:00:00Z', 10, 50, 900000, 0.1);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 250)); });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });

const H = {
  set: (patch) => page.evaluate((p) => window.__H__.set(p), patch),
  pushRealtime: (bar) => page.evaluate((b) => window.__H__.pushRealtime(b), bar),
  feedCalls: () => page.evaluate(() => window.__H__.feedCalls()),
  resetCalls: () => page.evaluate(() => window.__H__.resetCalls()),
};
const SNAP = () => page.evaluate(() => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions?.() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const g = (f, d = null) => { try { return f(); } catch { return d; } };
  if (!c) return { error: 'no chart', inits: A?.inits ?? -1 };
  const inds = g(() => c.getIndicators()) ?? [];
  const panes = (g(() => c.getPaneOptions()) ?? []).map((p) => {
    let domH = null; try { domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { /* ignore */ }
    return { id: p.id, optH: p.height, domH, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
  });
  const dcap = inds.find((i) => i.name === 'DCAP');
  return {
    inits: A?.inits ?? -1, disposes: A?.disposes ?? -1, logLen: A?.log?.length ?? -1,
    panes, overlays: (g(() => c.getOverlays()) ?? []).length,
    overlayDetail: (g(() => c.getOverlays()) ?? []).map((o) => ({ name: o.name, paneId: o.paneId, points: o.points })),
    dcap: dcap ? { paneId: dcap.paneId, precision: dcap.precision, calcParams: dcap.calcParams, figKeys: (dcap.figures ?? []).map((f) => f.key), result: dcap.result ?? [] } : null,
    dataLen: (g(() => c.getDataList()) ?? []).length,
    lastTs: (g(() => c.getDataList()) ?? []).slice(-1)[0]?.timestamp ?? null,
    bs: g(() => c.getBarSpace()),
  };
});
const burst = async (from) => (await page.evaluate(() => (window.__ACC__?.log ?? []).map((e) => e.api))).slice(from);
const heights = (s) => Object.fromEntries(s.panes.filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.domH]));
const diff1 = (a, b) => { const hb = heights(b), ha = heights(a), o = {}; for (const k of Object.keys(ha)) o[k] = { before: ha[k], after: hb[k], delta: +(hb[k] - ha[k]).toFixed(2) }; return o; };

// ═══ H1: overlay 创建（2 基础 + 1 marker）═══
await H.set({
  code: 'AAA', period: '15m', bars: barsA, indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: false },
  overlays: [
    { type: 'price-line', price: 10.5, label: 'OPEN' },
    { type: 'range', fromTs: Date.parse(barsA[10].ts), toTs: Date.parse(barsA[30].ts) },
    { type: 'marker', ts: Date.parse(barsA[20].ts), text: 'B', price: 10.9 },
  ],
});
await page.waitForTimeout(2500);
const h1 = await SNAP();
out.scenarios.h1_create = h1;
check('H1: overlay 创建 = 3（price-line + range + marker）', h1.overlays === 3, { overlays: h1.overlays, detail: h1.overlayDetail.map((o) => o.name) });
check('H1: marker overlay 名称 simpleAnnotation', h1.overlayDetail.some((o) => o.name === 'simpleAnnotation'), h1.overlayDetail.map((o) => o.name));
check('H1: 单 chart 实例（inits=1）', h1.inits === 1, { inits: h1.inits });

// ═══ H2: 切 feed（code/period 变）⇒ overlay 先清后建、不重建图、数据换新 ═══
const h2Before = await SNAP();
const h2Log = h2Before.logLen;
await H.set({
  code: 'BBB', period: '1h', bars: barsB,
  overlays: [
    { type: 'price-line', price: 205.5, label: 'CLOSE' },
    { type: 'marker', ts: Date.parse(barsB[40].ts), text: 'S', price: 208 },
  ],
});
await page.waitForTimeout(2500);
const h2 = await SNAP();
const h2Burst = await burst(h2Log);
out.scenarios.h2_switch = { before: h2Before, after: h2, burst: h2Burst };
check('H2: 切 feed 后 overlay 数 = 2（旧 3 个已清，非 5）', h2.overlays === 2, { overlays: h2.overlays, names: h2.overlayDetail.map((o) => o.name) });
check('H2: 切 feed 调用 removeOverlay（先清后建）', h2Burst.includes('removeOverlay'), h2Burst);
check('H2: 切 feed 不重建图（inits 不变、无 dispose）', h2.inits === h2Before.inits && h2.disposes === h2Before.disposes, { initsBefore: h2Before.inits, initsAfter: h2.inits, disposes: h2.disposes });
check('H2: pane 高度 ±1px 不变', Object.values(diff1(h2Before, h2)).every((d) => Math.abs(d.delta) <= 1), diff1(h2Before, h2));
check('H2: 数据换新（dataLen 80→70）', h2.dataLen === 70 && h2Before.dataLen === 80, { before: h2Before.dataLen, after: h2.dataLen });

// ═══ H3: WS 实时 bar 追加 + 标记（构造）═══
const h3Before = await SNAP();
const h3Log = h3Before.logLen;
const newTs = Date.parse(barsB[69].ts) + 3600000;
await H.pushRealtime({ ts: new Date(newTs).toISOString(), open: 214, high: 215, low: 213, close: 214.5, volume: 999, amount: 214500 });
await page.waitForTimeout(1000);
const h3 = await SNAP();
const h3Burst = await burst(h3Log);
out.scenarios.h3_ws = { dataLenBefore: h3Before.dataLen, dataLenAfter: h3.dataLen, lastTs: h3.lastTs, expectTs: newTs, burst: h3Burst };
check('H3: 实时 bar 追加（dataLen +1、末根 ts = 推送 ts）', h3.dataLen === h3Before.dataLen + 1 && h3.lastTs === newTs, out.scenarios.h3_ws);
check('H3: followLatest=true ⇒ scrollToRealTime', h3Burst.includes('scrollToRealTime'), h3Burst);

// ═══ H4: DCAP 数据不足断线（10 根 bar、n_l=60）═══
await H.set({
  code: 'FFF', period: '15m', bars: barsFew, overlays: [],
  indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: true },
  dcapParams: { n_s: 8, n_m: 26, n_l: 60, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3 },
});
await page.waitForTimeout(2000);
const h4 = await SNAP();
const res = h4.dcap?.result ?? [];
const numericL = res.filter((r) => r && typeof r.l === 'number').length;
out.scenarios.h4_dcap = { len: res.length, numericL, firstNumericL: res.findIndex((r) => r && typeof r.l === 'number'), precision: h4.dcap?.precision, figKeys: h4.dcap?.figKeys, sample: res.slice(0, 3) };
check('H4: DCAP 数据不足 ⇒ 三线 null 断线（10 根 ⇒ l 线全 null）', res.length === 10 && numericL === 0, out.scenarios.h4_dcap);
check('H4: DCAP precision=5 且 figures 含 s,m,l,zero', h4.dcap?.precision === 5 && ['s', 'm', 'l', 'zero'].every((k) => h4.dcap?.figKeys?.includes(k)), { precision: h4.dcap?.precision, figKeys: h4.dcap?.figKeys });

// ═══ H5: 参数变化（dcapParams 新对象、同 feed 身份）= 上一轮修复 ═══
// 先给一只够长的标的并开 DCAP，拖高 DCAP pane
await H.set({ code: 'AAA', period: '15m', bars: barsA, overlays: [], indicators: { ma: true, macd: false, kdj: false, boll: false, dcap: true }, dcapParams: { n_s: 8, n_m: 26, n_l: 60, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3 } });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const A = window.__ACC__; const c = A.charts[A.charts.length - 1];
  const d = c.getIndicators().find((i) => i.name === 'DCAP');
  c.setPaneOptions({ id: d.paneId, height: 220 });
});
await page.waitForTimeout(500);
const h5Before = await SNAP();
const h5Log = h5Before.logLen;
await H.set({ dcapParams: { n_s: 8, n_m: 26, n_l: 70, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 5 }, warmupBars: 74 });
await page.waitForTimeout(1500);
const h5 = await SNAP();
const h5Burst = await burst(h5Log);
out.scenarios.h5_params = { before: h5Before, after: h5, burst: h5Burst, diffs: diff1(h5Before, h5) };
check('H5: 参数变化不重建图、不重建 pane（inits 不变、无 create/remove churn）', h5.inits === h5Before.inits && !h5Burst.includes('createIndicator') && !h5Burst.includes('removeIndicator'), { inits: h5.inits, burst: h5Burst });
check('H5: 走 overrideIndicator 且 calcParams 更新（n_l 60→70、m 3→5）', h5Burst.includes('overrideIndicator') && h5.dcap?.calcParams?.[2] === 70 && h5.dcap?.calcParams?.[7] === 5, { burst: h5Burst, calcParams: h5.dcap?.calcParams });
check('H5: 拖高后的 DCAP pane 高度 ±1px 保持（220）', Math.abs((diff1(h5Before, h5).DCAP?.delta ?? 999)) <= 1, diff1(h5Before, h5));

out.pageErrors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e));
check('E: 无页面异常/崩溃', out.pageErrors.length === 0, out.pageErrors.slice(0, 5));

const fs = await import('node:fs');
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const pass = out.checks.filter((c) => c.ok).length;
console.log(`[H] checks: ${pass}/${out.checks.length} passed`);
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} :: ${JSON.stringify(c.detail).slice(0, 300)}`);
console.log('OUT=' + OUT);
await browser.close();
