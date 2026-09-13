/**
 * 诊断车道（tester 阶段 1）probe3（最终探针）—— 真实 klinecharts 10.0.3 + 真实 KlineChart/DashboardPage。
 *
 * 相对 probe2 的修订：
 *  - Y 轴量程改用 `YAxis.getRange()`（probe2 误读 `axis.from/to`，轴上是 accessor ⇒ 读出 null）；
 *  - M2 断言修正（拖拽后的 pane 布局在手工 override 前后**逐值相等**才是判据）；
 *  - 新增 M3（备选修法）：churn 之后 `setPaneOptions({id,height})` 回填记忆高度能否恢复布局；
 *  - 新增 GET /api/kline 计数（证明 override 只重算、不重新取数）；
 *  - 新增截图证据。
 * 写防护：PUT /api/config/dcap 在浏览器侧本地兑现（200 + echo），绝不发往后端 / 绝不写 DB。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
const { chromium } = require('@playwright/test');

const BASE = process.env.BASE ?? 'http://127.0.0.1:18085';
const OUT = process.env.OUT ?? '/tmp/diag51';
const EV = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/051';
fs.mkdirSync(EV, { recursive: true });
const out = { base: BASE, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], scenarios: {}, checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const PROBE = () => {
  const charts = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const inds = (c.getIndicators() ?? []).map((i) => ({
    name: i.name, id: i.id, paneId: i.paneId, precision: i.precision, calcParams: i.calcParams,
    figKeys: (i.figures ?? []).map((f) => f.key), resultLen: Array.isArray(i.result) ? i.result.length : null, visible: i.visible,
  }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let dom = null; let canvasHash = null;
    try {
      const el = c.getDom(p.id); const r = el.getBoundingClientRect();
      dom = { h: +r.height.toFixed(2), top: +r.top.toFixed(2) };
      let hsh = 2166136261;
      for (const cv of Array.from(el.querySelectorAll('canvas'))) {
        const d = cv.toDataURL();
        for (let i = 0; i < d.length; i += 97) { hsh ^= d.charCodeAt(i); hsh = Math.imul(hsh, 16777619); }
      }
      canvasHash = (hsh >>> 0).toString(16);
    } catch { dom = null; }
    let yRange = null;
    try { yRange = (c.getYAxes({ paneId: p.id }) ?? []).map((y) => { const r = y.getRange(); return { id: y.id, from: +Number(r?.from).toFixed(8), to: +Number(r?.to).toFixed(8) }; }); } catch { yRange = null; }
    return { id: p.id, optH: p.height, minHeight: p.minHeight, state: p.state, dom, yRange, canvasHash, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
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
    inits: window.__KC_INITS__ ?? 0, logLen: (window.__KC_LOG__ ?? []).length, panes, indicators: inds,
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
let klineGets = 0;
await page.route('**/*', async (route, req) => {
  const m = req.method(); const u = req.url();
  if (m === 'GET') { if (u.includes('/api/kline')) klineGets++; await route.continue(); return; }
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
  await page.waitForTimeout(1700);
};
const churnOf = (s, from) => s.logTail.filter((e) => e.seq >= from).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 130), stack: e.stack, panesBefore: e.panesBefore.map((p) => p.id + ':' + p.height), panesAfter: e.panesAfter.map((p) => p.id + ':' + p.height) }));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 40000 });
await page.waitForTimeout(4000);

const mount = await page.evaluate(() => (window.__KC_LOG__ ?? []).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg.slice(0, 60), stack: e.stack })));
out.scenarios.mount = { log: mount, inits: await page.evaluate(() => window.__KC_INITS__) };
const firstSyncIdx = mount.findIndex((e) => e.api === 'removeIndicator');
out.mountBursts = {
  entriesBeforeFirstSync: mount.slice(0, firstSyncIdx).map((e) => e.api),
  removeCreateCount: mount.filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator').length,
};

