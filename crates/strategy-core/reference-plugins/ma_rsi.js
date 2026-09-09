// =============================================================================
// 参考插件：ma_rsi —— 均线交叉 + RSI 超买/超卖过滤
// 迁移自 Rust 内建策略 crates/backtest/src/strategies.rs::MaRsiStrategy（语义 1:1）。
// =============================================================================
//
// 评分映射口径（架构裁决，ADR §6/§13.1）：Buy→80 / Sell→20 / Hold→50。
//   等价性依据：默认聚合阈 60/40 下 80≥60 即 Buy、20≤40 即 Sell、50 即 Hold，
//   与 Rust 版 Signal 逐 bar 一一对应（守门测试：tests/equivalence.rs）。
//
// 仓位说明：不含 position_pct——仓位换算是 ExecutionPolicy 职责（ADR §13.1），
//   插件只产评分。
//
// 语义注记（与 Rust 版逐条对齐）：
//   - 金叉（快线上穿慢线）且 RSI < 超买线 → Buy；死叉且 RSI > 超卖线 → Sell。
//   - RSI 数据不足（null）按「通过」处理（对应 Rust 的 is_none_or / map_or(true)）。
//   - 快/慢均线任一不可用（null）→ 中立 50 且不更新 prev 状态。
//
// 内部状态（ABI G3）：prevAbove 模块级变量，经 save()/load() 快照/恢复。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5, min: 2, max: 200, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" },
  { key: "rsi_period", type: "int", default: 14, min: 2, max: 60, description: "RSI 周期" },
  { key: "rsi_oversold", type: "float", default: 30, min: 10, max: 50, description: "RSI 超卖线" },
  { key: "rsi_overbought", type: "float", default: 70, min: 50, max: 90, description: "RSI 超买线" }
];

// 上一有效 bar 的「快线 > 慢线」状态；null = 尚无有效读数。
let prevAbove = null;

function init(params) {
  prevAbove = null;
}

function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  const rsi = ctx.indicators.rsi(ctx.params.rsi_period);
  if (fast === null || slow === null) {
    return 50; // 数据不足：中立，且不更新 prev
  }
  const above = fast > slow;
  let score = 50;
  if (prevAbove !== null) {
    if (above && !prevAbove) {
      // 金叉：RSI 未进入超买才 Buy；RSI 不足（null）按通过处理。
      if (rsi === null || rsi < ctx.params.rsi_overbought) {
        score = 80;
      }
    } else if (!above && prevAbove) {
      // 死叉：RSI 未进入超卖才 Sell；RSI 不足（null）按通过处理。
      if (rsi === null || rsi > ctx.params.rsi_oversold) {
        score = 20;
      }
    }
  }
  prevAbove = above;
  return score;
}

function save() {
  return { prevAbove: prevAbove };
}

function load(state) {
  prevAbove = (state && (state.prevAbove === true || state.prevAbove === false))
    ? state.prevAbove
    : null;
}
