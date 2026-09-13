/**
 * 诊断车道（tester 阶段 1）probe2 —— 真实 klinecharts 10.0.3 + 真实 KlineChart/DashboardPage 渲染。
 *
 * 与 probe1 的差异（修订）：
 *  - pane 高度以 **DOM 实测（rendered bounding）** 为准，getPaneOptions().height 仅作旁证
 *    （实测发现：弹性 pane `candle_pane` 的 option.height 是「拖拽残值」，不等于渲染高度 597 ⇒
 *     只信 DOM / 非弹性 pane 的 option.height）。
 *  - 归因：mount effect 的 burst 含 setDataLoader/setSymbol（mount 专属调用），
 *    deps effect 的 burst 只有 remove/create ⇒ 可正向区分两个 useEffect。
 *  - 路径 B（整图 remount）：改 warmup 参数（n_l 或 m）才可能重建 feed；probe1 误用 n_m（不进 warmup）。
 *  - 机制微测（M）：手工 removeIndicator+createIndicator vs overrideIndicator，隔离 React 之外。
 *  - overrideIndicator 返回值的**库事实**：仅 calc 变化时返回 false（index.esm.js:15305-15318），
 *    故用「状态差分 + 线值 + Y 轴 + canvas 像素」判成功，不用返回值判成功。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
const { chromium } = require('@playwright/test');

const BASE = process.env.BASE ?? 'http://127.0.0.1:18085';
const OUT = process.env.OUT ?? '/tmp/diag51';
const out = { base: BASE, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], scenarios: {}, checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const PROBE = () => {
  const charts = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const inds = (c.getIndicators() ?? []).map((i) => ({
    name: i.name, id: i.id, paneId: i.paneId, precision: i.precision, calcParams: i.calcParams,
    figKeys: (i.figures ?? []).map((f) => f.key), resultLen: Array.isArray(i.result) ? i.result.length : null,
    visible: i.visible,
  }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let dom = null; let canvasHash = null;
    try {
      const el = c.getDom(p.id); const r = el.getBoundingClientRect();
      dom = { h: +r.height.toFixed(2), top: +r.top.toFixed(2) };
      let h = 2166136261;
      for (const cv of Array.from(el.querySelectorAll('canvas'))) {
        const d = cv.toDataURL();
        for (let i = 0; i < d.length; i += 97) { h ^= d.charCodeAt(i); h = Math.imul(h, 16777619); }
      }
      canvasHash = (h >>> 0).toString(16);
    } catch (e) { dom = null; }
    let yAxis = null;
    try { const ys = c.getYAxes({ paneId: p.id }) ?? []; yAxis = ys.map((y) => ({ id: y.id, from: +Number(y.from).toFixed(8), to: +Number(y.to).toFixed(8) })); } catch { yAxis = null; }
    return { id: p.id, optH: p.height, minHeight: p.minHeight, state: p.state, dom, yAxis, canvasHash, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
  });
  const sample = (name) => {
    const ind = (c.getIndicators({ name }) ?? [])[0];
    const res = Array.isArray(ind?.result) ? ind.result : [];
    const keys = Array.from(new Set(res.flatMap((r) => Object.keys(r ?? {}))));
    const stat = {};
    for (const k of keys) {
      const vals = res.map((r) => r?.[k]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      stat[k] = { n: vals.length, min: vals.length ? +Math.min(...vals).toFixed(10) : null, max: vals.length ? +Math.max(...vals).toFixed(10) : null, head: vals.slice(0, 2).map((v) => +v.toFixed(10)), tail: vals.slice(-2).map((v) => +v.toFixed(10)) };
    }
    return { name, calcParams: ind?.calcParams, precision: ind?.precision, n: res.length, stat };
  };
  return {
    inits: window.__KC_INITS__ ?? 0, logLen: (window.__KC_LOG__ ?? []).length,
    panes, indicators: inds,
    dcap: sample('DCAP'), ma: sample('MA'), vol: sample('VOL'),
    logTail: (window.__KC_LOG__ ?? []).slice(-30),
  };
};

const rendered = (s) => Object.fromEntries(s.panes.filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.dom?.h ?? null]));
const ids = (s) => Object.fromEntries(s.panes.filter((p) => p.id !== 'x_axis_pane').map((p) => [p.indicators.join('+') || 'candle', p.id]));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });
await page.route('**/*', async (route, req) => {
  const m = req.method(); const u = req.url();
  if (m === 'GET') { await route.continue(); return; }
  if (m === 'PUT' && u.includes('/api/config/dcap')) {
    const body = req.postData() ?? '';
    out.putIntercepted.push({ method: m, url: u.replace(BASE, ''), body, action: 'fulfilled-locally-200-echo（未发往后端/DB）' });
    await route.fulfill({ status: 200, contentType: 'application/json', body }); return;
  }
  out.nonGetOther.push(`${m} ${u}`); await route.abort();
});

