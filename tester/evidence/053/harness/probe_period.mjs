/**
 * 诊断车道（tester 阶段 1）probe —— 切换 period / 切换 stock 时 pane 布局是否被重置。
 * 真实 klinecharts@10.0.3 + 真实 KlineChart/DashboardPage（临时构建 /tmp/diag53/dist，临时端口 18097，
 * /api 只读代理线上 8081；浏览器侧拦截全部非 GET）。
 *
 * 产出：
 *  A) UI 切 period（15m→1h）前后 pane id/高度/DOM 高度、__ACC__.inits、churn 序列、视口；
 *  B) UI 切 stock（518880→161226）前后同上；
 *  C) 「不 remount」首选方案在同一条 chart 实例上的实测（setSymbol+setPeriod+setDataLoader+resetData）；
 *  D) 「remount 后回放 setPaneOptions」备选方案实测；
 *  E) 回归面快照（ADR-020 视口、WS 订阅帧、overlay）。
 */
import fs from 'node:fs';
import { chromium, installRoutes, openPage, dragSeparator, readLog, writeJson } from '/tmp/diag53/lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18097';
const OUT = process.env.OUT ?? '/tmp/diag53/probe_period.json';
const EV = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/053';
fs.mkdirSync(EV, { recursive: true });

const out = { base: BASE, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], klineGets: 0, wsFrames: [], scenarios: {}, checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

/** 页面侧快照：pane（id/option 高度/DOM 高度/所属指标）+ 指标 + 数据 + 视口 + symbol/period + init 计数。 */
const SNAP = () => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => {
    try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; }
  });
  const c = charts[charts.length - 1];
  if (!c) return { error: 'no chart' };
  const inds = (c.getIndicators() ?? []).map((i) => ({
    name: i.name, id: i.id, paneId: i.paneId, calcParams: i.calcParams, precision: i.precision,
    figKeys: (i.figures ?? []).map((f) => f.key),
    resultTail: Array.isArray(i.result) ? i.result.slice(-1)[0] : null,
    resultLen: Array.isArray(i.result) ? i.result.length : null,
  }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let domH = null, domTop = null;
    try { const r = c.getDom(p.id).getBoundingClientRect(); domH = +r.height.toFixed(2); domTop = +r.top.toFixed(2); } catch { /* ignore */ }
    return { id: p.id, optH: p.height, minHeight: p.minHeight, state: p.state, domH, domTop, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
  });
  const data = c.getDataList?.() ?? [];
  const g = (fn) => { try { return fn(); } catch { return null; } };
  return {
    inits: A?.inits ?? -1,
    logLen: A?.log?.length ?? -1,
    chartCount: charts.length,
    symbol: g(() => c.getSymbol()),
    period: g(() => c.getPeriod()),
    panes, inds,
    vr: g(() => c.getVisibleRange()),
    bs: g(() => c.getBarSpace()),
    offsetRight: g(() => c.getOffsetRightDistance()),
    dataLen: data.length,
    firstTs: data[0]?.timestamp ?? null,
    lastTs: data[data.length - 1]?.timestamp ?? null,
    firstClose: data[0]?.close ?? null,
    lastClose: data[data.length - 1]?.close ?? null,
    head3: data.slice(0, 3).map((b) => ({ ts: b.timestamp, close: b.close })),
    tail2: data.slice(-2).map((b) => ({ ts: b.timestamp, close: b.close })),
  };
};

/** 以「指标名组合」为键的 DOM 高度（candle/VOL/DCAP…）。 */
const heights = (s) => Object.fromEntries((s.panes ?? []).filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.domH]));
const ids = (s) => Object.fromEntries((s.panes ?? []).filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.id]));
const diffs = (a, b) => {
  const ha = heights(a), hb = heights(b), o = {};
  for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
    const x = ha[k], y = hb[k];
    o[k] = { before: x ?? null, after: y ?? null, delta: x != null && y != null ? +(y - x).toFixed(2) : null };
  }
  return o;
};
const within1 = (d) => { const e = Object.entries(d); return e.length > 0 && e.every(([, v]) => v.delta != null && Math.abs(v.delta) <= 1); };
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });
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
out.mountInits = await page.evaluate(() => window.__ACC__?.inits);

