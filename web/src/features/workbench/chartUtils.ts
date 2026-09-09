// 页面⑪ 图表工具：复用页面⑤ 轻量 SVG 作图（不引新图表依赖，参照 09-frontend 折衷）。
export { areaBelow, evenTickIndices, extentOf, lineFrom, mapLine } from '@/features/backtest/chartUtils';
export type { SvgPoint } from '@/features/backtest/chartUtils';

/** 图表折线抽样上限（ADR §13.4：per_bar 全量落库，UI 端抽样渲染——分钟级 3 个月 ~3.7 万点，
 *  D1 5 年 ~1200 点；>2000 点的序列均匀抽样，首尾必保留保证区间端点不漂移）。 */
export const CHART_MAX_POINTS = 2000;

/** 均匀降采样（含首尾，升序保持）；n ≤ maxPoints 原样返回。 */
export function downsample<T>(pts: T[], maxPoints = CHART_MAX_POINTS): T[] {
  if (pts.length <= maxPoints) return pts;
  if (maxPoints <= 0) return [];
  if (maxPoints === 1) return [pts[0]!];
  const step = (pts.length - 1) / (maxPoints - 1);
  const out: T[] = [];
  let prev = -1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    if (idx > prev) {
      out.push(pts[idx]!);
      prev = idx;
    }
  }
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]!);
  return out;
}
