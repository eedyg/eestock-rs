// =============================================================================
// 参考插件：momentum —— 动量突破（Donchian 通道）
// 迁移自 Rust 内建策略 crates/backtest/src/strategies.rs::MomentumStrategy（语义 1:1）。
// =============================================================================
//
// 评分映射口径（架构裁决，ADR §6/§13.1）：Buy→80 / Sell→20 / Hold→50。
//   等价性依据：默认聚合阈 60/40 下 80≥60 即 Buy、20≤40 即 Sell、50 即 Hold
//   （守门测试：tests/equivalence.rs）。
//
// 仓位说明：不含 position_pct——仓位换算是 ExecutionPolicy 职责（ADR §13.1）。
//
// 语义注记（与 Rust 版逐条对齐）：
//   - Donchian 上/下轨 = **当前 bar 之前** lookback 根 bar 的最高 high / 最低 low
//     （**不含当前 bar**，避免 close 恒 ≤ 当前 high 造成的自破位；Rust 模块头口径注记）；
//     无对应 host 指标，插件自持固定长度滚动窗口（与 Rust 的 VecDeque 一致）。
//   - 窗口未满 lookback 根 → 中立 50。
//   - close > 上轨 → Buy；close < 下轨 → Sell（即使空仓也发出 Sell 信号，
//     与 Rust 一致；是否成交由引擎按持仓决定）。
//   - 窗口在信号判定**之后**推入当前 bar（Rust 同序）。
//
// 内部状态（ABI G3）：highs/lows 滚动窗，经 save()/load() 快照/恢复。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "lookback", type: "int", default: 20, min: 2, max: 150, description: "回看日数" }
];

let highs = []; // 最近 lookback 根 high（不含当前 bar）
let lows = [];  // 最近 lookback 根 low（不含当前 bar）

function init(params) {
  highs = [];
  lows = [];
}

function on_bar(ctx) {
  const lb = ctx.params.lookback;
  let score = 50;
  if (highs.length === lb) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let i = 0; i < highs.length; i++) {
      if (highs[i] > hh) { hh = highs[i]; }
      if (lows[i] < ll) { ll = lows[i]; }
    }
    if (ctx.bar.close > hh) {
      score = 80; // 突破上轨 → Buy
    } else if (ctx.bar.close < ll) {
      score = 20; // 跌破下轨 → Sell
    }
  }
  // 信号判定之后推入当前 bar（Rust 同序），窗口超长则弹出最旧一根。
  highs.push(ctx.bar.high);
  lows.push(ctx.bar.low);
  if (highs.length > lb) {
    highs.shift();
    lows.shift();
  }
  return score;
}

function save() {
  return { highs: highs.slice(), lows: lows.slice() };
}

// 防御口径（NIT-3）：与 dual_ma/boll 一致——字段缺失/类型错误时回退安全默认
// （= init() 初始值），不得将 undefined 写入状态引入 NaN 污染。
function load(state) {
  const s = state || {};
  highs = Array.isArray(s.highs) ? s.highs.slice() : [];
  lows = Array.isArray(s.lows) ? s.lows.slice() : [];
}
