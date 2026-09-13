import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Chart } from 'klinecharts';
import type { Period } from '@/api/types';
import {
  barSpaceForViewport,
  fitBarSpaceToViewport,
  MIN_BAR_SPACE,
  MAX_BAR_SPACE,
} from './barSpaceFit';

/** 主图 pane 实测宽度（ADR-020 §1.2：min-w-[1280px] − symbol-list w-60(240) − y 轴 ≈60）。 */
const MAIN_W = 980;
/** 宫格单格宽度（ADR-020 §2.7）。 */
const GRID_W = 470;

const ALL_PERIODS: Period[] = ['1m', '5m', '15m', '1h', '1d', '1w', '1mo'];

function fakeChart() {
  return { setBarSpace: vi.fn() } as unknown as Chart & { setBarSpace: ReturnType<typeof vi.fn> };
}

function fakeEl(width: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  return el;
}

describe('barSpaceForViewport（R1 缺陷复现：视口口径与周期解耦）', () => {
  it('R1：W=980 / bars=120 时 1m/5m/15m/1h/1d/1w/1mo 得到同一 space（旧实现 1m 夹 1、1d/1w/1mo 夹 50）', () => {
    // 周期无关：barSpace 只由 (宽度, 根数) 决定；旧实现 space = clamp(round(W/(每日bar数×days)),1,50)
    // → 1m 恒 1、1d/1w/1mo 恒 50，同一配置在不同周期等于完全不同的根数（用户「只有 15m 有反应」根因）。
    const spaces = ALL_PERIODS.map(() => barSpaceForViewport(MAIN_W, 120));
    expect(new Set(spaces).size).toBe(1);
    expect(spaces[0]).toBe(8); // round(980/120)=8 → 可见 ≈122 根（旧 1m 为 1 → 980 根、旧 1d 为 50 → 19 根）
    expect(spaces[0]).not.toBe(MIN_BAR_SPACE);
    expect(spaces[0]).not.toBe(MAX_BAR_SPACE);
  });

  it('R2：取值边界 (980,30)=33、(980,600)=2、(470,120)=4（宫格）', () => {
    expect(barSpaceForViewport(MAIN_W, 30)).toBe(33);
    expect(barSpaceForViewport(MAIN_W, 600)).toBe(2);
    expect(barSpaceForViewport(GRID_W, 120)).toBe(4);
  });

  it('R2：越界安全网 → min=1 / max=50（引擎硬限 barSpaceLimit）', () => {
    expect(barSpaceForViewport(MAIN_W, 10000)).toBe(MIN_BAR_SPACE);
    expect(barSpaceForViewport(MAIN_W, 1)).toBe(MAX_BAR_SPACE);
    expect(MIN_BAR_SPACE).toBe(1);
    expect(MAX_BAR_SPACE).toBe(50);
  });

  it('R2：width ≤ 0（未布局）→ null（不设置 barSpace）', () => {
    expect(barSpaceForViewport(0, 120)).toBeNull();
    expect(barSpaceForViewport(-5, 120)).toBeNull();
    expect(barSpaceForViewport(Number.NaN, 120)).toBeNull();
  });
});

describe('fitBarSpaceToViewport（设置 barSpace + 留痕）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常路径：setBarSpace(8) 并在元素上写 data-viewport-fit（bars/space/visible/clamped）', () => {
    const chart = fakeChart();
    const el = fakeEl(MAIN_W);
    const out = fitBarSpaceToViewport(chart, el, 120);
    expect(chart.setBarSpace).toHaveBeenCalledWith(8);
    expect(out).toEqual({ space: 8, clamped: false });
    expect(el.getAttribute('data-viewport-fit')).toBe(
      JSON.stringify({ bars: 120, space: 8, visible: 122, clamped: false }),
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('width ≤ 0 或 el 缺失 → 返回 null，不调用 setBarSpace', () => {
    const chart = fakeChart();
    expect(fitBarSpaceToViewport(chart, fakeEl(0), 120)).toBeNull();
    expect(fitBarSpaceToViewport(chart, null, 120)).toBeNull();
    expect(chart.setBarSpace).not.toHaveBeenCalled();
  });

  it('夹取（raw space 越出 [1,50]）→ clamped=true + 一次 console.warn，并按 chart 实例去重', () => {
    const chart = fakeChart();
    const el = fakeEl(MAIN_W);
    const out1 = fitBarSpaceToViewport(chart, el, 10000); // raw≈0.098 → 夹到 1
    expect(out1).toEqual({ space: 1, clamped: true });
    expect(el.getAttribute('data-viewport-fit')).toContain('"clamped":true');
    fitBarSpaceToViewport(chart, el, 1); // 同一 chart 实例再次夹取 → 不再刷屏
    expect(console.warn).toHaveBeenCalledTimes(1);
    // 结构化留痕（§5 观测性）：width/viewportBars/space/clamped
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({ width: MAIN_W, viewportBars: 10000, space: 1, clamped: true }),
    );
    // 新 chart 实例（重建）→ 重新允许一次告警
    fitBarSpaceToViewport(fakeChart(), el, 10000);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
