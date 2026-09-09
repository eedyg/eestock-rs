import { describe, it, expect } from 'vitest';
import { diffLines } from './diff';

describe('diffLines（行级 LCS diff；版本 diff 视图数据源）', () => {
  it('完全相同 → 全部 same', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.type === 'same')).toBe(true);
    expect(lines[0]).toEqual({ type: 'same', text: 'a', fromNo: 1, toNo: 1 });
    expect(lines[2]).toEqual({ type: 'same', text: 'c', fromNo: 3, toNo: 3 });
  });

  it('纯新增行 → add 带 toNo、fromNo=null', () => {
    const lines = diffLines('a\nc', 'a\nb\nc');
    expect(lines.map((l) => l.type)).toEqual(['same', 'add', 'same']);
    const add = lines[1]!;
    expect(add.text).toBe('b');
    expect(add.fromNo).toBeNull();
    expect(add.toNo).toBe(2);
  });

  it('纯删除行 → del 带 fromNo、toNo=null', () => {
    const lines = diffLines('a\nb\nc', 'a\nc');
    expect(lines.map((l) => l.type)).toEqual(['same', 'del', 'same']);
    const del = lines[1]!;
    expect(del.text).toBe('b');
    expect(del.fromNo).toBe(2);
    expect(del.toNo).toBeNull();
  });

  it('修改一行 → del 在前 add 在后（同位置替换口径）', () => {
    const lines = diffLines('a\nold\nc', 'a\nnew\nc');
    expect(lines.map((l) => l.type)).toEqual(['same', 'del', 'add', 'same']);
    expect(lines[1]!.text).toBe('old');
    expect(lines[2]!.text).toBe('new');
  });

  it('空串边界：空 → 非空 全 add；非空 → 空 全 del；双空 → 空序列', () => {
    expect(diffLines('', 'x\ny').every((l) => l.type === 'add')).toBe(true);
    expect(diffLines('x\ny', '').every((l) => l.type === 'del')).toBe(true);
    expect(diffLines('', '')).toEqual([]);
  });

  it('行号连续：same/add 的 toNo 单调递增；same/del 的 fromNo 单调递增', () => {
    const lines = diffLines('a\nb\nc\nd', 'b\nc\nx\nd\ne');
    let fromNo = 0;
    let toNo = 0;
    for (const l of lines) {
      if (l.type !== 'add') {
        fromNo += 1;
        expect(l.fromNo).toBe(fromNo);
      } else {
        expect(l.fromNo).toBeNull();
      }
      if (l.type !== 'del') {
        toNo += 1;
        expect(l.toNo).toBe(toNo);
      } else {
        expect(l.toNo).toBeNull();
      }
    }
  });
});
