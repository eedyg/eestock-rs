/**
 * ADR-028 §2.9（**D9**）—— 三视图布局**状态层**判据（jsdom 合成鼠标事件）。
 *
 * 契约（唯一事实源 = ADR-028 §2.8/§2.9 第 6/8 项）：
 *  - 两条分隔条（`wb-splitter-kline-indicators` / `wb-splitter-indicators-detail`）；
 *  - **方向语义（2026-09-24 二次纠错后为准）**：鼠标**向上**（Δy < 0）⇒ **下方**视图变高、上方视图变矮
 *    （`upperPx = startUpper + Δy` / `lowerPx = startLower − Δy`）；位移 **1:1**；
 *  - **卡片把手方向相反**（把手在卡片下沿 ⇒ 向下 = 卡片变高；`cardResize.test.tsx` 已覆盖）——
 *    两者符号不同是几何决定的，**禁止互相套用**；
 *  - 双击各自复位默认比例；per-view 收起/展开（**K 线视图无收起 API**）；
 *  - **可用高口径**：`视口高 − 132`（jsdom 无布局 ⇒ splitRef 未挂载 ⇒ 走该口径）；
 *  - **D9-13**：`subPaneCount` 变化 ⇒ K 线视图有效下限 299→329 ⇒ **重夹**（记忆/比例不得绕过）。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useResultLayout } from './useResultLayout';
import { RESULT_LAYOUT_STORAGE_KEY, availableForViewport, type LayoutStorage, type ViewRatios } from './resultLayout';

const TOL_PX = 2;

function fakeStorage(seed: Record<string, string> = {}): LayoutStorage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 测试宿主：把 hook 的 API 原样接到 DOM 上（两条分隔条 + 三段高度读数）。 */
function LayoutHarness({ storage, subPaneCount = 1 }: { storage: LayoutStorage; subPaneCount?: number }) {
  const r = useResultLayout({ storage, subPaneCount });
  return (
    <div>
      <div {...r.splitterProps('kline-indicators')} />
      <div {...r.splitterProps('indicators-detail')} />
      <span data-testid="kline-px">{r.klinePx}</span>
      <span data-testid="indicators-px">{r.indicatorsPx}</span>
      <span data-testid="detail-px">{r.detailPx}</span>
      <span data-testid="available">{r.availablePx}</span>
      <span data-testid="collapsed">{`${r.collapsed.indicators}/${r.collapsed.detail}`}</span>
      <span data-testid="disclosure">{r.disclosure ?? ''}</span>
      <span data-testid="clamped">{r.clamped ? 'true' : 'false'}</span>
      <button type="button" data-testid="collapse-indicators" onClick={() => r.collapse('indicators')} />
      <button type="button" data-testid="expand-indicators" onClick={() => r.expand('indicators')} />
    </div>
  );
}

const read = (id: string) => Number(screen.getByTestId(id).textContent);

function drag(handle: HTMLElement, fromY: number, toY: number, steps = 6): void {
  fireEvent.mouseDown(handle, { button: 0, clientY: fromY });
  for (let i = 1; i <= steps; i++) {
    fireEvent.mouseMove(window, { clientY: fromY + ((toY - fromY) * i) / steps });
  }
  fireEvent.mouseUp(window, { clientY: toY });
}

