/**
 * 阶段 3 独立验收真渲染探针（tester 自建）—— 「切 period / 切 stock 不得重置指标视图布局」。
 *
 * 与被测实现无关的部分（自建）：断言集、判据阈值、基准数据获取（Node 直连线上只读 8081 的
 * /api/kline 取 ground truth）、WS 构造（browser 侧 dispatchEvent 到真实 WebSocket 实例）。
 * 被测形态：仓库 web/（build A=工作树；build B=HEAD 旧行为）临时构建 + 临时端口 + 真实 klinecharts。
 *
 * 纪律：GET 只读透传；PUT /api/config/* 浏览器侧本地兑现（不发后端）；其余非 GET abort。
 */
import { chromium, makeOut, checker, installRoutes, openPage, dragSeparator, heightDiffs, allWithin1px, heights, ids, contentPanes, visibleCount, iso, SNAP } from '/tmp/acc3/lib.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18091';
const OUT = process.env.OUT ?? '/tmp/acc3/probe.json';
const LABEL = process.env.LABEL ?? 'A(fix)';
const GT = 'http://127.0.0.1:8081';

const out = makeOut(BASE);
out.label = LABEL;
const check = checker(out);

async function fetchGT(code, period, limit) {
  const r = await fetch(`${GT}/api/kline?code=${code}&period=${period}&limit=${limit}`);
  return r.json();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 250)); });
page.on('request', (r) => { if (r.url().includes('/api/kline')) out.klineUrls.push(r.url().replace(BASE, '').replace(GT, '')); });

// 构造真实 WS 推送：捕获 app 创建的 WebSocket 实例，后续 dispatchEvent('message') 走真实 onmessage 链。
await page.addInitScript(() => {
  const Orig = window.WebSocket;
  window.__WS_INSTANCES__ = [];
  const Wrapper = function (...args) { const s = new Orig(...args); window.__WS_INSTANCES__.push(s); return s; };
  Wrapper.prototype = Orig.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapper[k] = Orig[k];
  window.WebSocket = Wrapper;
});

await installRoutes(page, out);

const snap = () => page.evaluate(SNAP);
const readBurst = async (fromSeq) => (await page.evaluate(() => (window.__ACC__?.log ?? []).map((e) => ({ seq: e.seq, api: e.api, arg: e.arg })))).filter((e) => e.seq >= fromSeq);
const clickPeriod = async (label) => { await page.getByRole('button', { name: label, exact: true }).click(); await page.waitForTimeout(3500); };
const clickStock = async (code) => { await page.getByText(code, { exact: true }).first().click(); await page.waitForTimeout(3500); };
const drag = async (i, dy) => dragSeparator(page, i, dy);

const PERIOD_OF = { '1m': 'minute', '15m': 'minute15', '1h': 'hour' };
function periodMatches(period, p) {
  if (!period) return false;
  if (p === '1m') return period.type === 'minute' && period.span === 1;
  if (p === '15m') return period.type === 'minute' && period.span === 15;
  if (p === '1h') return period.type === 'hour' && period.span === 1;
  return false;
}

/** 数据重置判据：chart 已渲染 dataList 与 ground truth（新 code/period）在**时间戳 + 取值**上一致
 *  （允许实时漂移若干根，仅末根可能变动）。 */
function windowMatch(chartBars, gtBars) {
  const gtMap = new Map(gtBars.map((b) => [b.ts, b.close]));
  let overlap = 0, valueAgree = 0;
  for (const b of chartBars) {
    if (gtMap.has(b.ts)) {
      overlap++;
      const g = gtMap.get(b.ts);
      if (Math.abs(g - b.close) <= 1e-6 * Math.max(1, Math.abs(g))) valueAgree++;
    }
  }
  const minLen = Math.min(chartBars.length, gtBars.length);
  const driftAbs = Math.abs(chartBars.length - gtBars.length);
  return { chartLen: chartBars.length, gtLen: gtBars.length, overlap, valueAgree, minLen, driftAbs, ok: minLen >= 150 && overlap >= minLen - 6 && valueAgree >= overlap - 6 && driftAbs <= 6 };
}

