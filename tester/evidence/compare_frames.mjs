#!/usr/bin/env node
// 比较生产 :8082（修复前）与测试实例（修复后）在同一装配下的只读工具帧是否逐字节等价。
// 输入：prod_8082_regression.txt / i1_sse_harness_raw.txt
import { readFileSync } from 'node:fs';

function parseHarness(p) {
  const lines = readFileSync(p, 'utf8').split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('TOOL ')) { const m = l.match(/^TOOL (\S+) ARGS (.*)$/); cur = { name: m[1], args: JSON.parse(m[2]) }; }
    else if (l.startsWith('FRAME [') && cur) { const m = l.match(/^FRAME \[([^\]]+)\] (.*)$/); cur.tag = m[1]; cur.frame = JSON.parse(m[2]); out.push(cur); cur = null; }
  }
  return out;
}
function parseProd(p) {
  const lines = readFileSync(p, 'utf8').split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('## tools/call ')) { const m = l.match(/^## tools\/call (\S+) (.*)$/); cur = { name: m[1], args: JSON.parse(m[2]) }; }
    else if (l.startsWith('# SSE frame: ') && cur) { cur.tag = 'prod'; cur.frame = JSON.parse(l.slice('# SSE frame: '.length)); out.push(cur); cur = null; }
  }
  return out;
}

const prod = parseProd('prod_8082_regression.txt');
const harn = parseHarness('i1_sse_harness_raw.txt').filter(x => x.tag === 'D-regression');
const key = x => x.name + ' ' + JSON.stringify(x.args);

let diffs = 0, same = 0;
for (const h of harn) {
  const p = prod.find(x => key(x) === key(h));
  if (!p) { console.log(`SKIP(no prod counterpart): ${key(h)}`); continue; }
  // 规范化：id 不同；比较 result.payload 与 error
  const norm = f => JSON.stringify({ r: f.result ?? null, e: f.error ?? null })
      ;
  const a = norm(p.frame), b = norm(h.frame);
  if (a === b) { console.log(`MATCH  ${key(h)}  (payload bytes identical, ${a.length} chars)`); same++; }
  else {
    diffs++;
    console.log(`DIFF   ${key(h)}`);
    console.log(`  prod: ${a.slice(0, 600)}`);
    console.log(`  harn: ${b.slice(0, 600)}`);
  }
}
console.log(`\n# compared=${same + diffs} identical=${same} differing=${diffs}`);
