// ~/~ begin <<design/14-dcap-indicator/02-spec.md#crates/strategy-core/reference-plugins/dcap.js>>[init]
// =============================================================================
// 参考插件：dcap —— 假想定投收益率三线（短/中/长），纯滚动指标（无仓位换算，ADR §13.1）
// 由 design/14-dcap-indicator/02-spec.md §10 的代码块 tangle 生成，禁止手改；
//   改口径 = 改文档 + 重跑 `entangled tangle`（ADR-007 / ADR-021 D1/D2）。
// 镜像约束（ADR-021 D4）：`DCAP CORE BEGIN`/`END` 之间的正文与前端产物逐字节相同。
//
// 口径（02-spec §5）：on_bar ① 维护三条 close 滚动窗口 → ② 逐线算 ROI → ③ SMA(m) 平滑
//   → ④ 数据不足的线跳过（不计入 N）→ ⑤ 三线全不足返回 50（中立）→ ⑥ 否则 dcapScore(v, th)。
//   · 出口 [0,100]：平台 clamp_score + 60/40 阈值零改动（引擎不知道 dcap 存在）。
//   · 异常路径：close <= 0 按数据不足处理，**不得抛错**（避免熔断计次，§5）。
//   · init(params)：**先做三 n 归一化**（CORE `normalizeParams`，§2/§4 铁律 5）再初始化
//     状态；归一化确定 + 幂等，on_bar 内不得重复归一化（窗口容量恒定，T5a）。
//   · 平滑只保留最近 m 个原始 ROI 的尾窗 ⇒ 复用 CORE 的 smoothSeries（同表达式、同求和序）。
//
// 内部状态（ABI G3，必须进 save()/load()，否则重放分叉）：
//   · 三条 close 滚动窗口（各 n_i 长，尾部 = 最新 bar）；
//   · 三条原始 ROI 的平滑尾窗（各 ≤ m 长，含当前 bar）。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "n_s", type: "int", default: 8, min: 2, max: 250, description: "短窗口：最近 n 根 close" },
  { key: "n_m", type: "int", default: 26, min: 2, max: 250, description: "中窗口" },
  { key: "n_l", type: "int", default: 60, min: 2, max: 250, description: "长窗口（跨字段约束 n_s<n_m<n_l 由发布门禁强制）" },
  { key: "r_s", type: "float", default: 1.0, min: 0.5, max: 2.0, description: "短窗口金额增长比" },
  { key: "r_m", type: "float", default: 1.0, min: 0.5, max: 2.0, description: "中窗口金额增长比" },
  { key: "r_l", type: "float", default: 1.0, min: 0.5, max: 2.0, description: "长窗口金额增长比" },
  { key: "smooth", type: "int", default: 1, min: 0, max: 1, description: "平滑开关：0=关（原始线）/ 1=开（SMA(m)）" },
  { key: "m", type: "int", default: 3, min: 1, max: 60, description: "平滑周期；smooth=0 时忽略但仍受校验" },
  { key: "th", type: "float", default: 0.01, min: 0.001, max: 0.5, description: "评分映射标度（仅策略侧使用，图表不用）" }
];

// 归一化后的生效窗口（02-spec §2/§4 铁律 5：只在 init 归一一次，on_bar 只读；
// 属 params 的派生量，非流相关状态 ⇒ 不进 save()/load()，§5「内部状态」只列六条窗口）。
let effS = 8;
let effM = 26;
let effL = 60;

// 内部状态（ABI G3）
let winS = [];
let winM = [];
let winL = [];
let tailS = [];
let tailM = [];
let tailL = [];

// === DCAP CORE BEGIN ===
/**
 * dcap CORE —— 镜像区间（ADR-021 D4）：本区间在两个产物中必须**逐字节相同**。
 *
 * 运行环境契约（02-spec §4 铁律 4）：无类型注解的 ES2015 子集 —— 同一段字节既要经
 * Vite/TS 转译进前端模块，又要被 rquickjs 直接求值（不剥类型注解）。故本区间内
 * 不得出现 TypeScript 注解、ESM 的模块导入/导出语句，也不得使用宿主 Math 之外的 API。
 *
 * 浮点确定性铁律（02-spec §4 铁律 1–3；T3/T4 逐位断言的成立前提）：
 *   ① 禁用宿主 Math 的「幂 / 指数 / 对数」三个方法 —— `r` 的幂只用**迭代乘法**（`a = a * r`）；
 *   ② 禁增量累加（running sum）—— 每 bar 都在窗口上**完整重算**；
 *   ③ 求和顺序钉死为两步：先 k = 1..n 升序迭代乘法求权重（A_1 = 1、A_{k+1} = A_k × r），
 *      再自 k = n 往回（k = n → 1）累加 ΣA_k 与 Σ(A_k/P_k)。两种合法排布的尾数相差
 *      1–2 ulp ⇒ 本段是唯一表述，不得用「等价但次序不同」的写法则套。
 *   ④ §2 跨字段约束的**入口归一化**（§4 铁律 5）也在本区间内：唯一实现 `normalizeParams`，
 *      由插件 `init` 与前端 `computeDcapSeries` 入口调用（两侧同文 ⇒ 非单调 n 下逐位一致）。
 *   k 为年龄升序：k = 1 是窗口内最旧 bar、k = n 是最新 bar（当前 bar），P_k = 第 k 根 close。
 */

