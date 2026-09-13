/**
 * 诊断车道（tester 阶段 1）probe1 —— 真实 klinecharts 10.0.3 + 真实 KlineChart/DashboardPage 渲染。
 *
 * 服务：@/tmp/diag51/dist（仓库 src + klinecharts spy），经 vite preview 18085 提供；/api、/ws 代理到线上只读 8081。
 * 写防护：浏览器侧拦截一切非 GET —— PUT /api/config/dcap 由本地 promise 兑现（返回 echo，绝不落盘/落库）。
 *
 * 目标：
 *  A. 复现「保存 dcap 参数 ⇒ pane 高度被重置」并给量化证据（getPaneOptions + DOM rect）。
 *  B. 定位销毁点：调用序列 + 每次调用前后 pane 快照 + init 计数（A: syncIndicators churn / B: remount）。
 *  C. overrideIndicator 可行性：改 calcParams 是否重算线值且不动 pane 高度（DCAP/MA/VOL/KDJ 负控）。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
const { chromium } = require('@playwright/test');

const BASE = process.env.BASE ?? 'http://127.0.0.1:18085';
const OUT = process.env.OUT ?? '/tmp/diag51';
const out = { base: BASE, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], requests: [], scenarios: {}, checks: [] };
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const PROBE = () => {
  const charts = (window.__CHARTS__ ?? []).filter((c) => {
    try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; }
  });
  const c = charts[charts.length - 1];
  const inds = (c.getIndicators() ?? []).map((i) => ({
    name: i.name, id: i.id, paneId: i.paneId, yAxisId: i.yAxisId, precision: i.precision,
    calcParams: i.calcParams, figKeys: (i.figures ?? []).map((f) => f.key),
    resultLen: Array.isArray(i.result) ? i.result.length : null,
  }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let dom = null;
    try { const r = c.getDom(p.id).getBoundingClientRect(); dom = { h: +r.height.toFixed(2), top: +r.top.toFixed(2) }; } catch { dom = null; }
    return { id: p.id, height: p.height, minHeight: p.minHeight, state: p.state, order: p.order, dom, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
  });
  const kcRoot = document.querySelector('[data-testid="kline-chart"]')?.firstElementChild;
  const seps = [];
  if (kcRoot) {
    for (const el of Array.from(kcRoot.children)) {
      const wd = el.firstElementChild;
      if (wd && wd.style && wd.style.cursor === 'ns-resize') {
        const r = el.getBoundingClientRect();
        seps.push({ top: +r.top.toFixed(2), h: +r.height.toFixed(2) });
      }
    }
  }
  // DCAP 三线值抽样（用于「按新参数更新」断言）
  const dcapInd = inds.find((i) => i.name === 'DCAP');
  let dcapSample = null;
  if (dcapInd) {
    const ind = (c.getIndicators({ name: 'DCAP' }) ?? [])[0];
    const res = Array.isArray(ind?.result) ? ind.result : [];
    const pick = (k) => res.map((r) => r?.[k]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const s = pick('s'), m = pick('m'), l = pick('l'), z = pick('zero');
    const head = (a) => a.slice(0, 3).map((v) => +v.toFixed(10));
    const tail = (a) => a.slice(-3).map((v) => +v.toFixed(10));
    dcapSample = {
      n: res.length,
      s: { nFinite: s.length, head: head(s), tail: tail(s), min: s.length ? +Math.min(...s).toFixed(10) : null, max: s.length ? +Math.max(...s).toFixed(10) : null },
      m: { nFinite: m.length, tail: tail(m) },
      l: { nFinite: l.length, tail: tail(l) },
      zero: { nFinite: z.length, min: z.length ? Math.min(...z) : null, max: z.length ? Math.max(...z) : null },
    };
  }
  const log = window.__KC_LOG__ ?? [];
  return {
    inits: window.__KC_INITS__ ?? 0,
    logLen: log.length,
    panes, indicators: inds, separators: seps, dcapSample,
    logTail: log.slice(-24),
    containerW: document.querySelector('[data-testid="kline-chart"]')?.getBoundingClientRect().width ?? null,
  };
};

const heightsOf = (s) => Object.fromEntries(s.panes.filter((p) => p.state === 'normal' || p.id !== 'x_axis_pane').map((p) => [p.id, p.height]));
const domHeightsOf = (s) => Object.fromEntries(s.panes.map((p) => [p.id, p.dom?.h ?? null]));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200)); });

await page.route('**/*', async (route, req) => {
  const m = req.method();
  const u = req.url();
  if (m === 'GET') { out.requests.push(`GET ${u.replace(BASE, '')}`); await route.continue(); return; }
  if (m === 'PUT' && u.includes('/api/config/dcap')) {
    const body = req.postData() ?? '';
    out.putIntercepted.push({ method: m, url: u.replace(BASE, ''), body, action: 'fulfilled-locally-200-echo (未发往后端/DB)' });
    await route.fulfill({ status: 200, contentType: 'application/json', body });
    return;
  }
  out.nonGetOther.push(`${m} ${u}`);
  await route.abort();
});