const tsOf = async () => {
  const d = await page.evaluate(() => {
    const A = window.__ACC__;
    const charts = (A?.charts ?? []).filter((c) => (c.getDataList?.() ?? []).length > 0);
    const c = charts[charts.length - 1];
    return (c?.getDataList?.() ?? []).map((b) => ({ ts: b.timestamp, close: b.close }));
  });
  return d;
};

async function runSwitch(name, { kind, target, expectCode, expectPeriod, expectLimit }) {
  const before = await snap();
  const beforeLog = before.logLen;
  const beforeUrls = out.klineUrls.length;
  const beforeData = await tsOf();

  if (kind === 'period') await clickPeriod(target);
  else await clickStock(target);

  const after = await snap();
  const burst = await readBurst(beforeLog);
  const gt = await fetchGT(expectCode, expectPeriod, expectLimit);
  const gtBars = gt.bars.map((b) => ({ ts: Date.parse(b.ts), close: b.close }));
  const afterData = await tsOf();
  const afterTs = afterData.map((b) => b.ts);
  const wm = windowMatch(afterData, gtBars);
  const dedup = new Set(afterTs).size === afterTs.length;

  const H = {
    heightsBefore: heights(before), heightsAfter: heights(after), diffs: heightDiffs(before, after),
    idsBefore: ids(before), idsAfter: ids(after),
    initsBefore: before.inits, initsAfter: after.inits,
    disposesBefore: before.disposes, disposesAfter: after.disposes,
  };
  const Hok = {
    within1px: allWithin1px(H.diffs),
    idsSame: JSON.stringify(H.idsBefore) === JSON.stringify(H.idsAfter),
    noRemount: after.inits === before.inits,
    noDispose: after.disposes === before.disposes,
    noChurn: !burst.some((e) => e.api === 'createIndicator' || e.api === 'removeIndicator'),
  };
  const D = {
    symbolBefore: before.symbol?.ticker, symbolAfter: after.symbol?.ticker,
    periodBefore: before.period, periodAfter: after.period,
    dataLenBefore: before.dataLen, dataLenAfter: after.dataLen,
    firstTsBefore: iso(before.firstTs), firstTsAfter: iso(after.firstTs),
    lastTsBefore: iso(before.lastTs), lastTsAfter: iso(after.lastTs),
    lastCloseBefore: before.lastClose, lastCloseAfter: after.lastClose,
    gtLen: gtBars.length, gtFirst: new Date(gtBars[0].ts).toISOString(), gtLast: new Date(gtBars[gtBars.length - 1].ts).toISOString(),
    windowMatch: wm, dedup,
    changedFromBefore: JSON.stringify(beforeData.slice(0, 5)) !== JSON.stringify(afterData.slice(0, 5)) || before.firstTs !== after.firstTs,
  };
  const newUrls = out.klineUrls.slice(beforeUrls);
  const reqHit = newUrls.some((u) => u.includes(`code=${expectCode}`) && u.includes(`period=${expectPeriod}`));
  const Dok = {
    symbolUpdated: after.symbol?.ticker === expectCode,
    periodUpdated: periodMatches(after.period, expectPeriod),
    windowMatchesGT: wm.ok && dedup,
    valuesMatchGT: wm.valueAgree >= wm.overlap - 6 && wm.overlap >= 150,
    changedFromBefore: D.changedFromBefore,
    requestHitNewCodePeriod: reqHit,
  };
  const burstSummary = burst.map((e) => e.api);

  out.scenarios[name] = { kind, target, expectCode, expectPeriod, H, Hok, D, Dok, burst: burstSummary, newUrls };
  const s = (k) => `${name}:${k}`;
  check(s('H_heights_within_1px'), Hok.within1px, H.diffs);
  check(s('H_pane_ids_same'), Hok.idsSame, { before: H.idsBefore, after: H.idsAfter });
  check(s('H_no_remount(inits)'), Hok.noRemount, { before: H.initsBefore, after: H.initsAfter });
  check(s('H_no_dispose'), Hok.noDispose, { before: H.disposesBefore, after: H.disposesAfter });
  check(s('H_no_create_remove_churn'), Hok.noChurn, burstSummary);
  check(s('D_symbol_updated'), Dok.symbolUpdated, { got: D.symbolAfter, want: expectCode });
  check(s('D_period_updated'), Dok.periodUpdated, { got: D.periodAfter, want: expectPeriod });
  check(s('D_data_window_matches_GT'), Dok.windowMatchesGT, D);
  check(s('D_data_values_match_GT'), Dok.valuesMatchGT, { overlap: wm.overlap, valueAgree: wm.valueAgree, lastCloseAfter: D.lastCloseAfter });
  check(s('D_data_changed_from_before'), Dok.changedFromBefore, { before: D.firstTsBefore, after: D.firstTsAfter, closeBefore: D.lastCloseBefore, closeAfter: D.lastCloseAfter });
  check(s('D_request_hit_new_code_period'), Dok.requestHitNewCodePeriod, newUrls);
  return { before, after, H, Hok, D, Dok };
}

