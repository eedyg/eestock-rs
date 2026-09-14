import { describe, expect, it } from 'vitest';
import type { Chart, IndicatorCreate } from 'klinecharts';
import { createChartStoreStub } from '@/test/chartStoreStub';

/**
 * 陷阱回归（行为级，P0.1-A / 03-test-plan T7「G2 静默消失防护」）。
 *
 * 两个 describe：
 *  1. **[证据]** 用忠实 store 桩复现库级陷阱：同 pane 先建 A（`isStack=false`）→ 再建 B
 *     （`isStack=false`）⇒ **A 静默消失**，而 `createIndicator` 仍返回 id、零告警。
 *     这一段**现在就应该绿**——它是“为什么必须有防护”的证据（等价于
 *     `tester/report/165_ma_candle_pane_root_cause.md` 矩阵 D/F/R 的单元级指纹）。
 *  2. **[防护]** 走我们的入口 `addOverlayIndicator` 时，同一序列下 A **必须存活**。
 *     这一段**现在红**（入口模块尚不存在），实现落地后转绿。
 */

type AddOverlayIndicator = (chart: Chart, spec: IndicatorCreate, expectName: string) => void;

/** 见 `overlayIndicator.test.ts` 同款说明：红阶段用变量 specifier 取逐用例 red 证据。 */
const ENTRY_SPECIFIER: string = './overlayIndicator';

async function loadEntry(): Promise<AddOverlayIndicator> {
  const mod = (await import(/* @vite-ignore */ ENTRY_SPECIFIER)) as {
    addOverlayIndicator: AddOverlayIndicator;
  };
  return mod.addOverlayIndicator;
}

const CANDLE_PANE = 'candle_pane';
const MA: IndicatorCreate = { name: 'MA', calcParams: [5, 10, 20], paneId: CANDLE_PANE };
const BOLL: IndicatorCreate = { name: 'BOLL', calcParams: [20, 2], paneId: CANDLE_PANE };

function asChart(stub: ReturnType<typeof createChartStoreStub>): Chart {
  return stub as unknown as Chart;
}

describe('[证据] 库陷阱指纹：同 pane 第二个 isStack=false 会静默顶掉先建指标', () => {
  it('A(false) → B(false)：A 消失、B 在，且两次 createIndicator 都返回了 id（零告警）', () => {
    const chart = createChartStoreStub();

    const idA = chart.createIndicator(MA, false);
    expect(chart.getIndicators({ name: 'MA' })).toHaveLength(1);

    const idB = chart.createIndicator(BOLL, false);

    // “返回 id” 并不代表指标留在图中（:15292）——这正是“静默”的成因
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(chart.getIndicators({ name: 'BOLL' })).toHaveLength(1);
    expect(chart.getIndicators({ name: 'MA' })).toHaveLength(0); // ← 先建的 A 被静默顶掉
    expect(chart.getIndicators()).toHaveLength(1); // 整个 candle_pane 只剩 B
  });

  it('对照：省略 isStack 与 isStack=false 等价（同样顶掉 A）', () => {
    const chart = createChartStoreStub();

    chart.createIndicator(MA, false);
    chart.createIndicator(BOLL); // 省略 isStack ⇒ 引擎按 false 处理

    expect(chart.getIndicators({ name: 'MA' })).toHaveLength(0);
    expect(chart.getIndicators({ name: 'BOLL' })).toHaveLength(1);
  });

  it('对照：A(false) → B(true) ⇒ A 存活（isStack=true 才是“追加/叠加”）', () => {
    const chart = createChartStoreStub();

    chart.createIndicator(MA, false);
    chart.createIndicator(BOLL, true);

    expect(chart.getIndicators({ name: 'MA' })).toHaveLength(1);
    expect(chart.getIndicators({ name: 'BOLL' })).toHaveLength(1);
  });
});

describe('[防护] 走 addOverlayIndicator：先建 A 再建 B ⇒ A 必须存活', () => {
  it('同 pane 追加第二个指标后，先建的 A 仍在 getIndicators 中', async () => {
    const addOverlayIndicator = await loadEntry();
    const chart = createChartStoreStub();

    addOverlayIndicator(asChart(chart), MA, 'MA');
    addOverlayIndicator(asChart(chart), BOLL, 'BOLL');

    expect(chart.getIndicators({ name: 'MA' })).toHaveLength(1);
    expect(chart.getIndicators({ name: 'BOLL' })).toHaveLength(1);
    expect(chart.getIndicators()).toHaveLength(2);
  });
});
