// fixture: constant_score —— 恒分插件（确定性/异常隔离用例的对照组）。
// 无论输入如何恒返回 42，不读任何指标/持仓。
function on_bar(ctx) {
  ctx.log("constant_score bar " + ctx.index);
  return 42;
}
