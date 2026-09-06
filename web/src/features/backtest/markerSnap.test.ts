import { describe, it, expect } from 'vitest';
// 吸附+钳位纯函数（KlineMarkerOverlay 定位核心）来自 KlineChart（dashboard）。
// 测试目标是：B/S 标记 ts 无同类 bar（如 D1 run 的桶 ts=16:00Z 切 1m）时，
// 吸附到已加载 bar 集合里最近的 bar 且钳位到 [0, len-1]（On-Screen 保证）。
import { snapTsToBars } from '../dashboard/KlineChart';

function bar(iso: string) {
  return { ts: iso };
}

describe('snapTsToBars（B/S 标记「吸附 + 钳位」，保证跨周期 On-Screen）', () => {
  it('D1 桶 ts（16:00Z，无同类 1m bar，且晚于末根）→ 吸附到最近 bar，index 在 [0,len-1]，ts 在 [first,last] 内', () => {
    // 已加载 1m bars（升序，覆盖开→平 + buffer）
    const bars = [
      bar('2023-11-14T09:30:00.000Z'),
      bar('2023-11-14T10:00:00.000Z'),
      bar('2023-11-14T10:30:00.000Z'),
      bar('2023-11-14T11:00:00.000Z'),
    ];
    // D1 桶边界 ts（16:00Z）：不是真实盘中 1m bar
    const target = Date.parse('2023-11-14T16:00:00.000Z');
    const r = snapTsToBars(bars, target);
    expect(r).not.toBeNull();
    expect(r!.index).toBeGreaterThanOrEqual(0);
    expect(r!.index).toBeLessThan(bars.length);
    // 吸附后 ts 必在已加载范围首尾之间（On-Screen）
    expect(r!.ts).toBeGreaterThanOrEqual(Date.parse(bars[0]!.ts));
    expect(r!.ts).toBeLessThanOrEqual(Date.parse(bars[bars.length - 1]!.ts));
    // 最近一根 bar = 最后一根（11:00，diff 5h）
    expect(r!.index).toBe(bars.length - 1);
    expect(r!.ts).toBe(Date.parse(bars[bars.length - 1]!.ts));
  });

  it('D1 桶 ts 落在两根已加载 bar 之间 → 吸附到距其最近的 bar（不偏移到屏外）', () => {
    const bars = [
      bar('2023-11-14T09:30:00.000Z'),
      bar('2023-11-14T10:00:00.000Z'),
      bar('2023-11-14T10:30:00.000Z'),
    ];
    // 9:45 恰在 9:30 与 10:00 中间偏 9:30（diff 15m vs 15m，平局取前一根）
    const target = Date.parse('2023-11-14T09:45:00.000Z');
    const r = snapTsToBars(bars, target)!;
    expect(r.index).toBe(0);
    expect(r.ts).toBe(Date.parse(bars[0]!.ts));
    // 均在 loaded 范围
    expect(r.ts).toBeGreaterThanOrEqual(Date.parse(bars[0]!.ts));
    expect(r.ts).toBeLessThanOrEqual(Date.parse(bars[bars.length - 1]!.ts));
  });

  it('正常同周期：marker ts 恰为某根 bar → 吸附精确（不偏移）', () => {
    const bars = [
      bar('2023-11-14T09:30:00.000Z'),
      bar('2023-11-14T09:31:00.000Z'),
      bar('2023-11-14T09:32:00.000Z'),
    ];
    const target = Date.parse('2023-11-14T09:31:00.000Z');
    const r = snapTsToBars(bars, target)!;
    expect(r.index).toBe(1);
    expect(r.ts).toBe(Date.parse('2023-11-14T09:31:00.000Z'));
    // 精确匹配（ts 不变）
    expect(r.ts).toBe(target);
  });

  it('marker ts 早于首根 bar → 钳位到首根（index 0）', () => {
    const bars = [
      bar('2023-11-14T09:30:00.000Z'),
      bar('2023-11-14T10:00:00.000Z'),
    ];
    const r = snapTsToBars(bars, Date.parse('2023-11-14T08:00:00.000Z'))!;
    expect(r.index).toBe(0);
    expect(r.ts).toBe(Date.parse('2023-11-14T09:30:00.000Z'));
  });

  it('marker ts 晚于末根 bar（D1→细周期，区间外）→ 钳位到末根（index len-1）', () => {
    const bars = [
      bar('2023-11-14T09:30:00.000Z'),
      bar('2023-11-14T10:00:00.000Z'),
    ];
    const r = snapTsToBars(bars, Date.parse('2023-11-15T00:00:00.000Z'))!;
    expect(r.index).toBe(bars.length - 1);
    expect(r.ts).toBe(Date.parse(bars[bars.length - 1]!.ts));
    expect(r.ts).toBeLessThanOrEqual(Date.parse(bars[bars.length - 1]!.ts));
  });

  it('bars 为空 → 返回 null（无可吸附 bar，不创建标记）', () => {
    expect(snapTsToBars([], 123)).toBeNull();
  });

  it('bars 乱序输入也能正确吸附（数据罗盘容错）', () => {
    const bars = [
      bar('2023-11-14T10:30:00.000Z'),
      bar('2023-11-14T09:30:00.000Z'),
      bar('2023-11-14T10:00:00.000Z'),
    ];
    const r = snapTsToBars(bars, Date.parse('2023-11-14T10:10:00.000Z'))!;
    expect(r.ts).toBe(Date.parse('2023-11-14T10:00:00.000Z'));
  });
});
