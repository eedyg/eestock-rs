// fixture: position_gate —— 简单门控插件（ABI §2.5 ctx.position 验证 + 买卖闭环用）。
// 空仓（position 为 null）→ 买入区高分 80；持仓中 → 卖出区低分 20。
function on_bar(ctx) {
  return ctx.position === null ? 80 : 20;
}