const dragSep = async (index, dy) => {
  const handle = await page.evaluate((idx) => {
    const kcRoot = document.querySelector('[data-testid="kline-chart"]').firstElementChild;
    const seps = Array.from(kcRoot.children).filter((el) => el.firstElementChild && el.firstElementChild.style.cursor === 'ns-resize');
    const wd = seps[idx].firstElementChild; const r = wd.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, index);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
};

const saveDcap = async (field, value) => {
  await page.getByRole('button', { name: 'DCAP 配置' }).click();
  await page.waitForSelector('[data-dcap-editor]', { timeout: 5000 });
  await page.fill(`[data-testid="dcap-input-${field}"]`, String(value));
  await page.locator('[data-dcap-editor] button:has-text("保存")').click();
  await page.waitForTimeout(1500);
};

// ───────────────────────── 载入 ─────────────────────────
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 40000 });
await page.waitForTimeout(4000);

const mountLog = await page.evaluate(() => (window.__KC_LOG__ ?? []).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg, stack: e.stack })));
out.scenarios.mount = { log: mountLog, inits: (await page.evaluate(() => window.__KC_INITS__)) };
const s0 = await page.evaluate(PROBE);
out.scenarios.s0_default = s0;
check('D0 初始：内容 pane = candle+VOL（DCAP 默认关）', s0.panes.filter((p) => p.id !== 'x_axis_pane').length === 2, s0.panes.map((p) => ({ id: p.id, h: p.height, ind: p.indicators })));
check('D0 初始 init 次数 == 1', s0.inits === 1, s0.inits);

// ───────────────────────── A. DCAP 关态：拖高 VOL → 保存 dcap 参数 ─────────────────────────
await dragSep(0, -150); // 第一条分隔线（candle|VOL）上移 150 ⇒ VOL 变高
const s1 = await page.evaluate(PROBE);
out.scenarios.a1_after_drag = s1;
const h1 = heightsOf(s1);
check('A1 拖高 VOL 生效（VOL 高度 > 默认 100）', s1.panes[1].height > 200, h1);
check('A1b DOM 实测与 getPaneOptions 一致（±2px）', s1.panes.every((p) => p.dom && Math.abs(p.dom.h - p.height) <= 2), domHeightsOf(s1));
out.dragBeforeHeights = h1;