const dragSep = async (index, dy) => {
  const handle = await page.evaluate((idx) => {
    const kcRoot = document.querySelector('[data-testid="kline-chart"]').firstElementChild;
    const seps = Array.from(kcRoot.children).filter((el) => el.firstElementChild && el.firstElementChild.style.cursor === 'ns-resize');
    const r = seps[idx].firstElementChild.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, index);
  await page.mouse.move(handle.x, handle.y); await page.mouse.down();
  await page.mouse.move(handle.x, handle.y + dy, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(600);
};
const saveDcap = async (field, value) => {
  await page.getByRole('button', { name: 'DCAP 配置' }).click();
  await page.waitForSelector('[data-dcap-editor]', { timeout: 5000 });
  await page.fill(`[data-testid="dcap-input-${field}"]`, String(value));
  await page.locator('[data-dcap-editor] button:has-text("保存")').click();
  await page.waitForTimeout(1600);
};
const churnOf = (s, from) => s.logTail.filter((e) => e.seq >= from).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 120), stack: e.stack, panesBefore: e.panesBefore.map((p) => p.id + ':' + p.height), panesAfter: e.panesAfter.map((p) => p.id + ':' + p.height) }));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 40000 });
await page.waitForTimeout(4000);

// ── 0. mount：两段 burst（mount effect + deps effect），mount burst 含 setDataLoader/setSymbol ──
const mount = await page.evaluate(() => (window.__KC_LOG__ ?? []).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 60), stack: e.stack })));
out.scenarios.mount = { log: mount, inits: await page.evaluate(() => window.__KC_INITS__) };
const mountHasSelectors = mount.some((e) => e.api === 'setDataLoader') && mount.some((e) => e.api === 'setSymbol');
const firstSyncIdx = mount.findIndex((e) => e.api === 'removeIndicator');
out.mountBursts = {
  entriesBeforeFirstSync: mount.slice(0, firstSyncIdx).map((e) => e.api),
  removeCreateCount: mount.filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator').length,
  hasDataLoader: mountHasSelectors,
};

const s0 = await page.evaluate(PROBE);
out.scenarios.s0 = s0;
check('D0 初始内容 pane = candle+VOL', s0.panes.filter((p) => p.id !== 'x_axis_pane').length === 2, rendered(s0));

// ── A. DCAP 关态：拖高 VOL → 保存 r_s（warmup 不变） ──
await dragSep(0, -150);
const a1 = await page.evaluate(PROBE);
out.scenarios.a1_dragged = a1;
const a1r = rendered(a1), a1ids = ids(a1);
check('A1 拖高 VOL：渲染高度 100 → 237（+137px）', a1.panes.find((p) => p.indicators.includes('VOL')).dom.h > 220, a1r);

