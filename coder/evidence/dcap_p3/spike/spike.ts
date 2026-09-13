/**
 * T8 渲染 spike 页面脚本（coder 取证用；**非仓库运行时代码**，位于 coder/evidence/dcap_p3/spike/）。
 *
 * 目的：用**真实 klinecharts 10.0.3** 渲染 dcap 指标，取证 03-test-plan T8 五项：
 *   ① 不设 precision（默认 4 位）vs 设 precision:5 的双向对比（0.004578… / 0.0048）；
 *   ② 数据不足 → null 断线，且不抛异常（含恶意输入降级）；
 *   ③ 三 figure（s/m/l）+ 独立副图 pane + 独立 Y 轴；
 *   ④ 0.00048 的 decimalFold（threshold=3）折叠形态；
 *   ⑤ 性能：600 根 + n_l=250 + m=60 单次 computeDcapSeries 耗时（目标 < 16ms）。
 *
 * 被测实现 = 仓库真实文件（非复制）：web/src/features/indicators/{dcapIndicator.ts,dcap.ts}。
 * 渲染文案取证 = hook CanvasRenderingContext2D.prototype.fillText（y 轴刻度 / 指标图例都走这里）。
 */
import { init, registerIndicator, utils, version, type Chart, type KLineData } from 'klinecharts';
import { computeDcapSeries } from '../../../../web/src/features/indicators/dcap';
import {
  DCAP_INDICATOR_TEMPLATE,
  DEFAULT_DCAP_PARAMS,
  dcapCalcParams,
} from '../../../../web/src/features/indicators/dcapIndicator';

type Any = Record<string, unknown>;

// ── 渲染文本捕获（真实画到 canvas 的字符串）──
const drawnTexts: string[] = [];
(() => {
  const proto = CanvasRenderingContext2D.prototype as unknown as Any;
  const orig = proto.fillText as (text: string, x: number, y: number, ...rest: unknown[]) => void;
  proto.fillText = function (this: unknown, text: string, x: number, y: number, ...rest: unknown[]) {
    drawnTexts.push(String(text));
    return orig.call(this, text, x, y, ...rest);
  };
})();

const consoleErrors: string[] = [];
window.addEventListener('error', (e) => consoleErrors.push(`window.onerror: ${String(e.message)}`));

// ── 注册被测指标：DCAP（契约实现，precision 5）+ DCAP4（同模板但不设 precision ⇒ klinecharts 默认 4）──
registerIndicator(DCAP_INDICATOR_TEMPLATE as never);
const templateNoPrecision: Any = { ...(DCAP_INDICATOR_TEMPLATE as unknown as Any), name: 'DCAP4', shortName: 'DCAP4' };
delete templateNoPrecision.precision;
registerIndicator(templateNoPrecision as never);

