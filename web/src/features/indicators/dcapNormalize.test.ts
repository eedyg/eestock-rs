/**
 * dcap 指标 —— T5a（前端入口确定性归一化）
 *
 * 本文件位置：web/src/features/indicators/dcapNormalize.test.ts
 * 被测产物：web/src/features/indicators/dcap.ts
 *   （entangled 由 design/14-dcap-indicator/02-spec.md §10.1 生成，ADR-021 D2/D4）
 * 权威口径：design/14-dcap-indicator/02-spec.md §2（跨字段约束落地方式：插件 init 与
 *   前端入口都做确定性归一化 `n_m ← max(n_m, n_s+1)`、`n_l ← max(n_l, n_m+1)`，确定 + 幂等）、
 *   §4 铁律 5（**入口归一化必须在 CORE 内**：插件 `init` 与前端 `computeDcapSeries` 入口
 *   都调用它 —— 否则非单调参数下 D5 跨运行时比对必然分叉）、§3（参数归一化行）。
 * 测试规格：design/14-dcap-indicator/03-test-plan.md T5a。
 * 运行：cd web && npx vitest run src/features/indicators/dcapNormalize.test.ts
 *
 * ── 本文件钉死的口径（每条断言对应一条）────────────────────────────────────────
 * ① 生效值：非单调三元组进 `computeDcapSeries` 后的输出，必须与「已归一三元组」的输出
 *    **逐位相同**（等价于前端入口真的做了 `n_m ← max(n_m, n_s+1)`、`n_l ← max(n_l, n_m+1)`）；
 * ② 幂等：把归一后的三元组再次作为输入 ⇒ 输出与未归一输入**逐位**相同（f(f(x))=f(x) 的可观测形式）；
 * ③ 确定：同输入多次调用逐位相同（纯函数、无全局状态）；
 * ④ 生效位置可核验：三线首个有值位置必须按**归一后**的 `n_i + m − 1`（1 起）——
 *    这是 ① 的独立佐证（避免「两侧都没归一 ⇒ 都相等 ⇒ 假绿」）。
 */

import { describe, expect, it } from 'vitest';

import { computeDcapSeries } from './dcap';
import type { DcapParams, DcapValues } from './dcap';

// ---------------------------------------------------------------------------
// 位串工具（与 dcap.test.ts / dcapMirror.test.ts 同口径）
// ---------------------------------------------------------------------------

const bitsView = new DataView(new ArrayBuffer(8));

function bitsOf(v: unknown): string {
  if (typeof v !== 'number') {
    return `非数值(${String(v)})`;
  }
  bitsView.setFloat64(0, v, false);
  return bitsView.getBigUint64(0, false).toString(16).padStart(16, '0');
}

function valuesBits(v: DcapValues | undefined): string[] {
  return [bitsOf(v?.s), bitsOf(v?.m), bitsOf(v?.l)];
}

function assertSeriesBitwiseEqual(
  actual: readonly (DcapValues | undefined)[],
  expected: readonly (DcapValues | undefined)[],
  label: string,
): void {
  expect(actual.length, `${label}：长度必须相同`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = valuesBits(actual[i]);
    const b = valuesBits(expected[i]);
    for (let k = 0; k < 3; k++) {
      expect(
        a[k],
        `${label}：bar ${i} 字段 ${['s', 'm', 'l'][k]} 位串不同（actual=${a[k]} expected=${b[k]}）`,
      ).toBe(b[k]);
    }
  }
}

function params(over: Partial<DcapParams> = {}): DcapParams {
  return { n_s: 2, n_m: 3, n_l: 4, r_s: 1, r_m: 1, r_l: 1, smooth: 0, m: 3, ...over };
}

/** 确定性序列（纯算术构造，无 RNG / 无时间依赖）。 */
const SYNTH_40: number[] = Array.from({ length: 40 }, (_, i) => 10 + (((i * 37) % 11) - 5) * 0.3);

/** 三线首个有值位置（0 起下标；全部为 null 则返回 -1）。 */
function firstNonNull(vals: readonly (DcapValues | undefined)[], line: 's' | 'm' | 'l'): number {
  for (let i = 0; i < vals.length; i++) {
    if (vals[i]?.[line] !== null && vals[i]?.[line] !== undefined) {
      return i;
    }
  }
  return -1;
}

// ===========================================================================
// T5a —— 前端入口归一化
// ===========================================================================

