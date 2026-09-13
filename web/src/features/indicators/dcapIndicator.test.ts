/**
 * dcap 指标 —— P3 前端图表接线（T8 前置单测）
 *
 * 本文件位置：`web/src/features/indicators/dcapIndicator.test.ts`
 * 被测文件：  `web/src/features/indicators/dcapIndicator.ts`（手写；klinecharts registerIndicator 注册层）
 * 权威口径：  `design/14-dcap-indicator/02-spec.md` §6（图表契约 C）
 * 运行：      cd web && npx vitest run src/features/indicators/dcapIndicator.test.ts
 *
 * 覆盖：
 *  ① 注册面：名 DCAP、3 个 figure（s/m/l）、**precision 显式 5**、无 paneId（副图由 createIndicator 决定）；
 *  ② calc 面：calcParams（8 参，不含 th）→ computeDcapSeries 逐根对齐；数据不足 → null（断线）；
 *  ③ 降级面：空/非数组/计算抛异常等任何异常都必须降级为「全 null 断线」，**不得抛出**打断渲染；
 *  ④ 参数面：dcapCalcParams / dcapParamsFromCalcParams（缺参回默认）/ dcapWarmupBars（n_l+m−1）/ 校验规则；
 *  ⑤ 幂等：ensureDcapIndicatorRegistered 重复调用只注册一次。
 */
import { describe, it, expect, vi } from 'vitest';

const kc = vi.hoisted(() => ({ registerIndicator: vi.fn() }));
vi.mock('klinecharts', () => ({ registerIndicator: kc.registerIndicator }));

import {
  DCAP_INDICATOR_NAME,
  DCAP_INDICATOR_TEMPLATE,
  DCAP_PRECISION,
  DEFAULT_DCAP_PARAMS,
  dcapCalcParams,
  dcapParamsFromCalcParams,
  dcapWarmupBars,
  ensureDcapIndicatorRegistered,
  validateDcapParams,
} from './dcapIndicator';
import { computeDcapSeries, type DcapValues } from './dcap';

/** 递增收盘价序列（n 根） */
function rampCloses(n: number, start = 100, step = 0.5): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

type CalcFn = (dataList: unknown[], indicator: unknown) => DcapValues[];
const calc = DCAP_INDICATOR_TEMPLATE.calc as unknown as CalcFn;

function values(dataList: unknown[], calcParams: number[]): DcapValues[] {
  return calc(dataList, { calcParams });
}

describe('DCAP 注册面（design/14-dcap-indicator/02-spec.md §6）', () => {
  it('指标名/短名 = DCAP；3 个 figure = s/m/l（均为 line）；precision 显式 5', () => {
    expect(DCAP_INDICATOR_NAME).toBe('DCAP');
    expect(DCAP_INDICATOR_TEMPLATE.name).toBe('DCAP');
    expect(DCAP_INDICATOR_TEMPLATE.shortName).toBe('DCAP');
    expect(DCAP_PRECISION).toBe(5);
    expect(DCAP_INDICATOR_TEMPLATE.precision).toBe(5);
    const figures = DCAP_INDICATOR_TEMPLATE.figures!;
    expect(figures.map((f) => f.key)).toEqual(['s', 'm', 'l']);
    expect(figures.every((f) => f.type === 'line')).toBe(true);
  });

  it('模板不带 paneId（不得叠 candle_pane：副图 pane 由 createIndicator(isStack=true) 建）', () => {
    expect('paneId' in DCAP_INDICATOR_TEMPLATE).toBe(false);
    expect('yAxisId' in DCAP_INDICATOR_TEMPLATE).toBe(false);
  });

  it('calcParams 默认 = [n_s,n_m,n_l,r_s,r_m,r_l,smooth,m]（8 参，不含 th）', () => {
    expect(DCAP_INDICATOR_TEMPLATE.calcParams).toEqual([8, 26, 60, 1, 1, 1, 1, 3]);
    expect(dcapCalcParams(DEFAULT_DCAP_PARAMS)).toEqual([8, 26, 60, 1, 1, 1, 1, 3]);
  });

  it('ensureDcapIndicatorRegistered 幂等：重复调用只注册一次，注册参数即模板', () => {
    expect(kc.registerIndicator).not.toHaveBeenCalled();
    ensureDcapIndicatorRegistered();
    ensureDcapIndicatorRegistered();
    expect(kc.registerIndicator).toHaveBeenCalledTimes(1);
    expect(kc.registerIndicator).toHaveBeenCalledWith(DCAP_INDICATOR_TEMPLATE);
  });
});

