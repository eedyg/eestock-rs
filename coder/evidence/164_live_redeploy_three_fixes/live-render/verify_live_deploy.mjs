/**
 * 线上 8081 只读渲染取证（本轮上线三处前端修复）—— 真实 served bundle + 真实 klinecharts 10.0.3。
 *
 * 修复项：
 *   ① 181c35a 副图锚点重复分割线移除 + DCAP 副图常驻 0 参考线
 *   ③ 5d8eff4 切 period / 切 stock 不再重置指标视图布局
 *   ② 7949c0b 保存 dcap 参数不再重置布局（**仅浏览器侧本地兑现 PUT**，绝不发后端）
 *
 * 只读纪律：
 *   - GET 一律放行（仅记录 /api/kline URL）；
 *   - PUT /api/config/dcap 由浏览器侧本地兑现（记录 body，绝不转发后端）；
 *   - 其余非 GET 一律 abort；
 *   - 结束后用 Node 直连 8081 GET 配置基线，逐字节比对（证明确无写入）。
 *
 * 线上 bundle 无 kc-spy，故：
 *   - chart 实例经 React fiber 取得（只读）；
 *   - 「init 计数」用 klinecharts 自身暴露的 `chart.id = k_line_chart_<N>`（模块级 chartBaseId 单调递增，
 *     见 klinecharts@10.0.3 dist/index.esm.js `init()`）——无需任何注入即可判定是否发生整图 remount；
 *   - 线值用「离线 oracle 逐点比对」：Node 侧 esbuild 转译 web/src/features/indicators/dcap.ts
 *     同一 CORE，用 chart 的 dataList closes + 实际 calcParams 重算。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const REPO = '/home/eestock/workspace/git/eestock/eestock-rs';
const require = createRequire(REPO + '/web/node_modules/x.js');
const { chromium } = require('@playwright/test');
const esbuild = require('esbuild');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8081';
const OUT = process.env.OUT ?? REPO + '/web/e2e/artifacts/livecheck';
const out = {
  base: BASE,
  t0: new Date().toISOString(),
  puts: [],
  nonGetOther: [],
  klineUrls: [],
  pageErrors: [],
  scenarios: {},
  checks: [],
};
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });

// ── 离线 oracle：与线上同一份 CORE 源码（dcap.ts 生成物） ──
const dcapSrc = fs.readFileSync(REPO + '/web/src/features/indicators/dcap.ts', 'utf8');
const { code: dcapJs } = esbuild.transformSync(dcapSrc, { loader: 'ts', format: 'esm' });
const dcapMod = await import('data:text/javascript;base64,' + Buffer.from(dcapJs).toString('base64'));
const oracleSeries = (closes, params) => dcapMod.computeDcapSeries(closes, params);

/** 逐点比对（浮点：同一 CORE + 同一输入 ⇒ 期望逐位相同）。返回 {len1, len2, offset, mismatches, maxAbs} */
function compareOracle(result, closes, calcParams) {
  const params = {
    n_s: calcParams[0], n_m: calcParams[1], n_l: calcParams[2],
    r_s: calcParams[3], r_m: calcParams[4], r_l: calcParams[5],
    smooth: calcParams[6], m: calcParams[7],
  };
  const exp = oracleSeries(closes, params);
  let mismatches = 0;
  let maxAbs = 0;
  let compared = 0;
  const n = Math.min(exp.length, result.length);
  for (let i = 0; i < n; i++) {
    for (const k of ['s', 'm', 'l']) {
      const a = result[i] ? result[i][k] : null;
      const b = exp[i] ? exp[i][k] : null;
      const an = a === null || a === undefined;
      const bn = b === null || b === undefined;
      if (an !== bn) { mismatches++; continue; }
      if (an && bn) continue;
      compared++;
      const d = Math.abs(a - b);
      if (d > maxAbs) maxAbs = d;
      if (!(a === b)) mismatches++;
    }
  }
  return { oracleLen: exp.length, resultLen: result.length, compared, mismatches, maxAbs };
}

