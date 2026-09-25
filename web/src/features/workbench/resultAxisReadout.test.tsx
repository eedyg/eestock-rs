import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { AggregateScoreChart } from './AggregateScoreChart';
import { SlotScoresChart } from './SlotScoresChart';
import { EquityDrawdownChart } from './EquityDrawdownChart';
import { PositionRatioChart } from './PositionRatioChart';
import { CURVE_PAD as PAD, CURVE_W as W } from './curveGeometry';
import type { CurveXDomain } from './chartUtils';

/**
 * ADR-028 **D12（Y 轴刻度）+ D13（时刻取值）** —— 四张曲线卡**集成层**判据（先红后绿）。
 *
 * 判据设计（09-plan §2/§3 + §1.2 附加硬约束）：
 *  1. 四卡都出现左侧刻度带（3–5 条），且**刻度文本不在** `preserveAspectRatio="none"` 的 svg 内
 *     ⇒ 卡片横向拉伸时文字不变形（做进 svg 的实现本断言变红）；
 *  2. 刻度**只标注现有 y 域**：净值卡刻度必须落在数据 `[min,max]` 内（无 padding）；聚合/各策略 = 0–100；
 *     持仓 = `extentOf(ratios ∪ {0,1})`；含 0 的卡 0 刻度必须标出且视觉区别；
 *  3. 时刻取值 = **已加载原始点**（逐点核对 ≥2 点，禁插值）；悬停出十字线、点击锁定、再点/Esc 解除、←/→ 移动。
 */

const H_EQ = 220;
const H_SMALL = 160;
const BAR_TS = [1_700_000_000, 1_700_000_300, 1_700_000_600, 1_700_000_900, 1_700_001_200];
const XD: CurveXDomain = { mode: 'index', barTs: BAR_TS, toleranceSec: 2 };
const RECT = { left: 0, top: 0, width: 600, height: 200, right: 600, bottom: 200, x: 0, y: 0 };
let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...RECT, toJSON: () => RECT } as unknown as DOMRect);
});
afterEach(() => rectSpy.mockRestore());

/** bar 索引 j 的 svg userX（冻结 x 映射：8 + j/(N−1)×984）。 */
const barX = (j: number) => PAD + (j / (BAR_TS.length - 1)) * (W - PAD * 2);
/** 用户单位 → 像素 clientX（600px 盒子）。 */
const px = (userX: number) => (userX / W) * RECT.width;

// ─────────────────────── fixtures ───────────────────────

const NET: Array<[number, number]> = BAR_TS.map((ts, i) => [ts, [100, 101.5, 103, 104.5, 105][i]!]);
const DD: Array<[number, number]> = BAR_TS.map((ts, i) => [ts, [0.001, 0.02, 0.012, 0.004, 0][i]!]);
const AGG = [50, 62, 71, 83, 95];

function perBarRecords() {
  return BAR_TS.map((ts, i) => ({
    ts,
    aggregate: AGG[i]!,
    scores: [
      { slot_idx: 0, score: AGG[i]! },
      { slot_idx: 1, score: 100 - AGG[i]! },
    ],
  })) as never[];
}

const SLOTS = [
  { version_id: 'sv_a_v1', strategy_id: 'a', weight: 1 },
  { version_id: 'sv_b_v1', strategy_id: 'b', weight: 1 },
] as never[];

const POS = BAR_TS.map((ts, i) => {
  const r = [0.1, 0.3, 0.6, 0.8, 0.9][i]!;
  return { ts, position_ratio: r, cash_ratio: 1 - r, position_value: 1000 * r, cash: 1000 * (1 - r), nav: 1000 };
}) as never[];

type Rendered = { container: HTMLElement; frame: HTMLElement };

