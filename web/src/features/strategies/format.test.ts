import { describe, it, expect } from 'vitest';
import {
  APPROVAL_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  approvalRank,
  approvalSatisfies,
  formatDateTime,
} from './format';

describe('策略页展示格式化（format.ts）', () => {
  it('中文标签齐备：kind/status/approval 全枚举覆盖', () => {
    expect(KIND_LABEL).toEqual({ strategy: '策略', template: '模板' });
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(['archived', 'draft', 'published']);
    expect(Object.keys(APPROVAL_LABEL).sort()).toEqual(['backtest_ok', 'live_approved', 'sim_ok']);
  });

  it('approval 阶梯 rank：backtest_ok < sim_ok < live_approved', () => {
    expect(approvalRank('backtest_ok')).toBeLessThan(approvalRank('sim_ok'));
    expect(approvalRank('sim_ok')).toBeLessThan(approvalRank('live_approved'));
  });

  it('approvalSatisfies：at-least 语义（更高级别满足更低要求）', () => {
    expect(approvalSatisfies('live_approved', 'backtest_ok')).toBe(true);
    expect(approvalSatisfies('sim_ok', 'backtest_ok')).toBe(true);
    expect(approvalSatisfies('backtest_ok', 'sim_ok')).toBe(false);
    expect(approvalSatisfies('backtest_ok', 'backtest_ok')).toBe(true);
  });

  it('formatDateTime：ISO → 本地可读串；非法输入原样返回', () => {
    const out = formatDateTime('2026-09-08T06:00:00Z');
    expect(out).toMatch(/2026/);
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
