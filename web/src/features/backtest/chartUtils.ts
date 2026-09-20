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

// ───────────────────────── ADR-028 D2.1 / D2.3：曲线 x 定义域（主路 = bar 索引空间） ─────────────────────────

/**
 * 曲线 x 定义域（ADR-028 D2.1 第 2/4 条）：
 * - `index`（**主路**）：ts 先经「K 线所绘制的**同一 bar 序列**」（{@link CurveIndexDomain.barTs}）
 *   查最近邻得 bar 索引，再以**索引线性**映射到 plot ⇒ 与 K 线的「每 bar 一槽（缺口折叠）」同轴。
 * - `ts`（**降级**）：ts 线性映射（查表不可得时的兜底路径；调用方**必须**显式标注降级，禁静默）。
 */
export interface CurveIndexDomain {
  mode: 'index';
  /** K 线所绘制的 bar 的 ts（Unix 秒，**升序**；索引 i ⇒ `barTs[i]`）。 */
  barTs: readonly number[];
  /**
   * ts 与 bar 的配对容差（秒）：真身 per_bar ts 与 K 线 bar ts 可差数秒（实测 ~4s，两根时间轴口径不同）
   * ⇒ 取**最近邻**；`|Δ| > toleranceSec` 视为「该点不属于 K 线 bar 序列」⇒ 剔除（禁钳位到最近槽）。
   */
  toleranceSec: number;
}

/** ts 线性降级定义域（ADR-028 D2.1 第 4 条：仅兜底，且必须显式标注）。 */
export interface CurveTsDomain {
  mode: 'ts';
  from_ts: number;
  to_ts: number;
}

export type CurveXDomain = CurveIndexDomain | CurveTsDomain;

/** {@link curveXs} 结果：`xs[i] === null` ⇒ 该点无对应槽位（调用方须**断线跳过**，不得钳位）。 */
export interface CurveXs {
  xs: Array<number | null>;
  /** 被剔除的点数（>0 ⇒ 调用方应显式披露「N 个点未落在 K 线 bar 序列上」）。 */
  unmatched: number;
}

/**
 * ts 序列 → SVG user-unit x（plot 区间 `[pad, width-pad]`）。
 *
 * - `index`（主路）：最近邻查表（单调游标，O(n+m)）⇒ `x = pad + idx/(n-1) * plotW`；
 * - `ts`（降级）：`x = pad + (ts - from)/(to - from) * plotW`（定义域退化 ⇒ 全 pad，不除零）；
 * - `null`（无定义域）：**全部剔除**（ADR-028 D2.2：禁止回退到「数据自身 min/max 扇伸满框」）。
 */
export function curveXs(
  tsList: readonly number[],
  d: CurveXDomain | null,
  width: number,
  pad: number,
): CurveXs {
  const xs: Array<number | null> = tsList.map(() => null);
  if (tsList.length === 0) return { xs, unmatched: 0 };
  if (!d) return { xs, unmatched: tsList.length };
  const plotW = width - pad * 2;
  if (d.mode === 'ts') {
    const span = d.to_ts - d.from_ts;
    const ok = Number.isFinite(span) && span > 0;
    for (let i = 0; i < tsList.length; i++) {
      xs[i] = ok && Number.isFinite(tsList[i]) ? pad + ((tsList[i]! - d.from_ts) / span) * plotW : pad;
    }
    return { xs, unmatched: 0 };
  }
  const bars = d.barTs;
  if (bars.length === 0) return { xs, unmatched: tsList.length };
  const tol = Number.isFinite(d.toleranceSec) && d.toleranceSec > 0 ? d.toleranceSec : 0;
  const denom = Math.max(bars.length - 1, 1);
  let j = 0;
  let unmatched = 0;
  for (let i = 0; i < tsList.length; i++) {
    const t = tsList[i]!;
    if (!Number.isFinite(t)) {
      unmatched += 1;
      continue;
    }
    while (j + 1 < bars.length && Math.abs(bars[j + 1]! - t) <= Math.abs(bars[j]! - t)) j += 1;
    if (Math.abs(bars[j]! - t) > tol) {
      unmatched += 1;
      continue;
    }
    xs[i] = pad + (j / denom) * plotW;
  }
  return { xs, unmatched };
}