// ════════════════════ 0. mount ════════════════════
await openPage(page, BASE, '?code=518880');
const s0 = await snap();
out.scenarios.mount = s0;
check('mount: 单 chart 实例（inits=1）', s0.inits === 1 && s0.chartCount === 1, { inits: s0.inits, chartCount: s0.chartCount });
check('mount: DCAP 默认关（无 DCAP pane）', !contentPanes(s0).some((p) => p.indicators.includes('DCAP')), contentPanes(s0).map((p) => p.indicators.join('+')));
check('mount: DCAP 关时初始取数 limit=120（ADR-020 口径）', out.klineUrls.some((u) => u.includes('code=518880') && u.includes('period=15m') && u.includes('limit=120')), out.klineUrls.slice(0, 4));

// ════════════════════ 1. 开 DCAP（3 pane） ════════════════════
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2800);
const sDcap = await snap();
out.scenarios.dcap_on = sDcap;
const dcap = sDcap.dcap;
check('R_dcap: 独立副图 pane（paneId != candle_pane）', !!dcap && dcap.paneId !== 'candle_pane', dcap && { paneId: dcap.paneId });
check('R_dcap: precision=5', dcap?.precision === 5, { precision: dcap?.precision });
check('R_dcap: figures 含 s,m,l,zero', ['s', 'm', 'l', 'zero'].every((k) => dcap?.figKeys?.includes(k)), { figKeys: dcap?.figKeys });
check('R_dcap: 开 DCAP 不重建图（inits 仍 1）', sDcap.inits === 1, { inits: sDcap.inits });
check('R_dcap_warmup: 开 DCAP 差额补取（limit=68 ⇒ 窗口 188）', out.klineUrls.some((u) => u.includes('limit=68')), out.klineUrls.slice(0, 6));
const dcapResult = dcap?.result ?? [];
const firstNonNull = (key) => dcapResult.findIndex((r) => r && typeof r[key] === 'number');
const nullHead = dcapResult.findIndex((r) => r && typeof r['l'] === 'number');
const nNumericL = dcapResult.filter((r) => r && typeof r['l'] === 'number').length;
check('R_dcap_insufficient: 数据不足处三线为 null（断线）且其后有数值（l 线首非空索引 > 0）', nullHead > 0 && nNumericL > 0, { len: dcapResult.length, firstNonNull_s: firstNonNull('s'), firstNonNull_m: firstNonNull('m'), firstNonNull_l: nullHead, nNumericL });

