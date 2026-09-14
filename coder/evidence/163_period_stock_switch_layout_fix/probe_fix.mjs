/**
 * 阶段 2（修复）真渲染验收探针 —— 「切 period / 切 stock 不得重置指标视图布局」。
 *
 * 临时构建（/tmp/fix2/dist，root = 仓库 web/，真实 klinecharts + kc-spy）+ 临时预览 127.0.0.1:18098，
 * /api /ws 只读代理线上 8081（**只发 GET**；非 GET 一律浏览器侧 abort）。
 * 判据（修复后应为真）：
 *  1) 切 period / 切 stock：既有 pane 高度 ±1px 不变、pane id 不变、`__ACC__.inits` 不递增（无 remount）、
 *     burst 中无 createIndicator/removeIndicator；
 *  2) 数据确实重置（根数/首末 ts/取值换成新周期/新标的、`getPeriod()/getSymbol()` 更新）；
 *  3) 每次切换的 `/api/kline` GET 次数不膨胀（≤2，理想 1）；
 *  4) ADR-020：切换后可见根数重新 ≈ viewport_bars（`data-viewport-fit`）；真实 wheel 手动缩放后
 *     切换也不得把 barSpace 保留成手动值（= 仍回自动视口归一）；
 *  5) DCAP：独立副图 / precision 5 / 含 zero figure / 开关仍走 create-remove（pane 数 3↔2）；
 *  6) DCAP warmup 口径不变（关 → limit=120；开 → 差额补取 62 ⇒ 窗口 182）。
 */
import { chromium, installRoutes, openPage, dragSeparator, readLog, writeJson } from '/tmp/fix2/lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18098';
const OUT = process.env.OUT ?? '/tmp/fix2/probe_fix.json';
const out = { base: BASE, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], klineGets: 0, klineUrls: [], wsFrames: [], scenarios: {}, checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const SNAP = () => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => {
    try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; }
  });
  const c = charts[charts.length - 1];
  if (!c) return { error: 'no chart' };
  const inds = (c.getIndicators() ?? []).map((i) => ({
    name: i.name,
    id: i.id,
    paneId: i.paneId,
    precision: i.precision,
    calcParams: i.calcParams,
    figKeys: (i.figures ?? []).map((f) => f.key),
    resultLen: Array.isArray(i.result) ? i.result.length : null,
    resultTail: Array.isArray(i.result) ? i.result.slice(-1)[0] : null,
  }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let domH = null;
    try { domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { /* ignore */ }
    return { id: p.id, optH: p.height, domH, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
  });
  const data = c.getDataList?.() ?? [];
  const g = (fn) => { try { return fn(); } catch { return null; } };
  const fit = document.querySelector('[data-testid="kline-chart"]')?.getAttribute('data-viewport-fit') ?? null;
  return {
    inits: A?.inits ?? -1,
    chartCount: charts.length,
    logLen: A?.log?.length ?? -1,
    symbol: g(() => c.getSymbol()),
    period: g(() => c.getPeriod()),
    panes,
    inds,
    vr: g(() => c.getVisibleRange()),
    bs: g(() => c.getBarSpace()),
    dataLen: data.length,
    firstTs: data[0]?.timestamp ?? null,
    lastTs: data[data.length - 1]?.timestamp ?? null,
    firstClose: data[0]?.close ?? null,
    lastClose: data[data.length - 1]?.close ?? null,
    head3: data.slice(0, 3).map((b) => ({ ts: b.timestamp, close: b.close })),
    fitAttr: fit,
  };
};

const content = (s) => (s.panes ?? []).filter((p) => p.id !== 'x_axis_pane');
const heights = (s) => Object.fromEntries(content(s).map((p) => [p.indicators.join('+') || 'candle', p.domH]));
const ids = (s) => Object.fromEntries(content(s).map((p) => [p.indicators.join('+') || 'candle', p.id]));
const diffs = (a, b) => {
  const ha = heights(a); const hb = heights(b); const o = {};
  for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
    const x = ha[k]; const y = hb[k];
    o[k] = { before: x ?? null, after: y ?? null, delta: x != null && y != null ? +(y - x).toFixed(2) : null };
  }
  return o;
};
const within1 = (d) => { const e = Object.entries(d); return e.length > 0 && e.every(([, v]) => v.delta != null && Math.abs(v.delta) <= 1); };
const visible = (s) => (s.vr ? s.vr.to - s.vr.from + 1 : null);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });
page.on('request', (r) => { if (r.url().includes('/api/kline')) out.klineUrls.push(r.url().replace(BASE, '')); });
page.on('websocket', (ws) => {
  const rec = { url: ws.url(), sent: [], received: 0 };
  ws.on('framesent', (f) => rec.sent.push(String(f.payload).slice(0, 200)));
  ws.on('framereceived', () => { rec.received++; });
  out.wsFrames.push(rec);
});
await installRoutes(page, out, BASE);

