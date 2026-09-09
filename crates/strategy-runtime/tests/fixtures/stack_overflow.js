// fixture: stack_overflow —— 栈深递归用例（ABI §5）。
// 深递归必须被引擎内部栈限制打断（实测 QuickJS 抛 RangeError
// "Maximum call stack size exceeded"），宿主归类 JsException，宿主进程不得崩溃。
function dive(n) {
  return dive(n + 1) + 1;
}

function on_bar(ctx) {
  return dive(0);
}
