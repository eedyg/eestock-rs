import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { CURVE_PAD as PAD, CURVE_W as W } from './curveGeometry';
import { mapLineByDomain, type CurveXDomain } from './chartUtils';
import {
  CurveReadoutFrame,
  anchorsOf,
  buildSamples,
  clientXToUserX,
  fmtEquityValue,
  fmtScore,
  fmtTickPct,
  layoutTicks,
  nearestAnchorIndex,
  valueToY,
  type ReadoutSeries,
} from './curveReadout';

/**
 * ADR-028 D12/D13（09-plan §2/§3）——**共用**刻度/取值组件与几何纯函数（先红后绿）。
 *
 * 「文字不变形」自证口径（09-plan §1.2-1，`preserveAspectRatio="none"`）：
 * 刻度标签**必须**在**不被非等比拉伸的层**（HTML 绝对定位叠加层）⇒ 断言 `label.closest('svg') === null`。
 * 若把标签画进曲线 svg（→ 卡片横向拉伸时文字横向变形）本断言变红。
 */

const H = 160;
const BAR_TS = [1_700_000_000, 1_700_000_300, 1_700_000_600, 1_700_000_900, 1_700_001_200];
const XD: CurveXDomain = { mode: 'index', barTs: BAR_TS, toleranceSec: 2 };

/** jsdom 无布局：给 frame 根元素一个确定盒子（600×180），使 clientX → bar 索引可判别。 */
const RECT = { left: 0, top: 0, width: 600, height: 180, right: 600, bottom: 180, x: 0, y: 0 };
let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...RECT,
    toJSON: () => RECT,
  } as unknown as DOMRect);
});
afterEach(() => {
  rectSpy.mockRestore();
});

// ───────────────────────── 纯函数 ─────────────────────────

describe('R1 valueToY / layoutTicks 与曲线**同一套**几何（禁第二套 y 映射）', () => {
  it('valueToY 必须与 mapLineByDomain 的 y 逐点相同（否则刻度与曲线错位）', () => {
    const [min, max] = [100, 105];
    for (const v of [100, 102, 104, 105]) {
      const mapped = mapLineByDomain([[BAR_TS[0]!, v]], XD, min, max, W, H, PAD).points[0]!;
      expect(valueToY(v, min, max, H, PAD)).toBeCloseTo(mapped.y, 10);
    }
  });

  it('layoutTicks：pct 由同一 y 换算，zero 标记给到「含 0 的卡」的 0 刻度', () => {
    const items = layoutTicks({ ticks: [0, 50, 100], min: 0, max: 100, height: H, pad: PAD, fmt: fmtScore });
    expect(items.map((t) => t.label)).toEqual(['0', '50', '100']);
    expect(items.map((t) => t.zero)).toEqual([true, false, false]);
    for (const t of items) expect(t.pct).toBeCloseTo((valueToY(t.value, 0, 100, H, PAD) / H) * 100, 10);
    expect(items[0]!.pct).toBeGreaterThan(items[2]!.pct); // y 向下 ⇒ 大值在上
  });
});

describe('R2 clientXToUserX：像素 → viewBox user unit（与被拉伸的 svg 一致）', () => {
  it('线性换算（含 viewX0 偏移）', () => {
    expect(clientXToUserX({ clientX: 300, left: 0, width: 600, viewX0: -10, viewW: 1040 })).toBeCloseTo(510, 9);
    expect(clientXToUserX({ clientX: 0, left: 0, width: 600, viewX0: -10, viewW: 1040 })).toBeCloseTo(-10, 9);
    expect(clientXToUserX({ clientX: 60, left: 30, width: 600, viewX0: 0, viewW: W })).toBeCloseTo(50, 9);
  });

  it('盒子不可测（jsdom 0 宽）/非有限输入 ⇒ null（不得除零自造坐标）', () => {
    expect(clientXToUserX({ clientX: 10, left: 0, width: 0, viewX0: 0, viewW: W })).toBeNull();
    expect(clientXToUserX({ clientX: NaN, left: 0, width: 600, viewX0: 0, viewW: W })).toBeNull();
  });
});

describe('R3 nearestAnchorIndex / anchorsOf：最近点选择（禁插值）', () => {
  it('取最近的已加载点（平手取索引小者）', () => {
    const anchors = [{ x: 8 }, { x: 100 }, { x: 192 }];
    expect(nearestAnchorIndex(anchors, 101)).toBe(1);
    expect(nearestAnchorIndex(anchors, 96)).toBe(1);
    expect(nearestAnchorIndex(anchors, 147)).toBe(2);
    expect(nearestAnchorIndex(anchors, 0)).toBe(0);
    expect(nearestAnchorIndex([], 10)).toBe(-1);
  });

  it('anchorsOf：多线按 ts 去重、按 x 升序（同卡多线共用同一 bar 锚点）', () => {
    const series: ReadoutSeries[] = [
      { label: 'A', fmt: String, samples: [{ ts: 2, x: 100, y: 1, value: 1 }, { ts: 1, x: 8, y: 2, value: 2 }] },
      { label: 'B', fmt: String, samples: [{ ts: 2, x: 100, y: 1, value: 3 }] },
    ];
    expect(anchorsOf(series).map((a) => a.ts)).toEqual([1, 2]);
    expect(anchorsOf(series).map((a) => a.x)).toEqual([8, 100]);
  });
});

