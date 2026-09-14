/** 阶段 3 独立验收（tester 自建）公共库 —— 只在 /tmp 沙箱运行。 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
export const { chromium } = require('@playwright/test');

export function makeOut(base) {
  return { base, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], klineUrls: [], klineGets: 0, checks: [], scenarios: {}, wsDispatch: [] };
}

export function checker(out) {
  return (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); };
}

/** 页面侧状态快照（真实 klinecharts 实例）。 */
export const SNAP = () => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => { try { return (c.getPaneOptions?.() ?? []).length > 0; } catch { return false; } });
  const c = charts[charts.length - 1];
  if (!c) return { error: 'no chart', inits: A?.inits ?? -1 };
  const g = (fn, d = null) => { try { return fn(); } catch { return d; } };
  const inds = (g(() => c.getIndicators()) ?? []).map((i) => ({
    name: i.name, id: i.id, paneId: i.paneId, precision: i.precision, calcParams: i.calcParams,
    figKeys: (i.figures ?? []).map((f) => f.key),
    result: Array.isArray(i.result) ? i.result : [],
  }));
  const panes = (g(() => c.getPaneOptions()) ?? []).map((p) => {
    let domH = null;
    try { domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { domH = null; }
    return { id: p.id, optH: p.height, domH, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name) };
  });
  const data = g(() => c.getDataList()) ?? [];
  const fit = document.querySelector('[data-testid="kline-chart"]')?.getAttribute('data-viewport-fit') ?? null;
  const dcap = inds.find((i) => i.name === 'DCAP');
  return {
    inits: A?.inits ?? -1,
    disposes: A?.disposes ?? -1,
    chartCount: charts.length,
    logLen: A?.log?.length ?? -1,
    symbol: g(() => c.getSymbol()),
    period: g(() => c.getPeriod()),
    panes,
    indicators: inds.map(({ result, ...r }) => r),
    dcap: dcap ? { paneId: dcap.paneId, precision: dcap.precision, calcParams: dcap.calcParams, figKeys: dcap.figKeys, result: dcap.result } : null,
    overlays: (g(() => c.getOverlays()) ?? []).length,
    dataLen: data.length,
    firstTs: data[0]?.timestamp ?? null,
    lastTs: data[data.length - 1]?.timestamp ?? null,
    firstClose: data[0]?.close ?? null,
    lastClose: data[data.length - 1]?.close ?? null,
    head3: data.slice(0, 3).map((b) => ({ ts: b.timestamp, close: b.close })),
    vr: g(() => c.getVisibleRange()),
    bs: g(() => c.getBarSpace()),
    fitAttr: fit,
    marker: !!document.querySelector('[data-realtime-marker]'),
  };
};

export const contentPanes = (s) => (s.panes ?? []).filter((p) => p.id !== 'x_axis_pane');
export const heights = (s) => Object.fromEntries(contentPanes(s).map((p) => [p.indicators.join('+') || 'candle', p.domH]));
export const ids = (s) => Object.fromEntries(contentPanes(s).map((p) => [p.indicators.join('+') || 'candle', p.id]));
export function heightDiffs(a, b) {
  const ha = heights(a), hb = heights(b), o = {};
  for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
    o[k] = { before: ha[k] ?? null, after: hb[k] ?? null, delta: ha[k] != null && hb[k] != null ? +(hb[k] - ha[k]).toFixed(2) : null };
  }
  return o;
}
export function allWithin1px(d) {
  const e = Object.entries(d);
  return e.length > 0 && e.every(([, v]) => v.delta != null && Math.abs(v.delta) <= 1);
}
export const visibleCount = (s) => (s.vr ? s.vr.to - s.vr.from + 1 : null);
export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** 浏览器侧写防护：GET 放行（只读代理线上 8081）；PUT /api/config/* 本地兑现（不发后端）；其余非 GET abort。 */
export async function installRoutes(page, out) {
  await page.route('**/*', async (route, req) => {
    const m = req.method();
    const u = req.url();
    if (m === 'GET') { if (u.includes('/api/kline')) out.klineGets++; await route.continue(); return; }
    if (m === 'PUT' && u.includes('/api/config/')) {
      const body = req.postData() ?? '{}';
      out.putIntercepted.push({ method: m, url: u.replace(out.base, ''), body: body.slice(0, 300), action: 'fulfilled-locally(未发往后端/DB)' });
      await route.fulfill({ status: 200, contentType: 'application/json', body });
      return;
    }
    out.nonGetOther.push(`${m} ${u}`);
    await route.abort();
  });
}

export async function openPage(page, base, query = '') {
  await page.goto(base + '/' + query, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 45000 });
  await page.waitForTimeout(4000);
}

export async function dragSeparator(page, index, dy) {
  const handle = await page.evaluate((idx) => {
    const kcRoot = document.querySelector('[data-testid="kline-chart"]').firstElementChild;
    const seps = Array.from(kcRoot.children).filter((el) => el.firstElementChild && el.firstElementChild.style.cursor === 'ns-resize');
    const r = seps[idx].firstElementChild.getBoundingClientRect();
    return { n: seps.length, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, index);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y + dy, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  return handle;
}

