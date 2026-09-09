// fixture: stateful_counter —— 状态 round-trip 用例。
// 内部计数器每 bar +1，分数即计数；save/load 导出/恢复计数器（JSON round-trip，ABI G3）。
let count = 0;

function init(params) {
  if (typeof params.start === "number") {
    count = params.start;
  }
}

function on_bar(ctx) {
  count += 1;
  return count;
}

function save() {
  return { count: count };
}

function load(state) {
  count = state.count;
}
