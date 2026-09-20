// 页面⑪ 图表工具：复用页面⑤ 轻量 SVG 作图（不引新图表依赖，参照 09-frontend 折衷）。
// ADR-028 D2.1：`mapLineByTs`（按共享窗口 ts 定义域映射 x）与 `mapLine` 并列导出；
// `mapLine` 语义与 3 个既有调用点保持不变。
import { curveXs, type CurveXDomain } from '@/features/backtest/chartUtils';

export {
  areaBelow,
  curveDomainAttr,
  curvePlotViewBox,
  curveXs,
  evenTickIndices,
  extentOf,
  lineFrom,
  mapLine,
  mapLineByDomain,
  mapLineByTs,
  resolveCurveX,
} from '@/features/backtest/chartUtils';
export type {
  CurveIndexDomain,
  CurvePlotInput,
  CurveTsDomain,
  CurveXDomain,
  CurveXs,
  SvgPoint,
} from '@/features/backtest/chartUtils';

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

/**
 * ADR-028 D4.1 ④：曲线视图的**竖线标记** x 坐标（与曲线**同一** x 定义域/几何 ⇒ 同一时点在各视图同位）。
 * 定义域不可得（`null`）或该 ts 无对应槽位（index 模式查不到）⇒ `null`（不画，不钳位）。
 */
export function vlineX(
  ts: number | null | undefined,
  d: CurveXDomain | null,
  width = 1000,
  pad = 10,
): number | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  const xs = curveXs([ts], d, width, pad).xs[0];
  return xs ?? null;
}
