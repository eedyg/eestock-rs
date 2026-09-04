import { describe, it, expect } from 'vitest';
import { validateCode, marketOf, validateInterval, validateSettlement, validateForm } from './validate';

describe('symbols 表单校验（03-symbols §3，与后端 dto 校验同口径）', () => {
  it('code：6 位数字 + 市场前缀；北交所 4/8/920 拒绝「暂不支持」', () => {
    expect(validateCode('600519')).toBeNull(); // 沪
    expect(validateCode('518880')).toBeNull();
    expect(validateCode('159915')).toBeNull(); // 深
    expect(validateCode('000001')).toBeNull();
    expect(validateCode('60051')).toBe('code 须为 6 位数字');
    expect(validateCode('6005199')).toBe('code 须为 6 位数字');
    expect(validateCode('60051a')).toBe('code 须为 6 位数字');
    expect(validateCode('')).toBe('code 须为 6 位数字');
    for (const bse of ['430001', '830799', '920001']) {
      expect(validateCode(bse)).toBe('北交所标的（4/8/920 前缀）暂不支持');
    }
    expect(validateCode('700001')).toBe('不支持的市场前缀');
  });

  it('marketOf：5/6/9→沪、0/1/2/3→深', () => {
    expect(marketOf('600519')).toBe('沪');
    expect(marketOf('900901')).toBe('沪');
    expect(marketOf('159915')).toBe('深');
    expect(marketOf('830799')).toBeNull();
  });

  it('interval：下限 60 秒', () => {
    expect(validateInterval(60)).toBeNull();
    expect(validateInterval(300)).toBeNull();
    expect(validateInterval(59)).toBe('抓取间隔下限 60 秒');
    expect(validateInterval(0)).toBe('抓取间隔下限 60 秒');
    expect(validateInterval(Number.NaN)).toBe('抓取间隔须为数字');
  });

  it('settlement：T0/T1', () => {
    expect(validateSettlement('T0')).toBeNull();
    expect(validateSettlement('T1')).toBeNull();
    expect(validateSettlement('T2' as never)).toBe('交收规则须为 T0 或 T1');
  });

  it('validateForm：注册校验 code，编辑跳过 code；settlement 变更需二次确认', () => {
    const base = { code: '600519', intervalSec: 60, settlement: 'T1' as const, enabled: true, name: '' };
    expect(validateForm('register', base, null, false)).toEqual({});
    expect(validateForm('register', { ...base, code: '830799' }, null, false)).toHaveProperty('code');
    expect(validateForm('register', { ...base, intervalSec: 30 }, null, false)).toHaveProperty('intervalSec');
    // 编辑模式：code 不校验（主键只读）
    expect(validateForm('edit', { ...base, code: 'bad' }, 'T1', false)).toEqual({});
    // 编辑模式 settlement 变更且未确认 → 错误
    expect(validateForm('edit', { ...base, settlement: 'T0' }, 'T1', false)).toHaveProperty('settlement');
    // 已确认 → 通过
    expect(validateForm('edit', { ...base, settlement: 'T0' }, 'T1', true)).toEqual({});
    // 未变更无需确认
    expect(validateForm('edit', base, 'T1', false)).toEqual({});
  });
});
