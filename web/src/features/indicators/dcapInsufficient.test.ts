/**
 * dcap 指标 —— T6（数据不足边界：逐线首次有值位置）
 *
 * 本文件位置：web/src/features/indicators/dcapInsufficient.test.ts
 * 被测产物：web/src/features/indicators/dcap.ts
 *   （entangled 由 design/14-dcap-indicator/02-spec.md §10.1 生成，ADR-021 D2/D4）
 * 权威口径：design/14-dcap-indicator/02-spec.md §3「数据不足」行
 *   （可用 bar 数 `< n`（开平滑时 `< n + m − 1`）⇒ 该线该 bar 无值；前端 `null`，线自然断开）
 *   + §6 图表「断线」行（表现为「线从第 `n_i + m − 1` 根开始」）；
 *   §4 `smoothSeries` 契约（忽略 null 前导；有效值不足 m 个 ⇒ null）。
 * 测试规格：design/14-dcap-indicator/03-test-plan.md T6。
 * 运行：cd web && npx vitest run src/features/indicators/dcapInsufficient.test.ts
 *
 * ── 本文件钉死的口径（每条断言对应一条）────────────────────────────────────────
 * ① 逐线口径：每条线的首个有值位置**分别**等于各自的 `n_i + m − 1`（1 起 bar 数）/
 *    `n_i + m − 2`（0 起下标），**不得**用 `n_l` 一刀切（三线起始位置必须互不相同）；
 * ② 边界表：`n_i − 1` → null、`n_i` → null（SMA 未满 m）、`n_i + m − 2` → null、
 *    `n_i + m − 1` → 首个有值（逐线各测一遍）；
 * ③ `smooth=0`：只要 bar 数 ≥ `n_i` 就有值（首值下标 = `n_i − 1`）；
 * ④ `dcapRoi` 单线口径：bar 数 `< n` → null，`= n` → 有值（不抛错）。
 */

import { describe, expect, it } from 'vitest';

import { computeDcapSeries, dcapRoi } from './dcap';
import type { DcapParams, DcapValues } from './dcap';

/** 确定性序列（纯算术构造，无 RNG / 无时间依赖）。 */
const SYNTH_60: number[] = Array.from({ length: 60 }, (_, i) => 10 + (((i * 37) % 11) - 5) * 0.3);

function params(over: Partial<DcapParams> = {}): DcapParams {
  return { n_s: 2, n_m: 3, n_l: 4, r_s: 1, r_m: 1, r_l: 1, smooth: 0, m: 3, ...over };
}

function valueAt(closes: readonly number[], p: DcapParams, index: number): DcapValues | undefined {
  return computeDcapSeries(closes.slice(), p)[index];
}

function hasValue(v: DcapValues | undefined, line: 's' | 'm' | 'l'): boolean {
  return v?.[line] !== null && v?.[line] !== undefined;
}

/** 三线首个有值下标（0 起；无值返回 -1）。 */
function firstIndex(closes: readonly number[], p: DcapParams, line: 's' | 'm' | 'l'): number {
  const series = computeDcapSeries(closes.slice(), p);
  for (let i = 0; i < series.length; i++) {
    if (hasValue(series[i], line)) {
      return i;
    }
  }
  return -1;
}

// ===========================================================================
// T6 —— 数据不足边界（逐根对齐）
// ===========================================================================