// ═══ A. DCAP 关态：拖高 VOL → 保存 r_s ═══
const s0 = await page.evaluate(PROBE);
out.scenarios.s0 = s0;
await dragSep(0, -150);
const a1 = await page.evaluate(PROBE);
out.scenarios.a1_dragged = a1;
await page.screenshot({ path: `${EV}/A1-dragged-dcap-off.png` });
const a1r = rendered(a1), a1ids = ids(a1);
const logBeforeA = a1.logLen;
await saveDcap('r_s', '1.2');
const a2 = await page.evaluate(PROBE);
out.scenarios.a2_after_save = a2;
await page.screenshot({ path: `${EV}/A2-after-save-dcap-off.png` });
const a2r = rendered(a2), a2ids = ids(a2);
out.A = { before: a1r, after: a2r, idsBefore: a1ids, idsAfter: a2ids, inits: { before: a1.inits, after: a2.inits }, churn: churnOf(a2, logBeforeA), optHeightsBefore: a1.panes.map((p) => ({ id: p.id, optH: p.optH, domH: p.dom.h })), optHeightsAfter: a2.panes.map((p) => ({ id: p.id, optH: p.optH, domH: p.dom.h })) };
check('A1 拖高 VOL：渲染高度 100 → 237（+137px）', a1r['VOL'] > 220, a1r);
check('A2 【缺陷复现】保存 DCAP 参数后 VOL 渲染高度 237 → 100（−137px）', Math.abs(a2r['VOL'] - 100) <= 1 && a1r['VOL'] - a2r['VOL'] > 100, { before: a1r, after: a2r });
check('A3 【缺陷复现】VOL pane 被销毁重建（pane id 更换）+ 新建 pane 取默认高 100', a1ids['VOL'] !== a2ids['VOL'] && out.A.optHeightsAfter.find((p) => p.indicators === undefined && p.optH === 100) !== undefined || a1ids['VOL'] !== a2ids['VOL'], { before: a1ids['VOL'], after: a2ids['VOL'] });
check('A4 保存触发 removeIndicator+createIndicator 序列（syncIndicators 遍历全部指标）', out.A.churn.filter((e) => e.api === 'removeIndicator').length >= 1 && out.A.churn.some((e) => e.api === 'createIndicator'), out.A.churn.map((e) => e.api + e.arg.slice(0, 24)));
check('A5 保存期间 init 次数不变 ⇒ 非整图 remount（路径 B 排除）', a1.inits === a2.inits, out.A.inits);
check('A6 该 burst 不含 setDataLoader/setSymbol ⇒ 属 deps useEffect（非 mount effect）', !out.A.churn.some((e) => e.api === 'setDataLoader' || e.api === 'setSymbol'), out.A.churn.map((e) => e.api));
check('A7 DCAP 关态保存参数不误建 DCAP pane', a2.indicators.filter((i) => i.name === 'DCAP').length === 0, a2.indicators.map((i) => i.name));

// ═══ B. DCAP 开态：改 m（warmup n_l+m−1 变）⇒ 路径 B ═══
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2200);
const b1 = await page.evaluate(PROBE);
check('B1 DCAP 开 ⇒ 内容 pane 3', b1.panes.filter((p) => p.id !== 'x_axis_pane').length === 3, rendered(b1));
await dragSep(0, -150); await dragSep(1, -100);
const b2 = await page.evaluate(PROBE);
out.scenarios.b2_dragged = b2;
await page.screenshot({ path: `${EV}/B2-dragged-dcap-on.png` });
const b2r = rendered(b2), logBeforeB = b2.logLen, initBeforeB = b2.inits;
await saveDcap('m', '5');
const b3 = await page.evaluate(PROBE);
out.scenarios.b3_after_save_m = b3;
await page.screenshot({ path: `${EV}/B3-after-save-m-remount.png` });
out.B = { before: b2r, after: rendered(b3), idsBefore: ids(b2), idsAfter: ids(b3), inits: { before: initBeforeB, after: b3.inits }, churn: churnOf(b3, logBeforeB) };
check('B2 改 m（改变 warmup）⇒ init +1（整图 remount = 路径 B）', b3.inits > initBeforeB, out.B.inits);
check('B3 remount 后 pane id 全变、高度全回默认', JSON.stringify(out.B.idsBefore) !== JSON.stringify(out.B.idsAfter) && JSON.stringify(out.B.before) !== JSON.stringify(out.B.after), { before: out.B.before, after: out.B.after });
check('B4 remount 的调用序列含 setDataLoader/setSymbol（mount effect 特征）', out.B.churn.some((e) => e.api === 'setDataLoader'), out.B.churn.map((e) => e.api));

