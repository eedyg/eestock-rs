/**
 * P5-D-1（实现侧补充用例）：**拖拽期望值必须夹在配置域 `[80, 1200]`**，且与**渲染侧分配下界**
 * （基准 200 / 卫星 80）**不得混同**。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodDragDomainClamp.test.ts`
 * 权威依据：`design/15-multi-period/02-spec.md` §6.1 尾注（架构裁决 2026-09-15）；
 * 配置面事实源 `crates/web/src/dto.rs`（`MULTI_PERIOD_HEIGHT_MIN/MAX = 80/1200`，校验第 5 条）。
 *
 * 落点：`multiPeriodLayout.ts::sanitizeDragHeight`（拖拽改写**期望 px** 的唯一净化入口）
 * ⇒ `onHeightsChange` 载荷（= `PUT /api/config/multi_period` 的 `heights`）恒在配置域内 ⇒ 不会被 400 回滚。
 *
 * 层级分工（诚实标注）：页面级 C8/C9 与组件级 B13（tester 红测试）已钉死端到端载荷；
 * 本文件只钉**被改动的那一行**的数值契约，使回归在纯函数层即可捕获。
 */

import { describe, expect, it } from 'vitest';
import {
  BASE_MIN_HEIGHT,
  DEFAULT_BASE_HEIGHT,
  DEFAULT_SATELLITE_HEIGHT,
  HEIGHT_MAX,
  HEIGHT_MIN,
  SATELLITE_MIN_HEIGHT,
  distributeStackHeights,
  sanitizeDragHeight,
} from './multiPeriodLayout';

/** 一键构造拖拽 pane（期望值 = 拖拽净化后的值）。 */
function dragPane(period: string, requested: number, isBase: boolean) {
  return { key: period, period, requested: sanitizeDragHeight(requested, isBase), isBase, fromDrag: true };
}

describe('拖拽期望值净化（配置域夹取）', () => {
  it('D1 域内值原样（round 后）通过：80 / 200 / 420 / 1200 均保持', () => {
    for (const v of [HEIGHT_MIN, 200, 420, HEIGHT_MAX]) {
      expect(sanitizeDragHeight(v, true), `基准 ${v}`).toBe(v);
      expect(sanitizeDragHeight(v, false), `卫星 ${v}`).toBe(v);
    }
  });

  it('D2 **下界夹取**：期望 < 80（含 42px 实测值）⇒ 夹到配置域下界 80', () => {
    for (const v of [1, 42, 79, 79.6]) {
      expect(sanitizeDragHeight(v, true), `基准期望 ${v} 必须夹到 ${HEIGHT_MIN}`).toBe(HEIGHT_MIN);
      expect(sanitizeDragHeight(v, false), `卫星期望 ${v} 必须夹到 ${HEIGHT_MIN}`).toBe(HEIGHT_MIN);
    }
  });

  it('D3 上界夹取与非法值兜底不变（回归护栏）', () => {
    expect(sanitizeDragHeight(HEIGHT_MAX + 1, false)).toBe(HEIGHT_MAX);
    expect(sanitizeDragHeight(Number.NaN, true)).toBe(DEFAULT_BASE_HEIGHT);
    expect(sanitizeDragHeight(-5, false)).toBe(DEFAULT_SATELLITE_HEIGHT);
  });

  it('D4 不得混同：配置域下界（80）≠ 渲染侧分配下界（基准 200 / 卫星 80，由缩小路径保证）', () => {
    expect(HEIGHT_MIN).toBe(80);
    expect(BASE_MIN_HEIGHT).toBe(200);
    expect(SATELLITE_MIN_HEIGHT).toBe(80);

    // 拖后期望：基准 500 / 卫星 86 / 卫星 86 ⇒ 全部 ∈ 配置域，但 Σ = 672 > 可用 600 ⇒ 缩小路径。
    // 卫星期望 86 > 配置域下界，分配却停在渲染侧下限 80（两者**不是**同一个夹取）。
    const layout = distributeStackHeights({
      panes: [dragPane('15m', 500, true), dragPane('1h', 86, false), dragPane('1d', 86, false)],
      available: 600,
    });

    expect(layout.reason).toBe('shrunk');
    expect(layout.total, 'Σ 分配 == 可用高度').toBe(600);
    expect(layout.panes.find((p) => p.isBase)!.height, '基准分配下限').toBeGreaterThanOrEqual(BASE_MIN_HEIGHT);
    for (const p of layout.panes.filter((x) => !x.isBase)) {
      expect(p.height, `${p.period} 卫星分配下限`).toBeGreaterThanOrEqual(SATELLITE_MIN_HEIGHT);
    }
    // 载荷合法性（配置域）
    for (const p of layout.panes) {
      expect(p.height, `${p.period} 载荷域下界`).toBeGreaterThanOrEqual(HEIGHT_MIN);
      expect(p.height, `${p.period} 载荷域上界`).toBeLessThanOrEqual(HEIGHT_MAX);
    }
  });
});