describe('D9-6：两条分隔条 = 2 自由度守恒（jsdom 口径：可用高 = 视口 − 132）', () => {
  it('默认三段之和 == 可用高（守恒）；三段均不低于可读下限', () => {
    render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
    const avail = read('available');
    expect(avail).toBe(availableForViewport(window.innerHeight));
    expect(Math.abs(read('kline-px') + read('indicators-px') + read('detail-px') - avail)).toBeLessThanOrEqual(TOL_PX);
    expect(read('kline-px')).toBeGreaterThanOrEqual(299);
    expect(read('indicators-px')).toBeGreaterThanOrEqual(180);
    expect(read('detail-px')).toBeGreaterThanOrEqual(95);
  });

  /** 富余档视口（1400 ⇒ 可用 1268）：默认 697/368/203 ⇒ 两方向各留 ≥240px 余量，1:1 才可量。 */
  const withRichViewport = (fn: () => void): void => {
    const prev = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 1400, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: prev, configurable: true });
    }
  };

  it('K线↔指标：向上拖 100 ⇒ **指标变高 / K 线变矮**（1:1，未触下限；明细不动）', () => {
    withRichViewport(() => {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
      const k0 = read('kline-px');
      const i0 = read('indicators-px');
      const d0 = read('detail-px');
      const avail = read('available');
      drag(screen.getByTestId('wb-splitter-kline-indicators'), 900, 900 - 100);
      const k1 = read('kline-px');
      const i1 = read('indicators-px');
      expect(i1, `边界上移 ⇒ **下方**视图变大（${i0} → ${i1}；**错符号实现此处为 ${i0 - 100}**）`).toBeGreaterThan(i0);
      expect(Math.abs(i1 - i0 - 100), `下方视图 1:1 变高 100（实读 Δ${i1 - i0}）`).toBeLessThanOrEqual(TOL_PX);
      expect(k1, `上方视图反向（${k0} → ${k1}；**错符号实现此处为 ${k0 + 100}**）`).toBeLessThan(k0);
      expect(Math.abs(k0 - k1 - 100), `上方视图 1:1 变矮 100（实读 Δ${k0 - k1}）`).toBeLessThanOrEqual(TOL_PX);
      expect(read('detail-px'), '第三视图（明细）完全不动').toBe(d0);
      expect(Math.abs(k1 + i1 + read('detail-px') - avail), '守恒：三段之和 == 可用高').toBeLessThanOrEqual(TOL_PX);
    });
  });

  it('指标↔明细：向上拖 100 ⇒ **明细变高 / 指标变矮**（1:1，未触下限；K 线不动）', () => {
    withRichViewport(() => {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
      const k0 = read('kline-px');
      const i0 = read('indicators-px');
      const d0 = read('detail-px');
      drag(screen.getByTestId('wb-splitter-indicators-detail'), 900, 900 - 100);
      const i1 = read('indicators-px');
      const d1 = read('detail-px');
      expect(d1, `边界上移 ⇒ **下方**视图（明细）变大（${d0} → ${d1}；**错符号实现此处为 ${d0 - 100}**）`).toBeGreaterThan(d0);
      expect(Math.abs(d1 - d0 - 100), `明细 1:1 变高 100（实读 Δ${d1 - d0}）`).toBeLessThanOrEqual(TOL_PX);
      expect(Math.abs(i0 - i1 - 100), `指标 1:1 变矮 100（实读 Δ${i0 - i1}）`).toBeLessThanOrEqual(TOL_PX);
      expect(read('kline-px'), '第三视图（K 线）完全不动').toBe(k0);
    });
  });

  it('方向反证（下拖 = 边界下移）⇒ 两侧各反向：K 线变高 / 指标变矮（错符号实现此处必红）', () => {
    withRichViewport(() => {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
      const k0 = read('kline-px');
      const i0 = read('indicators-px');
      drag(screen.getByTestId('wb-splitter-kline-indicators'), 600, 600 + 60);
      const k1 = read('kline-px');
      const i1 = read('indicators-px');
      expect(k1, `下移 ⇒ 上方视图变大（${k0} → ${k1}；**错符号实现此处为 ${k0 - 60}**）`).toBeGreaterThan(k0);
      expect(Math.abs(k1 - k0 - 60), `1:1（实读 Δ${k1 - k0}）`).toBeLessThanOrEqual(TOL_PX);
      expect(i1, `下移 ⇒ 下方视图变小（${i0} → ${i1}）`).toBeLessThan(i0);
      expect(Math.abs(i0 - i1 - 60)).toBeLessThanOrEqual(TOL_PX);
    });
  });

  it('触可读下限 clamp（未修复的镜像读数对照）：上拖 400 ⇒ K 线停在 299、指标吸收缺口', () => {
    withRichViewport(() => {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
      const i0 = read('indicators-px');
      drag(screen.getByTestId('wb-splitter-kline-indicators'), 900, 900 - 400);
      expect(read('kline-px'), 'K 线视图停在可读下限 299').toBe(299);
      expect(read('indicators-px'), `缺口从指标回吐（${i0} + 400 − 2 = ${i0 + 398}）`).toBe(i0 + 398);
      expect(screen.getByTestId('clamped').textContent, '触下限必须置位').toBe('true');
    });
  });

  it('分离性：同一页内两条分隔条各管一侧（拖 A 不改 B 的另一侧）', () => {
    render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
    const i0 = read('indicators-px');
    drag(screen.getByTestId('wb-splitter-kline-indicators'), 400, 400 - 40);
    const iAfterA = read('indicators-px');
    const dAfterA = read('detail-px');
    drag(screen.getByTestId('wb-splitter-indicators-detail'), 500, 500 - 40);
    expect(read('detail-px'), '拖 指标↔明细 只改明细（与指标反向；§2.8：上拖 ⇒ **下方**明细变高）').toBeGreaterThan(dAfterA);
    expect(read('indicators-px')).toBeLessThan(iAfterA);
    expect(i0).toBeGreaterThanOrEqual(180);
  });

  it('双击分隔条 ⇒ 复位该边界的默认比例（0.55 : 0.29 / 0.29 : 0.16）', () => {
    render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
    const splitter = screen.getByTestId('wb-splitter-kline-indicators');
    drag(splitter, 400, 400 - 100);
    const kDragged = read('kline-px');
    fireEvent.doubleClick(splitter);
    const kReset = read('kline-px');
    const iReset = read('indicators-px');
    expect(kReset, '双击后 K 线回默认比例（与拖拽态不同 ⇒ 判据有鉴别力）').not.toBe(kDragged);
    // 两段之和守恒，比值回到 0.55 : 0.29
    expect(kReset / (kReset + iReset)).toBeCloseTo(0.55 / 0.84, 2);
  });

  it('分隔条可键盘操作（ArrowDown / ArrowUp 各 ±16px，大视口下无夹取 ⇒ 逐 px 可逆）', () => {
    const prev = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 1400, configurable: true });
    try {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
      const k0 = read('kline-px');
      fireEvent.keyDown(screen.getByTestId('wb-splitter-kline-indicators'), { key: 'ArrowDown' });
      const kDown = read('kline-px');
      // ArrowDown = 边界**下移** ⇒ 上方（K 线）视图变高 16px（§2.8：把手方向 = 边界方向）
      expect(Math.abs(kDown - k0 - 16), `ArrowDown ⇒ 上方视图变高 16px（实读 Δ${kDown - k0}）`).toBeLessThanOrEqual(TOL_PX);
      fireEvent.keyDown(screen.getByTestId('wb-splitter-kline-indicators'), { key: 'ArrowUp' });
      expect(Math.abs(read('kline-px') - k0)).toBeLessThanOrEqual(TOL_PX);
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: prev, configurable: true });
    }
  });
});

