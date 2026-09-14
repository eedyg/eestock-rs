// WS liveness probe (read-only observation) — phase 1 assessment 057
// Usage: node ws_probe.mjs <durationSec> <topicsCsv> <outFile>
//   topicsCsv: subset of bar1m,bar15m,quote,health
import { writeFileSync } from 'node:fs';

const durationSec = Number(process.argv[2] ?? 300);
const topics = (process.argv[3] ?? 'bar1m,bar15m,quote,health').split(',').filter(Boolean);
const outFile = process.argv[4] ?? 'ws_probe_out.json';
const URL = 'ws://127.0.0.1:18099/ws';
const CODE = '518880';

const frames = [];
const t0 = Date.now();
const iso = (ms = Date.now()) => new Date(ms).toISOString();

const ws = new WebSocket(URL);

ws.onopen = () => {
  if (topics.includes('bar1m')) ws.send(JSON.stringify({ type: 'subscribe', topic: 'bar', code: CODE, period: '1m' }));
  if (topics.includes('bar15m')) ws.send(JSON.stringify({ type: 'subscribe', topic: 'bar', code: CODE, period: '15m' }));
  if (topics.includes('quote')) ws.send(JSON.stringify({ type: 'subscribe', topic: 'quote' }));
  if (topics.includes('health')) ws.send(JSON.stringify({ type: 'subscribe', topic: 'health' }));
  console.error(`[probe] open, subs=${topics.join('+')} at ${iso()}`);
};

ws.onmessage = (ev) => {
  let msg = null;
  try { msg = JSON.parse(String(ev.data)); } catch { /* ignore */ }
  const rec = { wall: iso(), rel: ((Date.now() - t0) / 1000).toFixed(3), type: msg?.type ?? 'unparsed' };
  if (msg?.type === 'bar') { rec.code = msg.code; rec.period = msg.period; rec.bar_ts = msg.bar?.ts; rec.close = msg.bar?.close; }
  if (msg?.type === 'quote') { rec.code = msg.code; rec.ts = msg.ts; rec.last = msg.last; }
  if (msg?.type === 'health') { rec.window_secs = msg.window_secs; rec.sources = Array.isArray(msg.sources) ? msg.sources.length : null; }
  const key = msg?.type === 'bar' ? `bar:${msg.period}` : (msg?.type ?? 'other');
  rec.key = key;
  frames.push(rec);
};

ws.onerror = (e) => { console.error('[probe] error', e?.message ?? e); };
ws.onclose = (e) => { console.error(`[probe] closed code=${e.code} reason=${e.reason}`); };

setTimeout(() => {
  const rels = frames.map((f) => Number(f.rel));
  const summary = {};
  for (const f of frames) {
    summary[f.key] = summary[f.key] ?? { count: 0, firstRel: null, lastRel: null };
    summary[f.key].count += 1;
    summary[f.key].firstRel ??= f.rel;
    summary[f.key].lastRel = f.rel;
  }
  const gaps = (key) => {
    const t = frames.filter((f) => f.key === key).map((f) => Number(f.rel));
    return t.slice(1).map((v, i) => +(v - t[i]).toFixed(3));
  };
  const out = {
    probe: { url: URL, code: CODE, topics, durationSec, startedAt: iso(t0), endedAt: iso(), windowSecs: (Date.now() - t0) / 1000, totalFrames: frames.length },
    summary,
    gaps: Object.fromEntries(Object.keys(summary).map((k) => [k, gaps(k)])),
    frames,
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`[probe] done: total=${frames.length} -> ${outFile}`);
  for (const [k, v] of Object.entries(summary)) {
    console.error(`[probe]   ${k}: count=${v.count} first=${v.firstRel}s last=${v.lastRel}s gaps=${JSON.stringify(gaps(k))}`);
  }
  ws.close();
  process.exit(0);
}, durationSec * 1000);
