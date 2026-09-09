// fixture: infinite_loop —— 超时熔断用例（ABI G2）。
// on_bar 进入死循环，必须由 host 侧 interrupt handler 按 per-call 超时打断。
function on_bar(ctx) {
  while (true) {
    // 永不退出：等待 host interrupt。
  }
}