function renderAggregate(): Rendered {
  const { container } = render(
    <AggregateScoreChart perBar={perBarRecords()} buyThreshold={70} sellThreshold={30} xDomain={XD} plot={null} />,
  );
  return { container, frame: frameOf(container, 'aggregate') };
}
function renderSlot(): Rendered {
  const { container } = render(
    <SlotScoresChart perBar={perBarRecords()} slots={SLOTS} catalog={null} xDomain={XD} plot={null} />,
  );
  return { container, frame: frameOf(container, 'slot') };
}
function renderEquity(): Rendered {
  const { container } = render(<EquityDrawdownChart netValue={NET} drawdown={DD} xDomain={XD} plot={null} />);
  return { container, frame: frameOf(container, 'equity') };
}
function renderPosition(): Rendered {
  const { container } = render(
    <PositionRatioChart points={POS} domain={null} xDomain={XD} plot={null} cumulative={null} />,
  );
  return { container, frame: frameOf(container, 'position') };
}
function frameOf(container: HTMLElement, card: string): HTMLElement {
  const el = container.querySelector(`[data-testid="wb-readout-frame-${card}"]`);
  if (!el) throw new Error(`未找到读数框架 wb-readout-frame-${card}`);
  return el as HTMLElement;
}

/** 卡内读数文本（第 i 条线）。 */
function readoutValue(container: HTMLElement, card: string, i = 0): string {
  const el = container.querySelector(`[data-testid="wb-readout-value-${card}-${i}"]`);
  if (!el) throw new Error(`未找到读数 wb-readout-value-${card}-${i}`);
  return el.textContent ?? '';
}

const CARDS: Array<{ card: string; render: () => Rendered; height: number; labels: string[] }> = [
  { card: 'aggregate', render: renderAggregate, height: H_SMALL, labels: ['aggregate'] },
  { card: 'slot', render: renderSlot, height: H_SMALL, labels: ['slot', 'slot'] },
  { card: 'equity', render: renderEquity, height: H_EQ, labels: ['equity', 'equity'] },
  { card: 'position', render: renderPosition, height: H_EQ, labels: ['position'] },
];

// ─────────────────────── D12：刻度 ───────────────────────

describe('D12-1 四卡刻度带：3–5 条 + 文本层不被非等比拉伸', () => {
  for (const c of CARDS) {
    it(`${c.card}：刻度带存在、3–5 条、标签不在 svg 内（preserveAspectRatio=none 下文字不变形）`, () => {
      const { container } = c.render();
      const band = container.querySelector(`[data-testid="wb-axis-ticks-${c.card}"]`);
      expect(band, `缺少刻度带 wb-axis-ticks-${c.card}`).not.toBeNull();
      const labels = Array.from(container.querySelectorAll(`[data-testid^="wb-axis-tick-${c.card}-"]`));
      expect(labels.length).toBeGreaterThanOrEqual(3);
      expect(labels.length).toBeLessThanOrEqual(5);
      for (const l of labels) {
        expect(l.textContent).not.toBe('');
        expect(l.closest('svg'), '刻度文本必须画在不被 preserveAspectRatio=none 拉伸的 HTML 层').toBeNull();
      }
      // 网格与被拉伸 svg 同层，且为 svg 第一个子元素（最底层 ⇒ 压不过曲线/阈值线/分区）
      const svg = container.querySelector(`[data-testid="wb-${c.card}-chart"] svg`)!;
      const grid = container.querySelector(`[data-testid="wb-axis-grid-${c.card}"]`)!;
      expect(grid.parentElement).toBe(svg);
      expect(svg.firstElementChild).toBe(grid);
      expect(grid.querySelectorAll('line').length).toBe(labels.length);
    });
  }
});

