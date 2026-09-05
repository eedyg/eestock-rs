// 轻量 SVG 序列作图（页面⑤ 结果区/对比区；不引 echarts 新依赖，参照 TimeshareChart 折衷）。

export interface SvgPoint {
  x: number;
  y: number;
}

/** 把一组值（[ts,val]）映射为 SVG 折线点（x 等距，y 线性映射到 [H-PAD, PAD]）。 */
export function mapLine(
  pts: Array<[number, number]>,
  min: number,
  max: number,
  width: number,
  height: number,
  pad: number,
): SvgPoint[] {
  const span = max - min || 1;
  return pts.map((p, i) => ({
    x: (i / Math.max(pts.length - 1, 1)) * (width - pad * 2) + pad,
    y: height - pad - ((p[1] - min) / span) * (height - pad * 2),
  }));
}

export function lineFrom(points: SvgPoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** 折线下方填充多边形（用于净值曲线面积）。 */
export function areaBelow(points: SvgPoint[], baselineY: number): string {
  if (points.length === 0) return '';
  const top = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${top} ${last.x.toFixed(1)},${baselineY} ${first.x.toFixed(1)},${baselineY}`;
}

/** 等距取样索引（含首尾，去重后升序）用于 x 轴刻度；count 为目标刻度数，n 小时可能少于 count。 */
export function evenTickIndices(n: number, count = 5): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round((i * (n - 1)) / (count - 1)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** 由净值序列派生极值（含 0）；min=数据最小，max=数据最大。 */
export function extentOf(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    return { min: 0, max: 1 };
  }
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}
