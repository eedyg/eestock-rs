import { describe, it, expect } from 'vitest';
import { PERIOD_MAP } from './chartCommon';

describe('chartCommon PERIOD_MAP（周期 → klinecharts Period 映射）', () => {
  it('已有周期映射保持（1m/5m/15m/1h/1d）', () => {
    expect(PERIOD_MAP['1m']).toEqual({ type: 'minute', span: 1 });
    expect(PERIOD_MAP['5m']).toEqual({ type: 'minute', span: 5 });
    expect(PERIOD_MAP['15m']).toEqual({ type: 'minute', span: 15 });
    expect(PERIOD_MAP['1h']).toEqual({ type: 'hour', span: 1 });
    expect(PERIOD_MAP['1d']).toEqual({ type: 'day', span: 1 });
  });

  it('1w → week 周期（周线）', () => {
    expect(PERIOD_MAP['1w']).toEqual({ type: 'week', span: 1 });
  });

  it('1mo → month 周期（月线）', () => {
    expect(PERIOD_MAP['1mo']).toEqual({ type: 'month', span: 1 });
  });
});
