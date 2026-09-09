// =============================================================================
// 参考插件：macd —— MACD 金叉/死叉（DIF 上穿 DEA Buy / 下穿 Sell）
// 迁移自 Rust 内建策略 crates/backtest/src/strategies.rs::MacdStrategy（语义 1:1）。
// =============================================================================
//
// 评分映射口径（架构裁决，ADR §6/§13.1）：Buy→80 / Sell→20 / Hold→50。
//   等价性依据：默认聚合阈 60/40 下 80≥60 即 Buy、20≤40 即 Sell、50 即 Hold
//   （守门测试：tests/equivalence.rs）。
//
// 仓位说明：不含 position_pct——仓位换算是 ExecutionPolicy 职责（ADR §13.1）。
//
// 指标口径注记（重要）：
//   host 注入的 ctx.indicators.macd() 周期固定为 (12,26,9)（ABI §2），无法表达
//   本策略的 fast/slow/signal 参数。为与 Rust 版在任意参数下语义一致，本插件
//   按 backtest::Indicators::macd 口径**自持增量状态复算**：
//     - EMA 种子 = 首根 bar 的 close；DIF = EMA(fast) − EMA(slow)；
//     - DEA 种子 = 首根 DIF（= 0），之后按 signal 周期 EMA 递推；
//     - 全部 IEEE754 双精度同序运算，与 Rust 逐点一致（equivalence 测试含
//       默认参数 12/26/9 长序列抽查）。
//   前提：引擎从 bar 0 起逐 bar 连续调用 on_bar（EnsembleEngine 保证）。
//   MACD 自首根 bar 起即有值（Rust 版同样无暖机 null），故 prev 每 bar 更新。
//
// 内部状态（ABI G3）：emaFast/emaSlow/dea/seen/prevGt，经 save()/load() 快照/恢复。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 12, min: 2, max: 100, description: "快线 EMA 周期" },
  { key: "slow", type: "int", default: 26, min: 2, max: 200, description: "慢线 EMA 周期" },
  { key: "signal", type: "int", default: 9, min: 2, max: 100, description: "信号线（DEA）周期" }
];

let emaFast = 0;
let emaSlow = 0;
let dea = 0;
let seen = 0;      // 已处理 bar 数（首根种子判定）
let prevGt = null; // 上一 bar 的 dif > dea；null = 尚无读数

function init(params) {
  emaFast = 0;
  emaSlow = 0;
  dea = 0;
  seen = 0;
  prevGt = null;
}

function on_bar(ctx) {
  const fast = ctx.params.fast;
  const slow = ctx.params.slow;
  const sig = ctx.params.signal;
  // 周期非法（Rust 版 fast/slow/signal 为 0 时指标 None → Hold 且不更新 prev）。
  if (fast < 1 || slow < 1 || sig < 1) {
    return 50;
  }
  const close = ctx.bar.close;
  if (seen === 0) {
    // 种子：EMA 双均线与 DEA 均以首根起算（DIF[0] = 0，DEA[0] = 0）。
    emaFast = close;
    emaSlow = close;
    dea = 0;
  } else {
    const kf = 2 / (fast + 1);
    const ks = 2 / (slow + 1);
    emaFast = close * kf + emaFast * (1 - kf);
    emaSlow = close * ks + emaSlow * (1 - ks);
    const ksig = 2 / (sig + 1);
    dea = (emaFast - emaSlow) * ksig + dea * (1 - ksig);
  }
  seen += 1;
  const dif = emaFast - emaSlow;
  const gt = dif > dea;
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
  return { emaFast: emaFast, emaSlow: emaSlow, dea: dea, seen: seen, prevGt: prevGt };
}

// 防御口径（NIT-3）：与 dual_ma/boll 一致——字段缺失/类型错误时回退安全默认
// （= init() 初始值），不得将 undefined 写入状态引入 NaN 污染。
function load(state) {
  const s = state || {};
  emaFast = (typeof s.emaFast === "number") ? s.emaFast : 0;
  emaSlow = (typeof s.emaSlow === "number") ? s.emaSlow : 0;
  dea = (typeof s.dea === "number") ? s.dea : 0;
  seen = (typeof s.seen === "number") ? s.seen : 0;
  prevGt = (s.prevGt === true || s.prevGt === false) ? s.prevGt : null;
}
