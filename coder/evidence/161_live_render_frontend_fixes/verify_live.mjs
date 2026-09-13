/**
 * 线上 8081 只读渲染取证（问题①②③）—— 真实 served bundle + 真实 klinecharts 10.0.3。
 * Chart 实例经 React fiber 取得（线上 bundle 无 kc-spy，故不用 window.__CHARTS__）；
 * 断言语义对齐 tester/evidence/048/accept_issue1|2.mjs（18/18）。
 * 只读：拦截并 abort 任何非 GET 请求；DCAP 勾选与 setDataLoader 均为前端本地状态，不写服务端。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8081';
const OUT = process.env.OUT ?? '/home/eestock/workspace/git/eestock/eestock-rs/web/e2e/artifacts/livecheck';
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const nonGet = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.route('**/*', async (route, req) => {
  if (req.method() !== 'GET') { nonGet.push(`${req.method()} ${req.url()}`); await route.abort(); return; }
  await route.continue();
});
await page.addInitScript(() => {
  // 供页面脚本取得 chart 实例：fiber 查找（只读）
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
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
await page.waitForTimeout(2500);

const INFO = () => {
  const c = window.__findChart();
  const ind = c.getIndicators().find((i) => i.name === 'DCAP');
  const dataLen = c.getDataList().length;
  if (!ind) return { hasDcap: false, dataLen, panes: c.getPaneOptions().map((p) => p.id), inds: c.getIndicators().map((i) => i.name) };
  const paneId = ind.paneId;
  const yAxis = c.getYAxes({ paneId })[0];
  const range = yAxis.getRange();
  const y0 = c.convertToPixel({ value: 0 }, { paneId }).y;
  const yAxisY0 = yAxis.convertToPixel(0);
  const size = c.getSize(paneId);
  const result = ind.result ?? [];
  const dataVals = result.flatMap((r) => [r.s, r.m, r.l]).filter((v) => v !== null && v !== undefined);
  const zeroVals = result.map((r) => r.zero);
  const dom = c.getDom(paneId); const cv = dom.querySelector('canvas'); const ctx = cv.getContext('2d');
  const scaleY = cv.height / size.height;
  const row = Math.round(y0 * scaleY);
  const im = ctx.getImageData(0, Math.max(0, Math.min(cv.height - 1, row)), cv.width, 1).data;
  let gray = 0; const grayXs = [];
  for (let x = 0; x < cv.width; x++) {
    const r = im[x * 4], g = im[x * 4 + 1], b = im[x * 4 + 2], a = im[x * 4 + 3];
    if (a > 150 && Math.abs(r - 118) < 25 && Math.abs(g - 128) < 25 && Math.abs(b - 143) < 25) { gray++; grayXs.push(x); }
  }
  const gaps = []; for (let i = 1; i < grayXs.length; i++) gaps.push(grayXs[i] - grayXs[i - 1]);
  const gapSet = [...new Set(gaps)].sort((a, b) => a - b);
  return {
    hasDcap: true, paneId, precision: ind.precision, figKeys: (ind.figures ?? []).map((f) => f.key),
    dataLen, resultLen: result.length,
    dataMin: dataVals.length ? Math.min(...dataVals) : null, dataMax: dataVals.length ? Math.max(...dataVals) : null,
    dataNonNull: dataVals.length, zeroNonNull: zeroVals.filter((v) => v === 0).length,
    zeroIsAllZero: zeroVals.length > 0 && zeroVals.every((v) => v === 0),
    range: { from: range.from, to: range.to }, y0, yAxisY0, paneH: size.height, canvasH: cv.height, scaleY, row,
    gray, firstGrayXs: grayXs.slice(0, 12), grayGaps: gapSet,
  };
};

// ---- 问题① DOM 探针（对齐 e2e/dashboard-pane-separator.e2e.ts）----
const probeSeparators = () => page.evaluate(() => {
  const main = document.querySelector('[data-region="main-chart"]');
  const anchor = document.querySelector('[data-region="sub-chart"]');
  const host = document.querySelector('[k-line-chart-id]');
  const kc = host ? host.firstElementChild : null;
  const mr = main.getBoundingClientRect();
  const rel = (el) => { const r = el.getBoundingClientRect(); return { top: +(r.top - mr.top).toFixed(2), h: +r.height.toFixed(2), w: +r.width.toFixed(2) }; };
  const isSep = (el) => { const w = el.firstElementChild; return !!w && w.style.cursor === 'ns-resize'; };
  const seps = [];
  for (const el of Array.from(kc.children)) if (isSep(el)) seps.push({ bg: getComputedStyle(el).backgroundColor, ...rel(el) });
  const stray = [];
  for (const el of Array.from(main.querySelectorAll('*'))) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const bt = parseFloat(cs.borderTopWidth || '0');
    const opaque = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    const fullW = bt > 0 && cs.borderTopStyle !== 'none' && r.width >= 0.9 * mr.width;
    if ((fullW || (r.height <= 3 && opaque)) && !isSep(el)) stray.push({ tag: el.tagName + (el.dataset.region ? `[${el.dataset.region}]` : ''), kind: fullW ? `border-top ${cs.borderTopWidth} ${cs.borderTopColor}` : `bg ${cs.backgroundColor}`, ...rel(el) });
  }
  const acs = getComputedStyle(anchor);
  return { anchor: { classes: anchor.className, borderTopWidth: acs.borderTopWidth, borderTopStyle: acs.borderTopStyle, background: acs.backgroundColor }, seps, stray };
});

// ① 默认态（DCAP 关）
const p0 = await probeSeparators();
check('①-1 默认态：klinecharts 分隔线恰 1 条', p0.seps.length === 1, p0);
check('①-2 默认态：主图区无残留全宽横线（stray == []）', p0.stray.length === 0, p0.stray);
check('①-3 sub-chart 锚点 borderTopWidth == 0px（不再画线）', p0.anchor.borderTopWidth === '0px', p0.anchor);
// 注：Tailwind preflight 全局置 border-style:solid；锚点 border-top-width 为 0 ⇒ 不画线。判据取 width==0 + 背景透明 + 无 border-t class。
check('①-4 sub-chart 锚点：border 宽 0 且背景透明、无 border-t 类（不画线）', p0.anchor.borderTopWidth === '0px' && (p0.anchor.background === 'rgba(0, 0, 0, 0)' || p0.anchor.background === 'transparent') && !/\bborder-t\b/.test(p0.anchor.classes), p0.anchor);

// ② DCAP 关态
const offInfo = await page.evaluate(INFO);
check('②-0 DCAP 关闭态：无 DCAP 指标/pane', offInfo.hasDcap === false, offInfo);

// 开启 DCAP（本地状态，仍 0 非 GET）
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(1800);
const realInfo = await page.evaluate(INFO);
check('②-1 figKeys == s/m/l/zero 且 precision == 5', JSON.stringify(realInfo.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']) && realInfo.precision === 5, { figKeys: realInfo.figKeys, precision: realInfo.precision });
check('②-2 每根 bar zero 恒 = 0', realInfo.zeroIsAllZero, { zeroNonNull: realInfo.zeroNonNull, resultLen: realInfo.resultLen });
check('②-3 真实数据：三线跨越 0（min<0<max）', realInfo.dataMin < 0 && realInfo.dataMax > 0, { min: realInfo.dataMin, max: realInfo.dataMax });
check('②-4 真实数据：副图 Y 轴范围含 0', realInfo.range.from <= 0 && realInfo.range.to >= 0, realInfo.range);
check('②-5 真实数据：0 线 y == pane 内 y(0)，且落在 pane 内', Math.abs(realInfo.y0 - realInfo.yAxisY0) <= 1 && realInfo.y0 >= 0 && realInfo.y0 <= realInfo.paneH, { y0: realInfo.y0, yAxisY0: realInfo.yAxisY0, paneH: realInfo.paneH });
check('②-6 真实数据：y(0) 行渲染出 #76808F 虚线像素', realInfo.gray > 100, { row: realInfo.row, gray: realInfo.gray, gaps: realInfo.grayGaps });
await page.screenshot({ path: `${OUT}/live-issue2-real.png` });

// ① DCAP 开后：分隔线 2 条、无残留线
const p1 = await probeSeparators();
check('①-5 DCAP 开：分隔线恰 2 条（candle|VOL|DCAP）', p1.seps.length === 2, p1.seps);
check('①-6 DCAP 开：主图区仍无残留全宽横线', p1.stray.length === 0, p1.stray);

// ③ 拖高 VOL：分隔线随 pane 移动 + 无僵线
const before = p0.seps[0];
const handle = await page.evaluate(() => {
  const kc = document.querySelector('[k-line-chart-id]').firstElementChild;
  const sep = Array.from(kc.children).find((el) => { const w = el.firstElementChild; return !!w && w.style.cursor === 'ns-resize'; });
  const widget = sep.firstElementChild; const r = widget.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(handle.x, handle.y); await page.mouse.down();
await page.mouse.move(handle.x, handle.y - 120, { steps: 12 }); await page.mouse.up();
await page.waitForTimeout(600);
const p2 = await probeSeparators();
check('③-1 拖高 VOL 后分隔线条数不变（2）', p2.seps.length === 2, p2.seps);
check('③-2 拖高 VOL 后分隔线随 pane 上移（top 减少 >50px）', p2.seps[0].top < before.top - 50, { before: before.top, after: p2.seps[0].top });
check('③-3 拖高 VOL 后无僵线（stray == []）', p2.stray.length === 0, p2.stray);
await page.screenshot({ path: `${OUT}/live-issue1-after-drag.png` });

// ② 反向形态：三线全正 → Y 轴仍含 0，0 线仍在
const inject = async (closes) => { await page.evaluate((closes) => {
  const c = window.__findChart();
  const bars = closes.map((close, i) => ({ timestamp: 1700000000000 + i * 60000, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1000 + i }));
  c.setDataLoader({ getBars: async ({ callback }) => { callback(bars, { forward: false, backward: false }); }, subscribeBar() {}, unsubscribeBar() {} });
}, closes); await page.waitForTimeout(900); };
const up = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
await inject(up);
const upInfo = await page.evaluate(INFO);
check('②-7 形态①(全正)：三线全为正（min>0）', upInfo.dataNonNull > 0 && upInfo.dataMin > 0, { min: upInfo.dataMin, max: upInfo.dataMax });
check('②-8 形态①(全正)：Y 轴范围仍含 0（range.from ≤ 0 < dataMin）', upInfo.range.from <= 0 && upInfo.range.from < upInfo.dataMin, upInfo.range);
check('②-9 形态①(全正)：0 线 y == y(0) 且在 pane 内', Math.abs(upInfo.y0 - upInfo.yAxisY0) <= 1 && upInfo.y0 >= 0 && upInfo.y0 <= upInfo.paneH, { y0: upInfo.y0, yAxisY0: upInfo.yAxisY0, paneH: upInfo.paneH });
check('②-10 形态①(全正)：y(0) 行渲染出 #76808F 虚线像素', upInfo.gray > 100, { gray: upInfo.gray, gaps: upInfo.grayGaps });
await page.screenshot({ path: `${OUT}/live-issue2-all-positive.png` });

// ② 数据不足：三线断线但 0 线仍在
const short = Array.from({ length: 5 }, (_, i) => 100 + i * 0.5);
await inject(short);
const shortInfo = await page.evaluate(INFO);
check('②-11 数据不足：三条数据线全 null（断线）', shortInfo.dataNonNull === 0, { dataNonNull: shortInfo.dataNonNull, resultLen: shortInfo.resultLen });
check('②-12 数据不足：zero 仍每根 bar 返回 0', shortInfo.zeroIsAllZero, { zeroNonNull: shortInfo.zeroNonNull });
check('②-13 数据不足：Y 轴含 0 且 0 线渲染在 y(0)', shortInfo.range.from <= 0 && shortInfo.range.to >= 0 && Math.abs(shortInfo.y0 - shortInfo.yAxisY0) <= 1 && shortInfo.gray > 5, { range: shortInfo.range, y0: shortInfo.y0, gray: shortInfo.gray });
await page.screenshot({ path: `${OUT}/live-issue2-insufficient.png` });

check('只读保证：全程 0 条非 GET 请求', nonGet.length === 0, nonGet);

fs.writeFileSync(`${OUT}/live-results.json`, JSON.stringify({ base: BASE, results, infos: { offInfo, realInfo, upInfo, shortInfo }, probes: { p0, p1, p2 } }, null, 2));
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' :: ' + JSON.stringify(r.detail).slice(0, 400)}`);
console.log(`\nlive 8081: ${results.length - failed.length}/${results.length} passed; failed=${failed.length}; nonGet=${nonGet.length}`);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