describe('R4 buildSamples：只用已加载原始点 + 与绘制同一 x 映射（禁插值/禁 ts 反算）', () => {
  it('x 与 y 必须与 mapLineByDomain 逐点相同；无槽位点被跳过', () => {
    const pts: Array<[number, number]> = [
      [BAR_TS[0]!, 100],
      [BAR_TS[1]!, 101],
      [BAR_TS[2]! + 60, 102], // 不在 bar 序列上（剔除）
      [BAR_TS[3]!, 103],
    ];
    const { samples, unmatched } = buildSamples({ pts, xd: XD, min: 100, max: 103, width: W, height: H, pad: PAD });
    const mapped = mapLineByDomain(pts, XD, 100, 103, W, H, PAD);
    expect(unmatched).toBe(1);
    expect(samples.length).toBe(mapped.points.length);
    samples.forEach((s, i) => {
      expect(s.x).toBeCloseTo(mapped.points[i]!.x, 10);
      expect(s.y).toBeCloseTo(mapped.points[i]!.y, 10);
    });
    // 值必须是**原始点值**（禁插值）
    expect(samples.map((s) => s.value)).toEqual([100, 101, 103]);
    expect(samples.map((s) => s.ts)).toEqual([BAR_TS[0], BAR_TS[1], BAR_TS[3]]);
  });
});

// ───────────────────────── 组件 ─────────────────────────

function mkSeries(): ReadoutSeries[] {
  const pts: Array<[number, number]> = BAR_TS.map((ts, i) => [ts, 100 + i * 10]);
  const { samples } = buildSamples({ pts, xd: XD, min: 100, max: 140, width: W, height: H, pad: PAD });
  return [{ label: '净值', color: '#38bdf8', samples, fmt: fmtEquityValue }];
}

function renderFrame(series: ReadoutSeries[] = mkSeries()) {
  const ticks = layoutTicks({ ticks: [100, 120, 140], min: 100, max: 140, height: H, pad: PAD, fmt: fmtEquityValue });
  return render(
    <CurveReadoutFrame
      card="equity"
      height={H}
      viewX0={0}
      viewW={W}
      svgClassName="h-40 w-full"
      ariaLabel="测试曲线"
      ticks={ticks}
      series={series}
    >
      <polyline points="8,8 992,100" fill="none" data-testid="test-line" />
    </CurveReadoutFrame>,
  );
}

/** 把 viewBox user unit 换成像素 clientX（600px 宽盒子）。 */
const ux2px = (ux: number) => (ux / W) * RECT.width;

describe('R5 刻度渲染：网格在最底层 + 标签在**不被拉伸的层**', () => {
  it('刻度标签数量 = 刻度数，且**不在**被 preserveAspectRatio="none" 的 svg 内', () => {
    const { getByTestId } = renderFrame();
    const band = getByTestId('wb-axis-ticks-equity');
    const labels = band.querySelectorAll('[data-testid^="wb-axis-tick-equity-"]');
    expect(labels.length).toBe(3);
    for (const l of Array.from(labels)) {
      expect(l.closest('svg'), '刻度文本必须在 HTML 叠加层（否则随卡片拉伸变形）').toBeNull();
      expect(l.tagName.toLowerCase()).toBe('span');
    }
    expect(band.closest('svg')).toBeNull();
  });

  it('网格线与被拉伸 svg 同层且绘于曲线之前（最底层）', () => {
    const { getByTestId, container } = renderFrame();
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    const grid = getByTestId('wb-axis-grid-equity');
    expect(grid.parentElement).toBe(svg);
    expect(grid.querySelectorAll('line').length).toBe(3);
    // 最底层：网格分组必须是 svg 的第一个子元素（曲线/阈值线之后绘制 ⇒ 压不过曲线）
    expect(svg.firstElementChild).toBe(grid);
    expect(svg.querySelector('[data-testid="test-line"]')).not.toBeNull();
  });

  it('0 刻度视觉区别（含 0 的卡）', () => {
    const ticks = layoutTicks({ ticks: [0, 50, 100], min: 0, max: 100, height: H, pad: PAD, fmt: fmtScore });
    const { getByTestId } = render(
      <CurveReadoutFrame card="aggregate" height={H} viewX0={0} viewW={W} svgClassName="h-40 w-full" ariaLabel="t" ticks={ticks} series={[]}>
        <polyline points="8,8 992,100" />
      </CurveReadoutFrame>,
    );
    expect(getByTestId('wb-axis-tick-aggregate-0')).toHaveAttribute('data-zero', 'true');
    expect(getByTestId('wb-axis-tick-aggregate-1')).toHaveAttribute('data-zero', 'false');
    expect(getByTestId('wb-axis-grid-aggregate-0')).toHaveAttribute('data-zero', 'true');
  });
});

