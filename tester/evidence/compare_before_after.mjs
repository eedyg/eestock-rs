#!/usr/bin/env node
// 修复前后 get_kline 帧对比：生产 :8082（修复前） vs 测试实例（修复后，同一调用参数）。
import { readFileSync } from 'node:fs';

function frames(p, isProd) {
  const lines = readFileSync(p, 'utf8').split('\n');
  const out = []; let cur = null;
  for (const l of lines) {
    if (isProd && l.startsWith('## tools/call ')) { const m = l.match(/^## tools\/call (\S+) (.*)$/); cur = { name: m[1], args: JSON.parse(m[2]) }; }
    else if (!isProd && l.startsWith('TOOL ')) { const m = l.match(/^TOOL (\S+) ARGS (.*)$/); cur = { name: m[1], args: JSON.parse(m[2]) }; }
    else if (isProd && l.startsWith('# SSE frame: ') && cur) { cur.frame = JSON.parse(l.slice('# SSE frame: '.length)); out.push(cur); cur = null; }
    else if (!isProd && l.startsWith('FRAME [A-real] ') && cur) { cur.frame = JSON.parse(l.slice('FRAME [A-real] '.length)); out.push(cur); cur = null; }
  }
  return out;
}
const key = x => x.name + " " + JSON.stringify(Object.keys(x.args).sort().map(k => [k, x.args[k]]));
const prod = frames('baseline_prod_8082.txt', true);
const harn = frames('i1_sse_harness_raw.txt', false);

for (const h of harn) {
  const p = prod.find(x => key(x) === key(h));
  if (!p) { console.log(`SKIP ${key(h)}`); continue; }
  const pf = p.frame, hf = h.frame;
  const pErr = pf.result && pf.result.isError === true;
  const hErr = hf.result && hf.result.isError === true;
  const pText = pf.result?.content?.[0]?.text ?? JSON.stringify(pf.error);
  const hText = hf.result?.content?.[0]?.text ?? JSON.stringify(hf.error);
  const code = h.args.code;
  console.log(`\n=== get_kline code=${code} ===`);
  console.log(`prod(修前) isError=${pErr}  text=${JSON.stringify(pText).slice(0, 180)}`);
  console.log(`harness(修后) isError=${hErr}  text=${JSON.stringify(hText).slice(0, 180)}`);
  console.log(`payload_identical=${pText === hText}  behavior_changed=${pErr !== hErr}`);
}
