// fixture: constant_score —— 恒分插件（引擎端到端/确定性双跑用）。
// 分数经 params.score 配置（默认 42），便于脚本化驱动 Buy/Sell/Hold 信号。
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 42, min: 0, max: 100, description: "恒定评分" }
];
function on_bar(ctx) {
  return ctx.params.score;
}
