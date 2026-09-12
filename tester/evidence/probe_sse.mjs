#!/usr/bin/env node
// 独立 SSE MCP 探针（验证 I-1）：连 GET /sse，取 endpoint 帧；逐个 POST /messages，读 SSE message 帧。
// 用法: node probe_sse.mjs <base-url> '<json-array-of-calls>'
//   calls = [{"name":"get_kline","args":{"code":"510300"}}, ...]
const base = process.argv[2] || 'http://127.0.0.1:8082';
const calls = JSON.parse(process.argv[3] || '[{"name":"get_kline","args":{"code":"510300"}}]');

const t0 = Date.now();
const resp = await fetch(`${base}/sse`, { headers: { Accept: 'text/event-stream' } });
console.log(`# SSE GET ${base}/sse -> ${resp.status} ${resp.headers.get('content-type')} (${Date.now()-t0}ms)`);
if (resp.status !== 200) { console.log('# FATAL: SSE not available'); process.exit(2); }

const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '';
const queue = [];
const waiters = [];
function push(v){ if(waiters.length) waiters.shift()(v); else queue.push(v); }
function next(ms=10000){
  if(queue.length) return Promise.resolve(queue.shift());
  return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error('SSE frame timeout')),ms); waiters.push(v=>{clearTimeout(t);res(v);}); });
}
let endpoint = null;
(async () => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
      if (dataLine) {
        const data = dataLine.slice(6);
        if (!endpoint && data.startsWith('/messages?sessionId=')) endpoint = data;
        else push(data);
      }
    }
  }
})();

for (let k=0; k<120 && !endpoint; k++) await new Promise(r=>setTimeout(r,25));
if (!endpoint) { console.log('# FATAL: no endpoint frame'); process.exit(3); }
console.log(`# endpoint frame: ${endpoint}`);
const url = `${base}${endpoint}`;

let id = 100;
for (const c of calls) {
  const req = { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: c.name, arguments: c.args ?? {} } };
  const t = Date.now();
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(req) });
  let frame;
  try { frame = await next(15000); } catch(e) { frame = `<NO FRAME: ${e.message}>`; }
  console.log(`\n## tools/call ${c.name} ${JSON.stringify(c.args ?? {})}`);
  console.log(`# POST /messages -> ${r.status} (${Date.now()-t}ms)`);
  console.log(`# SSE frame: ${frame}`);
}
process.exit(0);
