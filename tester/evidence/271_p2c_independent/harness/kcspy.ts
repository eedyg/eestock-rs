/**
 * klinecharts 间谍包装（P2-C 独立验收临时 harness；**不进仓库**）。
 * 通过 vite alias 把 `klinecharts` 指向本文件 ⇒ 捕获每个 `init(el)` 返回的真实 chart 实例，
 * 并记录其宿主（卫星 period / 基准 host 标签），用于逐实例 getIndicators / getPaneOptions 取证。
 */
import * as real from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

// 星号再导出全部真实 API（本地声明的 init 覆盖之）
export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

const W = window as any;
W.__charts = W.__charts || [];

export function init(el: any, options?: any) {
  const chart = (real as any).init(el, options);
  let host: string | null = null;
  try {
    const sat = el?.closest?.('[data-mp-satellite]');
    const base = el?.closest?.('[data-host]');
    host = sat ? 'sat:' + sat.getAttribute('data-mp-satellite') : base ? 'base:' + base.getAttribute('data-host') : null;
  } catch { /* ignore */ }
  W.__charts.push({ el, chart, host });
  return chart;
}

export function dispose(chart: any) {
  try {
    const i = W.__charts.findIndex((c: any) => c.chart === chart);
    if (i >= 0) W.__charts.splice(i, 1);
  } catch { /* ignore */ }
  return (real as any).dispose(chart);
}