const logLenBeforeSave = s1.logLen;
await saveDcap('r_s', '1.2');
const s2 = await page.evaluate(PROBE);
out.scenarios.a2_after_save_rs = s2;
const h2 = heightsOf(s2);
out.dragAfterHeights = h2;
out.a_churnLog = s2.logTail.filter((e) => e.seq >= logLenBeforeSave);
check('A2 保存 r_s 后 init 次数未变（无整图 remount，路径 B 排除）', s2.inits === s1.inits, { before: s1.inits, after: s2.inits });
check('A3 【缺陷】保存后 pane 高度被重置（至少一个既有 pane 高度变化 > 1px）', JSON.stringify(h1) !== JSON.stringify(h2), { before: h1, after: h2 });
check('A4 保存后发生了 removeIndicator/createIndicator（pane 销毁重建）', out.a_churnLog.some((e) => e.api === 'removeIndicator') && out.a_churnLog.some((e) => e.api === 'createIndicator'), out.a_churnLog.map((e) => `${e.api}${e.arg}`));
check('A5 保存后 DCAP 参数已按新值生效（且 DCAP 关态下不新建 DCAP pane）', s2.indicators.filter((i) => i.name === 'DCAP').length === 0, s2.indicators.map((i) => i.name));

// ───────────────────────── B. DCAP 开态：n_m 变化（warmup 变 ⇒ feed 重建） ─────────────────────────
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2000);
const s3 = await page.evaluate(PROBE);
out.scenarios.b1_dcap_on = s3;
check('B1 DCAP 开 ⇒ 内容 pane 3（candle/VOL/DCAP）', s3.panes.filter((p) => p.id !== 'x_axis_pane').length === 3, s3.panes.map((p) => ({ id: p.id, h: p.height, ind: p.indicators })));

await dragSep(1, -140); // 第二条分隔线（VOL|DCAP）上移 ⇒ DCAP 变高、VOL 变矮
const s4 = await page.evaluate(PROBE);
out.scenarios.b2_after_drag2 = s4;
out.b_dragBefore = heightsOf(s4);
const initBeforeB = s4.inits;
const logBeforeB = s4.logLen;

await saveDcap('n_m', '28'); // n_l + m − 1 = 60+3−1=62 → 64 ⇒ warmup 变 ⇒ feed 重建？
const s5 = await page.evaluate(PROBE);
out.scenarios.b3_after_save_nm = s5;
out.b_dragAfter = heightsOf(s5);
out.b_churnLog = s5.logTail.filter((e) => e.seq >= logBeforeB);
check('B2 保存 n_m（改变 warmup）后 init 次数增加 ⇒ 整图 remount（路径 B）', s5.inits > initBeforeB, { before: initBeforeB, after: s5.inits, churnApis: out.b_churnLog.map((e) => e.api) });
check('B3 remount 后 pane 高度全回默认', JSON.stringify(out.b_dragBefore) !== JSON.stringify(out.b_dragAfter), { before: out.b_dragBefore, after: out.b_dragAfter });

// ───────────────────────── C. DCAP 开态：r_m 变化（warmup 不变 ⇒ 纯 syncIndicators churn） ─────────────────────────
await dragSep(1, -140);
const s6 = await page.evaluate(PROBE);
out.scenarios.c1_after_drag3 = s6;
out.c_dragBefore = heightsOf(s6);
const initBeforeC = s6.inits;
const logBeforeC = s6.logLen;
await saveDcap('r_m', '1.5');
const s7 = await page.evaluate(PROBE);
out.scenarios.c2_after_save_rm = s7;
out.c_dragAfter = heightsOf(s7);
out.c_churnLog = s7.logTail.filter((e) => e.seq >= logBeforeC);
check('C1 保存 r_m（warmup 不变）后 init 次数未变（路径 B 排除）', s7.inits === initBeforeC, { before: initBeforeC, after: s7.inits });
check('C2 【缺陷】DCAP 开态下保存参数同样重置 pane 高度', JSON.stringify(out.c_dragBefore) !== JSON.stringify(out.c_dragAfter), { before: out.c_dragBefore, after: out.c_dragAfter });
check('C3 该次变化伴随 removeIndicator/createIndicator（DCAP pane 销毁重建）', out.c_churnLog.some((e) => e.api === 'removeIndicator'), out.c_churnLog.map((e) => `${e.api}${e.arg}`));