const snap = () => page.evaluate(SNAP);
const clickPeriod = async (label) => { await page.getByRole('button', { name: label, exact: true }).click(); await page.waitForTimeout(3000); };
const clickStock = async (code) => { await page.getByText(code, { exact: true }).first().click(); await page.waitForTimeout(3500); };
const drag = async (i, dy) => { await dragSeparator(page, i, dy); };

await openPage(page, BASE);
const s0 = await snap();
out.scenarios.mount = s0;
check('mount：只有 1 个 chart 实例（inits=1）', s0.inits === 1 && s0.chartCount === 1, { inits: s0.inits, chartCount: s0.chartCount });
check('mount：DCAP 默认关（无 DCAP pane）', !s0.panes.some((p) => p.indicators.includes('DCAP')), s0.panes.map((p) => p.indicators.join('+')));

// DCAP 开（warmup 补取）
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
const sDcap = await snap();
out.scenarios.dcap_on = sDcap;
const dcap = sDcap.inds.find((i) => i.name === 'DCAP');
check('DCAP 独立副图 pane（不叠 candle_pane）', !!dcap && dcap.paneId !== 'candle_pane', dcap);
check('DCAP precision=5 且含常驻 zero figure', dcap?.precision === 5 && dcap?.figKeys?.includes('zero'), dcap);
check('DCAP 开启不重建图（inits 仍 1）', sDcap.inits === 1, { inits: sDcap.inits });
check('DCAP warmup 差额补取口径不变（初始 120 + 差额补取 68 ⇒ 窗口 188）', out.klineUrls.some((u) => u.endsWith('limit=120')) && out.klineUrls.some((u) => u.includes('limit=68')), out.klineUrls.slice(0, 4));

// 拖高 VOL / DCAP（candle|VOL 上移 150；VOL|DCAP 上移 40）
await drag(0, -150);
await drag(1, -40);

// ═══ A. 切 period：15m → 1h ═══
const a0 = await snap();
out.scenarios.A_before = a0;
const aLog = a0.logLen;
const aGets = out.klineGets;
await clickPeriod('1h');
const a1 = await snap();
out.scenarios.A_after = a1;
out.A = {
  heightsBefore: heights(a0), heightsAfter: heights(a1), diffs: diffs(a0, a1), within1px: within1(diffs(a0, a1)),
  idsBefore: ids(a0), idsAfter: ids(a1), idsSame: JSON.stringify(ids(a0)) === JSON.stringify(ids(a1)),
  initsBefore: a0.inits, initsAfter: a1.inits,
  period: { before: a0.period, after: a1.period },
  symbol: { before: a0.symbol, after: a1.symbol },
  data: { lenBefore: a0.dataLen, lenAfter: a1.dataLen, firstBefore: iso(a0.firstTs), firstAfter: iso(a1.firstTs), lastBefore: iso(a0.lastTs), lastAfter: iso(a1.lastTs), closeBefore: a0.lastClose, closeAfter: a1.lastClose },
  dataReset: a0.firstTs !== a1.firstTs || a0.dataLen !== a1.dataLen,
  viewport: { fitBefore: a0.fitAttr, fitAfter: a1.fitAttr, visibleBefore: visible(a0), visibleAfter: visible(a1), bsBefore: a0.bs, bsAfter: a1.bs },
  klineGetsDuring: out.klineGets - aGets,
};
out.A.logBurst = (await readLog(page)).filter((e) => e.seq >= aLog).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 120) }));
check('A 切 period：既有 pane 高度 ±1px 不变', within1(out.A.diffs), out.A.diffs);
check('A 切 period：pane id 不变', out.A.idsSame, { before: out.A.idsBefore, after: out.A.idsAfter });
check('A 切 period：不 remount（inits 不递增）', a1.inits === a0.inits, { before: a0.inits, after: a1.inits });
check('A 切 period：burst 无 create/removeIndicator', !out.A.logBurst.some((e) => e.api === 'createIndicator' || e.api === 'removeIndicator'), out.A.logBurst);
check('A 切 period：数据确实重置为 1h', out.A.dataReset && a1.period?.type === 'hour', out.A.data);
check('A 切 period：/api/kline GET 不膨胀（≤2）且窗口口径 = viewport_bars+warmup', out.A.klineGetsDuring <= 2 && out.klineUrls.some((u) => u.includes('period=1h&limit=188')), { gets: out.A.klineGetsDuring, urls: out.klineUrls.slice(-4) });
check('A 切 period：视口回到配置根数（ADR-020，fit 重算 ≈120）', (() => { const f = JSON.parse(a1.fitAttr ?? '{}'); return f.bars === 120 && f.visible >= 105 && f.visible <= 135; })(), out.A.viewport);

