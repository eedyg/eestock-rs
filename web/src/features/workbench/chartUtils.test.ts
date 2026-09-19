import { describe, it, expect } from 'vitest';
import { downsample, mapLine, mapLineByTs } from './chartUtils';

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