describe('T5a 前端入口归一化（02-spec §2 / §4 铁律 5）', () => {
  it('T5a-a 非单调三元组 ≡ 归一后三元组（逐位，smooth=1，r≠1）', () => {
    const base = params({ r_s: 1, r_m: 1.2, r_l: 0.8, smooth: 1, m: 3 });
    const cases: Array<{ name: string; raw: [number, number, number]; norm: [number, number, number] }> = [
      // n_s = n_m = n_l → n_m' = n_s+1、n_l' = n_m'+1（顺序归一）
      { name: 'n_s=n_m=n_l=3', raw: [3, 3, 3], norm: [3, 4, 5] },
      // n_m = n_l > n_s → 只推进 n_l'
      { name: 'n_s=2,n_m=n_l=5', raw: [2, 5, 5], norm: [2, 5, 6] },
      // 逆序（n_s > n_m > n_l）→ 两条都被顶上去
      { name: '逆序 9/6/3', raw: [9, 6, 3], norm: [9, 10, 11] },
      // n_s = n_l > n_m
      { name: 'n_s=n_l=4,n_m=3', raw: [4, 3, 4], norm: [4, 5, 6] },
    ];

    for (const c of cases) {
      const rawSeries = computeDcapSeries(SYNTH_40, { ...base, n_s: c.raw[0], n_m: c.raw[1], n_l: c.raw[2] });
      const normSeries = computeDcapSeries(SYNTH_40, { ...base, n_s: c.norm[0], n_m: c.norm[1], n_l: c.norm[2] });
      assertSeriesBitwiseEqual(rawSeries, normSeries, `T5a-a ${c.name}（raw=${c.raw} → 归一=${c.norm}）`);
    }
  });

  it('T5a-b 归一后的生效位置 = 各自的 (n_i + m − 1)（独立佐证：不是「都没归一」）', () => {
    const p = params({ n_s: 3, n_m: 3, n_l: 3, smooth: 1, m: 2 });
    const series = computeDcapSeries(SYNTH_40, p);
    // 归一后 (n_s, n_m', n_l') = (3, 4, 5) ⇒ 首个有值下标 = n_i + m − 2 = 3 / 4 / 5
    expect(firstNonNull(series, 's'), 'T5a-b s 线首值下标（3+2−2=3）').toBe(3);
    expect(firstNonNull(series, 'm'), 'T5a-b m 线首值下标（4+2−2=4，未归一则为 3）').toBe(4);
    expect(firstNonNull(series, 'l'), 'T5a-b l 线首值下标（5+2−2=5，未归一则为 3）').toBe(5);
    // 反「一刀切」：三线首值位置必须互不相同
    expect(
      new Set([firstNonNull(series, 's'), firstNonNull(series, 'm'), firstNonNull(series, 'l')]).size,
      'T5a-b 三线首值位置必须互不相同（若相同 ⇒ 很可能用了同一个 n）',
    ).toBe(3);
  });

  it('T5a-c 幂等：已归一三元组再进入口 ⇒ 输出不变（逐位）', () => {
    const base = params({ r_s: 1.05, r_m: 1, r_l: 1.2, smooth: 1, m: 4 });
    const raw: [number, number, number] = [6, 6, 6];
    const norm: [number, number, number] = [6, 7, 8];
    const p = (n: [number, number, number]) =>
      computeDcapSeries(SYNTH_40, { ...base, n_s: n[0], n_m: n[1], n_l: n[2] });

    const viaRaw = p(raw);
    const viaNormOnce = p(norm);
    const viaNormTwice = p(norm); // 归一后的值再次进入口（f(f(x)) 的可观测形式）
    assertSeriesBitwiseEqual(viaRaw, viaNormOnce, 'T5a-c f(raw) ≡ f(normalized)');
    assertSeriesBitwiseEqual(viaNormOnce, viaNormTwice, 'T5a-c f(normalized) ≡ f(f(normalized))');
  });

  it('T5a-d 确定：同输入重复调用逐位相同（无全局状态）', () => {
    const p = params({ n_s: 5, n_m: 5, n_l: 5, r_s: 1, r_m: 1.2, r_l: 1.5, smooth: 1, m: 3 });
    const a = computeDcapSeries(SYNTH_40, p);
    // 用另一组参数插在中间，验证入口不残留状态
    computeDcapSeries(SYNTH_40, params({ n_s: 2, n_m: 7, n_l: 9, smooth: 1, m: 5 }));
    const b = computeDcapSeries(SYNTH_40, p);
    assertSeriesBitwiseEqual(b, a, 'T5a-d 同输入两次调用');
  });

  it('T5a-e smooth=0 时同样按归一后窗口生效（逐位，不减配）', () => {
    const base = params({ smooth: 0, m: 3, r_s: 1, r_m: 1, r_l: 1 });
    const raw = computeDcapSeries(SYNTH_40, { ...base, n_s: 4, n_m: 4, n_l: 4 });
    const norm = computeDcapSeries(SYNTH_40, { ...base, n_s: 4, n_m: 5, n_l: 6 });
    assertSeriesBitwiseEqual(raw, norm, 'T5a-e smooth=0：raw(4,4,4) ≡ norm(4,5,6)');
    // smooth=0 时首个有值下标 = n_i − 1（归一后）⇒ s=3 / m=4 / l=5
    expect(firstNonNull(raw, 's'), 'T5a-e s 首值下标（smooth=0：4−1）').toBe(3);
    expect(firstNonNull(raw, 'm'), 'T5a-e m 首值下标（smooth=0：5−1）').toBe(4);
    expect(firstNonNull(raw, 'l'), 'T5a-e l 首值下标（smooth=0：6−1）').toBe(5);
  });
});
