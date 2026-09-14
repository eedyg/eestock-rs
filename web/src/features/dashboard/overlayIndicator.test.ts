import { describe, expect, it } from 'vitest';
import type { Chart, IndicatorCreate } from 'klinecharts';
import { createChartStoreStub } from '@/test/chartStoreStub';

/**
 * 红测试（P0.1-A）：框架入口 `addOverlayIndicator(chart, spec, expectName)` 的**契约**。
 *
 * 权威依据：`design/15-multi-period/02-spec.md` §4.3（硬约束）、`03-test-plan.md` T7（G2 门禁）、
 * `04-implementation-plan.md` 0.1；根因取证：`tester/report/165_ma_candle_pane_root_cause.md`。
 *
 * 预期 red 理由：**入口模块尚不存在**（`./overlayIndicator` 解析失败）。实现方落地
 * `web/src/features/dashboard/overlayIndicator.ts` 后本文件应转绿，且不得改动断言口径。
 */

type AddOverlayIndicator = (chart: Chart, spec: IndicatorCreate, expectName: string) => void;

/**
 * 入口模块说明符。红阶段模块不存在 ⇒ 用**变量 specifier**（类型显式声明为 `string`）
 * 动态 import：字面量会让 tsc/vitest 在**收集期**整体报错，拿不到逐用例的 red 证据；
 * 显式 `string` 同时避免 tsc 静态解析（红阶段 `tsc -b` 不被模块缺失阻塞）。
 * 入口落地后同一条代码路径立即成功，无需改测试。
 */
const ENTRY_SPECIFIER: string = './overlayIndicator';

async function loadEntry(): Promise<AddOverlayIndicator> {
  const mod = (await import(/* @vite-ignore */ ENTRY_SPECIFIER)) as {
    addOverlayIndicator: AddOverlayIndicator;
  };
  return mod.addOverlayIndicator;
}

const CANDLE_PANE = 'candle_pane';
const MA_SPEC: IndicatorCreate = { name: 'MA', calcParams: [5, 10, 20], paneId: CANDLE_PANE };

/** 桩 chart 仅实现本入口用到的三方法；真实 `Chart` 由引擎在宿主侧提供。 */
function asChart(stub: ReturnType<typeof createChartStoreStub>): Chart {
  return stub as unknown as Chart;
}

describe('addOverlayIndicator（框架入口契约；红：入口尚不存在）', () => {
  it('正常路径：先 removeIndicator({name}) 再 createIndicator(spec, true)，且 getIndicators({name}).length > 0', async () => {
    const addOverlayIndicator = await loadEntry();
    const chart = createChartStoreStub();

    addOverlayIndicator(asChart(chart), MA_SPEC, 'MA');

    expect(chart.removeIndicator).toHaveBeenCalledWith({ name: 'MA' });
    expect(chart.createIndicator).toHaveBeenCalledWith(MA_SPEC, true);
    expect(chart.getIndicators).toHaveBeenCalledWith({ name: 'MA' });
    expect(chart.getIndicators({ name: 'MA' }).length).toBeGreaterThan(0);
    // 顺序契约：remove 必须先于 create（create(true) 是**追加**，不显式移除会叠重复）
    expect(chart.removeIndicator.mock.invocationCallOrder[0]).toBeLessThan(
      chart.createIndicator.mock.invocationCallOrder[0]!,
    );
  });

  it('重复调用幂等：连调两次仍只有 1 个同名指标；每次都以 isStack=true 追加', async () => {
    const addOverlayIndicator = await loadEntry();
    const chart = createChartStoreStub();

    addOverlayIndicator(asChart(chart), MA_SPEC, 'MA');
    addOverlayIndicator(asChart(chart), MA_SPEC, 'MA');

    expect(chart.getIndicators({ name: 'MA' })).toHaveLength(1);
    expect(chart.createIndicator).toHaveBeenCalledTimes(2);
    for (const call of chart.createIndicator.mock.calls) {
      expect(call[1]).toBe(true);
    }
  });

  it('桩令 getIndicators 返回空 ⇒ 必须抛错（不得静默返回）', async () => {
    const addOverlayIndicator = await loadEntry();
    const chart = createChartStoreStub();
    chart.getIndicators.mockReturnValue([]);

    expect(() => addOverlayIndicator(asChart(chart), MA_SPEC, 'MA')).toThrow();
  });

  it('抛错信息包含指标名（可定位，与 02-spec §4.3 口径一致）', async () => {
    const addOverlayIndicator = await loadEntry();
    const chart = createChartStoreStub();
    chart.getIndicators.mockReturnValue([]);

    expect(() => addOverlayIndicator(asChart(chart), MA_SPEC, 'MA')).toThrow(/MA/);
  });
});
