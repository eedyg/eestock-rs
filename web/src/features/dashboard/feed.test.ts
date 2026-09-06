import { describe, it, expect } from 'vitest';
import { defaultPageSizeForPeriod, BARS_PER_TRADING_DAY } from './feed';

describe('feed defaultPageSizeForPeriod（周/月合理初始视口，非 2×交易日）', () => {
  it('1w → 30 根（≈30 周，半年+视口）', () => {
    expect(defaultPageSizeForPeriod('1w')).toBe(30);
  });

  it('1mo → 24 根（≈24 月，两年视口）', () => {
    expect(defaultPageSizeForPeriod('1mo')).toBe(24);
  });

  it('1w/1mo 不按 2×交易日（周/月一单位即一根）', () => {
    // BARS_PER_TRADING_DAY['1w']=1、['1mo']=1；若按 2× 会得 2 根，过疏
    expect(BARS_PER_TRADING_DAY['1w']).toBe(1);
    expect(BARS_PER_TRADING_DAY['1mo']).toBe(1);
    expect(defaultPageSizeForPeriod('1w')).toBeGreaterThan(BARS_PER_TRADING_DAY['1w'] * 2);
    expect(defaultPageSizeForPeriod('1mo')).toBeGreaterThan(BARS_PER_TRADING_DAY['1mo'] * 2);
  });

  it('常规周期仍为 2×交易日（缺口回归）', () => {
    expect(defaultPageSizeForPeriod('15m')).toBe(BARS_PER_TRADING_DAY['15m'] * 2);
    expect(defaultPageSizeForPeriod('1d')).toBe(BARS_PER_TRADING_DAY['1d'] * 2);
  });
});