/**
 * `[ts,val]` 点集 → SVG 折线点（x 按 {@link curveXs}；y 与 `mapLine` 同口径：max ⇒ 上边、min ⇒ 下边）。
 * 无对应槽位的点被**跳过**（折线在该处断开），不钳位、不外推。
 */
export function mapLineByDomain(
  pts: Array<[number, number]>,
  d: CurveXDomain | null,
  min: number,
  max: number,
  width: number,
  height: number,
  pad: number,
): { points: SvgPoint[]; unmatched: number } {
  const { xs, unmatched } = curveXs(
    pts.map((p) => p[0]),
    d,
    width,
    pad,
  );
  const span = max - min || 1;
  const out: SvgPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const x = xs[i];
    if (x == null) continue;
    out.push({ x, y: height - pad - ((pts[i]![1] - min) / span) * (height - pad * 2) });
  }
  return { points: out, unmatched };
}

/** {@link curvePlotViewBox} 输入：K 线真身绘图区几何（同一渲染帧读出）。 */
export interface CurvePlotInput {
  /** K 线每槽像素宽（`getBarSpace().bar`）。 */
  barSpacePx: number;
  /** 窗口**首根 bar** 的绘图区局部像素 x（K 线 `convertToPixel({timestamp})`）。 */
  xFromPx: number;
  /** K 线容器宽（px，`getSize().width`）——曲线 SVG 与其同宽时可直接换算。 */
  chartWidthPx: number;
  /** 窗口根数（= bar 序列长度）。 */
  slots: number;
}

/**
 * ADR-028 D2.3-4（「共用绘图区几何 insets」）：给出 svg `viewBox` 的 x 起点/宽度，使曲线 plot
 * `[pad, width-pad]` 与 K 线的 `xFromPx + i*barSpacePx` **落在同一屏幕像素** ⇒ 同一 bar 索引在
 * 两图上的 x 偏差 = 0（消除曲线右端「固定少 1 根」这类几何错位）。
 *
 * 几何不可得（槽宽/容器宽非正、根数 < 2、非有限）⇒ `null`（降级：曲线独立几何，viewBox `0 0 width h`）。
 */
export function curvePlotViewBox(
  g: CurvePlotInput,
  width: number,
  pad: number,
): { x0: number; w: number } | null {
  if (!(g.barSpacePx > 0) || !(g.chartWidthPx > 0) || !(g.slots >= 2)) return null;
  const spanPx = (g.slots - 1) * g.barSpacePx;
  if (!(spanPx > 0)) return null;
  const plotW = width - pad * 2;
  const w = (plotW * g.chartWidthPx) / spanPx;
  const x0 = pad - (g.xFromPx * w) / g.chartWidthPx;
  if (!Number.isFinite(w) || !Number.isFinite(x0) || w <= 0) return null;
  return { x0, w };
}

/** 曲线视图 x 域的**解析**（ADR-028 D2.1）：显式 `xDomain` 优先（主路 = bar 索引空间）；
 *  只给 `domain`（旧签名）时按 **ts 线性降级**（组件级兜底：页面侧一律传主路 xDomain）。 */
export function resolveCurveX(args: {
  xDomain?: CurveXDomain | null;
  domain?: { from_ts: number; to_ts: number } | null;
}): CurveXDomain | null {
  if (args.xDomain !== undefined) return args.xDomain;
  if (args.domain) return { mode: 'ts', from_ts: args.domain.from_ts, to_ts: args.domain.to_ts };
  return null;
}

/** `data-x-domain` 标注串（E2E 冻结口径 = **数据窗口** ts 区间）：
 *  显式 `domain` 优先（即使 x 映射走 bar 索引空间——该属性描述窗口，不描述映射方式）；
 *  退化到 `xDomain`（index ⇒ bar 序列端点；ts ⇒ 其区间）；皆无 ⇒ `'data'`（未消费窗口）。 */
export function curveDomainAttr(args: {
  xDomain: CurveXDomain | null;
  domain?: { from_ts: number; to_ts: number } | null;
}): string {
  if (args.domain) return `${args.domain.from_ts},${args.domain.to_ts}`;
  const xd = args.xDomain;
  if (xd?.mode === 'ts') return `${xd.from_ts},${xd.to_ts}`;
  if (xd?.mode === 'index' && xd.barTs.length >= 2) {
    return `${xd.barTs[0]},${xd.barTs[xd.barTs.length - 1]}`;
  }
  return 'data';
}