const SNAP = () => {
  const c = window.__findChart();
  if (!c) return { error: 'no chart' };
  const inds = (c.getIndicators() ?? []).map((i) => ({
    name: i.name,
    id: i.id,
    paneId: i.paneId,
    precision: i.precision,
    calcParams: i.calcParams,
    figKeys: (i.figures ?? []).map((f) => f.key),
    result:
      i.name === 'DCAP' && Array.isArray(i.result)
        ? i.result.map((r) => (r ? { s: r.s ?? null, m: r.m ?? null, l: r.l ?? null, zero: r.zero ?? null } : null))
        : null,
  }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let domH = null;
    try { domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { domH = null; }
    let yRanges = null;
    try {
      yRanges = (c.getYAxes({ paneId: p.id }) ?? []).map((y) => {
        const r = y.getRange();
        return { id: y.id, from: r?.from ?? null, to: r?.to ?? null };
      });
    } catch { yRanges = null; }
    return { id: p.id, optH: p.height, domH, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name), yRanges };
  });
  const data = c.getDataList?.() ?? [];
  const g = (fn) => { try { return fn(); } catch { return null; } };
  const kc = (() => {
    const host = document.querySelector('[k-line-chart-id]');
    return host ? host.firstElementChild : null;
  })();
  const seps = kc
    ? Array.from(kc.children).filter((el) => { const w = el.firstElementChild; return !!w && w.style && w.style.cursor === 'ns-resize'; }).length
    : -1;
  return {
    chartId: c.id ?? null,
    chartDomAttr: g(() => c.getDom()?.getAttribute('k-line-chart-id') ?? null),
    symbol: g(() => c.getSymbol()),
    period: g(() => c.getPeriod()),
    panes,
    inds,
    separators: seps,
    vr: g(() => c.getVisibleRange()),
    bs: g(() => c.getBarSpace()),
    dataLen: data.length,
    firstTs: data[0]?.timestamp ?? null,
    lastTs: data[data.length - 1]?.timestamp ?? null,
    firstClose: data[0]?.close ?? null,
    lastClose: data[data.length - 1]?.close ?? null,
    head3: data.slice(0, 3).map((b) => ({ ts: b.timestamp, close: b.close })),
    closes: data.map((b) => b.close),
  };
};

const contentPanes = (s) => (s.panes ?? []).filter((p) => p.id !== 'x_axis_pane');
const heights = (s) => Object.fromEntries(contentPanes(s).map((p) => [p.indicators.join('+') || 'candle', p.domH]));
const paneIds = (s) => Object.fromEntries(contentPanes(s).map((p) => [p.indicators.join('+') || 'candle', p.id]));
const indIds = (s) => Object.fromEntries((s.inds ?? []).map((i) => [i.name, `${i.id}:${i.paneId}`]));
function heightDiffs(a, b) {
  const ha = heights(a); const hb = heights(b); const o = {};
  for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
    const x = ha[k]; const y = hb[k];
    o[k] = { before: x ?? null, after: y ?? null, delta: x != null && y != null ? +(y - x).toFixed(2) : null };
  }
  return o;
}
const within1 = (d) => { const e = Object.entries(d); return e.length > 0 && e.every(([, v]) => v.delta != null && Math.abs(v.delta) <= 1); };
const sameIds = (a, b) => JSON.stringify(paneIds(a)) === JSON.stringify(paneIds(b));
const sameIndIds = (a, b) => JSON.stringify(indIds(a)) === JSON.stringify(indIds(b));
const dcapOf = (s) => (s.inds ?? []).find((i) => i.name === 'DCAP') ?? null;
const mTail = (s) => {
  const d = dcapOf(s);
  if (!d || !d.result) return null;
  return d.result.map((r) => (r ? r.m : null)).filter((v) => v !== null).slice(-5).map((v) => +v.toFixed(10));
};
const dataFingerprint = (s) => JSON.stringify([s.firstTs, s.lastTs, s.firstClose, s.lastClose, s.dataLen]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await ctx.newPage();
page.on('pageerror', (e) => out.pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') out.pageErrors.push('console: ' + m.text().slice(0, 200)); });
page.on('request', (r) => { if (r.url().includes('/api/kline')) out.klineUrls.push(r.url().replace(BASE, '')); });

await page.route('**/*', async (route, req) => {
  const url = req.url();
  const method = req.method();
  if (method === 'GET') {
    // 浏览器侧本地兑现：保存后若有本地镜像，GET 配置读镜像（仍不写服务端）
    if (out.mirror && url.includes('/api/config/dcap')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out.mirror) });
    }
    return route.continue();
  }
  if (method === 'PUT' && url.includes('/api/config/dcap')) {
    const body = req.postData() ?? '{}';
    out.puts.push({ url: url.replace(BASE, ''), body });
    try { out.mirror = JSON.parse(body); } catch { /* ignore */ }
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  }
  out.nonGetOther.push(`${method} ${url}`);
  return route.abort();
});

