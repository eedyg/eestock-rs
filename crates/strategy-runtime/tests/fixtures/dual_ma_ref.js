// fixture: dual_ma_ref —— 确定性双跑用例 + PARAMS_SCHEMA 提取用例。
// 语义对齐 backtest 双均线策略的评分口径：快线 > 慢线 → 80（买入区），否则 30（卖出区）；
// 数据不足（指标返回 null）→ 中立分 50。指标由 host 侧计算（复用 backtest::Indicators）。
const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5, min: 1, max: 250, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" },
  { key: "weight_hint", type: "float", default: 1.0, description: "建议聚合权重（仅提示）" }
];

function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  if (fast === null || slow === null) {
    return 50;
  }
  return fast > slow ? 80 : 30;
}
