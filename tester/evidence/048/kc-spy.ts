/**
 * 验收车道（tester 阶段 3）独立 harness 的 klinecharts spy。
 * 仅存在于 /tmp 沙箱；通过临时 vite resolve.alias 生效（不改仓库任何文件）。
 * 目的：抓取 init() 返回的 Chart 实例 → 暴露 window.__CHARTS__，供 Playwright 侧调用公开 API
 * （getPaneOptions / getIndicators / getSeparatorPanes / convertToPixel / getYAxes）。
 */
import * as real from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

interface W {
  __CHARTS__?: unknown[];
  __INIT_CALLS__?: number;
}
const w = window as unknown as W;
if (!Array.isArray(w.__CHARTS__)) w.__CHARTS__ = [];
if (typeof w.__INIT_CALLS__ !== 'number') w.__INIT_CALLS__ = 0;

export function init(...args: unknown[]): unknown {
  const chart = (real as unknown as { init: (...a: unknown[]) => unknown }).init(...args);
  w.__CHARTS__!.push(chart);
  w.__INIT_CALLS__ = (w.__INIT_CALLS__ ?? 0) + 1;
  return chart;
}
