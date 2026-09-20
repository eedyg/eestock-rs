import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FILL_DOT_R_PX,
  FILL_LABEL_CW_PX,
  FILL_LABEL_GAP_PX,
  FILL_LABEL_PAD_PX,
  placeFillLabel,
} from '@/features/dashboard/KlineChart';
import { buildMarkers } from './KlineResultChart';
import type { WorkbenchRunFill } from '@/api/types';

/**
 * 本波（2026-09-20，解除 tester 冻结）单测：
 *  - R1  标签边缘收敛（`placeFillLabel` 纯函数：有空间 ⇒ 与旧行为逐像素一致；右缘 ⇒ 翻转到左侧；极窄 ⇒ 夹紧在面板内）；
 *  - R2  不可达承诺文案不得回归（源码守卫：`KlineResultChart` 不得再出现「自动补高亮」承诺与 `'loading'` 高亮态）；
 *  - R3  买卖/止损的**颜色身份映射**（`buildMarkers`：买红 / 卖绿 / 止损橙 + `⊗` 文本）——
 *        与真渲染像素断言（`e2e/adr028-features-fix.e2e.ts` F3）互补：
 *        像素侧证明「画出来的 ink == store 的 color」，本单测证明「store 的 color == 语义身份」。
 *
 * 报告：`coder/evidence/20260920_adr028_features_fix/report.md`
 */

describe('R1 标签边缘收敛 placeFillLabel（纯函数）', () => {
  const LABEL = 'B 1.188×843.9619'; // 16 字符（真身 run A 第 42 笔口径）
  const TEXT_W = LABEL.length * FILL_LABEL_CW_PX + FILL_LABEL_PAD_PX; // 75.4

  it('① 右侧有空间 ⇒ 与旧实现完全一致（x = 圆点x + r + 3，左对齐）——既有居中 bar 标签位置不得变动', () => {
    const p = placeFillLabel({ x: 300, r: FILL_DOT_R_PX, text: LABEL, paneWidth: 606 });
    expect(p).toEqual({ x: 300 + FILL_DOT_R_PX + FILL_LABEL_GAP_PX, align: 'left' });
  });

  it('② 圆点贴右缘（run 末根 bar，x=604/pane 606）⇒ 翻转到圆点左侧并右对齐，且整段文本落在面板内', () => {
    const p = placeFillLabel({ x: 604, r: FILL_DOT_R_PX, text: LABEL, paneWidth: 606 });
    expect(p.align, '右缘必须翻转对齐（否则文本在面板外被裁掉）').toBe('right');
    expect(p.x).toBe(604 - FILL_DOT_R_PX - FILL_LABEL_GAP_PX);
    // 文本盒 [x - TEXT_W, x] 必须完整落在 [1, paneWidth-1] 内
    expect(p.x - TEXT_W).toBeGreaterThanOrEqual(1);
    expect(p.x).toBeLessThanOrEqual(605);
  });

  it('③ 极窄面板（两侧都放不下）⇒ 向面板内夹紧，锚点不得越界', () => {
    const p = placeFillLabel({ x: 30, r: FILL_DOT_R_PX, text: LABEL, paneWidth: 60 });
    expect(p.x).toBeGreaterThanOrEqual(1);
    expect(p.x).toBeLessThanOrEqual(59);
  });

  it('④ 高亮态（半径更大）同样翻转：paneWidth 不足时不留右侧越界', () => {
    const paneWidth = 606;
    const p = placeFillLabel({ x: 590, r: 8.7, text: LABEL, paneWidth });
    if (p.align === 'left') {
      expect(p.x + TEXT_W).toBeLessThanOrEqual(paneWidth - 1);
    } else {
      expect(p.x - TEXT_W).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('R2 不可达分支与承诺文案不得回归（源码守卫）', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/features/workbench/KlineResultChart.tsx'), 'utf8');

  it('不得再出现「标记就绪后自动补高亮」承诺文案（该分支在 UI 上不可达 ⇒ 属不真文案）', () => {
    expect(src).not.toContain('自动补高亮');
  });

  it('高亮态联合类型中不得再有 loading（删除不可达分支）', () => {
    expect(src).toMatch(/highlightState:\s*'idle'\s*\|\s*'ok'\s*\|\s*'unrecorded'\s*\|\s*'unmatched'/);
    expect(src).not.toMatch(/highlightState[\s\S]{0,80}'loading'/);
    expect(src).not.toMatch(/highlightState === 'loading'/);
  });
});

describe('R3 颜色身份映射（store 侧）：买红 / 卖绿 / 止损橙', () => {
  const fill = (over: Partial<WorkbenchRunFill>): WorkbenchRunFill =>
    ({
      ts: 1789660800,
      side: 'Buy',
      reason: 'Policy',
      price: 1.188,
      qty: 843.9619,
      rt_seq: 1,
      ...over,
    }) as WorkbenchRunFill;

  it('Buy ⇒ #ff5c6c / 文本 B；Sell ⇒ #00e0a4 / 文本 S；StopTrigger ⇒ #fb923c / 文本 ⊗', () => {
    const [buy] = buildMarkers([fill({ side: 'Buy', reason: 'Policy' })]);
    const [sell] = buildMarkers([fill({ side: 'Sell', reason: 'ForceClose' })]);
    const [stop] = buildMarkers([fill({ side: 'Sell', reason: 'StopTrigger' })]);
    expect(buy!.color).toBe('#ff5c6c');
    expect(buy!.text).toBe('B');
    expect(sell!.color).toBe('#00e0a4');
    expect(sell!.text).toBe('S');
    expect(stop!.color).toBe('#fb923c');
    expect(stop!.text).toBe('⊗');
    // 色相方向（与真渲染像素断言同口径）：买 r 主导；卖 g 主导
    const hx = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const [r1, g1, b1] = hx(buy!.color!);
    const [r2, g2, b2] = hx(sell!.color!);
    expect(r1! - g1!).toBeGreaterThan(40);
    expect(r1! - b1!).toBeGreaterThan(25);
    expect(g2! - r2!).toBeGreaterThan(40);
    expect(g2! - b2!).toBeGreaterThan(25);
  });
});
