/**
 * 红测试（P5-A）：**高度分配纯函数面** —— 恰好填满 / 直用 / 按比例缩小 / 下限 / 退化可滚动 / 非法值回退。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodLayout.test.ts`
 * 权威依据：
 *  - `design/15-multi-period/04-implementation-plan.md` P5（布局持久化与稳定性）
 *  - `design/15-multi-period/03-test-plan.md` T9（布局持久化与 ②③ 契约）
 *  - `design/15-multi-period/02-spec.md` §6（每实例高度 = `heights[period]`；拖拽持久化；我方容器渲染分隔条）
 *  - P2-C 实测：`tester/test/271_p2c_independent_acceptance_execution.md` §9（`#main` 600 vs scrollHeight 1140 ⇒ 540px 纵向溢出）
 *  - 本文件的设计报告：`tester/design/276_p5_layout_persistence_red_design.md` §2.1（钉死导出签名与算法口径）
 *
 * 预期 red 理由：**`web/src/features/dashboard/multiPeriodLayout.ts` 尚不存在**（P5 实现未开始）。
 * 实现后本文件应转绿，且**不得改动断言口径**（比例带 ±3px 来自 `floor` 舍入 + 基准吸收余量）。
 *
 * 层级分工（诚实标注）：jsdom **无布局引擎**（clientHeight/scrollHeight 恒 0）⇒ 「无纵向溢出」的
 * 几何判据由 `web/tester/p5-layout-harness/`（Playwright + 真实产品组件）承担；本文件只判**分配数值**。
 */

import { describe, expect, it } from 'vitest';

/**
 * 模块说明符：红阶段模块不存在 ⇒ 用**变量 specifier** 动态 import（字面量会让收集期整体报错，
 * 拿不到逐用例 red 证据；变量同时避免 `tsc -b` 在红阶段被模块缺失阻塞）。
 */
const LAYOUT_SPECIFIER: string = './multiPeriodLayout';

interface StackPaneInput {
  key: string;
  period: string;
  requested: number;
  isBase: boolean;
}
interface StackPaneOut {
  key: string;
  period: string;
  height: number;
  isBase: boolean;
}
interface StackLayout {
  panes: StackPaneOut[];
  total: number;
  shrunk: boolean;
  scrollable: boolean;
  reason: 'fit' | 'shrunk' | 'min-overflow' | 'unavailable';
}
interface LayoutApi {
  BASE_MIN_HEIGHT: number;
  SATELLITE_MIN_HEIGHT: number;
  HEIGHT_MIN: number;
  HEIGHT_MAX: number;
  DEFAULT_BASE_HEIGHT: number;
  DRAG_DEBOUNCE_MS: number;
  sanitizeRequestedHeight(value: unknown, isBase: boolean): number;
  distributeStackHeights(input: { panes: readonly StackPaneInput[]; available: number }): StackLayout;
}

async function loadLayout(): Promise<LayoutApi> {
  return (await import(/* @vite-ignore */ LAYOUT_SPECIFIER)) as unknown as LayoutApi;
}

/** 默认配置（02-spec §6）：基准 420 + 3 卫星 ×180 = 960；主图区可用高度 600（P2-C 实测）。 */
const BASE = '15m';
const SATS = ['1h', '5m', '1d'];
const AVAILABLE = 600;

function panes(baseRequested = 420, satRequested = 180, satPeriods: string[] = SATS): StackPaneInput[] {
  return [
    { key: BASE, period: BASE, requested: baseRequested, isBase: true },
    ...satPeriods.map((p) => ({ key: p, period: p, requested: satRequested, isBase: false })),
  ];
}

/** 按 period 取分配高度。 */
function h(layout: StackLayout, period: string): number {
  const pane = layout.panes.find((p) => p.period === period);
  if (!pane) throw new Error(`缺少 pane ${period}`);
  return pane.height;
}

function sum(layout: StackLayout): number {
  return layout.panes.reduce((a, p) => a + p.height, 0);
}