/**
 * 参数归一化（02-spec §2 跨字段约束 / §4 铁律 5）：把三条窗口顶成严格单调
 * `n_s < n_m' < n_l'` —— `n_m' ← max(n_m, n_s+1)`、`n_l' ← max(n_l, n_m'+1)`
 * （**顺序归一**：n_l' 用已归一后的 n_m'）。**确定且幂等**（f(f(p)) = f(p)）。
 * 入口调用一次：插件 `init` 与前端 `computeDcapSeries`（§3「参数归一化」行）；
 * `on_bar` 内不得重复归一化（否则窗口容量逐 bar 漂移 ⇒ 确定性与重放失守）。
 * 非有限输入（NaN/±Inf）的归一结果仍非有限，由调用方按「参数非法 → 中立」处理（§5）。
 */
function normalizeParams(p) {
  var s = Math.floor(p.n_s);
  var m = Math.max(Math.floor(p.n_m), s + 1);
  var l = Math.max(Math.floor(p.n_l), m + 1);
  return { n_s: s, n_m: m, n_l: l, r_s: p.r_s, r_m: p.r_m, r_l: p.r_l, smooth: p.smooth, m: p.m };
}

/**
 * 单条线的定投收益率（02-spec §1.2）：窗口 = 最近 n 根 close（含当前 bar）。
 * 金额 A_1 = 1、A_k = r^(k−1)（首笔约掉 ⇒ 无资金规模参数）。
 * ROI = P_n · Σ(A_k/P_k) / ΣA_k − 1；null = 数据不足（bar 数 < n 或价格非法）。
 */
function dcapRoi(closes, n, r) {
  var nn = Math.floor(n);
  if (!(nn >= 1) || nn > closes.length) { return null; }
  var base = closes.length - nn;

  // ① k = 1..n 升序：迭代乘法求权重（禁用 pow）
  var weights = [];
  var a = 1;
  for (var k = 0; k < nn; k++) {
    weights.push(a);
    a = a * r;
  }

  // ② k = n → 1 往回：累加 ΣA_k 与 Σ(A_k/P_k)（本顺序即尾数，不得改写）
  var sumA = 0;
  var sumAP = 0;
  for (var j = nn - 1; j >= 0; j--) {
    var p = closes[base + j];
    if (!(p > 0)) { return null; }   // 除零/非法价 → 按数据不足（插件侧不得抛错，§5）
    sumA = sumA + weights[j];
    sumAP = sumAP + weights[j] / p;
  }
  var last = closes[closes.length - 1];
  return last * sumAP / sumA - 1;
}

/**
 * SMA(m)（02-spec §3）：窗口局部 ⇒ 起算点无关（ADR-021 D1 成立的前提）。
 * smooth = 0 或 m <= 1 ⇒ **逐位直通原值**（§8 裁决 6；不得走第二条近似路径）。
 * 忽略 null 前导（窗口不推进）；有效值不足 m 个 ⇒ null。
 */
function smoothSeries(values, smooth, m) {
  var mm = Math.floor(m);
  var out = [];
  var i;
  if (smooth === 0 || !(mm > 1)) {
    for (i = 0; i < values.length; i++) { out.push(values[i]); }
    return out;
  }
  var win = [];
  for (i = 0; i < values.length; i++) {
    var v = values[i];
    if (v === null || v === undefined) {
      out.push(null);
      continue;
    }
    win.push(v);
    if (win.length > mm) { win.shift(); }
    if (win.length < mm) {
      out.push(null);
      continue;
    }
    var sum = 0;
    for (var j = 0; j < mm; j++) { sum = sum + win[j]; }
    out.push(sum / mm);
  }
  return out;
}

/**
 * 整段序列（图表 calc 用）：每个 index 只依赖 closes[..=index]（**禁未来函数**、
 * 禁增量累加 —— T2-b 用 dcapRoi 独立复算逐位钉死）。
 * 入口先 `normalizeParams(p)`（§4 铁律 5），后续一律用归一后的 `q`。
 */
