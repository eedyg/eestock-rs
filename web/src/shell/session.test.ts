import { describe, it, expect } from 'vitest';
import { tradingSession, sessionLabel } from './session';

// 交易时段口径（02-sources §L2 写死）：工作日 09:30-11:30 / 13:00-15:00（Asia/Shanghai）
// 构造北京时间：用 UTC 时间减 8h 表示
function shanghai(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi));
}

describe('tradingSession', () => {
  // 2026-09-04 是周五
  it('09:30 前为盘前', () => {
    expect(tradingSession(shanghai(2026, 9, 4, 9, 0))).toBe('preopen');
  });
  it('09:30-11:30 为交易中（含边界 09:30）', () => {
    expect(tradingSession(shanghai(2026, 9, 4, 9, 30))).toBe('trading');
    expect(tradingSession(shanghai(2026, 9, 4, 10, 23))).toBe('trading');
  });
  it('11:30-13:00 为午间休市', () => {
    expect(tradingSession(shanghai(2026, 9, 4, 11, 30))).toBe('lunch');
    expect(tradingSession(shanghai(2026, 9, 4, 12, 59))).toBe('lunch');
  });
  it('13:00-15:00 为交易中', () => {
    expect(tradingSession(shanghai(2026, 9, 4, 13, 0))).toBe('trading');
    expect(tradingSession(shanghai(2026, 9, 4, 14, 59))).toBe('trading');
  });
  it('15:00 及之后为已收盘', () => {
    expect(tradingSession(shanghai(2026, 9, 4, 15, 0))).toBe('closed');
    expect(tradingSession(shanghai(2026, 9, 4, 20, 0))).toBe('closed');
  });
  it('周末为已收盘（Wave 1 简化口径：仅工作日判断）', () => {
    // 2026-09-05 周六、2026-09-06 周日
    expect(tradingSession(shanghai(2026, 9, 5, 10, 0))).toBe('closed');
    expect(tradingSession(shanghai(2026, 9, 6, 10, 0))).toBe('closed');
  });
});

describe('sessionLabel', () => {
  it('中文标签', () => {
    expect(sessionLabel('preopen')).toBe('盘前');
    expect(sessionLabel('trading')).toBe('交易中');
    expect(sessionLabel('lunch')).toBe('午间休市');
    expect(sessionLabel('closed')).toBe('已收盘');
  });
});
