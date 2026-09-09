// =============================================================================
// 官方模板：trend_stop —— 趋势 + 止损模板（ADR §13.2 D10 / ABI §4.5）
// =============================================================================
// 适用场景：趋势跟随 + 软止损。演示三层止损中的「策略层（软止损）」（ADR §13.3）：
// 持仓亏损超过 stop_pct 时输出 0 分——强卖出区分数，把聚合总分拖过卖出阈。
//
// 软止损 vs 硬止损（重要口径）：
//   - 本模板的 0 分是**软止损**：它只是评分，可被执行层费用口径影响、
//     也可在组合回测中被其他策略的高分对冲（聚合是加权平均）。
//   - **硬止损**在 Run 级 stop 配置（fixed_pct/trailing/atr），触发即绕过评分
//     直接平仓，不依赖策略自觉。需要确定性保护时请用硬止损。
//
// 本模板策略：
//   持仓且 close < avg_cost × (1 − stop_pct) → 0（软止损，拖低总分至卖出区）；
//   快线 > 慢线 → 80（买入区）；快线 < 慢线 → 20（卖出区）；数据不足 → 50。
// 无内部状态 → 无需 save()/load()。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5, min: 2, max: 200, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" },
  { key: "stop_pct", type: "float", default: 0.08, min: 0.01, max: 0.5, description: "软止损幅度（相对摊薄成本价，0.08 = 8%）" }
];

function on_bar(ctx) {
  // 软止损：持仓浮亏越线 → 0 分（强卖出区；单策略 60/40 阈下必然触发卖出信号）。
  if (ctx.position !== null &&
      ctx.bar.close < ctx.position.avg_cost * (1 - ctx.params.stop_pct)) {
    return 0;
  }
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  if (fast === null || slow === null) {
    return 50; // 数据不足 → 中立
  }
  return fast > slow ? 80 : 20;
}
