/* P7 route probe: P7a hidden candle pane / P7b cross-instance sync / P7c cost+free / P7d contract
   read-only, file:// page, real klinecharts 10.0.3 UMD, Playwright Chromium. */
(function () {
  const kc = window.klinecharts;
  const R = { version: null, p7a: {}, p7b: {}, p7c: {}, p7d: {}, source: {}, errors: [] };
  try { R.version = kc.version(); } catch (e) { R.errors.push('version:' + e.message); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const err = (e) => R.errors.push(String((e && e.stack) || e));

  const T0 = Date.parse('2026-09-14T00:00:00Z');
  function mkBars(periodMin, fromTs, n) {
    const bm = periodMin * 60000, out = [];
    let px = 8.9;
    for (let i = 0; i < n; i++) {
      const ts = fromTs + i * bm;
      px += (Math.sin(i / 13) + Math.cos(i / 29)) * 0.002;
      const o = +px.toFixed(4), c = +(px + Math.sin(i / 7) * 0.001).toFixed(4);
      out.push({ timestamp: ts, open: o, high: +(Math.max(o, c) + 0.0008).toFixed(4), low: +(Math.min(o, c) - 0.0008).toFixed(4), close: c, volume: 1000 + (i % 37) * 100 });
    }
    return out;
  }
  function extSeries(bars, stepMin, scale) {
    const ts = [], values = [], bm = stepMin * 60000;
    let s = Math.floor(bars[0].timestamp / bm) * bm;
    while (s + bm <= bars[bars.length - 1].timestamp + 60000) { ts.push(s); values.push(+(Math.sin(s / 3000000) * scale + scale * 3).toFixed(4)); s += bm; }
    return { ts, values, stepMin };
  }
  // ---- a single external-series-reading template, registered ONCE globally (route-2 "DCAP zero change") ----
  const calcLog = [];
  kc.registerIndicator({
    name: 'P7EXT', figures: [{ key: 'v', title: 'P7EXT: ', type: 'line' }], precision: 5, minValue: 0,
    calc(dataList, indicator) {
      const ext = indicator.extendData;
      calcLog.push({ len: ext && ext.ts ? ext.ts.length : null, dataLen: dataList.length });
      if (!ext || !ext.ts) return dataList.map(() => ({ v: null }));
      const m = new Map(); for (let i = 0; i < ext.ts.length; i++) m.set(ext.ts[i], ext.values[i]);
      return dataList.map((d) => ({ v: m.has(d.timestamp) ? m.get(d.timestamp) : null }));
    },
  });
  R.source.supportedBuiltins = kc.getSupportedIndicators();

  function paneSummary(chart) {
    try {
      return chart.getPaneOptions().map((p) => ({ id: p.id, h: p.height, minH: p.minHeight, state: p.state, order: p.order }));
    } catch (e) { err(e); return null; }
  }
  function sizeOf(chart, id) { try { return chart.getSize(id); } catch (e) { err(e); return null; } }
  function rectOf(chart, id) {
    try { const el = chart.getDom(id); if (!el) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2), left: +r.left.toFixed(2), width: +r.width.toFixed(2) }; } catch (e) { err(e); return null; }
  }
  function rectGap(topRect, bottomRect, paneTop, paneBottom) { return (topRect && bottomRect) ? +(bottomRect.top - topRect.bottom).toFixed(2) : null; }
  function gapBetween(topSize, bottomSize) { return (topSize && bottomSize) ? +(bottomSize.top - topSize.bottom).toFixed(2) : null; }

  // ============================== P7a ==============================
  async function p7a() {
    const A = {};
    const chart = kc.init('c1', { styles: 'dark' });
    A.chartInitOk = !!chart;
    chart.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
    chart.setPeriod({ span: 1, type: 'minute' });
    const bars = mkBars(1, T0, 400);
    chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false), subscribe() { }, unsubscribe() { } });
    await raf();
    A.panesBaseline = paneSummary(chart);
    A.sizeCandleBaseline = sizeOf(chart, 'candle_pane');

    const indId = chart.createIndicator({ name: 'P7EXT', calcParams: [], extendData: extSeries(bars, 5, 1) }, true);
    await raf();
    A.createIndicatorReturn = indId;
    A.getIndicators = chart.getIndicators().map((i) => ({ name: i.name, paneId: i.paneId, yAxisId: i.yAxisId, visible: i.visible }));
    // createIndicator returns indicator id, NOT pane id -> resolve pane id from getIndicators
    A.getDomOfIndicatorReturn = !!chart.getDom(indId);           // expect false
    const indPaneId = (chart.getIndicators()[0] || {}).paneId;
    A.indPaneId = indPaneId;
    A.panesAfterIndicator = paneSummary(chart);
    A.sizeIndBaseline = sizeOf(chart, indPaneId);

    // ---- attempt 1: setPaneOptions({id:'candle_pane', height:0}) ----
    chart.setPaneOptions({ id: 'candle_pane', height: 0 });
    await raf();
    A.attempt_height0 = {
      paneOpt: (chart.getPaneOptions('candle_pane') || null),
      sizeCandle: sizeOf(chart, 'candle_pane'),
      sizeInd: sizeOf(chart, indPaneId),
      rectCandle: rectOf(chart, 'candle_pane'),
      rectInd: rectOf(chart, indPaneId),
      domGapPx: rectGap(rectOf(chart, 'candle_pane'), rectOf(chart, indPaneId)),
      gapPx_liveRefBogus: gapBetween(sizeOf(chart, 'candle_pane'), sizeOf(chart, indPaneId)),
    };

    // ---- attempt 2: state:'minimize' + minHeight 0 ----
    chart.setPaneOptions({ id: 'candle_pane', state: 'minimize', minHeight: 0, height: 0 });
    await raf();
    A.attempt_minimize = {
      paneOpt: (chart.getPaneOptions('candle_pane') || null),
      sizeCandle: sizeOf(chart, 'candle_pane'),
      sizeInd: sizeOf(chart, indPaneId),
      rectCandle: rectOf(chart, 'candle_pane'),
      rectInd: rectOf(chart, indPaneId),
      domGapPx: rectGap(rectOf(chart, 'candle_pane'), rectOf(chart, indPaneId)),
      panes: paneSummary(chart),
    };

    // ---- attempt 3: separator size -> 0 ----
    chart.setStyles({ separator: { size: 0 } });
    await raf();
    A.attempt_minimize_sep0 = {
      sizeCandle: sizeOf(chart, 'candle_pane'),
      sizeInd: sizeOf(chart, indPaneId),
      rectCandle: rectOf(chart, 'candle_pane'),
      rectInd: rectOf(chart, indPaneId),
      domGapPx: rectGap(rectOf(chart, 'candle_pane'), rectOf(chart, indPaneId)),
    };

    // ---- x axis shared across panes: same ts -> same pixel? ----
    const ts0 = bars[200].timestamp;
    A.xSharedPixels = {
      candle: chart.convertToPixel({ timestamp: ts0 }, { paneId: 'candle_pane' }),
      ind: chart.convertToPixel({ timestamp: ts0 }, { paneId: indPaneId }),
    };

    // ---- y axis independent: same value -> different pixel in the two panes ----
    A.yIndependentPixels = {
      candle_px_for_9: chart.convertToPixel({ value: 9 }, { paneId: 'candle_pane' }),
      ind_px_for_9: chart.convertToPixel({ value: 9 }, { paneId: indPaneId }),
    };
    A.yAxes = chart.getYAxes({ paneId: indPaneId }).map((a) => ({ id: a.id, range: a.getRange && a.getRange() }));

    // ---- residual gap after zoom / scroll ----
    chart.zoomAtCoordinate(1.6);
    chart.scrollByDistance(-180);
    await raf(); await sleep(150);
    A.afterZoomScroll = {
      sizeCandle: sizeOf(chart, 'candle_pane'),
      sizeInd: sizeOf(chart, indPaneId),
      rectCandle: rectOf(chart, 'candle_pane'),
      rectInd: rectOf(chart, indPaneId),
      domGapPx: rectGap(rectOf(chart, 'candle_pane'), rectOf(chart, indPaneId)),
      panes: paneSummary(chart),
      visible: chart.getVisibleRange(),
    };
    // ---- restore candle pane to normal to test un-hide ----
    chart.setPaneOptions({ id: 'candle_pane', state: 'normal', minHeight: 30 });
    await raf();
    A.restoreNormal = { sizeCandle: sizeOf(chart, 'candle_pane'), sizeInd: sizeOf(chart, indPaneId), rectCandle: rectOf(chart, 'candle_pane'), rectInd: rectOf(chart, indPaneId), panes: paneSummary(chart) };
    return A;
  }

  // ============================== P7b ==============================
  async function p7b() {
    const B = {};
    const chartA = kc.init('cA', { styles: 'dark' });
    const chartB = kc.init('cB', { styles: 'dark' });
    const barsA = mkBars(1, T0, 600);   // 1m x 600 = 600 min
    const barsB = mkBars(15, T0, 40);   // 15m x 40 = 600 min
    for (const [c, bars] of [[chartA, barsA], [chartB, barsB]]) {
      c.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
      c.setPeriod({ span: 1, type: 'minute' });
      c.setDataLoader({ getBars: ({ callback }) => callback(bars, false), subscribe() { }, unsubscribe() { } });
    }
    await raf();
    B.api = {
      getVisibleRange: typeof chartA.getVisibleRange,
      setVisibleRange: typeof chartA.setVisibleRange,
      scrollToTimestamp: typeof chartA.scrollToTimestamp,
      scrollToDataIndex: typeof chartA.scrollToDataIndex,
      zoomAtTimestamp: typeof chartA.zoomAtTimestamp,
      zoomAtDataIndex: typeof chartA.zoomAtDataIndex,
      setBarSpace: typeof chartA.setBarSpace,
      getBarSpace: typeof chartA.getBarSpace,
      setOffsetRightDistance: typeof chartA.setOffsetRightDistance,
      subscribeAction: typeof chartA.subscribeAction,
      onVisibleRangeChangeSupported: 'onVisibleRangeChange',
      getSize: typeof chartA.getSize,
    };
    // events on A
    const evA = [], evRangeA = [];
    chartA.subscribeAction('onScroll', (d) => evA.push(['onScroll', d && d.distance]));
    chartA.subscribeAction('onZoom', (d) => evA.push(['onZoom', d && d.scale]));
    chartA.subscribeAction('onVisibleRangeChange', (d) => evRangeA.push([d && d.from, d && d.to, d && d.realFrom, d && d.realTo]));
    chartA.scrollByDistance(-120);
    chartA.zoomAtCoordinate(1.4);
    await raf(); await sleep(200);
    B.eventsA = evA.slice(0, 30);
    B.rangeEventA = evRangeA.slice(-3);

    function visSpan(chart, bars) {
      const r = chart.getVisibleRange();
      const from = Math.max(0, Math.floor(r.realFrom)), to = Math.min(bars.length - 1, Math.ceil(r.realTo));
      return { realFrom: +r.realFrom.toFixed(3), realTo: +r.realTo.toFixed(3), from, to, tsFrom: bars[from] && bars[from].timestamp, tsTo: bars[to] && bars[to].timestamp, spanMin: (bars[to] && bars[from]) ? +(((bars[to].timestamp - bars[from].timestamp) / 60000)).toFixed(2) : null };
    }
    B.spanBefore = { A: visSpan(chartA, barsA), B: visSpan(chartB, barsB), barSpaceA: chartA.getBarSpace(), barSpaceB: chartB.getBarSpace(), width_A: chartA.getSize() && chartA.getSize().width, width_B: chartB.getSize() && chartB.getSize().width };

    // ---- cross-period mirror: timestamp-align right edge + scale barSpace by period ratio ----
    const rA = chartA.getVisibleRange();
    const tsRight = barsA[Math.min(barsA.length - 1, Math.ceil(rA.realTo))].timestamp;
    const tsLeft = barsA[Math.max(0, Math.floor(rA.realFrom))].timestamp;
    const bsA = chartA.getBarSpace().barSpace;
    const t0 = performance.now();
    chartB.setBarSpace(bsA * 15);
    chartB.scrollToTimestamp(tsRight, 0);
    await raf(); await sleep(200);
    B.mirrorMs = +(performance.now() - t0).toFixed(1);
    B.spanAfterCrossPeriod = { A: visSpan(chartA, barsA), B: visSpan(chartB, barsB), barSpaceA: chartA.getBarSpace(), barSpaceB: chartB.getBarSpace() };

    // ---- naive mirror WITHOUT barSpace scaling (only scrollToTimestamp) ----
    const chartC = kc.init('cC1', { styles: 'dark' });
    chartC.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
    chartC.setPeriod({ span: 1, type: 'minute' });
    chartC.setDataLoader({ getBars: ({ callback }) => callback(barsB, false), subscribe() { }, unsubscribe() { } });
    await raf();
    chartC.scrollToTimestamp(tsRight, 0);
    await raf(); await sleep(120);
    B.naiveTimestampOnly = { B: visSpan(chartB, barsB), C: visSpan(chartC, barsB) };

    // ---- feedback-loop test: bidirectional mirror, guarded only by a reentrancy flag ----
    let syncCalls = 0, mirroring = false;
    const sync = (src, dst, srcBars) => {
      if (mirroring) return;
      mirroring = true;
      try {
        const r = src.getVisibleRange();
        const to = Math.min(srcBars.length - 1, Math.ceil(r.realTo));
        dst.scrollToTimestamp(srcBars[to].timestamp, 0);
        syncCalls++;
      } finally { mirroring = false; }
    };
    const evB2 = [];
    chartB.subscribeAction('onScroll', function () { evB2.push('B'); sync(chartB, chartA, barsB); });
    chartA.subscribeAction('onScroll', function () { evA.push(['A-sync']); sync(chartA, chartB, barsA); });
    const before = { syncCalls, evA: evA.length, evB: evB2.length };
    chartA.scrollByDistance(-150);
    await sleep(400);
    B.feedback = { before, after: { syncCalls, evA: evA.length, evB: evB2.length }, rangeA: chartA.getVisibleRange(), rangeB: chartB.getVisibleRange() };

    // ---- index-align on two SAME-period instances (exactness check) ----
    const chartD = kc.init('cC2', { styles: 'dark' });
    const barsD = mkBars(1, T0, 600);
    chartD.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
    chartD.setPeriod({ span: 1, type: 'minute' });
    chartD.setDataLoader({ getBars: ({ callback }) => callback(barsD, false), subscribe() { }, unsubscribe() { } });
    await raf();
    chartA.setBarSpace(8); chartD.setBarSpace(8); chartD.setDataLoader({ getBars: ({ callback }) => callback(barsD, false), subscribe() { }, unsubscribe() { } });
    await raf();
    chartD.scrollToDataIndex(300, 0);
    chartA.scrollToDataIndex(300, 0);
    await raf(); await sleep(120);
    B.indexAlignSamePeriod = { A: visSpan(chartA, barsA), D: visSpan(chartD, barsD), barSpaceA: chartA.getBarSpace(), barSpaceD: chartD.getBarSpace() };
    // exact same visible range?
    B.indexAlignExact = { A: chartA.getVisibleRange(), D: chartD.getVisibleRange() };
    return B;
  }

  // ============================== P7c ==============================
  async function p7c() {
    const C = {};
    const ids = ['cC1', 'cC2', 'cC3', 'cC4'];
    const periods = [1, 5, 15, 30];
    // cC1/cC2 were used by p7b -> dispose them first
    try { kc.dispose('cC1'); } catch (e) { err(e); }
    try { kc.dispose('cC2'); } catch (e) { err(e); }
    await raf();
    const charts = [], barsets = [], createLog = [];
    const heap0 = (performance.memory && performance.memory.usedJSHeapSize) || null;
    const t0 = performance.now();
    for (let k = 0; k < 4; k++) {
      const chart = kc.init(ids[k], { styles: 'dark' });
      const bars = mkBars(periods[k], T0, 400);
      chart.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
      chart.setPeriod({ span: periods[k], type: 'minute' });
      chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false), subscribe() { }, unsubscribe() { } });
      charts.push(chart); barsets.push(bars);
      await raf();
      // ---- BUILT-IN indicators, ZERO front-end registration ----
      const r1 = chart.createIndicator({ name: 'MA', calcParams: [5, 10, 30], paneId: 'candle_pane' });
      const r2 = chart.createIndicator({ name: 'MACD', calcParams: [12, 26, 9] }, true);
      const r3 = chart.createIndicator({ name: 'KDJ', calcParams: [9, 3, 3] }, true);
      const r4 = chart.createIndicator({ name: 'BOLL', calcParams: [20, 2], paneId: 'candle_pane' });
      // ---- our own DCAP-style template, ZERO modification, one create per instance ----
      const r5 = chart.createIndicator({ name: 'P7EXT', calcParams: [], extendData: extSeries(bars, periods[k], 1 + k) }, true);
      createLog.push({ k, period: periods[k], returns: { MA: r1, MACD: r2, KDJ: r3, BOLL: r4, P7EXT: r5 } });
    }
    await raf();
    C.createMs_total = +(performance.now() - t0).toFixed(1);
    C.perInstance = charts.map((c, k) => ({
      period: periods[k],
      indicatorCount: c.getIndicators().length,
      indicators: c.getIndicators().map((i) => ({ name: i.name, paneId: i.paneId, yAxisId: i.yAxisId })),
      paneCount: c.getPaneOptions().length,
      hasCandleData: c.getDataList().length,
    }));
    C.createLog = createLog;
    C.calcCallsPerInstance = calcLog.slice(-8);
    // measure a data update across all 4 instances (proxy for realtime cost)
    const t1 = performance.now();
    for (let k = 0; k < 4; k++) {
      const nb = barsets[k].slice(0, -1).concat([{ ...barsets[k][barsets[k].length - 1], close: barsets[k][barsets[k].length - 1].close + 0.001 }]);
      charts[k].resetData();
      charts[k].setDataLoader({ getBars: ({ callback }) => callback(nb, false), subscribe() { }, unsubscribe() { } });
    }
    await raf(); await sleep(200);
    C.resetAndReloadMs_4instances = +(performance.now() - t1).toFixed(1);
    C.heap = heap0 && performance.memory ? { before: heap0, after: performance.memory.usedJSHeapSize, delta: performance.memory.usedJSHeapSize - heap0 } : null;
    // P7d: pane heights memory per instance (setPaneOptions per instance)
    C.paneHeightMemory = charts.map((c) => {
      const inds = c.getIndicators().filter((i) => i.paneId && i.paneId.indexOf('indicator_pane') === 0);
      const id = inds.length ? inds[0].paneId : null;
      if (id) c.setPaneOptions({ id, height: 120 });
      return { id, applied: id ? (c.getPaneOptions(id) || {}).height : null, size: id ? c.getSize(id) : null };
    });
    return C;
  }

  // ============================== P7d ==============================
  async function p7d() {
    const D = {};
    try { kc.dispose('cC3'); } catch (e) { err(e); }
    await raf();
    // route-1 multi-pane separators: one chart, 3 indicator panes -> count strips between panes
    const chart = kc.init('c1b', { styles: 'dark' });
    chart.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
    chart.setPeriod({ span: 1, type: 'minute' });
    const bars = mkBars(1, T0, 400);
    chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false), subscribe() { }, unsubscribe() { } });
    await raf();
    chart.createIndicator({ name: 'P7EXT', calcParams: [], extendData: extSeries(bars, 1, 1) }, true);
    chart.createIndicator({ name: 'P7EXT', calcParams: [], extendData: extSeries(bars, 5, 2) }, true);
    chart.createIndicator({ name: 'P7EXT', calcParams: [], extendData: extSeries(bars, 15, 3) }, true);
    await raf();
    const panes = chart.getPaneOptions().map((p) => ({ id: p.id, h: p.height, state: p.state, order: p.order }));
    const sizes = panes.map((p) => ({ id: p.id, s: chart.getSize(p.id), r: rectOf(chart, p.id) }));
    const strips = [];
    for (let i = 1; i < sizes.length; i++) strips.push(+(sizes[i].r.top - sizes[i - 1].r.bottom).toFixed(2));
    D.route1_singleChart_3indPanes = { panes, sizes: sizes.map((x) => ({ id: x.id, rect: x.r })), separatorStrips: strips };
    // pane height memory: set height, force re-layout, read back
    const p2 = panes[2].id;
    chart.setPaneOptions({ id: p2, height: 123 });
    chart.resize();
    await raf(); await sleep(80);
    D.paneHeightPersist = { id: p2, afterSet_andResize: { opt: (chart.getPaneOptions(p2) || {}).height, size: (chart.getSize(p2) || {}).height } };
    // route-2 residual: hide candle in one instance and count leftover strip
    const c2 = kc.init('cC3', { styles: 'dark' });
    c2.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
    c2.setPeriod({ span: 15, type: 'minute' });
    c2.setDataLoader({ getBars: ({ callback }) => callback(bars, false), subscribe() { }, unsubscribe() { } });
    await raf();
    const indId2 = c2.createIndicator({ name: 'P7EXT', calcParams: [], extendData: extSeries(bars, 15, 1) }, true);
    await raf();
    const indPane2 = (c2.getIndicators()[0] || {}).paneId;
    c2.setPaneOptions({ id: 'candle_pane', state: 'minimize', minHeight: 0 });
    await raf();
    D.route2_hiddenCandleStrip = {
      candleRect: rectOf(c2, 'candle_pane'), indRect: rectOf(c2, indPane2),
      domGapPx: rectGap(rectOf(c2, 'candle_pane'), rectOf(c2, indPane2)),
      panes: c2.getPaneOptions().map((p) => ({ id: p.id, h: p.height, state: p.state })),
      getDomIndicatorReturnIsNull: c2.getDom(indId2) === null,
    };
    return D;
  }

  // ============================== driver ==============================
  (async function () {
    try { R.p7a = await p7a(); } catch (e) { err(e); }
    try { R.p7b = await p7b(); } catch (e) { err(e); }
    try { R.p7c = await p7c(); } catch (e) { err(e); }
    try { R.p7d = await p7d(); } catch (e) { err(e); }
    window.__RESULT = R;
    window.__DONE = true;
  })();
})();
