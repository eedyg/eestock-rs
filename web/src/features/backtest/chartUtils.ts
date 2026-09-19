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

/**
 * 把一组 `[ts,val]` 点按**共享窗口 ts 定义域**映射为 SVG 折线点（ADR-028 D2.1，**并列新增**）。
 *
 * 与 {@link mapLine} 的区别（**`mapLine` 语义/调用点一律不动**：`AggregateScoreChart` /
 * `EquityDrawdownChart` / `ComparePanel`，F23）：
 * - x 由 **ts 线性映射**（`mapLine` 的 x 是**数组下标**等距铺满 ⇒ 时间轴失真，ADR-028 F21）；
 * - 定义域是**共享窗口** `[domainFrom, domainTo]`（**禁止**用数据自身 min/max，D2.1 明文）。
 *
 * 边界语义（显式、可断言）：
 * - 定义域退化（`domainTo <= domainFrom` 或非有限）⇒ 全部 x = pad（不除零、不静默跳变）；
 * - 定义域外的点按线性外推（**不钳位**）：调用方必须传「窗口内取数」的点，钳位会掩盖取数口径错误。
 */
export function mapLineByTs(
  pts: Array<[number, number]>,
  domainFrom: number,
  domainTo: number,
  min: number,
  max: number,
  width: number,
  height: number,
  pad: number,
): SvgPoint[] {
  const span = max - min || 1;
  const dSpan = domainTo - domainFrom;
  const plotW = width - pad * 2;
  return pts.map((p) => ({
    x: Number.isFinite(dSpan) && dSpan > 0 ? pad + ((p[0] - domainFrom) / dSpan) * plotW : pad,
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