// ── 数据 ──
function kc(closes: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: Date.UTC(2026, 0, 1, 0, 0) + i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

const CLOSES_004578 = [100, 90, 95]; // n=3, r=1.2, smooth=0 ⇒ s = 0.0045787545787547845
const CLOSES_00048 = [100, 100, 100.72]; // n=3, r=1, smooth=0 ⇒ s = 0.0048
const CLOSES_TINY = Array.from({ length: 40 }, (_, i) => 100 + i * 0.048 * (1 + 0.15 * Math.sin(i / 4))); // s ≈ 0.0004–0.0006（decimalFold 区）
const CLOSES_80 = Array.from({ length: 80 }, (_, i) => 2.4 * (1 + 0.01 * Math.sin(i / 3) + 0.003 * Math.cos(i / 7)));

const P3 = [3, 3, 3, 1.2, 1.2, 1.2, 0, 1]; // s 线：n_s=3, r_s=1.2, smooth=0
const P3R1 = [3, 3, 3, 1, 1, 1, 0, 1]; // s 线：n_s=3, r_s=1, smooth=0
const P_DEFAULT = dcapCalcParams({ ...DEFAULT_DCAP_PARAMS });

// ── 建图 ──
function buildChart(host: HTMLElement, data: KLineData[], params: number[], which: 'both' | 'p5' | 'p4') {
  const chart = init(host, { locale: 'zh-CN' }) as Chart;
  chart.setSymbol({ ticker: 'SPIKE', pricePrecision: 3, volumePrecision: 0 });
  chart.setPeriod({ type: 'minute', span: 1 });
  chart.setDataLoader({
    getBars: ({ callback }: Any) => {
      (callback as (d: KLineData[], m: boolean) => void)(data, false);
    },
    subscribeBar: () => {},
    unsubscribeBar: () => {},
  } as never);
  return chart;
}

function addIndicators(chart: Chart, params: number[], which: 'both' | 'p5' | 'p4') {
  if (which !== 'p4') chart.createIndicator({ name: 'DCAP', calcParams: params }, true);
  if (which !== 'p5') chart.createIndicator({ name: 'DCAP4', calcParams: params }, true);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function snapTexts(texts: string[]): Record<string, string[]> {
  const uniq = Array.from(new Set(texts));
  return {
    valueLike: uniq.filter((t) => /^-?\d*\.\d+$/.test(t)),
    legendLike: uniq.filter((t) => /(DCAP|S:|M:|L:)/.test(t)),
    all: uniq,
  };
}

async function capture(host: HTMLElement, chart: Chart, data: KLineData[], params: number[], which: 'both' | 'p5' | 'p4') {
  const mark = drawnTexts.length;
  addIndicators(chart, params, which);
  chart.setBarSpace(Math.max(2, Math.min(12, Math.floor((host.clientWidth - 40) / Math.max(1, data.length)))));
  chart.scrollToRealTime();
  await raf();
  await sleep(60);
  await raf();
  const indicators = chart.getIndicators();
  return {
    indicators: indicators.map((i) => ({
      name: i.name,
      precision: i.precision,
      paneId: i.paneId,
      yAxisId: i.yAxisId,
      figures: i.figures.map((f) => f.key),
      resultLen: Array.isArray(i.result) ? i.result.length : null,
      lastResult: Array.isArray(i.result) ? i.result[i.result.length - 1] : null,
      paneSize: chart.getSize(i.paneId),
      firstNonNull: (['s', 'm', 'l'] as const).reduce<Record<string, number | null>>((acc, k) => {
        const arr = Array.isArray(i.result) ? (i.result as Array<Record<string, unknown>>) : [];
        const idx = arr.findIndex((v) => v != null && v[k] != null);
        acc[k] = idx < 0 ? null : idx;
        return acc;
      }, {}),
    })),
    renderedTexts: snapTexts(drawnTexts.slice(mark)),
  };
}

window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));

