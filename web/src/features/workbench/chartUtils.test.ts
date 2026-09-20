import { describe, it, expect } from 'vitest';
import { curvePlotViewBox, curveXs, downsample, mapLine, mapLineByDomain, mapLineByTs } from './chartUtils';

describe('downsample（ADR §13.4：per_bar 全量数据 UI 抽样渲染）', () => {
  it('n ≤ maxPoints 原样返回（同引用语义不强制，内容相等）', () => {
    const pts: Array<[number, number]> = [[1, 10], [2, 20], [3, 30]];
    expect(downsample(pts, 5)).toEqual(pts);
    expect(downsample(pts, 3)).toEqual(pts);
  });

  it('n > maxPoints → 均匀抽样 ≤ maxPoints，且首尾保留', () => {
    const pts: Array<[number, number]> = Array.from({ length: 1000 }, (_, i) => [i, i * 2]);
    const out = downsample(pts, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([999, 1998]);
    // 抽样后 ts 严格升序
    for (let i = 1; i < out.length; i++) expect(out[i]![0]).toBeGreaterThan(out[i - 1]![0]);
  });

  it('空/单点输入不爆', () => {
    expect(downsample([], 10)).toEqual([]);
    expect(downsample([[5, 1]], 10)).toEqual([[5, 1]]);
  });
});

/**
 * F6（ADR-028 D2.1）：`mapLineByTs` 的 x 由 **ts 线性映射**到共享窗口定义域；
 * `mapLine` 语义**逐字节不变**（3 个既有调用点：AggregateScoreChart / EquityDrawdownChart / ComparePanel）。
 */
describe('mapLineByTs（共享窗口 ts 定义域；D2.1）', () => {
  const W = 1000;
  const H = 200;
  const PAD = 10;

  it('x 与 ts 在定义域内线性一致（端点 = [pad, width-pad]，中点 = 中线）', () => {
    const pts: Array<[number, number]> = [
      [100, 0],
      [150, 50],
      [200, 100],
    ];
    const out = mapLineByTs(pts, 100, 200, 0, 100, W, H, PAD);
    expect(out[0]!.x).toBeCloseTo(PAD, 6);
    expect(out[1]!.x).toBeCloseTo(PAD + (W - 2 * PAD) / 2, 6);
    expect(out[2]!.x).toBeCloseTo(W - PAD, 6);
    // y 与 mapLine 同口径：max ⇒ 上边，min ⇒ 下边
    expect(out[0]!.y).toBeCloseTo(H - PAD, 6);
    expect(out[2]!.y).toBeCloseTo(PAD, 6);
  });

  it('**定义域 = 共享窗口**（不是数据自身 min/max）：窗口内稀疏点不得铺满整框', () => {
    // 窗口 [0, 1000]，但数据只在 [400, 600] ⇒ 点必须落在框中部 40%~60%，不得端点对齐
    const out = mapLineByTs(
      [
        [400, 1],
        [600, 2],
      ],
      0,
      1000,
      1,
      2,
      W,
      H,
      PAD,
    );
    const plotW = W - 2 * PAD;
    expect(out[0]!.x).toBeCloseTo(PAD + 0.4 * plotW, 6);
    expect(out[1]!.x).toBeCloseTo(PAD + 0.6 * plotW, 6);
  });

  it('定义域退化（to ≤ from）⇒ 全部 x = pad（不除零、不 NaN）', () => {
    const out = mapLineByTs([[5, 1], [7, 2]], 100, 100, 0, 10, W, H, PAD);
    expect(out.map((p) => p.x)).toEqual([PAD, PAD]);
    expect(out.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it('回归：`mapLine` 仍是「下标等距铺满」语义（3 个既有调用点不得变）', () => {
    const pts: Array<[number, number]> = [
      [1000, 0],
      [2000, 50],
      [3000, 100],
    ];
    const byIndex = mapLine(pts, 0, 100, W, H, PAD);
    expect(byIndex.map((p) => p.x)).toEqual(mapLineByTs(pts, 1000, 3000, 0, 100, W, H, PAD).map((p) => p.x));
    // 关键区分：把 ts 换成不改变下标的前提下，mapLine 的 x 不变（只看下标）
    const shifted = mapLine([[7000, 0], [8000, 50], [9000, 100]], 0, 100, W, H, PAD);
    expect(shifted.map((p) => p.x)).toEqual(byIndex.map((p) => p.x));
    // 而 mapLineByTs 会随 ts 变（定义域不变、数据整体右移）
    const byTs = mapLineByTs([[7000, 0], [8000, 50], [9000, 100]], 1000, 3000, 0, 100, W, H, PAD);
    expect(byTs.map((p) => p.x)).not.toEqual(byIndex.map((p) => p.x));
  });
});

/**
 * ADR-028 D2.1/D2.3（2026-09-20 根因修正）：曲线 x **必须**按 **bar 索引空间**映射（禁 ts 线性作主路）。
 * 依据：K 线 x = 每 bar 一槽（缺口折叠），ts 线性会把缺口按时间占比摊到横轴 ⇒ 缺口窗偏差 169~350px@984。
 * 主路 = ts 先经「K 线所绘制的同一 bar 序列」查最近邻索引，再以索引线性映射；
 * 降级 = ts 线性（查表不可得，调用方必须显式标注）。
 */
describe('curveXs（bar 索引空间映射；D2.1 主路）', () => {
  const W = 1000;
  const PAD = 8;
  const PLOT = W - 2 * PAD;
  // K 线所绘制的 bar 序列（含一个 66600s 隔夜缺口：索引 2→3 之间）
  const barTs = [1000, 1300, 1600, 68200, 68500]; // 缺口：1600 → 68200（66600s）

  it('ts 落在 bar 上 ⇒ x = pad + 索引/(n-1)*plotW（**逐 bar 一槽**，与 ts 间隔无关）', () => {
    const { xs, unmatched } = curveXs(barTs, { mode: 'index', barTs, toleranceSec: 150 }, W, PAD);
    expect(unmatched).toBe(0);
    expect(xs[0]).toBeCloseTo(PAD, 6);
    expect(xs[2]).toBeCloseTo(PAD + (2 / 4) * PLOT, 6);
    // 缺口两侧相邻 bar 的 x 间距 == 其它相邻 bar 的间距（缺口被折叠，不摊进横轴）
    const step01 = xs[1]! - xs[0]!;
    const step23 = xs[3]! - xs[2]!;
    const step34 = xs[4]! - xs[3]!;
    expect(step23).toBeCloseTo(step01, 6);
    expect(step34).toBeCloseTo(step01, 6);
    expect(xs[4]).toBeCloseTo(W - PAD, 6);
  });

  it('真身 per_bar ts 与 K 线 bar ts 差数秒 ⇒ 容差内吸附到同一 bar（不新增槽位）', () => {
    const perBarTs = barTs.map((t) => t - 4); // 实测偏移量级（06:54:56 vs 06:55:00）
    const { xs, unmatched } = curveXs(perBarTs, { mode: 'index', barTs, toleranceSec: 150 }, W, PAD);
    expect(unmatched).toBe(0);
    for (let i = 0; i < barTs.length; i++) {
      expect(xs[i]).toBeCloseTo(PAD + (i / 4) * PLOT, 6);
    }
  });

  it('超容差（该 ts 不属于 K 线 bar 序列）⇒ null（**剔除而非钳位**），并计数', () => {
    const far = [...barTs, 999999]; // 远在序列之外
    const { xs, unmatched } = curveXs(far, { mode: 'index', barTs, toleranceSec: 150 }, W, PAD);
    expect(unmatched).toBe(1);
    expect(xs[far.length - 1]).toBeNull();
    expect(xs[0]).not.toBeNull();
  });

  it('ts 线性降级（mode=ts）与之**可区分**：缺口窗内两者 x 不同（降级必须被显式标注）', () => {
    const t = barTs[3]!; // 缺口后的首根
    const byIndex = curveXs([t], { mode: 'index', barTs, toleranceSec: 150 }, W, PAD).xs[0]!;
    const byTs = curveXs([t], { mode: 'ts', from_ts: barTs[0]!, to_ts: barTs[4]! }, W, PAD).xs[0]!;
    // 索引空间：缺口后首根 = 第 3 槽 = 3/4 plot；ts 线性：66600/67500 ≈ 98.7% plot
    expect(byIndex).toBeCloseTo(PAD + (3 / 4) * PLOT, 6);
    expect(byTs).toBeGreaterThan(PAD + 0.9 * PLOT);
    expect(Math.abs(byTs - byIndex)).toBeGreaterThan(150); // 与既有实测偏差同量级
  });

  it('无定义域（null）⇒ 全 null + 全计数（禁止回退到「数据自身 min/max 扇伸」，D2.2）', () => {
    const { xs, unmatched } = curveXs(barTs, null, W, PAD);
    expect(xs.every((x) => x === null)).toBe(true);
    expect(unmatched).toBe(barTs.length);
  });

  it('bar 序列为空 ⇒ 全 null（不除零）', () => {
    const { xs, unmatched } = curveXs(barTs, { mode: 'index', barTs: [], toleranceSec: 150 }, W, PAD);
    expect(xs.every((x) => x === null)).toBe(true);
    expect(unmatched).toBe(barTs.length);
  });
});

describe('mapLineByDomain（[ts,val] → 折线点；主路/降级/无域）', () => {
  const W = 1000;
  const H = 200;
  const PAD = 8;
  const barTs = [1000, 1300, 1600, 68200, 68500];
  const pts: Array<[number, number]> = [
    [1000, 0],
    [1300, 50],
    [1600, 100],
    [68200, 0],
    [68500, 100],
  ];

  it('bar 索引主路：x 按槽位等距、y 按 [min,max] 线性，剔除点被跳过（断线）', () => {
    const { points, unmatched } = mapLineByDomain(pts, { mode: 'index', barTs, toleranceSec: 150 }, 0, 100, W, H, PAD);
    expect(unmatched).toBe(0);
    expect(points.length).toBe(5);
    const step = (W - 2 * PAD) / 4;
    points.forEach((p, i) => expect(p.x).toBeCloseTo(PAD + i * step, 6));
    expect(points[0]!.y).toBeCloseTo(H - PAD, 6);
    expect(points[2]!.y).toBeCloseTo(PAD, 6);
  });

  it('超差点被剔除（points 变短 + unmatched 计数）而不是画到错误槽位', () => {
    const withAlien: Array<[number, number]> = [...pts, [999999, 50]];
    const { points, unmatched } = mapLineByDomain(
      withAlien,
      { mode: 'index', barTs, toleranceSec: 150 },
      0,
      100,
      W,
      H,
      PAD,
    );
    expect(unmatched).toBe(1);
    expect(points.length).toBe(5);
  });
});

describe('curvePlotViewBox（D2.3-4：曲线与 K 线**共用绘图区几何**）', () => {
  const W = 1000;
  const PAD = 8;

  it('把曲线 plot [pad, W-pad] 钉到 K 线的 xFromPx + i*barSpace（同一屏幕坐标）', () => {
    // 真身 init 态实测锚定值：首根 x=-83（绘图区局部）、barSpace=6、容器宽=666、可见 103 根
    const g = curvePlotViewBox({ barSpacePx: 6, xFromPx: -83, chartWidthPx: 666, slots: 103 }, W, PAD);
    expect(g).not.toBeNull();
    const user = (i: number): number => PAD + (i / (103 - 1)) * (W - 2 * PAD);
    const screen = (x: number): number => ((x - g!.x0) / g!.w) * 666;
    expect(screen(user(0))).toBeCloseTo(-83, 3); // 首根 == K 线首根
    expect(screen(user(102))).toBeCloseTo(-83 + 102 * 6, 3); // 末根 == K 线末根
    // 中间任意槽位同样对齐（不是只有端点对齐）
    expect(screen(user(51))).toBeCloseTo(-83 + 51 * 6, 3);
  });

  it('几何不可得（槽宽/容器宽非正 或 根数<2）⇒ null（降级：曲线独立几何）', () => {
    expect(curvePlotViewBox({ barSpacePx: 0, xFromPx: 0, chartWidthPx: 666, slots: 103 }, W, PAD)).toBeNull();
    expect(curvePlotViewBox({ barSpacePx: 6, xFromPx: 0, chartWidthPx: 0, slots: 103 }, W, PAD)).toBeNull();
    expect(curvePlotViewBox({ barSpacePx: 6, xFromPx: 0, chartWidthPx: 666, slots: 1 }, W, PAD)).toBeNull();
  });
});