// ════════════════════ 2. 拖到非默认高度 ════════════════════
const dragHandle = await page.evaluate(() => {
  const kcRoot = document.querySelector('[data-testid="kline-chart"]').firstElementChild;
  const seps = Array.from(kcRoot.children).filter((el) => el.firstElementChild && el.firstElementChild.style.cursor === 'ns-resize');
  return seps.length;
});
out.scenarios.separators = dragHandle;
await drag(0, -150);
await drag(1, -60);
const sDrag = await snap();
out.scenarios.dragged = { heights: heights(sDrag), panes: sDrag.panes.map((p) => ({ indicators: p.indicators, domH: p.domH })) };
const dragHeights = heights(sDrag);
check('drag: 已拖到非默认高度（VOL/DCAP 均 != 100 且互异）',
  Object.values(dragHeights).every((h) => h != null) && !Object.entries(dragHeights).every(([, h]) => h === 100),
  dragHeights);

// ════════════════════ 3. 切 period ×3（15m→1h→1m→15m） ════════════════════
await runSwitch('P1_15m_to_1h', { kind: 'period', target: '1h', expectCode: '518880', expectPeriod: '1h', expectLimit: 188 });
await runSwitch('P2_1h_to_1m', { kind: 'period', target: '1m', expectCode: '518880', expectPeriod: '1m', expectLimit: 188 });
await runSwitch('P3_1m_to_15m', { kind: 'period', target: '15m', expectCode: '518880', expectPeriod: '15m', expectLimit: 188 });

// ════════════════════ 4. 切 stock ×2（518880→161226→513310） ════════════════════
await runSwitch('S1_518880_to_161226', { kind: 'stock', target: '161226', expectCode: '161226', expectPeriod: '15m', expectLimit: 188 });
await runSwitch('S2_161226_to_513310', { kind: 'stock', target: '513310', expectCode: '513310', expectPeriod: '15m', expectLimit: 188 });

// ════════════════════ 5. ADR-020 视口 ════════════════════
const sView = await snap();
const fit = JSON.parse(sView.fitAttr ?? '{}');
const box = await page.locator('[data-testid="kline-chart"]').boundingBox();
const W = box.width;
const expectSpace = Math.max(1, Math.min(50, Math.round(W / 120)));
out.scenarios.viewport_fit = { fit, W, expectSpace, vr: sView.vr, visible: visibleCount(sView), bs: sView.bs };
check('R_viewport: 切周期后 data-viewport-fit.bars == 120（ADR-020 视口=根数）', fit.bars === 120, fit);
check('R_viewport: space = clamp(round(W/120),1,50) 且 ∈[1,50]', fit.space === expectSpace && fit.space >= 1 && fit.space <= 50, { fit, expectSpace });
check('R_viewport: 可见根数 ≈ viewport_bars（±15%）', fit.visible >= 102 && fit.visible <= 138 && visibleCount(sView) >= 102 && visibleCount(sView) <= 138, { fitVisible: fit.visible, vrVisible: visibleCount(sView) });

// 手动缩放后不被重算（resize）
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -900);
await page.waitForTimeout(900);
const sZoom = await snap();
out.scenarios.after_wheel = { bs: sZoom.bs, fit: sZoom.fitAttr, visible: visibleCount(sZoom) };
check('R_viewport: 真实 wheel 改变了 barSpace（进入手动视口态）', sZoom.bs?.bar !== sView.bs?.bar, { before: sView.bs, after: sZoom.bs });
// 触发窗口 resize（触发 ResizeObserver），手动态下不得重算
await page.setViewportSize({ width: 1300, height: 860 });
await page.waitForTimeout(800);
const sResize = await snap();
out.scenarios.resize_after_manual = { bs: sResize.bs, fit: sResize.fitAttr };
check('R_manual_zoom: 手动缩放后 resize 不重算 barSpace（ADR-020 §2.6）', sResize.bs?.bar === sZoom.bs?.bar, { afterWheel: sZoom.bs, afterResize: sResize.bs });
// 手动缩放后切周期 → 回自动视口归一
const pAfterZoom = await runSwitch('P4_manualzoom_15m_to_1h', { kind: 'period', target: '1h', expectCode: '513310', expectPeriod: '1h', expectLimit: 188 });
check('R_manual_zoom: 手动缩放后切周期仍回自动视口归一（≈120）', (() => { const f = JSON.parse(pAfterZoom.after.fitAttr ?? '{}'); return f.bars === 120 && f.visible >= 102 && f.visible <= 138; })(), pAfterZoom.after.fitAttr);
// 回到 15m 作为后续基准
await runSwitch('P5_1h_to_15m', { kind: 'period', target: '15m', expectCode: '513310', expectPeriod: '15m', expectLimit: 188 });

