// =============================================================================
// 官方模板：two_state_gate —— 两态门控模板（ADR §13.2 D10 / ABI §4.5）
// =============================================================================
// 适用场景：只想「开一次仓、持有一段时间、条件变坏就离场」的策略。
// 核心手法（ABI §4.5）：空仓（ctx.position === null）时才给买入区高分；
// 持仓期给中立分——门控逻辑全部编码在「何时给多少分」里，引擎不做任何固定门控。
//
// ctx.position（ABI §2.5，只读持仓全景）：
//   null           → 当前空仓（纯评分试算模式下恒为 null）；
//   { qty, avg_cost, entry_ts, bars_since_entry, unrealized_pnl } → 持仓中。
// 注意：position 是共享组合视角的真实执行结果；插件修改它不会影响任何执行。
//
// 本模板策略：
//   空仓 + 快线 > 慢线 → 80（开门，允许买入）；
//   持仓 + 快线 < 慢线 → 20（趋势变坏，关门离场）；
//   其余 → 50（中立，不动作）。
// 无内部状态（门控完全由 ctx.position 驱动）→ 无需 save()/load()。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5, min: 2, max: 200, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" }
];

function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  if (fast === null || slow === null) {
    return 50; // 数据不足 → 中立
  }
  const trendUp = fast > slow;
  if (ctx.position === null) {
    // 空仓：趋势向上才开门（买入区高分）。
    return trendUp ? 80 : 50;
  }
  // 持仓：趋势走坏给卖出区低分（离场），否则中立（继续持有）。
  return trendUp ? 50 : 20;
}