describe('multiPeriodLayout 纯函数面（P5-A 红：模块尚不存在）', () => {
  it('A1 默认配置（960 需求 / 600 可用）⇒ 恰好填满 + 按比例缩小（不溢出）', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layout = distributeStackHeights({ panes: panes(), available: AVAILABLE });

    // ① 各 pane 高度之和 == 可用高度（「恰好填满」，无纵向溢出的数值面）
    expect(sum(layout)).toBe(AVAILABLE);
    expect(layout.total).toBe(AVAILABLE);
    expect(layout.reason).toBe('shrunk');
    expect(layout.shrunk).toBe(true);
    // ② 仍放得下 ⇒ **不得**退化为可滚动
    expect(layout.scrollable).toBe(false);
    // ③ 下限（基准 ≥200、卫星 ≥80）
    expect(h(layout, BASE)).toBeGreaterThanOrEqual(200);
    for (const p of SATS) expect(h(layout, p), `卫星 ${p} 下限`).toBeGreaterThanOrEqual(80);
    // ④ 比例带：factor = 600/960 = 0.625 ⇒ 卫星 ≈ floor(180×0.625) = 112（±3px 容舍入策略），且不超请求值
    for (const p of SATS) {
      expect(h(layout, p), `卫星 ${p} 比例带`).toBeGreaterThanOrEqual(109);
      expect(h(layout, p), `卫星 ${p} 比例带`).toBeLessThanOrEqual(115);
      expect(h(layout, p)).toBeLessThanOrEqual(180);
    }
    // ⑤ 基准 ≤ 请求值（缩小），且 > 任一卫星（可视化主次不变量）
    expect(h(layout, BASE)).toBeLessThanOrEqual(420);
    for (const p of SATS) expect(h(layout, BASE)).toBeGreaterThan(h(layout, p));
  });

  it('A2 需求 ≤ 可用 ⇒ 卫星按配置 px 直用、基准吸收余量（Σ == 可用）', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layout = distributeStackHeights({ panes: panes(), available: 1200 });

    expect(layout.reason).toBe('fit');
    expect(layout.shrunk).toBe(false);
    expect(layout.scrollable).toBe(false);
    for (const p of SATS) expect(h(layout, p), `卫星 ${p} 直用配置 px`).toBe(180);
    expect(h(layout, BASE), '基准吸收余量 = 1200 − 3×180').toBe(660);
    expect(sum(layout)).toBe(1200);
    expect(layout.total).toBe(1200);
  });

  it('A3 退化输入：单基准（无卫星）⇒ 基准填满可用高度', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layout = distributeStackHeights({ panes: panes(420, 180, []), available: AVAILABLE });
    expect(layout.panes).toHaveLength(1);
    expect(h(layout, BASE)).toBe(AVAILABLE);
    expect(sum(layout)).toBe(AVAILABLE);
    expect(layout.reason).toBe('fit');
  });

  it('A4 边界：需求恰好 == 可用（960）⇒ 逐 pane == 请求值', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layout = distributeStackHeights({ panes: panes(), available: 960 });
    expect(h(layout, BASE)).toBe(420);
    for (const p of SATS) expect(h(layout, p)).toBe(180);
    expect(sum(layout)).toBe(960);
    expect(layout.reason).toBe('fit');
  });

  it('A5 连下限都放不下（300 < 200+3×80）⇒ 退化可滚动 + 记录（不静默裁剪）', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layout = distributeStackHeights({ panes: panes(), available: 300 });

    expect(layout.scrollable, '放不下最小高度 ⇒ 栈区域必须可滚动（并记录）').toBe(true);
    expect(layout.reason).toBe('min-overflow');
    expect(layout.shrunk).toBe(true);
    expect(h(layout, BASE), '各 pane 取下限').toBe(200);
    for (const p of SATS) expect(h(layout, p)).toBe(80);
    expect(sum(layout), '下限和 440（> 可用 300；不得伪造成 300）').toBe(440);
  });

  it('A6 边界：可用恰 == 下限和（440）⇒ 仍属「缩小」路径且不判可滚动', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layout = distributeStackHeights({ panes: panes(), available: 440 });
    expect(sum(layout)).toBe(440);
    expect(layout.scrollable).toBe(false);
    expect(layout.reason).toBe('shrunk');
    expect(h(layout, BASE)).toBeGreaterThanOrEqual(200);
    for (const p of SATS) expect(h(layout, p)).toBeGreaterThanOrEqual(80);
  });

  it('A7 量测不可用（0 / NaN / 负 / undefined）⇒ 保持请求高度、不伪造默认值、不抛', async () => {
    const { distributeStackHeights } = await loadLayout();
    for (const available of [0, NaN, -1, undefined as unknown as number]) {
      const layout = distributeStackHeights({ panes: panes(), available });
      expect(layout.reason, `available=${String(available)}`).toBe('unavailable');
      expect(layout.scrollable).toBe(false);
      expect(h(layout, BASE), `available=${String(available)} 保留基准请求高度`).toBe(420);
      for (const p of SATS) expect(h(layout, p)).toBe(180);
    }
  });

  it('A8 非法请求值 ⇒ 兜底默认（不崩）：NaN / ±Infinity / 0 / 负 / 字符串 / null / undefined', async () => {
    const { distributeStackHeights, sanitizeRequestedHeight } = await loadLayout();
    expect(sanitizeRequestedHeight(NaN, true)).toBe(420);
    expect(sanitizeRequestedHeight(Infinity, true)).toBe(420);
    expect(sanitizeRequestedHeight(-Infinity, false)).toBe(180);
    expect(sanitizeRequestedHeight(0, true)).toBe(420);
    expect(sanitizeRequestedHeight(-5, false)).toBe(180);
    expect(sanitizeRequestedHeight('180', false)).toBe(180);
    expect(sanitizeRequestedHeight(null, true)).toBe(420);
    expect(sanitizeRequestedHeight(undefined, false)).toBe(180);

    // 整条链路：坏值不得让分配崩溃
    const bad = [
      { key: BASE, period: BASE, requested: NaN, isBase: true },
      { key: '1h', period: '1h', requested: -1, isBase: false },
      { key: '5m', period: '5m', requested: '180' as unknown as number, isBase: false },
    ];
    // 量测不可用分支 ⇒ 高度 = 净化后的请求高度（缩小/直用路径由 A1–A6/A15 覆盖）
    const layout = distributeStackHeights({ panes: bad, available: 0 });
    expect(h(layout, BASE)).toBe(420);
    expect(h(layout, '1h')).toBe(180);
    expect(h(layout, '5m')).toBe(180);
  });

  it('A9 越界请求值 ⇒ 夹取到 [80,1200]', async () => {
    const { sanitizeRequestedHeight, HEIGHT_MIN, HEIGHT_MAX } = await loadLayout();
    expect(HEIGHT_MIN).toBe(80);
    expect(HEIGHT_MAX).toBe(1200);
    expect(sanitizeRequestedHeight(20, false)).toBe(80);
    expect(sanitizeRequestedHeight(5000, true)).toBe(1200);
    expect(sanitizeRequestedHeight(1200, false)).toBe(1200);
    expect(sanitizeRequestedHeight(80, false)).toBe(80);
    expect(sanitizeRequestedHeight(180.6, false)).toBe(181);
  });

  it('A10 空 pane 列表 ⇒ 零残留、不抛', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layout = distributeStackHeights({ panes: [], available: AVAILABLE });
    expect(layout.panes).toEqual([]);
    expect(layout.total).toBe(0);
    expect(layout.scrollable).toBe(false);
  });

  it('A11 输出与输入同序且字段原样回传（pane 身份稳定）', async () => {
    const { distributeStackHeights } = await loadLayout();
    const input = panes();
    const layout = distributeStackHeights({ panes: input, available: AVAILABLE });
    expect(layout.panes.map((p) => p.period)).toEqual(input.map((p) => p.period));
    expect(layout.panes.map((p) => p.key)).toEqual(input.map((p) => p.key));
    expect(layout.panes.map((p) => p.isBase)).toEqual(input.map((p) => p.isBase));
  });

  it('A12 卫星越多越挤（单调性）：1 / 3 / 5 卫星下基准与卫星高度单调不增', async () => {
    const { distributeStackHeights } = await loadLayout();
    const layouts = [1, 3, 5].map((n) =>
      distributeStackHeights({
        panes: panes(420, 180, ['1h', '5m', '1d', '1w', '1mo'].slice(0, n)),
        available: AVAILABLE,
      }),
    );
    for (let i = 1; i < layouts.length; i++) {
      expect(h(layouts[i]!, BASE)).toBeLessThanOrEqual(h(layouts[i - 1]!, BASE));
      expect(h(layouts[i]!, '1h')).toBeLessThanOrEqual(h(layouts[i - 1]!, '1h'));
      expect(h(layouts[i]!, BASE)).toBeGreaterThanOrEqual(200);
    }
  });

  it('A13 所有分支下基准 ≥ 任一卫星（主次不变量）', async () => {
    const { distributeStackHeights } = await loadLayout();
    for (const available of [300, 440, 600, 960, 1200, 2000]) {
      const layout = distributeStackHeights({ panes: panes(), available });
      for (const p of SATS) {
        expect(h(layout, BASE), `available=${available} 基准 ≥ 卫星 ${p}`).toBeGreaterThanOrEqual(
          h(layout, p),
        );
      }
    }
  });

  it('A14 所有返回高度均为整数 px', async () => {
    const { distributeStackHeights } = await loadLayout();
    for (const available of [300, 440, 600, 960, 1200, 2003]) {
      const layout = distributeStackHeights({ panes: panes(), available });
      for (const p of layout.panes) expect(Number.isInteger(p.height), `${p.period}`).toBe(true);
    }
  });

  it('A15 压力（卫星过多）：7 卫星 @600 ⇒ 连下限都放不下（760 > 600）⇒ 退化可滚动 + 记录', async () => {
    const { distributeStackHeights } = await loadLayout();
    const seven = ['1h', '5m', '1d', '1w', '1mo', '2h', '4h'];
    const layout = distributeStackHeights({
      panes: panes(420, 180, seven),
      available: AVAILABLE,
    });
    // 下限和 = 基准 200 + 7×80 = 760 > 600 ⇒ min-overflow（**不得**静默裁剪或伪造 600）
    expect(layout.reason).toBe('min-overflow');
    expect(layout.scrollable).toBe(true);
    expect(h(layout, BASE)).toBe(200);
    for (const p of seven) expect(h(layout, p), `卫星 ${p} 下限`).toBe(80);
    expect(sum(layout)).toBe(760);
  });
});
