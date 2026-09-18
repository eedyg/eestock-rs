#!/usr/bin/env node
// ADR-024 P4b 修复 tester 独立验收 —— 真路径 WS 帧捕获 + 终态路径探针（node，web/node_modules/ws）。
//
// 用法: node probe_255_ws.mjs <apiBase> <scenario> <symbol> <period> <from> <to> <cancelAfterMs> <verId>
//   scenario ∈ complete | cancel   （fail 场景由外层 bash 注入临时库约束后仍用 complete 驱动）
// 输出: 人类可读 + 末行 `RESULT {...}` 供程序解析。
import WebSocket from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/ws/index.js';

const [api, scenario, symbol, period, from, to, cancelMsRaw, ver] = process.argv.slice(2);
const cancelAfterMs = Number(cancelMsRaw || 0);
const iso = () => new Date().toISOString();

const frames = [];   // {t, run_id, progress}
let wsLagged = 0;
const ws = new WebSocket(api.replace(/^http/, 'ws') + '/ws');
const opened = new Promise((res) => ws.on('open', res));
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === 'strategy_run_progress') frames.push({ t: Date.now(), run_id: m.run_id, progress: m.progress });
});
ws.on('error', (e) => { console.log('# WS error: ' + e.message); });

await opened;
ws.send(JSON.stringify({ type: 'subscribe', topic: 'strategy_run' }));
console.log(`# ${iso()} WS connected + subscribed strategy_run(wildcard)`);

const body = {
  name: `T255-WS-${scenario}-${Date.now()}`, symbol, period, from, to,
  slots: [{ version_id: ver, params: { fast: 5.0, slow: 20.0 }, weight: 1.0 }],
  buy_threshold: 60.0, sell_threshold: 40.0,
  policy: { LumpSum: { position_pct: 1.0 } },
  initial_capital: 100000.0, warmup_bars: 250,
};
const t0 = Date.now();
const sub = await fetch(`${api}/api/workbench/runs`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const subJson = await sub.json();
const rid = subJson.id;
console.log(`# ${iso()} submit http=${sub.status} id=${rid} wall_ms=${Date.now() - t0}`);

let cancelResp = null;
if (scenario === 'cancel') {
  await new Promise((r) => setTimeout(r, cancelAfterMs));
  const cr = await fetch(`${api}/api/workbench/runs/${rid}/cancel`, { method: 'POST' });
  cancelResp = { status: cr.status, body: await cr.text() };
  console.log(`# ${iso()} cancel http=${cancelResp.status} at_ms=${Date.now() - t0} body=${cancelResp.body.slice(0, 200)}`);
}

let st = null, view = null;
for (let i = 0; i < 3000; i++) {
  const r = await fetch(`${api}/api/workbench/runs/${rid}`);
  view = await r.json();
  st = view.status;
  if (st === 'succeeded' || st === 'failed' || st === 'canceled') break;
  await new Promise((r) => setTimeout(r, 20));
}
const tTerm = Date.now();
// 等 WS 帧收敛（排水后再收 300ms）
await new Promise((r) => setTimeout(r, 400));
const my = frames.filter((f) => f.run_id === rid);
const last = my.length ? my[my.length - 1].progress : null;
const out = {
  scenario, run_id: rid, http_submit: sub.status, cancel: cancelResp,
  status: st, progress_in_db: view.progress, error: view.error,
  wall_submit_to_terminal_ms: tTerm - t0,
  ws_frames: my.length, ws_last_progress: last,
  ws_first_progress: my.length ? my[0].progress : null,
  ws_has_1_0: my.some((f) => f.progress >= 1.0),
  ws_duplicate_consecutive: my.filter((f, i) => i > 0 && f.progress === my[i - 1].progress).length,
};
console.log(`# ${iso()} terminal status=${st} db_progress=${view.progress} ws_frames=${my.length} ws_last=${last}`);
console.log('RESULT ' + JSON.stringify(out));
ws.close();
process.exit(0);
