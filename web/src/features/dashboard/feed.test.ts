import { describe, it, expect } from 'vitest';
import { defaultPageSizeForPeriod, paginationBatchForPeriod, PAGINATION_BATCH, BARS_PER_TRADING_DAY, DEFAULT_KLINE_VIEWPORT_DAYS } from './feed';

describe('feed defaultPageSizeForPeriod（可配置视口：BARS_PER_TRADING_DAY × viewport_days，缺省 2）', () => {
  it('常规周期默认 = 每日 bar 数 × DEFAULT_KLINE_VIEWPORT_DAYS(2)', () => {
    expect(defaultPageSizeForPeriod('1m')).toBe(BARS_PER_TRADING_DAY['1m'] * 2);
    expect(defaultPageSizeForPeriod('15m')).toBe(BARS_PER_TRADING_DAY['15m'] * 2);
    expect(defaultPageSizeForPeriod('1d')).toBe(BARS_PER_TRADING_DAY['1d'] * 2);
  });

  it('统一公式：周/月一单位即一根（1×N），不再特殊化 30/24', () => {
    expect(defaultPageSizeForPeriod('1w')).toBe(BARS_PER_TRADING_DAY['1w'] * 2);
    expect(defaultPageSizeForPeriod('1mo')).toBe(BARS_PER_TRADING_DAY['1mo'] * 2);
  });

  it('配置 viewport_days 生效：每周期实际 bar = 每日 bar 数 × viewport_days（1m=241×N、1d=1×N）', () => {
    expect(defaultPageSizeForPeriod('1m', 10)).toBe(BARS_PER_TRADING_DAY['1m'] * 10);
    expect(defaultPageSizeForPeriod('1d', 5)).toBe(BARS_PER_TRADING_DAY['1d'] * 5);
    expect(defaultPageSizeForPeriod('1w', 10)).toBe(10);
  });

  it('缺省 viewport_days = DEFAULT_KLINE_VIEWPORT_DAYS(2)，用户调大可见更多', () => {
    expect(defaultPageSizeForPeriod('1m')).toBe(241 * DEFAULT_KLINE_VIEWPORT_DAYS);
    expect(defaultPageSizeForPeriod('1d', 10)).toBeGreaterThan(defaultPageSizeForPeriod('1d'));
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