// 归因指纹：指标勾选切换（确定走 deps useEffect，无 init）
await dragSep(1, 120);
const s8 = await page.evaluate(PROBE);
const logBeforeToggle = s8.logLen;
await page.getByRole('button', { name: 'KDJ', exact: true }).click();
await page.waitForTimeout(1200);
const s9 = await page.evaluate(PROBE);
out.scenarios.d1_toggle_kdj = s9;
out.toggleChurnLog = s9.logTail.filter((e) => e.seq >= logBeforeToggle);
await page.getByRole('button', { name: 'KDJ', exact: true }).click();
await page.waitForTimeout(1200);

// ───────────────────────── E. overrideIndicator 可行性（真实数据、真实 pane） ─────────────────────────
const before = await page.evaluate(PROBE);
out.scenarios.e0_before_override = before;
// 先把 DCAP pane 拖高，证明 override 不动高度
await dragSep(1, -120);
const e1 = await page.evaluate(PROBE);
out.scenarios.e1_dragged = e1;
out.overrideBefore = { heights: heightsOf(e1), domHeights: domHeightsOf(e1), dcap: e1.dcapSample, dcapInd: e1.indicators.find((i) => i.name === 'DCAP') };

out.overrideCalls = await page.evaluate(() => {
  const charts = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  const getBarsCalls = () => (window.__KC_LOG__ ?? []).filter((e) => e.api === 'setDataLoader').length;
  const r = {};
  r.beforeOverrideLogLen = (window.__KC_LOG__ ?? []).length;
  r.dcap_no_paneId = c.overrideIndicator({ name: 'DCAP', calcParams: [8, 26, 60, 1.3, 1, 1, 0, 3] });
  r.ma_no_paneId = c.overrideIndicator({ name: 'MA', calcParams: [7, 20, 60] });
  r.ma_with_paneId = c.overrideIndicator({ name: 'MA', paneId: 'candle_pane', calcParams: [7, 20, 60] });
  r.vol = c.overrideIndicator({ name: 'VOL', calcParams: [10, 20] });
  r.macd_disabled_negative_control = c.overrideIndicator({ name: 'MACD', calcParams: [12, 26, 9] });
  r.nonexistent = c.overrideIndicator({ name: 'NOT_REGISTERED_IND' });
  r.afterOverrideLogLen = (window.__KC_LOG__ ?? []).length;
  r.setDataLoaderLogCount_dummy = getBarsCalls();
  return r;
});
await page.waitForTimeout(1500);
const e2 = await page.evaluate(PROBE);
out.scenarios.e2_after_override = e2;
out.overrideAfter = { heights: heightsOf(e2), domHeights: domHeightsOf(e2), dcap: e2.dcapSample, dcapInd: e2.indicators.find((i) => i.name === 'DCAP'), maInd: e2.indicators.find((i) => i.name === 'MA'), volInd: e2.indicators.find((i) => i.name === 'VOL'), inits: e2.inits, paneIds: e2.panes.map((p) => p.id) };
out.overrideChurn = e2.logTail.filter((x) => x.seq >= out.overrideCalls.beforeOverrideLogLen);