const logBeforeA = a1.logLen;
await saveDcap('r_s', '1.2');
const a2 = await page.evaluate(PROBE);
out.scenarios.a2_after_save = a2;
const a2r = rendered(a2), a2ids = ids(a2);
out.A = { before: a1r, after: a2r, idsBefore: a1ids, idsAfter: a2ids, inits: { before: a1.inits, after: a2.inits }, churn: churnOf(a2, logBeforeA), dcapIndCount: a2.indicators.filter((i) => i.name === 'DCAP').length };
check('A2 【缺陷复现】保存 DCAP 参数后 VOL pane 渲染高度被重置（237 → 100，−137px）', a1r['VOL'] === a2r['VOL'] + 0 || Math.abs((a2r['VOL'] ?? 0) - 100) <= 1, { before: a1r, after: a2r });
check('A3 【缺陷复现】VOL pane id 被更换（pane 被销毁重建）', a1ids['VOL'] !== a2ids['VOL'], { before: a1ids['VOL'], after: a2ids['VOL'], churn: out.A.churn.map((e) => e.api + e.arg.slice(0, 30)) });
check('A4 保存参数伴随 removeIndicator+createIndicator 序列', out.A.churn.some((e) => e.api === 'removeIndicator') && out.A.churn.some((e) => e.api === 'createIndicator'), out.A.churn.length);
check('A5 本次保存 init 次数不变 ⇒ 非整图 remount（路径 B 排除）', a1.inits === a2.inits, out.A.inits);
check('A6 该 burst 不含 setDataLoader/setSymbol ⇒ 非 mount effect（属 deps useEffect）', !out.A.churn.some((e) => e.api === 'setDataLoader' || e.api === 'setSymbol'), out.A.churn.map((e) => e.api));
check('A7 DCAP 关态保存参数不会误建 DCAP pane', out.A.dcapIndCount === 0, a2.indicators.map((i) => i.name));

// ── B. DCAP 开态：改 m（改变 warmup = n_l+m−1）⇒ 预期路径 B（feed 重建 → 整图 remount） ──
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2200);
const b1 = await page.evaluate(PROBE);
out.scenarios.b1_dcap_on = b1;
check('B1 DCAP 开 ⇒ 内容 pane 3', b1.panes.filter((p) => p.id !== 'x_axis_pane').length === 3, rendered(b1));
await dragSep(0, -150); // VOL 拖高
await dragSep(1, -100); // DCAP 拖高
const b2 = await page.evaluate(PROBE);
out.scenarios.b2_dragged = b2;
const b2r = rendered(b2);
const logBeforeB = b2.logLen, initBeforeB = b2.inits;
await saveDcap('m', '5'); // warmup 62 → 64
const b3 = await page.evaluate(PROBE);
out.scenarios.b3_after_save_m = b3;
const b3r = rendered(b3);
out.B = { before: b2r, after: b3r, idsBefore: ids(b2), idsAfter: ids(b3), inits: { before: initBeforeB, after: b3.inits }, churn: churnOf(b3, logBeforeB) };
check('B2 改 m（warmup 变）⇒ init 次数增加（整图 remount = 路径 B）', b3.inits > initBeforeB, out.B.inits);
check('B3 remount 后 pane id 集合全变、高度全回默认', JSON.stringify(out.B.idsBefore) !== JSON.stringify(out.B.idsAfter) && JSON.stringify(out.B.before) !== JSON.stringify(out.B.after), { before: out.B.before, after: out.B.after });

