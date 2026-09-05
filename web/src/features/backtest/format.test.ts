import { describe, it, expect } from 'vitest';
import { formatAvgHold } from './format';

describe('formatAvgHold（修复#2：平均持仓取整）', () => {
  it('无 period 时保留 bar 数并取整到 1 位（不再显示引擎原始小数）', () => {
    expect(formatAvgHold(16.999)).toBe('17bar'); // 16.99… → 四舍五入取整
    expect(formatAvgHold(3.2)).toBe('3.2bar');
    expect(formatAvgHold(3.0)).toBe('3bar'); // 整数去掉 .0
    expect(formatAvgHold(null)).toBe('—');
    expect(formatAvgHold(undefined)).toBe('—');
    expect(formatAvgHold(0)).toBe('0');
    expect(formatAvgHold(-3)).toBe('0');
  });

  it('period=D1 换算为天（保留 1 位小数）', () => {
    expect(formatAvgHold(3.2, 'D1')).toBe('3.2天');
    expect(formatAvgHold(1.0, 'D1')).toBe('1天');
  });

  it('period=M15 分时口径换算：<1 天显示时，>=1 天显示天', () => {
    // 60bar × 15分 = 900分 = 15时
    expect(formatAvgHold(60, 'M15')).toBe('15时');
    // 144bar × 15分 = 2160分 = 36时 = 1.5天（>=1 天时以天展示）
    expect(formatAvgHold(144, 'M15')).toBe('1.5天');
  });

  it('period=M1 不足 1 小时显示分', () => {
    // 3.2bar × 1分 = 3.2分
    expect(formatAvgHold(3.2, 'M1')).toBe('3.2分');
  });
});
