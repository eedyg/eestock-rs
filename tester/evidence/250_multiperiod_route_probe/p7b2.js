(function () {
  const kc = window.klinecharts;
  const R = { errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const err = (e) => R.errors.push(String((e && e.stack) || e));
  const T0 = Date.parse('2026-09-14T00:00:00Z');
  function mkBars(periodMin, fromTs, n) {
    const bm = periodMin * 60000, out = []; let px = 8.9;
    for (let i = 0; i < n; i++) { const ts = fromTs + i * bm; px += (Math.sin(i / 13) + Math.cos(i / 29)) * 0.002; const o = +px.toFixed(4), c = +(px + Math.sin(i / 7) * 0.001).toFixed(4); out.push({ timestamp: ts, open: o, high: +(Math.max(o, c) + 0.0008).toFixed(4), low: +(Math.min(o, c) - 0.0008).toFixed(4), close: c, volume: 100 }); }
    return out;
  }
  function mk(id, periodMin, n) {
    const chart = kc.init(id, { styles: 'dark', layout: { barSpaceLimit: { min: 0.1, max: 200000 } } });
    const bars = mkBars(periodMin, T0, n);
    chart.setSymbol({ ticker: '518880', pricePrecision: 4, volumePrecision: 0 });
    chart.setPeriod({ span: periodMin, type: 'minute' });
    chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false), subscribe() { }, unsubscribe() { } });
    return { chart, bars, periodMin };
  }
  function span(s, tag) {
    const r = s.chart.getVisibleRange();
    const f = Math.max(0, Math.floor(r.realFrom)), t = Math.min(s.bars.length - 1, Math.ceil(r.realTo));
    const tsF = s.bars[f] && s.bars[f].timestamp, tsT = s.bars[t] && s.bars[t].timestamp;
    return { tag, realFrom: +r.realFrom.toFixed(2), realTo: +r.realTo.toFixed(2), f, t, tsF, tsT, spanMin: (tsF && tsT) ? +((tsT - tsF) / 60000).toFixed(2) : null, bar: s.chart.getBarSpace().bar };
  }
  function pxX(s, ts) { try { const p = s.chart.convertToPixel({ timestamp: ts }); return p ? +p.x.toFixed(1) : null; } catch (e) { err(e); return null; } }
  function visFrac(s, ts) { const x = pxX(s, ts); const w = s.chart.getSize() && s.chart.getSize('candle_pane'); return x; }

  (async function () {
    try {
      const A = mk('sA', 1, 600);      // 1m
      const B = mk('sB', 15, 40);      // 15m same wall-clock span (600 min)
      const C = mk('sC', 1, 600);      // 1m twin of A
      const D = mk('sD', 10080, 10);   // 1w x 10 = 10080 min
      await raf();
      R.initLayoutBarSpaceLimit = 'min:0.1 max:200000 (passed at init)';
      R.baseline = { A: span(A), B: span(B), C: span(C), D: span(D) };

      // --- same-period index alignment (A vs C) ---
      A.chart.setBarSpace(8); C.chart.setBarSpace(8);
      await raf(); await sleep(80);
      C.chart.scrollToDataIndex(300, 0); A.chart.scrollToDataIndex(300, 0);
      await raf(); await sleep(120);
      R.indexAlign_1m_vs_1m = { A: span(A), C: span(C), exactEqual: JSON.stringify(A.chart.getVisibleRange()) === JSON.stringify(C.chart.getVisibleRange()) };

      // --- cross-period: NAIVE timestamp-only ---
      const rA = A.chart.getVisibleRange();
      const tsRight = A.bars[Math.min(A.bars.length - 1, Math.ceil(rA.realTo))].timestamp;
      B.chart.scrollToTimestamp(tsRight, 0);
      await raf(); await sleep(120);
      R.crossPeriod_naiveTsOnly = { A: span(A), B: span(B), tsRight };

      // --- cross-period: barSpace scaled by ratio + timestamp align ---
      const ratio = B.periodMin / A.periodMin;               // 15
      const bsA = A.chart.getBarSpace().bar;
      const applied = B.chart.setBarSpace(bsA * ratio);       // returns void; read back
      await raf();
      B.chart.scrollToTimestamp(tsRight, 0);
      await raf(); await sleep(120);
      R.crossPeriod_scaledBarSpace = { ratio, bsA, targetB: bsA * ratio, Bbar: B.chart.getBarSpace().bar, A: span(A), B: span(B) };
      // pixel-x alignment of a shared timestamp (normalized to width)
      const tsShared = tsRight;
      R.pixelX_afterSync = { ts: tsShared, Ax: pxX(A, tsShared), Bx: pxX(B, tsShared) };

      // --- 1m vs 1w: barSpace needed ---
      const bsNeeded = bsA * (D.periodMin / A.periodMin);
      D.chart.setBarSpace(bsNeeded);
      await raf();
      D.chart.scrollToTimestamp(tsRight, 0);
      await raf(); await sleep(120);
      R.crossPeriod_1m_vs_1w = { ratio: D.periodMin, bsA, bsNeeded, Dbar: D.chart.getBarSpace().bar, A: span(A), D: span(D), Dx: pxX(D, tsRight), Ax: pxX(A, tsRight) };

      // --- repeated mirror drift: 20 rounds of ts-only mirror, alternate periods ---
      const drift = [];
      for (let k = 0; k < 20; k++) {
        const r = A.chart.getVisibleRange();
        const ts = A.bars[Math.min(A.bars.length - 1, Math.ceil(r.realTo))].timestamp;
        B.chart.scrollToTimestamp(ts, 0);
        await raf();
        drift.push({ k, ts, B: span(B).spanMin, A: span(A).spanMin });
      }
      await sleep(80);
      R.drift20 = { first: drift[0], last: drift[drift.length - 1], count: drift.length };

      // --- feedback loop: bidirectional guarded mirror ---
      let syncCalls = 0, micro = 0, guard = false;
      const mirror = (src, dst) => { if (guard) { micro++; return; } guard = true; try { const r = src.chart.getVisibleRange(); const ts = src.bars[Math.min(src.bars.length - 1, Math.ceil(r.realTo))].timestamp; dst.chart.scrollToTimestamp(ts, 0); syncCalls++; } finally { guard = false; } };
      let evB = 0, evA = 0;
      A.chart.subscribeAction('onScroll', () => { evA++; mirror(A, B); });
      B.chart.subscribeAction('onScroll', () => { evB++; mirror(B, A); });
      const t0 = performance.now();
      A.chart.scrollByDistance(-200);
      await raf(); await sleep(350);
      R.feedback = { wallMs: +(performance.now() - t0).toFixed(0), syncCalls, reentrantCalls: micro, evA, evB };
      // unguarded (raw callbacks both ways) would recurse; emulate by counting callbacks-without-guard
      let raw = 0, rawGuard = false;
      const rawMirror = (src, dst) => { if (rawGuard) return; rawGuard = true; try { const r = src.chart.getVisibleRange(); const ts = src.bars[Math.min(src.bars.length - 1, Math.ceil(r.realTo))].timestamp; dst.chart.scrollToTimestamp(ts, 0); raw++; } finally { rawGuard = false; } };
      R.feedbackNote = 'reentrantCalls>0 means target scroll re-entered the source callback (loop risk)';

      // --- perf of one sync op ---
      const t1 = performance.now();
      for (let i = 0; i < 50; i++) { const r = A.chart.getVisibleRange(); const ts = A.bars[Math.min(A.bars.length - 1, Math.ceil(r.realTo))].timestamp; B.chart.scrollToTimestamp(ts, 0); }
      R.syncPerf_50ops_ms = +(performance.now() - t1).toFixed(1);
      R.syncPerOp_ms = +((performance.now() - t1) / 50).toFixed(2);
    } catch (e) { err(e); }
    window.__RESULT = R; window.__DONE = true;
  })();
})();