// ── C. DCAP 开态：改 r_m（warmup 不变）⇒ 路径 A（syncIndicators churn） ──
await dragSep(0, -150);
await dragSep(1, -100);
const c1 = await page.evaluate(PROBE);
out.scenarios.c1_dragged = c1;
const c1r = rendered(c1);
const logBeforeC = c1.logLen, initBeforeC = c1.inits;
await saveDcap('r_m', '1.5');
const c2 = await page.evaluate(PROBE);
out.scenarios.c2_after_save_rm = c2;
const c2r = rendered(c2);
out.C = { before: c1r, after: c2r, idsBefore: ids(c1), idsAfter: ids(c2), inits: { before: initBeforeC, after: c2.inits }, churn: churnOf(c2, logBeforeC) };
check('C1 改 r_m（warmup 不变）⇒ init 不变（路径 B 排除）', c2.inits === initBeforeC, out.C.inits);
check('C2 【缺陷复现】DCAP 开态保存参数同样重置既有 pane 渲染高度', JSON.stringify(out.C.before) !== JSON.stringify(out.C.after), { before: out.C.before, after: out.C.after });
check('C3 DCAP pane 被销毁重建（id 变化）', out.C.idsBefore['DCAP'] !== out.C.idsAfter['DCAP'], { before: out.C.idsBefore['DCAP'], after: out.C.idsAfter['DCAP'] });
check('C4 burst 不含 setDataLoader ⇒ deps useEffect（同一指纹）', !out.C.churn.some((e) => e.api === 'setDataLoader'), out.C.churn.map((e) => e.api));

// ── 归因指纹对照：指标勾选（确定是 deps useEffect） ──
const d0 = await page.evaluate(PROBE);
const logBeforeToggle = d0.logLen;
await page.getByRole('button', { name: 'KDJ', exact: true }).click();
await page.waitForTimeout(1400);
const d1 = await page.evaluate(PROBE);
out.scenarios.d1_toggle_kdj = d1;
out.toggleChurn = churnOf(d1, logBeforeToggle);
const fpSet = (arr) => Array.from(new Set(arr.map((e) => e.stack)));
out.fingerprints = {
  mount: fpSet(mount.filter((e) => e.api === 'removeIndicator')),
  saveA: fpSet(out.A.churn.filter((e) => e.api === 'removeIndicator')),
  saveC: fpSet(out.C.churn.filter((e) => e.api === 'removeIndicator')),
  toggle: fpSet(out.toggleChurn.filter((e) => e.api === 'removeIndicator')),
};
out.fingerprintMatch = {
  saveA_eq_toggle: out.fingerprints.saveA.some((x) => out.fingerprints.toggle.includes(x)),
  saveC_eq_toggle: out.fingerprints.saveC.some((x) => out.fingerprints.toggle.includes(x)),
  mount_eq_toggle: out.fingerprints.mount.some((x) => out.fingerprints.toggle.includes(x)),
};

// ── M. 机制微测（绕开 React）：destroy+recreate vs override ──
await page.getByRole('button', { name: 'KDJ', exact: true }).click();
await page.waitForTimeout(1200);
await dragSep(0, -150);
const m1 = await page.evaluate(PROBE);
out.scenarios.m1_dragged = m1;
out.M = { step1_before: rendered(m1) };
const m2 = await page.evaluate(() => {
  const charts = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  c.removeIndicator({ name: 'VOL' });
  c.createIndicator({ name: 'VOL' }, true);
  return true;
});
await page.waitForTimeout(900);
const m2s = await page.evaluate(PROBE);
out.scenarios.m2_after_manual_churn = m2s;
out.M.step2_after_remove_plus_create = rendered(m2s);
check('M1 【机制】手工 removeIndicator+createIndicator 即重置 pane 高度（与 React 无关）', JSON.stringify(out.M.step1_before['VOL']) !== JSON.stringify(out.M.step2_after_remove_plus_create['VOL']), out.M);
await dragSep(0, -150);
const m3 = await page.evaluate(PROBE);
out.M.step3_redragged = rendered(m3);
const m3state = await page.evaluate(() => {
  const charts = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  return c.overrideIndicator({ name: 'VOL', calcParams: [7, 21] });
});
await page.waitForTimeout(900);
const m4 = await page.evaluate(PROBE);
out.scenarios.m4_after_override = m4;
out.M.step4_after_override = rendered(m4);
out.M.overrideReturnValue = m3state;
check('M2 【机制】手工 overrideIndicator 不重置 pane 高度（高度保持）', JSON.stringify(out.M.step3_redragged['VOL']) === JSON.stringify(out.M.step4_after_override['VOL']) && out.M.step4_after_override['VOL'] > 200, out.M);

