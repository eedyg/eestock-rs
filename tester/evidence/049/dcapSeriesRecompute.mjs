import { computeDcapSeries } from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcap.ts';
const url = process.argv[2];
const limit = Number(process.argv[3] || 0);
const params = { n_s: 8, n_m: 26, n_l: 60, r_s: 1.0, r_m: 1.0, r_l: 1.0, smooth: 0, m: 3 };
const r = await fetch(url);
const j = await r.json();
const bars = Array.isArray(j) ? j : (j.bars || j.data || j.list || []);
console.log('bars:', bars.length, 'keys:', Object.keys(bars[0] || {}));
const list = limit > 0 ? bars.slice(-limit) : bars;
const closes = list.map(b => b.close ?? b.c ?? b.last);
const series = computeDcapSeries(closes, params);
const flat = { s: [], m: [], l: [] };
for (const v of series) { if (v.s !== null) flat.s.push(v.s); if (v.m !== null) flat.m.push(v.m); if (v.l !== null) flat.l.push(v.l); }
const all = [...flat.s, ...flat.m, ...flat.l];
const stat = a => a.length ? { n: a.length, min: Math.min(...a), max: Math.max(...a) } : { n: 0 };
console.log(JSON.stringify({ n: series.length, first20: series.slice(0, 3), perSeries: { s: stat(flat.s), m: stat(flat.m), l: stat(flat.l) }, allMin: Math.min(...all), allMax: Math.max(...all), negatives: all.filter(v => v < 0).length }, null, 1));