// ── 主流程 ──
async function main() {
  const out: Any = {
    klinechartsVersion: version(),
    templates: {
      DCAP: { precision: DCAP_INDICATOR_TEMPLATE.precision, figures: DCAP_INDICATOR_TEMPLATE.figures!.map((f) => f.key) },
      DCAP4: { precision: templateNoPrecision.precision ?? null },
    },
    defaults: DEFAULT_DCAP_PARAMS,
    charts: {} as Any,
    degraded: {} as Any,
    perf: {} as Any,
    rawValues: {} as Any,
  };

  const chartA = buildChart(document.getElementById('chartA') as HTMLElement, kc(CLOSES_004578), P3, 'both');
  const chartB = buildChart(document.getElementById('chartB') as HTMLElement, kc(CLOSES_00048), P3R1, 'both');
  const chartD = buildChart(document.getElementById('chartD') as HTMLElement, kc(CLOSES_80), P_DEFAULT, 'p5');
  const chartC = buildChart(document.getElementById('chartC') as HTMLElement, kc(CLOSES_TINY), P3R1, 'p5');
  await sleep(150);

  (out.charts as Any).A_004578 = await capture(document.getElementById('chartA') as HTMLElement, chartA, kc(CLOSES_004578), P3, 'both');
  (out.charts as Any).B_00048 = await capture(document.getElementById('chartB') as HTMLElement, chartB, kc(CLOSES_00048), P3R1, 'both');
  (out.charts as Any).D_break_3figures = await capture(document.getElementById('chartD') as HTMLElement, chartD, kc(CLOSES_80), P_DEFAULT, 'p5');
  (out.charts as Any).C_fold = await capture(document.getElementById('chartC') as HTMLElement, chartC, kc(CLOSES_TINY), P3R1, 'p5');

  // ② 降级：数据不足 / 恶意输入 → 全 null，不抛
  const dataOf = (closes: number[]) => kc(closes) as unknown as Array<Record<string, unknown>>;
  const callCalc = (data: unknown, params: unknown) => {
    try {
      const calc = DCAP_INDICATOR_TEMPLATE.calc as unknown as (d: unknown, i: unknown) => unknown;
      const r = calc(data, { calcParams: params, figures: DCAP_INDICATOR_TEMPLATE.figures });
      return { threw: false, result: r };
    } catch (e) {
      return { threw: true, result: `THREW: ${String(e)}` };
    }
  };
  const hostile = [
    { get close(): number { throw new Error('boom'); } },
    { get close(): number { throw new Error('boom'); } },
  ];
  (out.degraded as Any) = {
    insufficient_1bar: callCalc(dataOf([100]), P_DEFAULT),
    hostileGetter: callCalc(hostile, P_DEFAULT),
    empty: callCalc([], P_DEFAULT),
    notArray: callCalc(undefined, P_DEFAULT),
    badParams_undefined: callCalc(dataOf(CLOSES_80), undefined),
  };

  // 精确值（供断言：真实渲染的数值来源）
  const seriesA = computeDcapSeries(CLOSES_004578, { n_s: 3, n_m: 3, n_l: 3, r_s: 1.2, r_m: 1.2, r_l: 1.2, smooth: 0, m: 1 });
  const seriesB = computeDcapSeries(CLOSES_00048, { n_s: 3, n_m: 3, n_l: 3, r_s: 1, r_m: 1, r_l: 1, smooth: 0, m: 1 });
  (out.rawValues as Any) = {
    A_last_s: seriesA[seriesA.length - 1]!.s,
    A_last_s_p4: utils.formatPrecision(seriesA[seriesA.length - 1]!.s as number, 4),
    A_last_s_p5: utils.formatPrecision(seriesA[seriesA.length - 1]!.s as number, 5),
    B_last_s: seriesB[seriesB.length - 1]!.s,
    B_last_s_p4: utils.formatPrecision(seriesB[seriesB.length - 1]!.s as number, 4),
    B_last_s_p5: utils.formatPrecision(seriesB[seriesB.length - 1]!.s as number, 5),
    decimalFold_default: (() => {
      const fold = (utils as unknown as { getDecimalFold?: () => { threshold: number } }).getDecimalFold;
      return typeof fold === 'function' ? fold() : 'n/a';
    })(),
    fold_00048_t3: utils.formatFoldDecimal('0.00048', 3),
    fold_00048_t4: utils.formatFoldDecimal('0.00048', 4),
    fold_0_0048_t3: utils.formatFoldDecimal('0.0048', 3),
    fold_0_000048_t3: utils.formatFoldDecimal('0.000048', 3),
  };

  // ⑤ 性能：600 根 + n_l=250 + m=60（以及默认参数对照）
  const perfCloses600 = Array.from({ length: 600 }, (_, i) => 2.4 * (1 + 0.01 * Math.sin(i / 3) + 0.003 * Math.cos(i / 7)));
  const measure = (closes: number[], params: Parameters<typeof computeDcapSeries>[1], iters: number) => {
    const runs: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      computeDcapSeries(closes, params);
      runs.push(performance.now() - t0);
    }
    const sorted = [...runs].sort((a, b) => a - b);
    return {
      iters,
      min: sorted[0],
      median: sorted[Math.floor(sorted.length / 2)],
      max: sorted[sorted.length - 1],
      runs,
    };
  };
  (out.perf as Any) = {
    bars: 600,
    params_max: { n_s: 8, n_m: 100, n_l: 250, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 60 },
    max_nl_m60: measure(perfCloses600, { n_s: 8, n_m: 100, n_l: 250, r_s: 1, r_m: 1, r_l: 1, smooth: 1, m: 60 }, 7),
    default_params: measure(perfCloses600, DEFAULT_DCAP_PARAMS, 7),
    budget_ms: 16,
  };

  out.consoleErrors = consoleErrors;
  out.drawnTextCount = drawnTexts.length;
  out.ready = true;
  (window as unknown as Any).__DCAP_SPIKE__ = out;
}

void main();
