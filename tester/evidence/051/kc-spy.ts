/**
 * 诊断车道（tester 阶段 1）harness 的 klinecharts spy —— 只在 /tmp 沙箱，经临时 vite resolve.alias 生效，
 * 不改仓库任何文件。
 * 目的：
 *  1) 抓取 init() 返回的 Chart 实例 → window.__CHARTS__（组件不暴露 chartRef，库不导出 getChart）；
 *  2) 包裹 createIndicator / removeIndicator / overrideIndicator / setPaneOptions，
 *     把「调用序列 + 每次调用前后的 pane（id/height）快照 + 调用栈指纹」记到 window.__KC_LOG__，
 *     用于定位「哪一次调用销毁/重建了哪个 pane」；
 *  3) 记录 init() 调用次数（window.__KC_INITS__）→ 判定「整图 remount」（路径 B）。
 */
import * as real from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

interface LogEntry {
  seq: number;
  api: string;
  arg: string;
  ret: unknown;
  panesBefore: Array<{ id: string; height: number; minHeight: number }>;
  panesAfter: Array<{ id: string; height: number; minHeight: number }>;
  stack: string;
  t: number;
}

interface W {
  __CHARTS__?: unknown[];
  __KC_INITS__?: number;
  __KC_LOG__?: LogEntry[];
  __KC_SEQ__?: number;
}

const w = window as unknown as W;
if (!Array.isArray(w.__CHARTS__)) w.__CHARTS__ = [];
if (!Array.isArray(w.__KC_LOG__)) w.__KC_LOG__ = [];
if (typeof w.__KC_INITS__ !== 'number') w.__KC_INITS__ = 0;
if (typeof w.__KC_SEQ__ !== 'number') w.__KC_SEQ__ = 0;

/** 调用栈指纹：只取前 4 帧并归一化行号，用于判断两次调用是否来自同一调用点（minify 下仍有区分度）。 */
function fingerprint(): string {
  const st = (new Error().stack ?? '').split('\n').slice(1);
  return st
    .slice(0, 4)
    .map((l) => l.replace(/:\d+:\d+/g, ':L:C').replace(/^\s+at\s+/, '').trim())
    .join(' | ')
    .slice(0, 400);
}

type PaneLike = { id: string; height: number; minHeight: number };

function snap(chart: unknown): PaneLike[] {
  try {
    const c = chart as { getPaneOptions?: () => PaneLike[] };
    const ps = c.getPaneOptions?.() ?? [];
    return ps.map((p) => ({ id: p.id, height: p.height, minHeight: p.minHeight }));
  } catch {
    return [];
  }
}

const SPY_APIS = ['createIndicator', 'removeIndicator', 'overrideIndicator', 'setPaneOptions', 'setDataLoader', 'setSymbol', 'setPeriod', 'setStyles'];

function instrument(chart: unknown): void {
  if (!chart || typeof chart !== 'object') return;
  const c = chart as Record<string, unknown>;
  if (c.__spied__) return;
  c.__spied__ = true;
  for (const api of SPY_APIS) {
    const orig = c[api];
    if (typeof orig !== 'function') continue;
    const bound = (orig as (...a: unknown[]) => unknown).bind(chart);
    c[api] = (...args: unknown[]) => {
      const panesBefore = api === 'setPaneOptions' || api === 'removeIndicator' || api === 'createIndicator' || api === 'overrideIndicator' ? snap(chart) : [];
      const ret = bound(...args);
      const entry: LogEntry = {
        seq: w.__KC_SEQ__!++,
        api,
        arg: JSON.stringify(args)?.slice(0, 300) ?? '',
        ret: ret as unknown,
        panesBefore,
        panesAfter: snap(chart),
        stack: fingerprint(),
        t: Math.round(performance.now() * 10) / 10,
      };
      w.__KC_LOG__!.push(entry);
      return ret;
    };
  }
}

export function init(...args: unknown[]): unknown {
  const chart = (real as unknown as { init: (...a: unknown[]) => unknown }).init(...args);
  instrument(chart);
  w.__CHARTS__!.push(chart);
  w.__KC_INITS__ = (w.__KC_INITS__ ?? 0) + 1;
  return chart;
}