describe('T6 数据不足边界（逐线，不用 n_l 一刀切）', () => {
  it('T6-a 逐线首值下标 = 各自的 n_i + m − 2（smooth=1, m=4）', () => {
    const p = params({ n_s: 3, n_m: 5, n_l: 8, smooth: 1, m: 4 });
    // 期望（0 起）：s = 3+4−2 = 5、m = 5+4−2 = 7、l = 8+4−2 = 10
    expect(firstIndex(SYNTH_60, p, 's'), 'T6-a s 线首值下标 = n_s + m − 2 = 5').toBe(5);
    expect(firstIndex(SYNTH_60, p, 'm'), 'T6-a m 线首值下标 = n_m + m − 2 = 7（不得用 n_l）').toBe(7);
    expect(firstIndex(SYNTH_60, p, 'l'), 'T6-a l 线首值下标 = n_l + m − 2 = 10').toBe(10);
    // 反「一刀切」：三线首值位置互不相同，s 严格早于 l
    const [fs, fm, fl] = [firstIndex(SYNTH_60, p, 's'), firstIndex(SYNTH_60, p, 'm'), firstIndex(SYNTH_60, p, 'l')];
    expect(new Set([fs, fm, fl]).size, 'T6-a 三线首值位置必须互不相同').toBe(3);
    expect(fs, 'T6-a s 线必须早于 l 线出现').toBeLessThan(fl);
  });

  it('T6-b 边界表：n−1 / n / n+m−2 → null；n+m−1 → 首个有值（逐线各测）', () => {
    const p = params({ n_s: 3, n_m: 5, n_l: 8, smooth: 1, m: 4 });
    const lines: Array<{ line: 's' | 'm' | 'l'; n: number }> = [
      { line: 's', n: p.n_s },
      { line: 'm', n: p.n_m },
      { line: 'l', n: p.n_l },
    ];
    for (const { line, n } of lines) {
      const at = (bars: number) => valueAt(SYNTH_60.slice(0, bars), p, bars - 1);
      expect(hasValue(at(n - 1), line), `T6-b ${line} 线：${n - 1} 根 → null`).toBe(false);
      expect(hasValue(at(n), line), `T6-b ${line} 线：${n} 根 → null（SMA 未满 m）`).toBe(false);
      expect(hasValue(at(n + p.m - 2), line), `T6-b ${line} 线：${n + p.m - 2} 根 → null`).toBe(false);
      expect(hasValue(at(n + p.m - 1), line), `T6-b ${line} 线：${n + p.m - 1} 根 → 首个有值`).toBe(true);
      // 一旦有值，后续 bar 不得再回到 null（窗口推进、数据只增）
      const series = computeDcapSeries(SYNTH_60.slice(), p);
      for (let i = n + p.m - 1; i < series.length; i++) {
        expect(hasValue(series[i], line), `T6-b ${line} 线：bar ${i} 不应回到 null`).toBe(true);
      }
    }
  });

  it('T6-c smooth=0：bar 数 ≥ n_i 即有值（首值下标 = n_i − 1）', () => {
    const p = params({ n_s: 3, n_m: 5, n_l: 8, smooth: 0, m: 4 });
    expect(firstIndex(SYNTH_60, p, 's'), 'T6-c s 首值下标 = n_s − 1 = 2').toBe(2);
    expect(firstIndex(SYNTH_60, p, 'm'), 'T6-c m 首值下标 = n_m − 1 = 4').toBe(4);
    expect(firstIndex(SYNTH_60, p, 'l'), 'T6-c l 首值下标 = n_l − 1 = 7').toBe(7);
    // 边界：n_i − 1 根 → null
    for (const [line, n] of [
      ['s', p.n_s],
      ['m', p.n_m],
      ['l', p.n_l],
    ] as Array<['s' | 'm' | 'l', number]>) {
      expect(
        hasValue(valueAt(SYNTH_60.slice(0, n - 1), p, n - 2), line),
        `T6-c ${line} 线：${n - 1} 根 → null`,
      ).toBe(false);
      expect(
        hasValue(valueAt(SYNTH_60.slice(0, n), p, n - 1), line),
        `T6-c ${line} 线：${n} 根 → 有值`,
      ).toBe(true);
    }
  });

  it('T6-d dcapRoi 单线口径：bar 数 < n → null；= n → 有值；非法价 → null（不抛错）', () => {
    const closes = SYNTH_60.slice(0, 5);
    expect(dcapRoi(closes.slice(0, 2), 3, 1), 'T6-d 2 根 < n=3 → null').toBeNull();
    expect(dcapRoi(closes.slice(0, 3), 3, 1), 'T6-d 恰好 3 根 → 有值').not.toBeNull();
    expect(dcapRoi([], 3, 1), 'T6-d 空序列 → null').toBeNull();
    // 除零 / 非法价按数据不足处理，不得抛错（02-spec §5 异常路径）
    expect(() => dcapRoi([100, 90, 0], 3, 1), 'T6-d close=0 不得抛错').not.toThrow();
    expect(dcapRoi([100, 90, 0], 3, 1), 'T6-d close=0 → null').toBeNull();
  });
});
