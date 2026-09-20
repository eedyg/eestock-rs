import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useCardResize } from './cardResize';
import { AggregateScoreChart } from './AggregateScoreChart';
import { CURVE_PAD, CURVE_W } from './curveGeometry';
import type { CurveXDomain } from './chartUtils';

/**
 * ADR-028 §2.4c 第 3 项「卡片下边缘拖拽自由调高 + 双击标题复位」的**行为面**单测：
 *  - 拖拽期间卡片高度跟随指针位移（clamp 到 [120, 1200]）；
 *  - 松手**一次**提交（持久化由调用方落 key，本 hook 只回调）；
 *  - 双击标题 ⇒ 复位（提交 null = 回默认渲染）；
 *  - `heightPx != null` ⇒ svg 必须随容器（`h-full`），且卡片显式 `flex-shrink:0`（否则被 flex 吞回）。
 */
const XD: CurveXDomain = { mode: 'index', barTs: [1_700_000_000, 1_700_000_300, 1_700_000_600], toleranceSec: 2 };

/** 测试宿主：把 hook 的 API 原样接到一个可控 div 上（不引入 ResultView 的重依赖）。 */
function Harness({ onCommit, heightPx = null }: { onCommit: (px: number | null) => void; heightPx?: number | null }) {
  const r = useCardResize({ cardId: 'kline', heightPx, onCommit, defaultPx: 256 });
  return (
    <div data-testid="host">
      <div {...r.handleProps} />
      <button type="button" data-testid="reset" onClick={r.reset} />
      <span data-testid="active">{String(r.active)}</span>
      <span data-testid="live">{String(r.heightPx)}</span>
    </div>
  );
}

describe('C1 拖拽（下边缘把手）：跟手、clamp、松手单次提交', () => {
  it('下拖 100px ⇒ 提交 256+100=356；拖拽期间实时反映', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const handle = screen.getByTestId('wb-card-resize-kline');
    fireEvent.mouseDown(handle, { button: 0, clientY: 500 });
    // 拖拽中：跟手（jsdom 无真实 rect ⇒ 起点取 defaultPx 256）
    fireEvent.mouseMove(window, { clientY: 600 });
    expect(screen.getByTestId('active').textContent).toBe('true');
    expect(Number(screen.getByTestId('live').textContent)).toBe(356);
    fireEvent.mouseUp(window, { clientY: 600 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(356);
    expect(screen.getByTestId('active').textContent, '松手后回到受控值').toBe('false');
  });

  it('上拖越过下限 ⇒ 夹紧到 120（不得为负/为零高）', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 500 });
    fireEvent.mouseMove(window, { clientY: -5000 });
    fireEvent.mouseUp(window, { clientY: -5000 });
    expect(onCommit).toHaveBeenCalledWith(120);
  });

  it('上拖越过上限 ⇒ 夹紧到 1200', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 90_000 });
    fireEvent.mouseUp(window, { clientY: 90_000 });
    expect(onCommit).toHaveBeenCalledWith(1200);
  });

  it('已受控高度作为拖拽起点（380 ⇒ 再拖 +20 = 400）', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} heightPx={380} />);
    fireEvent.mouseDown(screen.getByTestId('wb-card-resize-kline'), { button: 0, clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 120 });
    fireEvent.mouseUp(window, { clientY: 120 });
    expect(onCommit).toHaveBeenCalledWith(400);
  });

  it('把手可被「宽 > 100 且高 ≤ 10」筛选命中（与 klinecharts 分隔线同口径，供真渲染拖拽）', () => {
    render(<Harness onCommit={vi.fn()} />);
    const h = screen.getByTestId('wb-card-resize-kline') as HTMLElement;
    expect(h.style.cursor).toBe('ns-resize');
    expect(h.getAttribute('data-card-resize')).toBe('kline');
  });
});

describe('C2 双击标题复位', () => {
  it('双击标题 ⇒ 提交 null（回默认渲染）且立即回默认', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<Harness onCommit={onCommit} heightPx={420} />);
    expect(screen.getByTestId('active').textContent).toBe('true');
    // 标题由调用组件渲染（见 C4 聚合卡）；hook 侧复位入口 = reset()
    fireEvent.click(screen.getByTestId('reset'));
    expect(onCommit).toHaveBeenCalledWith(null);
    rerender(<Harness onCommit={onCommit} heightPx={null} />);
    expect(screen.getByTestId('active').textContent).toBe('false');
  });
});

describe('C4 曲线卡（聚合）随容器：svg 必须 h-full + 卡片 shrink-0', () => {
  const perBar = [1_700_000_000, 1_700_000_300, 1_700_000_600].map((ts, i) => ({ ts, aggregate: 50 + i }) as never);

  function Curve({ onCommit, heightPx }: { onCommit: (px: number | null) => void; heightPx: number | null }) {
    const resize = useCardResize({ cardId: 'aggregate', heightPx, onCommit, defaultPx: 186 });
    return (
      <AggregateScoreChart
        perBar={perBar}
        buyThreshold={70}
        sellThreshold={30}
        xDomain={XD}
        plot={null}
        resize={resize}
      />
    );
  }

  it('默认（heightPx=null）⇒ svg 固定 h-40、卡片无 inline 高度（既有渲染不变）', () => {
    const { container } = render(<Curve onCommit={vi.fn()} heightPx={null} />);
    const host = container.querySelector('[data-testid="wb-aggregate-chart"]') as HTMLElement;
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('h-40');
    expect(host.style.height).toBe('');
  });

  it('受控高度 ⇒ svg h-full（随容器）+ 卡片 height:<px> + flex-shrink:0', () => {
    const { container } = render(<Curve onCommit={vi.fn()} heightPx={340} />);
    const host = container.querySelector('[data-testid="wb-aggregate-chart"]') as HTMLElement;
    const svg = host.querySelector('svg')!;
    expect(host.style.height).toBe('340px');
    expect(host.style.flexShrink, '被 flex 收缩吞回高度是探针实测缺陷 ⇒ 必须 shrink-0').toBe('0');
    expect(svg.getAttribute('class')).toContain('h-full');
    expect(svg.getAttribute('class')).not.toContain('h-40');
  });

  it('拖拽把手存在且双击卡片标题复位', () => {
    const onCommit = vi.fn();
    const { container } = render(<Curve onCommit={onCommit} heightPx={340} />);
    const host = container.querySelector('[data-testid="wb-aggregate-chart"]') as HTMLElement;
    expect(host.querySelector('[data-testid="wb-card-resize-aggregate"]')).not.toBeNull();
    fireEvent.doubleClick(host.querySelector('[data-testid="wb-card-title-aggregate"]')!);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('受控高度不改变 x 几何（PAD 与 plot 边界不变）', () => {
    const { container } = render(<Curve onCommit={vi.fn()} heightPx={340} />);
    const xs = (container.querySelector('polyline')!.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .map((t) => Number(t.split(',')[0]));
    expect(xs[0]).toBe(CURVE_PAD);
    expect(xs[xs.length - 1]).toBe(CURVE_W - CURVE_PAD);
  });
});