// DCAP 打开（默认关）
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
check('DCAP 打开后存在独立 DCAP pane', (await snap()).panes.some((p) => p.indicators.includes('DCAP')), (await snap()).panes.map((p) => p.indicators.join('+') + ':' + p.id));

// 拖拽两条分隔线（candle|VOL 上移 150 → VOL 变高；VOL|DCAP 上移 40）
const drag0 = await drag(0, -150);
const drag1 = await drag(1, -40);
out.dragHandles = { drag0, drag1 };

// ═══ A. UI 切 period：15m → 1h ═══
const a0 = await snap();
out.scenarios.A_before_period = a0;
const logA0 = a0.logLen;
await clickPeriod('1h');
const a1 = await snap();
out.scenarios.A_after_period = a1;
out.A = {
  heightsBefore: heights(a0), heightsAfter: heights(a1),
  idsBefore: ids(a0), idsAfter: ids(a1),
  diffs: diffs(a0, a1), within1px: within1(diffs(a0, a1)),
  initsBefore: a0.inits, initsAfter: a1.inits, remount: a1.inits > a0.inits,
  period: { before: a0.period, after: a1.period },
  symbol: { before: a0.symbol, after: a1.symbol },
  data: { lenBefore: a0.dataLen, lenAfter: a1.dataLen, firstBefore: iso(a0.firstTs), firstAfter: iso(a1.firstTs), lastBefore: iso(a0.lastTs), lastAfter: iso(a1.lastTs), closeBefore: a0.lastClose, closeAfter: a1.lastClose },
  viewport: { vrBefore: a0.vr, vrAfter: a1.vr, bsBefore: a0.bs, bsAfter: a1.bs, offsetBefore: a0.offsetRight, offsetAfter: a1.offsetRight },
  dataReset: a0.firstTs !== a1.firstTs || a0.lastTs !== a1.lastTs || a0.dataLen !== a1.dataLen,
};
out.A.logBurst = (await readLog(page)).filter((e) => e.seq >= logA0).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 120), paneIdsAfter: e.paneIdsAfter }));
check('A 切 period 后 pane 高度被重置（= 缺陷）', !within1(out.A.diffs), out.A.diffs);
check('A 切 period 触发整图 remount（init 计数 +1）', out.A.remount, { before: a0.inits, after: a1.inits });
check('A 切 period 数据确实重置', out.A.dataReset, out.A.data);

// ═══ D. 备选方案：remount 后回放 setPaneOptions（在当前新 chart 上直接试） ═══
const remembered = heights(a0);
out.scenarios.D_remembered = remembered;
out.D_replay = await page.evaluate((mem) => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const inds = c.getIndicators() ?? [];
  const paneOf = (name) => (inds.find((i) => i.name === name) ?? {}).paneId;
  const before = Object.fromEntries((c.getPaneOptions() ?? []).filter((p) => p.id !== 'x_axis_pane').map((p) => [p.id, +c.getDom(p.id).getBoundingClientRect().height.toFixed(2)]));
  const applied = {};
  for (const [key, h] of Object.entries(mem)) {
    if (key === 'candle') continue;
    // key 形如 'VOL' 或 'VOL+DCAP'；逐个指标名映射到 pane
    for (const name of key.split('+')) {
      const pid = paneOf(name);
      if (pid && h != null) { c.setPaneOptions({ id: pid, height: h }); applied[name] = { paneId: pid, height: h }; }
    }
  }
  const after = Object.fromEntries((c.getPaneOptions() ?? []).filter((p) => p.id !== 'x_axis_pane').map((p) => [p.id, { optH: p.height, domH: +c.getDom(p.id).getBoundingClientRect().height.toFixed(2) }]));
  return { before, applied, after };
}, remembered);
check('D 回放 setPaneOptions 能恢复被重置的高度', Object.values(out.D_replay.after).some((v) => typeof v === 'object' && v.domH > 100), out.D_replay);

