import { describe, it, expect } from 'vitest';
import { downsample } from './chartUtils';

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