describe('R6 时刻取值：悬停读数 == 序列原值；点击锁定 / 再点解除 / Esc / 方向键', () => {
  it('悬停两个位置 ⇒ 读数逐点等于序列原值', () => {
    const { container, getByTestId } = renderFrame();
    const frame = container.querySelector('[data-testid="wb-readout-frame-equity"]') as HTMLElement;
    // 第 0 根 bar 的 x = PAD=8；第 2 根 bar 的 x = 8 + 2/4*984 = 500
    fireEvent.mouseMove(frame, { clientX: ux2px(9) });
    expect(getByTestId('wb-readout-equity').textContent).toContain('100.00');
    fireEvent.mouseMove(frame, { clientX: ux2px(500) });
    expect(getByTestId('wb-readout-equity').textContent).toContain('120.00');
  });

  it('十字线随悬停出现，读数含该 bar 的 ts', () => {
    const { container, getByTestId } = renderFrame();
    const frame = container.querySelector('[data-testid="wb-readout-frame-equity"]') as HTMLElement;
    expect(container.querySelector('[data-testid="wb-crosshair-equity"]')).toBeNull();
    fireEvent.mouseMove(frame, { clientX: ux2px(500) });
    expect(container.querySelector('[data-testid="wb-crosshair-equity"]')).not.toBeNull();
    expect(getByTestId('wb-readout-equity').textContent).toContain('11-15 06:23'); // fmtTs(1_700_000_600)
  });

  it('点击 ⇒ 锁定标记出现；再点同点 ⇒ 解除；Esc / 点击卡外 ⇒ 解除', () => {
    const { container } = renderFrame();
    const frame = container.querySelector('[data-testid="wb-readout-frame-equity"]') as HTMLElement;
    fireEvent.mouseMove(frame, { clientX: ux2px(500) });
    fireEvent.click(frame, { clientX: ux2px(500) });
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).not.toBeNull();
    // 锁定后鼠标移出仍在
    fireEvent.mouseLeave(frame);
    expect(container.querySelector('[data-testid="wb-readout-equity"]')).not.toBeNull();

    // 再点同点 ⇒ 解除
    fireEvent.click(frame, { clientX: ux2px(500) });
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).toBeNull();

    // Esc 解除
    fireEvent.click(frame, { clientX: ux2px(500) });
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).toBeNull();

    // 点击卡外解除
    fireEvent.click(frame, { clientX: ux2px(500) });
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).not.toBeNull();
    fireEvent.click(document.body);
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).toBeNull();
  });

  it('←/→ 移动取值点且读数随之变化；锁定时移动的是锁定点', () => {
    const { container, getByTestId } = renderFrame();
    const frame = container.querySelector('[data-testid="wb-readout-frame-equity"]') as HTMLElement;
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(getByTestId('wb-readout-equity').textContent).toContain('100.00');
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(getByTestId('wb-readout-equity').textContent).toContain('110.00');
    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(getByTestId('wb-readout-equity').textContent).toContain('100.00');
    // 键盘态不被 mouseleave 清掉（键盘可达性：不依赖指针）
    fireEvent.mouseLeave(frame);
    expect(container.querySelector('[data-testid="wb-readout-equity"]')).not.toBeNull();
  });

  it('卡可聚焦（tabIndex=0）', () => {
    const { container } = renderFrame();
    const frame = container.querySelector('[data-testid="wb-readout-frame-equity"]') as HTMLElement;
    expect(frame.tabIndex).toBe(0);
  });

  it('同卡多线一并显示（缺失该 bar 的线给 —）', () => {
    const s = mkSeries();
    const partial: ReadoutSeries = { label: '回撤', fmt: fmtTickPct, samples: [{ ts: BAR_TS[2]!, x: 500, y: 100, value: 0.0123 }] };
    const { container, getByTestId } = renderFrame([...s, partial]);
    const frame = container.querySelector('[data-testid="wb-readout-frame-equity"]') as HTMLElement;
    fireEvent.mouseMove(frame, { clientX: ux2px(500) });
    const text = getByTestId('wb-readout-equity').textContent ?? '';
    expect(text).toContain('净值');
    expect(text).toContain('120.00');
    expect(text).toContain('回撤');
    expect(text).toContain('1.23%');
    fireEvent.mouseMove(frame, { clientX: ux2px(9) });
    expect(getByTestId('wb-readout-equity').textContent).toContain('—');
  });

  it('盒子不可测（width=0）⇒ 不产生读数（不得自造坐标）', () => {
    rectSpy.mockReturnValue({ ...RECT, width: 0, right: 0, toJSON: () => RECT } as unknown as DOMRect);
    const { container } = renderFrame();
    const frame = container.querySelector('[data-testid="wb-readout-frame-equity"]') as HTMLElement;
    fireEvent.mouseMove(frame, { clientX: 10 });
    expect(container.querySelector('[data-testid="wb-readout-equity"]')).toBeNull();
  });
});