describe('DCAP calc 面（数据不足 → null 断线；计算对齐 computeDcapSeries）', () => {
  const closes = rampCloses(70);
  const dataList = closes.map((close, i) => ({ timestamp: 1_700_000_000_000 + i * 60_000, close }));

  it('逐根与 computeDcapSeries（归一后同参数）逐位对齐，长度 = 数据长度', () => {
    const got = values(dataList, dcapCalcParams(DEFAULT_DCAP_PARAMS));
    const want = computeDcapSeries(closes, DEFAULT_DCAP_PARAMS) as DcapValues[];
    expect(got).toHaveLength(closes.length);
    expect(want).toHaveLength(closes.length);
    for (let i = 0; i < closes.length; i++) {
      expect(got[i]).toStrictEqual(want[i]);
    }
  });

  it('数据不足 → null（每线各自 n_i + m − 1 首值：s=9 / m=27 / l=61；l 在 index 60 仍 null）', () => {
    const got = values(dataList, dcapCalcParams(DEFAULT_DCAP_PARAMS));
    expect(got[0]).toStrictEqual({ s: null, m: null, l: null });
    expect(got[9]!.s).not.toBeNull();
    expect(got[8]!.s).toBeNull();
    expect(got[27]!.m).not.toBeNull();
    expect(got[26]!.m).toBeNull();
    expect(got[61]!.l).not.toBeNull();
    expect(got[60]!.l).toBeNull();
    // 视口最左（warmup 后）已断线的反例：前 n_l+m−1 根无 l 值
    expect(got.slice(0, 61).every((v) => v.l === null)).toBe(true);
  });

  it('calcParams 生效：改 n_s=5/n_m=10/n_l=20/m=1 → 首值位置随参数变化', () => {
    const got = values(dataList, [5, 10, 20, 1, 1, 1, 0, 1]);
    expect(got[4]!.s).not.toBeNull(); // smooth=0 → n=5 起有值
    expect(got[3]!.s).toBeNull();
    expect(got[19]!.l).not.toBeNull();
    expect(got[18]!.l).toBeNull();
  });

  it('非单调 n（26/26/26）→ 入口归一化仍产出单调三线（不抛错）', () => {
    // 归一化：n_m ← max(26, 26+1) = 27、n_l ← max(26, 27+1) = 28 ⇒ 首值 s=27 / m=28 / l=29
    const got = values(dataList, [26, 26, 26, 1, 1, 1, 1, 3]);
    expect(got[27]!.s).not.toBeNull();
    expect(got[26]!.s).toBeNull();
    expect(got[28]!.m).not.toBeNull();
    expect(got[27]!.m).toBeNull();
    expect(got[29]!.l).not.toBeNull();
    expect(got[28]!.l).toBeNull();
  });
});

describe('DCAP calc 降级面（任何异常 → 断线，不抛、不打断渲染）', () => {
  it('空数据 → 空数组', () => {
    expect(values([], dcapCalcParams(DEFAULT_DCAP_PARAMS))).toEqual([]);
  });

  it('非数组 dataList → 空数组（不抛）', () => {
    expect(() => values(undefined as unknown as unknown[], [8, 26, 60, 1, 1, 1, 1, 3])).not.toThrow();
    expect(values(undefined as unknown as unknown[], [8, 26, 60, 1, 1, 1, 1, 3])).toEqual([]);
  });

  it('bar.close 读取抛异常 → 降级为全 null（长度对齐），不向外抛', () => {
    const evil = [
      { get close(): number { throw new Error('boom'); } },
      { get close(): number { throw new Error('boom'); } },
    ];
    let got: DcapValues[] = [];
    expect(() => { got = values(evil, [8, 26, 60, 1, 1, 1, 1, 3]); }).not.toThrow();
    expect(got).toStrictEqual([
      { s: null, m: null, l: null },
      { s: null, m: null, l: null },
    ]);
  });

  it('calcParams 缺失/非法 → 回默认参数，仍不抛（非法 n 由 CORE 归一化兜底）', () => {
    const dataList = rampCloses(70).map((close) => ({ close }));
    expect(() => values(dataList, undefined as unknown as number[])).not.toThrow();
    const got = values(dataList, undefined as unknown as number[]);
    expect(got).toHaveLength(70);
    expect(got[61]!.l).not.toBeNull(); // 默认 n_l=60 → 61 起有值
  });
});

describe('DCAP 参数工具与校验（02-spec §2 范围 + §7 跨字段 n_s<n_m<n_l）', () => {
  it('dcapParamsFromCalcParams：[8,26,60,1,1,1,1,3] → 完整参数；缺参回默认', () => {
    expect(dcapParamsFromCalcParams([8, 26, 60, 1, 1, 1, 1, 3])).toStrictEqual(DEFAULT_DCAP_PARAMS);
    expect(dcapParamsFromCalcParams([])).toStrictEqual(DEFAULT_DCAP_PARAMS);
    expect(dcapParamsFromCalcParams([5, 10, 20, 1.2, 1.2, 1.2, 0, 5])).toStrictEqual({
      n_s: 5, n_m: 10, n_l: 20, r_s: 1.2, r_m: 1.2, r_l: 1.2, smooth: 0, m: 5,
    });
  });

  it('dcapWarmupBars = n_l + m − 1（默认 60+3−1=62；上界 250+60−1=309）', () => {
    expect(dcapWarmupBars(DEFAULT_DCAP_PARAMS)).toBe(62);
    expect(dcapWarmupBars({ ...DEFAULT_DCAP_PARAMS, n_l: 250, m: 60 })).toBe(309);
  });

  it('validateDcapParams：默认合法；非单调 n / 越界 / 非整数 / 非法 r / smooth / m 一律拒绝', () => {
    expect(validateDcapParams(DEFAULT_DCAP_PARAMS)).toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, n_s: 26, n_m: 26 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, n_m: 60, n_l: 26 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, n_s: 1 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, n_l: 251 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, n_s: 8.5 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, r_s: 0.49 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, r_l: 2.01 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, smooth: 2 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, m: 0 })).not.toBeNull();
    expect(validateDcapParams({ ...DEFAULT_DCAP_PARAMS, m: 61 })).not.toBeNull();
  });
});