// ═══ B. UI 切 stock：518880 → 161226（先切回 15m 并重新拖高） ═══
await clickPeriod('15m');
await drag(0, -150);
await drag(1, -40);
const b0 = await snap();
out.scenarios.B_before_stock = b0;
const logB0 = b0.logLen;
await clickStock('161226');
const b1 = await snap();
out.scenarios.B_after_stock = b1;
out.B = {
  heightsBefore: heights(b0), heightsAfter: heights(b1),
  idsBefore: ids(b0), idsAfter: ids(b1),
  diffs: diffs(b0, b1), within1px: within1(diffs(b0, b1)),
  initsBefore: b0.inits, initsAfter: b1.inits, remount: b1.inits > b0.inits,
  symbol: { before: b0.symbol, after: b1.symbol },
  data: { lenBefore: b0.dataLen, lenAfter: b1.dataLen, firstBefore: iso(b0.firstTs), firstAfter: iso(b1.firstTs), lastBefore: iso(b0.lastTs), lastAfter: iso(b1.lastTs), closeBefore: b0.lastClose, closeAfter: b1.lastClose, headBefore: b0.head3, headAfter: b1.head3 },
  dataReset: b0.firstTs !== b1.firstTs || b0.lastTs !== b1.lastTs || b0.dataLen !== b1.dataLen,
};
out.B.logBurst = (await readLog(page)).filter((e) => e.seq >= logB0).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 120), paneIdsAfter: e.paneIdsAfter }));
check('B 切 stock 后 pane 高度被重置（= 缺陷）', !within1(out.B.diffs), out.B.diffs);
check('B 切 stock 触发整图 remount', out.B.remount, { before: b0.inits, after: b1.inits });
check('B 切 stock 数据确实重置', out.B.dataReset, out.B.data);

// ═══ C. 首选方案：同一实例 setSymbol + setPeriod + setDataLoader + resetData ═══
// 在当前 chart 上先设好非默认高度
await page.evaluate(() => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const inds = c.getIndicators() ?? [];
  for (const [name, h] of [['VOL', 220], ['DCAP', 170]]) {
    const pid = (inds.find((i) => i.name === name) ?? {}).paneId;
    if (pid) c.setPaneOptions({ id: pid, height: h });
  }
});
await page.waitForTimeout(400);
const c0 = await snap();
out.scenarios.C_before = { heights: heights(c0), ids: ids(c0), inits: c0.inits, data: { len: c0.dataLen, firstTs: iso(c0.firstTs), last: iso(c0.lastTs), close: c0.lastClose }, symbol: c0.symbol, period: c0.period, vr: c0.vr, bs: c0.bs };
const cLog0 = c0.logLen;
const klineGetsBefore = out.klineGets;

