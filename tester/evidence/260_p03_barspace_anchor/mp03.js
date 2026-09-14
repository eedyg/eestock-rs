// P0.3 barSpace anchor probe — real klinecharts 10.0.3, real backend bars (read-only GET /api/kline)
// Findings baked in:
//  * klinecharts 10.0.3 has NO applyNewData: data comes from DataLoader.getBars(type:'init')
//  * chart.setPeriod expects {type,span} (bare string silently never loads)
//  * getVisibleRange() returns DATA-INDEX space {from,to,realFrom,realTo} (index.esm.js:13556-13567),
//    so a time span must be reconstructed index->timestamp (gaps: 1d/1w series skip non-trading days).
(function () {
  const KC = window.klinecharts;
  const MIN = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440, '1w': 10080 };
  const PERIOD = { '1m': { type: 'minute', span: 1 }, '5m': { type: 'minute', span: 5 }, '15m': { type: 'minute', span: 15 },
                   '1h': { type: 'hour', span: 1 }, '1d': { type: 'day', span: 1 }, '1w': { type: 'week', span: 1 } };
  const CODE = '518880';
  const cache = {};
  const state = {};

  const log = (s) => { document.getElementById('log').textContent += s + '\n'; };
  const frames = (n) => new Promise(res => { let i = 0; const step = () => { if (++i >= (n || 3)) res(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });

  async function bars(period) {
    if (cache[period]) return cache[period];
    const r = await fetch(`/api/kline?code=${CODE}&period=${period}&limit=1000`);
    if (!r.ok) throw new Error('kline HTTP ' + r.status + ' period=' + period);
    const j = await r.json();
    const out = j.bars.map(b => ({ timestamp: Date.parse(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    out.meta = { n: out.length, first: out[0] && out[0].timestamp, last: out[out.length - 1] && out[out.length - 1].timestamp, period: j.period, code: j.code };
    cache[period] = out;
    return out;
  }
  function medianBucket(list) { const d = []; for (let i = 1; i < list.length; i++) d.push(list[i].timestamp - list[i - 1].timestamp); d.sort((a, b) => a - b); return d[Math.floor(d.length / 2)]; }
  function nBarsWithin(list, from, to) { let c = 0; for (const d of list) if (d.timestamp >= from && d.timestamp <= to) c++; return c; }
  // index -> timestamp (fractional index allowed; index space is uniform regardless of calendar gaps)
  function tsAt(list, idx) {
    const n = list.length; const fb = n > 1 ? (list[n - 1].timestamp - list[n - 2].timestamp) : 0;
    if (idx <= 0) return list[0].timestamp + idx * fb;
    if (idx >= n - 1) return list[n - 1].timestamp + (idx - (n - 1)) * fb;
    const i = Math.floor(idx), f = idx - i;
    return list[i].timestamp + f * (list[i + 1].timestamp - list[i].timestamp);
  }
  async function initCharts(basePeriod, satPeriod, satMax, opts) {
    opts = opts || {};
    const baseMax = opts.baseMax == null ? 50 : opts.baseMax;
    if (state.base) { KC.dispose(state.base); KC.dispose(state.sat); state.base = state.sat = null; }
    state.basePeriod = basePeriod; state.satPeriod = satPeriod; state.satMax = satMax;
    // fresh DOM node per init: re-init on a disposed node eventually yields NaN visible ranges (probe-harness artifact)
    const fresh = (id) => { const old = document.getElementById(id); const nw = document.createElement('div'); nw.id = id; nw.className = 'box'; old.parentNode.replaceChild(nw, old); return nw; };
    fresh('cBase'); fresh('cSat');
    state.base = KC.init('cBase', { layout: { barSpaceLimit: { min: 1, max: baseMax } } });
    state.sat = KC.init('cSat', { layout: { barSpaceLimit: { min: 1, max: satMax } } });
    state.baseList = await bars(basePeriod);
    state.satList = await bars(satPeriod);
    const wire = (chart, list, period) => {
      chart.setSymbol({ ticker: CODE, pricePrecision: 3, volumePrecision: 0 });
      chart.setPeriod(PERIOD[period]);
      chart.setDataLoader({ getBars: ({ type, callback }) => { if (type === 'init') callback(list.map(x => ({ ...x })), false); else callback([], false); } });
    };
    wire(state.base, state.baseList, basePeriod);
    wire(state.sat, state.satList, satPeriod);
    if (opts.satCandleMinimized) {
      state.sat.setPaneOptions({ id: 'candle_pane', state: 'minimize', minHeight: 0 });
      state.sat.setStyles({ separator: { size: 0 } });
    }
    await frames(4);
    document.getElementById('lblBase').textContent = `base ${basePeriod} bs=${state.base.getBarSpace().bar} bars=${state.base.getDataList().length}`;
    document.getElementById('lblSat').textContent = `sat ${satPeriod} bs=${state.sat.getBarSpace().bar} bars=${state.sat.getDataList().length} max=${satMax}` + (opts.satCandleMinimized ? ' candle=minimize' : '');
    return { baseSize: state.base.getSize(), satSize: state.sat.getSize(), baseBars: state.base.getDataList().length, satBars: state.sat.getDataList().length,
             baseBucketMs: medianBucket(state.baseList), satBucketMs: medianBucket(state.satList), baseMax, satMax };
  }
  function read(chart, list, max) {
    const r = chart.getVisibleRange();
    const bs = chart.getBarSpace().bar;
    if (!isFinite(r.realFrom) || !isFinite(r.realTo)) {
      return { idxFrom: r.realFrom, idxTo: r.realTo, idxSpan: NaN, tsFrom: NaN, tsTo: NaN, spanMin: NaN, centerTs: NaN,
               barSpace: bs, clampedAtMax: false, widthPx: chart.getSize().width, invalidRange: true };
    }
    const tFrom = tsAt(list, r.realFrom), tTo = tsAt(list, r.realTo);
    return { idxFrom: r.realFrom, idxTo: r.realTo, idxSpan: r.realTo - r.realFrom, tsFrom: tFrom, tsTo: tTo,
             spanMin: (tTo - tFrom) / 60000, centerTs: Math.round((tFrom + tTo) / 2),
             barSpace: bs, clampedAtMax: Math.abs(bs - max) < 1e-9, widthPx: chart.getSize().width,
             satDataExhausted: tTo > list[list.length - 1].timestamp, lastDataTs: list[list.length - 1].timestamp };
  }
  // One sync round: base.setBarSpace(baseBs) -> satellite barSpace (explicit or multiplier) -> scroll to base center
  async function syncRound(baseBs, satBsOrMul, opts) {
    opts = opts || {};
    const bp = state.basePeriod, sp = state.satPeriod;
    const nominalRatio = MIN[sp] / MIN[bp];
    state.base.setBarSpace(baseBs); await frames(2);
    const base = read(state.base, state.baseList, opts.baseMax == null ? 50 : opts.baseMax);
    base.offsetRight = state.base.getOffsetRightDistance(); base.dataExhausted = base.idxTo >= state.base.getDataList().length;
    // empirical density multiplier over the base window: bars-per-ms(base) / bars-per-ms(sat)
    const nB = nBarsWithin(state.baseList, base.tsFrom, base.tsTo), nS = nBarsWithin(state.satList, base.tsFrom, base.tsTo);
    const densityMul = nS > 0 ? nB / nS : Infinity;
    let satBs;
    if (satBsOrMul == null) satBs = base.barSpace * nominalRatio;            // spec §3.2 formula
    else if (satBsOrMul.mul != null) satBs = base.barSpace * satBsOrMul.mul;
    else satBs = satBsOrMul.abs;
    if (opts.rounding === 'int') satBs = Math.round(satBs);
    if (opts.rounding === 'floor') satBs = Math.floor(satBs);
    if (opts.mirrorOffset) state.sat.setOffsetRightDistance(state.base.getOffsetRightDistance());
    state.sat.setBarSpace(satBs);
    state.sat.scrollToTimestamp(base.centerTs);
    if (opts.mirrorOffset) state.sat.setOffsetRightDistance(state.base.getOffsetRightDistance());
    await frames(3);
    const sat = read(state.sat, state.satList, state.satMax);
    sat.offsetRight = state.sat.getOffsetRightDistance();
    const satBarMin = MIN[sp];
    return { basePeriod: bp, satPeriod: sp, nominalRatio,
      baseBsRequested: baseBs, base: base, sat: sat,
      densityMul: densityMul, nBWin: nB, nSWin: nS,
      satBsRequested: satBs, satBsTargetNominal: base.barSpace * nominalRatio, satBsTargetDensity: base.barSpace * densityMul,
      errMin: sat.spanMin - base.spanMin,
      errInSatBars: (sat.spanMin - base.spanMin) / satBarMin,
      errInBaseBars: (sat.spanMin - base.spanMin) / MIN[bp],
      leftEdgeErrMin: (sat.tsFrom - base.tsFrom) / 60000, rightEdgeErrMin: (sat.tsTo - base.tsTo) / 60000,
      centerErrMin: (sat.centerTs - base.centerTs) / 60000,
      satClamped: Math.abs(sat.barSpace - satBs) > 1e-9, satBarMin, satBarsVisible: nS,
      mirrorOffset: !!opts.mirrorOffset, satOffsetRight: state.sat.getOffsetRightDistance() };
  }
  window.__init = initCharts;
  window.__sync = syncRound;
  window.__read = () => ({ base: read(state.base, state.baseList, 50), sat: read(state.sat, state.satList, state.satMax) });
  window.__bars = bars;

  // A: default barSpaceLimit silently swallows large multiplications (satellite + base isolation)
  async function limitClamp() {
    await initCharts('1d', '1w', 50);
    state.sat.setBarSpace(350); await frames(2);
    const a = state.sat.getBarSpace().bar;
    await initCharts('1d', '1w', 400);
    state.sat.setBarSpace(350); await frames(2);
    const b = state.sat.getBarSpace().bar;
    state.base.setBarSpace(60); await frames(2);
    const c = state.base.getBarSpace().bar;
    state.sat.setBarSpace(400); await frames(2);
    state.base.setBarSpace(60); await frames(2);
    return { satLimit50_req350_actual: a, satLimit400_req350_actual: b, baseDefaultLimit_req60_actual: c,
             baseStillDefaultAfterSatelliteWiden: state.base.getBarSpace().bar, satAtLimit400: state.sat.getBarSpace().bar };
  }
  // B: satellite widen must not leak into the base instance
  async function isolation() {
    await initCharts('1d', '1w', 5000);
    const o = {};
    for (const v of [50, 51, 350, 5000]) { state.base.setBarSpace(v); await frames(2); o['base_req' + v] = state.base.getBarSpace().bar; }
    for (const v of [350, 235, 5000]) { state.sat.setBarSpace(v); await frames(2); o['sat_req' + v] = state.sat.getBarSpace().bar; }
    state.base.setBarSpace(50); await frames(2);
    o.base_afterSatelliteWiden_req50 = state.base.getBarSpace().bar;
    return o;
  }
  // C: how many bars does the satellite still show as barSpace grows (>=1 bar feasibility ceiling)
  async function satSweep(satPeriod, satMax) {
    await initCharts('1d', satPeriod, satMax || 2000000);
    const list = state.satList;
    const probe = [];
    for (const v of [20, 50, 100, 150, 235, 350, 520, 700, 1040, 2000, 5000, 10080, 20000]) {
      state.sat.setBarSpace(v); await frames(2);
      const r = read(state.sat, list, satMax || 2000000);
      probe.push({ requested: v, actual: r.barSpace, idxSpan: r.idxSpan, spanMin: r.spanMin, spanInSatBars: r.spanMin / MIN[satPeriod],
                   nBarsInWindow: nBarsWithin(list, r.tsFrom, r.tsTo), widthPx: r.widthPx, barsPerWidth: r.barSpace ? r.widthPx / r.barSpace : null });
    }
    return { satPeriod, chartWidth: state.sat.getSize().width, nominalBucketMs: MIN[satPeriod] * 60000, medianBucketMs: medianBucket(list), probe };
  }
  // D: stability — repeated re-sync rounds + zoom then re-sync
  async function stability(rounds, baseBs, satMax) {
    await initCharts('1d', '1w', satMax || 400, { satCandleMinimized: true });
    const rows = [];
    for (let i = 0; i < rounds; i++) {
      const m = await syncRound(baseBs, { mul: 1 });
      rows.push({ i, satBsRequested: m.satBsRequested, satBsActual: m.sat.barSpace, baseSpanMin: m.base.spanMin, satSpanMin: m.sat.spanMin,
                  errMin: m.errMin, errInSatBars: m.errInSatBars, densityMul: m.densityMul, satIdxSpan: m.sat.idxSpan });
      state.base.scrollToTimestamp(state.baseList[Math.min(600 + i * 7, state.baseList.length - 1)].timestamp);
      await frames(2);
    }
    return rows;
  }
  // base window + empirical density multiplier (bars-per-ms base / bars-per-ms sat) for a given base barSpace
  async function windowInfo(baseBs) {
    state.base.setBarSpace(baseBs); await frames(2);
    const base = read(state.base, state.baseList, 50);
    const nB = nBarsWithin(state.baseList, base.tsFrom, base.tsTo), nS = nBarsWithin(state.satList, base.tsFrom, base.tsTo);
    return { baseBsRequested: baseBs, base, nBWin: nB, nSWin: nS, densityMul: nS > 0 ? nB / nS : null,
             nominalMul: MIN[state.satPeriod] / MIN[state.basePeriod],
             baseBucketMs: medianBucket(state.baseList), satBucketMs: medianBucket(state.satList),
             baseLastTs: state.baseList[state.baseList.length - 1].timestamp, satLastTs: state.satList[state.satList.length - 1].timestamp,
             baseWidth: state.base.getSize().width, satWidth: state.sat.getSize().width };
  }
  // Scan the satellite multiplier around the nominal ratio to find the value that minimises span error
  async function scan(baseBs, loF, hiF, steps, mirrorOffset) {
    const bp = state.basePeriod, sp = state.satPeriod;
    const nominalMul = MIN[sp] / MIN[bp];
    state.base.setBarSpace(baseBs); await frames(2);
    const baseW = read(state.base, state.baseList, 50);
    const run = async (m, fast) => {
      const satBs = baseW.barSpace * m;
      if (mirrorOffset) state.sat.setOffsetRightDistance(state.base.getOffsetRightDistance());
      state.sat.setBarSpace(satBs);
      state.sat.scrollToTimestamp(baseW.centerTs);
      await frames(fast ? 2 : 3);
      const sat = read(state.sat, state.satList, state.satMax);
      return { m, satBsRequested: satBs, satBsActual: sat.barSpace, satSpanMin: sat.spanMin, baseSpanMin: baseW.spanMin,
               errMin: sat.spanMin - baseW.spanMin, errInSatBars: (sat.spanMin - baseW.spanMin) / MIN[sp],
               satIdxSpan: sat.idxSpan, satBarsInWindow: nBarsWithin(state.satList, sat.tsFrom, sat.tsTo), satDataExhausted: sat.satDataExhausted };
    };
    const trail = [];
    const coarse = [];
    for (let i = 0; i <= steps; i++) { const f = loF + (hiF - loF) * i / steps; coarse.push(await run(nominalMul * f, true)); }
    // refine: keep the best coarse point, bisect its neighbourhood 5x using err sign
    let best = coarse.reduce((a, b) => (Math.abs(b.errMin) < Math.abs(a.errMin) ? b : a));
    const sorted = coarse.slice().sort((a, b) => Math.abs(a.errMin) - Math.abs(b.errMin));
    let a = { m: sorted[Math.min(1, sorted.length - 1)].m }, c = { m: sorted[0].m };
    for (let k = 0; k < 5; k++) {
      const probes = (await Promise.all([run((c.m + a.m) / 2, true)])).concat([]);
      trail.push(probes[0]);
      if (Math.abs(probes[0].errMin) < Math.abs(c.errMin)) { a = c; c = probes[0]; }
      else { /* move a further out */ }
      if (Math.abs(probes[0].errMin) < Math.abs(best.errMin)) best = probes[0];
    }
    return { baseBs, baseBsActual: baseW.barSpace, nominalMul, mirrorOffset: !!mirrorOffset, baseSpanMin: baseW.spanMin, baseIdxSpan: baseW.idxSpan, baseBarsInWindow: nBarsWithin(state.baseList, baseW.tsFrom, baseW.tsTo),
             coarse, refineTrail: trail, best, bestMul: best.m, bestErrInSatBars: best.errInSatBars };
  }
  window.__scan = scan;
  window.__windowInfo = windowInfo;
  window.__sizes = () => ({ base: state.base.getSize(), sat: state.sat.getSize(), baseBars: state.base.getDataList().length, satBars: state.sat.getDataList().length });
  window.__limitClamp = limitClamp;
  window.__isolation = isolation;
  window.__satSweep = satSweep;
  window.__stability = stability;
  window.__measuredBuckets = async (periods) => {
    const o = {};
    for (const p of (periods || [])) { const l = await bars(p); o[p] = { nominalMin: MIN[p], medianBucketMs: medianBucket(l), n: l.meta.n, firstTs: l.meta.first, lastTs: l.meta.last }; }
    o.klinechartsVersion = KC.version || KC.getVersion && KC.getVersion() || 'n/a';
    o.supportedIndicators = (KC.getSupportedIndicators && KC.getSupportedIndicators().length) || 0;
    return o;
  };
  window.__ready = true;
})();
// ---- density-anchored probe (appended; loaded after the IIFE above) ----
(function () {
  const KC = window.klinecharts;
  const MIN = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440, '1w': 10080 };
  const DAY = 86400000;
  const st = {};
  const frames = (n) => new Promise(res => { let i = 0; const step = () => { if (++i >= (n || 3)) res(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });
  function tsAt(list, idx) {
    const n = list.length; const fb = n > 1 ? (list[n - 1].timestamp - list[n - 2].timestamp) : 0;
    if (idx <= 0) return list[0].timestamp + idx * fb;
    if (idx >= n - 1) return list[n - 1].timestamp + (idx - (n - 1)) * fb;
    const i = Math.floor(idx), f = idx - i;
    return list[i].timestamp + f * (list[i + 1].timestamp - list[i].timestamp);
  }
  function read(c, list) {
    const r = c.getVisibleRange(); const bs = c.getBarSpace().bar;
    if (!isFinite(r.realFrom)) return { barSpace: bs, invalid: true };
    const tF = tsAt(list, r.realFrom), tT = tsAt(list, r.realTo);
    return { barSpace: bs, idxFrom: r.realFrom, idxTo: r.realTo, idxSpan: r.realTo - r.realFrom,
             tsFrom: tF, tsTo: tT, spanMin: (tT - tF) / 60000, centerTs: Math.round((tF + tT) / 2),
             dataExhausted: tT > list[list.length - 1].timestamp, offsetRight: c.getOffsetRightDistance(), width: c.getSize().width };
  }
  async function bars(p) {
    if (st['b_' + p]) return st['b_' + p];
    const r = await fetch(`/api/kline?code=518880&period=${p}&limit=1000`); const j = await r.json();
    const out = j.bars.map(b => ({ timestamp: Date.parse(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    st['b_' + p] = out; return out;
  }
  const KEY = { '1m': { type: 'minute', span: 1 }, '5m': { type: 'minute', span: 5 }, '15m': { type: 'minute', span: 15 }, '1h': { type: 'hour', span: 1 }, '1d': { type: 'day', span: 1 }, '1w': { type: 'week', span: 1 } };
  async function init(bp, sp, satMax) {
    if (st.base) { KC.dispose(st.base); KC.dispose(st.sat); }
    const fresh = (id) => { const o = document.getElementById(id); const n = document.createElement('div'); n.id = id; n.className = 'box'; o.parentNode.replaceChild(n, o); };
    fresh('cBase'); fresh('cSat');
    st.base = KC.init('cBase', { layout: { barSpaceLimit: { min: 1, max: 50 } } });
    st.sat = KC.init('cSat', { layout: { barSpaceLimit: { min: 1, max: satMax } } });
    st.bp = bp; st.sp = sp; st.satMax = satMax;
    st.bL = await bars(bp); st.sL = await bars(sp);
    for (const [c, l, p] of [[st.base, st.bL, bp], [st.sat, st.sL, sp]]) {
      c.setSymbol({ ticker: '518880', pricePrecision: 3, volumePrecision: 0 });
      c.setPeriod(KEY[p]);
      c.setDataLoader({ getBars: ({ type, callback }) => { type === 'init' ? callback(l.map(x => ({ ...x })), false) : callback([], false); } });
    }
    await frames(4);
    return { bp, sp, satMax, baseW: st.base.getSize().width, satW: st.sat.getSize().width, baseN: st.bL.length, satN: st.sL.length };
  }
  // bars/day density over the last `days` calendar days (gap-robust reference scale)
  async function density(periods, days) {
    const o = {};
    for (const p of periods) {
      const l = await bars(p); const last = l[l.length - 1].timestamp, from = last - days * DAY;
      let n = 0; for (const b of l) if (b.timestamp >= from) n++;
      o[p] = { n, days, barsPerDay: n / days, barsPerMin: n / (days * 1440), lastTs: last, firstTs: l[0].timestamp };
    }
    return o;
  }
  async function round(baseBs, mul, mirrorOffset, rounding) {
    st.base.setBarSpace(baseBs); await frames(2);
    const base = read(st.base, st.bL);
    let satBs = base.barSpace * mul;
    if (rounding === 'int') satBs = Math.round(satBs);
    if (mirrorOffset) st.sat.setOffsetRightDistance(st.base.getOffsetRightDistance());
    st.sat.setBarSpace(satBs);
    st.sat.scrollToTimestamp(base.centerTs);
    if (mirrorOffset) st.sat.setOffsetRightDistance(st.base.getOffsetRightDistance());
    await frames(3);
    const sat = read(st.sat, st.sL);
    return { baseBs, mul, satBsRequested: satBs, satBsActual: sat.barSpace, satClamped: Math.abs(sat.barSpace - satBs) > 1e-9,
      mirrorOffset: !!mirrorOffset, base, sat, errMin: sat.spanMin - base.spanMin, errInSatBars: (sat.spanMin - base.spanMin) / MIN[st.sp],
      leftEdgeErrMin: (sat.tsFrom - base.tsFrom) / 60000, rightEdgeErrMin: (sat.tsTo - base.tsTo) / 60000,
      satBarsVisible: sat.idxSpan, satBarMin: MIN[st.sp] };
  }
  // satellite feasibility: max barSpace that still shows >= `minBars` bars
  async function satCeiling(satPeriod, satMax, minBars) {
    await init('1d', satPeriod, satMax);
    const out = [];
    for (const v of [50, 100, 150, 200, 235, 260, 300, 350, 400, 520, 700, 1000, 1500, 3000, 10080, 20000]) {
      st.sat.setBarSpace(v); await frames(2);
      const r = read(st.sat, st.sL);
      out.push({ requested: v, actual: r.barSpace, width: r.width, idxSpan: r.idxSpan, widthPerBar: r.width / r.barSpace,
                 spanMin: r.spanMin, spanInBars: r.spanMin / MIN[satPeriod], ok1bar: r.width / r.barSpace >= 1, ok3bar: r.width / r.barSpace >= 3 });
    }
    return { satPeriod, satMax, minBars, chartWidth: st.sat.getSize().width, out };
  }
  // Gap-robust density ratio: split the common coverage into K windows anchored on satellite bars,
  // ratio_i = nBase(window_i)/nSat(window_i); D = median(ratio_i).  This is what an implementation can compute at runtime.
  async function densityRatio(K) {
    const bl = st.bL, sl = st.sL;
    const from = Math.max(bl[0].timestamp, sl[0].timestamp), to = Math.min(bl[bl.length - 1].timestamp, sl[sl.length - 1].timestamp);
    const inRange = sl.filter(b => b.timestamp >= from && b.timestamp <= to);
    if (inRange.length < 2) return { D: null, reason: 'no overlap', nSatInOverlap: inRange.length };
    const K2 = K || 8; const ratios = []; const detail = [];
    for (let i = 0; i < K2; i++) {
      const a = Math.floor(i * (inRange.length - 1) / K2), b = Math.floor((i + 1) * (inRange.length - 1) / K2);
      const t0 = inRange[a].timestamp, t1 = inRange[b].timestamp;
      let nB = 0, nS = 0;
      for (const x of bl) if (x.timestamp >= t0 && x.timestamp <= t1) nB++;
      for (const x of inRange) if (x.timestamp >= t0 && x.timestamp <= t1) nS++;
      if (nS > 0 && nB > 0) { ratios.push(nB / nS); detail.push({ t0, t1, nB, nS, r: nB / nS }); }
    }
    ratios.sort((a, b) => a - b);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
    return { D: med, K: K2, ratios, detail, coverage: { from, to, baseN: bl.length, satN: sl.length } };
  }
  window.__dRatio = densityRatio;
  window.__dCharts = () => ({ base: st.base, sat: st.sat, bL: st.bL, sL: st.sL });
  window.__dRead = () => ({ base: read(st.base, st.bL), sat: read(st.sat, st.sL) });
  window.__dInit = init; window.__dDensity = density; window.__dRound = round; window.__dCeiling = satCeiling;
  window.__dBars = bars;
})();
