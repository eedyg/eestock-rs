// 基线用：买入持有（恒定买入区高分；LumpSum 满仓后重复买信号无副作用，末日 ForceClose 由引擎处理）。
// 仅用于基线测量，非交付策略。
function on_bar(ctx) {
  return 80;
}