describe('D12-1b 横线来源唯一（复审裁定：装饰线**替换**为带标注的刻度网格）', () => {
  /** 卡内 svg 的**水平**线（y1 === y2）。 */
  const horizontals = (container: HTMLElement, card: string) =>
    Array.from(container.querySelectorAll(`[data-testid="wb-${card}-chart"] svg line`)).filter(
      (l) => l.getAttribute('y1') === l.getAttribute('y2'),
    );

  for (const card of ['equity', 'position'] as const) {
    it(`${card}：水平线**只来自**刻度网格（数量 == 刻度数，无固定 0.25/0.5/0.75 装饰线遗留）`, () => {
      const r = card === 'equity' ? renderEquity() : renderPosition();
      const labels = r.container.querySelectorAll(`[data-testid^="wb-axis-tick-${card}-"]`);
      const lines = horizontals(r.container, card);
      expect(lines.length).toBe(labels.length);
      for (const l of lines) {
        expect(
          l.closest(`[data-testid="wb-axis-grid-${card}"]`),
          '该卡所有水平线必须属于刻度网格组（装饰线残留会使本断言变红）',
        ).not.toBeNull();
        expect(l.getAttribute('data-tick-value')).not.toBeNull();
      }
    });
  }

  it('聚合总分卡：阈值虚线/分区是**语义元素** ⇒ 原样保留（水平线 = 刻度网格 + 2 条阈值）', () => {
    const { container } = renderAggregate();
    const labels = container.querySelectorAll('[data-testid^="wb-axis-tick-aggregate-"]');
    expect(container.querySelector('[data-testid="threshold-buy"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="threshold-sell"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="zone-buy"]')).not.toBeNull();
    expect(horizontals(container, 'aggregate').length).toBe(labels.length + 2);
  });
});

describe('D12-2 各卡刻度格式与值域口径（禁改值域）', () => {
  it('聚合总分：0–100 整数刻度 + 含 0（视觉区别）+ **5 条**（复审裁定：2.5×10^k 档）', () => {
    const { container } = renderAggregate();
    const labels = Array.from(container.querySelectorAll('[data-testid^="wb-axis-tick-aggregate-"]'));
    const vals = labels.map((l) => Number(l.textContent));
    for (const v of vals) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(vals).toEqual([0, 25, 50, 75, 100]);
    expect(container.querySelector('[data-testid="wb-axis-tick-aggregate-0"]')!.getAttribute('data-zero')).toBe('true');
    expect(container.querySelector('[data-testid="wb-axis-grid-aggregate-0"]')!.getAttribute('data-zero')).toBe('true');
  });

  it('各策略评分：0–100 整数刻度 + 含 0 + 5 条（0/25/50/75/100）', () => {
    const { container } = renderSlot();
    const vals = Array.from(container.querySelectorAll('[data-testid^="wb-axis-tick-slot-"]')).map((l) => Number(l.textContent));
    for (const v of vals) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(vals).toEqual([0, 25, 50, 75, 100]);
  });

  it('净值卡：现状量纲（2 位小数）+ 刻度**全在数据域内**（无 padding，禁外扩）', () => {
    const { container } = renderEquity();
    const labels = Array.from(container.querySelectorAll('[data-testid^="wb-axis-tick-equity-"]'));
    const vals = labels.map((l) => Number(l.textContent));
    for (const l of labels) expect(l.textContent).toMatch(/^-?\d+\.\d{2}$/); // 现状量纲 = toFixed(2)
    const dataMin = Math.min(...NET.map((p) => p[1]));
    const dataMax = Math.max(...NET.map((p) => p[1]));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(dataMin); // 外扩到 nice 边界（100）本断言变红
      expect(v).toBeLessThanOrEqual(dataMax);
    }
    expect(Math.min(...vals)).toBe(dataMin);
  });

  it('持仓比率：百分比 2 位 + 含 0（extentOf(ratios ∪ {0,1}) 的 0 端）', () => {
    const { container } = renderPosition();
    const labels = Array.from(container.querySelectorAll('[data-testid^="wb-axis-tick-position-"]'));
    for (const l of labels) expect(l.textContent).toMatch(/^-?\d+\.\d{2}%$/);
    const vals = labels.map((l) => Number((l.textContent ?? '').replace('%', '')));
    expect(vals).toContain(0);
    expect(vals).toContain(25); // 复审裁定：2.5×10^k 档 ⇒ 0/25/50/75/100 可见
    expect(vals.length).toBe(5);
    // 域 = extentOf(ratios ∪ {0,1}) = [0,1] ⇒ 刻度不得越界
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(container.querySelector('[data-testid="wb-axis-tick-position-0"]')!.getAttribute('data-zero')).toBe('true');
  });
});

// ─────────────────────── D13：时刻取值 ───────────────────────