// ── E. overrideIndicator 可行性（DCAP/MA/VOL/MACD 开；含负控） ──
await page.getByRole('button', { name: 'MACD', exact: true }).click();
await page.waitForTimeout(1400);
await dragSep(0, -150);
await dragSep(1, 60);
const e1 = await page.evaluate(PROBE);
out.scenarios.e1_before_override = e1;
out.E = { before: { rendered: rendered(e1), ids: ids(e1), inits: e1.inits, dcap: e1.dcap, ma: e1.ma, vol: e1.vol, panes: e1.panes.map((p) => ({ id: p.id, yAxis: p.yAxis, canvasHash: p.canvasHash })) } };
const logBeforeE = e1.logLen;
const eCalls = await page.evaluate(() => {
  const charts = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const r = {};
  r.dcap = c.overrideIndicator({ name: 'DCAP', calcParams: [8, 26, 60, 1.3, 1, 1, 0, 3] });
  r.ma_paneIdless = c.overrideIndicator({ name: 'MA', calcParams: [7, 20, 60] });
  r.vol = c.overrideIndicator({ name: 'VOL', calcParams: [3, 9] });
  r.macd_enabled = c.overrideIndicator({ name: 'MACD', calcParams: [8, 17, 9] });
  r.kdj_disabled_negs = c.overrideIndicator({ name: 'KDJ', calcParams: [3, 3, 3] });
  r.nonexistent = c.overrideIndicator({ name: 'NOT_REGISTERED_IND' });
  return r;
});
await page.waitForTimeout(1400);
const e2 = await page.evaluate(PROBE);
out.scenarios.e2_after_override = e2;
out.overrideCalls = eCalls;
out.E.after = { rendered: rendered(e2), ids: ids(e2), inits: e2.inits, dcap: e2.dcap, ma: e2.ma, vol: e2.vol, panes: e2.panes.map((p) => ({ id: p.id, yAxis: p.yAxis, canvasHash: p.canvasHash })), indicatorSet: e2.indicators.map((i) => `${i.name}@${i.paneId}`) };
out.overrideChurn = churnOf(e2, logBeforeE);
out.overrideBeforeSet = e1.indicators.map((i) => `${i.name}@${i.paneId}`);

