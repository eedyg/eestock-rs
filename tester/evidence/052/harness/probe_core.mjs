/**
 * 阶段 3 独立验收 · 核心场景探针（真实渲染）。
 * 场景：DCAP 开 → 把 VOL pane 与 DCAP pane 拖到非默认高度（记录基线）→ 走真实「保存 dcap 参数」路径
 *       连续 3 次（r_m 变 / m 变（warmup 变）/ n_l 变（warmup 变））→ 断言：
 *       (H1) 所有既有 pane 渲染高度保持 ±1px；(H2) pane id 集合不变；(H3) 无整图 remount（init 计数不变）；
 *       (H4) 期间无 removeIndicator/createIndicator churn；(H5) DCAP calcParams 按新参数；
 *       (H6) DCAP 线值按新参数确实更新（参数敏感度：逐点差异计数 + 最大绝对差）；
 *       (H7) zero 恒 0、长度对齐；(H8) DCAP 仍是独立副图 pane 且 precision=5、figures=s/m/l/zero；
 *       (H9) 无页面错误/异常。
 * 变异（反向证据用）：MUT=1 ⇒ 浏览器侧 __ACC__.mut.disableOverride = true（overrideIndicator 变 no-op）。
 */
import { chromium, makeOut, checker, PROBE, heights, paneIds, heightDiffs, allWithin1px, seriesDiff, openPage, installRoutes, dragSeparator, saveDcapViaUI, readLog, writeJson, reportChecks } from './lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18093';
const OUT = process.env.OUT ?? '/tmp/acc3/probe_core.json';
const EV = process.env.EV ?? '/tmp/acc3/shots';
const MUT = process.env.MUT === '1';
const TAG = process.env.TAG ?? 'cur';

const out = makeOut(BASE);
out.tag = TAG;
out.mutation = { disableOverride: MUT };
const check = checker(out);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200));
});
await installRoutes(page, out, BASE);
await openPage(page, BASE);

if (MUT) {
  // 变异：让 overrideIndicator 彻底不调用（等价“参数变更不调用 override”）
  out.mutationApplied = await page.evaluate(() => {
    window.__ACC_SET_MUT__({ disableOverride: true });
    return window.__ACC__?.mut;
  });
}

// ① DCAP 开
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2500);
const sOn = await page.evaluate(PROBE);
out.scenarios.sOn = sOn;
check('P0 DCAP 开启后存在 DCAP 独立副图 pane', !!sOn.dcap && sOn.dcap.paneId !== 'candle_pane', { paneId: sOn.dcap?.paneId, panes: heights(sOn) });

// ② 归一到已知基准参数（保存 #0：8/26/60/1/1/1/1/3；不进高度系列断言）
await saveDcapViaUI(page, [
  ['n_s', 8],
  ['n_m', 26],
  ['n_l', 60],
  ['r_s', 1],
  ['r_m', 1],
  ['r_l', 1],
  ['m', 3],
]);
const sNorm = await page.evaluate(PROBE);
out.scenarios.sNormalized = sNorm;
const P0 = sNorm.dcap?.calcParams;
check('P1 基准参数归一后 DCAP calcParams = [8,26,60,1,1,1,1,3]', JSON.stringify(P0) === JSON.stringify([8, 26, 60, 1, 1, 1, 1, 3]), P0);

// ③ 拖到非默认高度（candle↔VOL 上移 150px；VOL↔DCAP 上移 60px ⇒ DCAP 变高、VOL 净 +90）
out.sepInfo = [await dragSeparator(page, 0, -150), await dragSeparator(page, 1, -60)];
const B0 = await page.evaluate(PROBE);
out.scenarios.baseline = B0;
out.baselineHeights = heights(B0);
out.baselinePaneIds = paneIds(B0);
out.rawLog = await readLog(page);
await page.screenshot({ path: `${EV}/core_0_baseline_dragged.png` });
check(
  'P2 基线：VOL 与 DCAP 均处于非默认高度（>默认 100px）',
  out.baselineHeights['VOL'] > 120 && out.baselineHeights['DCAP'] > 120,
  out.baselineHeights,
);
check('P3 基线 pane 集合 = candle + VOL + DCAP（3 个内容 pane）', Object.keys(out.baselineHeights).length === 3, out.baselineHeights);

