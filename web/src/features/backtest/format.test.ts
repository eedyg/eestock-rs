import { describe, it, expect } from 'vitest';
import { formatAvgHold, periodCodeToPeriod, periodLabel } from './format';

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

  // ADR-024 P0：M30 档（30min）的显示/映射补齐。
  it('period=M30 分时口径换算：120bar 保 0.6 天区间显示时/分', () => {
    // 120bar × 30分 = 3600分 = 60时 = 2.5天（>=1 天时以天展示）
    expect(formatAvgHold(120, 'M30')).toBe('2.5天');
    // 24bar × 30分 = 720分 = 12时
    expect(formatAvgHold(24, 'M30')).toBe('12时');
    // 1bar × 30分 = 30分
    expect(formatAvgHold(1, 'M30')).toBe('30分');
  });
});

describe('ADR-024 P0：后端口径周期代码 → 前端展示/看板周期映射（含 M30）', () => {
  it('periodLabel(M30) = "30m"（新增）；既有档位不变', () => {
    expect(periodLabel('M30')).toBe('30m');
    expect(periodLabel('M1')).toBe('1m');
    expect(periodLabel('M5')).toBe('5m');
    expect(periodLabel('M15')).toBe('15m');
    expect(periodLabel('D1')).toBe('日');
  });

  it('periodLabel(H1) = "1h"（回测白名单 H1 的展示补齐）', () => {
    expect(periodLabel('H1')).toBe('1h');
  });

  it('periodCodeToPeriod(M30) = "30m"（ScopedKlineFeed 已有 30m 步长映射，勿重复添加）', () => {
    expect(periodCodeToPeriod('M30')).toBe('30m');
    expect(periodCodeToPeriod('M1')).toBe('1m');
    expect(periodCodeToPeriod('M15')).toBe('15m');
    expect(periodCodeToPeriod('D1')).toBe('1d');
  });

  it('periodCodeToPeriod(H1) = "1h"；未识别兜底 1d', () => {
    expect(periodCodeToPeriod('H1')).toBe('1h');
    expect(periodCodeToPeriod('W1')).toBe('1d');
    expect(periodCodeToPeriod(undefined)).toBe('1d');
  });
});
