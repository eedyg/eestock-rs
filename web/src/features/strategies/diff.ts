/**
 * 行级 LCS diff（版本 diff 视图数据源；自实现——未引入 @codemirror/merge，保持批准依赖清单不变）。
 * 口径：同位置修改 = del 在前 + add 在后；行号 1-based（fromNo 属旧版本、toNo 属新版本）。
 */

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  /** 旧版本行号（add 行为 null） */
  fromNo: number | null;
  /** 新版本行号（del 行为 null） */
  toNo: number | null;
}

export function diffLines(from: string, to: string): DiffLine[] {
  const a = from === '' ? [] : from.split('\n');
  const b = to === '' ? [] : to.split('\n');
  if (a.length === 0 && b.length === 0) return [];
  const n = a.length;
  const m = b.length;
  // LCS DP 表（lcs[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度）
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]!, fromNo: i + 1, toNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]!, fromNo: i + 1, toNo: null });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]!, fromNo: null, toNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i]!, fromNo: i + 1, toNo: null });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j]!, fromNo: null, toNo: j + 1 });
    j++;
  }
  return out;
}
