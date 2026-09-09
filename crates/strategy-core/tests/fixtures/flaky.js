// fixture: flaky —— 周期性抛错插件（G5 连续错误计数「成功即清零」验证用）。
// 每 3 个 bar 抛一次错（index % 3 === 2），其余 bar 返回 60。
function on_bar(ctx) {
  if (ctx.index % 3 === 2) {
    throw new Error("boom@" + ctx.index);
  }
  return 60;
}