describe('D9-3：per-view 收起（状态层）', () => {
  it('收起指标 ⇒ 指标 0、其余按原比例分享（和仍 = 可用高）；展开逐 px 复原', () => {
    render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
    const avail = read('available');
    const before = { k: read('kline-px'), i: read('indicators-px'), d: read('detail-px') };
    fireEvent.click(screen.getByTestId('collapse-indicators'));
    expect(screen.getByTestId('collapsed').textContent).toBe('true/false');
    expect(read('indicators-px')).toBe(0);
    expect(Math.abs(read('kline-px') + read('detail-px') - avail)).toBeLessThanOrEqual(TOL_PX);
    fireEvent.click(screen.getByTestId('expand-indicators'));
    expect(read('kline-px'), '展开逐 px 复原').toBe(before.k);
    expect(read('indicators-px')).toBe(before.i);
    expect(read('detail-px')).toBe(before.d);
  });

  it('收起态**记忆**（写入 v2 键；K 线视图无收起 API ⇒ 结构里不含 kline）', () => {
    const storage = fakeStorage();
    render(<LayoutHarness storage={storage} subPaneCount={1} />);
    fireEvent.click(screen.getByTestId('collapse-indicators'));
    const raw = JSON.parse(storage.getItem(RESULT_LAYOUT_STORAGE_KEY) as string);
    expect(raw.collapsed).toEqual({ indicators: true, detail: false });
    expect(Object.keys(raw.collapsed)).not.toContain('kline');
  });
});

describe('BLOCKED-2 修复：拖拽路径必须披露夹取（禁只在默认分配路径置位）', () => {
  it('拖到 K 线视图可读下限 ⇒ clamped=true 且披露文本非空（禁静默）', () => {
    const prev = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 1400, configurable: true });
    try {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
      expect(screen.getByTestId('clamped').textContent, '前置：默认比例不夹取（可用高 1268 可行）').toBe('false');
      expect(screen.getByTestId('disclosure').textContent, '前置：未夹取时不得有披露').toBe('');
      // 默认 697 / 368 / 203 ⇒ **上拖** 400（边界上移 ⇒ 上方 K 线变矮）必触 K 线视图可读下限 299
      drag(screen.getByTestId('wb-splitter-kline-indicators'), 900, 900 - 400);
      expect(screen.getByTestId('clamped').textContent, '拖到下限必须置位 `data-view-clamped`').toBe('true');
      expect(
        screen.getByTestId('disclosure').textContent,
        '夹取必须显式披露（禁静默）；且必须指明来自**拖拽路径**（默认分配路径的披露不得冒充）',
      ).toContain('拖拽');
      expect(read('kline-px'), 'K 线视图停在可读下限').toBeGreaterThanOrEqual(299);
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: prev, configurable: true });
    }
  });

  it('未触下限的拖拽不得误报夹取/披露（禁误报）', () => {
    const prev = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 1400, configurable: true });
    try {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
      const k0 = read('kline-px');
      const i0 = read('indicators-px');
      drag(screen.getByTestId('wb-splitter-kline-indicators'), 600, 600 + 20);
      expect(Math.abs(read('kline-px') - k0 - 20), '未触下限 ⇒ 满额 1:1').toBeLessThanOrEqual(TOL_PX);
      expect(Math.abs(i0 - read('indicators-px') - 20)).toBeLessThanOrEqual(TOL_PX);
      expect(screen.getByTestId('clamped').textContent).toBe('false');
      expect(screen.getByTestId('disclosure').textContent).toBe('');
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: prev, configurable: true });
    }
  });
});

