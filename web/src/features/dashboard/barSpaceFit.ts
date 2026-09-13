import { useEffect, useRef } from 'react';
import type { Chart } from 'klinecharts';

/**
 * barSpaceFit —— 视口自适应的 barSpace 计算/应用（主图 KlineChart 与宫格 GridCell 共用，DRY）。
 *
 * 口径（ADR-020 §2.5/§2.6/§2.7）：配置值 = **K 线根数**（`viewport_bars`，默认 120 / 范围 30–600），
 * 与周期无关；barSpace 由 `(容器宽度, 根数)` 唯一决定：
 *
 *     barSpaceForViewport(width, bars) = clamp(round(width / bars), 1, 50)
 *
 * 决策依据（`design/06-web/11-kline-viewport-bars.md` §1.1）：
 *  - klinecharts 引擎硬限 `_layoutOptions.barSpaceLimit = {min:1, max:50}`（E3），`setBarSpace` 越界
 *    **静默 return**（E4），可见根数 = `宽度 / space`（E5）→ 可达可见区间仅 [W/50, W]。
 *  - 旧实现按「每日 bar 数 × 交易日数」折算 target：1m 恒夹 1（饱和全宽）、1d/1w/1mo 恒夹 50
 *    （恒约 20 根）→ 表现为用户报告的「默认视口只影响 15m」。本模块取消该折算，夹取退化为安全网。
 *
 * 观测性（ADR-020 §5）：夹取（raw space ∉ [1,50]）时按 chart 实例去重地 `console.warn` 一次；
 * 每次成功应用都会在宿主元素上写 `data-viewport-fit='{"bars":N,"space":S,"visible":V,"clamped":bool}'`
 * （单图与宫格同构），供 e2e/人工排查直接断言，替代像素猜测。
 */

/** klinecharts barSpace 硬下限（引擎 `barSpaceLimit.min`）。 */
export const MIN_BAR_SPACE = 1;
/** klinecharts barSpace 硬上限（引擎 `barSpaceLimit.max`）。 */
export const MAX_BAR_SPACE = 50;

export interface BarSpaceFitResult {
  space: number;
  /** raw space 越出 [MIN_BAR_SPACE, MAX_BAR_SPACE]（即夹取生效 = 视口不可完全精确表达）。 */
  clamped: boolean;
}

/**
 * 纯函数：`clamp(round(width / viewportBars), 1, 50)`。
 * `width <= 0`（未布局）或 `viewportBars` 非法（<= 0 / NaN）→ `null`（调用方**不设置** barSpace，
 * 避免用未布局宽度算出无意义 space 并写进引擎）。
 */
export function barSpaceForViewport(width: number, viewportBars: number): number | null {
  if (!(width > 0) || !(viewportBars > 0)) return null; // NaN/0/负值一律 false → null
  const raw = Math.round(width / viewportBars);
  return Math.max(MIN_BAR_SPACE, Math.min(MAX_BAR_SPACE, raw));
}

/** 已告警过的 chart 实例（按实例去重，不刷屏；chart 重建后可再次留痕）。 */
const warnedCharts = new WeakSet<object>();

/**
 * 按 (容器宽度, 视口根数) 设置 barSpace，并在宿主元素上留痕 `data-viewport-fit`。
 * `width <= 0` / `el` 缺失 → 返回 `null` 且**不调用** `chart.setBarSpace`（不设置即保持引擎现值）。
 * 发生夹取时按 chart 实例 `console.warn` 一次（结构化：width/viewportBars/space/clamped）。
 */
export function fitBarSpaceToViewport(
  chart: Chart,
  el: HTMLElement | null,
  viewportBars: number,
): BarSpaceFitResult | null {
  const width = el ? el.clientWidth : 0;
  const space = barSpaceForViewport(width, viewportBars);
  if (space === null) return null;

  const raw = width / viewportBars;
  const clamped = raw < MIN_BAR_SPACE || raw > MAX_BAR_SPACE;
  if (clamped && !warnedCharts.has(chart)) {
    warnedCharts.add(chart);
    console.warn({
      message: '[barSpaceFit] barSpace 被 klinecharts barSpaceLimit{1,50} 夹取（视口无法精确表达）',
      width,
      viewportBars,
      space,
      clamped,
    });
  }

  chart.setBarSpace(space);
  if (el) {
    el.setAttribute(
      'data-viewport-fit',
      JSON.stringify({
        bars: viewportBars,
        space,
        visible: Math.floor(width / space),
        clamped,
      }),
    );
  }
  return { space, clamped };
}

export interface BarSpaceFitOptions {
  /** 图表宿主元素（宽度来源；同时是 `data-viewport-fit` 的写入目标）。 */
  elRef: { readonly current: HTMLElement | null };
  /** 取当前 chart 实例（组件在 feed 变化时整图重建，故用 getter 而非实例）。 */
  getChart: () => Chart | null;
  /** 配置视口（K 线根数）。 */
  viewportBars: number;
  /** 返回 false 时本次 resize **不重算**（主图「用户手动缩放后不重算」，ADR-020 §2.6）。 */
  enabled: () => boolean;
}

/**
 * `ResizeObserver` 接线：容器宽度变化时按当前视口重算 barSpace（保持「可见 ≈ N 根」）。
 * 不做首次铺满——首次由调用方的初始加载路径显式 fit（DataLoader init），避免与建图竞态。
 */
export function useBarSpaceFit(opts: BarSpaceFitOptions): void {
  const latest = useRef(opts);
  latest.current = opts;
  const { elRef, viewportBars } = opts;

  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const cur = latest.current;
      if (!cur.enabled()) return;
      const chart = cur.getChart();
      if (!chart) return;
      fitBarSpaceToViewport(chart, el, cur.viewportBars);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [elRef, viewportBars]);
}
