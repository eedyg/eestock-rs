/**
 * 阶段 3 独立验收 harness 的 klinecharts spy（自建，只在 /tmp 沙箱 + 临时 vite alias 生效）。
 * 只做三件事（不改仓库任何文件）：
 *  1) 透传真身 klinecharts@10.0.3（未打桩算法/渲染）；
 *  2) 暴露 window.__ACC__ = { inits, charts, log } —— 拿不到 chartRef 时唯一读 pane/指标状态的通道；
 *  3) 提供**变异开关** window.__ACC_MUT__.disableOverride：让 overrideIndicator 变成 no-op（“不调用 override”
 *     的反向证据用），以及记录 create/remove/override 的调用序列（pane 生命周期证据）。
 */
import * as real from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

interface Entry {
  seq: number;
  api: string;
  arg: string;
  ret: unknown;
  paneIdsAfter: string[];
}

interface AccWindow {
  __ACC__?: { inits: number; seq: number; charts: unknown[]; log: Entry[]; mut: { disableOverride: boolean } };
}

const w = window as unknown as AccWindow;
if (!w.__ACC__) w.__ACC__ = { inits: 0, seq: 0, charts: [], log: [], mut: { disableOverride: false } };
const A = w.__ACC__!;

const SPY = [
  'createIndicator',
  'removeIndicator',
  'overrideIndicator',
  'setPaneOptions',
  'setDataLoader',
  'setSymbol',
  'setPeriod',
  'resetData',
] as const;

function paneIds(chart: unknown): string[] {
  try {
    return ((chart as { getPaneOptions?: () => Array<{ id: string }> }).getPaneOptions?.() ?? []).map((p) => p.id);
  } catch {
    return [];
  }
}

function instrument(chart: unknown): void {
  if (!chart || typeof chart !== 'object') return;
  const c = chart as Record<string, unknown>;
  if (c.__accSpied__) return;
  c.__accSpied__ = true;
  for (const api of SPY) {
    const orig = c[api];
    if (typeof orig !== 'function') continue;
    const bound = (orig as (...a: unknown[]) => unknown).bind(chart);
    c[api] = (...args: unknown[]) => {
      if (api === 'overrideIndicator' && A.mut.disableOverride) {
        A.log.push({
          seq: A.seq++,
          api: 'overrideIndicator(MUTANT-noop)',
          arg: JSON.stringify(args)?.slice(0, 240) ?? '',
          ret: false,
          paneIdsAfter: paneIds(chart),
        });
        return false; // 变异：完全不调用库的 override（等价于“参数变更不做任何事”）
      }
      const ret = bound(...args);
      A.log.push({
        seq: A.seq++,
        api,
        arg: JSON.stringify(args)?.slice(0, 240) ?? '',
        ret: ret as unknown,
        paneIdsAfter: paneIds(chart),
      });
      return ret;
    };
  }
}

export function init(...args: unknown[]): unknown {
  const chart = (real as unknown as { init: (...a: unknown[]) => unknown }).init(...args);
  instrument(chart);
  A.charts.push(chart);
  A.inits += 1;
  return chart;
}

/** 变异开关（浏览器侧调用）：disableOverride=true ⇒ overrideIndicator 变 no-op。 */
export function __accSetMut(mut: Partial<{ disableOverride: boolean }>): void {
  Object.assign(A.mut, mut);
}

// 便于 Playwright 从页面上下文打开/关闭变异开关（同一模块实例 ⇒ 同一 A.mut）。
(window as unknown as { __ACC_SET_MUT__?: (m: Partial<{ disableOverride: boolean }>) => void }).__ACC_SET_MUT__ = __accSetMut;
