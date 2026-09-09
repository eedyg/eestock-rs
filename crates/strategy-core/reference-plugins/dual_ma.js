// =============================================================================
// 参考插件：dual_ma —— 双均线交叉
// 迁移自 Rust 内建策略 crates/backtest/src/strategies.rs::DualMaStrategy（语义 1:1）。
// =============================================================================
//
// 评分映射口径（架构裁决，ADR §6/§13.1）：插件内部复刻 Rust 信号逻辑，
//   输出分数 Buy→80 / Sell→20 / Hold→50。等价性依据：默认聚合阈 60/40 下
//   80≥60 即聚合 Buy、20≤40 即聚合 Sell、50 居中即 Hold，
//   与 Rust 版 Signal::Buy/Sell/Hold 逐 bar 一一对应（守门测试：tests/equivalence.rs）。
//
// 仓位说明：不含 position_pct 参数——仓位换算是 ExecutionPolicy 职责
//   （ADR §13.1 决策/执行分层），插件只产评分；Rust 版 Signal::Buy(pct) 的 pct
//   在此映射为固定买入区高分 80。
//
// 语义注记（与 Rust 版逐条对齐）：
//   - 金叉定义：fast_ma > slow_ma 且上一有效 bar fast_ma <= slow_ma（严格大于）；
//     死叉反之。
//   - prev 状态仅当快/慢均线均可用（非 null）时更新；数据不足（指标 null）
//     → 中立分 50 且不更新 prev（对应 Rust 的 prev_above: Option<bool> 口径）。
//
// 内部状态（ABI G3）：prevAbove 模块级变量，经 save()/load() 快照/恢复。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5, min: 2, max: 200, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" }
];

// 上一有效 bar 的「快线 > 慢线」状态；null = 尚无有效读数（对应 Rust None）。
let prevAbove = null;

function init(params) {
  prevAbove = null;
}

function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  if (fast === null || slow === null) {
    return 50; // 数据不足：中立，且不更新 prev
  }
  const above = fast > slow;
  let score = 50;
  if (prevAbove !== null) {
    if (above && !prevAbove) {
      score = 80; // 金叉 → Buy
    } else if (!above && prevAbove) {
      score = 20; // 死叉 → Sell
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