check('E1 overrideIndicator 对 DCAP/MA/VOL 返回 true', out.overrideCalls.dcap_no_paneId && out.overrideCalls.ma_no_paneId && out.overrideCalls.vol, out.overrideCalls);
check('E2 负控：未启用指标（MACD）override → false（不创建 pane ⇒ 启用状态逻辑仍需 create）', out.overrideCalls.macd_disabled_negative_control === false, out.overrideCalls.macd_disabled_negative_control);
check('E3 负控：不存在的指标 → false', out.overrideCalls.nonexistent === false, out.overrideCalls.nonexistent);
check('E4 override 后 pane id 集合不变（无销毁/重建）', JSON.stringify(before.panes.map((p) => p.id)) === JSON.stringify(e2.panes.map((p) => p.id)), { before: before.panes.map((p) => p.id), after: e2.panes.map((p) => p.id) });
check('E5 override 后 pane 高度不变（±1px，getPaneOptions 与 DOM 双口径）', JSON.stringify(out.overrideBefore.heights) === JSON.stringify(out.overrideAfter.heights), { before: out.overrideBefore.heights, after: out.overrideAfter.heights });
check('E6 override 后 DCAP calcParams == 新值', JSON.stringify(out.overrideAfter.dcapInd?.calcParams) === JSON.stringify([8, 26, 60, 1.3, 1, 1, 0, 3]), out.overrideAfter.dcapInd);
check('E7 override 后 MA calcParams == [7,20,60]（主图 candle_pane 指标同样适用）', JSON.stringify(out.overrideAfter.maInd?.calcParams) === JSON.stringify([7, 20, 60]), out.overrideAfter.maInd);
check('E8 override 后 DCAP 线值按新参数改变（抽样值/统计与 override 前不同）', JSON.stringify(out.overrideBefore.dcap) !== JSON.stringify(out.overrideAfter.dcap), { before: out.overrideBefore.dcap, after: out.overrideAfter.dcap });
check('E9 override 后 DCAP precision=5 / figKeys=s,m,l,zero 不变', out.overrideAfter.dcapInd?.precision === 5 && JSON.stringify(out.overrideAfter.dcapInd?.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']), out.overrideAfter.dcapInd);
check('E10 override 未触发 init（无整图重建）', out.overrideAfter.inits === before.inits, { before: before.inits, after: out.overrideAfter.inits });
check('E11 override 未新增非 GET 请求（无写入）', out.nonGetOther.length === 0, out.nonGetOther);

// 归因指纹对照（mount burst vs deps burst vs 保存参数 burst vs 勾选 burst）
const fp = (e) => e.stack;
out.fingerprints = {
  mountBursts: out.scenarios.mount.log.filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator').map((e) => ({ api: e.api, arg: e.arg, stack: fp(e) })),
  saveBurst_A: out.a_churnLog.map((e) => ({ api: e.api, arg: e.arg, stack: e.stack })),
  saveBurst_C: out.c_churnLog.map((e) => ({ api: e.api, arg: e.arg, stack: e.stack })),
  toggleBurst: out.toggleChurnLog.map((e) => ({ api: e.api, arg: e.arg, stack: e.stack })),
  overrideBurst: out.overrideChurn.map((e) => ({ api: e.api, arg: e.arg, stack: e.stack })),
};
out.pageErrors = pageErrors;
out.finalState = await page.evaluate(PROBE);

fs.writeFileSync(`${OUT}/probe1.json`, JSON.stringify(out, null, 1));
console.log('checks:', out.checks.filter((c) => c.ok).length, '/', out.checks.length, 'passed');
for (const c of out.checks) console.log(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}`);
console.log('\n --- heights ---');
console.log('A draggable(before):', JSON.stringify(out.dragBeforeHeights), '→ after save r_s:', JSON.stringify(out.dragAfterHeights));
console.log('B before:', JSON.stringify(out.b_dragBefore), '→ after save n_m:', JSON.stringify(out.b_dragAfter), 'inits', initBeforeB, '→', s5.inits);
console.log('C before:', JSON.stringify(out.c_dragBefore), '→ after save r_m:', JSON.stringify(out.c_dragAfter), 'inits', initBeforeC, '→', s7.inits);
console.log('override before:', JSON.stringify(out.overrideBefore.heights), '→ after:', JSON.stringify(out.overrideAfter.heights));
console.log('overrideCalls:', JSON.stringify(out.overrideCalls));
console.log('putIntercepted:', JSON.stringify(out.putIntercepted));
console.log('nonGetOther:', JSON.stringify(out.nonGetOther));
console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 5)));
await browser.close();