// ④ 连续 3 次真实保存（r 变 / m 变（warmup 变）/ n_l 变（warmup 变））
const saves = [
  { id: 'S1', edits: [['r_m', 1.5]], expect: [8, 26, 60, 1, 1.5, 1, 1, 3], warmupChanged: false, label: 'r_m 1→1.5' },
  { id: 'S2', edits: [['m', 5]], expect: [8, 26, 60, 1, 1.5, 1, 1, 5], warmupChanged: true, label: 'm 3→5（warmup 62→64）' },
  { id: 'S3', edits: [['n_l', 80]], expect: [8, 26, 80, 1, 1.5, 1, 1, 5], warmupChanged: true, label: 'n_l 60→80（warmup 64→84）' },
];
out.saves = [];
let prev = B0;
for (const [i, s] of saves.entries()) {
  const klineBefore = out.klineGets;
  const seqBefore = (await readLog(page)).length;
  await saveDcapViaUI(page, s.edits);
  const after = await page.evaluate(PROBE);
  const log = await readLog(page);
  const b = log.filter((e) => e.seq >= seqBefore);
  const rec = {
    id: s.id,
    label: s.label,
    expectCalcParams: s.expect,
    calcParams: after.dcap?.calcParams,
    heightsBefore: heights(prev),
    heightsAfter: heights(after),
    idDiffs: heightDiffs(prev, after),
    paneIdsBefore: paneIds(prev),
    paneIdsAfter: paneIds(after),
    inits: { before: prev.inits, after: after.inits },
    klineGets: { delta: out.klineGets - klineBefore },
    dataLen: { before: prev.data.length, after: after.data.length },
    burstApis: b.map((e) => e.api),
    churnCount: b.filter((e) => e.api === 'removeIndicator' || e.api === 'createIndicator').length,
    overrideCalls: b.filter((e) => e.api.startsWith('overrideIndicator')).map((e) => e.arg),
    sensitivity: seriesDiff(prev.dcap?.result, after.dcap?.result),
    zeroAllZero: (after.dcap?.result ?? []).every((r) => r == null || r.zero === 0),
    // 供离线独立 oracle 复算：本步 chart 的 dataList（closes）与 chart 上 DCAP 的 result 原值
    closes: after.data.map((d) => d.close),
    result: after.dcap?.result ?? [],
    resultLen: (after.dcap?.result ?? []).length,
    vr: { before: prev.vr, after: after.vr },
  };
  out.saves.push(rec);
  await page.screenshot({ path: `${EV}/core_${i + 1}_after_${s.id}.png` });

  check(`${s.id}-H1 保存后所有既有 pane 渲染高度保持 ±1px（${s.label}）`, allWithin1px(rec.idDiffs), rec.idDiffs);
  check(`${s.id}-H2 保存后 pane id 集合不变（无销毁重建）`, JSON.stringify(rec.paneIdsBefore) === JSON.stringify(rec.paneIdsAfter), { before: rec.paneIdsBefore, after: rec.paneIdsAfter });
  check(`${s.id}-H3 保存后无整图 remount（init 计数不变）`, rec.inits.before === rec.inits.after, rec.inits);
  check(`${s.id}-H4 保存期间无 removeIndicator/createIndicator churn（参数变化只走 override）`, rec.churnCount === 0, { churnCount: rec.churnCount, apis: rec.burstApis });
  check(`${s.id}-H5 DCAP calcParams 按新参数生效`, JSON.stringify(rec.calcParams) === JSON.stringify(s.expect), { got: rec.calcParams, want: s.expect });
  const sd = rec.sensitivity;
  const sensOk = ['s', 'm', 'l'].some((k) => sd[k].nDiff > 0 && sd[k].maxAbsDelta > 1e-9);
  check(`${s.id}-H6 DCAP 线值确实按新参数更新（参数敏感度：有可测差异）`, sensOk, sd);
  check(`${s.id}-H7 zero 参考线恒 0 且 result 长度 = dataList 长度`, rec.zeroAllZero && rec.resultLen === rec.dataLen.after, { zeroAllZero: rec.zeroAllZero, resultLen: rec.resultLen, dataLen: rec.dataLen.after });
  prev = after;
}

// ⑤ 端态复核
const end = await page.evaluate(PROBE);
out.scenarios.end = end;
out.endHeights = heights(end);
out.endPaneIds = paneIds(end);
out.baselineVsEnd = heightDiffs(B0, end);
check('P4 【核心】基线 → 3 次保存后，VOL/DCAP/candle 渲染高度仍与基线一致（±1px）', allWithin1px(out.baselineVsEnd), out.baselineVsEnd);
check('P5 端态 DCAP 仍是独立副图 pane（paneId≠candle_pane）、precision=5、figures=s,m,l,zero', (() => {
  const d = end.indicators.find((i) => i.name === 'DCAP');
  const dc = contentPanesOf(end).find((p) => p.indicators.includes('DCAP'));
  return !!d && d.paneId !== 'candle_pane' && d.precision === 5 && JSON.stringify(d.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']) && dc && dc.indicators.length === 1;
})(), (() => {
  const d = end.indicators.find((i) => i.name === 'DCAP');
  const dc = contentPanesOf(end).find((p) => p.indicators.includes('DCAP'));
  return { dcap: d, pane: dc ? { id: dc.id, indicators: dc.indicators, yRange: dc.yRange } : null };
})());
check('P6 端态 DCAP 副图 Y 轴标度包含 0（0 参考线在标度内 ⇒ 可见）', (() => {
  const dc = contentPanesOf(end).find((p) => p.indicators.includes('DCAP'));
  return !!dc && (dc.yRange ?? []).some((y) => y.from <= 0 && y.to >= 0);
})(), contentPanesOf(end).find((p) => p.indicators.includes('DCAP'))?.yRange);
check('P7 数据不足处 DCAP 三线仍断线（头部存在 null），zero 无 null', (() => {
  const res = end.dcap?.result ?? [];
  const nulls = (k) => res.filter((r) => r == null || typeof r[k] !== 'number').length;
  return nulls('s') > 0 && nulls('m') > 0 && nulls('l') > 0 && nulls('zero') === 0;
})(), (() => {
  const res = end.dcap?.result ?? [];
  const nulls = (k) => res.filter((r) => r == null || typeof r[k] !== 'number').length;
  return { n: res.length, nullS: nulls('s'), nullM: nulls('m'), nullL: nulls('l'), nullZero: nulls('zero') };
})());
check('P8 全程无页面错误（无异常抛出/无崩溃）', pageErrors.length === 0, pageErrors.slice(0, 5));
check('P9 全程无非 GET 请求逃逸（PUT 全部浏览器侧本地兑现）', out.nonGetOther.length === 0, out.nonGetOther);

function contentPanesOf(st) {
  return (st.panes ?? []).filter((p) => p.id !== 'x_axis_pane');
}

out.pageErrors = pageErrors;
writeJson(OUT, out);
reportChecks(out);
await browser.close();
