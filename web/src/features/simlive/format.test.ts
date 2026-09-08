import { describe, it, expect } from 'vitest';
import { formatCstDateTime } from './format';

/**
 * CST 时间格式化（simlive 委托/成交/事件统一口径）。
 * 给定 Unix 秒 UTC ts → 固定 Asia/Shanghai（+8）"MM-DD HH:mm:ss"（含日期+时分秒，紧凑）。
 */
describe('formatCstDateTime（Unix 秒 → CST "MM-DD HH:mm:ss"）', () => {
  it('UTC 06:54:17Z → CST 14:54:17（含日期 09-08，非仅时分）', () => {
    // 2025-09-08T06:54:17Z = Unix 1757314457s；+8 → 2025-09-08 14:54:17 CST。
    const ts = Date.UTC(2025, 8, 8, 6, 54, 17) / 1000;
    expect(formatCstDateTime(ts)).toBe('09-08 14:54:17');
  });

  it('输出含秒（HH:mm:ss 三位时间）', () => {
    const ts = Date.UTC(2025, 8, 8, 6, 54, 0) / 1000;
    expect(formatCstDateTime(ts)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formatCstDateTime(ts)).toContain(':00');
  });

  it('跨日转换：UTC 2025-03-04T16:30:00Z → CST 03-05 00:30:00（UTC 日 3/4 → CST 日 3/5）', () => {
    const ts = Date.UTC(2025, 2, 4, 16, 30, 0) / 1000;
    expect(formatCstDateTime(ts)).toBe('03-05 00:30:00');
  });

  it('固定 +8：UTC 2025-01-01T00:00:00Z → CST 01-01 08:00:00（不随运行环境时区漂移）', () => {
    const ts = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000;
    expect(formatCstDateTime(ts)).toBe('01-01 08:00:00');
    // 同一 ts 恒定输出（与浏览器/Node 时区无关）。
    expect(formatCstDateTime(ts)).toBe(formatCstDateTime(ts));
  });

  it('无效输入 → —（null/undefined/NaN/0/负值）', () => {
    expect(formatCstDateTime(null)).toBe('—');
    expect(formatCstDateTime(undefined)).toBe('—');
    expect(formatCstDateTime(Number.NaN)).toBe('—');
    expect(formatCstDateTime(0)).toBe('—');
    expect(formatCstDateTime(-5)).toBe('—');
    expect(formatCstDateTime(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
