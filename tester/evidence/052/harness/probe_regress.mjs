/**
 * 阶段 3 独立验收 · 回归探针（真实渲染）。
 *  R-A 指标勾选开/关（DCAP 关 → 开 → 关）：仍正常、不产生空 pane，且不牵连既有 pane（VOL 高度/id 不变）。
 *  R-B MA windows 变化：仍生效（calcParams/线值变）且不重置任何 pane 高度、无 churn、无 remount。
 *  R-C DCAP 回归面：独立副图 pane、precision=5、figures=s/m/l/zero、0 参考线在 Y 标度内、数据不足断线、无异常。
 */
import { chromium, makeOut, checker, PROBE, heights, paneIds, heightDiffs, allWithin1px, seriesDiff, openPage, installRoutes, dragSeparator, saveMaViaUI, toggleIndicator, readLog, writeJson, reportChecks } from './lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18093';
const OUT = process.env.OUT ?? '/tmp/acc3/probe_regress.json';
const EV = process.env.EV ?? '/tmp/acc3/shots';

const out = makeOut(BASE);
const check = checker(out);
const contentPanesOf = (s) => (s.panes ?? []).filter((p) => p.id !== 'x_axis_pane');
const emptyPanes = (s) => contentPanesOf(s).filter((p) => (p.indicators ?? []).length === 0).map((p) => p.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200));
});
await installRoutes(page, out, BASE);
await openPage(page, BASE);

// ── R-A：DCAP 关 → 开 → 关 ──
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
await dragSeparator(page, 0, -150);
await dragSeparator(page, 1, -60);
const a0 = await page.evaluate(PROBE);
out.scenarios.a0_dcap_on_dragged = a0;
out.a0 = { heights: heights(a0), ids: paneIds(a0), paneCount: contentPanesOf(a0).length };
await page.screenshot({ path: `${EV}/regress_A0_dcap_on_dragged.png` });

const seq0 = (await readLog(page)).length;
await toggleIndicator(page, 'DCAP'); // 关
const a1 = await page.evaluate(PROBE);
out.scenarios.a1_dcap_off = a1;
await page.screenshot({ path: `${EV}/regress_A1_dcap_off.png` });
await toggleIndicator(page, 'DCAP'); // 再开
const a2 = await page.evaluate(PROBE);
out.scenarios.a2_dcap_on_again = a2;
await page.screenshot({ path: `${EV}/regress_A2_dcap_on_again.png` });
const burstA = (await readLog(page)).filter((e) => e.seq >= seq0);

out.A = {
  onHeights: heights(a0),
  offHeights: heights(a1),
  onAgainHeights: heights(a2),
  onIds: paneIds(a0),
  offIds: paneIds(a1),
  onAgainIds: paneIds(a2),
  offIndicators: a1.indicators.map((i) => `${i.name}@${i.paneId}`),
  onAgainDcap: a2.dcap,
  emptyPanesOff: emptyPanes(a1),
  emptyPanesOnAgain: emptyPanes(a2),
  burstApis: burstA.map((e) => e.api),
  inits: { a0: a0.inits, a1: a1.inits, a2: a2.inits },
};
check('RA1 DCAP 关：DCAP 指标与副图 pane 均消失，无残留空 pane', a1.indicators.every((i) => i.name !== 'DCAP') && contentPanesOf(a1).length === 2 && emptyPanes(a1).length === 0, { indicators: out.A.offIndicators, panes: out.A.offHeights, empty: out.A.emptyPanesOff });
check('RA2 DCAP 关不牵连既有 pane：VOL pane id 与渲染高度保持不变，仅 candle 吸收腾出的高度', out.A.offIds['VOL'] === out.A.onIds['VOL'] && Math.abs((out.A.offHeights['VOL'] ?? 0) - (out.A.onHeights['VOL'] ?? 0)) <= 1 && (out.A.offHeights['MA'] ?? 0) > (out.A.onHeights['MA'] ?? 0), { ids: { on: out.A.onIds['VOL'], off: out.A.offIds['VOL'] }, heights: { on: out.A.onHeights, off: out.A.offHeights } });
check('RA3 DCAP 再开：恢复独立副图 pane（新 pane id）且带 8 参 calcParams、无空 pane', !!a2.dcap && a2.dcap.paneId !== 'candle_pane' && (a2.dcap.calcParams ?? []).length === 8 && contentPanesOf(a2).length === 3 && emptyPanes(a2).length === 0, { dcap: a2.dcap, heights: out.A.onAgainHeights, empty: out.A.emptyPanesOnAgain });
check('RA4 DCAP 再开不牵连既有 pane：VOL pane id/高度仍不变', out.A.onAgainIds['VOL'] === out.A.onIds['VOL'] && Math.abs((out.A.onAgainHeights['VOL'] ?? 0) - (out.A.onHeights['VOL'] ?? 0)) <= 1, { ids: out.A.onAgainIds, heights: out.A.onAgainHeights });
check('RA5 勾选翻转确实走 create/remove（差分不得吞掉开关语义）', out.A.burstApis.includes('removeIndicator') && out.A.burstApis.includes('createIndicator') && !out.A.burstApis.includes('setDataLoader'), out.A.burstApis);
check('RA6 开关翻转不重建整图（init 计数不变）', a0.inits === a1.inits && a1.inits === a2.inits, out.A.inits);

