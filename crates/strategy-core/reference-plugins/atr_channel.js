// =============================================================================
// 参考插件：atr_channel —— ATR 通道突破（Donchian 通道 + ATR 止损）
// 迁移自 Rust 内建策略 crates/backtest/src/strategies.rs::AtrChannelStrategy（语义 1:1）。
// =============================================================================
//
// 评分映射口径（架构裁决，ADR §6/§13.1）：Buy→80 / Sell→20 / Hold→50。
//   等价性依据：默认聚合阈 60/40 下 80≥60 即 Buy、20≤40 即 Sell、50 即 Hold
//   （守门测试：tests/equivalence.rs）。
//
// 仓位说明：不含 position_pct——仓位换算是 ExecutionPolicy 职责（ADR §13.1）。
//
// 语义注记（与 Rust 版逐条对齐）：
//   - Donchian 上/下轨 = **当前 bar 之前** channel_period 根 bar 的最高 high /
//     最低 low（**不含当前 bar**，Rust 模块头口径注记）；无对应 host 指标，
//     插件自持固定长度滚动窗口。
//   - 空仓判定用 ctx.position === null（对应 Rust 的 ctx.position > 0.0；
//     ABI §2.5：空仓时 host 给 null）。
//   - 空仓且 close 破上轨 → Buy，并记录 **entry = 自身 Buy 信号当根 close**
//     （插件内部状态记录，**不用 ctx.position.avg_cost**——口径注记：Rust 版
//     同样取信号 bar close 的近似值，实际成交在下一 open）。
//   - 持仓时 ATR 止损**优先**：close < entry − atr_multiplier × ATR(atr_period)
//     → Sell 并清空 entry；ATR 数据不足（null）→ 该 bar 不触发止损（Rust 同口径）。
//   - 止损未触发且 close 跌破通道下轨 → Sell（通道离场）并清空 entry。
//   - 窗口在信号判定**之后**推入当前 bar（Rust 同序）。
//
// 内部状态（ABI G3）：highs/lows 滚动窗 + entry，经 save()/load() 快照/恢复。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "channel_period", type: "int", default: 20, min: 2, max: 150, description: "通道周期" },
  { key: "atr_period", type: "int", default: 14, min: 2, max: 60, description: "ATR 周期" },
  { key: "atr_multiplier", type: "float", default: 1.0, min: 0.5, max: 5.0, description: "ATR 止损倍数" }
];

let highs = [];   // 最近 channel_period 根 high（不含当前 bar）
let lows = [];    // 最近 channel_period 根 low（不含当前 bar）
let entry = null; // 自身 Buy 信号当根 close（止损基准）；null = 无未平仓信号

function init(params) {
  highs = [];
  lows = [];
  entry = null;
}

function on_bar(ctx) {
  const cp = ctx.params.channel_period;
  const ready = highs.length === cp;
  let upper = -Infinity;
  let lower = Infinity;
  if (ready) {
    for (let i = 0; i < highs.length; i++) {
      if (highs[i] > upper) { upper = highs[i]; }
      if (lows[i] < lower) { lower = lows[i]; }
    }
  }

  let score = 50;
  const holding = ctx.position !== null;
  if (holding) {
    // ATR 止损优先（数据不足则不触发，Rust 同口径）。
    const a = ctx.indicators.atr(ctx.params.atr_period);
    if (a !== null && entry !== null &&
        ctx.bar.close < entry - ctx.params.atr_multiplier * a) {
      entry = null;
      score = 20;
    }
    // 通道下轨跌破 → 离场。
    if (score === 50 && ready && ctx.bar.close < lower) {
      entry = null;
      score = 20;
    }
  } else if (ready && ctx.bar.close > upper) {
    // 空仓 + 突破上轨 → Buy；entry 记当根 close（近似口径，见头注释）。
    entry = ctx.bar.close;
    score = 80;
  }

  // 信号判定之后推入当前 bar（Rust 同序），供下一根的通道计算。
  highs.push(ctx.bar.high);
  lows.push(ctx.bar.low);
  if (highs.length > cp) {
    highs.shift();
    lows.shift();
  }
  return score;
}

function save() {
  return { highs: highs.slice(), lows: lows.slice(), entry: entry };
}

// 防御口径（NIT-3）：与 dual_ma/boll 一致——字段缺失/类型错误时回退安全默认
// （= init() 初始值），不得将 undefined 写入状态引入 NaN 污染。
function load(state) {
  const s = state || {};
  highs = Array.isArray(s.highs) ? s.highs.slice() : [];
  lows = Array.isArray(s.lows) ? s.lows.slice() : [];
  entry = (typeof s.entry === "number") ? s.entry : null;
}
