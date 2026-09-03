import { describe, it, expect } from 'vitest';
import { computeTimeshare } from './timeshare';
import type { Bar } from '@/api/types';

function bar(ts: string, close: number, volume: number, amount: number): Bar {
  return { ts, open: close, high: close, low: close, close, volume, amount };
}

describe('computeTimeshare（分时=当日价格线+均价线，1m bar 客户端计算）', () => {
  it('价格线取 close，均价=累计成交额/累计成交量', () => {
    const bars = [
      bar('2026-09-04T01:30:00Z', 2.0, 100, 200),
      bar('2026-09-04T01:31:00Z', 2.2, 100, 220),
      bar('2026-09-04T01:32:00Z', 2.4, 200, 480),
    ];
    const points = computeTimeshare(bars);
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ price: 2.0, avg: 2.0 });
    expect(points[1]!.avg).toBeCloseTo((200 + 220) / 200, 6);
    expect(points[2]!.price).toBe(2.4);
    expect(points[2]!.avg).toBeCloseTo((200 + 220 + 480) / 400, 6);
  });

  it('空输入返回空数组', () => {
    expect(computeTimeshare([])).toEqual([]);
  });

  it('成交量为 0 的 bar 不污染均价', () => {
    const bars = [bar('2026-09-04T01:30:00Z', 2.0, 0, 0), bar('2026-09-04T01:31:00Z', 2.1, 100, 210)];
    const points = computeTimeshare(bars);
    expect(points[0]!.avg).toBe(2.0); // 退化为收盘价
    expect(points[1]!.avg).toBeCloseTo(2.1, 6);
  });
});
