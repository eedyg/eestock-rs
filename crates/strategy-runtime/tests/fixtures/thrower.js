// fixture: thrower —— 异常隔离用例。
// 在指定 bar（index === 2）抛出异常，其余 bar 返回中立分 50（ABI G5）。
function on_bar(ctx) {
  if (ctx.index === 2) {
    throw new Error("boom at bar 2");
  }
  return 50;
}
