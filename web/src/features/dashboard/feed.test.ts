import { describe, it, expect } from 'vitest';
import { defaultPageSizeForPeriod, paginationBatchForPeriod, PAGINATION_BATCH, BARS_PER_TRADING_DAY } from './feed';

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

describe('feed paginationBatchForPeriod（分页批量 vs 视口 pageSize 分离，问题②修复）', () => {
  it('各周期批量取值正确（约定定稿）', () => {
    expect(paginationBatchForPeriod('1m')).toBe(500);
    expect(paginationBatchForPeriod('5m')).toBe(300);
    expect(paginationBatchForPeriod('15m')).toBe(220);
    expect(paginationBatchForPeriod('1h')).toBe(120);
    expect(paginationBatchForPeriod('1d')).toBe(250);
    expect(paginationBatchForPeriod('1w')).toBe(150);
    expect(paginationBatchForPeriod('1mo')).toBe(80);
  });

  it('批量 ≥ 视口 pageSize（深翻不退回 2-bar 小页）', () => {
    // 视口很小（1d=2、1w=30、1mo=24），批量必须大于等于视口，否则深翻依旧每次只几根
    for (const p of ['1m', '5m', '15m', '1h', '1d', '1w', '1mo'] as const) {
      expect(paginationBatchForPeriod(p)).toBeGreaterThanOrEqual(defaultPageSizeForPeriod(p));
    }
  });

  it('PAGINATION_BATCH 与 paginationBatchForPeriod 一致（无双重事实源）', () => {
    for (const p of ['1m', '5m', '15m', '1h', '1d', '1w', '1mo'] as const) {
      expect(PAGINATION_BATCH[p]).toBe(paginationBatchForPeriod(p));
    }
  });
});