check('E1 override 后 pane 渲染高度全部不变（±1px）', JSON.stringify(out.E.before.rendered) === JSON.stringify(out.E.after.rendered), { before: out.E.before.rendered, after: out.E.after.rendered });
check('E2 override 后 pane id 集合不变（无 pane 销毁/重建）', JSON.stringify(out.E.before.ids) === JSON.stringify(out.E.after.ids), { before: out.E.before.ids, after: out.E.after.ids });
check('E3 override 后指标集合（name@paneId）不变、无新增 pane', JSON.stringify(out.overrideBeforeSet) === JSON.stringify(out.E.after.indicatorSet) && e2.panes.filter((p) => p.id !== 'x_axis_pane').length === e1.panes.filter((p) => p.id !== 'x_axis_pane').length, { before: out.overrideBeforeSet, after: out.E.after.indicatorSet });
check('E4 DCAP calcParams 已按新参数生效', JSON.stringify(out.E.after.dcap.calcParams) === JSON.stringify([8, 26, 60, 1.3, 1, 1, 0, 3]), out.E.after.dcap.calcParams);
check('E5 DCAP 三线 + zero 线值按新参数改变', JSON.stringify(out.E.before.dcap.stat) !== JSON.stringify(out.E.after.dcap.stat), { before: out.E.before.dcap.stat, after: out.E.after.dcap.stat });
check('E6 DCAP pane 渲染像素变化（canvas hash 变）', out.E.before.panes.find((p) => p.id === out.E.before.ids['DCAP'])?.canvasHash !== out.E.after.panes.find((p) => p.id === out.E.after.ids['DCAP'])?.canvasHash, { before: out.E.before.panes.find((p) => p.id === out.E.before.ids['DCAP'])?.canvasHash, after: out.E.after.panes.find((p) => p.id === out.E.after.ids['DCAP'])?.canvasHash });
check('E7 DCAP pane Y 轴随新值域重建（from/to 变）', JSON.stringify(out.E.before.panes.find((p) => p.id === out.E.before.ids['DCAP'])?.yAxis) !== JSON.stringify(out.E.after.panes.find((p) => p.id === out.E.after.ids['DCAP'])?.yAxis), { before: out.E.before.panes.find((p) => p.id === out.E.before.ids['DCAP'])?.yAxis, after: out.E.after.panes.find((p) => p.id === out.E.after.ids['DCAP'])?.yAxis });
check('E8 MA（candle_pane）override 生效（calcParams + 线值变）', JSON.stringify(out.E.after.ma.calcParams) === JSON.stringify([7, 20, 60]) && JSON.stringify(out.E.before.ma.stat) !== JSON.stringify(out.E.after.ma.stat), { cp: out.E.after.ma.calcParams, figKeys: out.E.after.ma.stat && Object.keys(out.E.after.ma.stat) });
check('E9 VOL（副图）override 生效（calcParams 变）', JSON.stringify(out.E.after.vol.calcParams) === JSON.stringify([3, 9]), out.E.after.vol.calcParams);
check('E10 MACD（已启用副图）override 生效', JSON.stringify(out.E.after.indicatorSet) === JSON.stringify(out.overrideBeforeSet), out.E.after.indicatorSet);
check('E11 负控：未启用指标 KDJ override 不创建 indicator/pane', !out.E.after.indicatorSet.some((x) => x.startsWith('KDJ@')), out.E.after.indicatorSet.filter((x) => x.startsWith('KDJ')));
check('E12 负控：不存在指标 override 无副作用', !out.E.after.indicatorSet.some((x) => x.startsWith('NOT_REGISTERED_IND')), out.E.after.indicatorSet);
check('E13 override 未触发 init（无整图重建）', out.E.after.inits === out.E.before.inits, { before: out.E.before.inits, after: out.E.after.inits });
check('E14 override 未发出任何非 GET 请求（无写盘/写库）', out.nonGetOther.length === 0, out.nonGetOther);
out.overrideReturnValues_note = '库事实：仅 calc 变化时 ChartImp.overrideIndicator 返回 false（index.esm.js:15296-15318：updated 只在 draw/sort 置位）⇒ 返回值不可用作成功判据；改用状态/线值/pane 高度判定。';

out.pageErrors = pageErrors;
fs.writeFileSync(`${OUT}/probe2.json`, JSON.stringify(out, null, 1));
console.log('checks:', out.checks.filter((c) => c.ok).length, '/', out.checks.length, 'passed');
for (const c of out.checks) console.log(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}`);
console.log('\nA:', JSON.stringify(out.A.before), '→', JSON.stringify(out.A.after), 'inits', JSON.stringify(out.A.inits));
console.log('B:', JSON.stringify(out.B.before), '→', JSON.stringify(out.B.after), 'inits', JSON.stringify(out.B.inits));
console.log('C:', JSON.stringify(out.C.before), '→', JSON.stringify(out.C.after), 'inits', JSON.stringify(out.C.inits));
console.log('M:', JSON.stringify(out.M));
console.log('fingerprintMatch:', JSON.stringify(out.fingerprintMatch));
console.log('overrideCalls:', JSON.stringify(out.overrideCalls));
console.log('override rendered:', JSON.stringify(out.E.before.rendered), '→', JSON.stringify(out.E.after.rendered));
console.log('override churn apis:', JSON.stringify(out.overrideChurn.map((e) => e.api)));
console.log('putIntercepted:', out.putIntercepted.length, JSON.stringify(out.putIntercepted.map((p) => p.body)));
console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 5)));
await browser.close();
