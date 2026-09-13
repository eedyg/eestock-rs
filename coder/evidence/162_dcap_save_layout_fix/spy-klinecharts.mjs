/** 真渲染探针：包装真实 klinecharts 10.0.3（**仅**记录 init 计数与实例引用；行为零改动）。
 *  别名 'klinecharts' → 本文件（构建期），故被测组件代码逐字节不变。 */
import * as KC from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

const realInit = KC.init;
export function init(...args) {
  const chart = realInit(...args);
  globalThis.__KC_INITS__ = (globalThis.__KC_INITS__ ?? 0) + 1;
  (globalThis.__CHARTS__ ??= []).push(chart);
  return chart;
}
