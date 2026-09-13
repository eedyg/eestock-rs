/**
 * 验收（tester 阶段 3）问题② 独立断言 —— 真实 app（临时实例）+ 真实 klinecharts 10.0.3 渲染。
 * 自建断言：0 线在两组数据形态（三线全正 / 存在负值跨越 0）下始终可见；0 线 y == pane 内 y(0) 映射；
 * 数据不足段三线断线但 0 线仍在；DCAP 关态无 0 线。带 EXPECT=nozero 时用于反向证据（去 zero figure）。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18081';
const MODE = process.env.EXPECT ?? 'real';
const OUT = process.env.OUT ?? '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/048';
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const INFO = () => {
  const charts = window.__CHARTS__ ?? [];
  const live = charts.filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = live[live.length - 1];
  window.__CHART__ = c;
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
    dataMin: dataVals.length ? Math.min(...dataVals) : null,
    dataMax: dataVals.length ? Math.max(...dataVals) : null,
    dataNonNull: dataVals.length,
    zeroNonNull: zeroVals.filter((v) => v === 0).length,
    zeroIsAllZero: zeroVals.length > 0 && zeroVals.every((v) => v === 0),
    range: { from: range.from, to: range.to },
    y0, yAxisY0, paneH: size.height, canvasH: cv.height, scaleY, row,
    gray, grayPixels: gray, firstGrayXs: grayXs.slice(0, 12), grayGaps: gapSet,
  };
};

async function inject(page, closes) {
  await page.evaluate((closes) => {
    const charts = window.__CHARTS__ ?? [];
    const live = charts.filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
    const c = live[live.length - 1];
    const bars = closes.map((close, i) => ({
      timestamp: 1700000000000 + i * 60000, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1000 + i,
    }));
    c.setDataLoader({
      getBars: async ({ callback }) => { callback(bars, { forward: false, backward: false }); },
      subscribeBar() {}, unsubscribeBar() {},
    });
  }, closes);
  await page.waitForTimeout(900);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
await page.waitForTimeout(2200);

// DCAP 关闭态：无 0 线
const offInfo = await page.evaluate(INFO);
check('②-0 DCAP 关闭态：无 DCAP 指标/pane ⇒ 无 0 线', offInfo.hasDcap === false, offInfo);

await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(1800);

// 真实数据（m/l 负、s 正 ⇒ 三线跨越 0）
const realInfo = await page.evaluate(INFO);
check('②-1 DCAP figKeys = s/m/l/zero，precision = 5', JSON.stringify(realInfo.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']) && realInfo.precision === 5, realInfo);
check('②-2 每根 bar 的 zero 恒 = 0', realInfo.zeroIsAllZero, { zeroNonNull: realInfo.zeroNonNull, resultLen: realInfo.resultLen });
check('②-3 真实数据：三线跨越 0（min<0<max）', realInfo.dataMin < 0 && realInfo.dataMax > 0, { min: realInfo.dataMin, max: realInfo.dataMax });
check('②-4 真实数据：副图 Y 轴范围含 0', realInfo.range.from <= 0 && realInfo.range.to >= 0, realInfo.range);
check('②-5 真实数据：0 线 y == yAxis y(0) 且落在 pane 内', Math.abs(realInfo.y0 - realInfo.yAxisY0) <= 1 && realInfo.y0 >= 0 && realInfo.y0 <= realInfo.paneH, { y0: realInfo.y0, yAxisY0: realInfo.yAxisY0, paneH: realInfo.paneH });
check('②-6 真实数据：canvas 在 y(0) 行渲染出 #76808F 虚线（像素）', realInfo.gray > 100, { row: realInfo.row, gray: realInfo.gray, gaps: realInfo.grayGaps });
await page.screenshot({ path: `${OUT}/issue2-real.png` });

// 形态①：三线全为正
const up = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
await inject(page, up);
const upInfo = await page.evaluate(INFO);
check('②-7 形态①(全正)：三线全为正（min>0）', upInfo.dataNonNull > 0 && upInfo.dataMin > 0, { min: upInfo.dataMin, max: upInfo.dataMax, n: upInfo.dataNonNull });
check('②-8 形态①(全正)：Y 轴范围仍含 0（range.from ≤ 0 < 数据 min）⇒ 0 线在可视范围', upInfo.range.from <= 0 && upInfo.range.from < upInfo.dataMin, { range: upInfo.range, dataMin: upInfo.dataMin });
check('②-9 形态①(全正)：0 线 y == y(0) 映射且落在 pane 内', Math.abs(upInfo.y0 - upInfo.yAxisY0) <= 1 && upInfo.y0 >= 0 && upInfo.y0 <= upInfo.paneH, { y0: upInfo.y0, paneH: upInfo.paneH });
check('②-10 形态①(全正)：canvas 在 y(0) 行渲染出 #76808F 虚线（像素）', upInfo.gray > 100, { row: upInfo.row, gray: upInfo.gray, gaps: upInfo.grayGaps });
await page.screenshot({ path: `${OUT}/issue2-all-positive.png` });

// 形态②：存在负值跨越 0（降后升）
const mixed = Array.from({ length: 220 }, (_, i) => (i < 110 ? 200 - i * 0.6 : 134 + (i - 110) * 0.6));
await inject(page, mixed);
const mixInfo = await page.evaluate(INFO);
check('②-11 形态②(跨 0)：三线存在负值且跨越 0（min<0<max）', mixInfo.dataMin < 0 && mixInfo.dataMax > 0, { min: mixInfo.dataMin, max: mixInfo.dataMax });
check('②-12 形态②(跨 0)：Y 轴范围含 0', mixInfo.range.from <= 0 && mixInfo.range.to >= 0, mixInfo.range);
check('②-13 形态②(跨 0)：0 线 y == y(0) 映射且落在 pane 内', Math.abs(mixInfo.y0 - mixInfo.yAxisY0) <= 1 && mixInfo.y0 >= 0 && mixInfo.y0 <= mixInfo.paneH, { y0: mixInfo.y0, paneH: mixInfo.paneH });
check('②-14 形态②(跨 0)：canvas 在 y(0) 行渲染出 #76808F 虚线（像素）', mixInfo.gray > 100, { row: mixInfo.row, gray: mixInfo.gray, gaps: mixInfo.grayGaps });
await page.screenshot({ path: `${OUT}/issue2-cross-zero.png` });

// 数据不足：三线断线但 0 线仍在
const short = Array.from({ length: 5 }, (_, i) => 100 + i * 0.5);
await inject(page, short);
const shortInfo = await page.evaluate(INFO);
check('②-15 数据不足：三条数据线全 null（断线）', shortInfo.dataNonNull === 0, { dataNonNull: shortInfo.dataNonNull, resultLen: shortInfo.resultLen });
check('②-16 数据不足：zero 仍每根 bar 返回 0（0 线不随数据不足消失）', shortInfo.zeroIsAllZero, { zeroNonNull: shortInfo.zeroNonNull, resultLen: shortInfo.resultLen });
check('②-17 数据不足：Y 轴范围含 0 且 0 线渲染在 y(0)', shortInfo.range.from <= 0 && shortInfo.range.to >= 0 && Math.abs(shortInfo.y0 - shortInfo.yAxisY0) <= 1 && shortInfo.gray > 5, { range: shortInfo.range, y0: shortInfo.y0, gray: shortInfo.gray });
await page.screenshot({ path: `${OUT}/issue2-insufficient.png` });

fs.writeFileSync(`${OUT}/issue2-results-${MODE}.json`, JSON.stringify({ base: BASE, mode: MODE, results, infos: { offInfo, realInfo, upInfo, mixInfo, shortInfo } }, null, 2));
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\nissue②[${MODE}]: ${results.length - failed.length}/${results.length} passed; failed=${failed.length}`);
await browser.close();
if (MODE === 'real') process.exit(failed.length === 0 ? 0 : 1);
// nozero：反向证据 → 期望至少 ②-8（全正却含 0）变红
process.exit(failed.length > 0 ? 0 : 1);