// ═══ B. 切回 15m 后再切 stock：518880 → 161226 ═══
await clickPeriod('15m');
const b0 = await snap();
out.scenarios.B_before = b0;
const bLog = b0.logLen;
const bGets = out.klineGets;
await clickStock('161226');
const b1 = await snap();
out.scenarios.B_after = b1;
out.B = {
  heightsBefore: heights(b0), heightsAfter: heights(b1), diffs: diffs(b0, b1), within1px: within1(diffs(b0, b1)),
  idsBefore: ids(b0), idsAfter: ids(b1), idsSame: JSON.stringify(ids(b0)) === JSON.stringify(ids(b1)),
  initsBefore: b0.inits, initsAfter: b1.inits,
  symbol: { before: b0.symbol, after: b1.symbol },
  data: { lenBefore: b0.dataLen, lenAfter: b1.dataLen, firstBefore: iso(b0.firstTs), firstAfter: iso(b1.firstTs), closeBefore: b0.lastClose, closeAfter: b1.lastClose, headBefore: b0.head3, headAfter: b1.head3 },
  dataReset: b0.firstTs !== b1.firstTs || b0.lastClose !== b1.lastClose,
  klineGetsDuring: out.klineGets - bGets,
};
out.B.logBurst = (await readLog(page)).filter((e) => e.seq >= bLog).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 120) }));
check('B 切 stock：既有 pane 高度 ±1px 不变', within1(out.B.diffs), out.B.diffs);
check('B 切 stock：pane id 不变', out.B.idsSame, { before: out.B.idsBefore, after: out.B.idsAfter });
check('B 切 stock：不 remount（inits 不递增）', b1.inits === b0.inits, { before: b0.inits, after: b1.inits });
check('B 切 stock：burst 无 create/removeIndicator', !out.B.logBurst.some((e) => e.api === 'createIndicator' || e.api === 'removeIndicator'), out.B.logBurst);
check('B 切 stock：数据确实重置为 161226', out.B.dataReset && b1.symbol?.ticker === '161226', out.B.data);
check('B 切 stock：/api/kline GET 不膨胀（≤2）', out.B.klineGetsDuring <= 2, { gets: out.B.klineGetsDuring, urls: out.klineUrls.slice(-4) });

// ═══ C. ADR-020：真实 wheel 手动缩放后切 period → 仍回自动视口归一 ═══
const box = await page.locator('[data-testid="kline-chart"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -900);
await page.waitForTimeout(900);
const c0 = await snap();
const cGets = out.klineGets;
await clickPeriod('1h');
const c1 = await snap();
out.C = {
  bsBeforeWheelRef: b1.bs, bsAfterWheel: c0.bs, bsAfterSwitch: c1.bs,
  visibleAfterWheel: visible(c0), visibleAfterSwitch: visible(c1),
  fitAfterSwitch: c1.fitAttr, diffs: diffs(c0, c1), within1px: within1(diffs(c0, c1)),
  initsBefore: c0.inits, initsAfter: c1.inits, klineGetsDuring: out.klineGets - cGets,
  heightsBefore: heights(c0), heightsAfter: heights(c1),
};
check('C 真实 wheel 改变了 barSpace（确认进入手动视口态）', c0.bs?.bar !== b1.bs?.bar, { manual: c0.bs, before: b1.bs });
check('C 手动缩放后切 period：仍回自动视口归一（可见 ≈120，ADR-020 口径不变）', (() => { const f = JSON.parse(c1.fitAttr ?? '{}'); return f.bars === 120 && f.visible >= 105 && f.visible <= 135; })(), out.C);
check('C 手动缩放后切 period：pane 高度仍 ±1px 不变', within1(out.C.diffs), out.C.diffs);
check('C 手动缩放后切 period：仍不 remount', c1.inits === c0.inits, { before: c0.inits, after: c1.inits });

// ═══ D. DCAP 关/开仍走 create/remove（pane 数 3 ↔ 2），且不 remount ═══
const dBefore = await snap();
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
const dOff = await snap();
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
const dOn = await snap();
out.D = {
  panes: { before: content(dBefore).length, off: content(dOff).length, on: content(dOn).length },
  inits: { before: dBefore.inits, off: dOff.inits, on: dOn.inits },
  dcapAfterReopen: dOn.inds.find((i) => i.name === 'DCAP'),
};
check('D DCAP 关 → pane 数减少 1、开 → 恢复（无空 pane 残留）', out.D.panes.before === 3 && out.D.panes.off === 2 && out.D.panes.on === 3, out.D.panes);
check('D DCAP 关/开不 remount', dOff.inits === dBefore.inits && dOn.inits === dBefore.inits, out.D.inits);

// ═══ E. 只读保证 ═══
out.pageErrors = pageErrors;
check('E 全程无非 GET 请求（未改线上状态）', out.nonGetOther.length === 0, out.nonGetOther);
check('E 无页面异常/崩溃', pageErrors.length === 0, pageErrors.slice(0, 5));

writeJson(OUT, out);
const pass = out.checks.filter((c) => c.ok).length;
console.log(`checks: ${pass}/${out.checks.length} passed`);
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} :: ${JSON.stringify(c.detail).slice(0, 300)}`);
console.log('A:', JSON.stringify(out.A, null, 1).slice(0, 2600));
console.log('B:', JSON.stringify(out.B, null, 1).slice(0, 2200));
console.log('C:', JSON.stringify(out.C, null, 1).slice(0, 1400));
console.log('klineUrls:', JSON.stringify(out.klineUrls));
console.log('OUT=' + OUT);
await browser.close();
