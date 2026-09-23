import { describe, expect, it } from 'vitest';
import { clipToEvaluatedRange, evaluatedRange } from './runSeriesRange';

/** 结果页「评估段裁剪」规格（ADR-028 D2.4；用户 2026-09-22 决策 = 方案 A「裁剪到执行段」）。 */

const RUN = { from_ts: '2026-05-20T00:00:00Z', to_ts: '2026-09-02T00:00:00Z' };
const FROM = Math.floor(Date.parse(RUN.from_ts) / 1000);
const TO = Math.floor(Date.parse(RUN.to_ts) / 1000);

describe('evaluatedRange（run 评估段 = effective [from_ts, to_ts]）', () => {
  it('ISO → Unix 秒（含端点在语义内）', () => {
    expect(evaluatedRange(RUN)).toEqual({ from: FROM, to: TO });
  });

  it('缺 run / 缺端点 / 解析失败 ⇒ null（不裁剪，零回归）', () => {
    expect(evaluatedRange(null)).toBeNull();
    expect(evaluatedRange({ from_ts: RUN.from_ts, to_ts: '' })).toBeNull();
    expect(evaluatedRange({ from_ts: 'not-a-date', to_ts: RUN.to_ts })).toBeNull();
  });

  it('from > to（坏数据）⇒ null（不裁剪，不静默清空曲线）', () => {
    expect(evaluatedRange({ from_ts: RUN.to_ts, to_ts: RUN.from_ts })).toBeNull();
  });
});

describe('clipToEvaluatedRange（预热段不参与曲线绘制）', () => {
  const rows = (tsList: number[]) => tsList.map((ts) => ({ ts, v: ts }));

  it('剔除 from 之前（预热段）与 to 之后的行，含端点保留，顺序不变', () => {
    const src = rows([FROM - 300, FROM - 1, FROM, FROM + 100, TO, TO + 1]);
    const { kept, dropped } = clipToEvaluatedRange(src, { from: FROM, to: TO });
    expect(kept.map((r) => r.ts)).toEqual([FROM, FROM + 100, TO]);
    expect(dropped).toBe(3);
  });

  it('range = null ⇒ 原样返回（dropped=0）', () => {
    const src = rows([1, 2, 3]);
    const { kept, dropped } = clipToEvaluatedRange(src, null);
    expect(kept).toBe(src);
    expect(dropped).toBe(0);
  });

  it('无预热行时逐元素相等（回归护栏：正常 run 零变化）', () => {
    const src = rows([FROM, FROM + 60, TO]);
    const { kept, dropped } = clipToEvaluatedRange(src, { from: FROM, to: TO });
    expect(kept).toHaveLength(3);
    expect(dropped).toBe(0);
  });

  it('空序列 ⇒ 空（不抛）', () => {
    expect(clipToEvaluatedRange([], { from: FROM, to: TO })).toEqual({ kept: [], dropped: 0 });
  });
});
