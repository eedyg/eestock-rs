// =============================================================================
// 参考插件：kdj —— KDJ 金叉/死叉（K 上穿 D Buy / 下穿 Sell）
// 迁移自 Rust 内建策略 crates/backtest/src/strategies.rs::KdjStrategy（语义 1:1）。
// =============================================================================
//
// 评分映射口径（架构裁决，ADR §6/§13.1）：Buy→80 / Sell→20 / Hold→50。
//   等价性依据：默认聚合阈 60/40 下 80≥60 即 Buy、20≤40 即 Sell、50 即 Hold
//   （守门测试：tests/equivalence.rs）。
//
// 仓位说明：不含 position_pct——仓位换算是 ExecutionPolicy 职责（ADR §13.1）。
//
// 指标口径注记（重要）：
//   host 注入的 ctx.indicators.kdj() 周期固定为 (9,3,3)（ABI §2），无法表达
//   本策略的 n/k_period/d_period 参数。为与 Rust 版在任意参数下语义一致，
//   本插件按 backtest::Indicators::kdj 口径**自持滚动窗口与平滑状态复算**：
//     - RSV = (close − n周期最低low) / (n周期最高high − n周期最低low) × 100，
//       区间含当前 bar；high == low 时 RSV 取 50（Rust 同口径）；
//     - K/D 以 50 为种子，自窗口首次满 n 根起按 (m−1)/m 平滑递推；
//     - J = 3K − 2D（本策略只用 K/D 交叉，J 不参与判定）；
//     - 全部 IEEE754 双精度同序运算，与 Rust 逐点一致（equivalence 测试含
//       默认参数 9/3/3 长序列抽查）。
//   前提：引擎从 bar 0 起逐 bar 连续调用 on_bar（EnsembleEngine 保证）。
//   数据不足（窗口未满 n 根）→ 中立 50 且不更新 prev/K/D（对应 Rust kdj 返回 None
//   时 prev_k_gt_d 不更新的口径）。
//
// 内部状态（ABI G3）：highs/lows 滚动窗 + k/d/prevGt，经 save()/load() 快照/恢复。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "n", type: "int", default: 9, min: 2, max: 100, description: "RSV 周期" },
  { key: "k_period", type: "int", default: 3, min: 2, max: 30, description: "K 平滑周期" },
  { key: "d_period", type: "int", default: 3, min: 2, max: 30, description: "D 平滑周期" }
];

let highs = [];    // 最近 n 根 high（滚动窗）
let lows = [];     // 最近 n 根 low（滚动窗）
let k = 50;        // K 值（种子 50，Rust 同口径）
let d = 50;        // D 值（种子 50）
let prevGt = null; // 上一有效 bar 的 k > d；null = 尚无有效读数

function init(params) {
  highs = [];
  lows = [];
  k = 50;
  d = 50;
  prevGt = null;
}

function on_bar(ctx) {
  const n = ctx.params.n;
  const kp = ctx.params.k_period;
  const dp = ctx.params.d_period;
  if (n < 1 || kp < 1 || dp < 1) {
    return 50; // 周期非法（Rust 版指标 None → Hold）
  }
  highs.push(ctx.bar.high);
  lows.push(ctx.bar.low);
  if (highs.length > n) {
    highs.shift();
    lows.shift();
  }
  if (highs.length < n) {
    return 50; // 窗口未满：指标不可用 → 中立，不更新 prev/K/D
  }
  let hh = -Infinity;
  let ll = Infinity;
  for (let i = 0; i < highs.length; i++) {
    if (highs[i] > hh) { hh = highs[i]; }
    if (lows[i] < ll) { ll = lows[i]; }
  }
  const rsv = hh === ll ? 50 : (ctx.bar.close - ll) / (hh - ll) * 100;
  k = ((kp - 1) / kp) * k + (1 / kp) * rsv;
  d = ((dp - 1) / dp) * d + (1 / dp) * k;
  const gt = k > d;
  let score = 50;
  if (prevGt !== null) {
    if (gt && !prevGt) {
      score = 80; // 金叉 → Buy
    } else if (!gt && prevGt) {
      score = 20; // 死叉 → Sell
    }
  }
  prevGt = gt;
  return score;
}

function save() {
  return { highs: highs.slice(), lows: lows.slice(), k: k, d: d, prevGt: prevGt };
}

// 防御口径（NIT-3）：与 dual_ma/boll 一致——字段缺失/类型错误时回退安全默认
// （= init() 初始值），不得将 undefined 写入状态引入 NaN 污染。
function load(state) {
  const s = state || {};
  highs = Array.isArray(s.highs) ? s.highs.slice() : [];
  lows = Array.isArray(s.lows) ? s.lows.slice() : [];
  k = (typeof s.k === "number") ? s.k : 50;
  d = (typeof s.d === "number") ? s.d : 50;
  prevGt = (s.prevGt === true || s.prevGt === false) ? s.prevGt : null;
}
