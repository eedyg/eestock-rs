// =============================================================================
// dca_baseline —— 无脑定期定额（DCA Family #0：对照组，不是策略）
// 设计文档：design/01-dca-strategy-family.md §4.4
// =============================================================================
// 作用：**判断三个候选定投策略是否真有价值的唯一标尺。**
// 没有它，任何收益数字都无法解释——你不知道改善来自择时，还是来自市场本身。
//
// 逻辑：每 cadence 根 bar 到期投一期，窗口 plan_bars 内保持买入区，
//       不读任何指标、不做任何判断。
//
// 无内部状态（节奏由 ctx.index 算术导出）→ 无需 save()/load()。
// =============================================================================

const PARAMS_SCHEMA = [
  { key: "cadence", type: "int", default: 20, min: 1, max: 250, description: "定投周期（bar 数）" },
  { key: "plan_bars", type: "int", default: 5, min: 1, max: 120, description: "买入区保持窗口（bar 数）" }
];

function on_bar(ctx) {
  const p = ctx.params;
  const idx = ctx.index;
  const since = idx - Math.floor(idx / p.cadence) * p.cadence;
  return since < p.plan_bars ? 75 : 50;
}
