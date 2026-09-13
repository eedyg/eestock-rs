/**
 * 阶段 3 独立验收 harness 公共库（自建；只在 /tmp 沙箱运行）。
 * 真实 klinecharts@10.0.3 + 真实 KlineChart/DashboardPage（临时构建，未改仓库文件）。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
export const { chromium } = require('@playwright/test');

export const REPO = '/home/eestock/workspace/git/eestock/eestock-rs';

export function makeOut(base) {
  return { base, t0: new Date().toISOString(), putIntercepted: [], nonGetOther: [], klineGets: 0, checks: [], scenarios: {} };
}

export function checker(out) {
  return (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });
}

/** 页面侧状态快照（chart 状态 + DCAP 原始 result + dataList）。 */
export const PROBE = () => {
  const A = window.__ACC__;
  const charts = (A?.charts ?? []).filter((c) => {
    try {
      return (c.getPaneOptions() ?? []).length > 0;
    } catch {
      return false;
    }
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
    result: i.result ?? [],
  }));
  const panes = (c.getPaneOptions() ?? []).map((p) => {
    let domH = null;
    try {
      domH = +c.getDom(p.id).getBoundingClientRect().height.toFixed(2);
    } catch {
      domH = null;
    }
    let yRange = null;
    try {
      yRange = (c.getYAxes({ paneId: p.id }) ?? []).map((y) => {
        const r = y.getRange();
        return { id: y.id, from: +Number(r?.from).toFixed(10), to: +Number(r?.to).toFixed(10) };
      });
    } catch {
      yRange = null;
    }
    return {
      id: p.id,
      optH: p.height,
      domH,
      indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name),
      yRange,
    };
  });
  const data = (c.getDataList?.() ?? []).map((b) => ({ ts: b.timestamp, close: b.close }));
  const dcap = inds.find((i) => i.name === 'DCAP');
  const ma = inds.find((i) => i.name === 'MA');
  const vol = inds.find((i) => i.name === 'VOL');
  const pick = (i) =>
    i
      ? { calcParams: i.calcParams, precision: i.precision, figKeys: i.figKeys, paneId: i.paneId, result: i.result }
      : null;
  return {
    inits: A?.inits ?? -1,
    logLen: A?.log.length ?? -1,
    panes,
    indicators: inds.map(({ result, ...r }) => r),
    dcap: pick(dcap),
    ma: pick(ma),
    vol: pick(vol),
    data,
    vr: (() => {
      try {
        return c.getVisibleRange();
      } catch {
        return null;
      }
    })(),
    bs: (() => {
      try {
        return c.getBarSpace();
      } catch {
        return null;
      }
    })(),
  };
};

export const contentPanes = (s) => (s.panes ?? []).filter((p) => p.id !== 'x_axis_pane');
export const heights = (s) =>
  Object.fromEntries(contentPanes(s).map((p) => [p.indicators.join('+') || 'candle', p.domH]));
export const paneIds = (s) =>
  Object.fromEntries(contentPanes(s).map((p) => [p.indicators.join('+') || 'candle', p.id]));

/** 逐 pane 高度差（±1px 判据用）。 */
export function heightDiffs(a, b) {
  const ha = heights(a);
  const hb = heights(b);
  const diffs = {};
  for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
    diffs[k] = { before: ha[k] ?? null, after: hb[k] ?? null, delta: ha[k] != null && hb[k] != null ? +(hb[k] - ha[k]).toFixed(2) : null };
  }
  return diffs;
}

export function allWithin1px(diffs) {
  const entries = Object.entries(diffs);
  return entries.length > 0 && entries.every(([, d]) => d.delta != null && Math.abs(d.delta) <= 1);
}

