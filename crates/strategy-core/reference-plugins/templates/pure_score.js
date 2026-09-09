// =============================================================================
// 官方模板：pure_score —— 纯评分模板（ADR §13.2 D10 / ABI §4.5）
// =============================================================================
// 适用场景：最小编写起点。不读 ctx.position、无内部状态，只根据指标输出分数。
//
// 插件契约速览（权威：design/12-strategy-system/02-plugin-abi.md）：
//   - on_bar(ctx) 每 bar 调用一次，返回 0-100 连续分（越界由 host clamp）。
//   - 默认聚合阈值：总分 ≥ 60 → 买入信号；≤ 40 → 卖出信号；其余 → 持有。
//     所以「买入区」惯例给 80，「卖出区」惯例给 20，中立给 50。
//   - ctx.indicators 由 host 侧确定性计算（与 Rust 回测口径一致）；
//     数据不足返回 null，策略必须自行判空（否则 null 参与比较会得到意外结果）。
//   - ctx.params 为下方 PARAMS_SCHEMA 声明的参数（已由消费方填好默认值，只读冻结）。
//   - 插件只产评分，永远看不到订单/账户接口；仓位换算由 ExecutionPolicy 负责。
//
// 本模板策略：快均线上穿慢均线区间给 80（买入区），下穿区间给 20（卖出区），
// 数据不足给 50（中立）。无内部状态 → 无需实现 save()/load()。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "fast", type: "int", default: 5, min: 2, max: 200, description: "快线周期" },
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期" }
];

function on_bar(ctx) {
  const fast = ctx.indicators.ma(ctx.params.fast);
  const slow = ctx.indicators.ma(ctx.params.slow);
  // 数据不足（指标 null）→ 中立分：不表达观点。
  if (fast === null || slow === null) {
    return 50;
  }
  // 趋势上行 → 买入区高分；下行 → 卖出区低分。
  return fast > slow ? 80 : 20;
}