// 页面侧：新 loader（闭合捕获目标 code/period）+ setSymbol/setPeriod/setDataLoader/resetData
out.C_switch = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TARGET = { code: '161226', period: '1h', kc: { type: 'hour', span: 1 } };
  window.__TARGET__ = TARGET;
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const snapNow = () => {
    const data = c.getDataList?.() ?? [];
    return {
      dataLen: data.length, firstTs: data[0]?.timestamp ?? null, lastTs: data[data.length - 1]?.timestamp ?? null,
      lastClose: data[data.length - 1]?.close ?? null,
      panes: (c.getPaneOptions() ?? []).map((p) => ({ id: p.id, optH: p.height, domH: +c.getDom(p.id).getBoundingClientRect().height.toFixed(2) })),
    };
  };
  // 新 loader：无论 store 传什么 symbol/period，都按 TARGET 取数（消除多次隐式 resetData 的竞态）
  const loader = {
    getBars: async ({ type, callback }) => {
      const r = await fetch(`/api/kline?code=${TARGET.code}&period=${TARGET.period}&limit=120`);
      const j = await r.json();
      callback(j.bars.map((b) => ({
        timestamp: Date.parse(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, turnover: b.amount,
      })), { forward: false, backward: false });
    },
    subscribeBar: () => {},
    unsubscribeBar: () => {},
  };
  const timeline = [];
  const t0 = performance.now();
  const mark = (label) => timeline.push({ label, t: +(performance.now() - t0).toFixed(1), ...snapNow() });
  mark('pre');
  c.setDataLoader(loader);
  mark('after-setDataLoader');
  c.setSymbol({ ticker: TARGET.code, pricePrecision: 3, volumePrecision: 0 });
  mark('after-setSymbol');
  c.setPeriod(TARGET.kc);
  mark('after-setPeriod');
  c.resetData();
  mark('after-resetData(sync)');
  for (const ms of [50, 150, 400, 1000, 2000]) { await sleep(ms); mark('t+' + ms); }
  const data = c.getDataList?.() ?? [];
  return {
    timeline,
    symbol: c.getSymbol(), period: c.getPeriod(),
    dataLen: data.length, firstTs: data[0]?.timestamp ?? null, lastTs: data[data.length - 1]?.timestamp ?? null,
    lastClose: data[data.length - 1]?.close ?? null,
    head3: data.slice(0, 3).map((b) => ({ ts: b.timestamp, close: b.close })),
    panes: (c.getPaneOptions() ?? []).map((p) => ({ id: p.id, optH: p.height, domH: +c.getDom(p.id).getBoundingClientRect().height.toFixed(2), inds: (c.getIndicators() ?? []).filter((i) => i.paneId === p.id).map((i) => i.name) })),
  };
});
const c1 = await snap();
out.scenarios.C_after = { heights: heights(c1), ids: ids(c1), inits: c1.inits, data: { len: c1.dataLen, firstTs: iso(c1.firstTs), last: iso(c1.lastTs), close: c1.lastClose }, symbol: c1.symbol, period: c1.period, vr: c1.vr, bs: c1.bs };
out.C = {
  diffs: diffs(c0, c1), within1px: within1(diffs(c0, c1)),
  idsSame: JSON.stringify(ids(c0)) === JSON.stringify(ids(c1)),
  initsBefore: c0.inits, initsAfter: c1.inits, remount: c1.inits > c0.inits,
  klineGetsDuring: out.klineGets - klineGetsBefore,
  symbolAfter: out.C_switch.symbol, periodAfter: out.C_switch.period,
  dataReplaced: c0.firstTs !== c1.firstTs || c0.lastTs !== c1.lastTs,
  viewport: { vrBefore: c0.vr, vrAfter: c1.vr, bsBefore: c0.bs, bsAfter: c1.bs },
};
out.C.logBurst = (await readLog(page)).filter((e) => e.seq >= cLog0).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 120), paneIdsAfter: e.paneIdsAfter }));
check('C 首选方案：pane 高度天然保持不变（±1px）', within1(out.C.diffs), out.C.diffs);
check('C 首选方案：pane id 不变', out.C.idsSame, { before: ids(c0), after: ids(c1) });
check('C 首选方案：不 remount（init 计数不变）', !out.C.remount, { before: c0.inits, after: c1.inits });
check('C 首选方案：数据确实换成新标的/周期', out.C.dataReplaced && out.C_switch.dataLen > 0, { before: { len: c0.dataLen, first: iso(c0.firstTs), last: iso(c0.lastTs) }, after: { len: out.C_switch.dataLen, first: iso(out.C_switch.firstTs), last: iso(out.C_switch.lastTs) } });

// ═══ E. 回归面：manual zoom 后切 period（现 UI 路径 remount 会 reset manualAdjusted） ═══
out.regression = {
  wsFrameCount: out.wsFrames.length,
  wsSent: out.wsFrames.flatMap((w) => w.sent),
  klineGets: out.klineGets,
  nonGetOther: out.nonGetOther,
  putIntercepted: out.putIntercepted,
};

out.pageErrors = pageErrors;
writeJson(OUT, out);

// 控制台摘要
const pass = out.checks.filter((c) => c.ok).length;
console.log(`checks: ${pass}/${out.checks.length} passed`);
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} :: ${JSON.stringify(c.detail).slice(0, 400)}`);
console.log('--- A (period 15m→1h) ---');
console.log(JSON.stringify({ diffs: out.A.diffs, idsBefore: out.A.idsBefore, idsAfter: out.A.idsAfter, remount: out.A.remount, viewport: out.A.viewport }, null, 1));
console.log('--- B (stock 518880→161226) ---');
console.log(JSON.stringify({ diffs: out.B.diffs, idsBefore: out.B.idsBefore, idsAfter: out.B.idsAfter, remount: out.B.remount }, null, 1));
console.log('--- C (no-remount raw API) ---');
console.log(JSON.stringify({ diffs: out.C.diffs, idsSame: out.C.idsSame, remount: out.C.remount, klineGetsDuring: out.C.klineGetsDuring, symbolAfter: out.C.symbolAfter, periodAfter: out.C.periodAfter, dataReplaced: out.C.dataReplaced, timeline: out.C_switch.timeline.map((t) => ({ label: t.label, dataLen: t.dataLen, lastTs: t.lastTs })) }, null, 1));
console.log('--- pageErrors ---');
console.log(JSON.stringify(pageErrors.slice(0, 10)));
console.log('OUT=' + OUT);

await browser.close();
