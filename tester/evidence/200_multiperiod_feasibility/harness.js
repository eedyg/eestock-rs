/* v2: async-sequenced probes. Results on window.__RESULT. */
(function () {
  const kc = window.klinecharts;
  const P = { logs: [], calcCalls: [], errors: [] };
  const log = (k, v) => P.logs.push([k, v]);
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const NOW = Date.parse('2026-09-14T07:00:00Z');
  const N = 600, bars = [];
  let px = 8.9;
  for (let i = 0; i < N; i++) {
    const ts = NOW - (N - 1 - i) * 60000;
    px += (Math.sin(i / 11) + Math.cos(i / 23)) * 0.0015;
    const o = px, c = px + Math.sin(i / 7) * 0.001;
    bars.push({ timestamp: ts, open: +o.toFixed(4), high: +(Math.max(o, c) + 0.0008).toFixed(4), low: +(Math.min(o, c) - 0.0008).toFixed(4), close: +c.toFixed(4), volume: 1000 + (i % 37) * 100 });
  }
  function extSeries(stepMin, scale) {
    const ts = [], val = [], bm = stepMin * 60000;
    let s = Math.floor(bars[0].timestamp / bm) * bm;
    while (s + bm <= bars[N - 1].timestamp + 60000) { ts.push(s); val.push(+(Math.sin(s / 3000000) * 2 * scale + scale * 3).toFixed(4)); s += bm; }
    return { ts, values: val, stepMin };
  }
  const ext5 = extSeries(5, 1), ext15 = extSeries(15, 2);
  window.__ext5 = ext5; window.__ext15 = ext15;

  // figure-draw path needs paths computed with axis access: recompute inside attrs is not axis-aware,
  // so use indicator-level `draw` (has chart+axes) for the self-draw probe.
  function makeTemplate(name) {
    return {
      name, figures: [{ key: 'v', title: name + ': ', type: 'line' }], precision: 5,
      calc(dataList, indicator) {
        const ext = indicator.extendData || (indicator.__extRef);
        P.calcCalls.push({ name, extLen: ext && ext.values ? ext.values.length : null, dataLen: dataList.length, t: performance.now() | 0 });
        if (!ext || !ext.ts) return dataList.map(() => ({ v: null }));
        const m = new Map(); for (let i = 0; i < ext.ts.length; i++) m.set(ext.ts[i], ext.values[i]);
        return dataList.map((d) => ({ v: m.has(d.timestamp) ? m.get(d.timestamp) : null }));
      },
    };
  }
  kc.registerIndicator(makeTemplate('EXT_A'));   // extendData path (5m)
  kc.registerIndicator(makeTemplate('EXT_B'));   // extendData path (15m, own yAxisId)
  window.__REG = { 5: ext5, 15: ext15 };
  kc.registerIndicator({
    name: 'EXT_REG', figures: [{ key: 'v', title: 'vR: ', type: 'line' }], precision: 5,
    calc(dataList, indicator) {
      const per = Number(indicator.calcParams[0]); const ext = window.__REG[per];
      P.calcCalls.push({ name: 'EXT_REG', period: per, extLen: ext ? ext.values.length : null, dataLen: dataList.length, t: performance.now() | 0 });
      if (!ext) return dataList.map(() => ({ v: null }));
      const m = new Map(); for (let i = 0; i < ext.ts.length; i++) m.set(ext.ts[i], ext.values[i]);
      return dataList.map((d) => ({ v: m.has(d.timestamp) ? m.get(d.timestamp) : null }));
    },
  });
  let drawCalls = 0;
  kc.registerIndicator({
    name: 'EXT_DRAW', figures: [{ key: 'v', title: 'vD: ', type: 'line' }], precision: 5, minValue: 0, maxValue: 8,
    calc(dataList) { return dataList.map(() => ({ v: null })); },
    draw(params) {
      drawCalls++;
      const { ctx, chart, xAxis, yAxis, bounding } = params;
      const ext = window.__REG[5];
      ctx.save(); ctx.strokeStyle = '#ff00ff'; ctx.lineWidth = 2; ctx.beginPath();
      let started = false;
      for (let i = 0; i < ext.ts.length; i++) {
        const x = xAxis.convertTimestampToPixel(ext.ts[i]), y = yAxis.convertToPixel(ext.values[i]);
        if (x < bounding.left - 100 || x > bounding.right + 100) { started = false; continue; }
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.restore();
      P.drawLastCoords = { left: bounding.left, right: bounding.right, y0: yAxis.convertToPixel(0), y8: yAxis.convertToPixel(8) };
      return true;
    },
  });

  const chart = kc.init('chart', { styles: 'dark' });
  window.__CHART = chart;
  chart.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
  chart.setPeriod({ span: 1, type: 'minute' });
  chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false), subscribe: () => { }, unsubscribe: () => { } });

  const paneA = chart.createIndicator({ name: 'EXT_A', extendData: ext5 }, true);
  const paneB = chart.createIndicator({ name: 'EXT_B', extendData: ext15, yAxisId: 'yA_extB' }, true);
  const paneReg = chart.createIndicator({ name: 'EXT_REG', calcParams: [5] }, true);
  const paneDraw = chart.createIndicator({ name: 'EXT_DRAW' }, true);
  const paneVol = chart.createIndicator('VOL', true);
  const pidOf = (n) => (chart.getIndicators({ name: n })[0] || {}).paneId;
  const PIDA = pidOf('EXT_A'), PIDB = pidOf('EXT_B'), PIDR = pidOf('EXT_REG'), PIDD = pidOf('EXT_DRAW'), PIDV = pidOf('VOL');
  log('paneIds', { createIndicatorReturned: { paneA, paneB, paneReg, paneDraw, paneVol }, realPaneIds: { PIDA, PIDB, PIDR, PIDD, PIDV } });
  log('supportedFigures', kc.getSupportedFigures());
  log('supportedOverlays', kc.getSupportedOverlays());

  async function snapshot(tag) {
    const out = { tag, panes: [], indicators: [], yaxes: [], visibleRange: null, pixels: [], dom: {} };
    try { out.panes = chart.getPaneOptions().map((p) => ({ id: p.id.slice(0, 30), height: p.height, order: p.order, state: p.state, size: chart.getSize(p.id, 'root') })); } catch (e) { out.paneErr = String(e); }
    try { out.indicators = chart.getIndicators().map((i) => ({ name: i.name, paneId: i.paneId, yAxisId: i.yAxisId, calcParams: i.calcParams, precision: i.precision, resultLen: i.result ? i.result.length : null, firstNonNull: i.result ? (i.result.find((r) => r.v != null) || null) : null })); } catch (e) { out.indErr = String(e); }
    try { out.yaxes = chart.getYAxes({}).map((a) => { const r = a.getRange(); return { paneId: a.paneId, id: a.id, realRange: r.realRange, from: r.from, to: r.to }; }); } catch (e) { out.yaxErr = String(e); }
    try { out.visibleRange = chart.getVisibleRange(); } catch (e) { out.vrErr = String(e); }
    const t = bars[Math.floor(N / 2)].timestamp;
    for (const pid of [undefined, PIDA, PIDB, PIDR, PIDD, PIDV].filter(Boolean)) {
      try { const a = chart.convertToPixel({ timestamp: t, value: 3 }, { paneId: pid }); const sz = chart.getSize(pid, 'root'); out.pixels.push({ paneId: pid, xAtSameTs: a && a.x, yAtValue3: a && a.y, paneHeight: sz && sz.height, paneWidth: sz && sz.width }); } catch (e) { out.pixels.push({ paneId: pid, err: String(e) }); }
    }
    try { out.dom = { canvasCount: document.querySelectorAll('#chart canvas').length, PIDAroot: (() => { const el = chart.getDom(PIDA, 'root'); return el ? { tag: el.tagName, kids: Array.from(el.children).map((c) => c.tagName) } : null; })() }; } catch (e) { out.dom = { err: String(e) }; }
    return out;
  }

  function paneCanvas(paneId) {
    const el = chart.getDom(paneId, 'root');
    if (!el) return null;
    if (el.tagName === 'CANVAS') return el;
    return el.querySelector('canvas');
  }
  function countColoredPixels(paneId) {
    const cv = paneCanvas(paneId);
    if (!cv) return { err: 'no canvas', domTag: chart.getDom(paneId) && chart.getDom(paneId).tagName };
    const ctx = cv.getContext('2d'); const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; const colors = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && (d[i] > 30 || d[i + 1] > 30 || d[i + 2] > 30)) { n++; const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; colors.set(k, (colors.get(k) || 0) + 1); }
    }
    return { w: cv.width, h: cv.height, nonBgPixels: n, topColors: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) };
  }
  window.__count = countColoredPixels;

  (async () => {
    try {
      await sleep(500); await raf();
      log('S1.firstRender', await snapshot('S1'));
      // P1: pane height persistence
      const before = chart.getPaneOptions(PIDB);
      chart.setPaneOptions({ id: PIDB, height: 222 });
      await raf();
      const after = chart.getPaneOptions(PIDB);
      const afterAll = chart.getPaneOptions().map((p) => ({ id: p.id.slice(0, 26), height: p.height, order: p.order }));
      log('P1.setPaneHeight', { target: PIDB, before, after, afterAll, sizeAfter: chart.getSize(PIDB, 'root') });
      // zoom/scroll then re-check heights + x sync
      chart.setBarSpace(9); chart.zoomAtDataIndex(1.15, Math.floor(N / 2)); chart.scrollByDistance(120);
      await raf();
      log('S2.afterZoomScroll', await snapshot('S2'));
      log('P1.heightAfterZoomScroll', { opt: chart.getPaneOptions(PIDB), size: chart.getSize(PIDB, 'root'), allHeights: chart.getPaneOptions().map((p) => ({ id: p.id.slice(0, 26), h: p.height })) });
      // P2a: reactivity via overrideIndicator extendData
      const callsBefore = P.calcCalls.filter((c) => c.name === 'EXT_A').length;
      const ret = chart.overrideIndicator({ name: 'EXT_A', extendData: { ts: ext5.ts, values: ext5.values.map((v) => v + 10) } });
      await raf();
      const callsAfter = P.calcCalls.filter((c) => c.name === 'EXT_A').length;
      const aInd = chart.getIndicators({ name: 'EXT_A' })[0];
      log('P2a.overrideExtendData', { ret, calcCallsBefore: callsBefore, calcCallsAfter: callsAfter, recalced: callsAfter > callsBefore, resultLen: aInd.result.length, firstNonNull: aInd.result.find((r) => r.v != null) });
      // P2b: registry mutation reactivity
      const regBefore = JSON.stringify(chart.getIndicators({ name: 'EXT_REG' })[0].result.find((r) => r.v != null));
      window.__REG[5] = { ts: ext5.ts, values: ext5.values.map((v) => v + 100) };
      const retSame = chart.overrideIndicator({ name: 'EXT_REG', calcParams: [5] });
      await raf();
      const regAfterSame = JSON.stringify(chart.getIndicators({ name: 'EXT_REG' })[0].result.find((r) => r.v != null));
      chart.resetData();
      await sleep(300); await raf();
      const regAfterReset = JSON.stringify(chart.getIndicators({ name: 'EXT_REG' })[0].result.find((r) => r.v != null));
      log('P2b.registryReactivity', { regBefore, retSame, regAfterSame, regAfterReset, recalcWithoutReset: regBefore !== regAfterSame, recalcAfterReset: regAfterSame !== regAfterReset });
      // P2c: self-draw
      await raf();
      log('P2c.indicatorDraw', { drawCalls, drawLastCoords: P.drawLastCoords, paneDrawPixels: countColoredPixels(paneDraw) });
      // P2d: overlay
      const ovPoly = chart.createOverlay({ name: 'polyline', points: ext5.ts.map((t) => ({ timestamp: t, value: 3 })) });
      const ovBrush = chart.createOverlay({ name: 'brush', points: ext5.ts.map((t) => ({ timestamp: t, value: 3 })), styles: { line: { style: 'dashed', dashedValue: [4, 4], color: '#00ff00', size: 2 } } });
      const ovSeg = chart.createOverlay({ name: 'segment', points: [{ timestamp: ext5.ts[0], value: 3 }, { timestamp: ext5.ts[1], value: 3 }], styles: { line: { style: 'dashed', dashedValue: [4, 4] } } });
      await raf();
      log('P2d.overlay', { polyline: !!ovPoly, brush: !!ovBrush, segment: !!ovSeg, overlays: chart.getOverlays().length, overlayNames: chart.getOverlays().map((o) => o.name) });
      // P1 x-sync assertion data
      log('P2a.pixelCheck EXT_A', countColoredPixels(paneA));
      log('P2b.pixelCheck EXT_REG', countColoredPixels(paneReg));
      log('P2a2.pixelCheck EXT_B', countColoredPixels(paneB));
      try { window.__PIC = chart.getConvertPictureUrl(false, 'png'); } catch (e) { P.errors.push(['getConvertPictureUrl', String(e)]); window.__PIC = null; }
      window.__RESULT = { logs: P.logs, calcCalls: P.calcCalls, errors: P.errors, picLen: window.__PIC ? window.__PIC.length : 0 };
    } catch (e) { P.errors.push(['outer', String(e) + '\n' + e.stack]); window.__RESULT = { logs: P.logs, calcCalls: P.calcCalls, errors: P.errors, picLen: 0 }; }
    window.__DONE = true;
  })();
})();