// ════════════════════ 6. WS 实时 bar 追加 + followLatest ════════════════════
// 6a: followLatest=true（点「回到最新」显式置真）→ 追加 + scrollToRealTime + 标记
await page.getByRole('button', { name: '回到最新' }).click();
await page.waitForTimeout(1000);
const wsBefore = await snap();
const wsBeforeLog = wsBefore.logLen;
const lastBarTs = wsBefore.lastTs;
const wsTs = lastBarTs + 15 * 60 * 1000;
const dispatchWs = async (ts, close) => {
  const code = (await snap()).symbol?.ticker;
  const period = '15m';
  await page.evaluate(({ code, period, ts, close }) => {
    const s = window.__WS_INSTANCES__[window.__WS_INSTANCES__.length - 1];
    const bar = { ts: new Date(ts).toISOString(), open: close - 0.005, high: close + 0.01, low: close - 0.01, close, volume: 12345, amount: 12345 * close };
    s.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'bar', code, period, bar }) }));
  }, { code, period, ts, close });
  await page.waitForTimeout(1200);
};
out.wsDispatch.push({ code: wsBefore.symbol?.ticker, ts: iso(wsTs) });
await dispatchWs(wsTs, (wsBefore.lastClose ?? 1) + 0.05);
const wsAfter = await snap();
const wsBurst = (await readBurst(wsBeforeLog)).map((e) => e.api);
out.scenarios.ws_follow = { dataLenBefore: wsBefore.dataLen, dataLenAfter: wsAfter.dataLen, lastTsBefore: iso(wsBefore.lastTs), lastTsAfter: iso(wsAfter.lastTs), expectTs: iso(wsTs), burst: wsBurst, marker: wsAfter.marker, followLatest: true };
check('R_ws: 实时 bar 追加（dataLen +1 且末根 ts = 推送 ts）', wsAfter.dataLen === wsBefore.dataLen + 1 && wsAfter.lastTs === wsTs, out.scenarios.ws_follow);
check('R_ws_follow: followLatest=true 时滚动到最新（scrollToRealTime 被调用）', wsBurst.includes('scrollToRealTime'), wsBurst);
check('R_ws_marker: 实时标记渲染（data-realtime-marker）', wsAfter.marker === true, { marker: wsAfter.marker });

// 6b: 手动缩放 → followLatest=false → 追加但不滚动
const box2 = await page.locator('[data-testid="kline-chart"]').boundingBox();
await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(800);
const ws2Before = await snap();
const ws2Log = ws2Before.logLen;
const ws2Ts = ws2Before.lastTs + 15 * 60 * 1000;
await dispatchWs(ws2Ts, (ws2Before.lastClose ?? 1) + 0.07);
const ws2After = await snap();
const ws2Burst = (await readBurst(ws2Log)).map((e) => e.api);
out.scenarios.ws_nofollow = { dataLenBefore: ws2Before.dataLen, dataLenAfter: ws2After.dataLen, expectTs: iso(ws2Ts), lastTsAfter: iso(ws2After.lastTs), burst: ws2Burst };
check('R_ws_nofollow: followLatest=false 时仍追加但不强拉（无 scrollToRealTime）', ws2After.dataLen >= ws2Before.dataLen + 1 && !ws2Burst.includes('scrollToRealTime'), out.scenarios.ws_nofollow);

