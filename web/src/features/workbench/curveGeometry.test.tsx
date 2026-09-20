import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { AggregateScoreChart } from './AggregateScoreChart';
import { EquityDrawdownChart } from './EquityDrawdownChart';
import { PositionRatioChart } from './PositionRatioChart';
import { CURVE_PAD, CURVE_W } from './curveGeometry';
import type { CurveXDomain } from './chartUtils';

/**
 * ADR-028 D5（§2.4c 第 5 项）——四张曲线**绘图区 PAD 单一事实源** + 取值钉死。
 *
 * 背景（本波裁决，2026-09-20）：
 *  - 修复前：聚合/各策略 `PAD=8`、净值/持仓 `PAD=10` ⇒ 跨视图同一根 bar 的 userX 恒差 2.0 user unit
 *    （666px 卡宽 / viewBox 1070.82 ⇒ **1.244px**）；
 *  - 冻结规格 `web/e2e/adr028-axis-align-probe.e2e.ts` L54-57 把校准口径**硬编码**为 `PAD=8`
 *    （`predictIndexUserX(j) = 8 + j/(N-1)*984`），并在 L1630-1633 以 `indexResidualMaxUser ≤ 1` 做
 *    「配对自洽」硬断言 ⇒ **PAD 只能统一到 8**（统一到 10 会让该规格主断言必红）。
 *  - ⇒ 本文件把「单一事实源 + 取值 = 8」写成守卫：**改它必须同步改上述冻结规格**（跨仓契约变更）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));

describe('G0 取值钉死：CURVE_PAD === 8（锚定冻结规格 adr028-axis-align-probe 的校准口径）', () => {
  it('CURVE_PAD 必须恰为 8；改它必须同步改冻结规格（跨仓契约变更）', () => {
    expect(
      CURVE_PAD,
      'CURVE_PAD 是四张曲线唯一的绘图内边距来源；其取值锚定 web/e2e/adr028-axis-align-probe.e2e.ts 的 CURVE_PAD=8/PLOT_W=984',
    ).toBe(8);
    expect(CURVE_W).toBe(1000);
  });
});

describe('G1 单一事实源：四张曲线不得各自声明 PAD/W，必须从 curveGeometry 导入', () => {
  const charts = ['AggregateScoreChart.tsx', 'SlotScoresChart.tsx', 'EquityDrawdownChart.tsx', 'PositionRatioChart.tsx'];
  for (const f of charts) {
    it(`${f} 从 curveGeometry 导入 CURVE_PAD/CURVE_W，且不得再出现自有 const PAD / const W`, () => {
      const src = readFileSync(resolve(HERE, f), 'utf8');
      expect(/(^|\n)\s*const PAD\s*=/.test(src), `${f} 不得声明自有 PAD（四处收敛为一处）`).toBe(false);
      expect(/(^|\n)\s*const W\s*=/.test(src), `${f} 不得声明自有 W`).toBe(false);
      expect(
        /import\s*\{[^}]*\bCURVE_PAD\b[^}]*\}\s*from\s*'\.\/curveGeometry'/.test(src),
        `${f} 必须从 ./curveGeometry 导入 CURVE_PAD`,
      ).toBe(true);
      expect(src, `${f} 不得再出现字面量 PAD 常量入口`).not.toMatch(/const\s+PAD\s*=/);
    });
  }
});

/** 索引定义域 fixture：5 根 bar 的 ts（M5 均匀）。 */
const BAR_TS = [1_700_000_000, 1_700_000_300, 1_700_000_600, 1_700_000_900, 1_700_001_200];
const XD: CurveXDomain = { mode: 'index', barTs: BAR_TS, toleranceSec: 2 };

/** 读第一根 polyline 的 userX 首末（x 映射判据）。 */
function polyEnds(host: HTMLElement, testid?: string): { first: number; last: number } {
  const sel = testid ? `polyline[data-testid="${testid}"]` : 'polyline';
  const poly = host.querySelector(sel);
  if (!poly) throw new Error(`未找到 polyline ${testid ?? ''}`);
  const xs = (poly.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .map((t) => Number(t.split(',')[0]))
    .filter((v) => Number.isFinite(v));
  return { first: xs[0]!, last: xs[xs.length - 1]! };
}

describe('G2 运行期几何：三张（可脱离服务端 fixture 渲染的）曲线 plot 左右边界必须 = CURVE_PAD / CURVE_W − CURVE_PAD', () => {
  it('聚合分曲线', () => {
    const perBar = BAR_TS.map((ts, i) => ({ ts, aggregate: 50 + i }) as never);
    const { container } = render(
      <AggregateScoreChart perBar={perBar} buyThreshold={70} sellThreshold={30} xDomain={XD} plot={null} />,
    );
    const host = container.querySelector('[data-testid="wb-aggregate-chart"]') as HTMLElement;
    expect(polyEnds(host)).toEqual({ first: CURVE_PAD, last: CURVE_W - CURVE_PAD });
  });

  it('净值+回撤曲线', () => {
    const netValue: Array<[number, number]> = BAR_TS.map((ts, i) => [ts, 100 + i]);
    const { container } = render(
      <EquityDrawdownChart netValue={netValue} drawdown={netValue} xDomain={XD} plot={null} />,
    );
    const host = container.querySelector('[data-testid="wb-equity-chart"]') as HTMLElement;
    expect(polyEnds(host, 'equity-line')).toEqual({ first: CURVE_PAD, last: CURVE_W - CURVE_PAD });
  });

  it('持仓比率曲线', () => {
    const points = BAR_TS.map((ts, i) => ({
      ts,
      position_ratio: 0.1 * i,
      cash_ratio: 1 - 0.1 * i,
      position_value: 100 * i,
      cash: 1000 - 100 * i,
      nav: 1000,
    }));
    const { container } = render(
      <PositionRatioChart points={points as never} domain={null} xDomain={XD} plot={null} cumulative={null} />,
    );
    const host = container.querySelector('[data-testid="wb-position-chart"]') as HTMLElement;
    expect(polyEnds(host, 'position-line')).toEqual({ first: CURVE_PAD, last: CURVE_W - CURVE_PAD });
  });

  it('跨视图同一根 bar 的 userX 必须逐点相同（PAD 统一后 0.0 user unit）', () => {
    const perBar = BAR_TS.map((ts, i) => ({ ts, aggregate: 50 + i }) as never);
    const netValue: Array<[number, number]> = BAR_TS.map((ts, i) => [ts, 100 + i]);
    const a = render(<AggregateScoreChart perBar={perBar} buyThreshold={70} sellThreshold={30} xDomain={XD} plot={null} />);
    const b = render(<EquityDrawdownChart netValue={netValue} drawdown={netValue} xDomain={XD} plot={null} />);
    const xa = polyEnds(a.container.querySelector('[data-testid="wb-aggregate-chart"]') as HTMLElement);
    const xb = polyEnds(b.container.querySelector('[data-testid="wb-equity-chart"]') as HTMLElement, 'equity-line');
    expect(Math.abs(xa.first - xb.first)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(xa.last - xb.last)).toBeLessThanOrEqual(0.1);
  });
});
