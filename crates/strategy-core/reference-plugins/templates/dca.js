// =============================================================================
// 官方模板：dca —— 定投模板（ADR §13.2 D10 / ABI §4.5）
// =============================================================================
// 适用场景：分批建仓（定投式）。请配合 ExecutionPolicy = Dca（tranches/interval）
// 使用——**分批换算是 Policy 的职责**，插件只需控制「何时保持在买入区」。
//
// 与 DCA Policy 的协作口径（ADR §13.1）：
//   - Buy 信号（聚合 ≥ 60）持续期间，Policy 每 interval bar 执行一批，共 tranches 批；
//   - 信号中断（Hold/Sell）→ 剩余批次取消；Buy 重现 → 重新计数。
//   因此插件的典型写法：空仓且触发条件满足 → 给 80 开启本轮；随后用
//   ctx.position.bars_since_entry（建仓以来经过的 bar 数）控制高分持续的窗口，
//   窗口结束回到 50（中立），让 Policy 停止后续批次。
//
// 本模板策略：
//   空仓 + 收盘低于慢速均线（回踩）→ 80（开启一轮定投）；
//   持仓且 bars_since_entry < plan_bars → 继续 80（让 Policy 把批次打完）；
//   达到计划窗口 → 50（中立，停止加仓）；趋势深跌可改为 20 离场（留作练习）。
// 无内部状态（节奏由 ctx.position 驱动）→ 无需 save()/load()。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "slow", type: "int", default: 20, min: 2, max: 250, description: "慢线周期（回踩判定基准）" },
  { key: "plan_bars", type: "int", default: 3, min: 1, max: 60, description: "计划加仓窗口（bar 数，应与 DCA Policy 的 tranches×interval 对齐）" }
];

function on_bar(ctx) {
  const slow = ctx.indicators.ma(ctx.params.slow);
  if (slow === null) {
    return 50; // 数据不足 → 中立
  }
  if (ctx.position === null) {
    // 空仓：价格回踩慢线下方 → 开启一轮定投（买入区高分）。
    return ctx.bar.close < slow ? 80 : 50;
  }
  // 持仓：计划窗口内保持买入区高分（Policy 按 interval 逐批执行），窗口外中立。
  return ctx.position.bars_since_entry < ctx.params.plan_bars ? 80 : 50;
}