/** 线值对比（参数敏感度）：逐 key 逐点比较。 */
export function seriesDiff(a, b) {
  const arrA = a ?? [];
  const arrB = b ?? [];
  const keys = Array.from(new Set([...arrA, ...arrB].flatMap((r) => Object.keys(r ?? {})))).sort();
  const out = {};
  for (const k of keys) {
    const xa = arrA.map((r) => (r == null ? null : r[k]));
    const xb = arrB.map((r) => (r == null ? null : r[k]));
    let nDiff = 0;
    let maxAbs = 0;
    let nNonNull = 0;
    const len = Math.min(xa.length, xb.length);
    for (let i = 0; i < len; i++) {
      const va = xa[i];
      const vb = xb[i];
      if (typeof va !== 'number' && typeof vb !== 'number') continue;
      if (typeof va === 'number') nNonNull++;
      if (typeof va !== 'number' || typeof vb !== 'number') {
        nDiff++;
        continue;
      }
      const d = Math.abs(vb - va);
      if (d > 1e-12) nDiff++;
      if (d > maxAbs) maxAbs = d;
    }
    out[k] = { lenBefore: xa.length, lenAfter: xb.length, nDiff, maxAbsDelta: +maxAbs.toExponential(4), nNonNull };
  }
  return out;
}

/** 数据不足断线：返回首个非 null 索引（-1 = 全 null）。 */
export function firstNonNull(arr, key) {
  return (arr ?? []).findIndex((r) => r != null && typeof r[key] === 'number');
}
export function nNulls(arr, key) {
  return (arr ?? []).filter((r) => r == null || typeof r[key] !== 'number').length;
}

export async function openPage(page, base) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 45000 });
  await page.waitForTimeout(4000);
}

/** 浏览器侧写防护：GET 放行（只读代理到线上 8081），PUT/PATCH/POST/DELETE 一律本地兑现或中断。 */
export async function installRoutes(page, out, base) {
  await page.route('**/*', async (route, req) => {
    const m = req.method();
    const u = req.url();
    if (m === 'GET') {
      if (u.includes('/api/kline')) out.klineGets++;
      await route.continue();
      return;
    }
    if (m === 'PUT' && (u.includes('/api/config/dcap') || u.includes('/api/config/ma'))) {
      const body = req.postData() ?? '{}';
      out.putIntercepted.push({ method: m, url: u.replace(base, ''), body, action: 'fulfilled-locally-200-echo(未发往后端/DB)' });
      await route.fulfill({ status: 200, contentType: 'application/json', body });
      return;
    }
    out.nonGetOther.push(`${m} ${u}`);
    await route.abort();
  });
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

/** 真实「保存 dcap 参数」路径：打开面板 → 逐字段填写 → 点保存（onSave = DashboardPage.saveDcapParams）。 */
export async function saveDcapViaUI(page, edits) {
  await page.getByRole('button', { name: 'DCAP 配置' }).click();
  await page.waitForSelector('[data-dcap-editor]', { timeout: 5000 });
  for (const [field, value] of edits) {
    await page.fill(`[data-testid="dcap-input-${field}"]`, String(value));
  }
  await page.locator('[data-dcap-editor] button:has-text("保存")').click();
  await page.waitForTimeout(2000);
}

export async function saveMaViaUI(page, windows) {
  await page.getByRole('button', { name: 'MA 配置' }).click();
  await page.waitForSelector('[data-ma-editor]', { timeout: 5000 });
  for (let i = 0; i < windows.length; i++) {
    await page.fill(`[data-ma-input="${i}"]`, String(windows[i]));
  }
  await page.locator('[data-ma-editor] button:has-text("保存")').click();
  await page.waitForTimeout(1800);
}

export async function toggleIndicator(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(2200);
}

export function burst(out, s, fromSeq) {
  return out.rawLog.filter((e) => e.seq >= fromSeq).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg, ret: e.ret, paneIdsAfter: e.paneIdsAfter }));
}

export async function readLog(page) {
  return page.evaluate(() => (window.__ACC__?.log ?? []).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg, ret: e.ret, paneIdsAfter: e.paneIdsAfter })));
}

export function writeJson(path, obj) {
  fs.mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(obj, null, 1));
}

export function reportChecks(out) {
  const pass = out.checks.filter((c) => c.ok).length;
  console.log(`checks: ${pass}/${out.checks.length} passed`);
  for (const c of out.checks) {
    console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} ${JSON.stringify(c.detail).slice(0, 240)}`);
  }
  return pass;
}