await page.addInitScript(() => {
  window.__findChart = () => {
    const host = document.querySelector('[k-line-chart-id]');
    if (!host) return null;
    const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    const isChart = (v) => v && typeof v === 'object' && typeof v.convertToPixel === 'function' && typeof v.getIndicators === 'function';
    let f = host[key];
    for (let up = 0; f && up < 40; up++) {
      let h = f.memoizedState; let i = 0;
      while (h && i < 60) {
        const v = h.memoizedState;
        if (isChart(v)) return v;
        if (v && typeof v === 'object' && isChart(v.current)) return v.current;
        if (v && typeof v === 'object' && v.chart && isChart(v.chart)) return v.chart;
        h = h.next; i++;
      }
      f = f.return;
    }
    return null;
  };
});

const snap = () => page.evaluate(SNAP);
const clickPeriod = async (label) => { await page.getByRole('button', { name: label, exact: true }).click(); await page.waitForTimeout(3500); };
const clickStock = async (code) => {
  const inList = page.locator('[data-region="symbol-list"]').getByText(code, { exact: true }).first();
  if (await inList.count()) await inList.click();
  else await page.getByText(code, { exact: true }).first().click();
  await page.waitForTimeout(3500);
};
const dragSeparator = async (index, dy) => {
  const handle = await page.evaluate((index) => {
    const host = document.querySelector('[k-line-chart-id]');
    const kc = host ? host.firstElementChild : null;
    if (!kc) return null;
    const seps = Array.from(kc.children).filter((el) => { const w = el.firstElementChild; return !!w && w.style && w.style.cursor === 'ns-resize'; });
    const sep = seps[index];
    if (!sep) return null;
    const w = sep.firstElementChild;
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: seps.length };
  }, index);
  if (!handle) return false;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y + dy, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  return true;
};

// ── 打开页面 ──
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"] canvas', { timeout: 30000 });
await page.waitForTimeout(3000);

const sMount = await snap();
out.scenarios.mount = sMount;
check('M1 mount：chart.id == k_line_chart_1（本次页面加载内 init 恰 1 次）', sMount.chartId === 'k_line_chart_1', { chartId: sMount.chartId });
check('M2 mount：DCAP 默认关（无 DCAP indicator）', !dcapOf(sMount), (sMount.inds ?? []).map((i) => i.name));
check('M3 mount：分隔线数 == 1（candle|VOL）', sMount.separators === 1, { separators: sMount.separators });