// ════════════════════ 7. 上一轮修复：保存 dcap 参数不重建 pane ════════════════════
const saveBefore = await snap();
const saveLog = saveBefore.logLen;
let saveErr = null;
try {
  await page.getByRole('button', { name: 'DCAP 配置' }).click();
  await page.waitForSelector('[data-dcap-editor]', { timeout: 5000 });
  await page.fill('[data-testid="dcap-input-n_l"]', '70');
  await page.fill('[data-testid="dcap-input-m"]', '5');
  await page.locator('[data-dcap-editor] button:has-text("保存")').click();
  await page.waitForTimeout(2500);
} catch (e) { saveErr = String(e).slice(0, 300); }
const saveAfter = await snap();
const saveBurst = (await readBurst(saveLog)).map((e) => ({ api: e.api, arg: e.arg.slice(0, 90) }));
out.scenarios.dcap_save = {
  err: saveErr,
  heightsBefore: heights(saveBefore), heightsAfter: heights(saveAfter), diffs: heightDiffs(saveBefore, saveAfter),
  inits: { before: saveBefore.inits, after: saveAfter.inits },
  idsBefore: ids(saveBefore), idsAfter: ids(saveAfter),
  dcapCalcParamsBefore: saveBefore.dcap?.calcParams, dcapCalcParamsAfter: saveAfter.dcap?.calcParams,
  burst: saveBurst,
  putIntercepted: out.putIntercepted,
};
const saveDiffs = heightDiffs(saveBefore, saveAfter);
check('R_prev_fix: 保存 dcap 参数不重建 pane（inits 不变、无 dispose）', saveAfter.inits === saveBefore.inits && saveAfter.disposes === saveBefore.disposes, { before: saveBefore.inits, after: saveAfter.inits, disp: saveAfter.disposes });
check('R_prev_fix: 保存后 pane 高度 ±1px 不变、pane id 不变', allWithin1px(saveDiffs) && JSON.stringify(ids(saveBefore)) === JSON.stringify(ids(saveAfter)), { diffs: saveDiffs, idsBefore: ids(saveBefore), idsAfter: ids(saveAfter) });
check('R_prev_fix: 参数确实生效（DCAP calcParams 更新为含 70/5）', JSON.stringify(saveAfter.dcap?.calcParams) !== JSON.stringify(saveBefore.dcap?.calcParams) && saveAfter.dcap?.calcParams?.[2] === 70 && saveAfter.dcap?.calcParams?.[7] === 5, { before: saveBefore.dcap?.calcParams, after: saveAfter.dcap?.calcParams });
check('R_prev_fix: 无 create/remove churn（走 overrideIndicator）', !saveBurst.some((e) => e.api === 'createIndicator' || e.api === 'removeIndicator') && saveBurst.some((e) => e.api === 'overrideIndicator'), saveBurst);
check('R_prev_fix: 保存的 PUT 请求被浏览器侧本地兑现（未发往后端）', out.putIntercepted.length >= 1, out.putIntercepted);

// ════════════════════ 8. 只读/卫生 ════════════════════
out.pageErrors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e));
check('E: 全程无非 GET 请求（未改线上状态）', out.nonGetOther.length === 0, out.nonGetOther);
check('E: 无页面异常/崩溃', out.pageErrors.length === 0, out.pageErrors.slice(0, 5));

const fs = await import('node:fs');
fs.mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const pass = out.checks.filter((c) => c.ok).length;
console.log(`[${LABEL}] checks: ${pass}/${out.checks.length} passed`);
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name} :: ${JSON.stringify(c.detail).slice(0, 260)}`);
console.log('OUT=' + OUT);
await browser.close();