function computeDcapSeries(closes, p) {
  var q = normalizeParams(p);   // §4 铁律 5：前端入口归一化（CORE 内唯一实现，与插件同口径）
  var rawS = [];
  var rawM = [];
  var rawL = [];
  for (var i = 0; i < closes.length; i++) {
    var prefix = closes.slice(0, i + 1);
    rawS.push(dcapRoi(prefix, q.n_s, q.r_s));
    rawM.push(dcapRoi(prefix, q.n_m, q.r_m));
    rawL.push(dcapRoi(prefix, q.n_l, q.r_l));
  }
  var smS = smoothSeries(rawS, q.smooth, q.m);
  var smM = smoothSeries(rawM, q.smooth, q.m);
  var smL = smoothSeries(rawL, q.smooth, q.m);
  var out = [];
  for (var j = 0; j < closes.length; j++) {
    out.push({ s: smS[j], m: smM[j], l: smL[j] });
  }
  return out;
}

/**
 * 评分映射（02-spec §4）：per_i = clamp(roi_i / th, −1, +1)；
 * score = clamp(50 − (50/N)·Σ per_i, 0, 100)。缺值的线跳过（不计入 N）；三线全缺 → 50。
 * 三线等权 =「平均观感」而非「平均 ROI」，保住三重确认语义。
 */
function dcapScore(values, th) {
  var roi = [];
  if (values.s !== null && values.s !== undefined) { roi.push(values.s); }
  if (values.m !== null && values.m !== undefined) { roi.push(values.m); }
  if (values.l !== null && values.l !== undefined) { roi.push(values.l); }
  if (roi.length === 0) { return 50; }
  var acc = 0;
  for (var i = 0; i < roi.length; i++) {
    var per = roi[i] / th;
    if (per < -1) { per = -1; }
    if (per > 1) { per = 1; }
    acc = acc + per;
  }
  var score = 50 - (50 / roi.length) * acc;
  if (score < 0) { score = 0; }
  if (score > 100) { score = 100; }
  return score;
}
// === DCAP CORE END ===

/**
 * 单线推进：close 入滚动窗 → 原始 ROI → 平滑尾窗 → SMA(m)（复用 CORE 的 smoothSeries）。
 * 尾窗长度 ≤ m ⇒ smoothSeries 在该窗上的末元素与前端「整段序列上的 SMA(m)」逐位相同
 * （SMA 窗口局部；原始 ROI 的 null 仅出现在前导，两端一致 —— 见 02-spec §3）。
 */
function dcapPushLine(win, tail, close, n, r, smooth, m) {
  win.push(close);
  if (win.length > n) { win.shift(); }
  const raw = dcapRoi(win, n, r);
  tail.push(raw);
  if (tail.length > m) { tail.shift(); }
  const sm = smoothSeries(tail, smooth, m);
  return sm[sm.length - 1];
}

function init(params) {
  // §2 跨字段约束：先做 CORE 归一化（确定 + 幂等），生效值存模块状态；
  // on_bar 内不得重复归一化（窗口容量恒定 ⇒ T5a-4）。
  const q = normalizeParams(params);
  effS = Math.floor(q.n_s);
  effM = Math.floor(q.n_m);
  effL = Math.floor(q.n_l);
  winS = [];
  winM = [];
  winL = [];
  tailS = [];
  tailM = [];
  tailL = [];
}

function on_bar(ctx) {
  const p = ctx.params;
  const nS = effS;   // init 归一化后的生效值（on_bar 不再归一，§3/§5）
  const nM = effM;
  const nL = effL;
  const mm = Math.floor(p.m);
  if (!(nS >= 1) || !(nM >= 1) || !(nL >= 1) || !(mm >= 1)) {
    return 50; // 参数非法（含 NaN/±Inf）→ 中立（不抛错，避 ABI G5 熔断计次）
  }
  const close = ctx.bar.close;
  const values = {
    s: dcapPushLine(winS, tailS, close, nS, p.r_s, p.smooth, mm),
    m: dcapPushLine(winM, tailM, close, nM, p.r_m, p.smooth, mm),
    l: dcapPushLine(winL, tailL, close, nL, p.r_l, p.smooth, mm)
  };
  return dcapScore(values, p.th);
}

function save() {
  return {
    winS: winS.slice(), winM: winM.slice(), winL: winL.slice(),
    tailS: tailS.slice(), tailM: tailM.slice(), tailL: tailL.slice()
  };
}

// 防御口径（NIT-3，与 kdj/dual_ma/boll 一致）：字段缺失/类型错误 → 回退安全默认
// （= init() 初始值），不得把 undefined 写入状态引入 NaN 污染。
function load(state) {
  const s = state || {};
  winS = Array.isArray(s.winS) ? s.winS.slice() : [];
  winM = Array.isArray(s.winM) ? s.winM.slice() : [];
  winL = Array.isArray(s.winL) ? s.winL.slice() : [];
  tailS = Array.isArray(s.tailS) ? s.tailS.slice() : [];
  tailM = Array.isArray(s.tailM) ? s.tailM.slice() : [];
  tailL = Array.isArray(s.tailL) ? s.tailL.slice() : [];
}
// ~/~ end
