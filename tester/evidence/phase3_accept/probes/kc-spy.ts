/**
 * 阶段 3 独立验收（tester 自建）klinecharts 透传 spy —— 只在 /tmp 沙箱 + 临时 vite alias 生效。
 * 目的：不改仓库任何文件，透传真身 klinecharts@10.0.3，并把「图表实例生命周期/接线调用序列」暴露到
 * window.__ACC__ 供真渲染探针读取（真身渲染 = 真 canvas，非打桩）。
 * 变异开关：window.__ACC_SET_MUT__({ disableOverride }) —— 反向对照用。
 */
import * as real from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

const SPY = [
  'createIndicator',
  'removeIndicator',
  'overrideIndicator',
  'setPaneOptions',
  'setDataLoader',
  'setSymbol',
  'setPeriod',
  'resetData',
  'removeOverlay',
  'createOverlay',
  'scrollToRealTime',
] as const;

function paneIds(chart: any): string[] {
  try {
    return (chart.getPaneOptions?.() ?? []).map((p: any) => p.id);
  } catch {
    return [];
  }
}

const w = window as any;
if (!w.__ACC__) w.__ACC__ = { inits: 0, disposes: 0, seq: 0, charts: [], log: [], loaders: [], mut: { disableOverride: false } };
const A = w.__ACC__;

function instrument(chart: any): void {
  if (!chart || typeof chart !== 'object') return;
  if (chart.__accSpied__) return;
  chart.__accSpied__ = true;
  for (const api of SPY) {
    const orig = chart[api];
    if (typeof orig !== 'function') continue;
    const bound = orig.bind(chart);
    chart[api] = (...args: any[]) => {
      if (api === 'overrideIndicator' && A.mut.disableOverride) {
        A.log.push({ seq: A.seq++, api: 'overrideIndicator(MUTANT-noop)', arg: JSON.stringify(args)?.slice(0, 240) ?? '', ret: false, paneIdsAfter: paneIds(chart) });
        return false;
      }
      if (api === 'setDataLoader') A.loaders.push(args[0]);
      const ret = bound(...args);
      A.log.push({ seq: A.seq++, api, arg: JSON.stringify(args)?.slice(0, 240) ?? '', ret, paneIdsAfter: paneIds(chart) });
      return ret;
    };
  }
}

export function init(...args: any[]): any {
  const chart = (real as any).init(...args);
  instrument(chart);
  A.charts.push(chart);
  A.inits += 1;
  return chart;
}

export function dispose(chart: any): any {
  A.disposes += 1;
  A.log.push({ seq: A.seq++, api: 'dispose', arg: '', ret: true, paneIdsAfter: [] });
  return (real as any).dispose(chart);
}

w.__ACC_SET_MUT__ = (m: any) => Object.assign(A.mut, m);
