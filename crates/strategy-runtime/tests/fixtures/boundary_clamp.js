// fixture: boundary_clamp —— 越界 clamp 用例（ABI G6）。
// index 0 → -5（clamp 到 0）；index 1 → 150（clamp 到 100）；
// index 2 → NaN（非有限数值，按异常处理）；其余 → 60（界内原样通过）。
function on_bar(ctx) {
  if (ctx.index === 0) {
    return -5;
  }
  if (ctx.index === 1) {
    return 150;
  }
  if (ctx.index === 2) {
    return NaN;
  }
  return 60;
}
