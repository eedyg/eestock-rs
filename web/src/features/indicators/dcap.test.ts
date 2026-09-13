/**
 * dcap 指标 —— T1 / T2 测试
 *
 * 本文件位置：web/src/features/indicators/dcap.test.ts
 * 被测产物：web/src/features/indicators/dcap.ts
 *   （entangled 由 design/14-dcap-indicator/02-spec.md 的 CORE 块生成，ADR-021 D2/D4）
 * 权威口径：design/14-dcap-indicator/{02-spec.md §1/§3/§4, 03-test-plan.md §0/T1/T2}
 * 运行：cd web && npx vitest run src/features/indicators/dcap.test.ts
 *
 * ── 等价层级（03-test-plan §0，本文件严格遵守）──────────────────────────────
 * T1 = **容差相等**（|Δ| ≤ 1e-12）：`ΣA/P` 与 `1/HM` 两种代数排列的求和序天生不同，
 *      实测差 ~1e-16（示例见 T1-a/T1-b）；两种合法累加序（权重 1/r^k 自最新往回
 *      vs r^(k-1) 自最旧往前）实测差 2.2e-16。故本文件对 **任何 r 值** 都只用
 *      1e-12 容差断言，**不冻结任何浮点位**（逐位断言只属于 T2/T3/T4）。
 * T2 = **逐位相等**（IEEE754 位串，含 null 位置）：smooth=0 的输出必须与未平滑原始
 *      ROI 逐位相同（02-spec §3「开关关闭」行 / §8 裁决 6）。
 */

import { describe, expect, it } from 'vitest';

import { computeDcapSeries, dcapRoi, smoothSeries } from './dcap';
import type { DcapParams, DcapValues } from './dcap';

// ---------------------------------------------------------------------------
// 浮点位串工具（「逐位相同」的可机械判定形式）
// ---------------------------------------------------------------------------

const bitsView = new DataView(new ArrayBuffer(8));

/** f64 → 64 位十六进制位串；非 number（null/undefined/undefined 缺字段）不参与位比较。 */
function bitsOf(v: unknown): string {
  if (typeof v !== 'number') {
    return `非数值(${String(v)})`;
  }
  bitsView.setFloat64(0, v, false);
  return bitsView.getBigUint64(0, false).toString(16).padStart(16, '0');
}

/** 三线值对象 → 位串三元组（字段缺失与 null 必须可区分）。 */
function valuesBits(v: DcapValues | undefined): string[] {
  return [bitsOf(v?.s), bitsOf(v?.m), bitsOf(v?.l)];
}

/**
 * 逐位断言谓词（T2/T4 共用形态）。
 * 特别注意：**内部用 expect** ⇒ 违反时抛 AssertionError，
 * 因此「哨兵」用例可以用 toThrow 验证本谓词确有鉴别力（见 T2-d）。
 */
function assertSeriesBitwiseEqual(
  actual: readonly unknown[],
  expected: readonly unknown[],
  label: string,
): void {
  expect(actual.length, `${label}：长度必须相同`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(
      bitsOf(actual[i]),
      `${label}：index ${i} 位串不同（actual=${String(actual[i])} expected=${String(expected[i])}）`,
    ).toBe(bitsOf(expected[i]));
  }
}

function assertValuesAtBarBitwiseEqual(
  actual: DcapValues | undefined,
  expected: DcapValues | undefined,
  label: string,
): void {
  const a = valuesBits(actual);
  const b = valuesBits(expected);
  for (let i = 0; i < b.length; i++) {
    expect(a[i], `${label}：字段 ${['s', 'm', 'l'][i]} 位串不同（${a[i]} vs ${b[i]}）`).toBe(b[i]);
  }
}

function assertSeriesOfValuesBitwiseEqual(
  actual: readonly (DcapValues | undefined)[],
  expected: readonly (DcapValues | undefined)[],
  label: string,
): void {
  expect(actual.length, `${label}：长度必须相同`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    assertValuesAtBarBitwiseEqual(actual[i], expected[i], `${label}：bar ${i}`);
  }
}

// ---------------------------------------------------------------------------
// 容差断言（仅 T1 使用）
// ---------------------------------------------------------------------------

const TOL = 1e-12;