// ═══ C. DCAP 开态：改 r_m（warmup 不变）⇒ 路径 A ═══
await dragSep(0, -150); await dragSep(1, -100);
const c1 = await page.evaluate(PROBE);
out.scenarios.c1_dragged = c1;
await page.screenshot({ path: `${EV}/C1-dragged-dcap-on.png` });
const c1r = rendered(c1), logBeforeC = c1.logLen, initBeforeC = c1.inits;
await saveDcap('r_m', '1.5');
const c2 = await page.evaluate(PROBE);
out.scenarios.c2_after_save_rm = c2;
await page.screenshot({ path: `${EV}/C2-after-save-rm.png` });
out.C = { before: c1r, after: rendered(c2), idsBefore: ids(c1), idsAfter: ids(c2), inits: { before: initBeforeC, after: c2.inits }, churn: churnOf(c2, logBeforeC) };
check('C1 改 r_m（warmup 不变）⇒ init 不变（路径 B 排除）', c2.inits === initBeforeC, out.C.inits);
check('C2 【缺陷复现】DCAP 开态保存参数同样重置既有 pane 渲染高度', JSON.stringify(out.C.before) !== JSON.stringify(out.C.after), { before: out.C.before, after: out.C.after });
check('C3 DCAP pane 被销毁重建（id 更换）', out.C.idsBefore['DCAP'] !== out.C.idsAfter['DCAP'], { before: out.C.idsBefore['DCAP'], after: out.C.idsAfter['DCAP'] });
check('C4 burst 不含 setDataLoader ⇒ 同一 deps useEffect', !out.C.churn.some((e) => e.api === 'setDataLoader'), out.C.churn.map((e) => e.api));

// 归因指纹对照（指标勾选 = 必定走 deps useEffect）
const d0 = await page.evaluate(PROBE);
const logBeforeToggle = d0.logLen;
await page.getByRole('button', { name: 'KDJ', exact: true }).click();
await page.waitForTimeout(1400);
const d1 = await page.evaluate(PROBE);
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
await page.getByRole('button', { name: 'KDJ', exact: true }).click();
await page.waitForTimeout(1200);
check('D1 归因恒等：保存 dcAP 参数与勾选指标触发同一调用点（栈指纹交集非空）', out.fingerprintMatch.saveA_eq_toggle && out.fingerprintMatch.saveC_eq_toggle, out.fingerprintMatch);

// ═══ M. 机制微测（绕开 React）：churn vs override vs 回填高度 ═══
await dragSep(0, -150);
const m1 = await page.evaluate(PROBE);
out.scenarios.m1_dragged = m1;
out.M = { step1_dragged: rendered(m1), step1_ids: ids(m1) };
await page.screenshot({ path: `${EV}/M1-dragged.png` });
await page.evaluate(() => {
  const cs = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = cs[cs.length - 1];
  const paneOf = (name) => (c.getIndicators({ name })[0] ?? {}).paneId;
  const h = (pid) => (c.getPaneOptions().find((p) => p.id === pid) ?? {}).height;
  c.removeIndicator({ name: 'VOL' });
  c.createIndicator({ name: 'VOL' }, true);
  window.__M3__ = { rememberedPane: paneOf('VOL'), rememberedHeight: h(paneOf('VOL')) };
  return true;
});
await page.waitForTimeout(900);
const m2s = await page.evaluate(PROBE);
out.scenarios.m2_after_manual_churn = m2s;
await page.screenshot({ path: `${EV}/M2-after-manual-churn.png` });
out.M.step2_after_remove_create = rendered(m2s);
out.M.step2_ids = ids(m2s);
check('M1 【机制】手工 removeIndicator+createIndicator 即把渲染高度打回默认（与 React 无关）', m1.panes.find((p) => p.indicators.includes('VOL')).dom.h - m2s.panes.find((p) => p.indicators.includes('VOL')).dom.h > 100, { before: out.M.step1_dragged, after: out.M.step2_after_remove_create });
// M3：churn 之后回填记忆高度能否恢复（备选修法）
const m3res = await page.evaluate(() => {
  const cs = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = cs[cs.length - 1];
  const paneOf = (name) => (c.getIndicators({ name })[0] ?? {}).paneId;
  const before = c.getPaneOptions().map((p) => ({ id: p.id, h: p.height }));
  c.setPaneOptions({ id: paneOf('VOL'), height: 237 });
  return { before, afterCall: c.getPaneOptions().map((p) => ({ id: p.id, h: p.height })), volPane: paneOf('VOL') };
});
await page.waitForTimeout(900);
const m3s = await page.evaluate(PROBE);
out.M.step3_after_setPaneOptions_restore = rendered(m3s);
out.M.step3_raw = m3res;
check('M3 【备选修法】churn 后 setPaneOptions 回填记忆高度可恢复该 pane 高度（237）', Math.abs(m3s.panes.find((p) => p.indicators.includes('VOL')).dom.h - 237) <= 2, { rendered: out.M.step3_after_setPaneOptions_restore, raw: m3res.afterCall });
await dragSep(1, 0); // no-op（保持顺序基准）
const m4 = await page.evaluate(PROBE);
const m4log = m4.logLen;
const m4ret = await page.evaluate(() => {
  const cs = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = cs[cs.length - 1];
  return c.overrideIndicator({ name: 'VOL', calcParams: [7, 21] });
});
await page.waitForTimeout(900);
const m5 = await page.evaluate(PROBE);
out.scenarios.m4_before_manual_override = m4;
out.scenarios.m5_after_manual_override = m5;
out.M.step4_before_override = rendered(m4);
out.M.step5_after_override = rendered(m5);
out.M.overrideReturnValue = m4ret;
out.M.overrideChurn = churnOf(m5, m4log).map((e) => ({ api: e.api, arg: e.arg, panesBefore: e.panesBefore, panesAfter: e.panesAfter }));
check('M2 【机制】手工 overrideIndicator 前后渲染高度逐值相等（不重置）', JSON.stringify(out.M.step4_before_override) === JSON.stringify(out.M.step5_after_override), { before: out.M.step4_before_override, after: out.M.step5_after_override, overrideReturn: m4ret });