describe('BLOCKED-2 修复：拖拽披露不得被「未夹取」拖拽误报（键盘步进同理）', () => {
  it('键盘 ArrowUp 到下限 ⇒ 也必顶置位并披露（键盘路径与鼠标路径同源）', () => {
    render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
    const splitter = screen.getByTestId('wb-splitter-kline-indicators');
    // 上移至 K 线可读下限（可用 636；默认 K 线 350 ⇒ 步进 16×20 = 320 > 51 余量）
    for (let i = 0; i < 20; i++) fireEvent.keyDown(splitter, { key: 'ArrowUp' });
    expect(read('kline-px'), 'K 线视图停在可读下限').toBeGreaterThanOrEqual(299);
    expect(screen.getByTestId('clamped').textContent, '键盘拖到下限也必须置位').toBe('true');
    expect(screen.getByTestId('disclosure').textContent, '键盘路径同样必须披露').toContain('拖拽');
  });
});

describe('D9-13：记忆/比例不得绕过夹取，副图数变化时**重夹**', () => {
  it('播种旧卡高 {kline:200} ⇒ 视口 728 档 K 线视图仍 ≥ 299（旧实现直渲染 200 ⇒ 主图 121）', () => {
    const storage = fakeStorage({ 'eestock.result.cardHeights.v1': JSON.stringify({ kline: 200 }) });
    render(<LayoutHarness storage={storage} subPaneCount={1} />);
    expect(read('kline-px')).toBeGreaterThanOrEqual(299);
    expect(read('kline-px') + read('indicators-px') + read('detail-px')).toBeCloseTo(read('available'), 0);
  });

  it('副图数 1 → 2 ⇒ K 线视图下限 299 → 329，自动重夹', () => {
    const storage = fakeStorage({ 'eestock.result.cardHeights.v1': JSON.stringify({ kline: 200 }) });
    const { rerender } = render(<LayoutHarness storage={storage} subPaneCount={1} />);
    const one = read('kline-px');
    rerender(<LayoutHarness storage={storage} subPaneCount={2} />);
    const two = read('kline-px');
    expect(one).toBeGreaterThanOrEqual(299);
    expect(two, `2 副图 ⇒ K 线视图 ≥ 329（实读 ${two}）`).toBeGreaterThanOrEqual(329);
  });

  it('夹取/压缩时**显式披露**（禁静默）：2 副图 + 小视口（下限之和 604 > 可用 468）⇒ disclosure 非空', () => {
    const prev = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    try {
      render(<LayoutHarness storage={fakeStorage()} subPaneCount={2} />);
      expect(screen.getByTestId('disclosure').textContent).toBeTruthy();
      expect(read('kline-px'), 'K 线视图优先保下限').toBeGreaterThanOrEqual(329);
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: prev, configurable: true });
    }
  });
});

describe('R1e 归一完备（状态层）：收缩发生 ⇒ collapsed/clamped + 披露；未发生 ⇒ 不误报', () => {
  it('legacy v1 {ratio:0.5, collapsed:true} ⇒ 迁移收缩 ⇒ clamped=true ∧ 披露说明「已收缩」', () => {
    const storage = fakeStorage({
      'eestock.result.layout.v1': JSON.stringify({ ratio: 0.5, collapsed: true }),
    });
    render(<LayoutHarness storage={storage} subPaneCount={1} />);
    // jsdom 视口 768 ⇒ 可用 636；可见两段下限之和 479 ⇒ S 上界 = 1 − 479/636 ≈ 0.2469 < 0.5 ⇒ 必收缩
    expect(screen.getByTestId('clamped').textContent, '发生收缩 ⇒ clamped 必须置位').toBe('true');
    expect(screen.getByTestId('disclosure').textContent, '收缩必须**显式披露**').toContain('收缩');
    const raw = JSON.parse(storage.getItem(RESULT_LAYOUT_STORAGE_KEY) as string) as { ratios: ViewRatios };
    expect(raw.ratios.detail, 'S 收缩到可行上界（≈0.2469）').toBeLessThanOrEqual(1 - 479 / 636 + 0.01);
    expect(raw.ratios.detail).toBeGreaterThan(0);
  });

  it('无收起 / 可行态 ⇒ 不误报（clamped=false、无披露）', () => {
    render(<LayoutHarness storage={fakeStorage()} subPaneCount={1} />);
    expect(screen.getByTestId('clamped').textContent).toBe('false');
    expect(screen.getByTestId('disclosure').textContent).toBe('');
  });
});