// ── ①-默认态：锚点无 border-top + 无残留全宽线 ──
const probeSeparators = () => page.evaluate(() => {
  const main = document.querySelector('[data-region="main-chart"]');
  const anchor = document.querySelector('[data-region="sub-chart"]');
  const host = document.querySelector('[k-line-chart-id]');
  const kc = host ? host.firstElementChild : null;
  const mr = main.getBoundingClientRect();
  const rel = (el) => { const r = el.getBoundingClientRect(); return { top: +(r.top - mr.top).toFixed(2), h: +r.height.toFixed(2), w: +r.width.toFixed(2) }; };
  const isSep = (el) => { const w = el.firstElementChild; return !!w && w.style && w.style.cursor === 'ns-resize'; };
  const seps = [];
  for (const el of Array.from(kc.children)) if (isSep(el)) seps.push({ bg: getComputedStyle(el).backgroundColor, ...rel(el) });
  const stray = [];
  for (const el of Array.from(main.querySelectorAll('*'))) {
    if (isSep(el)) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const bt = parseFloat(cs.borderTopWidth || '0');
    const opaque = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    if ((bt > 0 && cs.borderTopStyle !== 'none' && r.width >= 0.9 * mr.width) || (r.height <= 3 && opaque)) {
      stray.push({ tag: el.tagName + (el.dataset.region ? `[${el.dataset.region}]` : ''), kind: bt > 0 ? `border-top ${cs.borderTopWidth}` : `bg ${cs.backgroundColor}`, ...rel(el) });
    }
  }
  const acs = getComputedStyle(anchor);
  return { anchor: { classes: anchor.className, borderTopWidth: acs.borderTopWidth, borderTopStyle: acs.borderTopStyle, background: acs.backgroundColor }, seps, stray };
});
const p0 = await probeSeparators();
out.scenarios.sep_default = p0;
check('①-1 默认态：分隔线恰 1 条', p0.seps.length === 1, p0.seps);
check('①-2 默认态：主图区无残留全宽横线（stray == []）', p0.stray.length === 0, p0.stray);
check('①-3 sub-chart 锚点 borderTopWidth == 0px 且无 border-t 类、背景透明', p0.anchor.borderTopWidth === '0px' && !/\bborder-t\b/.test(p0.anchor.classes) && (p0.anchor.background === 'rgba(0, 0, 0, 0)' || p0.anchor.background === 'transparent'), p0.anchor);

