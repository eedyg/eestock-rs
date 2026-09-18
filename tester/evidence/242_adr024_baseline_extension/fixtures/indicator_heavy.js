// =============================================================================
// fixture：indicator_heavy —— ADR-024 P1b ③ 的**指标重插件**（负载探针，非交易策略）
// 归属：tester 产出物（`tester/evidence/242_adr024_baseline_extension/fixtures/`）。
// 目的：每 bar 调用 host 注入的 ctx.indicators.macd() / rsi(14) / atr(14) 各一次，
//       量化「指标二次项系数」相对「每 bar 上下文构造 + 历史复制」项的大小，
//       为 P3（指标增量）的必要性与优先级提供判据输入。
// 说明（口径）：
//   - 严格只调 macd()/rsi()/atr() 三个指标各一次，不调 ma/ema/kdj/boll（避免混淆归因）；
//   - host 侧每个指标都从 bar 0 重算（crates/backtest/src/indicators.rs），故每个调用
//     都是 O(index) ⇒ 在改造前（P2 前）共引入 3 个附加二次项；
//   - 无 PARAMS_SCHEMA / 无内部状态（恒返回由指标派生的分数，保证调用不被优化掉）。
// 分数映射与交易语义无关（阈值 60/40 下会成交，但本 fixture 只用于计时）。
// =============================================================================

function on_bar(ctx) {
  const m = ctx.indicators.macd();      // {dif, dea, macd} | null
  const r = ctx.indicators.rsi(14);     // number | null
  const a = ctx.indicators.atr(14);     // number | null
  if (m === null || r === null || a === null) {
    return 50;                          // 数据不足 → 中立（不掩盖调用本身的开销）
  }
  const raw = 50 + m.macd * 10 + (r - 50) * 0.5 + a * 0.1;
  if (raw > 100) { return 100; }
  if (raw < 0) { return 0; }
  return raw;
}
