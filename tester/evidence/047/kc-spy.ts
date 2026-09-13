/**
 * 测试车道（tester / 诊断 问题①）：klinecharts 模块 spy。
 * - 仅用于 /tmp 沙箱 harness，**不进仓库、不改产品代码**。
 * - 通过 esbuild `--alias:klinecharts=/tmp/dcap_sep01/kc-spy.ts` 生效：
 *   KlineChart.tsx / dcapIndicator.ts 导入的 'klinecharts' 全部落到本文件。
 * - 目的：① 抓住 init() 返回的 Chart 实例（React 组件内部不暴露 chartRef）；
 *         ② 记录 createIndicator / removeIndicator 调用序列（用于「只增不减」判定）。
 */
import * as real from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/index.esm.js';

interface AnyChart {
  id?: string;
  getPaneOptions(id?: string): unknown;
  getIndicators(filter?: unknown): Array<{ name?: string; paneId?: string; id?: string }>;
  getDrawPanes(): Array<{ getId(): string }>;
  getSeparatorPanes(): Map<unknown, unknown>;
  getContainer(): HTMLElement;
  removeIndicator(filter?: unknown): boolean;
  createIndicator(value: unknown, isStack?: boolean): string | null;
  setPaneOptions(options: unknown): void;
}

interface W {
  __CHARTS__?: AnyChart[];
  __CALLS__?: string[];
}

const w = window as unknown as W;
if (!w.__CHARTS__) w.__CHARTS__ = [];
if (!w.__CALLS__) w.__CALLS__ = [];

export function init(...args: unknown[]): unknown {
  const chart = (real as unknown as { init: (...a: unknown[]) => unknown }).init(...args) as AnyChart;
  try {
    w.__CHARTS__!.push(chart);
    w.__CALLS__!.push(`init -> id=${String(chart.id)}`);
    const oc = chart.createIndicator.bind(chart);
    const or = chart.removeIndicator.bind(chart);
    const osp = chart.setPaneOptions.bind(chart);
    chart.removeIndicator = (filter?: unknown) => {
      const before = chart.getPaneOptions() as Array<{ id: string }>;
      const r = or(filter as never) as boolean;
      const after = chart.getPaneOptions() as Array<{ id: string }>;
      w.__CALLS__!.push(
        `removeIndicator ${JSON.stringify(filter)} -> ${r} | panesBefore=[${before
          .map((p) => p.id)
          .join(',')}] panesAfter=[${after.map((p) => p.id).join(',')}]`,
      );
      return r;
    };
    chart.createIndicator = (value: unknown, isStack?: boolean) => {
      const before = chart.getPaneOptions() as Array<{ id: string }>;
      const r = oc(value as never, isStack as never) as string | null;
      const after = chart.getPaneOptions() as Array<{ id: string }>;
      w.__CALLS__!.push(
        `createIndicator ${JSON.stringify(value)} isStack=${String(isStack)} -> ${String(r)} | panesBefore=[${before
          .map((p) => p.id)
          .join(',')}] panesAfter=[${after.map((p) => p.id).join(',')}]`,
      );
      return r;
    };
    chart.setPaneOptions = (options: unknown) => {
      w.__CALLS__!.push(`setPaneOptions ${JSON.stringify(options)}`);
      return osp(options as never);
    };
  } catch (e) {
    w.__CALLS__!.push(`spy error: ${String(e)}`);
  }
  return chart;
}