function assertClose(actual: number | null, expected: number, label: string): void {
  expect(actual, `${label}：应有值（不得为 null）`).not.toBeNull();
  const a = actual as number;
  expect(
    Math.abs(a - expected),
    `${label}：|Δ| ≤ ${TOL}（actual=${a} expected=${expected}）`,
  ).toBeLessThanOrEqual(TOL);
}

// ---------------------------------------------------------------------------
// 测试内参考实现（仅为「口径参照」，不参与生产代码、不参与逐位判定）
// ---------------------------------------------------------------------------

const HAND_CLOSES: number[] = [100, 90, 95];

/**
 * 遗留 DCAP 参考式（02-spec §1.2）：
 * golang/analysis/dcap_kdj_winrate.py、golang/pkg/histview/web.go 的
 *   `close / harmonic_mean(last_N_closes) − 1`
 * 求和序：自最新往回（与 02-spec §0 对累加序的要求一致）。
 */
function legacyDcap(closes: readonly number[], n: number): number {
  const win = closes.slice(-n);
  let inv = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    inv += 1 / win[i]!;
  }
  return win[win.length - 1]! / (win.length / inv) - 1;
}

/** 滑窗 SMA(m) 参考实现（忽略 null 前导）；**仅供哨兵 impl 使用，非逐位基准**。 */
function smaRef(values: readonly (number | null)[], m: number): (number | null)[] {
  const out: (number | null)[] = [];
  const win: number[] = [];
  let sum = 0;
  for (const v of values) {
    if (v === null) {
      out.push(null);
      continue;
    }
    win.push(v);
    sum += v;
    if (win.length > m) {
      sum -= win.shift()!;
    }
    out.push(win.length < m ? null : sum / m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 真实数据抽样（冻结回归基准）——数据面**只读**抽样
// ---------------------------------------------------------------------------
//
// 抽样命令（2026-09-13，只读 SELECT，未写库；未触碰生产线/未启动服务）：
//   psql "postgres://eestock:eestock@127.0.0.1:5433/eestock" \
//     -At -c "SET extra_float_digits=3;
//            SELECT ts::text || '|' || close::text FROM kline_accurate_15m
//            WHERE code='518880' ORDER BY ts DESC LIMIT 64"
// 冻结区间（oldest → newest）：2026-09-04 03:30+00 → 2026-09-11 07:00+00，共 64 根 M15 close。
// 结构：kline_accurate_15m 为 M1 聚合的 15m 连续聚合视图（migrations/0010）。
const REAL_518880_M15_64: number[] = [
  9.197, 9.188, 9.187, 9.196, 9.192, 9.185, 9.188, 9.176, 9.161, 9.164, 9.061, 9.062, 9.047, 9.054,
  9.066, 9.058, 9.057, 9.057, 9.058, 9.045, 9.054, 9.048, 9.034, 9.027, 9.025, 9.03, 9.024, 9.024,
  9.101, 9.089, 9.094, 9.084, 9.067, 9.045, 9.054, 9.048, 9.047, 9.017, 9.012, 9.027, 9.039, 9.041,
  9.03, 9.039, 9.042, 9.041, 9.073, 9.073, 9.096, 9.096, 9.076, 9.072, 9.087, 9.084, 9.083, 8.906,
  8.907, 8.922, 8.935, 8.958, 8.941, 8.938, 8.942, 8.943,
];

/** 参数工厂：默认给一组满足强制约束 n_s < n_m < n_l 的最小合法参数。 */
function params(over: Partial<DcapParams> = {}): DcapParams {
  return { n_s: 2, n_m: 3, n_l: 4, r_s: 1, r_m: 1, r_l: 1, smooth: 0, m: 3, ...over };
}

/** 确定性长序列（纯算术构造，无 RNG / 无时间依赖）：20 根，供 r 变化与 null 区覆盖。 */
const SYNTH_20: number[] = Array.from({ length: 20 }, (_, i) => 10 + (((i * 37) % 11) - 5) * 0.3);

// ===========================================================================
// T1 —— 口径基准：r = 1 ≡ 遗留 DCAP（**容差** 1e-12）
// ===========================================================================

describe('T1 口径基准：r=1 ≡ 遗留 DCAP（容差 1e-12）', () => {
  it('T1-a 手算样例 closes=[100,90,95] n=3 r=1：本指标 ≡ 遗留 DCAP ≡ 0.0018518518518517713', () => {
    const our = dcapRoi(HAND_CLOSES, 3, 1);
    const legacy = legacyDcap(HAND_CLOSES, 3);

    // 遗留式自身的冻结值（03-test-plan T1 给定）
    assertClose(legacy, 0.0018518518518519933, 'T1-a 遗留 DCAP 冻结值');
    // 本指标口径冻结值（03-test-plan T1 给定）
    assertClose(our, 0.0018518518518517713, 'T1-a 本指标冻结值');
    // 核心口径：r=1 时本指标 ≡ 遗留 DCAP
    assertClose(our, legacy, 'T1-a 本指标 vs 遗留 DCAP');
  });

  it('T1-b 手算样例 closes=[100,90,95] n=3 r=1.2：冻结值 0.0045787545787547845（容差，非逐位）', () => {
    // 该值依赖累加序：实测两种合法排布分别得 …7547845 / …7545625（差 2.2e-16）
    // ⇒ 断言容差固定 1e-12（03-test-plan T1 明确：不得用 1e-15）。
    assertClose(dcapRoi(HAND_CLOSES, 3, 1.2), 0.0045787545787547845, 'T1-b r=1.2 冻结值');
    // r≠1 时**不得**与遗留式相等（否则 r 参数没生效）
    const legacy = legacyDcap(HAND_CLOSES, 3);
    expect(
      Math.abs((dcapRoi(HAND_CLOSES, 3, 1.2) as number) - legacy),
      'T1-b：r=1.2 必须偏离遗留 DCAP（r 参数被忽略时会静默相等）',
    ).toBeGreaterThan(1e-3);
  });

  it('T1-c 数据不足：可用 bar 数 < n ⇒ null（不抛错）', () => {
    expect(dcapRoi(HAND_CLOSES, 4, 1)).toBeNull();
    expect(dcapRoi([], 3, 1)).toBeNull();
    expect(dcapRoi([100], 2, 1)).toBeNull();
    expect(dcapRoi(HAND_CLOSES, 3, 1)).not.toBeNull();
  });

  it('T1-d 真实 15m 抽样冻结回归：单线 ROI（n=60/26/8 × r=1.0/1.2，容差）', () => {
    const c = REAL_518880_M15_64;
    // 冻结值取自「最近 n 根」窗口（正确窗口 = 数组尾部 n 根）；两种合法排列实测差 ≤ 1e-15。
    assertClose(dcapRoi(c, 60, 1.0), -0.011674411920738925, 'T1-d n=60 r=1.0');
    assertClose(dcapRoi(c, 26, 1.0), -0.007990502969230762, 'T1-d n=26 r=1.0');
    assertClose(dcapRoi(c, 8, 1.0), 0.0008139126723081258, 'T1-d n=8 r=1.0');
    assertClose(dcapRoi(c, 60, 1.2), -0.0022963360597847426, 'T1-d n=60 r=1.2');
    assertClose(dcapRoi(c, 26, 1.2), -0.0022123890643179767, 'T1-d n=26 r=1.2');
    assertClose(dcapRoi(c, 8, 1.2), 0.0004516499227451565, 'T1-d n=8 r=1.2');
  });

  it('T1-e 真实 15m 抽样冻结回归：r=1 时 n=60 与本测试内遗留式一致（容差）', () => {
    const c = REAL_518880_M15_64;
    const our = dcapRoi(c, 60, 1.0);
    const legacy = legacyDcap(c, 60);
    assertClose(legacy, -0.011674411920738814, 'T1-e 遗留式冻结值');
    assertClose(our, legacy, 'T1-e r=1 本指标 vs 遗留 DCAP（真实 64 根）');
  });

  it('T1-f 真实 15m 抽样冻结回归：默认三线（smooth=1, m=3）末根三值 + 首次有值位置', () => {
    const c = REAL_518880_M15_64;
    const p = params({ n_s: 8, n_m: 26, n_l: 60, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 3 });
    const last = computeDcapSeries(c, p).at(-1);
    assertClose(last?.s ?? null, 0.00028966107001308455, 'T1-f 末根 s');
    assertClose(last?.m ?? null, -0.008571441774230748, 'T1-f 末根 m');
    assertClose(last?.l ?? null, -0.012349115526361643, 'T1-f 末根 l');

    const p12 = params({ n_s: 8, n_m: 26, n_l: 60, r_s: 1.2, r_m: 1.2, r_l: 1.2, smooth: 1, m: 3 });
    const last12 = computeDcapSeries(c, p12).at(-1);
    assertClose(last12?.s ?? null, 0.00018787644132038187, 'T1-f(r=1.2) 末根 s');
    assertClose(last12?.m ?? null, -0.0029321814752066855, 'T1-f(r=1.2) 末根 m');
    assertClose(last12?.l ?? null, -0.0030166951270530484, 'T1-f(r=1.2) 末根 l');

    // 首次有值位置必须按各自 n_i + m − 1 根（bar index = n_i + m − 2）
    const firstValid = (idx: 0 | 1 | 2): number =>
      computeDcapSeries(c, p).findIndex((v: DcapValues) => [v.s, v.m, v.l][idx] !== null);
    expect(firstValid(0), 'T1-f s 线首次有值位置（n_s=8, m=3 ⇒ index 9）').toBe(9);
    expect(firstValid(1), 'T1-f m 线首次有值位置（n_m=26, m=3 ⇒ index 27）').toBe(27);
    expect(firstValid(2), 'T1-f l 线首次有值位置（n_l=60, m=3 ⇒ index 61）').toBe(61);
  });
});

// ===========================================================================
// T2 —— 开关关闭 == 原始值（**逐位**，含 null 位置）
// ===========================================================================

describe('T2 开关关闭 == 未平滑原始 ROI（逐位相等，含 null 位置）', () => {
  const inputs: Array<{ label: string; closes: number[] }> = [
    { label: '手算 3 根', closes: HAND_CLOSES },
    { label: '合成 20 根', closes: SYNTH_20 },
    { label: '真实 15m 64 根', closes: REAL_518880_M15_64 },
    { label: '空序列', closes: [] },
  ];

  it('T2-a smooth=0 与 (smooth=1, m=1) 两条路径逐位相同', () => {
    for (const { label, closes } of inputs) {
      const off = computeDcapSeries(closes, params({ smooth: 0, m: 3 }));
      const m1 = computeDcapSeries(closes, params({ smooth: 1, m: 1 }));
      assertSeriesOfValuesBitwiseEqual(off, m1, `T2-a[${label}] smooth=0 vs m=1`);
    }
  });

  it('T2-b smooth=0 每条线逐 bar === 未平滑原始 ROI（用 dcapRoi 独立复算，null 位置必须一致）', () => {
    const p = params({ n_s: 2, n_m: 3, n_l: 4, r_s: 1, r_m: 1.2, r_l: 0.9, smooth: 0, m: 3 });
    const closes = SYNTH_20;
    const series = computeDcapSeries(closes, p);

    expect(series.length, 'T2-b series 长度必须 === closes 长度').toBe(closes.length);
    for (let i = 0; i < closes.length; i++) {
      const prefix = closes.slice(0, i + 1);
      // 独立复算（窗口局部：只依赖 closes[..=i]；若实现用 running sum 增量优化，位串会不同）
      const expected: DcapValues = {
        s: dcapRoi(prefix, p.n_s, p.r_s),
        m: dcapRoi(prefix, p.n_m, p.r_m),
        l: dcapRoi(prefix, p.n_l, p.r_l),
      };
      assertValuesAtBarBitwiseEqual(series[i], expected, `T2-b smooth=0 bar ${i}`);
    }
    // null 位置必须精确对齐各自窗口（否则本用例退化为平凡）：index 0 三线全缺；
    // s 自 index 1（n_s=2）有值、m 自 index 2（n_m=3）、l 自 index 3（n_l=4）。
    assertValuesAtBarBitwiseEqual(series[0], { s: null, m: null, l: null }, 'T2-b 首根三线全缺');
    expect(series[1]?.s, 'T2-b index 1 的 s 线应有值').not.toBeNull();
    expect(series[1]?.m, 'T2-b index 1 的 m 线应仍缺').toBeNull();
    expect(series[2]?.m, 'T2-b index 2 的 m 线应有值').not.toBeNull();
    expect(series[2]?.l, 'T2-b index 2 的 l 线应仍缺').toBeNull();
    expect(series[3]?.l, 'T2-b index 3 的 l 线应有值').not.toBeNull();
  });

  it('T2-c smoothSeries 直通契约（smooth=0 或 m<=1 ⇒ 直通原值）且平滑分支非退化', () => {
    const raw: (number | null)[] = [null, null, 0.01, -0.02, 0.03, 0.0];
    assertSeriesBitwiseEqual(smoothSeries(raw, 0, 3), raw, 'T2-c smoothSeries(smooth=0)');
    assertSeriesBitwiseEqual(smoothSeries(raw, 1, 1), raw, 'T2-c smoothSeries(m=1)');
    assertSeriesBitwiseEqual(smoothSeries(raw, 1, 0), raw, 'T2-c smoothSeries(m=0 ⇒ 直通)');

    const noNull: (number | null)[] = [0.01, -0.02, 0.03, 0.04, -0.05];
    const smoothed = smoothSeries(noNull, 1, 3);
    expect(
      bitsOf(smoothed.at(-1)),
      'T2-c 平滑必须真的改变数值（否则 smooth 分支是死的，T2-a/b 会变得平凡）',
    ).not.toBe(bitsOf(noNull.at(-1)));
  });

  it('T2-d 哨兵：可注入的「近似直通 / 吞掉前导 null」等价实现必须被判红', () => {
    type SmoothFn = (values: (number | null)[], smooth: number, m: number) => (number | null)[];

    // 断言有效性验证器：对任意可注入 impl 施加「smooth=0 必须与原始值逐位相同」的判据
    const assertSmoothOffIsRaw = (fn: SmoothFn, values: (number | null)[], m: number): void => {
      assertSeriesBitwiseEqual(fn(values, 0, m), values, '哨兵: smooth=0 vs raw');
    };

    // ① 合规 impl（口径内直通）⇒ 判据**不得**报红（防止判据「恒红」的退化）
    const compliant: SmoothFn = (values, smooth, m) =>
      smooth === 0 || m <= 1 ? values.slice() : smaRef(values, m);
    expect(() => assertSmoothOffIsRaw(compliant, [null, 0.01, -0.02], 3)).not.toThrow();

    // ② 近似直通（× (1+1e-10)）⇒ 必须报红（03-test-plan T2 反向哨兵）
    const approx: SmoothFn = (values, smooth, m) => {
      if (smooth !== 0) {
        return compliant(values, smooth, m);
      }
      return values.map((v) => (v === null ? null : v * 1.0000000001));
    };
    expect(() => assertSmoothOffIsRaw(approx, [null, 0.01, -0.02], 3)).toThrow();

    // ③ +1 ulp 级近似（Number.EPSILON）⇒ 同样必须报红（逐位判据的最小可检差异）
    const oneUlp: SmoothFn = (values, smooth, m) => {
      if (smooth !== 0) {
        return compliant(values, smooth, m);
      }
      return values.map((v) => (v === null ? null : v + Number.EPSILON));
    };
    expect(() => assertSmoothOffIsRaw(oneUlp, [null, 0.01, -0.02], 3)).toThrow();

    // ④ 直通但吞掉前导 null（位置错位）⇒ 必须报红（覆盖「含 null 位置」要求）
    const dropLeadingNulls: SmoothFn = (values, smooth, m) => {
      if (smooth !== 0) {
        return compliant(values, smooth, m);
      }
      const out = values.slice();
      while (out.length > 0 && out[0] === null) {
        out.shift();
      }
      return out;
    };
    expect(() => assertSmoothOffIsRaw(dropLeadingNulls, [null, null, 0.01], 3)).toThrow();

    // ⑤ 生产模块的 smoothSeries 在同一判据下**必须不报红**（哨兵与真断言共用同一谓词）
    expect(() =>
      assertSmoothOffIsRaw(
        (values, smooth, m) => smoothSeries(values, smooth, m),
        [null, 0.01, -0.02],
        3,
      ),
    ).not.toThrow();
  });
});
