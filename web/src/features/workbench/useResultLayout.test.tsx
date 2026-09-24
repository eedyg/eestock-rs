/**
 * ADR-028 §2.7 第 3 项（**方向语义**，2026-09-24 补齐）—— 分隔条拖拽的**方向 + 1:1 位移**判据（jsdom 合成鼠标事件）。
 *
 * 契约（唯一事实源 = `design/01-architecture/adr/ADR-028-…§2.7` 第 3 项）：
 *  - 分隔条位于下栏**上沿** ⇒ **鼠标向上（Δy < 0）⇒ 下栏变高**（`detailPx = startDetail − Δy`）；
 *  - **鼠标向下（Δy > 0）⇒ 下栏变矮**；位移 **1:1**；
 *  - 双击分隔条 ⇒ 比例复位 `DEFAULT_DETAIL_RATIO`（0.4）。
 *
 * **与卡片把手方向相反**（卡片把手在下沿 ⇒ 向下拖 = 卡片变高；见 `cardResize.tsx` / `cardResize.test.tsx`），
 * 两者符号不同是几何决定的，**禁止互相套用** —— 本文件末尾用一条「双把手同规格」用例把这条反向关系钉住。
 *
 * jsdom 口径：`splitRef` 未挂载 ⇒ `availablePx = 0` ⇒ 几何退化为「按视口高换算」
 * （`detailPx = round(window.innerHeight × ratio)`）⇒ 方向与 1:1 位移在此口径下可**精确**判定（±2px）。
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useResultLayout } from './useResultLayout';
import { useCardResize } from './cardResize';
import { DEFAULT_DETAIL_RATIO, RESULT_LAYOUT_STORAGE_KEY, type LayoutStorage } from './resultLayout';

const DRAG_PX = 120;
const TOL_PX = 2;

/** 注入式内存 storage（起点比例固定 0.4，杜绝用例间串味）。 */
function fakeStorage(seed: Record<string, string> = {}): LayoutStorage {
  const map = new Map<string, string>(
    Object.entries({
      [RESULT_LAYOUT_STORAGE_KEY]: JSON.stringify({ ratio: DEFAULT_DETAIL_RATIO, collapsed: false }),
      ...seed,
    }),
  );
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 测试宿主：把 hook 的 API 原样接到 DOM 上（分隔条可被真鼠标事件命中）。 */
function LayoutHarness({ storage }: { storage: LayoutStorage }) {
  const r = useResultLayout({ storage });
  return (
    <div>
      <div {...r.splitterProps} />
      <span data-testid="detail-px">{r.detailPx}</span>
      <span data-testid="ratio">{r.ratio}</span>
    </div>
  );
}

function readDetailPx(): number {
  return Number(screen.getByTestId('detail-px').textContent);
}

function drag(handle: HTMLElement, fromY: number, toY: number, steps = 1): void {
  fireEvent.mouseDown(handle, { button: 0, clientY: fromY });
  for (let i = 1; i <= steps; i++) {
    fireEvent.mouseMove(window, { clientY: fromY + ((toY - fromY) * i) / steps });
  }
  fireEvent.mouseUp(window, { clientY: toY });
}

describe('D7-3（方向语义）：分隔条拖拽 = 上移变高 / 下移变矮（位移 1:1）', () => {
  it('向上拖 −120px ⇒ 下栏 px **增加** ≈120（分隔条在下栏上沿，契约 §2.7-3）', () => {
    render(<LayoutHarness storage={fakeStorage()} />);
    const before = readDetailPx();
    expect(before, '前置：默认 40% 视口高的下栏 px（jsdom 视口 768 ⇒ 307）').toBeGreaterThan(0);
    drag(screen.getByTestId('wb-pane-splitter'), 500, 500 - DRAG_PX, 6);
    const after = readDetailPx();
    expect(
      after - before,
      `上移 ${DRAG_PX}px ⇒ 下栏必须变高 ${DRAG_PX}±${TOL_PX}（起点 ${before} → 实读 ${after}）`,
    ).toBeGreaterThan(DRAG_PX - TOL_PX);
    expect(Math.abs(after - before - DRAG_PX), `位移必须 1:1（实读 Δ${after - before}）`).toBeLessThanOrEqual(TOL_PX);
  });

  it('向下拖 +120px ⇒ 下栏 px **减少** ≈120', () => {
    render(<LayoutHarness storage={fakeStorage()} />);
    const before = readDetailPx();
    drag(screen.getByTestId('wb-pane-splitter'), 200, 200 + DRAG_PX, 6);
    const after = readDetailPx();
    expect(
      after - before,
      `下移 ${DRAG_PX}px ⇒ 下栏必须变矮 ${DRAG_PX}±${TOL_PX}（起点 ${before} → 实读 ${after}）`,
    ).toBeLessThan(-(DRAG_PX - TOL_PX));
    expect(Math.abs(after - before + DRAG_PX), `位移必须 1:1（实读 Δ${after - before}）`).toBeLessThanOrEqual(TOL_PX);
  });

  it('位移按**起点**累计（多次 mousemove 不得累加漂移）：−60 再 −120 ⇒ 净 +120', () => {
    render(<LayoutHarness storage={fakeStorage()} />);
    const before = readDetailPx();
    const splitter = screen.getByTestId('wb-pane-splitter');
    fireEvent.mouseDown(splitter, { button: 0, clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 440 });
    const mid = readDetailPx();
    expect(mid - before, `中途 −60 ⇒ +60（实读 Δ${mid - before}）`).toBeGreaterThan(60 - TOL_PX);
    fireEvent.mouseMove(window, { clientY: 380 });
    const end = readDetailPx();
    expect(Math.abs(end - before - DRAG_PX), `终点 −120 ⇒ 净 +120（实读 Δ${end - before}）`).toBeLessThanOrEqual(TOL_PX);
  });

  it('双击分隔条 ⇒ 比例复位 40%（±0.02 / ±2px）', () => {
    render(<LayoutHarness storage={fakeStorage()} />);
    const splitter = screen.getByTestId('wb-pane-splitter');
    const before = readDetailPx();
    drag(splitter, 500, 500 - 300, 6);
    const dragged = readDetailPx();
    expect(dragged, '前置：拖拽后下栏必须已改变（否则「复位」无鉴别力）').toBeGreaterThan(before + 100);
    fireEvent.doubleClick(splitter);
    const reset = readDetailPx();
    expect(Number(screen.getByTestId('ratio').textContent), '双击 ⇒ 比例回 0.4').toBeCloseTo(DEFAULT_DETAIL_RATIO, 2);
    expect(Math.abs(reset - before), `双击 ⇒ 下栏 px 回默认（起点 ${before} → 实读 ${reset}）`).toBeLessThanOrEqual(TOL_PX);
  });
});

describe('D7-3/D6（方向不得互相套用）：分隔条与卡片把手的符号**相反**', () => {
  /** 同一页里两枚把手（分隔条在上沿、卡片把手在下沿）；卡片高度与产品一致由外层 state 持久化。 */
  function BothHandles() {
    const layout = useResultLayout({ storage: fakeStorage() });
    const [cardPx, setCardPx] = useState<number | null>(null);
    const card = useCardResize({ cardId: 'kline', heightPx: cardPx, onCommit: setCardPx, defaultPx: 300 });
    return (
      <div>
        <div {...layout.splitterProps} />
        <div {...card.handleProps} />
        <span data-testid="detail-px">{layout.detailPx}</span>
        <span data-testid="card-px">{card.heightPx}</span>
      </div>
    );
  }

  it('分隔条向上拖 120 ⇒ 下栏 **+120**；卡片把手向下拖 120 ⇒ 卡片 **+120**（两者反向，禁止互相套用）', () => {
    render(<BothHandles />);
    const detailBefore = readDetailPx();
    drag(screen.getByTestId('wb-pane-splitter'), 500, 500 - DRAG_PX, 6);
    expect(readDetailPx() - detailBefore, '分隔条：上移 ⇒ 下栏变高').toBeGreaterThan(DRAG_PX - TOL_PX);

    drag(screen.getByTestId('wb-card-resize-kline'), 300, 300 + DRAG_PX, 6);
    expect(
      Number(screen.getByTestId('card-px').textContent) - 300,
      '卡片把手（下沿）：下移 ⇒ 卡片变高（与分隔条方向相反）',
    ).toBeGreaterThan(DRAG_PX - TOL_PX);
    expect(Number(screen.getByTestId('card-px').textContent), '卡片新高度 = 300+120').toBe(300 + DRAG_PX);
  });
});
