// Tester 独立值域穷举（用库内 strategy_version.code 的原始字节，node 里真实执行 on_bar）
// 输入：50_sv_code.exact.txt（psql 原样导出的 code；注意末尾多一个换行需裁掉）
// 目的：判定「该插件是否存在任何 ≤ sell_threshold(40) 的分支」与「是否存在 > buy 阈值以外的中立」
const fs = require('fs');
let src = fs.readFileSync(__dirname + '/50_sv_code.exact.txt', 'utf8');
if (src.endsWith('\n')) src = src.slice(0, -1);
console.log('code 字节数(裁掉 psql 尾换行后) =', Buffer.byteLength(src, 'utf8'));
console.log('code 是否含 string "return" 之外的分支字面量 40 或更小数字 =',
  /\b(?:[0-3]?\d)\s*;/.test(src.replace(/\/\/[^\n]*/g, '')));

// 用真实插件字节构造实例（与 QuickJS 沙箱语义等价的纯函数调用）
const factory = new Function(src + '\n; return { on_bar, PARAMS_SCHEMA };');
const { on_bar, PARAMS_SCHEMA } = factory();
console.log('PARAMS_SCHEMA =', JSON.stringify(PARAMS_SCHEMA));

const vals = new Set();
let n = 0, bad = 0, nonfinite = 0;
const cads = [];
for (let c = PARAMS_SCHEMA[0].min; c <= PARAMS_SCHEMA[0].max; c++) cads.push(c);
const plans = [];
for (let p = PARAMS_SCHEMA[1].min; p <= PARAMS_SCHEMA[1].max; p++) plans.push(p);
for (const cadence of cads) for (const plan_bars of plans) for (let idx = 0; idx <= 1000; idx++) {
  const v = on_bar({ params: { cadence, plan_bars }, index: idx });
  n++;
  if (!Number.isFinite(v)) nonfinite++;
  if (v < 0 || v > 100) bad++;
  vals.add(v);
}
const sorted = [...vals].sort((a, b) => a - b);
console.log('样本数 =', n);
console.log('可达值域 =', JSON.stringify(sorted));
console.log('是否含 ≤ sell_threshold(40) 的取值 =', sorted.some(v => v <= 40));
console.log('是否含 ≥ buy_threshold(60) 的取值 =', sorted.some(v => v >= 60));
console.log('非有限值数 =', nonfinite, '越界值数 =', bad);

// run 实际参数 (cadence=20, plan_bars=5) 的相位序列
const seq = [];
for (let idx = 255; idx <= 266; idx++) seq.push(on_bar({ params: { cadence: 20, plan_bars: 5 }, index: idx }));
console.log('run 参数 (20,5) idx 255..266 序列 =', JSON.stringify(seq));

// 参数交互边界：plan_bars >= cadence ⇒ 恒 Buy（永不中立）
const alwaysBuy = [];
for (const cadence of cads) for (const plan_bars of [cadence, cadence + 1, 120]) {
  if (plan_bars < 1 || plan_bars > 120) continue;
  let all75 = true;
  for (let idx = 0; idx <= 500; idx++) if (on_bar({ params: { cadence, plan_bars }, index: idx }) !== 75) { all75 = false; break; }
  if (all75) alwaysBuy.push([cadence, plan_bars]);
}
console.log('「恒为 75（永不中立）」的 (cadence,plan_bars) 对数 =', alwaysBuy.length, '例：', JSON.stringify(alwaysBuy.slice(0, 5)));
