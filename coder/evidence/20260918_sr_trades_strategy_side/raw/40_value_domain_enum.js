// 可执行验证：用库内 sv_1789211089727_000010 的**原始字节**实例化插件，
// 枚举 (cadence, plan_bars) 声明值域内的全部组合 × idx 0..1000，收集真实返回值集合。
const fs = require("fs");
const code = fs.readFileSync(process.argv[2], "utf8");
// 以 ABI 同构方式加载：module 级 eval，捕获 PARAMS_SCHEMA 与 on_bar
const mod = { exports: {} };
const fn = new Function("exports", "module", code + "\n;module.exports={PARAMS_SCHEMA:typeof PARAMS_SCHEMA!=='undefined'?PARAMS_SCHEMA:null, on_bar:typeof on_bar!=='undefined'?on_bar:null};");
fn(mod.exports, mod);
const { PARAMS_SCHEMA, on_bar } = mod.exports;
console.log("PARAMS_SCHEMA =", JSON.stringify(PARAMS_SCHEMA));
const seen = new Set();
let combos = 0;
const schema = Object.fromEntries(PARAMS_SCHEMA.map(p => [p.key, p]));
for (let cadence = schema.cadence.min; cadence <= schema.cadence.max; cadence++) {
  for (let plan_bars = schema.plan_bars.min; plan_bars <= schema.plan_bars.max; plan_bars++) {
    combos++;
    for (let idx = 0; idx <= 1000; idx++) {
      const v = on_bar({ params: { cadence, plan_bars }, index: idx, bar: { open: 1, high: 1, low: 1, close: 1 }, indicators: {}, position: null, log: () => {} });
      seen.add(v);
    }
  }
}
console.log("combos(cadence×plan_bars) =", combos, " idx 0..1000 ⇒ 样本数 =", combos * 1001);
console.log("可达值域 value set =", JSON.stringify([...seen].sort((a,b)=>a-b)));
console.log("是否含 ≤ sell_threshold(40) 的分支 =", [...seen].some(v => v <= 40));
console.log("是否含 ≥ buy_threshold(60) 的分支 =", [...seen].some(v => v >= 60));
// 单点对照：本 run 的实际参数
console.log("run 参数 (cadence=20, plan_bars=5) idx 255..266 =",
  [...Array(12)].map((_,k)=>on_bar({params:{cadence:20,plan_bars:5},index:255+k,bar:{},indicators:{},position:null,log:()=>{}})).join(","));