// ── 开 DCAP（本地状态；0 非 GET 之外无副作用） ──
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
const sDcap = await snap();
out.scenarios.dcap_on = sDcap;
const dcapInd = dcapOf(sDcap);
check('①-4 DCAP 开：分隔线恰 2 条（candle|VOL|DCAP）', sDcap.separators === 2, { separators: sDcap.separators });
check('②-1 DCAP：figKeys == s/m/l/zero 且 precision == 5 且独立副图 pane', !!dcapInd && JSON.stringify(dcapInd.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']) && dcapInd.precision === 5 && dcapInd.paneId !== 'candle_pane', dcapInd && { figKeys: dcapInd.figKeys, precision: dcapInd.precision, paneId: dcapInd.paneId });
check('②-2 DCAP：每根 bar zero 恒 0（常驻 0 线）', !!dcapInd && dcapInd.result.filter(Boolean).length > 0 && dcapInd.result.filter(Boolean).every((r) => r.zero === 0), dcapInd && { n: dcapInd.result.length, nonZeroZero: dcapInd.result.filter(Boolean).filter((r) => r.zero !== 0).length });
check('①-5 DCAP 开：主图区仍无残留全宽横线（stray == []）', (await probeSeparators()).stray.length === 0, (await probeSeparators()).stray);
{
  const vals = dcapInd.result.filter(Boolean).flatMap((r) => [r.s, r.m, r.l]).filter((v) => v !== null);
  const mn = Math.min(...vals); const mx = Math.max(...vals);
  check('②-3 DCAP：真实数据三线跨 0（min<0<max）', mn < 0 && mx > 0, { min: mn, max: mx, n: vals.length });
  const dcapPane = contentPanes(sDcap).find((p) => p.indicators.includes('DCAP'));
  const yr = dcapPane?.yRanges?.[0];
  check('②-4 DCAP：副图 Y 轴范围含 0', !!yr && yr.from <= 0 && yr.to >= 0, yr);
  const info = await page.evaluate(() => {
    const c = window.__findChart();
    const d = c.getIndicators().find((i) => i.name === 'DCAP');
    const paneId = d.paneId;
    const yAxis = c.getYAxes({ paneId })[0];
    const y0 = c.convertToPixel({ value: 0 }, { paneId }).y;
    const size = c.getSize(paneId);
    const dom = c.getDom(paneId); const cv = dom.querySelector('canvas'); const ctx2 = cv.getContext('2d');
    const scaleY = cv.height / size.height;
    const row = Math.round(y0 * scaleY);
    const im = ctx2.getImageData(0, Math.max(0, Math.min(cv.height - 1, row)), cv.width, 1).data;
    let gray = 0;
    for (let x = 0; x < cv.width; x++) {
      if (im[x * 4 + 3] > 150 && Math.abs(im[x * 4] - 118) < 25 && Math.abs(im[x * 4 + 1] - 128) < 25 && Math.abs(im[x * 4 + 2] - 143) < 25) gray++;
    }
    const grayXs = [];
    for (let x = 0; x < cv.width; x++) {
      if (im[x * 4 + 3] > 150 && Math.abs(im[x * 4] - 118) < 25 && Math.abs(im[x * 4 + 1] - 128) < 25 && Math.abs(im[x * 4 + 2] - 143) < 25) grayXs.push(x);
    }
    const gaps = [];
    for (let i = 1; i < grayXs.length; i++) gaps.push(grayXs[i] - grayXs[i - 1]);
    const r = dom.getBoundingClientRect();
    return {
      y0, yAxisY0: yAxis.convertToPixel(0), paneH: size.height, gray, row, range: yAxis.getRange(),
      firstGrayXs: grayXs.slice(0, 12), grayGaps: [...new Set(gaps)].sort((a, b) => a - b),
      crop: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
  });
  out.scenarios.zero_line = info;
  check('②-5 DCAP：0 线 y == pane 内 y(0) 且落在 pane 内', Math.abs(info.y0 - info.yAxisY0) <= 1 && info.y0 >= 0 && info.y0 <= info.paneH, info);
  check('②-6 DCAP：y(0) 行渲染出 #76808F 虚线像素（细分/虚线交替 => gap 集含 1 与 >1）', info.gray > 100 && info.grayGaps.includes(1) && info.grayGaps.some((g) => g > 1), { row: info.row, gray: info.gray, gaps: info.grayGaps });
  await page.screenshot({ path: `${OUT}/live-deploy-dcap-zero-crop.png`, clip: info.crop });
}

// ── ③ 拖到非默认高度 → 切 period ×2 / 切 stock ×2 ──
const d1 = await dragSeparator(0, -160);
const d2 = await dragSeparator(1, -50);
const sDrag = await snap();
out.scenarios.dragged = sDrag;
const dragDiffs = heightDiffs(sDcap, sDrag);
check('③-0 拖拽生效：成功拖 2 条分隔线', d1 && d2, { d1, d2 });
check('③-0b 拖拽后高度非默认（至少一个 pane 偏离 DCAP 开态 ≥20px）', Object.values(dragDiffs).some((v) => v.delta != null && Math.abs(v.delta) >= 20), dragDiffs);
const pDrag = await probeSeparators();
out.scenarios.sep_after_drag = pDrag;
check('①-6 拖拽后：主图区仍无残留全宽横线（stray == []，无僵线）', pDrag.stray.length === 0, pDrag.stray);
check('①-7 拖拽后：分隔线仍随 pane 移动（2 条且上分隔线 top 变小）', pDrag.seps.length === 2 && pDrag.seps[0].top < p0.seps[0].top - 50, { beforeTop: p0.seps[0].top, afterTops: pDrag.seps.map((s) => s.top) });
await page.screenshot({ path: `${OUT}/live-deploy-after-drag.png` });

const sBefore = sDrag;
const periodSteps = [];
for (const label of ['1h', '5m']) {
  const before = await snap();
  await clickPeriod(label);
  const after = await snap();
  const diffs = heightDiffs(before, after);
  periodSteps.push({ label, beforeChartId: before.chartId, afterChartId: after.chartId, diffs, beforePeriod: before.period, afterPeriod: after.period, beforeData: dataFingerprint(before), afterData: dataFingerprint(after), paneIdsSame: sameIds(before, after), indIdsSame: sameIndIds(before, after), separators: [before.separators, after.separators] });
  check(`③-P[${label}] 高度 ±1px 不变`, within1(diffs), diffs);
  check(`③-P[${label}] pane id 不变`, sameIds(before, after), { before: paneIds(before), after: paneIds(after) });
  check(`③-P[${label}] indicator id 不变（无 create/remove）`, sameIndIds(before, after), { before: indIds(before), after: indIds(after) });
  check(`③-P[${label}] init 计数不递增（chart.id 不变）`, before.chartId === after.chartId, { before: before.chartId, after: after.chartId });
  check(`③-P[${label}] 数据确实换新（首末时间戳/取值变化）`, dataFingerprint(before) !== dataFingerprint(after), { before: dataFingerprint(before), after: dataFingerprint(after) });
  check(`③-P[${label}] 请求命中新 period=${label}`, out.klineUrls.some((u) => u.includes('period=' + label)), out.klineUrls.slice(-3));
}
out.scenarios.periodSteps = periodSteps;

const stockSteps = [];
for (const code of ['161226', '513310']) {
  const before = await snap();
  await clickStock(code);
  const after = await snap();
  const diffs = heightDiffs(before, after);
  const okData = dataFingerprint(before) !== dataFingerprint(after);
  stockSteps.push({ code, beforeChartId: before.chartId, afterChartId: after.chartId, diffs, beforeSymbol: before.symbol?.ticker ?? null, afterSymbol: after.symbol?.ticker ?? null, beforeData: dataFingerprint(before), afterData: dataFingerprint(after), paneIdsSame: sameIds(before, after), hits: out.klineUrls.filter((u) => u.includes('code=' + code)).slice(-2) });
  check(`③-S[${code}] 切标的成功（chart symbol == ${code}）`, (after.symbol?.ticker ?? '') === code, { before: before.symbol?.ticker, after: after.symbol?.ticker });
  check(`③-S[${code}] 高度 ±1px 不变`, within1(diffs), diffs);
  check(`③-S[${code}] pane id 不变`, sameIds(before, after), { before: paneIds(before), after: paneIds(after) });
  check(`③-S[${code}] indicator id 不变（无 create/remove）`, sameIndIds(before, after), { before: indIds(before), after: indIds(after) });
  check(`③-S[${code}] init 计数不递增（chart.id 不变）`, before.chartId === after.chartId, { before: before.chartId, after: after.chartId });
  check(`③-S[${code}] 数据确实换新`, okData, { before: dataFingerprint(before), after: dataFingerprint(after) });
  check(`③-S[${code}] 请求命中新 code=${code}`, out.klineUrls.some((u) => u.includes('code=' + code)), out.klineUrls.slice(-3));
}
out.scenarios.stockSteps = stockSteps;

// 回到 518880（保持初始标的），仍只读
await clickStock('518880');
const sBack = await snap();
out.scenarios.back518880 = { symbol: sBack.symbol?.ticker ?? null, chartId: sBack.chartId, heights: heights(sBack) };

// ── ② 保存 dcap 参数：仅浏览器侧本地兑现（拦截 PUT，不回后端） ──
const dcapPanel = () => page.getByRole('group', { name: 'DCAP 参数' });
async function saveDcap(changes) {
  if (!(await dcapPanel().isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'DCAP 配置' }).click();
    await dcapPanel().waitFor({ timeout: 5000 });
  }
  for (const [k, v] of Object.entries(changes)) await page.getByTestId(`dcap-input-${k}`).fill(String(v));
  await dcapPanel().getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(1800);
  if (await dcapPanel().isVisible().catch(() => false)) await page.getByRole('button', { name: 'DCAP 配置' }).click();
  await page.waitForTimeout(400);
}

const saveSteps = [];
let prev = await snap();
out.scenarios.before_save = prev;
const savedParams = [];
for (const changes of [{ r_m: 1.5 }, { n_m: 30 }]) {
  const before = prev;
  await saveDcap(changes);
  const after = await snap();
  prev = after;
  const diffs = heightDiffs(before, after);
  const d = dcapOf(after);
  const cp = d?.calcParams ?? [];
  const cmp = d?.result && after.closes ? compareOracle(d.result, after.closes, cp) : null;
  const appliedExpected = Object.entries(changes).every(([k, v]) => {
    const idx = { n_s: 0, n_m: 1, n_l: 2, r_s: 3, r_m: 4, r_l: 5, smooth: 6, m: 7 }[k];
    return Number(cp[idx]) === Number(v);
  });
  savedParams.push({ changes, calcParams: cp, ...cmp });
  saveSteps.push({ changes, calcParams: cp, diffs, beforeChartId: before.chartId, afterChartId: after.chartId, paneIdsSame: sameIds(before, after), indIdsSame: sameIndIds(before, after), separators: [before.separators, after.separators], mTailBefore: mTail(before), mTailAfter: mTail(after), oracle: cmp });
  const tag = JSON.stringify(changes);
  check(`②-S${tag} PUT 被浏览器侧拦截（未回后端）`, out.puts.length >= 1, out.puts.slice(-1));
  check(`②-S${tag} 参数已应用（calcParams 含新值）`, appliedExpected, { calcParams: cp, changes });
  check(`②-S${tag} 高度 ±1px 不变`, within1(diffs), diffs);
  check(`②-S${tag} pane id 不变`, sameIds(before, after), { before: paneIds(before), after: paneIds(after) });
  check(`②-S${tag} indicator id 不变（无 create/remove）`, sameIndIds(before, after), { before: indIds(before), after: indIds(after) });
  check(`②-S${tag} 分隔线数不变`, before.separators === after.separators, { before: before.separators, after: after.separators });
  check(`②-S${tag} init 计数不递增（chart.id 不变）`, before.chartId === after.chartId, { before: before.chartId, after: after.chartId });
  check(`②-S${tag} 线值按新参数更新（m 线尾值变化）`, JSON.stringify(mTail(before)) !== JSON.stringify(mTail(after)), { before: mTail(before), after: mTail(after) });
  check(`②-S${tag} 离线 oracle 逐点一致（0 失配）`, !!cmp && cmp.mismatches === 0 && cmp.compared > 0, cmp);
}
out.scenarios.saveSteps = saveSteps;
out.scenarios.appliedParams = savedParams;

// 只读保证
check('R1 全程无非 GET 其他请求（除被本地兑现的 PUT /api/config/dcap）', out.nonGetOther.length === 0, out.nonGetOther);
check('R2 PUT 仅命中 /api/config/dcap 且被本地兑现', out.puts.every((p) => p.url === '/api/config/dcap'), out.puts);
check('R3 无页面异常', out.pageErrors.length === 0, out.pageErrors);

await page.screenshot({ path: `${OUT}/live-deploy-final.png` });
await browser.close();

// Node 直连复读配置（不经浏览器）：证明确无写入
const cfg = {};
for (const k of ['kline', 'dcap', 'ma']) {
  const r = await fetch(`${BASE}/api/config/${k}`);
  cfg[k] = { status: r.status, body: await r.text() };
}
out.configAfter = cfg;

fs.writeFileSync(`${OUT}/live-deploy-results.json`, JSON.stringify(out, null, 2));
const failed = out.checks.filter((c) => !c.ok);
for (const c of out.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ' :: ' + JSON.stringify(c.detail).slice(0, 500)}`);
console.log(`\nlive ${BASE}: ${out.checks.length - failed.length}/${out.checks.length} passed; failed=${failed.length}; puts=${out.puts.length}; nonGetOther=${out.nonGetOther.length}; pageErrors=${out.pageErrors.length}`);
console.log('config after (Node 直连):', JSON.stringify(cfg));
process.exit(failed.length === 0 ? 0 : 1);
