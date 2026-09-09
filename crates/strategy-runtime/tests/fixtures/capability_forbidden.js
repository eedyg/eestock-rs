// fixture: capability_forbidden —— 能力禁区用例（ABI G1）。
// 引用被禁用的 Date 全局对象：沙箱内 Date 不存在，引用即 ReferenceError，按插件异常处理。
function on_bar(ctx) {
  return Date.now() > 0 ? 10 : 20;
}