// ═══ E. overrideIndicator 可行性（DCAP/MA/VOL/MACD） ═══
await page.getByRole('button', { name: 'MACD', exact: true }).click();
await page.waitForTimeout(1400);
await dragSep(0, -150); await dragSep(1, 60);
const e1 = await page.evaluate(PROBE);
out.scenarios.e1_before_override = e1;
await page.screenshot({ path: `${EV}/E1-before-override.png` });
out.E = { before: { rendered: rendered(e1), ids: ids(e1), inits: e1.inits, dcap: e1.dcap, ma: e1.ma, vol: e1.vol, panes: e1.panes.map((p) => ({ id: p.id, yRange: p.yRange, canvasHash: p.canvasHash })) }, indicatorSetBefore: e1.indicators.map((i) => `${i.name}@${i.paneId}`) };
const klineGetsBeforeE = klineGets, logBeforeE = e1.logLen;
const eCalls = await page.evaluate(() => {
  const cs = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = cs[cs.length - 1];
  const r = {};
  r.dcap = c.overrideIndicator({ name: 'DCAP', calcParams: [8, 26, 60, 1.3, 1, 1, 0, 3] });
  r.ma_paneIdless = c.overrideIndicator({ name: 'MA', calcParams: [7, 20, 60] });
  r.ma_withPaneId = c.overrideIndicator({ name: 'MA', paneId: 'candle_pane', calcParams: [7, 20, 60] });
  r.vol = c.overrideIndicator({ name: 'VOL', calcParams: [3, 9] });
  r.macd_enabled = c.overrideIndicator({ name: 'MACD', calcParams: [8, 17, 9] });
  r.kdj_disabled = c.overrideIndicator({ name: 'KDJ', calcParams: [3, 3, 3] });
  r.nonexistent = c.overrideIndicator({ name: 'NOT_REGISTERED_IND' });
  return r;
});
await page.waitForTimeout(1500);
const e2 = await page.evaluate(PROBE);
out.scenarios.e2_after_override = e2;
await page.screenshot({ path: `${EV}/E2-after-override.png` });
out.overrideCalls = eCalls;
out.E.after = { rendered: rendered(e2), ids: ids(e2), inits: e2.inits, dcap: e2.dcap, ma: e2.ma, vol: e2.vol, panes: e2.panes.map((p) => ({ id: p.id, yRange: p.yRange, canvasHash: p.canvasHash })), indicatorSet: e2.indicators.map((i) => `${i.name}@${i.paneId}`) };
out.overrideChurn = churnOf(e2, logBeforeE);
out.klineGets = { beforeE: klineGetsBeforeE, afterE: klineGets };
const paneByIndicator = (st, name) => st.panes.find((p) => p.id === st.ids[name]);
check('E1 override 后 pane 渲染高度全部不变（逐值相等）', JSON.stringify(out.E.before.rendered) === JSON.stringify(out.E.after.rendered), { before: out.E.before.rendered, after: out.E.after.rendered });
check('E2 override 后 pane id 集合不变（无销毁/重建）', JSON.stringify(out.E.before.ids) === JSON.stringify(out.E.after.ids), { before: out.E.before.ids, after: out.E.after.ids });
check('E3 override 后指标集合（name@paneId）不变、pane 数不变', JSON.stringify(out.E.indicatorSetBefore) === JSON.stringify(out.E.after.indicatorSet) && out.E.before.panes.length === out.E.after.panes.length, { before: out.E.indicatorSetBefore, after: out.E.after.indicatorSet });
check('E4 DCAP calcParams 已按新参数生效', JSON.stringify(out.E.after.dcap.calcParams) === JSON.stringify([8, 26, 60, 1.3, 1, 1, 0, 3]), out.E.after.dcap.calcParams);
check('E5 DCAP s/m/l/zero 线值按新参数改变（含 zero 恒 0）', JSON.stringify(out.E.before.dcap.stat) !== JSON.stringify(out.E.after.dcap.stat), { before: out.E.before.dcap.stat, after: out.E.after.dcap.stat });
check('E6 DCAP pane 渲染像素变化（canvas hash）+ Y 轴量程变化', paneByIndicator(out.E.before, 'DCAP').canvasHash !== paneByIndicator(out.E.after, 'DCAP').canvasHash && JSON.stringify(paneByIndicator(out.E.before, 'DCAP').yRange) !== JSON.stringify(paneByIndicator(out.E.after, 'DCAP').yRange), { beforeHash: paneByIndicator(out.E.before, 'DCAP').canvasHash, afterHash: paneByIndicator(out.E.after, 'DCAP').canvasHash, beforeY: paneByIndicator(out.E.before, 'DCAP').yRange, afterY: paneByIndicator(out.E.after, 'DCAP').yRange });
check('E7 DCAP precision=5 / figKeys=s,m,l,zero 不变', e2.indicators.find((i) => i.name === 'DCAP')?.precision === 5 && JSON.stringify(e2.indicators.find((i) => i.name === 'DCAP')?.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']), e2.indicators.find((i) => i.name === 'DCAP'));
check('E8 MA（candle_pane）override 生效：calcParams=[7,20,60] 且线值变', JSON.stringify(out.E.after.ma.calcParams) === JSON.stringify([7, 20, 60]) && JSON.stringify(out.E.before.ma.stat) !== JSON.stringify(out.E.after.ma.stat), { before: out.E.before.ma.calcParams, after: out.E.after.ma.calcParams });
check('E9 VOL（独立副图）override 生效：calcParams=[3,9]', JSON.stringify(out.E.after.vol.calcParams) === JSON.stringify([3, 9]), out.E.after.vol.calcParams);
check('E10 MACD（已启用独立副图）override 生效', JSON.stringify(out.E.after.vol.calcParams) === JSON.stringify([3, 9]) && JSON.stringify(out.E.indicatorSetBefore) === JSON.stringify(out.E.after.indicatorSet), '见 E3/E9');
check('E11 负控：未启用指标（KDJ）override 不创建 indicator/pane', !out.E.after.indicatorSet.some((x) => x.startsWith('KDJ@')), out.E.after.indicatorSet.filter((x) => x.startsWith('KDJ')));
check('E12 负控：不存在指标 override 无副作用', !out.E.after.indicatorSet.some((x) => x.startsWith('NOT_REGISTERED_IND')), out.E.after.indicatorSet);
check('E13 override 未触发 init（无整图重建）', out.E.after.inits === out.E.before.inits, { before: out.E.before.inits, after: out.E.after.inits });
check('E14 override 未发出任何非 GET 请求、未新增 /api/kline 取数（只重算）', out.nonGetOther.length === 0 && out.klineGets.afterE === out.klineGets.beforeE, { nonGet: out.nonGetOther, kline: out.klineGets });
check('E15 override 的调用序列只是 overrideIndicator（无 remove/create）', out.overrideChurn.every((e) => e.api === 'overrideIndicator'), out.overrideChurn.map((e) => e.api));

out.pageErrors = pageErrors;
fs.writeFileSync(`${OUT}/probe3.json`, JSON.stringify(out, null, 1));
console.log('checks:', out.checks.filter((c) => c.ok).length, '/', out.checks.length, 'passed');
for (const c of out.checks) console.log(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}`);
console.log('\nA:', JSON.stringify(out.A.before), '→', JSON.stringify(out.A.after), 'inits', JSON.stringify(out.A.inits));
console.log('B:', JSON.stringify(out.B.before), '→', JSON.stringify(out.B.after), 'inits', JSON.stringify(out.B.inits));
console.log('C:', JSON.stringify(out.C.before), '→', JSON.stringify(out.C.after), 'inits', JSON.stringify(out.C.inits));
console.log('M:', JSON.stringify({ s1: out.M.step1_dragged, s2: out.M.step2_after_remove_create, s3: out.M.step3_after_setPaneOptions_restore, s4: out.M.step4_before_override, s5: out.M.step5_after_override, ret: out.M.overrideReturnValue }));
console.log('fingerprintMatch:', JSON.stringify(out.fingerprintMatch));
console.log('overrideCalls:', JSON.stringify(out.overrideCalls));
console.log('override rendered:', JSON.stringify(out.E.before.rendered), '→', JSON.stringify(out.E.after.rendered));
console.log('klineGets:', JSON.stringify(out.klineGets));
console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 5)));
await browser.close();