describe('D13 时刻取值：读数 == 序列原值（逐点核对）；悬停/点击/键盘', () => {
  it('净值+回撤：两个时点的读数 == 两列序列原值（禁插值）', () => {
    const { container, frame } = renderEquity();
    // ts 标签 = 该 bar 的 ts
    fireEvent.mouseMove(frame, { clientX: px(barX(1)) });
    expect(container.querySelector('[data-testid="wb-readout-equity"]')!.getAttribute('data-readout-ts')).toBe(String(BAR_TS[1]));
    expect(readoutValue(container, 'equity', 0)).toBe('101.50');
    expect(readoutValue(container, 'equity', 1)).toBe('2.00%');
    // 第二点：bar 索引 3
    fireEvent.mouseMove(frame, { clientX: px(barX(3)) });
    expect(readoutValue(container, 'equity', 0)).toBe('104.50');
    expect(readoutValue(container, 'equity', 1)).toBe('0.40%');
    // 十字线随悬停出现并落在该 bar 的 x 上
    const cross = container.querySelector('[data-testid="wb-crosshair-equity"]')!;
    expect(cross).not.toBeNull();
    expect(Number(cross.getAttribute('data-crosshair-ts'))).toBe(BAR_TS[3]);
  });

  it('聚合总分：两个时点读数 == 原始 aggregate；点击锁定 ⇒ 常驻；Esc ⇒ 解除', () => {
    const { container, frame } = renderAggregate();
    fireEvent.mouseMove(frame, { clientX: px(barX(0)) });
    expect(readoutValue(container, 'aggregate', 0)).toBe('50');
    fireEvent.mouseMove(frame, { clientX: px(barX(2)) });
    expect(readoutValue(container, 'aggregate', 0)).toBe('71');
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).toBeNull();
    fireEvent.click(frame, { clientX: px(barX(2)) });
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).not.toBeNull();
    // 锁定后鼠标移开仍常驻
    fireEvent.mouseLeave(frame);
    expect(readoutValue(container, 'aggregate', 0)).toBe('71');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('[data-testid="wb-readout-locked"]')).toBeNull();
  });

  it('各策略评分：同卡多线一并显示（默认前 3 条可见 ⇒ 2 条都在读数里）', () => {
    const { container, frame } = renderSlot();
    fireEvent.mouseMove(frame, { clientX: px(barX(1)) });
    expect(readoutValue(container, 'slot', 0)).toBe('62');
    expect(readoutValue(container, 'slot', 1)).toBe('38');
  });

  it('持仓比率：读数 = position_ratio 原值（百分比 2 位）', () => {
    const { container, frame } = renderPosition();
    fireEvent.mouseMove(frame, { clientX: px(barX(2)) });
    expect(readoutValue(container, 'position', 0)).toBe('60.00%');
    fireEvent.mouseMove(frame, { clientX: px(barX(4)) });
    expect(readoutValue(container, 'position', 0)).toBe('90.00%');
  });

  it('鼠标位置 → 最近 bar：偏差 ≤ 1 根 bar（半格内不串到邻根）', () => {
    const { container, frame } = renderEquity();
    const mid = (barX(1) + barX(2)) / 2;
    fireEvent.mouseMove(frame, { clientX: px(mid - 2) });
    expect(readoutValue(container, 'equity', 0)).toBe('101.50'); // 略偏 bar1 ⇒ bar1
    fireEvent.mouseMove(frame, { clientX: px(mid + 2) });
    expect(readoutValue(container, 'equity', 0)).toBe('103.00'); // 略偏 bar2 ⇒ bar2
  });

  it('键盘 ←/→ 移动取值点，读数随之变化', () => {
    const { container, frame } = renderPosition();
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(readoutValue(container, 'position', 0)).toBe('10.00%');
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(readoutValue(container, 'position', 0)).toBe('30.00%');
    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(readoutValue(container, 'position', 0)).toBe('10.00%');
  });

  it('四卡都可聚焦（tabIndex=0）', () => {
    for (const c of CARDS) {
      const { frame } = c.render();
      expect(frame.tabIndex, `${c.card} 卡必须可聚焦（无障碍最低要求）`).toBe(0);
    }
  });
});