// ── R-B：MA windows 变化（5,10,20 → 7,20,60）──
await dragSeparator(page, 0, -120);
await dragSeparator(page, 1, -50);
const b0 = await page.evaluate(PROBE);
out.scenarios.b0_before_ma_save = b0;
out.b0 = { heights: heights(b0), ids: paneIds(b0), ma: b0.ma?.calcParams };
const seqB = (await readLog(page)).length;
await saveMaViaUI(page, [7, 20, 60]);
const b1 = await page.evaluate(PROBE);
out.scenarios.b1_after_ma_save = b1;
await page.screenshot({ path: `${EV}/regress_B1_after_ma_save.png` });
const burstB = (await readLog(page)).filter((e) => e.seq >= seqB);
out.B = {
  maBefore: b0.ma?.calcParams,
  maAfter: b1.ma?.calcParams,
  maValueDiff: seriesDiff(b0.ma?.result, b1.ma?.result),
  heightDiff: heightDiffs(b0, b1),
  idsBefore: paneIds(b0),
  idsAfter: paneIds(b1),
  burstApis: burstB.map((e) => e.api),
  churn: burstB.filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator').length,
  inits: { before: b0.inits, after: b1.inits },
  dcapStill: b1.dcap,
  vr: { before: b0.vr, after: b1.vr },
};
check('RB1 MA windows 生效：MA calcParams 5,10,20 → 7,20,60 且线值确实改变', JSON.stringify(b1.ma?.calcParams) === JSON.stringify([7, 20, 60]) && Object.values(out.B.maValueDiff).some((d) => d.nDiff > 0 && d.nNonNull > 0), { params: { before: out.B.maBefore, after: out.B.maAfter }, diff: out.B.maValueDiff });
check('RB2 MA windows 变化不重置 pane 高度（±1px）、pane id 不变', allWithin1px(out.B.heightDiff) && JSON.stringify(out.B.idsBefore) === JSON.stringify(out.B.idsAfter), { heights: out.B.heightDiff, ids: { before: out.B.idsBefore, after: out.B.idsAfter } });
check('RB3 MA windows 变化无 remove/create churn、无整图 remount', out.B.churn === 0 && out.B.inits.before === out.B.inits.after, { churn: out.B.churn, apis: out.B.burstApis, inits: out.B.inits });
check('RB4 MA windows 变化后 DCAP 副图仍完好（独立 pane + 8 参）', !!b1.dcap && b1.dcap.paneId !== 'candle_pane' && (b1.dcap.calcParams ?? []).length === 8, b1.dcap);

// ── R-C：DCAP 回归面（端态）──
const c = b1;
const dc = contentPanesOf(c).find((p) => p.indicators.includes('DCAP'));
const res = c.dcap?.result ?? [];
const nNull = (k) => res.filter((r) => r == null || typeof r[k] !== 'number').length;
out.C = {
  dcap: c.dcap,
  pane: dc ? { id: dc.id, indicators: dc.indicators, yRange: dc.yRange, domH: dc.domH } : null,
  nulls: { n: res.length, s: nNull('s'), m: nNull('m'), l: nNull('l'), zero: nNull('zero') },
  zeroAllZero: res.every((r) => r == null || r.zero === 0),
  panes: contentPanesOf(c).map((p) => ({ id: p.id, indicators: p.indicators, domH: p.domH, yRange: p.yRange })),
};
check('RC1 DCAP 仍是独立副图 pane（paneId≠candle_pane，该 pane 仅 DCAP）', !!dc && c.dcap.paneId !== 'candle_pane' && dc.indicators.length === 1 && dc.indicators[0] === 'DCAP', out.C.pane);
check('RC2 precision=5 且 figures = s/m/l/zero（0 参考线在场）', c.dcap?.precision === 5 && JSON.stringify(c.dcap?.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']), { precision: c.dcap?.precision, figKeys: c.dcap?.figKeys });
check('RC3 0 参考线参与 Y 轴标度：DCAP 副图 Y 标度包含 0（0 线始终可见）', (dc?.yRange ?? []).some((y) => y.from <= 0 && y.to >= 0), dc?.yRange);
check('RC4 0 参考线恒 0（无 null）', out.C.zeroAllZero && out.C.nulls.zero === 0, out.C.nulls);
check('RC5 数据不足处三条数据线仍断线（头部 null）', out.C.nulls.s > 0 && out.C.nulls.m > 0 && out.C.nulls.l > 0, out.C.nulls);
check('RC6 全程无页面错误（无异常抛出/无崩溃）', pageErrors.length === 0, pageErrors.slice(0, 5));
check('RC7 全程无非 GET 请求逃逸（PUT /api/config/ma|dcap 本地兑现）', out.nonGetOther.length === 0, out.nonGetOther);

out.pageErrors = pageErrors;
out.rawBurstA = burstA.map((e) => ({ seq: e.seq, api: e.api, arg: e.arg, paneIdsAfter: e.paneIdsAfter }));
out.rawBurstB = burstB.map((e) => ({ seq: e.seq, api: e.api, arg: e.arg, paneIdsAfter: e.paneIdsAfter }));
writeJson(OUT, out);
reportChecks(out);
await browser.close();
