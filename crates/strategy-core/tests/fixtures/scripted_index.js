// fixture: scripted_index —— 按 bar 序号脚本化评分（DCA 批次序列测试用）。
// index < params.buy_below → 80（Buy 区）；否则 50（Hold 区）。
const PARAMS_SCHEMA = [
  { key: "buy_below", type: "int", default: 4, min: 0, max: 100000, description: "index 小于该值时给买入区高分" }
];
function on_bar(ctx) {
  return ctx.index < ctx.params.buy_below ? 80 : 50;
}
